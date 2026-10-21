import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../config/database';
import { recordRefund } from '../modules/billing/refunds.controller';

/* ==========================================================================
 * Phase 10G.4b — refund write path against a real catalog
 *
 * The mocked suite proves what the code decides. This proves the SQL: real
 * NUMERIC arithmetic, real FK and CHECK constraints, real partial unique index,
 * real FOR UPDATE.
 *
 * It never touches the developer's database: 047, 048 and 049 are applied
 * INSIDE one transaction that is always rolled back, and the controller is handed
 * that same client with BEGIN/COMMIT/ROLLBACK swallowed, so everything the write
 * path does lives and dies inside that transaction. If the process dies mid-test
 * the dropped connection rolls it back too.
 *
 * Opt-in, same convention as payments.db.test.ts:
 *   SETTLEMENT_SCHEMA_TEST=1
 * ========================================================================== */

const enabled = process.env.SETTLEMENT_SCHEMA_TEST === '1';
const MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
// 047 for payments, 048 because the refund path reads the boundary and refuses to
// run without it (ON CONFLICT DO NOTHING, so it is safe to re-apply), 049 for the
// refunds table this path writes.
const SCHEMA = ['047_payments.sql', '048_settlement_cutover_activation.sql', '049_refunds.sql'];
const ORIGINAL_CONNECT = pool.connect.bind(pool);

const USER = { userId: 0, roleId: 3, clinicId: 0, roleName: 'ACCOUNTANT', permissions: ['RECORD_REFUND'], clinicIds: [] };

interface Fixture {
  clinicId: number;
  otherClinicId: number;
  userId: number;
  invoiceId: number;
  paymentId: number;
  secondPaymentId: number;
  creditId: number;
}

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

/**
 * A post-cutover invoice (created_at defaults to now, and the committed marker
 * is in the past) paid in full, with one payment carrying a 044 credit that has
 * a real refund_due_amount. The reversal half of the 044 chain is borrowed from
 * rows already in the catalog; what matters here is that the credit points at
 * THIS invoice, so only the new invoice and line are built.
 *
 * `anchorOffset` picks which borrowed reversal to use, because two constraints
 * forbid reusing one: uq_invoice_items_dispensing_item (one charged line per
 * dispensing item) and medication_return_credits.return_item_id UNIQUE (one
 * credit per return line). A test that needs a second invoice must therefore ask
 * for a second anchor.
 */
