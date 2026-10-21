import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { createInvoice } from '../modules/billing/billing.controller';
import { recordPayment } from '../modules/billing/payments.controller';
import { classifyByCreatedAt, isPostCutoverNow } from '../modules/billing/settlementCutover';

/* ==========================================================================
 * Phase 10G.3 — Settlement cutover
 *
 * One row, one rule:
 *
 *   created_at <  cutover_at  ->  LEGACY          paid_amount is a historical
 *                                                    assertion; settlement closed
 *   created_at >= cutover_at  ->  PAYMENT_BACKED  paid_amount is the live sum of
 *                                                    payment rows, nothing else
 *
 * What must be true after this phase:
 *   - the marker exists, exactly once, and can never move
 *   - a new service invoice is born UNPAID (this is the behavioural change)
 *   - a new medication invoice is still born unpaid
 *   - a legacy invoice cannot be settled, and its paid_amount is left alone
 *   - a missing marker fails closed instead of silently picking a side
 *   - classification never consults payment rows
 *
 * Tier 1 (mocked pool) always runs. Tier 2 (real catalog) is opt-in:
 *   SETTLEMENT_SCHEMA_TEST=1
 * and applies 047 + 048 inside one always-rolled-back transaction.
 * ========================================================================== */

const enabled = process.env.SETTLEMENT_SCHEMA_TEST === '1';
const MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const migrationSource = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

const codeOf = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

/* ==========================================================================
 * 1. THE RULE ITSELF — pure, no database
 * ======================================================================== */

test('RULE: التصنيف بالوقت، ونقطة الحد عند التساوي لصالح ما بعد العتبة', () => {
  const cutover = new Date('2026-06-01T12:00:00.000Z');
  assert.equal(classifyByCreatedAt(new Date('2026-05-31T23:59:59.999Z'), cutover), 'LEGACY');
  assert.equal(classifyByCreatedAt(cutover, cutover), 'PAYMENT_BACKED', 'created_at = cutover_at');
  assert.equal(classifyByCreatedAt(new Date('2026-06-01T12:00:00.001Z'), cutover), 'PAYMENT_BACKED');
  assert.equal(isPostCutoverNow(cutover, new Date('2026-05-31T00:00:00.000Z')), false);
  assert.equal(isPostCutoverNow(cutover, new Date('2026-06-01T00:00:00.000Z')), false, 'صباح يوم العتبة ما زال قبلها');
  assert.equal(isPostCutoverNow(cutover, cutover), true, 'عند العتبة بالضبط: بعد العتبة');
  assert.equal(isPostCutoverNow(cutover, new Date('2026-06-02T00:00:00.000Z')), true);
});

test('RULE: التصنيف لا يستشير وجود الدفعات إطلاقاً', () => {
  const helper = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'settlementCutover.ts'), 'utf8',
  );
  const body = codeOf(helper);
  assert.doesNotMatch(body, /payments/i, 'وحدة التصنيف لا تذكر جدول الدفعات');
  assert.doesNotMatch(body, /EXISTS/i);
  assert.match(body, /getTime\(\) < cutoverAt\.getTime\(\)/, 'المقارنة بالوقت وحده');
});

test('MIGRATION: 048 يكتب الصف مرة واحدة ولا ينقل العتبة عند إعادة التشغيل', () => {
  const sql = migrationSource('048_settlement_cutover_activation.sql');
  assert.match(sql, /INSERT INTO settlement_cutover \(singleton, cutover_at, reason, set_by\)/);
  assert.match(sql, /CURRENT_TIMESTAMP/, 'وقت الخادم وقت الترحيل، لا قيمة عميل');
  assert.match(sql, /Settlement payment ledger activated/);
  assert.match(sql, /ON CONFLICT \(singleton\) DO NOTHING/, 'إعادة التشغيل لا تحرّك العتبة');
  assert.doesNotMatch(codeOf(sql), /UPDATE\s+(invoices|settlement_cutover)/i, 'لا إعادة كتابة تاريخ');
  assert.doesNotMatch(codeOf(sql), /INSERT INTO payments/i, 'لا دفعة اصطناعية');
});

