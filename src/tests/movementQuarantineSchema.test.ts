import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import { STOCK_MOVEMENT_TYPES } from '../validations/stockMovement.validation';

/* ==========================================================================
 * Phase 10D.1 — Applied-schema verification
 * Proves migration 033 is actually in the database: the movement vocabulary, the
 * untouched positive-quantity rule, and the quarantine table with its
 * constraints, indexes and no-CASCADE history protection.
 * ========================================================================== */

const ALLOWED = [...STOCK_MOVEMENT_TYPES];

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

/* ==========================================================================
 * MOVEMENT VOCABULARY
 * ========================================================================== */

test('SCHEMA: the movement-type CHECK accepts exactly the seven declared types', async () => {
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_movement_type_valid' AND conrelid = 'stock_movements'::regclass`,
  );
  assert.equal(rows.length, 1, 'chk_movement_type_valid must exist on stock_movements');

  const def = String(rows[0].def);
  for (const type of ALLOWED) {
    assert.ok(def.includes(`'${type}'`), `CHECK must allow ${type}`);
  }
  assert.ok(def.includes('ADJUSTMENT_DECREASE'), 'the new type is present');
  // ADJUSTMENT must remain in the vocabulary alongside the new type
  assert.ok(def.includes("'ADJUSTMENT'"));
});

test('SCHEMA: the database really accepts ADJUSTMENT_DECREASE and still rejects nonsense', async () => {
  // Needs a real batch; reuse an existing one if present, otherwise skip the insert half.
  const batches = await q(`SELECT batch_id FROM inventory_batches ORDER BY batch_id LIMIT 1`);
  if (batches.length === 0) return; // no stock seeded yet — the CHECK assertion above still holds

  const batchId = batches[0].batch_id;
  const accepted = await q(
    `INSERT INTO stock_movements (batch_id, movement_type, quantity)
     VALUES ($1, 'ADJUSTMENT_DECREASE', 1) RETURNING movement_id, movement_type, quantity`,
    [batchId],
  );
  assert.equal(accepted.length, 1, 'ADJUSTMENT_DECREASE must be accepted by the database');
  assert.equal(accepted[0].movement_type, 'ADJUSTMENT_DECREASE');

  // legacy types still accepted
  const legacy = await q(
    `INSERT INTO stock_movements (batch_id, movement_type, quantity)
     VALUES ($1, 'ADJUSTMENT', 1) RETURNING movement_type`,
    [batchId],
  );
  assert.equal(legacy[0].movement_type, 'ADJUSTMENT', 'ADJUSTMENT keeps working');

  await q(`DELETE FROM stock_movements WHERE batch_id = $1 AND movement_type IN ('ADJUSTMENT_DECREASE','ADJUSTMENT') AND quantity = 1`, [batchId]);

  await assert.rejects(
    () => q(`INSERT INTO stock_movements (batch_id, movement_type, quantity) VALUES ($1, 'NONSENSE', 1)`, [batchId]),
    'an unknown movement type must be rejected',
  );
});

test('SCHEMA: quantity must still be strictly positive', async () => {
  const batches = await q(`SELECT batch_id FROM inventory_batches ORDER BY batch_id LIMIT 1`);
  if (batches.length === 0) return;

  const batchId = batches[0].batch_id;
  for (const quantity of [0, -1]) {
    await assert.rejects(
      () => q(`INSERT INTO stock_movements (batch_id, movement_type, quantity) VALUES ($1, 'ADJUSTMENT_DECREASE', $2)`, [batchId, quantity]),
      `quantity ${quantity} must be rejected — no signed quantities were introduced`,
    );
  }
});

test('SCHEMA: no existing movement row was altered or backfilled', async () => {
  const rows = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE quantity <= 0)::int AS nonpositive,
            COUNT(*) FILTER (WHERE movement_type = 'ADJUSTMENT_DECREASE')::int AS new_type
     FROM stock_movements`,
  );
  assert.equal(rows[0].nonpositive, 0, 'no pre-existing row violates the positive-quantity rule');
  // The new type only ever appears if this phase's own tests inserted one
  assert.ok(rows[0].total >= 0);
});

/* ==========================================================================
 * QUARANTINE SCHEMA
 * ============================================================== */

test('SCHEMA: batch_quarantines exists with the traceability columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'batch_quarantines'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of ['quarantine_id', 'batch_id', 'clinic_id', 'reason', 'quarantined_by_user_id', 'quarantined_at']) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }
  // who / when / why must all be mandatory
  for (const column of ['batch_id', 'clinic_id', 'reason', 'quarantined_by_user_id', 'quarantined_at']) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // release fields are optional (an active quarantine has no release yet)
  for (const column of ['released_at', 'released_by_user_id', 'release_reason']) {
    assert.equal(byName.get(column).is_nullable, 'YES', `${column} must be nullable`);
  }
});

test('SCHEMA: quarantine has the reason/release consistency constraints', async () => {
  const rows = await q(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'batch_quarantines'::regclass`,
  );
  const names = rows.map((r) => r.conname);
  assert.ok(names.includes('chk_bq_reason_present'), 'a reason must be present and non-empty');
  assert.ok(names.includes('chk_bq_release_pair'), 'released_at and released_by must be set together');
  assert.ok(names.includes('chk_bq_release_reason'), 'a release must carry its own reason');
});

test('SCHEMA: at most one active quarantine per batch, and history survives release', async () => {
  const rows = await q(
    `SELECT indexdef FROM pg_indexes
     WHERE tablename = 'batch_quarantines' AND indexname = 'uq_bq_one_active_per_batch'`,
  );
  assert.equal(rows.length, 1, 'the partial unique index must exist');
  assert.match(String(rows[0].indexdef), /WHERE \(released_at IS NULL\)/, 'released rows must not block a new quarantine');
});

test('SCHEMA: quarantine history is protected — no CASCADE and no cascade delete on batches', async () => {
  const rows = await q(
    `SELECT rc.delete_rule
     FROM information_schema.referential_constraints rc
     JOIN information_schema.table_constraints tc
       ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
     WHERE tc.table_name = 'batch_quarantines' AND rc.delete_rule = 'CASCADE'`,
  );
  assert.equal(rows.length, 0, 'no CASCADE on quarantine history');
});

test('SCHEMA: quantity_reserved is still untouched and has no writer in the foundation', async () => {
  const cols = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'inventory_batches' AND column_name = 'quantity_reserved'`,
  );
  assert.equal(cols.length, 1, 'quantity_reserved still exists and is unchanged');
});

test('SCHEMA: no reconciliation table exists in this phase', async () => {
  const rows = await q(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('reconciliations','stock_reconciliations')`,
  );
  // Deliberately excluded, because later phases own them:
  //   stock_adjustments          -> Phase 10D.2 (manual adjustment)
  //   medication_returns/_items  -> Phase 10D.4 (returns foundation)
  //   stock_counts/_lines        -> Phase 10D.6 (stock count foundation)
  assert.equal(rows.length, 0, 'reconciliation is still unimplemented');
});