const seed = async (
  c: PoolClient,
  options: { refundDue?: string; payer?: string; anchorOffset?: number } = {},
): Promise<Fixture> => {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const clinic = await c.query(`INSERT INTO clinics (clinic_name) VALUES ($1) RETURNING clinic_id`, [`refund harness ${stamp}`]);
  const other = await c.query(`INSERT INTO clinics (clinic_name) VALUES ($1) RETURNING clinic_id`, [`other refund harness ${stamp}`]);
  const clinicId = Number(clinic.rows[0].clinic_id);
  const otherClinicId = Number(other.rows[0].clinic_id);

  const user = await c.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ('Refund Harness', $1, 'x') RETURNING user_id`,
    [`refund-harness-${stamp}`],
  );
  const userId = Number(user.rows[0].user_id);
  const patient = await c.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ('Refund Harness Patient', $1, 'MALE', '1990-01-01', $2) RETURNING patient_id`,
    [`9${stamp.slice(-6)}`, clinicId],
  );

  // The invoice is paid in two live instalments, 100 + 40, so net_amount and
  // paid_amount are BOTH 140: that keeps the 10G.2 identity
  // (paid_amount == SUM(live payments)) true in the fixture, which is what lets
  // a test assert the refund path did not disturb it.
  const invoice = await c.query(
    `INSERT INTO invoices (patient_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
     VALUES ($1, $2, 140, 0, 140, 140, 'CASH', 'JOD') RETURNING invoice_id`,
    [patient.rows[0].patient_id, userId],
  );
  const invoiceId = Number(invoice.rows[0].invoice_id);

  // One charged medication line, so the credit's invoice_item_id is a real line.
  const anchor = await c.query(
    `SELECT mrr.reversal_id, mrr.dispensing_id, mrr.dispensing_item_id, mri.return_item_id
       FROM medication_return_reversals mrr
       JOIN medication_return_items mri ON mri.return_item_id = mrr.return_item_id
      ORDER BY mrr.reversal_id LIMIT 1 OFFSET $1`,
    [options.anchorOffset ?? 0],
  );
  const item = await c.query(
    `INSERT INTO invoice_items (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
                                dispensed_quantity, unit_price_snapshot, line_total, price, quantity, medication_discount_value)
     SELECT $1, $2, di.dispensing_id, di.dispensing_item_id, di.medication_id,
            dib.quantity, 5.00, ROUND(dib.quantity * 5.00, 2), ROUND(dib.quantity * 5.00, 2), 1, 0
       FROM dispensing_items di
       JOIN dispensing_item_batches dib ON dib.dispensing_item_id = di.dispensing_item_id
      WHERE di.dispensing_item_id = $3 LIMIT 1 RETURNING item_id`,
    [invoiceId, clinicId, anchor.rows[0].dispensing_item_id],
  );

  // Generous by default so a test about the PAYMENT cap is not silently also a
  // test about the credit cap. Tests that are about the entitlement pass their
  // own small refundDue.
  const refundDue = options.refundDue ?? '1000.00';
  const credit = await c.query(
    `INSERT INTO medication_return_credits
       (return_item_id, reversal_id, dispensing_id, dispensing_item_id, invoice_id, invoice_item_id,
        clinic_id, returned_quantity, unit_price_snapshot, medication_discount_value,
        gross_amount, net_amount, credit_amount, applied_to_outstanding, refund_due_amount,
        invoice_net_amount, invoice_paid_amount, currency_code)
     SELECT mri.return_item_id, mrr.reversal_id, $2, mrr.dispensing_item_id, $3, $4, $5,
            mri.quantity, 5.00, 0, 5.00, 5.00, $6, 0.00, $7, 140.00, 140.00, 'JOD'
       FROM medication_return_items mri
       JOIN medication_return_reversals mrr ON mrr.return_item_id = mri.return_item_id
      WHERE mrr.reversal_id = $1 RETURNING credit_id`,
    [anchor.rows[0].reversal_id, anchor.rows[0].dispensing_id, invoiceId, item.rows[0].item_id, clinicId, refundDue, refundDue],
  );

  const payment = await c.query(
    `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id)
     VALUES ($1, $2, 100, $3, 'CASH', 'JOD', $4) RETURNING payment_id`,
    [invoiceId, clinicId, options.payer ?? 'PATIENT', userId],
  );
  const second = await c.query(
    `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id)
     VALUES ($1, $2, 40, $3, 'CARD', 'JOD', $4) RETURNING payment_id`,
    [invoiceId, clinicId, options.payer ?? 'PATIENT', userId],
  );

  return {
    clinicId,
    otherClinicId,
    userId,
    invoiceId,
    paymentId: Number(payment.rows[0].payment_id),
    secondPaymentId: Number(second.rows[0].payment_id),
    creditId: Number(credit.rows[0].credit_id),
  };
};