test('MIGRATION: 047 لا يفعّل العتبة و048 وحده يفعلها', () => {
  assert.doesNotMatch(codeOf(migrationSource('047_payments.sql')), /INSERT INTO settlement_cutover/i);
  // A later migration exists for an unrelated concern (049 stores refunds).
  // What must hold is narrower and stronger: nothing after 048 touches the
  // boundary — no later migration moves the row or rewrites its history.
  const later = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => f > '048_settlement_cutover_activation.sql');
  for (const file of later) {
    assert.doesNotMatch(codeOf(migrationSource(file)), /settlement_cutover/i, `${file} لا يمس العتبة`);
  }
});

test('MIGRATION: لا تقارير ولا واجهة ولا استرداد في هذه المرحلة', () => {
  const sql = codeOf(migrationSource('048_settlement_cutover_activation.sql'));
  for (const forbidden of ['refund', 'allocation', 'reports', 'invoice_items', '043', '044']) {
    assert.ok(!sql.includes(forbidden), `048 لا يلمس ${forbidden}`);
  }
});

test('ERRORS: رمزان ثابتان ومستقران للعتبة والفواتير السابقة', () => {
  const codes = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'utils', 'apiErrors.ts'), 'utf8');
  assert.match(codes, /LEGACY_INVOICE_READ_ONLY: 'LEGACY_INVOICE_READ_ONLY'/);
  assert.match(codes, /SETTLEMENT_CUTOVER_MISSING: 'SETTLEMENT_CUTOVER_MISSING'/);
  const payment = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'payments.controller.ts'), 'utf8',
  );
  assert.match(payment, /ApiErrorCode\.LEGACY_INVOICE_READ_ONLY/);
  assert.match(payment, /ApiErrorCode\.SETTLEMENT_CUTOVER_MISSING/);
});

/* ==========================================================================
 * 2. TIER 1 — mocked pool: invoice issuance
 * ======================================================================== */

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

type QueryCall = { text: string; params: unknown[] };
type MockResult = { rows: any[]; rowCount: number | null };

interface Scenario {
  cutoverAt?: string | null;
  postCutoverNow?: boolean;
  failOn?: string;
}

const CUTOVER_PAST = '2020-01-01T00:00:00.000Z';
const CUTOVER_FUTURE = '2999-01-01T00:00:00.000Z';

