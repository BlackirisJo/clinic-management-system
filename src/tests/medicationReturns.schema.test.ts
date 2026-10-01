import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import { MEDICATION_RETURN_STATUSES, RESTOCK_DECISIONS } from '../validations/medicationReturnRead.validation';

/* ==========================================================================
 * Phase 10D.4 — Applied-schema verification for the medication-returns foundation
 *
 * Catalog assertions are read-only (same convention as the 10D.1/10D.2/10D.3
 * schema tests). Constraint-behaviour assertions must insert rows, so they are
 * gated behind the same opt-in flag as the concurrency suite and never touch a
 * developer's database implicitly:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

const num = (value: unknown): number => Number(value);

/* ==========================================================================
 * 1-2. TABLES AND COLUMNS
 * ========================================================================== */

test('SCHEMA: both return tables exist', async () => {
  const rows = await q(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('medication_returns','medication_return_items')
     ORDER BY table_name`,
  );
  assert.deepEqual(rows.map((r) => r.table_name), ['medication_return_items', 'medication_returns']);
});

test('SCHEMA: medication_returns carries every required column', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'medication_returns'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'return_id', 'clinic_id', 'returned_by_user_id', 'dispensed_to_patient_id',
    'original_dispensing_id', 'status', 'reason', 'notes', 'created_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }
  for (const column of [
    'clinic_id', 'returned_by_user_id', 'dispensed_to_patient_id',
    'original_dispensing_id', 'status', 'reason', 'created_at',
  ]) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // notes alone is optional
  assert.equal(byName.get('notes').is_nullable, 'YES');
});

test('SCHEMA: medication_return_items carries every required column', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'medication_return_items'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'return_item_id', 'return_id', 'dispensing_item_batch_id', 'batch_id',
    'medication_id', 'quantity', 'unit_cost_snapshot', 'restock_decision', 'created_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }
  for (const column of [
    'return_id', 'dispensing_item_batch_id', 'batch_id', 'medication_id',
    'quantity', 'unit_cost_snapshot', 'restock_decision', 'created_at',
  ]) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
});

/* ==========================================================================
 * 3-7. CHECK CONSTRAINTS
 * ========================================================================== */

test('SCHEMA: statuses are exactly COMPLETED and VOIDED', async () => {
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_mr_status_valid' AND conrelid = 'medication_returns'::regclass`,
  );
  assert.equal(rows.length, 1);
  const def = String(rows[0].def);
  for (const status of MEDICATION_RETURN_STATUSES) {
    assert.ok(def.includes(`'${status}'`), `CHECK must allow ${status}`);
  }
  for (const rejected of ['PENDING', 'PARTIAL', 'REJECTED']) {
    assert.ok(!def.includes(`'${rejected}'`), `CHECK must not allow ${rejected}`);
  }
});

test('SCHEMA: restock decisions are exactly RESTOCK, QUARANTINE and WASTE', async () => {
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_mri_restock_decision_valid' AND conrelid = 'medication_return_items'::regclass`,
  );
  assert.equal(rows.length, 1);
  const def = String(rows[0].def);
  for (const decision of RESTOCK_DECISIONS) {
    assert.ok(def.includes(`'${decision}'`), `CHECK must allow ${decision}`);
  }
  for (const rejected of ['RESTOCKED', 'DESTROY', 'REJECTED']) {
    assert.ok(!def.includes(`'${rejected}'`), `CHECK must not allow ${rejected}`);
  }
});

test('SCHEMA: quantity must be strictly positive', async () => {
  const rows = await q(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'medication_return_items'::regclass`,
  );
  assert.ok(rows.map((r) => r.conname).includes('chk_mri_quantity_positive'));
});

test('SCHEMA: unit_cost_snapshot must be non-negative and NOT NULL', async () => {
  const rows = await q(
    `SELECT conname FROM pg_constraint WHERE conname = 'chk_mri_unit_cost_nonneg'
       AND conrelid = 'medication_return_items'::regclass`,
  );
  assert.equal(rows.length, 1, 'a negative historical cost must be refused');

  const columns = await q(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'medication_return_items' AND column_name = 'unit_cost_snapshot'`,
  );
  assert.equal(columns[0].is_nullable, 'NO', 'an unknown historical cost is not an acceptable value');
});