const withRealSchema = async (
  fn: (c: PoolClient, fixture: Fixture, scoped: Record<string, unknown>) => Promise<void>,
  options: Parameters<typeof seed>[1] = {},
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of SCHEMA) {
      await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    (pool as any).connect = async () => ({
      query: async (text: string, params: unknown[] = []) => {
        const t = String(text).trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
        return client.query(text, params);
      },
      release: () => undefined,
    });

    const fixture = await seed(client, options);
    const scoped = { ...USER, userId: fixture.userId, clinicId: fixture.clinicId, clinicIds: [fixture.clinicId] };
    await fn(client, fixture, scoped);
  } finally {
    (pool as any).connect = ORIGINAL_CONNECT;
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

const refund = async (body: Record<string, unknown>, user: Record<string, unknown>) => {
  const { res, captured } = makeRes();
  await recordRefund(req(body, user), res);
  return { status: captured.status, ...(captured.body ?? {}) };
};

// credit_id is part of the ordinary body: RETURN_CREDIT requires it (049's
// chk_refunds_return_credit_needs_credit), so a refund without it is a body error.
const body = (f: Fixture, amount: number, extra: Record<string, unknown> = {}) =>
  ({ payment_id: f.paymentId, amount, currency_code: 'JOD', reason: 'RETURN_CREDIT', credit_id: f.creditId, ...extra });

const refundRows = async (c: PoolClient, where: string, id: number) =>
  (await c.query(
    `SELECT amount, payer_type, method, currency_code, credit_id, reason, voided_at
     FROM refunds WHERE ${where} = $1 ORDER BY refund_id`,
    [id],
  )).rows;

const invoiceRow = async (c: PoolClient, invoiceId: number) =>
  (await c.query(`SELECT net_amount, paid_amount FROM invoices WHERE invoice_id = $1`, [invoiceId])).rows[0];

// An expected constraint violation aborts the enclosing transaction, so each one
// gets a savepoint to roll back to. Without this, the next statement is 25P02 and
// the test fails for the wrong reason.
let savepoint = 0;
const violating = async (c: PoolClient, sql: string, params: unknown[], match: (error: any) => boolean) => {
  const name = `sp_${savepoint++}`;
  await c.query(`SAVEPOINT ${name}`);
  await assert.rejects(c.query(sql, params), match);
  await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
  await c.query(`RELEASE SAVEPOINT ${name}`);
};

/* ==========================================================================
 * 1. THE ORDINARY CASE
 * ======================================================================== */

test('DB: استرداد ناجح يُسجَّل، والمصطلحات مشتقّة من الدفعة', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const out = await refund(body(f, 20), scoped);
    assert.equal(out.status, 201);
    assert.equal(out.idempotent_replay, false);

    const rows = await refundRows(c, 'payment_id', f.paymentId);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].amount), 20);
    assert.equal(rows[0].payer_type, 'PATIENT', 'من الدفعة');
    assert.equal(rows[0].method, 'CASH', 'من الدفعة');
    assert.equal(rows[0].currency_code, 'JOD');
    assert.equal(rows[0].voided_at, null);
    assert.equal(out.payment.refundable_remaining, 80);
  });
});

test('DB: الاسترداد الجزئي يتراكم، والثاني يقرأ الأول', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const first = await refund(body(f, 30), scoped);
    assert.equal(first.status, 201);
    assert.equal(first.payment.refunded_total, 30);
    assert.equal(first.payment.refundable_remaining, 70);

    const second = await refund(body(f, 20), scoped);
    assert.equal(second.status, 201, 'استرداد جزئي ثانٍ مشروع');
    assert.equal(second.payment.refunded_total, 50);
    assert.equal(second.payment.refundable_remaining, 50);

    const rows = await refundRows(c, 'payment_id', f.paymentId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => Number(r.amount)), [30, 20]);
  });
});

/* ==========================================================================
 * 2. NO MUTATION — the property the whole phase rests on
 * ======================================================================== */

test('DB: لا تعديل على الفاتورة ولا الدفعات ولا البنود ولا الائتمان', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const before = {
      invoice: await invoiceRow(c, f.invoiceId),
      payments: (await c.query(`SELECT payment_id, amount, voided_at FROM payments WHERE invoice_id = $1 ORDER BY payment_id`, [f.invoiceId])).rows,
      items: (await c.query(`SELECT item_id, line_total, price, quantity FROM invoice_items WHERE invoice_id = $1 ORDER BY item_id`, [f.invoiceId])).rows,
      credit: (await c.query(`SELECT * FROM medication_return_credits WHERE credit_id = $1`, [f.creditId])).rows[0],
    };

    assert.equal((await refund(body(f, 20), scoped)).status, 201);

    const after = {
      invoice: await invoiceRow(c, f.invoiceId),
      payments: (await c.query(`SELECT payment_id, amount, voided_at FROM payments WHERE invoice_id = $1 ORDER BY payment_id`, [f.invoiceId])).rows,
      items: (await c.query(`SELECT item_id, line_total, price, quantity FROM invoice_items WHERE invoice_id = $1 ORDER BY item_id`, [f.invoiceId])).rows,
      credit: (await c.query(`SELECT * FROM medication_return_credits WHERE credit_id = $1`, [f.creditId])).rows[0],
    };

    // THE invariant: paid_amount is untouched. A fully paid, fully refunded
    // invoice still reads PAID, which is true — and reports' outstanding does
    // not grow by a debt that was never owed.
    assert.equal(Number(after.invoice.paid_amount), Number(before.invoice.paid_amount), 'invoices.paid_amount unchanged');
    assert.deepEqual(after.payments, before.payments, 'the payment ledger is never written');
    assert.deepEqual(after.items, before.items, 'invoice lines are never written');
    assert.deepEqual(after.credit, before.credit, 'the 044 credit keeps recording the entitlement it was born with');

    // And reconciliation still holds: paid_amount == SUM(live payments).
    const live = await c.query(
      `SELECT (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = $1 AND voided_at IS NULL) AS paid,
              (SELECT COALESCE(SUM(amount), 0) FROM refunds  WHERE invoice_id = $1 AND voided_at IS NULL) AS refunded`,
      [f.invoiceId],
    );
    assert.equal(Number(live.rows[0].paid), Number(after.invoice.paid_amount), 'the 10G.2 identity still holds');
    assert.equal(Number(live.rows[0].refunded), 20, 'cash out is counted separately, never netted against it');
  });
});

