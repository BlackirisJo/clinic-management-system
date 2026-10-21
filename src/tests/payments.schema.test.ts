import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10G.1 — Settlement foundation: payments + cutover marker
 *
 * Two tiers, deliberately:
 *
 *   1. SOURCE (always runs). The migration is not applied anywhere yet — 047
 *      ships the schema and leaves settlement_cutover empty on purpose — so the
 *      ungated assertions read the migration text and prove the DDL, the indexes,
 *      the immutability triggers, the permission grants and the absence of a
 *      cutover row. These fail the moment the file drifts from the policy.
 *
 *   2. APPLIED (opt-in). Constraint behaviour can only be observed against a real
 *      catalog, so it is gated behind SETTLEMENT_SCHEMA_TEST=1 exactly as the
 *      insert-based assertions are in medicationReturns.schema.test.ts. When
 *      enabled it applies 047 inside a transaction that is ALWAYS rolled back,
 *      so the developer's database is never modified: the schema is verified to
 *      exist, then vanishes. Nothing is committed, so an enabled run is safe to
 *      repeat and safe to interrupt.
 * ========================================================================== */

const enabled = process.env.SETTLEMENT_SCHEMA_TEST === '1';
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const MIGRATION_FILE = '047_payments.sql';
const migrationPath = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
const migrationSql = () => fs.readFileSync(migrationPath, 'utf8');
/**
 * Executable SQL only, comments stripped. This migration explains at length why
 * it never touches paid_amount and why it is not a system_settings row, so an
 * absence assertion has to read the statements rather than the prose — otherwise
 * a well-documented comment would read as a violation.
 */
const migrationCode = () =>
  migrationSql()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/** Applies 047 inside a transaction, runs fn, and always rolls back. */
const withMigratedSchema = async (fn: (c: PoolClient) => Promise<void>): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

/**
 * A failed statement aborts the whole transaction in Postgres, so every expected
 * rejection runs inside its own savepoint and the transaction stays usable for
 * the next assertion.
 */
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
  return caught ?? { code: 'NONE', message: 'statement was accepted' };
};

const rows = async (c: PoolClient, text: string, params: unknown[] = []): Promise<any[]> =>
  (await c.query(text, params)).rows;

/* ==========================================================================
 * 1. SOURCE — the migration file itself (ungated)
 * ======================================================================== */

test('SOURCE: 047_payments.sql and 048_settlement_cutover_activation.sql are the only settlement migrations', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  assert.ok(files.includes('047_payments.sql'), '047_payments.sql is present');
  assert.ok(files.includes('048_settlement_cutover_activation.sql'), '048 activates the cutover');
  assert.ok(files.includes('046_prescription_fulfilment_permission.sql'), '046 is untouched and still present');
  // A later migration may exist for an unrelated concern — 049 stores refunds,
  // the other side of the same ledger. What must not change is the settlement
  // pair itself: no migration after 048 extends or revises the payments ledger.
  const settlement = files.filter((f) => f.endsWith('.sql')).filter((f) => /payments|settlement/i.test(f)).sort();
  assert.deepEqual(settlement, ['047_payments.sql', '048_settlement_cutover_activation.sql']);
});

test('SOURCE: migration is additive — it alters no existing table', () => {
  const sql = migrationCode();
  const alters = sql.match(/ALTER\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s+settlement_cutover)/gi) ?? [];
  assert.deepEqual(alters, [], `no ALTER TABLE at all: ${alters.join(' ')}`);
  assert.doesNotMatch(sql, /DROP\s+TABLE/i, 'no table is dropped');
  assert.doesNotMatch(sql, /TRUNCATE\s+TABLE\s+(?!settlement_cutover)/i, 'no data is truncated');
});

test('SOURCE: migration never writes paid_amount or touches an existing invoice', () => {
  const sql = migrationCode();
  assert.doesNotMatch(sql, /paid_amount/i, 'paid_amount is not part of 047 at all');
  assert.doesNotMatch(sql, /UPDATE\s+invoices/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+invoices/i);
  assert.doesNotMatch(sql, /ALTER\s+TYPE\s+payment_method/i, 'the shared enum is not modified');
});