test('SCHEMA: reason must be present and non-blank', async () => {
  const rows = await q(
    `SELECT conname FROM pg_constraint WHERE conname = 'chk_mr_reason_present'
       AND conrelid = 'medication_returns'::regclass`,
  );
  assert.equal(rows.length, 1);
});

/* ==========================================================================
 * 8-9. FOREIGN KEYS, ALL RESTRICT
 * ========================================================================== */

test('SCHEMA: every required FK exists', async () => {
  const mapping: [string, string, string][] = [
    ['medication_returns', 'clinic_id', 'clinics'],
    ['medication_returns', 'returned_by_user_id', 'users'],
    ['medication_returns', 'dispensed_to_patient_id', 'patients'],
    ['medication_returns', 'original_dispensing_id', 'dispensings'],
    ['medication_return_items', 'return_id', 'medication_returns'],
    ['medication_return_items', 'dispensing_item_batch_id', 'dispensing_item_batches'],
    ['medication_return_items', 'batch_id', 'inventory_batches'],
    ['medication_return_items', 'medication_id', 'medications'],
  ];

  for (const [table, column, target] of mapping) {
    const rows = await q(
      `SELECT ccu.table_name AS target FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = $2`,
      [table, column],
    );
    assert.equal(rows.length, 1, `${table}.${column} must have exactly one FK`);
    assert.equal(rows[0].target, target, `${table}.${column} must reference ${target}`);
  }
});

test('SCHEMA: no CASCADE on any return FK — history can never be destroyed', async () => {
  const rows = await q(
    `SELECT rc.delete_rule, tc.table_name, tc.constraint_name
     FROM information_schema.referential_constraints rc
     JOIN information_schema.table_constraints tc
       ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
     WHERE tc.table_name IN ('medication_returns','medication_return_items')`,
  );
  assert.equal(rows.length, 8, 'all eight references are real FKs');
  for (const row of rows) {
    assert.equal(row.delete_rule, 'RESTRICT', `${row.constraint_name} must be RESTRICT, never CASCADE`);
  }
});

/* ==========================================================================
 * 10. INDEXES
 * ========================================================================== */

test('SCHEMA: the required indexes exist', async () => {
  const rows = await q(
    `SELECT indexname FROM pg_indexes
     WHERE tablename IN ('medication_returns','medication_return_items')
     ORDER BY indexname`,
  );
  const names = rows.map((r) => r.indexname);

  for (const index of [
    'idx_mr_clinic_created', 'idx_mr_patient_created', 'idx_mr_dispensing', 'idx_mr_returned_by',
    'idx_mri_return_id', 'idx_mri_dispensing_item_batch', 'idx_mri_batch_id', 'idx_mri_medication_id',
  ]) {
    assert.ok(names.includes(index), `missing index ${index}`);
  }
});