test('DB: استردادان على دفعتين لفاتورة واحدة — المتبقي مستقل لكل منهما', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const fromFirst = await refund({ ...body(f, 100), payment_id: f.paymentId }, scoped);
    assert.equal(fromFirst.status, 201, 'كامل نقد الدفعة الأولى');
    assert.equal(fromFirst.payment.refundable_remaining, 0);

    const fromSecond = await refund({ ...body(f, 15), payment_id: f.secondPaymentId }, scoped);
    assert.equal(fromSecond.status, 201, 'الدفعة الثانية لها نقدها الخاص');
    assert.equal(fromSecond.payment.refundable_remaining, 25);
    assert.equal(Number((await invoiceRow(c, f.invoiceId)).paid_amount), 140, 'الفاتورة لم تتغير');
  });
});

/* ==========================================================================
 * 3. THE CAPS, against real NUMERIC arithmetic
 * ======================================================================== */

test('DB: تجاوز نقد الدفعة مرفوض ولا يترك مالاً يتحرك', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    assert.equal((await refund(body(f, 70), scoped)).status, 201);

    const over = await refund(body(f, 30.01), scoped);
    assert.equal(over.status, 409);
    assert.equal(over.code, 'REFUND_EXCEEDS_PAYMENT');
    assert.equal(over.refundable_remaining, 30);
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 1);

    const exact = await refund(body(f, 30), scoped);
    assert.equal(exact.status, 201, 'بلوغ نقد الدفعة بالضبط مسموح');
    assert.equal(exact.payment.refundable_remaining, 0);

    const beyond = await refund(body(f, 0.01), scoped);
    assert.equal(beyond.status, 409, 'ولا دقيقة واحدة بعد النفاد');
  });
});

test('DB: الاستحقاق مستنفد مرفوض، والتجزئة حتى نفاده مسموحة', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const first = await refund(body(f, 20, { credit_id: f.creditId }), scoped);
    assert.equal(first.status, 201);

    const second = await refund(body(f, 10, { credit_id: f.creditId }), scoped);
    assert.equal(second.status, 201, 'استحقاق 30.00 على شريحتين');
    assert.equal((await refundRows(c, 'credit_id', f.creditId)).length, 2);

    const exhausted = await refund(body(f, 0.01, { credit_id: f.creditId }), scoped);
    assert.equal(exhausted.status, 409);
    assert.equal(exhausted.code, 'NO_REFUND_ENTITLEMENT');
    assert.equal(exhausted.remaining_entitlement, 0);

    // The payment still has cash; only the entitlement is gone. The two caps are
    // independent, and the refusal names the one that fired.
    assert.ok(Number((await refundRows(c, 'payment_id', f.paymentId)).reduce((t, r) => t + Number(r.amount), 0)) < 100);
    assert.equal((await refundRows(c, 'credit_id', f.creditId)).length, 2, 'ولا سطر إضافي');
  }, { refundDue: '30.00' });
});

