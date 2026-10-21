import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10G.4a — Refund storage
 *
 * 10G.3 activated the settlement boundary and gave money IN a ledger. Money OUT
 * has none, and `payments` structurally cannot become it: CHECK (amount > 0)
 * leaves cash-out inexpressible by design. This phase ships the storage half of
 * that missing half and stops there — no endpoint, no writer, no validation, no
 * behaviour. Every assertion below is about the shape of the record and the
 * strength of its constraints, never about a refund being issued.
 *
 * Two tiers, deliberately:
 *
 *   1. SOURCE (always runs). Proves the DDL, the constraints, the indexes, the
 *      permission, the seed alignment — and, just as load-bearing, that no
 *      application code reads or writes this table yet.
 *
 *   2. APPLIED (opt-in, SETTLEMENT_SCHEMA_TEST=1). Constraint behaviour can only
 *      be observed against a real catalog. 047 + 049 are applied inside a
 *      transaction that is ALWAYS rolled back, so the schema is verified to
 *      exist and then vanishes: an enabled run never modifies the database and is
 *      safe to repeat or interrupt.
 * ========================================================================== */

const enabled = process.env.SETTLEMENT_SCHEMA_TEST === '1';
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const MIGRATION_FILE = '049_refunds.sql';
const migrationPath = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
const migrationSql = () => fs.readFileSync(migrationPath, 'utf8');

/**
 * Executable SQL only, comments stripped. This migration argues at length about
 * why it never touches paid_amount and why a second reason value does not exist,
 * so an absence assertion has to read the statements rather than the prose —
 * otherwise a well-documented comment would read as a violation.
 */
const migrationCode = () =>
  migrationSql()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

const sourceOf = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

const rows = async (c: PoolClient, text: string, params: unknown[] = []): Promise<any[]> =>
  (await c.query(text, params)).rows;

/**
 * Applies 047 (payments must exist for the foreign key) and 049 inside one
 * transaction, builds the refund fixture, runs fn, and always rolls back.
 *
 * The credit fixture borrows the reversal half of the 044 chain that is already
 * in the catalog and builds its own invoice and medication invoice line. What is
 * under test is the refunds table's own constraints, not 044's internal
 * consistency, so reusing the expensive half of that chain keeps this a storage
 * test rather than a second E2E harness.
 */
const withRefundSchema = async (fn: (c: PoolClient, f: Fixture) => Promise<void>): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, '047_payments.sql'), 'utf8'));
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    const f = await seedFixture(client);
    await fn(client, f);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

interface Fixture {
  clinicId: number;
  userId: number;
  invoiceId: number;
  paymentId: number;
  secondPaymentId: number;
  creditId: number;
}

const REFUND_COLUMNS =
  'payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code, credit_id, reason, refunded_by_user_id';

