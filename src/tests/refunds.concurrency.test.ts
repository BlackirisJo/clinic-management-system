import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../config/database';
import { recordRefund } from '../modules/billing/refunds.controller';

/* ==========================================================================
 * Phase 10G.4b — refund write path under REAL contention
 *
 * The mocked suite proves the code asks for `FOR UPDATE`. This proves Postgres
 * honours it, which is the claim that actually protects the money: two refunds
 * racing for one payment must serialize, and two refunds against different
 * payments of one invoice must NOT.
 *
 * So unlike refunds.db.test.ts, the schema has to be COMMITTED — two connections
 * cannot see DDL living inside someone else's transaction. This suite therefore
 * applies 049 for real and drops it in `after`, commits its fixtures and deletes
 * them afterwards. Nothing is left behind either way.
 *
 * The proof is causal rather than timing-based. A gate holds request A inside its
 * transaction, already holding the locks, while B runs to completion:
 *   - same payment: B cannot get the row, so it is refused on the live cap;
 *   - one invoice, two payments: B is never blocked, and the event log proves
 *     B committed while A was still held.
 * If the payment lock were missing, B would finish early and be over-refunded.
 * If the invoice were locked, B could not finish before A is released.
 *
 * Opt-in, same convention as the rest of the DB tier:
 *   SETTLEMENT_SCHEMA_TEST=1
 * ========================================================================== */

const enabled = process.env.SETTLEMENT_SCHEMA_TEST === '1';
const MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const ORIGINAL_CONNECT = pool.connect.bind(pool);

const USER = { userId: 0, roleId: 3, clinicId: 0, roleName: 'ACCOUNTANT', permissions: ['RECORD_REFUND'], clinicIds: [] };
// If the gate is ever wrong the suite must fail, not hang: this bounds any wait
// the gate itself is holding.
const SAFETY_MS = 5000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const call = async (body: Record<string, unknown>, user: Record<string, unknown>) => {
  const { res, captured } = makeRes();
  await recordRefund({ body, params: {}, query: {}, user } as any, res);
  return { status: captured.status, ...(captured.body ?? {}) };
};

interface Seed {
  clinicId: number;
  userId: number;
  patientId: number;
  invoiceId: number;
  creditIds: number[];
  paymentIds: number[];
}

/**
 * A paid invoice, one charged line and one 044 credit per `credits`, and one
 * payment per entry. Reversal/dispensing rows are BORROWED from the catalog for
 * the reason refunds.db.test.ts borrows them: uq_invoice_items_dispensing_item
 * and UNIQUE (return_item_id) make any second line need a second anchor.
 */
const seed = async (c: PoolClient, payments: number[], credits: number): Promise<Seed> => {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const total = payments.reduce((t, n) => t + n, 0);
  const clinic = await c.query(`INSERT INTO clinics (clinic_name) VALUES ($1) RETURNING clinic_id`, [`concurrency harness ${stamp}`]);
  const clinicId = Number(clinic.rows[0].clinic_id);
  const user = await c.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ('Concurrency Harness', $1, 'x') RETURNING user_id`,
    [`concurrency-harness-${stamp}`],
  );
  const userId = Number(user.rows[0].user_id);
  const patient = await c.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ('Concurrency Harness Patient', $1, 'MALE', '1990-01-01', $2) RETURNING patient_id`,
    [`8${stamp.slice(-6)}`, clinicId],
  );
  const patientId = Number(patient.rows[0].patient_id);
  // paid_amount mirrors SUM(live payments): the 10G.2 identity has to hold
  // BEFORE any refund runs, or the test would be measuring its own fixture.
  const invoice = await c.query(
    `INSERT INTO invoices (patient_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
     VALUES ($1, $2, $3, 0, $3, $3, 'CASH', 'JOD') RETURNING invoice_id`,
    [patientId, userId, total],
  );
  const invoiceId = Number(invoice.rows[0].invoice_id);

  const creditIds: number[] = [];
  for (let i = 0; i < credits; i++) {
    // Anchors that no committed row already uses. This suite COMMITS its
    // fixtures, so a process killed mid-test can leave rows behind; asking the
    // catalog which anchors are free makes a leftover harmless instead of a
    // uq_invoice_items_dispensing_item failure in another suite.
    const anchor = await c.query(
      `SELECT mrr.reversal_id, mrr.dispensing_id, mrr.dispensing_item_id
         FROM medication_return_reversals mrr
         JOIN medication_return_items mri ON mri.return_item_id = mrr.return_item_id
        WHERE NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.dispensing_item_id = mrr.dispensing_item_id)
          AND NOT EXISTS (SELECT 1 FROM medication_return_credits rc WHERE rc.return_item_id = mri.return_item_id)
        ORDER BY mrr.reversal_id
        LIMIT 1 OFFSET $1`,
      [i],
    );
    if (anchor.rows.length === 0) throw new Error('the catalog has no unused reversal anchor left for this fixture');
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
    const credit = await c.query(
      `INSERT INTO medication_return_credits
         (return_item_id, reversal_id, dispensing_id, dispensing_item_id, invoice_id, invoice_item_id,
          clinic_id, returned_quantity, unit_price_snapshot, medication_discount_value,
          gross_amount, net_amount, credit_amount, applied_to_outstanding, refund_due_amount,
          invoice_net_amount, invoice_paid_amount, currency_code)
       SELECT mri.return_item_id, mrr.reversal_id, $2, mrr.dispensing_item_id, $3, $4, $5,
              mri.quantity, 5.00, 0, 5.00, 5.00, 1000.00, 0.00, 1000.00, $6, $6, 'JOD'
         FROM medication_return_items mri
         JOIN medication_return_reversals mrr ON mrr.return_item_id = mri.return_item_id
        WHERE mrr.reversal_id = $1 RETURNING credit_id`,
      [anchor.rows[0].reversal_id, anchor.rows[0].dispensing_id, invoiceId, Number(item.rows[0].item_id), clinicId, total],
    );
    creditIds.push(Number(credit.rows[0].credit_id));
  }

  const paymentIds: number[] = [];
  for (const amount of payments) {
    const payment = await c.query(
      `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id)
       VALUES ($1, $2, $3, 'PATIENT', 'CASH', 'JOD', $4) RETURNING payment_id`,
      [invoiceId, clinicId, amount, userId],
    );
    paymentIds.push(Number(payment.rows[0].payment_id));
  }
  return { clinicId, userId, patientId, invoiceId, creditIds, paymentIds };
};

