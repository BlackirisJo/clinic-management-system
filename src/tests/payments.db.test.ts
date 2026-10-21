import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../config/database';
import { recordPayment } from '../modules/billing/payments.controller';

/* ==========================================================================
 * Phase 10G.2 — payment write path against a real catalog
 *
 * The mocked suite proves what the code decides. This proves the SQL: real
 * constraints, real NUMERIC arithmetic, real unique index.
 *
 * It runs against a real PostgreSQL without touching the developer's database:
 * 047 is applied INSIDE one transaction that is always rolled back, and the
 * controller is handed that same client with BEGIN/COMMIT/ROLLBACK swallowed, so
 * everything the write path does lives and dies inside that transaction. If the
 * process dies mid-test the dropped connection rolls it back too.
 *
 * Opt-in, same convention as payments.schema.test.ts:
 *   SETTLEMENT_SCHEMA_TEST=1
 * ========================================================================== */

const enabled = process.env.SETTLEMENT_SCHEMA_TEST === '1';
const MIGRATION = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '047_payments.sql');
// 048 too, because from 10G.3 the payment path reads the boundary and refuses to
// run without it. 048 is ON CONFLICT DO NOTHING, so applying it here works both
// on a database where the marker is already committed and on a fresh one.
const ACTIVATION = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '048_settlement_cutover_activation.sql');
const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface Fixture {
  clinicId: number;
  otherClinicId: number;
  userId: number;
  patientId: number;
  invoiceId: number;
}

const USER = {
  userId: 0, roleId: 3, clinicId: 0, roleName: 'ACCOUNTANT',
  permissions: ['RECORD_PAYMENT'], clinicIds: [],
};
const CENTRAL_USER = {
  userId: 0, roleId: 3, clinicId: 0, roleName: 'ACCOUNTANT',
  permissions: ['MANAGE_SERVICES', 'CREATE_EXPENSE', 'RECORD_PAYMENT'], clinicIds: [],
};

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const req = (body: Record<string, unknown>, user: Record<string, unknown>) =>
  ({ body, params: {}, query: {}, user } as any);

const seed = async (c: PoolClient, options: { net?: string; paid?: string } = {}): Promise<Fixture> => {
  const clinic = await c.query(`INSERT INTO clinics (clinic_name) VALUES ('payment harness') RETURNING clinic_id`);
  const other = await c.query(`INSERT INTO clinics (clinic_name) VALUES ('other harness') RETURNING clinic_id`);
  const user = await c.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ('Harness', $1, 'x') RETURNING user_id`,
    [`harness_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`],
  );
  const patient = await c.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ('Harness Patient', '0000000', 'MALE', '1990-01-01', $1) RETURNING patient_id`,
    [clinic.rows[0].clinic_id],
  );
  const net = options.net ?? '100.00';
  const paid = options.paid ?? '0.00';
  const invoice = await c.query(
    `INSERT INTO invoices (patient_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
     VALUES ($1, $2, $3, 0, $3, $4, 'CASH', 'JOD') RETURNING invoice_id`,
    [patient.rows[0].patient_id, user.rows[0].user_id, net, paid],
  );
  const invoiceId = Number(invoice.rows[0].invoice_id);
  await c.query(
    `INSERT INTO invoice_items (invoice_id, clinic_id, price, doctor_share) VALUES ($1, $2, $3, 0)`,
    [invoiceId, clinic.rows[0].clinic_id, net],
  );

  return {
    clinicId: Number(clinic.rows[0].clinic_id),
    otherClinicId: Number(other.rows[0].clinic_id),
    userId: Number(user.rows[0].user_id),
    patientId: Number(patient.rows[0].patient_id),
    invoiceId,
  };
};