/** Builds a clinic, user, patient, paid invoice, medication line, a credit and two payments. */
const seedFixture = async (c: PoolClient): Promise<Fixture> => {
  const tag = `rf${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const clinicId = Number(
    (await rows(c, `INSERT INTO clinics (clinic_name) VALUES ($1) RETURNING clinic_id`, [`refund ${tag}`]))[0].clinic_id,
  );
  const userId = Number(
    (await rows(
      c,
      `INSERT INTO users (full_name, username, password_hash) VALUES ('Refund Fixture', $1, 'x') RETURNING user_id`,
      [tag],
    ))[0].user_id,
  );
  const patientId = Number(
    (await rows(
      c,
      `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
       VALUES ('Refund Patient', $1, 'MALE', '1991-01-01', $2) RETURNING patient_id`,
      [tag.slice(-7).padStart(7, '9'), clinicId],
    ))[0].patient_id,
  );

  // The reversal half of the 044 chain that is already in the catalog.
  const anchor = (await rows(
    c,
    `SELECT mrr.reversal_id, mrr.dispensing_id, mrr.dispensing_item_id, mri.return_item_id
       FROM medication_return_reversals mrr
       JOIN medication_return_items mri ON mri.return_item_id = mrr.return_item_id
      ORDER BY mrr.reversal_id LIMIT 1`,
  ))[0];

  const invoiceId = Number(
    (await rows(
      c,
      `INSERT INTO invoices (patient_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
       VALUES ($1, $2, 100, 0, 100, 100, 'CASH', 'JOD') RETURNING invoice_id`,
      [patientId, userId],
    ))[0].invoice_id,
  );

  // A medication line, so the credit's invoice_item_id is a real charged line.
  const invoiceItemId = Number(
    (await rows(
      c,
      `INSERT INTO invoice_items (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
                                  dispensed_quantity, unit_price_snapshot, line_total, price, quantity, medication_discount_value)
       SELECT $1, $2, di.dispensing_id, di.dispensing_item_id, di.medication_id,
              dib.quantity, 5.00, ROUND(dib.quantity * 5.00, 2), ROUND(dib.quantity * 5.00, 2), 1, 0
         FROM dispensing_items di
         JOIN dispensing_item_batches dib ON dib.dispensing_item_id = di.dispensing_item_id
        WHERE di.dispensing_item_id = $3
        LIMIT 1
       RETURNING item_id`,
      [invoiceId, clinicId, anchor.dispensing_item_id],
    ))[0].item_id,
  );

  const creditId = Number(
    (await rows(
      c,
      `INSERT INTO medication_return_credits
         (return_item_id, reversal_id, dispensing_id, dispensing_item_id, invoice_id, invoice_item_id,
          clinic_id, returned_quantity, unit_price_snapshot, medication_discount_value,
          gross_amount, net_amount, credit_amount, applied_to_outstanding, refund_due_amount,
          invoice_net_amount, invoice_paid_amount, currency_code)
       SELECT mri.return_item_id, mrr.reversal_id, $2, mrr.dispensing_item_id, $3, $4, $5,
              mri.quantity, 5.00, 0, 5.00, 5.00, 5.00, 0.00, 5.00, 100.00, 100.00, 'JOD'
         FROM medication_return_items mri
         JOIN medication_return_reversals mrr ON mrr.return_item_id = mri.return_item_id
        WHERE mrr.reversal_id = $1
       RETURNING credit_id`,
      [anchor.reversal_id, anchor.dispensing_id, invoiceId, invoiceItemId, clinicId],
    ))[0].credit_id,
  );

  const paymentId = Number(
    (await rows(
      c,
      `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id)
       VALUES ($1, $2, 100, 'PATIENT', 'CASH', 'JOD', $3) RETURNING payment_id`,
      [invoiceId, clinicId, userId],
    ))[0].payment_id,
  );

  const secondPaymentId = Number(
    (await rows(
      c,
      `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id)
       VALUES ($1, $2, 50, 'PATIENT', 'CARD', 'JOD', $3) RETURNING payment_id`,
      [invoiceId, clinicId, userId],
    ))[0].payment_id,
  );

  return { clinicId, userId, invoiceId, paymentId, secondPaymentId, creditId };
};

/** A failed statement aborts the transaction, so every rejection gets its own savepoint. */
const expectReject = async (
  c: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<{ code: string; message: string }> => {
  await c.query('SAVEPOINT probe');
  let caught: { code: string; message: string } | null = null;
  try {
    await c.query(sql, params);
  } catch (e: any) {
    caught = { code: String(e?.code ?? ''), message: String(e?.message ?? '') };
  }
  await c.query('ROLLBACK TO SAVEPOINT probe');
  await c.query('RELEASE SAVEPOINT probe');
  return caught ?? { code: 'NONE', message: 'the statement was accepted' };
};

/** A refund insert with the part under test replaced. */
const refundInsert = (values: string) => `INSERT INTO refunds (${REFUND_COLUMNS}) VALUES (${values})`;

/* ==========================================================================
 * 1. SOURCE — the migration file (ungated)
 * ======================================================================== */

test('SOURCE: 049 is present and 043/044/047/048 are present and untouched', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  for (const earlier of [
    '043_medication_return_reversals.sql',
    '044_medication_return_credits.sql',
    '047_payments.sql',
    '048_settlement_cutover_activation.sql',
  ]) {
    assert.ok(files.includes(earlier), `${earlier} is still present`);
  }
  // 049 موجود. أما كونه "أعلى رقم" فلا يبقى صحيحاً بعد إضافة سلاسل لاحقة
  // (054–059: جدولة الأطباء وتقويم العطل)، فالفحص ينحصر في سلسلة المدفوعات:
  // لا ملف ثانٍ بنفس الرقم، ولا تعديل على الملفات المُطبَّقة سابقاً.
  assert.ok(files.includes('049_refunds.sql'), '049_refunds.sql is still present');
  assert.ok(
    !files.some((file) => file.startsWith('049_') && file !== '049_refunds.sql'),
    'no second migration file shares the 049 number'
  );
});

test('SOURCE: the migration is additive — it alters and drops nothing', () => {
  const sql = migrationCode();
  assert.deepEqual(sql.match(/ALTER\s+TABLE/gi) ?? [], [], 'not a single ALTER TABLE');
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|TYPE)/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i, 'and deletes no row — ON DELETE RESTRICT clauses are not deletes');
  assert.doesNotMatch(sql, /ADD\s+COLUMN/i, 'no existing table gains a column');
});

test('SOURCE: the migration never moves money that already exists', () => {
  const sql = migrationCode();
  // The whole design rests on this: a refund does not reduce invoices.paid_amount,
  // because that column is the derived mirror of SUM(live payments). Reduce it and
  // "amount paid" becomes a net-cash figure that reports a fully paid, then
  // refunded, patient as UNPAID.
  assert.doesNotMatch(sql, /paid_amount/i, 'paid_amount is not mentioned at all');
  assert.doesNotMatch(sql, /UPDATE\s+(invoices|payments|invoice_items|medication_return_credits)\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+(invoices|payments|invoice_items)\b/i);
  assert.doesNotMatch(sql, /ALTER\s+TYPE\s+payment_method/i, 'the shared enum is not modified');
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+refunds/i, 'the migration creates no money movement of its own');
});

test('SOURCE: refunds carries every required column with its type and nullability', () => {
  const sql = migrationSql();
  const required = [
    'refund_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    'payment_id INT NOT NULL',
    'invoice_id INT NOT NULL',
    'clinic_id INT NOT NULL',
    'amount NUMERIC(10, 2) NOT NULL',
    'payer_type VARCHAR(20) NOT NULL',
    'method payment_method NOT NULL',
    'currency_code VARCHAR(3) NOT NULL',
    'credit_id INT NULL',
    'reason VARCHAR(30) NOT NULL',
    'reason_note TEXT NULL',
    'refunded_by_user_id INT NOT NULL',
    'refunded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'voided_at TIMESTAMPTZ NULL',
    'voided_by_user_id INT NULL',
    'void_reason TEXT NULL',
    'idempotency_key VARCHAR(64) NULL',
    'created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP',
  ];
  for (const fragment of required) {
    assert.ok(sql.includes(fragment), `column declaration: ${fragment}`);
  }
  // payment_id is the anchor that makes over-refund arithmetic and multi-invoice
  // refund structurally impossible, so it must never become optional.
  assert.doesNotMatch(sql, /payment_id\s+INT\s+NULL/);
});

test('SOURCE: no foreign key can cascade a delete, and only the currency code cascades an update', () => {
  const sql = migrationCode();
  // 047 states the money-moving foreign keys explicitly and leaves the two user
  // references to the default; this file mirrors that exactly.
  const explicitRestrict = [...sql.matchAll(/REFERENCES\s+(\w+)\s*\([^)]+\)\s*ON DELETE RESTRICT/gi)].map((m) => m[1]);
  assert.deepEqual(explicitRestrict.sort(), ['clinics', 'invoices', 'medication_return_credits', 'payments']);
  assert.doesNotMatch(sql, /ON DELETE\s+(CASCADE|SET NULL|SET DEFAULT)/i, 'nothing is ever cascade-deleted');

  const updates = [...sql.matchAll(/REFERENCES\s+(\w+)\s*\([^)]+\)\s*ON UPDATE CASCADE/gi)].map((m) => m[1]);
  assert.deepEqual(updates, ['currency_master'], 'renaming a currency code is the only cascade allowed');

  const targets = [...sql.matchAll(/REFERENCES\s+(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(targets.sort(), [
    'clinics', 'currency_master', 'invoices', 'medication_return_credits', 'payments', 'users', 'users',
  ], 'exactly the seven declared references, and no others');
});

test('SOURCE: the six checks are declared with the definitions the design promises', () => {
  const sql = migrationCode();
  const defs = new Map(
    [...sql.matchAll(/CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*?)\)\s*(?:,|\n\s*\))/g)].map((m) => [m[1]!, m[2]!]),
  );
  assert.deepEqual([...defs.keys()].sort(), [
    'chk_refunds_amount_positive',
    'chk_refunds_method_cash_card',
    'chk_refunds_payer_type',
    'chk_refunds_reason',
    'chk_refunds_return_credit_needs_credit',
    'chk_refunds_void_consistent',
  ].sort(), 'no more constraints than the design, and no fewer');

  assert.match(defs.get('chk_refunds_amount_positive')!, /amount > 0/);
  assert.match(defs.get('chk_refunds_payer_type')!, /payer_type IN \('PATIENT', 'INSURER'\)/);
  assert.match(defs.get('chk_refunds_method_cash_card')!, /method IN \('CASH', 'CARD'\)/);
  assert.match(defs.get('chk_refunds_reason')!, /reason IN \('RETURN_CREDIT'\)/);
  assert.match(defs.get('chk_refunds_return_credit_needs_credit')!, /reason <> 'RETURN_CREDIT' OR credit_id IS NOT NULL/);
  assert.match(defs.get('chk_refunds_void_consistent')!, /\(voided_at IS NULL\) = \(voided_by_user_id IS NULL\)/);
});

test('SOURCE: the reason enum admits one value, because only one authorisation source exists', () => {
  // A second value would need a source this system does not have: a
  // service-level cancellation has no credit note table, and goodwill has no
  // authorisation at all.
  const sql = migrationCode();
  const reasonValues = sql.match(/chk_refunds_reason\s+CHECK\s*\(reason IN \(([^)]*)\)\)/)![1]!;
  assert.deepEqual(reasonValues.split(',').map((v) => v.trim().replace(/'/g, '')), ['RETURN_CREDIT']);
  // The rejected values may only ever appear in the prose that explains them.
  for (const rejected of ['SERVICE_CANCELLATION', 'GOODWILL']) {
    assert.doesNotMatch(sql, new RegExp(`IN \\([^)]*'${rejected}'`), `${rejected} is not an admitted value`);
  }
});

test('SOURCE: credit_id is enforced by a CHECK, never by NOT NULL', () => {
  const sql = migrationSql();
  // This is what keeps the file from ever needing an ALTER: admitting a second
  // reason later must not require dropping a NOT NULL and re-deriving rows.
  assert.ok(sql.includes('credit_id INT NULL'), 'the column stays nullable');
  assert.doesNotMatch(sql, /credit_id\s+INT\s+NOT NULL/);
  assert.doesNotMatch(sql, /credit_id\s+INT\s+NULL\s+UNIQUE/i, 'one credit may be discharged more than once');
  assert.doesNotMatch(sql, /UNIQUE[^\n]*\(payment_id, credit_id\)/i, 'and no uniqueness hides behind a composite');
});

test('SOURCE: the three live aggregates, the clinic activity index and the partial unique key exist', () => {
  const sql = migrationCode();
  for (const [name, definition] of [
    ['idx_refunds_payment_live', /ON refunds \(payment_id\) WHERE voided_at IS NULL/],
    ['idx_refunds_invoice_live', /ON refunds \(invoice_id\) WHERE voided_at IS NULL/],
    ['idx_refunds_credit_live', /ON refunds \(credit_id\) WHERE credit_id IS NOT NULL AND voided_at IS NULL/],
    ['idx_refunds_clinic_created', /ON refunds \(clinic_id, refunded_at DESC, refund_id DESC\)/],
    ['uq_refunds_payment_idempotency', /ON refunds \(payment_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/],
  ] as const) {
    assert.match(sql, new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${name}\\s+${definition.source}`), name);
  }
  // The idempotency key is scoped to the payment, not global.
  assert.doesNotMatch(sql, /UNIQUE[^\n]*\(idempotency_key\)/);
});