test('DB: استحقاق صفر — دواء غير مدفوع — لا استرداد منه إطلاقاً', { skip: !enabled }, async () => {
  // This is the DEFERRED invariant, observed rather than fixed: 044 computed
  // refund_due_amount against a paid_amount of zero, so a credit recorded BEFORE
  // payment yields an entitlement of 0 — and nothing re-derives it when the
  // payment later arrives. The refusal is explicit, which is all 10G.4b promises.
  await withRealSchema(async (c, f, scoped) => {
    const out = await refund(body(f, 5, { credit_id: f.creditId }), scoped);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'NO_REFUND_ENTITLEMENT');
    assert.equal(out.refund_due_amount, 0);
    assert.equal(out.remaining_entitlement, 0);
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
  }, { refundDue: '0.00' });
});

test('DB: استحقاق مريض لا يُفرَّغ من نقد شركة التأمين', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const out = await refund(body(f, 5, { credit_id: f.creditId }), scoped);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'PAYER_MISMATCH');
    assert.equal(out.payer_type, 'INSURER');
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
  }, { payer: 'INSURER' });
});

test('DB: ائتمان من فاتورة أخرى مرفوض', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const other = await seed(c, { refundDue: '50.00', anchorOffset: 1 });
    const out = await refund(body(f, 5, { credit_id: other.creditId }), scoped);
    assert.equal(out.status, 409);
    assert.equal(out.credit_invoice_id, other.invoiceId);
    assert.equal(out.payment_invoice_id, f.invoiceId);
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
  });
});

test('DB: ائتمان غير موجود أو دفعة غير موجودة لا يُكتب شيء', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const noCredit = await refund(body(f, 5, { credit_id: 999999 }), scoped);
    assert.equal(noCredit.status, 404);
    const noPayment = await refund({ ...body(f, 5), payment_id: 999999 }, scoped);
    assert.equal(noPayment.status, 404);
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
  });
});

/* ==========================================================================
 * 4. REFUSALS THAT DO NOT DEPEND ON SQL TYPES
 * ======================================================================== */

test('DB: دفعة ملغاة لا يُردّ منها نقد', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    // chk_payments_void_consistent requires the stamp and the actor together,
    // exactly like chk_refunds_void_consistent.
    await c.query(`UPDATE payments SET voided_at = NOW(), voided_by_user_id = $2, void_reason = 'test' WHERE payment_id = $1`, [f.paymentId, f.userId]);
    const out = await refund(body(f, 20), scoped);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'PAYMENT_VOIDED');
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
  });
});

test('DB: عملة مختلفة تُرفض ولا تُحوَّل', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const out = await refund({ ...body(f, 10), currency_code: 'USD' }, scoped);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'CURRENCY_MISMATCH');
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
  });
});

test('DB: فاتورة ببنود من عيادة أخرى تُرفض، وعيادة أخرى محجوبة', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    // A second line from another clinic: two authorities, no truthful choice.
    await c.query(`INSERT INTO invoice_items (invoice_id, clinic_id, price) VALUES ($1, $2, 10)`, [f.invoiceId, f.otherClinicId]);
    const cross = await refund(body(f, 10), scoped);
    assert.equal(cross.status, 409);
    assert.equal(cross.code, 'CROSS_CLINIC_INVOICE');
    assert.deepEqual(cross.invoice_clinic_ids.sort(), [f.clinicId, f.otherClinicId].sort());

    const single = await seed(c, { anchorOffset: 1 });
    const outsider = { ...scoped, clinicIds: [single.otherClinicId], clinicId: single.otherClinicId };
    const denied = await refund(body(single, 10), outsider);
    assert.equal(denied.status, 404, 'لا يُكشف وجود الدفعة لعيادة أخرى');
    assert.equal((await refundRows(c, 'payment_id', single.paymentId)).length, 0);
  });
});

