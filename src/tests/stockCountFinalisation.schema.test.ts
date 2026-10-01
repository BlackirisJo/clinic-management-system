import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10D.7 — Applied-schema verification for the finalisation migration
 *
 * 038 must add exactly one column to stock_counts and change nothing else.
 * Catalog assertions are read-only; the behaviour assertions write, so they are
 * gated behind the project's opt-in flag:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

const num = (value: unknown): number => Number(value);

/* ==========================================================================
 * CATALOG (read-only)
 * ======================================================================== */

test('SCHEMA: the 10D.7 migration is recorded exactly once', async () => {
  const rows = await q(
    `SELECT version FROM schema_migrations WHERE version = '038_stock_count_finalisation.sql'`,
  );
  assert.equal(rows.length, 1, '038 must be applied');
});

test('SCHEMA: finalised_by_user_id exists on stock_counts', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_counts'
       AND column_name = 'finalised_by_user_id'`,
  );
  assert.equal(rows.length, 1, 'the finaliser column must exist');
  assert.equal(rows[0].is_nullable, 'YES', 'an open count has no finaliser');
  assert.equal(rows[0].data_type, 'integer');
});

test('SCHEMA: finalised_by_user_id is a RESTRICT foreign key to users', async () => {
  const rows = await q(
    `SELECT c.conname, rc.delete_rule, ccu.relname AS target,
            pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_class ccu ON ccu.oid = c.confrelid
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = c.conname AND rc.constraint_schema = 'public'
     WHERE t.relname = 'stock_counts' AND c.contype = 'f' AND ccu.relname = 'users'`,
  );

  const finaliser = rows.filter((r) => /\bfinalised_by_user_id\b/.test(String(r.def)));
  assert.equal(finaliser.length, 1, 'exactly one FK on finalised_by_user_id');
  assert.equal(finaliser[0].delete_rule, 'RESTRICT', 'and it is RESTRICT, never CASCADE');

  // approved_by_user_id keeps its own meaning and its own FK
  const approved = rows.filter((r) => /\bapproved_by_user_id\b/.test(String(r.def)));
  assert.equal(approved.length, 1, 'approved_by_user_id is untouched by 10D.7');
  assert.equal(approved[0].delete_rule, 'RESTRICT');
});

test('SCHEMA: no column was removed, renamed or retyped by 10D.7', async () => {
  const rows = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_counts'`,
  );
  const names = rows.map((r) => r.column_name);
  for (const column of [
    'count_id', 'clinic_id', 'status', 'counted_by_user_id', 'approved_by_user_id',
    'notes', 'created_at', 'finalised_at', 'finalised_by_user_id',
  ]) {
    assert.ok(names.includes(column), `missing column ${column}`);
  }
});