const drop = async (s: Seed) => {
  const client = await ORIGINAL_CONNECT();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM refunds WHERE payment_id = ANY($1::int[])`, [s.paymentIds]);
    await client.query(`DELETE FROM audit_logs WHERE user_id = $1`, [s.userId]);
    await client.query(`DELETE FROM payments WHERE payment_id = ANY($1::int[])`, [s.paymentIds]);
    await client.query(`DELETE FROM medication_return_credits WHERE credit_id = ANY($1::int[])`, [s.creditIds]);
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [s.invoiceId]);
    await client.query(`DELETE FROM invoices WHERE invoice_id = $1`, [s.invoiceId]);
    await client.query(`DELETE FROM patients WHERE patient_id = $1`, [s.patientId]);
    await client.query(`DELETE FROM users WHERE user_id = $1`, [s.userId]);
    await client.query(`DELETE FROM clinics WHERE clinic_id = $1`, [s.clinicId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/* ==========================================================================
 * The gate: hold one request inside its transaction, record what the other does
 * ======================================================================== */

type Lock = { started: number; finished: number | null };
type Commit = { started: number };

interface Gate { arrived: Promise<void>; open: () => void }

/** The gate must never become the thing that hangs: bounded, and loud when it trips. */
const bounded = async (what: string, promise: Promise<void>) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} خلال ${SAFETY_MS}ms — الطلب A لم يصل إلى بوابة الاستحقاق`)), SAFETY_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Wraps pool.connect so each request gets its own REAL connection and the log
 * records when a payment row lock was requested, when it was actually granted,
 * and when a transaction committed. The gate holds the request tagged `holdKey`
 * at the moment it is about to insert — locks taken, aggregate already read,
 * nothing written.
 */
const instrument = () => {
  const locks: Lock[] = [];
  const commits: Commit[] = [];
  let holdKey: string | null = null;
  let armed = false;
  let arrive!: () => void;
  let open!: () => void;
  let waited!: Promise<void>;

  (pool as any).connect = async () => {
    const client = await ORIGINAL_CONNECT();
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = String(text);
        const locksPayment = /payments/i.test(sql) && /FOR UPDATE/i.test(sql);
        const insertsRefund = /INSERT\s+INTO\s+refunds/i.test(sql);
        const isCommit = sql.trim() === 'COMMIT';
        const key = insertsRefund ? params.find(p => p === 'A' || p === 'B') as string | undefined : undefined;

        if (armed && insertsRefund && key === holdKey) {
          armed = false;
          arrive();
          await Promise.race([waited, sleep(SAFETY_MS)]);
        }

        const started = Date.now();
        if (locksPayment) locks.push({ started, finished: null });
        if (isCommit) commits.push({ started });
        try {
          const result = await client.query(text, params);
          if (locksPayment) {
            const pending = locks[locks.length - 1]!;
            if (pending.finished === null) pending.finished = Date.now();
          }
          return result;
        } catch (error) {
          if (locksPayment) {
            const pending = locks[locks.length - 1]!;
            if (pending.finished === null) pending.finished = Date.now();
          }
          throw error;
        }
      },
      release: () => client.release(),
    };
  };

  return {
    locks,
    commits,
    restore: () => { (pool as any).connect = ORIGINAL_CONNECT; },
    hold: (key: string): Gate => {
      holdKey = key;
      armed = true;
      const arrived = new Promise<void>(resolve => { arrive = resolve; });
      waited = new Promise<void>(resolve => { open = resolve; });
      return { arrived, open };
    },
    /** Resolve once `count` payment locks have been GRANTED. */
    granted: async (count: number) => {
      const deadline = Date.now() + SAFETY_MS;
      while (locks.filter(l => l.finished !== null).length < count) {
        if (Date.now() > deadline) throw new Error(`only ${locks.filter(l => l.finished !== null).length} of ${count} payment locks were granted`);
        await sleep(5);
      }
    },
    /** Resolve once `count` payment locks have been REQUESTED. */
    requested: async (count: number) => {
      const deadline = Date.now() + SAFETY_MS;
      while (locks.length < count) {
        if (Date.now() > deadline) throw new Error(`only ${locks.length} of ${count} payment locks were requested`);
        await sleep(5);
      }
    },
  };
};