const handlerFor = (s: Scenario) => {
  const cutoverAt = s.cutoverAt === undefined ? CUTOVER_PAST : s.cutoverAt;
  // The mock mirrors what the database does: it returns the boolean the way
  // `CURRENT_TIMESTAMP >= cutover_at` would evaluate it, so the test proves the
  // controller CONSUMES a DB-provided decision instead of computing one with the
  // application clock. The reference here is a fixed test date, never `new Date()`
  // inside the code under test.
  const reference = new Date('2026-12-31T00:00:00.000Z');
  return (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
    if (s.failOn && t.includes(s.failOn)) {
      throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
    }
    if (t.includes('FROM settlement_cutover')) {
      if (cutoverAt === null) return { rows: [], rowCount: 0 };
      const postCutoverNow = s.postCutoverNow ?? new Date(cutoverAt) <= reference;
      return { rows: [{ cutover_at: cutoverAt, post_cutover_now: postCutoverNow }], rowCount: 1 };
    }
    if (t.includes("FROM system_settings WHERE key = 'base_currency'")) {
      return { rows: [{ value: 'JOD' }], rowCount: 1 };
    }
    if (t.startsWith('SELECT 1 FROM patients')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    // الاستعلام يبدأ بـ SELECT، فلا يطابق beginsWith('FROM ...') أبداً.
    // والأسعار تُبنى من العيادات المطلوبة فعلاً ($2)، وإلا رفض resolveItem
    // أي بند/service_id لا-return له صف، وظهر خطأ حساب مكان خطأ التسوية.
    if (t.includes('FROM clinic_services')) {
      const clinicIds: number[] = Array.isArray(params[1]) ? [...(params[1] as number[])] : [3];
      return {
        rows: clinicIds.map((clinicId) => ({
          clinic_id: clinicId, service_id: 41, price: 100, doctor_percentage: 40, is_active: true,
        })),
        rowCount: clinicIds.length,
      };
    }
    if (t.startsWith('INSERT INTO invoices')) {
      return {
        rows: [{ invoice_id: 700, total_amount: '100.00', net_amount: '100.00', paid_amount: String(params[6]), currency_code: 'JOD' }],
        rowCount: 1,
      };
    }
    if (t.startsWith('INSERT INTO invoice_items')) return { rows: [{ item_id: 900 }], rowCount: 1 };
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
};

const ACCOUNTANT = {
  userId: 7, roleId: 3, clinicId: 3, roleName: 'ACCOUNTANT',
  permissions: ['MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE'], clinicIds: [3],
};

const issueReq = (body: Record<string, unknown>): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user: ACCOUNTANT } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const SERVICE_BODY = {
  patient_id: 254, discount_amount: 0, payment_type: 'CASH',
  items: [{ clinic_id: 3, service_id: 41, quantity: 1 }],
};

async function issue(scenario: Scenario = {}, body: Record<string, unknown> = SERVICE_BODY) {
  const calls: QueryCall[] = [];
  const handler = handlerFor(scenario);
  const { res, captured } = makeRes();
  const record = (text: string, params: unknown[] = []): MockResult => {
    calls.push({ text, params });
    return handler(text, params);
  };
  (pool as unknown as { query: unknown }).query = async (t: string, p: unknown[] = []) => record(t, p);
  (pool as unknown as { connect: unknown }).connect = async () =>
    ({ query: async (t: string, p: unknown[] = []) => record(t, p), release: () => undefined } as any);
  try {
    await createInvoice(issueReq(body), res);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
  const texts = calls.map((c) => c.text.trim());
  return {
    captured,
    calls,
    texts,
    invoiceInsert: calls.find((c) => c.text.trim().startsWith('INSERT INTO invoices')),
    lineInserts: calls.filter((c) => c.text.trim().startsWith('INSERT INTO invoice_items')),
    paymentInserts: calls.filter((c) => c.text.trim().startsWith('INSERT INTO payments')),
  };
}

test('ISSUE: فاتورة الخدمات بعد العتبة تُصدر غير محصّلة', async () => {
  const { captured, invoiceInsert } = await issue();
  assert.equal(captured.status, 201);
  assert.equal(invoiceInsert!.params[6], 0, 'paid_amount = 0 بعد العتبة');
  assert.equal(captured.body.paid_amount, 0);
  assert.equal(captured.body.remaining, 100, 'المتبقي = الصافي');
  assert.equal(captured.body.status, 'UNPAID');
  assert.equal(captured.body.settlement, 'PAYMENT_BACKED');
});

test('ISSUE: الإصدار لا ينشئ أي دفعة', async () => {
  const { paymentInserts, texts } = await issue();
  assert.equal(paymentInserts.length, 0);
  assert.equal(texts.some((t) => t.includes('FROM payments')), false);
});

test('ISSUE: الإجماليات والصافي لم تتغير', async () => {
  const { captured } = await issue();
  assert.equal(captured.body.total_amount, 100);
  assert.equal(captured.body.net_amount, 100);
  assert.equal(captured.body.discount_amount, 0);
});

test('ISSUE: payment_type يُحفظ كإعلان ولا يُشتق منه محصّل', async () => {
  const { invoiceInsert } = await issue({}, { ...SERVICE_BODY, payment_type: 'INSURANCE' });
  assert.equal(invoiceInsert!.params[7], 'INSURANCE', 'القيمة المعلنة محفوظة');
  assert.equal(invoiceInsert!.params[6], 0, 'لكن المدفوع صفر: الإعلان ليس سنداً');
});

test('ISSUE: رسالة الإصدار لا تدّعي تحصيلاً بعد العتبة', async () => {
  const { captured } = await issue();
  assert.match(String(captured.body.message), /لم يُحصَّل/);
  assert.doesNotMatch(String(captured.body.message), /وتحصيل المبلغ/);
});

test('ISSUE: عتبة لم يأتِ بعد تُبقي الإصدار المحصّل القديم', async () => {
  // The data-driven boundary: if the marker is dated ahead of us, this build is
  // still the legacy one and invoices stay born settled.
  const { captured, invoiceInsert } = await issue({ cutoverAt: CUTOVER_FUTURE });
  assert.equal(captured.status, 201);
  assert.equal(invoiceInsert!.params[6], 100, 'قبل العتبة: مدفوع = صافي');
  assert.equal(captured.body.status, 'PAID');
  assert.equal(captured.body.settlement, 'LEGACY');
});

test('ISSUE: غياب العتبة يُفشل صريحاً ولا يُصدر فاتورة', async () => {
  const { captured, invoiceInsert, texts } = await issue({ cutoverAt: null });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.code, 'SETTLEMENT_CUTOVER_MISSING');
  assert.equal(invoiceInsert, undefined, 'لا فاتورة على قاعدة بلا تسوية');
  assert.equal(texts.includes('COMMIT'), false);
  assert.equal(texts.includes('ROLLBACK'), true);
});

test('ISSUE: العتبة تُقرأ داخل المعاملة قبل الإدراج', async () => {
  const { texts, invoiceInsert } = await issue();
  const cutoverIndex = texts.findIndex((t) => t.includes('FROM settlement_cutover'));
  // نص الإدراج متعدد الأسطر، فـ indexOf على 'INSERT INTO invoices' لا يطابقه أبداً
  const insertIndex = texts.findIndex((t) => t.startsWith('INSERT INTO invoices'));
  assert.ok(cutoverIndex > -1, 'العتبة تُقرأ');
  assert.ok(insertIndex > -1, 'والفاتورة تُدرَج');
  assert.ok(insertIndex > cutoverIndex, 'تُقرأ قبل الكتابة');
});

test('ISSUE: قرار ما بعد العبة يُستقبل من قاعدة البيانات، لا يُحسب بالساعة applications', async () => {
  // The claim this test exists to prove: the controller does NOT compute the
  // answer with `new Date()`. It consumes whatever the database says. Two
  // scenarios, the same cutover_at, opposite decisions — if the controller were
  // computing the answer itself, one of them would be wrong.
  const past = await issue({ cutoverAt: CUTOVER_PAST, postCutoverNow: false });
  assert.equal(past.captured.status, 201);
  assert.equal(past.invoiceInsert!.params[6], 100, 'الداتا تقول "قبل العبة": محصّلة');
  assert.equal(past.captured.body.settlement, 'LEGACY');

  const future = await issue({ cutoverAt: CUTOVER_FUTURE, postCutoverNow: false });
  assert.equal(future.captured.status, 201);
  assert.equal(future.invoiceInsert!.params[6], 100, 'داتا واحدة، نصيحة واحدة');
  assert.equal(future.captured.body.settlement, 'LEGACY');

  // And the source of the decision is the query result, not a host clock: the
  // mock returns `post_cutover_now` and the controller must echo it back, and it
  // must pass no application time into the query.
  const cutoverQuery = past.calls.find((c) => c.text.includes('FROM settlement_cutover'))!;
  assert.equal(cutoverQuery.params.length, 0, 'لا تُمرَّر أي ساعة من الـApplication');
  assert.ok(cutoverQuery.text.includes('post_cutover_now'), 'النتيجة تُستقبل من قاعدة البيانات');
  assert.ok(cutoverQuery.text.includes('CURRENT_TIMESTAMP >= cutover_at'), 'المقارنة تحدث على الخادم');
});

test('ISSUE: فاتورة متعددة العيادات تبقى سلوكاً مدعوماً في الإصدار', async () => {
  // 10G.3 does not change what may be issued — only what may be settled. A
  // multi-clinic invoice was always issuable and stays issuable; the payment
  // path is where it is refused.
  const { captured, lineInserts } = await issue({}, {
    ...SERVICE_BODY,
    items: [
      { clinic_id: 3, service_id: 41, quantity: 1 },
      { clinic_id: 8, service_id: 41, quantity: 1 },
    ],
  });
  assert.equal(captured.status, 201);
  assert.equal(lineInserts.length, 2, 'بنود العيادتين');
  assert.equal(captured.body.paid_amount, 0);
});

/* ==========================================================================
 * 3. TIER 2 — real catalog (opt-in)
 * ======================================================================== */

const applySettlement = async (c: PoolClient) => {
  await c.query(fs.readFileSync(path.join(MIGRATIONS, '047_payments.sql'), 'utf8'));
  await c.query(fs.readFileSync(path.join(MIGRATIONS, '048_settlement_cutover_activation.sql'), 'utf8'));
};

const withSettlement = async (fn: (c: PoolClient) => Promise<void>) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applySettlement(client);
    (pool as any).connect = async () => ({
      query: async (text: string, params: unknown[] = []) => {
        const t = String(text).trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
        return client.query(text, params);
      },
      release: () => undefined,
    });
    await fn(client);
  } finally {
    (pool as any).connect = ORIGINAL_CONNECT;
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

const seedInvoiceAt = async (c: PoolClient, createdAt: string, paid: string) => {
  const clinic = await c.query(`INSERT INTO clinics (clinic_name) VALUES ('cutover harness') RETURNING clinic_id`);
  const user = await c.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ('Harness', $1, 'x') RETURNING user_id`,
    [`cutover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`],
  );
  const patient = await c.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ('Cutover Patient', '0000001', 'FEMALE', '1992-02-02', $1) RETURNING patient_id`,
    [clinic.rows[0].clinic_id],
  );
  const invoice = await c.query(
    `INSERT INTO invoices (patient_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code, created_at)
     VALUES ($1, $2, 100, 0, 100, $3, 'CASH', 'JOD', $4) RETURNING invoice_id, created_at`,
    [patient.rows[0].patient_id, user.rows[0].user_id, paid, createdAt],
  );
  await c.query(`INSERT INTO invoice_items (invoice_id, clinic_id, price, doctor_share) VALUES ($1, $2, 100, 0)`, [
    invoice.rows[0].invoice_id,
    clinic.rows[0].clinic_id,
  ]);
  return {
    invoiceId: Number(invoice.rows[0].invoice_id),
    clinicId: Number(clinic.rows[0].clinic_id),
    userId: Number(user.rows[0].user_id),
  };
};