const withRealSchema = async (
  fn: (c: PoolClient, fixture: Fixture, scoped: Record<string, unknown>, central: Record<string, unknown>) => Promise<void>,
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(MIGRATION, 'utf8'));
    await client.query(fs.readFileSync(ACTIVATION, 'utf8'));

    // The controller opens its own "transaction" on this one connection: the
    // control statements are absorbed so the harness keeps ownership of COMMIT.
    (pool as any).connect = async () => ({
      query: async (text: string, params: unknown[] = []) => {
        const t = String(text).trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
        return client.query(text, params);
      },
      release: () => undefined,
    });

    const fixture = await seed(client);
    const scoped = { ...USER, userId: fixture.userId, clinicId: fixture.clinicId, clinicIds: [fixture.clinicId] };
    const central = { ...CENTRAL_USER, userId: fixture.userId, clinicIds: [fixture.clinicId] };
    await fn(client, fixture, scoped, central);
  } finally {
    (pool as any).connect = ORIGINAL_CONNECT;
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

const pay = async (body: Record<string, unknown>, user: Record<string, unknown>) => {
  const { res, captured } = makeRes();
  await recordPayment(req(body, user), res);
  // Flattened: the status alongside whatever the handler answered with.
  return { status: captured.status, ...(captured.body ?? {}) };
};

const invoiceRow = async (c: PoolClient, invoiceId: number) =>
  (await c.query(`SELECT net_amount, paid_amount FROM invoices WHERE invoice_id = $1`, [invoiceId])).rows[0];

const paymentRows = async (c: PoolClient, invoiceId: number) =>
  (await c.query(
    `SELECT amount, clinic_id, payer_type, method, received_by_user_id, voided_at
     FROM payments WHERE invoice_id = $1 ORDER BY payment_id`,
    [invoiceId],
  )).rows;

/* ==========================================================================
 * WRITE BEHAVIOUR — real SQL, real constraints
 * ======================================================================== */

test('DB: دفعة نقدية تُسجَّل والمدفوع يُشتق منها', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const out = await pay({ invoice_id: f.invoiceId, amount: 40, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(out.status, 201);

    const rows = await paymentRows(c, f.invoiceId);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].amount), 40);
    assert.equal(rows[0].clinic_id, f.clinicId, 'clinic_id من بنود الفاتورة');
    assert.equal(rows[0].received_by_user_id, f.userId, 'الفاعل من التوكن');

    const invoice = await invoiceRow(c, f.invoiceId);
    assert.equal(Number(invoice.paid_amount), 40);
    assert.equal(out.invoice.remaining, 60);
    assert.equal(out.invoice.status, 'PARTIAL');

    const audited = await c.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
       WHERE action = 'PAYMENT_RECORDED' AND resource_type = 'PAYMENT' AND user_id = $1`,
      [f.userId],
    );
    assert.equal(audited.rows[0].n, 1, 'تدقيق واحد باسم المستخدم الذي سجّل');
  });
});

test('DB: بطاقة مع INSURER وبلغ المتبقي بالضبط', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const out = await pay({ invoice_id: f.invoiceId, amount: 100, payer_type: 'INSURER', method: 'CARD', currency_code: 'JOD', note: 'insurance settlement' }, scoped);
    assert.equal(out.status, 201);
    assert.equal(out.invoice.status, 'PAID');
    assert.equal(out.invoice.remaining, 0);
    const rows = await paymentRows(c, f.invoiceId);
    assert.equal(rows[0].payer_type, 'INSURER');
    assert.equal(rows[0].method, 'CARD');
  });
});

test('DB: دفعات جزئية تتراكم حتى بلوغ المتبقي', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    for (const amount of [30, 20, 50]) {
      const out = await pay({ invoice_id: f.invoiceId, amount, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
      assert.equal(out.status, 201, `دفعة ${amount}`);
    }
    const invoice = await invoiceRow(c, f.invoiceId);
    assert.equal(Number(invoice.paid_amount), 100);
    const sum = (await paymentRows(c, f.invoiceId)).reduce((t, r) => t + Number(r.amount), 0);
    assert.equal(Number(invoice.paid_amount), sum, 'المخزَّن = مجموع الدفعات الحية');
  });
});

test('DB: التجاوز مرفوض ولا يترك مالاً يتحرك', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    await pay({ invoice_id: f.invoiceId, amount: 90, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    const over = await pay({ invoice_id: f.invoiceId, amount: 10.01, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(over.status, 409);
    assert.equal(over.reason, 'OVERPAYMENT');
    assert.equal((await paymentRows(c, f.invoiceId)).length, 1);
    assert.equal(Number((await invoiceRow(c, f.invoiceId)).paid_amount), 90);

    const exact = await pay({ invoice_id: f.invoiceId, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(exact.status, 201, 'بلوغ المتبقي بالضبط مسموح');
    assert.equal(exact.invoice.status, 'PAID');
  });
});

test('DB: العملة مختلفة تُرفض ولا تُحوَّل', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const out = await pay({ invoice_id: f.invoiceId, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'USD' }, scoped);
    assert.equal(out.status, 409);
    assert.equal(out.reason, 'CURRENCY_MISMATCH');
    assert.equal((await paymentRows(c, f.invoiceId)).length, 0);
  });
});

test('DB: فاتورة غير موجودة، وعيادة أخرى محجوبة', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const missing = await pay({ invoice_id: f.invoiceId + 999999, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(missing.status, 404);

    const outsider = { ...scoped, clinicIds: [f.otherClinicId], clinicId: f.otherClinicId };
    const denied = await pay({ invoice_id: f.invoiceId, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, outsider);
    assert.equal(denied.status, 404, 'لا يُكشف وجود الفاتورة لعيادة أخرى');
    assert.equal((await paymentRows(c, f.invoiceId)).length, 0);
  });
});

test('DB: إعادة الطلب بنفس المفتاح لا تُنشئ حركة مال ثانية', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const body = { invoice_id: f.invoiceId, amount: 100, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD', idempotency_key: 'req-1' };
    const first = await pay(body, scoped);
    assert.equal(first.status, 201);

    const replay = await pay(body, scoped);
    assert.equal(replay.status, 200);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.payment.payment_id, first.payment.payment_id);
    assert.equal((await paymentRows(c, f.invoiceId)).length, 1, 'دفعة واحدة فقط');
    assert.equal(Number((await invoiceRow(c, f.invoiceId)).paid_amount), 100, 'المدفوع لم يتضاعف');
  });
});

test('DB: الدفعة الملغاة لا تدخل المجموع الحي', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    await pay({ invoice_id: f.invoiceId, amount: 40, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    // ما سيفعله مسار الإلغاء لاحقاً: يجعل السطر غير حياً ويعيد اشتقاق المخزن.
    await c.query(`UPDATE payments SET voided_at = NOW(), voided_by_user_id = $2 WHERE invoice_id = $1`, [f.invoiceId, f.userId]);
    await c.query(
      `UPDATE invoices SET paid_amount = COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = $1 AND voided_at IS NULL), 0) WHERE invoice_id = $1`,
      [f.invoiceId],
    );

    const next = await pay({ invoice_id: f.invoiceId, amount: 100, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(next.status, 201);
    assert.equal(Number((await invoiceRow(c, f.invoiceId)).paid_amount), 100, 'السطر الملغى لا يُحسب');
    assert.equal((await paymentRows(c, f.invoiceId)).length, 2, 'التاريخ كامل، والسطر الملغى باقٍ');
  });
});

test('DB: تأكيد تسوية بلا سند (فاتورة قديمة) لا يُبنى عليه تحصيل', { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(MIGRATION, 'utf8'));
    await client.query(fs.readFileSync(ACTIVATION, 'utf8'));
    (pool as any).connect = async () => ({
      query: async (text: string, params: unknown[] = []) => {
        const t = String(text).trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
        return client.query(text, params);
      },
      release: () => undefined,
    });
    // فاتورة بمبلغ مدفوع مخزَّن لا يملك أي دفعة: الحالة الوحيدة التي يبلغها
    // شرط الاتساق اليوم.
    const f = await seed(client, { net: '100.00', paid: '100.00' });
    const scoped = { ...USER, userId: f.userId, clinicId: f.clinicId, clinicIds: [f.clinicId] };
    const out = await pay({ invoice_id: f.invoiceId, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);

    assert.equal(out.status, 409);
    assert.equal(out.reason, 'SETTLEMENT_OUT_OF_SYNC');
    assert.equal(out.stored_paid_amount, 100);
    assert.equal(out.live_payments_total, 0);
    assert.equal((await paymentRows(client, f.invoiceId)).length, 0);
    assert.equal(Number((await invoiceRow(client, f.invoiceId)).paid_amount), 100, 'التسوية التاريخية لم تُمسّ');
  } finally {
    (pool as any).connect = ORIGINAL_CONNECT;
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('DB: الدفعة الثانية ترى الأولى — لا سباق على المتبقي', { skip: !enabled }, async () => {
  // The row lock serialises them, and the re-derivation (never an increment) is
  // what the second attempt reads: 60 + 60 > 100 must fail rather than pass and
  // leave paid_amount at 120.
  await withRealSchema(async (c, f, scoped) => {
    const first = await pay({ invoice_id: f.invoiceId, amount: 60, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(first.status, 201);

    const second = await pay({ invoice_id: f.invoiceId, amount: 60, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, scoped);
    assert.equal(second.status, 409);
    assert.equal(second.reason, 'OVERPAYMENT');

    const invoice = await invoiceRow(c, f.invoiceId);
    const sum = (await paymentRows(c, f.invoiceId)).reduce((t, r) => t + Number(r.amount), 0);
    assert.equal(Number(invoice.paid_amount), 60);
    assert.equal(Number(invoice.paid_amount), sum, 'المخزَّن يطابق الدفعات الحية دائماً');
  });
});

test('DB: لا تخصيص ولا دفتر عام — الدفعات للاسترداد، والعتبة صف واحد', { skip: !enabled }, async () => {
  await withRealSchema(async (c) => {
    // 049, so the refunds table exists here: money in (payments) and money out
    // (refunds) are separate tables, each with its own positive-amount rule and
    // its own live-sum index. What must still not exist is an allocation table, a
    // general ledger, or a GL account — this system records facts, it does not
    // post to accounts.
    await c.query(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '049_refunds.sql'), 'utf8'));
    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name LIKE '%payment%' OR table_name LIKE '%refund%'
              OR table_name LIKE '%alloc%' OR table_name LIKE '%ledger%' OR table_name LIKE '%gl_%')
       ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name), ['payments', 'refunds']);

    const cutover = await c.query(`SELECT COUNT(*)::int AS n FROM settlement_cutover`);
    assert.equal(cutover.rows[0].n, 1, 'العتبة مفعّلة — صف واحد');
  });
});