const settled = (promise: Promise<unknown>) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
};

/* ==========================================================================
 * Schema: applied for real, dropped again
 * ======================================================================== */

let ready = false;
let reason = '';

before(async () => {
  if (!enabled) return;
  const client = await ORIGINAL_CONNECT();
  try {
    const present = await client.query(
      `SELECT to_regclass('public.payments') AS payments,
              to_regclass('public.settlement_cutover') AS cutover,
              to_regclass('public.medication_return_reversals') AS reversals`,
    );
    if (!present.rows[0].payments || !present.rows[0].cutover || !present.rows[0].reversals) {
      reason = 'requires a migrated development database (payments, settlement_cutover, medication_return_reversals)';
      return;
    }
    await client.query(fs.readFileSync(path.join(MIGRATIONS, '049_refunds.sql'), 'utf8'));
    ready = true;
  } finally {
    client.release();
  }
});

after(async () => {
  if (!ready) return;
  const client = await ORIGINAL_CONNECT();
  try {
    // Sweep any fixture a failing test could not drop itself, so a broken run
    // cannot poison the next one.
    await client.query('BEGIN');
    const clinics = await client.query(`SELECT clinic_id FROM clinics WHERE clinic_name LIKE 'concurrency harness %'`);
    const users = await client.query(`SELECT user_id FROM users WHERE username LIKE 'concurrency-harness-%'`);
    const patients = await client.query(`SELECT patient_id FROM patients WHERE full_name = 'Concurrency Harness Patient'`);
    const clinicIds = clinics.rows.map(r => r.clinic_id);
    const userIds = users.rows.map(r => r.user_id);
    const patientIds = patients.rows.map(r => r.patient_id);
    const invoices = await client.query(`SELECT invoice_id FROM invoices WHERE patient_id = ANY($1::int[])`, [patientIds]);
    const invoiceIds = invoices.rows.map(r => r.invoice_id);
    const payments = await client.query(`SELECT payment_id FROM payments WHERE clinic_id = ANY($1::int[]) OR invoice_id = ANY($2::int[])`, [clinicIds, invoiceIds]);
    const paymentIds = payments.rows.map(r => r.payment_id);
    await client.query(`DELETE FROM refunds WHERE payment_id = ANY($1::int[])`, [paymentIds]);
    await client.query(`DELETE FROM audit_logs WHERE user_id = ANY($1::int[])`, [userIds]);
    await client.query(`DELETE FROM payments WHERE payment_id = ANY($1::int[])`, [paymentIds]);
    await client.query(`DELETE FROM medication_return_credits WHERE clinic_id = ANY($1::int[])`, [clinicIds]);
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1::int[])`, [invoiceIds]);
    await client.query(`DELETE FROM invoices WHERE invoice_id = ANY($1::int[])`, [invoiceIds]);
    await client.query(`DELETE FROM patients WHERE patient_id = ANY($1::int[])`, [patientIds]);
    await client.query(`DELETE FROM users WHERE user_id = ANY($1::int[])`, [userIds]);
    await client.query(`DELETE FROM clinics WHERE clinic_id = ANY($1::int[])`, [clinicIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('DROP TABLE IF EXISTS refunds').catch(() => undefined);
    client.release();
  }
});

const commit = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const client = await ORIGINAL_CONNECT();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

/* ==========================================================================
 * 1. TWO REFUNDS, ONE PAYMENT — must serialize
 * ======================================================================== */

test('concurrency: استردادان متزامنان على دفعة واحدة — الثاني ينتظر القفل ثم يُرفض بالسقف الحي', { skip: !enabled }, async (t) => {
  if (!ready) return t.skip(reason);
  let fixture: Seed | null = null;
  const probe = instrument();
  try {
    fixture = await commit(c => seed(c, [100], 1));
    const f = fixture!;
    const user = { ...USER, userId: f.userId, clinicId: f.clinicId, clinicIds: [f.clinicId] };
    const request = (amount: number, key: string) => ({
      payment_id: f.paymentIds[0],
      amount,
      currency_code: 'JOD',
      reason: 'RETURN_CREDIT',
      credit_id: f.creditIds[0],
      idempotency_key: key,
    });

    const gate = probe.hold('A');
    const a = call(request(70, 'A'), user);
    await bounded('لم يصل A إلى بوابة الاستحقاق', gate.arrived);   // A: locked, aggregate read, not written

    const b = call(request(40, 'B'), user);
    await probe.requested(2);                // B is inside its FOR UPDATE …
    const isBsettled = settled(b);
    await sleep(50);
    assert.equal(isBsettled(), false, 'لا يجوز for B أن يمرّ بينما A ما زال ممسكاً القفل');
    await probe.granted(1);                  // only A's lock has been granted

    gate.open();
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(ra.status, 201);
    assert.equal(rb.status, 409);
    assert.equal(rb.code, 'REFUND_EXCEEDS_PAYMENT', 'السقف الحي بعد قفل A، لا 0 كما لو تُركا معاً');
    assert.equal(Number(rb.already_refunded), 70, 'وB رأى ما.commitه A، لا صفراً');    assert.equal(Number(rb.refundable_remaining), 30);
    assert.equal(Number(ra.payment.refundable_remaining), 30, 'A نفسه رأى أنه لم يُسترد منه شيء بعد');

    // The causal claim: B was granted the row only after A's COMMIT began. Without
    // the lock B would have been granted it while A was held.
    const bLock = probe.locks[1]!;
    assert.ok(bLock.finished !== null, 'وانتهى قفل B بعد COMMIT');
    assert.ok(bLock.finished! > probe.commits[0]!.started, 'قفل B مُنح بعد بدء COMMIT لـ A');
  } finally {
    probe.restore();
    if (fixture) await drop(fixture);
  }
});

/* ==========================================================================
 * 2. TWO REFUNDS, TWO PAYMENTS, ONE INVOICE — must NOT serialize
 * ======================================================================== */

test('concurrency: استردادان على دفعتين لنفس الفاتورة — لا قفل على الفاتورة', { skip: !enabled }, async (t) => {
  if (!ready) return t.skip(reason);
  let fixture: Seed | null = null;
  const probe = instrument();
  try {
    fixture = await commit(c => seed(c, [100, 40], 2));
    const f = fixture!;
    const user = { ...USER, userId: f.userId, clinicId: f.clinicId, clinicIds: [f.clinicId] };
    const request = (payment: number, credit: number, amount: number, key: string) => ({
      payment_id: f.paymentIds[payment],
      amount,
      currency_code: 'JOD',
      reason: 'RETURN_CREDIT',
      credit_id: f.creditIds[credit],
      idempotency_key: key,
    });

    const gate = probe.hold('A');
    const a = call(request(0, 0, 20, 'A'), user);
    await bounded('لم يصل A إلى بوابة الاستحقاق', gate.arrived);
    const isAsettled = settled(a);

    // B is on the SAME invoice but a different payment and a different credit.
    // If the write path locked the invoice — or the credit — B could not finish
    // while A is still held, and this await would only return after the safety
    // valve, which the assertion below catches.
    const rb = await call(request(1, 1, 15, 'B'), user);
    assert.equal(rb.status, 201, 'دفعة أخرى على نفس الفاتورة لا تنتظر');
    assert.equal(isAsettled(), false, 'وA ما زال محتجزاً: إذاً الفاتورة ليست محل قفل');

    gate.open();
    const ra = await a;
    assert.equal(ra.status, 201);

    const client = await ORIGINAL_CONNECT();
    try {
      const state = await client.query(
        `SELECT (SELECT COUNT(*)::int FROM refunds WHERE invoice_id = $1) AS refunds,
                (SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE invoice_id = $1) AS refunded,
                (SELECT paid_amount FROM invoices WHERE invoice_id = $1) AS paid,
                (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = $1 AND voided_at IS NULL) AS paid_ledger`,
        [f.invoiceId],
      );
      assert.equal(state.rows[0].refunds, 2);
      assert.equal(Number(state.rows[0].refunded), 35);
      assert.equal(Number(state.rows[0].paid), 140, 'الفاتورة لم تتغير');
      assert.equal(Number(state.rows[0].paid_ledger), Number(state.rows[0].paid), 'هوية 10G.2 قائمة');
    } finally {
      client.release();
    }
  } finally {
    probe.restore();
    if (fixture) await drop(fixture);
  }
});