test('SCHEMA: the 10D.6 status and finalised_at constraints are unchanged', async () => {
  const rows = await q(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'stock_counts'::regclass`,
  );
  const byName = new Map(rows.map((r) => [r.conname, String(r.def).replace(/\s+/g, ' ')]));

  assert.ok(byName.has('chk_sc_status_valid'), 'the status vocabulary is still controlled');
  const statusDef = byName.get('chk_sc_status_valid')!;
  for (const status of ['OPEN', 'FINALISED', 'CANCELLED']) {
    assert.ok(statusDef.includes(`'${status}'`), `CHECK must still allow ${status}`);
  }
  assert.ok(
    byName.get('chk_sc_finalised_consistent')!.includes('finalised_at IS NOT NULL'),
    'a finalised count still must carry its timestamp',
  );
});

test('SCHEMA: the 10D.6 line columns and constraints are unchanged', async () => {
  const cols = await q(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_count_lines'`,
  );
  const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
  for (const column of ['system_quantity', 'counted_quantity', 'variance']) {
    assert.equal(byName.get(column), 'NO', `${column} is still NOT NULL evidence`);
  }
  for (const column of ['system_quantity_at_finalisation', 'adjusted_quantity']) {
    assert.equal(byName.get(column), 'YES', `${column} is still nullable`);
  }

  const constraints = await q(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'stock_count_lines'::regclass`,
  );
  const defs = constraints.map((c) => String(c.def).replace(/[()\s]/g, ''));
  assert.ok(
    defs.some((d) => d.includes('variance=counted_quantity-system_quantity')),
    'the variance identity is still enforced',
  );
  assert.ok(
    constraints.some((c) => c.conname === 'uq_scl_count_batch'),
    'the one-line-per-batch rule is still enforced',
  );
});

test('SCHEMA: the finalisation lookup index exists and no new table was added', async () => {
  const indexes = await q(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'stock_counts' ORDER BY indexname`,
  );
  assert.ok(indexes.map((r) => r.indexname).includes('idx_sc_finalised_by'));

  const tables = await q(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('stock_count_finalisations', 'stock_count_approvals', 'reconciliations')`,
  );
  assert.equal(tables.length, 0, 'no separate finalisation/approval/reconciliation table exists');
});

test('SCHEMA: no new stock movement type was introduced', async () => {
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_movement_type_valid' AND conrelid = 'stock_movements'::regclass`,
  );
  const def = String(rows[0].def);
  for (const type of ['ADJUSTMENT', 'ADJUSTMENT_DECREASE']) {
    assert.ok(def.includes(`'${type}'`), 'a count reuses the existing adjustment movement types');
  }
  assert.doesNotMatch(def, /COUNT/i, 'a stock count is not a movement type');
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (writes — opt-in only)
 * ======================================================================== */

interface Fixture { clinic: number; user: number; medication: number; inventory: number; batch: number }

const seed = async (): Promise<Fixture> => {
  const stamp = `FINAL-SCHEMA-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [stamp],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Finalisation Probe', `fin-schema-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Finalisation Probe'],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  const batch = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, 100, 0) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp],
  );
  return {
    clinic: num(clinic.rows[0].clinic_id),
    user: num(user.rows[0].user_id),
    medication: num(medication.rows[0].medication_id),
    inventory: num(inventory.rows[0].inventory_id),
    batch: num(batch.rows[0].batch_id),
  };
};

const insertCount = (f: Fixture, over: Record<string, unknown> = {}) =>
  q(
    `INSERT INTO stock_counts
       (clinic_id, status, counted_by_user_id, approved_by_user_id, finalised_by_user_id, finalised_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING count_id`,
    [
      f.clinic,
      over.status ?? 'OPEN',
      f.user,
      over.approved_by_user_id ?? null,
      over.finalised_by_user_id ?? null,
      over.finalised_at ?? null,
    ],
  );

const drop = async (f: Fixture) => {
  if (f.batch) {
    await pool.query('DELETE FROM stock_count_lines WHERE batch_id = $1', [f.batch]);
    await pool.query('DELETE FROM stock_counts WHERE clinic_id = $1', [f.clinic]);
    await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  }
  if (f.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.user) await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

test('SCHEMA: a finalised count with its finaliser is accepted', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const rows = await insertCount(f, {
      status: 'FINALISED', finalised_by_user_id: f.user, finalised_at: new Date(),
    });
    assert.equal(rows.length, 1);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a finalised count without a finaliser is still accepted (no DB-level rule)', { skip: !enabled, timeout: 30000 }, async () => {
  // Documented deliberately: 038 adds no CHECK, so this must be possible. The
  // application is the only writer and always sets the finaliser.
  const f = await seed();
  try {
    const rows = await insertCount(f, { status: 'FINALISED', finalised_by_user_id: null, finalised_at: new Date() });
    assert.equal(rows.length, 1);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: an open count may not carry a finaliser', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    // the pre-existing finalised_at rule is what stops this, not a 038 rule
    await assert.rejects(
      () => insertCount(f, { status: 'OPEN', finalised_by_user_id: f.user, finalised_at: new Date() }),
      'an open count still cannot claim to be finished',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a count history cannot be destroyed through the finaliser FK', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f, {
      status: 'FINALISED', finalised_by_user_id: f.user, finalised_at: new Date(),
    });
    assert.ok(count.count_id);
    await assert.rejects(
      () => pool.query('DELETE FROM users WHERE user_id = $1', [f.user]),
      'a finalised count must block deleting its finaliser',
    );
  } finally {
    await drop(f);
  }
});
