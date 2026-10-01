import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10D.3 — Applied-schema verification for inventory_write_offs
 *
 * Catalog assertions are read-only (same convention as the 10D.1/10D.2 schema
 * tests). The constraint-behaviour assertions must actually insert rows, so they
 * are gated behind the same opt-in flag as the concurrency suite and never touch
 * a developer's database implicitly:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

const num = (value: unknown): number => Number(value);

/* ==========================================================================
 * CATALOG (read-only)
 * ========================================================================== */

test('SCHEMA: inventory_write_offs exists with the traceability columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'inventory_write_offs'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'write_off_id', 'clinic_id', 'batch_id', 'inventory_id', 'medication_id',
    'type', 'quantity', 'quantity_before', 'quantity_after',
    'reason', 'notes', 'performed_by_user_id', 'created_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }

  // WHO / WHICH / WHERE / WHY / WHEN must all be mandatory
  for (const column of [
    'clinic_id', 'batch_id', 'inventory_id', 'medication_id', 'type',
    'quantity', 'quantity_before', 'quantity_after', 'reason', 'performed_by_user_id', 'created_at',
  ]) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // notes alone is optional
  assert.equal(byName.get('notes').is_nullable, 'YES');
});

test('SCHEMA: the type / quantity / reason / direction constraints exist', async () => {
  const rows = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'inventory_write_offs'::regclass`);
  const names = rows.map((r) => r.conname);

  assert.ok(names.includes('chk_iwo_type_valid'), 'type is a controlled value');
  assert.ok(names.includes('chk_iwo_quantity_positive'), 'quantity is never zero or negative');
  assert.ok(names.includes('chk_iwo_reason_present'), 'a blank reason is not a reason');
  assert.ok(names.includes('chk_iwo_before_after_consistent'), 'a write-off only ever subtracts');
  assert.ok(names.includes('chk_iwo_before_nonneg'));
  assert.ok(names.includes('chk_iwo_after_nonneg'));
});

test('SCHEMA: write-off history is protected — no CASCADE on any FK', async () => {
  const rows = await q(
    `SELECT rc.delete_rule, tc.constraint_name
     FROM information_schema.referential_constraints rc
     JOIN information_schema.table_constraints tc
       ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
     WHERE tc.table_name = 'inventory_write_offs'`,
  );
  assert.equal(rows.length, 5, 'five real FKs: clinic, batch, inventory item, medication, user');
  for (const row of rows) {
    assert.equal(row.delete_rule, 'RESTRICT', `${row.constraint_name} must be RESTRICT, never CASCADE`);
  }
});

test('SCHEMA: the audit lookup indexes exist', async () => {
  const rows = await q(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'inventory_write_offs' ORDER BY indexname`,
  );
  const names = rows.map((r) => r.indexname);
  assert.ok(names.includes('idx_iwo_clinic_created'));
  assert.ok(names.includes('idx_iwo_batch_created'));
  assert.ok(names.includes('idx_iwo_type_created'));
  assert.ok(names.includes('idx_iwo_performed_by'));
});

test('SCHEMA: the movement vocabulary is unchanged — no type was added by this phase', async () => {
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_movement_type_valid' AND conrelid = 'stock_movements'::regclass`,
  );
  const def = String(rows[0].def);
  for (const type of ['RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'ADJUSTMENT_DECREASE', 'WASTE', 'EXPIRE']) {
    assert.ok(def.includes(`'${type}'`), `CHECK must allow ${type}`);
  }
  assert.doesNotMatch(def, /WRITE_OFF|DAMAGE|WRITE-OFF/i, 'no new movement type was introduced');
});

test('SCHEMA: no reconciliation table exists yet', async () => {
  const rows = await q(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('reconciliations','stock_reconciliations')`,
  );
  // Later phases own these, deliberately excluded from this assertion:
  //   medication_returns / medication_return_items -> 10D.4
  //   stock_counts / stock_count_lines            -> 10D.6 (stock count foundation)
  assert.equal(rows.length, 0, '10D.3 is write-offs only, and reconciliation is still unimplemented');
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (writes — opt-in only)
 * ========================================================================== */

interface Fixture { clinic: number; medication: number; inventory: number; batch: number; user: number }

const seed = async (): Promise<Fixture> => {
  const stamp = `WO-SCHEMA-${Date.now()}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [stamp],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Write-off Schema Probe', `wo-schema-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Write-off Schema Probe'],
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

const insertHeader = (f: Fixture, over: Record<string, unknown> = {}) =>
  q(
    `INSERT INTO inventory_write_offs
       (clinic_id, batch_id, inventory_id, medication_id, type, quantity,
        quantity_before, quantity_after, reason, notes, performed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING write_off_id`,
    [
      f.clinic, f.batch, f.inventory, f.medication,
      over.type ?? 'WASTE',
      over.quantity ?? 10,
      over.quantity_before ?? 100,
      over.quantity_after ?? 90,
      over.reason ?? 'schema probe',
      over.notes ?? null,
      f.user,
    ],
  );

const drop = async (f: Fixture) => {
  await pool.query(
    `DELETE FROM audit_logs WHERE resource_type = 'INVENTORY_WRITE_OFF'
       AND resource_id IN (SELECT write_off_id::text FROM inventory_write_offs WHERE batch_id = $1)`,
    [f.batch],
  );
  await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [f.batch]);
  await pool.query('DELETE FROM inventory_write_offs WHERE batch_id = $1', [f.batch]);
  await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

test('SCHEMA: both declared types are accepted by the database', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    assert.equal((await insertHeader(f, { type: 'WASTE' })).length, 1);
    assert.equal((await insertHeader(f, { type: 'EXPIRE' })).length, 1);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a blank or whitespace reason is refused by the database itself', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    for (const reason of ['', '   ', '\t', '\n']) {
      await assert.rejects(
        () => insertHeader(f, { reason }),
        `reason ${JSON.stringify(reason)} must be refused at the DB level`,
      );
    }
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a zero or negative quantity is refused — no signed quantities', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    for (const quantity of [0, -5]) {
      await assert.rejects(
        () => insertHeader(f, { quantity, quantity_after: 100 - quantity }),
        `quantity ${quantity} must be refused`,
      );
    }
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a write-off can never increase stock', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    // after > before is impossible for a subtraction
    await assert.rejects(
      () => insertHeader(f, { quantity_before: 100, quantity_after: 110, quantity: 10 }),
      'a write-off only ever subtracts',
    );
    // a negative resulting balance is refused
    await assert.rejects(
      () => insertHeader(f, { quantity_before: 5, quantity_after: -5, quantity: 10 }),
      'a negative resulting balance is refused',
    );
    // an unknown type is refused outright
    await assert.rejects(
      () => insertHeader(f, { type: 'DAMAGE' }),
      'type is a controlled value',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a batch cannot be deleted while write-off history references it (RESTRICT)', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    await insertHeader(f);
    await assert.rejects(
      () => pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]),
      'write-off history must block a batch delete',
    );
  } finally {
    await drop(f);
  }
});