test('DB: فاتورة قبل العتبة تُرفض ولا يتحرك مال', { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of SCHEMA) await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    (pool as any).connect = async () => ({
      query: async (text: string, params: unknown[] = []) => {
        const t = String(text).trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
        return client.query(text, params);
      },
      release: () => undefined,
    });
    const f = await seed(client);
    // Move the invoice behind the committed boundary: its paid_amount is then a
    // historical assertion and cash must not move against it.
    await client.query(`UPDATE invoices SET created_at = '2019-01-01T00:00:00.000Z' WHERE invoice_id = $1`, [f.invoiceId]);
    const scoped = { ...USER, userId: f.userId, clinicId: f.clinicId, clinicIds: [f.clinicId] };

    const out = await refund(body(f, 20), scoped);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'LEGACY_INVOICE_READ_ONLY');
    assert.equal((await refundRows(client, 'payment_id', f.paymentId)).length, 0);
    assert.equal(Number((await invoiceRow(client, f.invoiceId)).paid_amount), 140, 'التأكيد التاريخي لم يُمسّ');
  } finally {
    (pool as any).connect = ORIGINAL_CONNECT;
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('DB: العتبة غير قابلة للحذف — 그래서 فرع "العتبة مفقودة" غير قابل للوصول هنا', { skip: !enabled }, async () => {
  // 047 guards settlement_cutover with BEFORE UPDATE OR DELETE and BEFORE
  // TRUNCATE row triggers. So on a database where 048 HAS run, the marker cannot
  // be removed even inside a transaction: SETTLEMENT_CUTOVER_MISSING is reachable
  // only where 048 was never applied, which is exactly the state that branch means
  // and exactly what the mocked tier simulates.
  //
  // Asserting the trigger rather than faking a missing row is the honest version
  // of this test — and it is a stronger claim: the boundary cannot drift.
  await withRealSchema(async (c, f, scoped) => {
    await violating(c, `DELETE FROM settlement_cutover WHERE singleton = TRUE`, [], () => true);
    await violating(c, `UPDATE settlement_cutover SET cutover_at = NOW() WHERE singleton = TRUE`, [], () => true);

    const before = (await c.query(`SELECT cutover_at FROM settlement_cutover WHERE singleton = TRUE`)).rows[0];
    const out = await refund(body(f, 20), scoped);
    assert.equal(out.status, 201, 'وعند عتبة سليمة يعمل الاسترداد عادياً');
    const after = (await c.query(`SELECT cutover_at FROM settlement_cutover WHERE singleton = TRUE`)).rows[0];
    assert.equal(String(after.cutover_at), String(before.cutover_at), 'والعتبة نفسها لم تتحرك');
  });
});

/* ==========================================================================
 * 5. IDEMPOTENCY AND AUDIT
 * ======================================================================== */

test('DB: إعادة الطلب بنفس المفتاح لا تُنشئ حركة مال ثانية', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const request = body(f, 20, { idempotency_key: 'req-1' });
    const first = await refund(request, scoped);
    assert.equal(first.status, 201);

    const replay = await refund(request, scoped);
    assert.equal(replay.status, 200);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.refund.refund_id, first.refund.refund_id);
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 1, 'سطر واحد');
    assert.equal(Number((await invoiceRow(c, f.invoiceId)).paid_amount), 140);

    // A different payment with the SAME key is a different request: the index is
    // anchored per payment, not global.
    const other = await refund({ ...body(f, 5), payment_id: f.secondPaymentId, idempotency_key: 'req-1' }, scoped);
    assert.equal(other.status, 201);
    assert.notEqual(other.refund.refund_id, first.refund.refund_id);
  });
});

test('DB: تدقيق REFUND_RECORDED واحد باسم من سجّل، داخل المعاملة', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    await refund(body(f, 20), scoped);
    const audits = await c.query(
      `SELECT action, resource_type, resource_id, metadata FROM audit_logs
        WHERE action = 'REFUND_RECORDED' AND user_id = $1 ORDER BY audit_id`,
      [f.userId],
    );
    assert.equal(audits.rows.length, 1, 'سطر تدقيق واحد');
    assert.equal(audits.rows[0].resource_type, 'REFUND');
    const refundId = (await c.query(`SELECT refund_id FROM refunds WHERE payment_id = $1 ORDER BY refund_id`, [f.paymentId])).rows[0].refund_id;
    assert.equal(audits.rows[0].resource_id, String(refundId), 'المورد يشير إلى الاسترداد نفسه');
    assert.equal(audits.rows[0].metadata.payment_id, f.paymentId);
    assert.equal(audits.rows[0].metadata.invoice_id, f.invoiceId);
    assert.equal(Number(audits.rows[0].metadata.amount), 20);
    assert.equal(audits.rows[0].metadata.refunded_total, 20);
  });
});