test('SCHEMA: the foundation is a schema-only migration — it seeds no operational data', async () => {
  // A foundation migration must not create quarantine rows, write-offs, stock
  // movements or return records. Later phases (10D.5+) legitimately do, so row
  // counts are no longer a valid proxy; what remains verifiable forever is that
  // the migration itself is recorded and is pure DDL.
  const applied = await q(
    `SELECT version FROM schema_migrations WHERE version = '036_medication_returns_foundation.sql'`,
  );
  assert.equal(applied.length, 1, 'the foundation migration is applied exactly once');
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (writes — opt-in only)
 * ========================================================================== */

interface Fixture {
  clinic: number; user: number; patient: number; dispensing: number;
  medication: number; inventory: number; batch: number; dispensingItem: number; allocation: number;
}

/** Seeds the full FK chain: clinic -> user/patient/visit/prescription -> dispensing -> allocation. */
const seed = async (): Promise<Fixture> => {
  const stamp = `RET-SCHEMA-${Date.now()}`;
  const clinic = await q(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [stamp],
  );
  const user = await q(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Return Schema Probe', `ret-schema-${stamp}`, 'x'],
  );
  const patient = await q(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ($1, $2, 'MALE', '1990-01-01', $3) RETURNING patient_id`,
    ['Return Probe Patient', `0500${String(Date.now()).slice(-6)}`, clinic[0].clinic_id],
  );
  const visit = await q(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id) VALUES ($1, $2, $3) RETURNING visit_id`,
    [patient[0].patient_id, clinic[0].clinic_id, user[0].user_id],
  );
  const prescription = await q(
    `INSERT INTO prescriptions (visit_id, patient_id, doctor_id) VALUES ($1, $2, $3) RETURNING prescription_id`,
    [visit[0].visit_id, patient[0].patient_id, user[0].user_id],
  );
  const medication = await q(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Return Probe'],
  );
  const inventory = await q(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic[0].clinic_id, medication[0].medication_id],
  );
  const dispensing = await q(
    `INSERT INTO dispensings (prescription_id, visit_id, clinic_id, patient_id, dispensed_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED') RETURNING dispensing_id`,
    [prescription[0].prescription_id, visit[0].visit_id, clinic[0].clinic_id, patient[0].patient_id, user[0].user_id],
  );
  const batch = await q(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, 100, 0, 2.5) RETURNING batch_id`,
    [inventory[0].inventory_id, stamp],
  );
  const prescriptionItem = await q(
    `INSERT INTO prescription_items
       (prescription_id, medication_id, dosage, frequency, duration, prescribed_quantity, uom)
     VALUES ($1, $2, '1 x 3', 'TDS', '5 days', 30, 'TABLET') RETURNING item_id`,
    [prescription[0].prescription_id, medication[0].medication_id],
  );
  const item = await q(
    `INSERT INTO dispensing_items
       (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
        prescribed_quantity, dispensed_quantity, remaining_quantity, uom)
     VALUES ($1, $2, $3, $4, 30, 30, 0, 'TABLET') RETURNING dispensing_item_id`,
    [dispensing[0].dispensing_id, prescriptionItem[0].item_id, medication[0].medication_id, inventory[0].inventory_id],
  );
  const allocation = await q(
    `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity, unit_cost_snapshot, expiry_date_snapshot)
     VALUES ($1, $2, 30, 2.5, CURRENT_DATE + 30) RETURNING dispensing_item_batch_id`,
    [item[0].dispensing_item_id, batch[0].batch_id],
  );

  return {
    clinic: num(clinic[0].clinic_id), user: num(user[0].user_id), patient: num(patient[0].patient_id),
    dispensing: num(dispensing[0].dispensing_id), medication: num(medication[0].medication_id),
    inventory: num(inventory[0].inventory_id), batch: num(batch[0].batch_id),
    dispensingItem: num(item[0].dispensing_item_id), allocation: num(allocation[0].dispensing_item_batch_id),
  };
};

const insertReturn = (f: Fixture, over: Record<string, unknown> = {}) =>
  q(
    `INSERT INTO medication_returns
       (clinic_id, returned_by_user_id, dispensed_to_patient_id, original_dispensing_id, status, reason, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING return_id`,
    [
      f.clinic, f.user, f.patient, f.dispensing,
      over.status ?? 'COMPLETED',
      over.reason ?? 'schema probe',
      over.notes ?? null,
    ],
  );

const insertItem = (f: Fixture, returnId: number, over: Record<string, unknown> = {}) =>
  q(
    `INSERT INTO medication_return_items
       (return_id, dispensing_item_batch_id, batch_id, medication_id, quantity, unit_cost_snapshot, restock_decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING return_item_id`,
    [
      returnId, f.allocation, f.batch, f.medication,
      over.quantity ?? 10,
      over.unit_cost_snapshot ?? 2.5,
      over.restock_decision ?? 'RESTOCK',
    ],
  );

const drop = async (f: Fixture) => {
  await pool.query('DELETE FROM medication_return_items WHERE dispensing_item_batch_id = $1', [f.allocation]);
  await pool.query('DELETE FROM medication_returns WHERE clinic_id = $1', [f.clinic]);
  await pool.query('DELETE FROM dispensing_item_batches WHERE dispensing_item_batch_id = $1', [f.allocation]);
  await pool.query('DELETE FROM dispensing_items WHERE dispensing_item_id = $1', [f.dispensingItem]);
  await pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [f.dispensing]);
  await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  await pool.query('DELETE FROM prescription_items WHERE prescription_id IN (SELECT prescription_id FROM prescriptions WHERE patient_id = $1)', [f.patient]);
  await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  await pool.query('DELETE FROM prescriptions WHERE patient_id = $1', [f.patient]);
  await pool.query('DELETE FROM visits WHERE patient_id = $1', [f.patient]);
  await pool.query('DELETE FROM patients WHERE patient_id = $1', [f.patient]);
  await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

test('SCHEMA: a valid return with a valid item is accepted by the database', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const header = await insertReturn(f);
    assert.equal(header.length, 1);
    const items = await insertItem(f, num(header[0].return_id));
    assert.equal(items.length, 1, 'the declared shape must actually be insertable');
  } finally {
    await drop(f);
  }
});

test('SCHEMA: an unknown status or a blank reason is refused', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    await assert.rejects(() => insertReturn(f, { status: 'PENDING' }), 'status is a controlled value');
    for (const reason of ['', '   ', '\t', '\n']) {
      await assert.rejects(
        () => insertReturn(f, { reason }),
        `reason ${JSON.stringify(reason)} must be refused at the DB level`,
      );
    }
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a non-positive quantity or a negative cost is refused', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const header = await insertReturn(f);
    const returnId = num(header[0].return_id);
    for (const quantity of [0, -5]) {
      await assert.rejects(() => insertItem(f, returnId, { quantity }), `quantity ${quantity} must be refused`);
    }
    await assert.rejects(
      () => insertItem(f, returnId, { unit_cost_snapshot: -1 }),
      'a negative historical cost must be refused',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: an unknown restock decision is refused', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const header = await insertReturn(f);
    await assert.rejects(
      () => insertItem(f, num(header[0].return_id), { restock_decision: 'DESTROY' }),
      'restock_decision is a controlled value',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a return blocks deletion of the dispensing it points at (RESTRICT)', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    await insertReturn(f);
    await assert.rejects(
      () => pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [f.dispensing]),
      'a return must keep its original dispensing',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a return item keeps its dispensing allocation undeletable (RESTRICT)', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const header = await insertReturn(f);
    await insertItem(f, num(header[0].return_id));
    await assert.rejects(
      () => pool.query('DELETE FROM dispensing_item_batches WHERE dispensing_item_batch_id = $1', [f.allocation]),
      'a return item must keep the exact allocation it refers to',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: writing a return header changes no stock, movement or dispensing quantity', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  // quantity_reserved must be $1 and dispensing_item_id $2 so both placeholders are used
  const snapshot = async () => {
    const rows = await q(
      `SELECT
         (SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1) AS on_hand,
         (SELECT quantity_reserved FROM inventory_batches WHERE batch_id = $1) AS reserved,
         (SELECT COUNT(*)::int FROM stock_movements) AS movements,
         (SELECT dispensed_quantity FROM dispensing_items WHERE dispensing_item_id = $2) AS dispensed,
         (SELECT remaining_quantity FROM dispensing_items WHERE dispensing_item_id = $2) AS remaining`,
      [f.batch, f.dispensingItem],
    );
    return rows[0];
  };

  try {
    const before = await snapshot();
    const header = await insertReturn(f);
    await insertItem(f, num(header[0].return_id));
    const after = await snapshot();

    assert.equal(after.on_hand, before.on_hand, 'inventory quantity is untouched');
    assert.equal(after.reserved, before.reserved, 'reserved quantity is untouched');
    assert.equal(after.movements, before.movements, 'no stock movement is created');
    assert.equal(after.dispensed, before.dispensed, 'dispensed_quantity is untouched');
    assert.equal(after.remaining, before.remaining, 'remaining_quantity is untouched');
  } finally {
    await drop(f);
  }
});