test('SOURCE: payments carries every required column with its nullability', () => {
  const sql = migrationSql();
  const required = [
    'payment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    'invoice_id INT NOT NULL',
    'clinic_id INT NOT NULL',
    'amount NUMERIC(10, 2) NOT NULL',
    'payer_type VARCHAR(20) NOT NULL',
    'method payment_method NOT NULL',
    'currency_code VARCHAR(3) NOT NULL',
    'received_by_user_id INT NOT NULL',
    'received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'voided_at TIMESTAMPTZ NULL',
    'voided_by_user_id INT NULL',
    'void_reason TEXT NULL',
    'idempotency_key VARCHAR(64) NULL',
    'note TEXT NULL',
    'created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP',
  ];
  for (const column of required) {
    assert.ok(sql.includes(column), `missing column declaration: ${column}`);
  }
});

test('SOURCE: the four money-shaped constraints are declared by name', () => {
  const sql = migrationSql();
  for (const name of [
    'chk_payments_amount_positive',
    'chk_payments_payer_type',
    'chk_payments_method_cash_card',
    'chk_payments_void_consistent',
  ]) {
    assert.ok(sql.includes(name), `missing constraint ${name}`);
  }
  assert.match(sql, /CHECK \(amount > 0\)/, 'amount must be strictly positive');
  assert.match(sql, /payer_type IN \('PATIENT', 'INSURER'\)/);
  assert.match(sql, /method IN \('CASH', 'CARD'\)/, 'method admits cash and card only');
  assert.match(
    sql,
    /CHECK \(\(voided_at IS NULL\) = \(voided_by_user_id IS NULL\)\)/,
    'void is one fact: timestamp and actor agree',
  );
});

test('SOURCE: both indexes are declared exactly as approved', () => {
  const sql = migrationSql();
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_payments_invoice_live\s+ON payments \(invoice_id\) WHERE voided_at IS NULL/,
    'live payments by invoice',
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_invoice_idempotency\s+ON payments \(invoice_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/,
    'idempotency is unique per invoice and only when supplied',
  );
});

test('SOURCE: settlement_cutover is single-row and immutable, with no row inserted', () => {
  const sql = migrationSql();
  assert.match(sql, /singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK \(singleton\)/);
  assert.match(sql, /cutover_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /reason TEXT NOT NULL/);
  assert.match(sql, /set_by VARCHAR\(100\) NOT NULL/);
  assert.match(sql, /created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON settlement_cutover/, 'row-level immutability');
  assert.match(sql, /BEFORE TRUNCATE ON settlement_cutover/, 'truncate cannot slip past a row trigger');
  assert.match(sql, /settlement_cutover_is_immutable/, 'the guard is a named function');
  // THE critical absence: no marker, so no boundary exists yet.
  assert.doesNotMatch(migrationCode(), /INSERT\s+INTO\s+settlement_cutover/i, '047 must not activate the cutover');
});

test('SOURCE: settlement_cutover is not a settings row', () => {
  assert.doesNotMatch(migrationCode(), /system_settings/i, 'an editable key/value setting is not a boundary');
});

test('SOURCE: the permission is granted to finance-writing roles only', () => {
  const sql = migrationSql();
  assert.match(sql, /'RECORD_PAYMENT',\s*'Finance'/);
  const grant = sql.slice(sql.indexOf('INSERT INTO role_permissions'));
  const match = /r\.role_name IN \(([^)]*)\)/.exec(grant);
  assert.ok(match, 'the grant lists its roles explicitly');
  const roles = match![1]!
    .split(',')
    .map((r) => r.trim().replace(/^'|'$/g, ''))
    .sort();
  assert.deepEqual(roles, ['ACCOUNTANT', 'SUPER_ADMIN', 'SYSTEM_ADMIN']);
  for (const roleName of ['FINANCIAL_AUDITOR', 'RECEPTIONIST', 'DOCTOR', 'NURSE', 'PHARMACIST']) {
    assert.ok(!grant.includes(`'${roleName}'`), `${roleName} is never granted RECORD_PAYMENT`);
  }
  assert.doesNotMatch(sql, /UPDATE\s+permissions|DELETE\s+FROM\s+permissions/, 'no existing permission is modified');
  assert.doesNotMatch(sql, /UPDATE\s+role_permissions|DELETE\s+FROM\s+role_permissions/, 'no existing grant is modified');
});