test('SOURCE: exactly one permission is introduced, and it is RECORD_REFUND in Finance', () => {
  const keys = [...migrationSql().matchAll(/INSERT INTO permissions[\s\S]*?VALUES \('([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['RECORD_REFUND'], 'exactly one permission is introduced');
  assert.match(migrationSql(), /VALUES \('RECORD_REFUND', 'Finance'/);
});

test('SOURCE: the grant reaches ACCOUNTANT and the two admin roles, and never the auditor', () => {
  const grant = migrationSql().match(/WHERE r\.role_name IN \(([^)]*)\)/)![1]!;
  assert.deepEqual(
    grant.split(',').map((v) => v.trim().replace(/'/g, '')).sort(),
    ['ACCOUNTANT', 'SUPER_ADMIN', 'SYSTEM_ADMIN'],
  );
  for (const excluded of ['FINANCIAL_AUDITOR', 'RECEPTIONIST', 'DOCTOR', 'NURSE', 'PHARMACIST']) {
    assert.ok(!grant.includes(`'${excluded}'`), `${excluded} is never granted a permission that moves money`);
  }
  assert.doesNotMatch(migrationSql(), /UPDATE\s+role_permissions|DELETE\s+FROM\s+role_permissions/);
});

/* ==========================================================================
 * 2. SOURCE — nothing uses this table yet
 * ======================================================================== */

test('WRITER: exactly one module touches refunds, and it only ever inserts', () => {
  // Walk the compiled output: anything that mentions the refunds TABLE would
  // appear here. One writer is the design — the refund path — and it must never
  // UPDATE or DELETE, because a refund is voided, never edited or removed.
  const distModules = path.join(__dirname, '..', 'modules');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /\b(?:FROM|INTO|UPDATE|JOIN)\s+refunds\b/i.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(distModules, full).split(path.sep).join('/'));
      }
    }
  };
  walk(distModules);
  assert.deepEqual(offenders, ['billing/refunds.controller.js'], 'one writer, and it is the refund path');

  const controller = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'refunds.controller.ts'), 'utf8');
  assert.match(controller, /INSERT INTO refunds/i);
  assert.doesNotMatch(controller, /UPDATE\s+refunds/i, 'a refund is voided, never edited');
  assert.doesNotMatch(controller, /DELETE\s+FROM\s+refunds/i, 'and never removed');
});