test('DB: صف عتبة واحد فقط، بتاريخ من الخادم وسبب مقروء', { skip: !enabled }, async () => {
  await withSettlement(async (c) => {
    const rows = (await c.query(`SELECT cutover_at, reason, set_by FROM settlement_cutover`)).rows;
    assert.equal(rows.length, 1, 'صف واحد');
    assert.ok(rows[0].cutover_at instanceof Date, 'وقت الخادم');
    assert.equal(rows[0].reason, 'Settlement payment ledger activated');
  });
});

test('DB: إعادة تشغيل 048 لا تحرّك العتبة', { skip: !enabled }, async () => {
  await withSettlement(async (c) => {
    const before = (await c.query(`SELECT cutover_at FROM settlement_cutover`)).rows[0].cutover_at;
    await c.query(fs.readFileSync(path.join(MIGRATIONS, '048_settlement_cutover_activation.sql'), 'utf8'));
    const after = (await c.query(`SELECT COUNT(*)::int AS n, MIN(cutover_at) AS at FROM settlement_cutover`)).rows[0];
    assert.equal(after.n, 1, 'ما زال صفاً واحداً');
    assert.equal(new Date(after.at).getTime(), new Date(before).getTime(), 'العتبة نفسها');
  });
});

test('DB: العتبة ما زالت غير قابلة للتعديل أو الحذف', { skip: !enabled }, async () => {
  await withSettlement(async (c) => {
    await c.query('SAVEPOINT probe');
    await assert.rejects(() => c.query(`UPDATE settlement_cutover SET cutover_at = NOW() + INTERVAL '1 day'`));
    await c.query('ROLLBACK TO SAVEPOINT probe');
    await c.query('RELEASE SAVEPOINT probe');
    await c.query('SAVEPOINT probe2');
    await assert.rejects(() => c.query(`DELETE FROM settlement_cutover`));
    await c.query('ROLLBACK TO SAVEPOINT probe2');
    await c.query('RELEASE SAVEPOINT probe2');
    const survivor = await c.query(`SELECT COUNT(*)::int AS n FROM settlement_cutover`);
    assert.equal(survivor.rows[0].n, 1);
  });
});