test('SOURCE: 047 لا يكتب دفعة — الكتابة في وحدة التحكم لا في الترحيل', () => {
  // The migration creates storage; the write path (10G.2) is the only writer.
  assert.doesNotMatch(migrationCode(), /INSERT INTO payments/i, '047 لا يُنشئ حركة مال');
  const controller = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'payments.controller.ts'),
    'utf8',
  );
  assert.match(controller, /INSERT INTO payments/i, 'الكاتب هو وحدة تحكم التسجيل');
});

/* ==========================================================================
 * 2. SEED — the permission catalogue (ungated)
 * ======================================================================== */

test('SEED: RECORD_PAYMENT is in the Finance group', () => {
  const seed = fs.readFileSync(require.resolve('../scripts/seed'), 'utf8');
  assert.match(seed, /key: 'RECORD_PAYMENT', group: 'Finance'/);
});

test('SEED: ACCOUNTANT receives it; FINANCIAL_AUDITOR never does', () => {
  const seed = fs.readFileSync(require.resolve('../scripts/seed'), 'utf8');
  const matrix = seed.slice(seed.indexOf('const ROLE_PERMISSIONS'));
  const accountant = /ACCOUNTANT: \[([^\]]*)\]/.exec(matrix);
  assert.ok(accountant, 'ACCOUNTANT row exists');
  assert.ok(accountant![1]!.includes("'RECORD_PAYMENT'"), 'the settling role holds it');
  const auditor = /FINANCIAL_AUDITOR: \[([^\]]*)\]/.exec(matrix);
  assert.ok(auditor, 'FINANCIAL_AUDITOR row exists');
  assert.ok(!auditor![1]!.includes('RECORD_PAYMENT'), 'the read-only auditor role must never hold it');
  for (const roleName of ['RECEPTIONIST', 'DOCTOR', 'NURSE']) {
    const row = new RegExp(`${roleName}: \\[([^\\]]*)\\]`).exec(matrix);
    assert.ok(!row![1]!.includes('RECORD_PAYMENT'), `${roleName} is not a finance-writing role`);
  }
});

/* ==========================================================================
 * 3. APPLIED — catalog (opt-in, always rolled back)
 * ======================================================================== */

test('APPLIED: payments exists with exactly the approved columns', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const present = await rows(
      c,
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('payments','settlement_cutover')
       ORDER BY table_name`,
    );
    assert.deepEqual(present.map((r) => r.table_name), ['payments', 'settlement_cutover']);

    const cols = await rows(
      c,
      `SELECT column_name, is_nullable, column_default, data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'payments'
       ORDER BY ordinal_position`,
    );
    const byName = new Map(cols.map((r) => [r.column_name, r]));
    assert.deepEqual(
      [...byName.keys()],
      [
        'payment_id', 'invoice_id', 'clinic_id', 'amount', 'payer_type', 'method',
        'currency_code', 'received_by_user_id', 'received_at', 'voided_at',
        'voided_by_user_id', 'void_reason', 'idempotency_key', 'note', 'created_at',
      ],
      'column set and order are exactly as approved',
    );
    for (const notNull of [
      'invoice_id', 'clinic_id', 'amount', 'payer_type', 'method', 'currency_code',
      'received_by_user_id', 'received_at', 'created_at',
    ]) {
      assert.equal(byName.get(notNull)!.is_nullable, 'NO', `${notNull} is NOT NULL`);
    }
    for (const nullable of ['voided_at', 'voided_by_user_id', 'void_reason', 'idempotency_key', 'note']) {
      assert.equal(byName.get(nullable)!.is_nullable, 'YES', `${nullable} is optional`);
    }
    assert.equal(byName.get('payer_type')!.udt_name, 'varchar', 'payer_type is not a new enum type');
    assert.equal(byName.get('method')!.udt_name, 'payment_method', 'method reuses the existing enum');
    assert.equal(String(byName.get('received_at')!.column_default).includes('CURRENT_TIMESTAMP'), true);
    assert.equal(String(byName.get('created_at')!.column_default).includes('CURRENT_TIMESTAMP'), true);
  });
});

test('APPLIED: amount, payer_type and method are bounded by CHECK constraints', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const defs = new Map(
      (
        await rows(
          c,
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'payments'::regclass AND contype = 'c'`,
        )
      ).map((r) => [r.conname, String(r.def)]),
    );
    // Postgres prints the constraint against the coerced literal, not the source text.
    assert.match(defs.get('chk_payments_amount_positive')!, /amount > \(0\)/);
    const payer = defs.get('chk_payments_payer_type')!;
    assert.ok(payer.includes('PATIENT') && payer.includes('INSURER'));
    assert.ok(!payer.includes('INSURANCE'), 'the payer enum value is not a payer_type');
    const method = defs.get('chk_payments_method_cash_card')!;
    assert.ok(method.includes('CASH') && method.includes('CARD'));
    assert.ok(!method.includes('INSURANCE') && !method.includes('SPLIT'), 'INSURANCE/SPLIT are not methods');
    assert.match(defs.get('chk_payments_void_consistent')!, /voided_at IS NULL.*voided_by_user_id IS NULL/s);
  });
});