test('WRITER: the refund path moves no other money', () => {
  const controller = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'refunds.controller.ts'), 'utf8');
  // The tables this phase refuses to touch. A refund is a new fact, not an edit
  // of an existing one: paid_amount stays the mirror of live payments, and the
  // 044 credit keeps recording the entitlement it was born with.
  for (const forbidden of [
    /UPDATE\s+invoices/i,
    /INSERT\s+INTO\s+payments/i,
    /UPDATE\s+payments/i,
    /INSERT\s+INTO\s+invoice_items/i,
    /UPDATE\s+invoice_items/i,
    /UPDATE\s+medication_return_credits/i,
    /UPDATE\s+medication_return_reversals/i,
  ]) {
    assert.doesNotMatch(controller, forbidden);
  }
  // And it never re-derives paid_amount from refunds either — the whole reason
  // this table is separate rather than a signed payments row.
  assert.doesNotMatch(controller, /SET\s+paid_amount/i);
});

test('ROUTE: the refund route is gated by RECORD_REFUND, and every other gate is unchanged', () => {
  const routes = sourceOf('src', 'modules', 'billing', 'billing.routes.ts');
  const refundRoute = routes.split('\n').find((l) => l.includes("router.post('/refunds'"));
  assert.ok(refundRoute, 'مسار الاسترداد موجود');
  assert.match(refundRoute!, /requirePermission\('RECORD_REFUND'\)/);
  assert.match(refundRoute!, /validateBody\(refundSchema\)/);
  assert.doesNotMatch(refundRoute!, /RECORD_PAYMENT|CREATE_INVOICE/, 'ولا يرث صلاحية التحصيل أو الإصدار');
  for (const gate of [
    "router.post('/invoices', requirePermission('CREATE_INVOICE')",
    "router.post('/payments', requirePermission('RECORD_PAYMENT')",
    "router.post('/expenses', requirePermission('CREATE_EXPENSE')",
    "router.post('/medication-charges', requirePermission('CREATE_INVOICE')",
  ]) {
    assert.ok(routes.includes(gate), `unchanged gate: ${gate}`);
  }
});

