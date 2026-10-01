import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10D.2 — Applied-schema verification for stock_adjustments
 *
 * Catalog assertions are read-only (same convention as the 10D.1 schema test).
 * The constraint-behaviour assertions must actually insert rows, so they are
 * gated behind the same opt-in flag as the concurrency suite and never touch a
 * developer's database implicitly:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

const num = (value: unknown): number => Number(value);

/* ==========================================================================
 * CATALOG (read-only)
 * ========================================================================== */

test('SCHEMA: stock_adjustments exists with the traceability columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_adjustments'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'adjustment_id', 'clinic_id', 'batch_id', 'inventory_id', 'medication_id',
    'direction', 'quantity', 'quantity_before', 'quantity_after',
    'reason', 'notes', 'performed_by_user_id', 'created_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }

  // WHO / WHICH / WHERE / WHY / WHEN must all be mandatory
  for (const column of [
    'clinic_id', 'batch_id', 'inventory_id', 'medication_id', 'direction',
    'quantity', 'quantity_before', 'quantity_after', 'reason', 'performed_by_user_id', 'created_at',
  ]) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // notes alone is optional
  assert.equal(byName.get('notes').is_nullable, 'YES');
});

test('SCHEMA: the direction / quantity / reason constraints exist', async () => {
  const rows = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'stock_adjustments'::regclass`);
  const names = rows.map((r) => r.conname);

  assert.ok(names.includes('chk_sa_direction_valid'), 'direction is a controlled value');
  assert.ok(names.includes('chk_sa_quantity_positive'), 'quantity is never zero or negative');
  assert.ok(names.includes('chk_sa_reason_present'), 'a blank reason is not a reason');
  assert.ok(names.includes('chk_sa_before_after_consistent'), 'the balances must match the direction');
  assert.ok(names.includes('chk_sa_before_nonneg'));
  assert.ok(names.includes('chk_sa_after_nonneg'));
});

test('SCHEMA: adjustment history is protected — no CASCADE on any FK', async () => {
  const rows = await q(
    `SELECT rc.delete_rule, tc.constraint_name
     FROM information_schema.referential_constraints rc
     JOIN information_schema.table_constraints tc
       ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
     WHERE tc.table_name = 'stock_adjustments'`,
  );
  assert.ok(rows.length >= 5, 'every reference is a real FK');
  for (const row of rows) {
    assert.equal(row.delete_rule, 'RESTRICT', `${row.constraint_name} must be RESTRICT, never CASCADE`);
  }
});

test('SCHEMA: the audit lookup indexes exist', async () => {
  const rows = await q(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'stock_adjustments' ORDER BY indexname`,
  );
  const names = rows.map((r) => r.indexname);
  assert.ok(names.includes('idx_sa_clinic_created'));
  assert.ok(names.includes('idx_sa_batch_created'));
  assert.ok(names.includes('idx_sa_performed_by'));
});

test('SCHEMA: the movement vocabulary still has exactly seven types', async () => {
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_movement_type_valid' AND conrelid = 'stock_movements'::regclass`,
  );
  const def = String(rows[0].def);
  for (const type of ['RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'ADJUSTMENT_DECREASE', 'WASTE', 'EXPIRE']) {
    assert.ok(def.includes(`'${type}'`), `CHECK must allow ${type}`);
  }
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (writes — opt-in only)
 * ========================================================================== */

interface Fixture { clinic: number; medication: number; inventory: number; batch: number; user: number }

const seed = async (): Promise<Fixture> => {
  const stamp = `ADJ-SCHEMA-${Date.now()}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [stamp],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Schema Probe', `adj-schema-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Schema Probe'],
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
    `INSERT INTO stock_adjustments
       (clinic_id, batch_id, inventory_id, medication_id, direction, quantity,
        quantity_before, quantity_after, reason, notes, performed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING adjustment_id`,
    [
      f.clinic, f.batch, f.inventory, f.medication,
      over.direction ?? 'INCREASE',
      over.quantity ?? 10,
      over.quantity_before ?? 100,
      over.quantity_after ?? 110,
      over.reason ?? 'schema probe',
      over.notes ?? null,
      f.user,
    ],
  );

const drop = async (f: Fixture) => {
  await pool.query(`DELETE FROM audit_logs WHERE resource_type = 'STOCK_ADJUSTMENT' AND resource_id IN (SELECT adjustment_id::text FROM stock_adjustments WHERE batch_id = $1)`, [f.batch]);
  await pool.query(`DELETE FROM stock_movements WHERE batch_id = $1`, [f.batch]);
  await pool.query(`DELETE FROM stock_adjustments WHERE batch_id = $1`, [f.batch]);
  await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

test('SCHEMA: a valid increase header is accepted by the database', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const rows = await insertHeader(f);
    assert.equal(rows.length, 1, 'the declared shape must actually be insertable');
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a blank or whitespace reason is refused by the database itself', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    for (const reason of ['', '   ', '\t\n']) {
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
        () => insertHeader(f, { quantity, quantity_after: 100 + quantity }),
        `quantity ${quantity} must be refused`,
      );
    }
  } finally {
    await drop(f);
  }
});

test('SCHEMA: balances must agree with the declared direction', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    // A DECREASE whose after-quantity is higher than before is a contradiction
    await assert.rejects(
      () => insertHeader(f, { direction: 'DECREASE', quantity: 10, quantity_before: 100, quantity_after: 110 }),
      'the direction must match the arithmetic',
    );
    // An INCREASE whose after-quantity is lower is equally impossible
    await assert.rejects(
      () => insertHeader(f, { direction: 'INCREASE', quantity: 10, quantity_before: 100, quantity_after: 90 }),
      'the direction must match the arithmetic',
    );
    // An unknown direction is refused outright
    await assert.rejects(
      () => insertHeader(f, { direction: 'SIDEWAYS' }),
      'direction is a controlled value',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a batch cannot be deleted while adjustment history references it (RESTRICT)', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    await insertHeader(f);
    await assert.rejects(
      () => pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]),
      'adjustment history must block a batch delete',
    );
  } finally {
    await drop(f);
  }
});