test('APPLIED: invoice_id is a RESTRICT foreign key, never CASCADE', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const fks = await rows(
      c,
      `SELECT conname, confrelid::regclass::text AS target, confdeltype
       FROM pg_constraint
       WHERE conrelid = 'payments'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    const byTarget = new Map(fks.map((r) => [r.target, r]));
    // confdeltype: a = NO ACTION, r = RESTRICT, c = CASCADE
    assert.equal(byTarget.get('invoices')!.confdeltype, 'r', 'deleting an invoice must not delete its payments');
    assert.equal(byTarget.get('clinics')!.confdeltype, 'r', 'clinic_id is RESTRICT');
    assert.ok(byTarget.has('currency_master'), 'currency_code references the currency catalogue');
    assert.equal(byTarget.has('users'), true);
  });
});

test('APPLIED: the live index is partial and the idempotency index is unique and partial', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const idx = new Map(
      (
        await rows(
          c,
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'payments'`,
        )
      ).map((r) => [r.indexname, String(r.indexdef)]),
    );
    const live = idx.get('idx_payments_invoice_live')!;
    assert.match(live, /\(invoice_id\)/);
    assert.match(live, /WHERE \(voided_at IS NULL\)/, 'only live payments are indexed');
    const idem = idx.get('uq_payments_invoice_idempotency')!;
    assert.match(idem, /CREATE UNIQUE INDEX/);
    assert.match(idem, /\(invoice_id, idempotency_key\)/);
    assert.match(idem, /WHERE \(idempotency_key IS NOT NULL\)/, 'absent keys must not collide');
  });
});