test('SOURCE: reports, KPIs and the UI are untouched by refunds', () => {
  const reports = sourceOf('src', 'modules', 'reports', 'reports.controller.ts');
  assert.doesNotMatch(reports, /refund/i, 'no report reads refunds yet');
  assert.doesNotMatch(reports, /\bpayments\b/i, 'and reports still do not read the payment ledger either');
  assert.doesNotMatch(sourceOf('src', 'modules', 'billing', 'billing.controller.ts'), /refund/i, 'the KPIs are unchanged');
  assert.doesNotMatch(sourceOf('frontend', 'src', 'views', 'OverviewView.jsx'), /refund/i, 'and no UI surface exists');
});

test('SEED: RECORD_REFUND is granted the way RECORD_PAYMENT is', () => {
  const seed = sourceOf('src', 'scripts', 'seed.ts');
  assert.match(seed, /key: 'RECORD_REFUND', group: 'Finance'/);
  const matrix = seed.slice(seed.indexOf('const ROLE_PERMISSIONS'));
  const accountant = /ACCOUNTANT: \[([^\]]*)\]/.exec(matrix);
  assert.ok(accountant, 'ACCOUNTANT row exists');
  assert.ok(accountant![1]!.includes("'RECORD_REFUND'"), 'the settling role holds it');
  const auditor = /FINANCIAL_AUDITOR: \[([^\]]*)\]/.exec(matrix);
  assert.ok(auditor, 'FINANCIAL_AUDITOR row exists');
  assert.ok(!auditor![1]!.includes('RECORD_REFUND'), 'the read-only auditor must never hold it');
});

/* ==========================================================================
 * 3. APPLIED — the real catalog (opt-in, always rolled back)
 * ======================================================================== */

test('APPLIED: refunds exists with exactly the declared columns and nullability', { skip: !enabled }, async () => {
  await withRefundSchema(async (c) => {
    const cols = await rows(
      c,
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'refunds'
        ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      cols.map((r) => r.column_name),
      [
        'refund_id', 'payment_id', 'invoice_id', 'clinic_id', 'amount', 'payer_type', 'method',
        'currency_code', 'credit_id', 'reason', 'reason_note', 'refunded_by_user_id', 'refunded_at',
        'voided_at', 'voided_by_user_id', 'void_reason', 'idempotency_key', 'created_at',
      ],
      'column set and order are exactly as approved',
    );
    const byName = new Map(cols.map((r) => [r.column_name, r]));
    assert.equal(byName.get('amount')!.data_type, 'numeric');
    for (const notNull of [
      'payment_id', 'invoice_id', 'clinic_id', 'amount', 'payer_type', 'method', 'currency_code',
      'reason', 'refunded_by_user_id', 'refunded_at', 'created_at',
    ]) {
      assert.equal(byName.get(notNull)!.is_nullable, 'NO', notNull);
    }
    for (const nullable of ['credit_id', 'reason_note', 'voided_at', 'voided_by_user_id', 'void_reason', 'idempotency_key']) {
      assert.equal(byName.get(nullable)!.is_nullable, 'YES', nullable);
    }
    // When the money left is a server clock, never a client value.
    for (const clock of ['refunded_at', 'created_at']) {
      assert.match(String(byName.get(clock)!.column_default), /CURRENT_TIMESTAMP|now\(\)/i, clock);
    }
  });
});