test('DB: استرداد ائتمان بلا credit_id مرفوض قبل أي كتابة', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const { credit_id: _dropped, ...withoutCredit } = body(f, 20);
    const out = await refund(withoutCredit, scoped);
    assert.equal(out.status, 400);
    assert.equal(out.code, 'VALIDATION_ERROR');
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
    const audits = await c.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'REFUND_RECORDED' AND user_id = $1`, [f.userId]);
    assert.equal(audits.rows[0].n, 0);
  });
});

test('DB: كل رفض يترك صفراً من الاستردادات وصفراً من التدقيق', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    const refusals: Array<Promise<{ status: number }>> = [
      refund(body(f, 200), scoped),
      refund(body(f, 5, { credit_id: 999999 }), scoped),
      refund({ ...body(f, 5), currency_code: 'USD' }, scoped),
      refund({ ...body(f, 5), payment_id: 999999 }, scoped),
    ];
    for (const r of await Promise.all(refusals)) assert.notEqual(r.status, 201);
    assert.equal((await refundRows(c, 'payment_id', f.paymentId)).length, 0);
    const audits = await c.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'REFUND_RECORDED' AND user_id = $1`, [f.userId]);
    assert.equal(audits.rows[0].n, 0, 'لا تدقيق لرفض لم يُسجَّل مال');
  });
});

/* ==========================================================================
 * 6. THE FIXTURE ITSELF — proves nothing here is a fiction
 * ======================================================================== */

test('DB: المفتاح الجزئي يُطبَّق في القاعدة، لا في الكود وحده', { skip: !enabled }, async () => {
  // Standalone, not inside withRealSchema: that harness replaces pool.connect, so
  // a nested client there is the stub and BEGINs on the harness's own transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of SCHEMA) await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    const f = await seed(client);

    // Straight at the table, bypassing the controller: the same key twice on one
    // payment is a constraint violation, whatever the code thinks.
    const keyed = `INSERT INTO refunds (payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code, credit_id, reason, refunded_by_user_id, idempotency_key)
                   VALUES ($1, $2, $3, 5, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5, 'dup')`;
    const params = [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId];
    await client.query(keyed, params);
    await violating(
      client,
      keyed,
      params,
      (error: any) => error.code === '23505' && /uq_refunds_payment_idempotency/.test(error.message),
    );

    // The same key on a DIFFERENT payment is a different request.
    await client.query(keyed, [f.secondPaymentId, f.invoiceId, f.clinicId, f.creditId, f.userId]);

    // And absent keys never collide with each other.
    const unkeyed = `INSERT INTO refunds (payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code, credit_id, reason, refunded_by_user_id)
                     VALUES ($1, $2, $3, 5, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5)`;
    await client.query(unkeyed, params);
    await client.query(unkeyed, params);
    const count = await client.query(`SELECT COUNT(*)::int AS n FROM refunds WHERE payment_id = $1`, [f.paymentId]);
    assert.equal(count.rows[0].n, 3, 'مفتاح واحد + مفتاحان غائبان');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('DB: لا شيء من هذا المسار يكتب على جدول غير refunds و audit_logs', { skip: !enabled }, async () => {
  await withRealSchema(async (c, f, scoped) => {
    // Snapshot every other financial table, refund, and compare.
    const snapshot = async () => ({
      invoices: (await c.query(`SELECT invoice_id, net_amount, paid_amount, total_amount, discount_amount FROM invoices ORDER BY invoice_id`)).rows,
      payments: (await c.query(`SELECT payment_id, invoice_id, amount, payer_type, method, voided_at FROM payments ORDER BY payment_id`)).rows,
      items: (await c.query(`SELECT item_id, invoice_id, line_total, price, quantity FROM invoice_items ORDER BY item_id`)).rows,
      credits: (await c.query(`SELECT credit_id, credit_amount, applied_to_outstanding, refund_due_amount FROM medication_return_credits ORDER BY credit_id`)).rows,
      cutover: (await c.query(`SELECT cutover_at FROM settlement_cutover ORDER BY singleton`)).rows,
    });
    const before = await snapshot();
    await refund(body(f, 20, { credit_id: f.creditId }), scoped);
    assert.deepEqual(await snapshot(), before);
  });
});