test('APPLIED: settlement_cutover is a single-row table guarded by triggers', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const cols = await rows(
      c,
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'settlement_cutover'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(cols.map((r) => r.column_name), [
      'singleton', 'cutover_at', 'reason', 'set_by', 'created_at',
    ]);
    assert.equal(cols.find((r) => r.column_name === 'singleton')!.data_type, 'boolean');
    for (const notNull of ['singleton', 'cutover_at', 'reason', 'set_by']) {
      assert.equal(cols.find((r) => r.column_name === notNull)!.is_nullable, 'NO', notNull);
    }
    const triggers = await rows(
      c,
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'settlement_cutover'::regclass AND NOT tgisinternal`,
    );
    assert.deepEqual(triggers.map((r) => r.tgname).sort(), [
      'trg_settlement_cutover_immutable',
      'trg_settlement_cutover_no_truncate',
    ]);
  });
});

test('APPLIED: the cutover row exists exactly once — 047 creates it empty, 048 activates it', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    // The boundary is activated as of 10G.3. 047 alone still inserts no row —
    // settlementCutover.test.ts proves that by reading the file — so this
    // assertion is about the post-cutover database, not about 047's statements.
    const cutover = await rows(c, `SELECT cutover_at, reason, set_by FROM settlement_cutover`);
    assert.equal(cutover.length, 1, 'one marker, never two');
    assert.ok(cutover[0].cutover_at instanceof Date, 'a server timestamp');
    assert.equal(cutover[0].reason, 'Settlement payment ledger activated');

    const payments = await rows(c, `SELECT COUNT(*)::int AS n FROM payments`);
    assert.equal(payments[0].n, 0, 'activation writes no payment row for anyone');
  });
});

test('APPLIED: RECORD_PAYMENT exists in Finance and reaches exactly three roles', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const perm = await rows(
      c,
      `SELECT permission_group FROM permissions WHERE permission_key = 'RECORD_PAYMENT'`,
    );
    assert.equal(perm.length, 1);
    assert.equal(perm[0].permission_group, 'Finance');
    const granted = await rows(
      c,
      `SELECT r.role_name FROM role_permissions rp
       JOIN permissions p ON p.permission_id = rp.permission_id
       JOIN roles r ON r.role_id = rp.role_id
       WHERE p.permission_key = 'RECORD_PAYMENT' ORDER BY r.role_name`,
    );
    assert.deepEqual(granted.map((r) => r.role_name), ['ACCOUNTANT', 'SUPER_ADMIN', 'SYSTEM_ADMIN']);
  });
});

/* ==========================================================================
 * 4. APPLIED — constraint behaviour (opt-in, transactional fixtures)
 * ======================================================================== */

interface Fixture {
  clinicId: number;
  userId: number;
  invoiceId: number;
}

const seedInvoice = async (c: PoolClient): Promise<Fixture> => {
  const clinic = await rows(c, `SELECT clinic_id FROM clinics ORDER BY clinic_id LIMIT 1`);
  const user = await rows(c, `SELECT user_id FROM users ORDER BY user_id LIMIT 1`);
  const patient = await rows(
    c,
    `SELECT p.patient_id FROM patients p
     JOIN clinics c ON c.clinic_id = p.clinic_id
     WHERE p.clinic_id = $1 ORDER BY p.patient_id LIMIT 1`,
    [clinic[0].clinic_id],
  );
  const invoice = await rows(
    c,
    `INSERT INTO invoices (patient_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
     VALUES ($1, $2, 100.00, 0, 100.00, 0, 'CASH', 'JOD')
     RETURNING invoice_id`,
    [patient[0].patient_id, user[0].user_id],
  );
  return {
    clinicId: Number(clinic[0].clinic_id),
    userId: Number(user[0].user_id),
    invoiceId: Number(invoice[0].invoice_id),
  };
};

/** Insert statement; `keyed` appends the optional idempotency column. */
const paymentInsert = (keyed = false) =>
  `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code, received_by_user_id${keyed ? ', idempotency_key' : ''})
   VALUES ($1, $2, $3, $4, $5, $6, $7${keyed ? ', $8' : ''})
   RETURNING payment_id`;

test('BEHAVIOUR: a payment must be a positive amount from a known payer on cash or card', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const f = await seedInvoice(c);
    const base = [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', f.userId];

    const ok = await rows(c, paymentInsert(), base);
    assert.equal(ok.length, 1, 'the ordinary case is accepted');

    for (const amount of ['0.00', '-5.00']) {
      const bad = await expectReject(c, paymentInsert(), [f.invoiceId, f.clinicId, amount, 'PATIENT', 'CASH', 'JOD', f.userId]);
      assert.equal(bad.code, '23514', `amount ${amount} must violate the CHECK`);
    }
    for (const payer of ['THIRD_PARTY', 'INSURANCE', '']) {
      const bad = await expectReject(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, payer, 'CASH', 'JOD', f.userId]);
      assert.equal(bad.code, '23514', `payer_type ${payer || '(empty)'} must be refused`);
    }
    // INSURANCE and SPLIT exist in the shared enum and are still refused here:
    // that is the CHECK doing its job, not the type. A label outside the enum is
    // stopped earlier still, by the type itself.
    for (const method of ['INSURANCE', 'SPLIT']) {
      const bad = await expectReject(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'PATIENT', method, 'JOD', f.userId]);
      assert.equal(bad.code, '23514', `${method} is a payer/contract fact, not a way to hand over cash`);
    }
    const notEvenALabel = await expectReject(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'WIRE', 'JOD', f.userId]);
    assert.equal(notEvenALabel.code, '22P02', 'a method outside the enum never reaches the CHECK');
    const insurer = await rows(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'INSURER', 'CASH', 'JOD', f.userId]);
    assert.equal(insurer.length, 1, 'an insurer paying in cash is a legitimate, separately recorded fact');
  });
});

test('BEHAVIOUR: void is one fact — a timestamp and an actor must agree', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const f = await seedInvoice(c);
    const created = await rows(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', f.userId]);
    const paymentId = Number(created[0].payment_id);

    const halfVoid = await expectReject(c, `UPDATE payments SET voided_at = NOW() WHERE payment_id = $1`, [paymentId]);
    assert.equal(halfVoid.code, '23514', 'voided_at without an actor is not a void');

    const bothVoid = await expectReject(
      c,
      `UPDATE payments SET voided_at = NOW(), voided_by_user_id = $2 WHERE payment_id = $1`,
      [paymentId, f.userId],
    );
    assert.equal(bothVoid.code, 'NONE', 'a complete void is permitted and is the repair path');

    const halfVoid2 = await expectReject(c, `UPDATE payments SET voided_by_user_id = $2 WHERE payment_id = $1`, [paymentId, f.userId]);
    assert.equal(halfVoid2.code, '23514', 'an actor without a timestamp is not a void either');
  });
});

test('BEHAVIOUR: an idempotency key is unique per invoice and optional', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const f = await seedInvoice(c);
    const other = await seedInvoice(c);
    const keyed = paymentInsert(true);
    const params = [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', f.userId, 'req-1'];

    await rows(c, keyed, params);
    const dupe = await expectReject(c, keyed, params);
    assert.equal(dupe.code, '23505', 'the same key on the same invoice is a double submission');

    const otherParams = [other.invoiceId, other.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', other.userId, 'req-1'];
    const elsewhere = await rows(c, keyed, otherParams);
    assert.equal(elsewhere.length, 1, 'the key is scoped to its invoice, not global');

    await rows(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', f.userId]);
    const secondUnkeyed = await rows(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', f.userId]);
    assert.equal(secondUnkeyed.length, 1, 'absent keys never collide with each other');
  });
});

test('BEHAVIOUR: an invoice cannot be deleted while a payment points at it', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    const f = await seedInvoice(c);
    await rows(c, paymentInsert(), [f.invoiceId, f.clinicId, 10.0, 'PATIENT', 'CASH', 'JOD', f.userId]);

    const blocked = await expectReject(c, `DELETE FROM invoices WHERE invoice_id = $1`, [f.invoiceId]);
    assert.equal(blocked.code, '23503', 'RESTRICT protects the money record from the document');

    await rows(c, `UPDATE payments SET voided_at = NOW(), voided_by_user_id = $2 WHERE invoice_id = $1`, [f.invoiceId, f.userId]);
    const stillBlocked = await expectReject(c, `DELETE FROM invoices WHERE invoice_id = $1`, [f.invoiceId]);
    assert.equal(stillBlocked.code, '23503', 'a void is not a deletion: the history still stands in the way');
  });
});

test('BEHAVIOUR: the cutover marker is written once and can never be moved or removed', { skip: !enabled }, async () => {
  await withMigratedSchema(async (c) => {
    // Phase 10G.3 activated the boundary, so this probe no longer creates the
    // marker — it attacks the REAL one. That is the stronger assertion: the row
    // under test is the row the application reads.
    const present = await rows(c, `SELECT cutover_at, reason FROM settlement_cutover`);
    assert.equal(present.length, 1, 'the activated marker is what these probes attack');

    const moved = await expectReject(c, `UPDATE settlement_cutover SET cutover_at = NOW() + INTERVAL '1 day'`);
    assert.equal(moved.code, '23001', 'moving the boundary is refused by the database');
    const second = await expectReject(c, `UPDATE settlement_cutover SET reason = 'relabelled'`);
    assert.equal(second.code, '23001', 'even relabelling it is refused');
    const removed = await expectReject(c, `DELETE FROM settlement_cutover`);
    assert.equal(removed.code, '23001', 'and it cannot be deleted');
    const wiped = await expectReject(c, `TRUNCATE settlement_cutover`);
    assert.equal(wiped.code, '23001', 'nor truncated');

    const duplicate = await expectReject(c, `INSERT INTO settlement_cutover (cutover_at, reason, set_by) VALUES (NOW(), 'second', 'test')`);
    assert.equal(duplicate.code, '23505', 'a second marker is impossible');
    const notSingleton = await expectReject(c, `INSERT INTO settlement_cutover (singleton, cutover_at, reason, set_by) VALUES (FALSE, NOW(), 'x', 'test')`);
    assert.equal(notSingleton.code, '23514', 'and the singleton flag cannot be turned off');

    const survivors = await rows(c, `SELECT COUNT(*)::int AS n, MIN(reason) AS reason FROM settlement_cutover`);
    assert.equal(survivors[0].n, 1, 'the marker is intact and still the only one');
    assert.equal(survivors[0].reason, present[0].reason, 'with its original reason — every probe failed');
  });
});