test('APPLIED: the six checks exist with their definitions', { skip: !enabled }, async () => {
  await withRefundSchema(async (c) => {
    const defs = new Map(
      (await rows(
        c,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'refunds'::regclass AND contype = 'c'`,
      )).map((r) => [r.conname, r.def]),
    );
    assert.deepEqual([...defs.keys()].sort(), [
      'chk_refunds_amount_positive',
      'chk_refunds_method_cash_card',
      'chk_refunds_payer_type',
      'chk_refunds_reason',
      'chk_refunds_return_credit_needs_credit',
      'chk_refunds_void_consistent',
    ].sort());
    assert.match(defs.get('chk_refunds_amount_positive')!, /amount > \(?0\)?(::numeric)?/);
    // Postgres renders a one-element IN list as an equality and casts to text,
    // so the reason check legitimately reads `= 'RETURN_CREDIT'::text`.
    assert.match(defs.get('chk_refunds_payer_type')!, /'PATIENT'::(character varying|text)/);
    assert.match(defs.get('chk_refunds_method_cash_card')!, /'CASH'::(payment_method|text)/);
    assert.match(defs.get('chk_refunds_reason')!, /'RETURN_CREDIT'::(character varying|text)/);
    assert.match(defs.get('chk_refunds_return_credit_needs_credit')!, /credit_id IS NOT NULL/);
    assert.match(defs.get('chk_refunds_void_consistent')!, /voided_at IS NULL.*voided_by_user_id IS NULL/s);
  });
});

test('APPLIED: every reference points where the design says and none can cascade a delete', { skip: !enabled }, async () => {
  await withRefundSchema(async (c) => {
    const fks = await rows(
      c,
      `SELECT a.attname AS column_name,
              (SELECT relname FROM pg_class WHERE oid = c.confrelid) AS target_table,
              c.confdeltype AS delete_rule, c.confupdtype AS update_rule
         FROM pg_constraint c
         JOIN unnest(c.conkey) AS k(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'refunds'::regclass AND c.contype = 'f'
        ORDER BY a.attname`,
    );
    assert.deepEqual(
      fks.map((r) => `${r.column_name}->${r.target_table}`),
      [
        'clinic_id->clinics',
        'credit_id->medication_return_credits',
        'currency_code->currency_master',
        'invoice_id->invoices',
        'payment_id->payments',
        'refunded_by_user_id->users',
        'voided_by_user_id->users',
      ],
      'seven references, exactly as designed',
    );
    // 'c' is CASCADE. Nothing may cascade a delete: deleting an invoice must
    // never delete the record that money moved against it.
    assert.deepEqual(
      fks.filter((r) => r.delete_rule === 'c').map((r) => r.column_name),
      [],
      'no reference cascades a delete',
    );
    assert.deepEqual(
      fks.filter((r) => r.update_rule === 'c').map((r) => `${r.column_name}->${r.target_table}`),
      ['currency_code->currency_master'],
      'the currency code is the only cascade, and only on update',
    );
  });
});

test('APPLIED: the live aggregates and the partial unique key exist as declared', { skip: !enabled }, async () => {
  await withRefundSchema(async (c) => {
    const idx = new Map(
      (await rows(c, `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'refunds' AND indexname <> 'refunds_pkey'`))
        .map((r) => [r.indexname, r.indexdef]),
    );
    assert.deepEqual([...idx.keys()].sort(), [
      'idx_refunds_clinic_created',
      'idx_refunds_credit_live',
      'idx_refunds_invoice_live',
      'idx_refunds_payment_live',
      'uq_refunds_payment_idempotency',
    ]);
    for (const partial of ['idx_refunds_payment_live', 'idx_refunds_invoice_live', 'idx_refunds_credit_live']) {
      assert.match(idx.get(partial)!, /WHERE/, `${partial} serves an aggregate, so it covers live rows only`);
    }
    assert.match(idx.get('uq_refunds_payment_idempotency')!, /UNIQUE/);
    assert.match(idx.get('uq_refunds_payment_idempotency')!, /WHERE \(idempotency_key IS NOT NULL\)/);
  });
});

/* ==========================================================================
 * 4. BEHAVIOUR — the ordinary case, then every way it must be refused
 * ======================================================================== */

test('BEHAVIOUR: the ordinary case inserts, and the server supplies the clock', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    const inserted = await rows(
      c,
      `${refundInsert('$1, $2, $3, 20.00, \'PATIENT\', \'CASH\', \'JOD\', $4, \'RETURN_CREDIT\', $5')}
        RETURNING refund_id, refunded_at, voided_at, idempotency_key`,
      [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId],
    );
    assert.equal(inserted.length, 1);
    assert.ok(inserted[0].refunded_at instanceof Date, 'refunded_at is a timestamp the server chose');
    assert.equal(inserted[0].voided_at, null, 'a new refund is live');
    assert.equal(inserted[0].idempotency_key, null, 'the key is optional');
  });
});

test('BEHAVIOUR: the amount is strictly positive — cash out is never a signed column', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    for (const amount of ['0.00', '-5.00']) {
      const bad = await expectReject(
        c,
        refundInsert(`$1, $2, $3, ${amount}, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`),
        [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId],
      );
      assert.equal(bad.code, '23514', `amount ${amount} violates the check`);
      assert.match(bad.message, /chk_refunds_amount_positive/);
    }
  });
});

test('BEHAVIOUR: a RETURN_CREDIT refund cannot exist without the credit it discharges', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    // This is the constraint that gives 044's refund_due_amount a consumer: an
    // entitlement cannot be handed over without being named.
    const bad = await expectReject(
      c,
      refundInsert(`$1, $2, $3, 20.00, 'PATIENT', 'CASH', 'JOD', NULL, 'RETURN_CREDIT', $4`),
      [f.paymentId, f.invoiceId, f.clinicId, f.userId],
    );
    assert.equal(bad.code, '23514');
    assert.match(bad.message, /chk_refunds_return_credit_needs_credit/);
  });
});

test('BEHAVIOUR: only RETURN_CREDIT is a reason, and only PATIENT/INSURER and CASH/CARD are admitted', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    const base = [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId];
    const refused: Array<[string, string, string]> = [
      ['GOODWILL', 'PATIENT', 'CASH'],
      ['SERVICE_CANCELLATION', 'PATIENT', 'CASH'],
      ['RETURN_CREDIT', 'THIRD_PARTY', 'CASH'],
      ['RETURN_CREDIT', 'INSURANCE', 'CASH'],
      ['RETURN_CREDIT', 'PATIENT', 'INSURANCE'],
      ['RETURN_CREDIT', 'PATIENT', 'SPLIT'],
    ];
    for (const [reason, payer, method] of refused) {
      const bad = await expectReject(
        c,
        refundInsert(`$1, $2, $3, 10.00, '${payer}', '${method}', 'JOD', $4, '${reason}', $5`),
        base,
      );
      // INSURANCE and SPLIT exist in the shared payment_method enum and in the
      // invoice vocabulary, so a check refuses them rather than the type: that
      // is the barrier against reading a payer contract as a way to hand over cash.
      assert.equal(bad.code, '23514', `${reason} / ${payer} / ${method} must be refused`);
    }
    const ok = await rows(c, `${refundInsert(`$1, $2, $3, 10.00, 'INSURER', 'CARD', 'JOD', $4, 'RETURN_CREDIT', $5`)} RETURNING refund_id`, base);
    assert.equal(ok.length, 1, 'INSURER by CARD is legitimate — the payer and the method are separate facts');
  });
});

test('BEHAVIOUR: a refund cannot name a payment, invoice, clinic or credit that does not exist', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    // Each bogus value is a typed parameter rather than an inline literal, so
    // the failure that surfaces is the foreign key and not Postgres' guess at an
    // untyped literal.
    const cases: Array<[string, string, unknown[]]> = [
      ['payment_id', refundInsert(`$1::int, $2, $3, 10.00, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`), [999999999, f.invoiceId, f.clinicId, f.creditId, f.userId]],
      ['invoice_id', refundInsert(`$1, $2::int, $3, 10.00, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`), [f.paymentId, 999999999, f.clinicId, f.creditId, f.userId]],
      ['clinic_id', refundInsert(`$1, $2, $3::int, 10.00, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`), [f.paymentId, f.invoiceId, 999999999, f.creditId, f.userId]],
      ['credit_id', refundInsert(`$1, $2, $3, 10.00, 'PATIENT', 'CASH', 'JOD', $4::int, 'RETURN_CREDIT', $5`), [f.paymentId, f.invoiceId, f.clinicId, 999999999, f.userId]],
    ];
    for (const [column, sql, params] of cases) {
      const bad = await expectReject(c, sql, params);
      assert.equal(bad.code, '23503', `${column} is a reference`);
      assert.match(bad.message, /refunds_\w+_fkey/);
    }
  });
});

test('BEHAVIOUR: a currency outside currency_master is refused, never converted', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    // No rate source exists anywhere in this system, so a currency that does not
    // match the payment is a refusal for the writer to raise, not a conversion.
    const bad = await expectReject(
      c,
      refundInsert(`$1, $2, $3, 10.00, 'PATIENT', 'CASH', $4::varchar(3), $5, 'RETURN_CREDIT', $6`),
      [f.paymentId, f.invoiceId, f.clinicId, 'XXX', f.creditId, f.userId],
    );
    assert.equal(bad.code, '23503');
    assert.match(bad.message, /refunds_currency_code_fkey/);
  });
});

test('BEHAVIOUR: a void is one fact — either half on its own is refused', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    const insert = refundInsert(`$1, $2, $3, 10.00, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`);
    await rows(c, insert, [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId]);
    const refundId = (await rows(c, `SELECT refund_id FROM refunds ORDER BY refund_id LIMIT 1`))[0].refund_id;

    const atOnly = await expectReject(c, `UPDATE refunds SET voided_at = NOW() WHERE refund_id = $1`, [refundId]);
    assert.equal(atOnly.code, '23514');
    assert.match(atOnly.message, /chk_refunds_void_consistent/);

    const byOnly = await expectReject(c, `UPDATE refunds SET voided_by_user_id = $1 WHERE refund_id = $2`, [f.userId, refundId]);
    assert.equal(byOnly.code, '23514');
    assert.match(byOnly.message, /chk_refunds_void_consistent/);

    const whole = await rows(
      c,
      `UPDATE refunds SET voided_at = NOW(), voided_by_user_id = $1, void_reason = 'mis-keyed'
        WHERE refund_id = $2 RETURNING voided_at`,
      [f.userId, refundId],
    );
    assert.ok(whole[0].voided_at instanceof Date, 'a complete void is accepted — the row is kept, only excluded');
    const survivors = await rows(c, `SELECT COUNT(*)::int AS n FROM refunds`);
    assert.equal(survivors[0].n, 1, 'voiding never deletes: the history stays complete');
  });
});

test('BEHAVIOUR: the idempotency key is anchored per payment, and only bites when supplied', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    const keyed = (payment: number, key: string | null) =>
      `INSERT INTO refunds (${REFUND_COLUMNS}, idempotency_key)
       VALUES ($1, $2, $3, 10.00, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5, $6::varchar(64))
       RETURNING refund_id`;

    assert.equal((await rows(c, keyed(f.paymentId, 'K1'), [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId, 'K1'])).length, 1);

    const replay = await expectReject(c, keyed(f.paymentId, 'K1'), [f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId, 'K1']);
    assert.equal(replay.code, '23505', 'the same request twice is a constraint violation, never a second refund');
    assert.match(replay.message, /uq_refunds_payment_idempotency/);

    // The key is scoped to the payment, not global: the same value against a
    // different payment is a different request and must be accepted.
    assert.equal(
      (await rows(c, keyed(f.secondPaymentId, 'K1'), [f.secondPaymentId, f.invoiceId, f.clinicId, f.creditId, f.userId, 'K1'])).length,
      1,
      'the same key on another payment is a distinct request',
    );

    // Absent keys do not collide with each other.
    const unkeyed = [f.secondPaymentId, f.invoiceId, f.clinicId, f.creditId, f.userId, null];
    assert.equal((await rows(c, keyed(f.secondPaymentId, null), unkeyed)).length, 1);
    assert.equal(
      (await rows(c, keyed(f.secondPaymentId, null), unkeyed)).length,
      1,
      "two unkeyed refunds on one payment are legal — the over-refund cap is the writer's job, not this index's",
    );
  });
});

test('BEHAVIOUR: one credit may be discharged more than once — the cap is an aggregate', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    // 044 anchors one credit per return line with return_item_id UNIQUE. This is
    // deliberately different: a patient may take part of an entitlement back in
    // cash and come back for the rest. Forbidding the second instalment would be
    // a policy the schema has no basis for.
    const instalment = (amount: string) =>
      rows(c, `${refundInsert(`$1, $2, $3, ${amount}, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`)} RETURNING refund_id`, [
        f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId,
      ]);
    assert.equal((await instalment('5.00')).length, 1);
    assert.equal((await instalment('7.50')).length, 1);
    const total = await rows(c, `SELECT COALESCE(SUM(amount), 0)::numeric AS refunded FROM refunds WHERE credit_id = $1`, [f.creditId]);
    assert.equal(Number(total[0].refunded), 12.5, 'this aggregate is what the writer will compare to refund_due_amount');
  });
});

test('APPLIED: re-running 049 changes nothing and never moves a row', { skip: !enabled }, async () => {
  await withRefundSchema(async (c, f) => {
    await rows(c, refundInsert(`$1, $2, $3, 10.00, 'PATIENT', 'CASH', 'JOD', $4, 'RETURN_CREDIT', $5`), [
      f.paymentId, f.invoiceId, f.clinicId, f.creditId, f.userId,
    ]);
    const before = await rows(c, `SELECT COUNT(*)::int AS n, MIN(refund_id) AS id FROM refunds`);

    await c.query(fs.readFileSync(migrationPath, 'utf8'));

    const after = await rows(c, `SELECT COUNT(*)::int AS n, MIN(refund_id) AS id FROM refunds`);
    assert.deepEqual(after[0], before[0], 'idempotent: a retry adds no table, no index, no permission and no row');
  });
});

test('APPLIED: RECORD_REFUND exists in Finance and reaches exactly three roles', { skip: !enabled }, async () => {
  await withRefundSchema(async (c) => {
    const perm = await rows(c, `SELECT permission_group FROM permissions WHERE permission_key = 'RECORD_REFUND'`);
    assert.equal(perm.length, 1);
    assert.equal(perm[0].permission_group, 'Finance');

    const granted = await rows(
      c,
      `SELECT r.role_name FROM role_permissions rp
         JOIN permissions p ON p.permission_id = rp.permission_id
         JOIN roles r ON r.role_id = rp.role_id
        WHERE p.permission_key = 'RECORD_REFUND' ORDER BY r.role_name`,
    );
    assert.deepEqual(granted.map((r) => r.role_name), ['ACCOUNTANT', 'SUPER_ADMIN', 'SYSTEM_ADMIN']);
  });
});

test('APPLIED: RECORD_REFUND and RECORD_PAYMENT are separate keys, not aliases', { skip: !enabled }, async () => {
  await withRefundSchema(async (c) => {
    // Collecting must never imply disbursing: the two are bounded by different
    // ceilings, so one key cannot stand in for the other.
    const both = await rows(
      c,
      `SELECT permission_key FROM permissions
        WHERE permission_key IN ('RECORD_PAYMENT', 'RECORD_REFUND') ORDER BY permission_key`,
    );
    assert.deepEqual(both.map((r) => r.permission_key), ['RECORD_PAYMENT', 'RECORD_REFUND']);

    const refundOnly = await rows(
      c,
      `SELECT r.role_name FROM role_permissions rp
         JOIN permissions p ON p.permission_id = rp.permission_id
         JOIN roles r ON r.role_id = rp.role_id
        WHERE p.permission_key = 'RECORD_PAYMENT' AND r.role_name = 'ACCOUNTANT'`,
    );
    assert.equal(refundOnly.length, 1, 'the settling role still holds the collecting key — the new one only adds to it');
  });
});