test('DB: التصنيف بالوقت — فاتورة قبل العتبة legacy وبعدها payment-backed', { skip: !enabled }, async () => {
  await withSettlement(async (c) => {
    const cutoverAt = (await c.query(`SELECT cutover_at FROM settlement_cutover`)).rows[0].cutover_at;
    const before = new Date(new Date(cutoverAt).getTime() - 86_400_000).toISOString();
    const after = new Date(new Date(cutoverAt).getTime() + 3_600_000).toISOString();

    const legacy = await seedInvoiceAt(c, before, '100.00');
    const backed = await seedInvoiceAt(c, after, '0.00');

    // النطاق يغطي عيادتي الفاتورتين: كل seedInvoiceAt تنشئ عيادة مستقلة، ونطاق
    // واحد لا يشمل إلا الأولى فتسقط الثانية في 404 لا في اختبار العتبة.
    const scoped = {
      userId: legacy.userId,
      roleId: 3,
      clinicId: legacy.clinicId,
      roleName: 'ACCOUNTANT',
      permissions: ['RECORD_PAYMENT'],
      clinicIds: [legacy.clinicId, backed.clinicId],
    };

    const refused = makeRes();
    await recordPayment({ body: { invoice_id: legacy.invoiceId, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, params: {}, query: {}, user: scoped } as any, refused.res);
    assert.equal(refused.captured.status, 409);
    assert.equal(refused.captured.body.code, 'LEGACY_INVOICE_READ_ONLY');
    assert.equal((await c.query(`SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1`, [legacy.invoiceId])).rows[0].n, 0);
    assert.equal(
      Number((await c.query(`SELECT paid_amount FROM invoices WHERE invoice_id = $1`, [legacy.invoiceId])).rows[0].paid_amount),
      100,
      'المدفوع التاريخي لم يُمسّ',
    );

    const accepted = makeRes();
    await recordPayment({ body: { invoice_id: backed.invoiceId, amount: 100, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, params: {}, query: {}, user: scoped } as any, accepted.res);
    assert.equal(accepted.captured.status, 201, 'ما بعد العتبة يُسوّى');
    assert.equal(accepted.captured.body.invoice.status, 'PAID');
  });
});

test('DB: فاتورة قديمة لها دفعات تظل legacy — وقت الإصدار هو المقياس وحده', { skip: !enabled }, async () => {
  await withSettlement(async (c) => {
    const cutoverAt = (await c.query(`SELECT cutover_at FROM settlement_cutover`)).rows[0].cutover_at;
    const before = new Date(new Date(cutoverAt).getTime() - 86_400_000).toISOString();
    const f = await seedInvoiceAt(c, before, '40.00');
    await c.query(
      `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id)
       VALUES ($1, $2, 40, 'PATIENT', 'CASH', 'JOD', $3)`,
      [f.invoiceId, f.clinicId, f.userId],
    );
    const scoped = { userId: f.userId, roleId: 3, clinicId: f.clinicId, roleName: 'ACCOUNTANT', permissions: ['RECORD_PAYMENT'], clinicIds: [f.clinicId] };
    const res = makeRes();
    await recordPayment({ body: { invoice_id: f.invoiceId, amount: 10, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD' }, params: {}, query: {}, user: scoped } as any, res.res);
    assert.equal(res.captured.status, 409, 'created_at هي المقياس، لا وجود الدفعات');
    assert.equal(res.captured.body.code, 'LEGACY_INVOICE_READ_ONLY');
  });
});

test('DB: الإصدار بعد العتبة لا يصنع دفعات ولا يمس الصرف والمخزون', { skip: !enabled }, async () => {
  await withSettlement(async (c) => {
    const before = {
      dispensings: (await c.query('SELECT COUNT(*)::int AS n FROM dispensings')).rows[0].n,
      batches: (await c.query('SELECT COUNT(*)::int AS n FROM inventory_batches')).rows[0].n,
      prescriptions: (await c.query('SELECT COUNT(*)::int AS n FROM prescriptions')).rows[0].n,
      credits: (await c.query('SELECT COUNT(*)::int AS n FROM medication_return_credits')).rows[0].n,
    };
    const f = await seedInvoiceAt(c, new Date().toISOString(), '0.00');
    const after = {
      dispensings: (await c.query('SELECT COUNT(*)::int AS n FROM dispensings')).rows[0].n,
      batches: (await c.query('SELECT COUNT(*)::int AS n FROM inventory_batches')).rows[0].n,
      prescriptions: (await c.query('SELECT COUNT(*)::int AS n FROM prescriptions')).rows[0].n,
      credits: (await c.query('SELECT COUNT(*)::int AS n FROM medication_return_credits')).rows[0].n,
    };
    assert.deepEqual(after, before, 'لا صرف ولا مخزون ولا روشتات ولا أرصدة إرجاع');
    assert.equal((await c.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n, 0, 'ولا دفعة من الإصدار');
  });
});

test('DB: لا أثر لل prescriptions أو dispensing في الترحيل نفسه', () => {
  const sql = codeOf(migrationSource('048_settlement_cutover_activation.sql'));
  for (const table of ['prescriptions', 'dispensing', 'inventory', 'medication_return', 'medication_dispensing']) {
    assert.ok(!sql.includes(table), `048 لا يلمس ${table}`);
  }
});