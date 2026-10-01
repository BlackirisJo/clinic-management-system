import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10D.6 — Applied-schema verification for stock_counts / stock_count_lines
 *
 * Catalog assertions are read-only (same convention as the 10D.2/10D.4 schema
 * tests). The constraint-behaviour assertions must actually insert rows, so
 * they are gated behind the same opt-in flag as the rest of the inventory
 * concurrency suite and never touch a developer's database implicitly:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

const num = (value: unknown): number => Number(value);

/* ==========================================================================
 * CATALOG (read-only)
 * ======================================================================== */

/** 1. tables + columns */
test('SCHEMA: stock_counts exists with the count-session columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type, is_identity, identity_generation
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_counts'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'count_id', 'clinic_id', 'status', 'counted_by_user_id',
    'approved_by_user_id', 'notes', 'created_at', 'finalised_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }

  // count_id must be an ALWAYS IDENTITY primary key: no sequence default can be
  // overridden by an explicit id, so a count id can never be forged or reused
  assert.equal(byName.get('count_id').is_identity, 'YES', 'count_id must be an identity column');
  assert.equal(byName.get('count_id').identity_generation, 'ALWAYS');

  for (const column of ['clinic_id', 'status', 'counted_by_user_id', 'created_at']) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // optional by design: nobody approves a count in 10D.6 and nobody finalises it yet
  for (const column of ['approved_by_user_id', 'notes', 'finalised_at']) {
    assert.equal(byName.get(column).is_nullable, 'YES', `${column} must be nullable`);
  }
});

test('SCHEMA: stock_count_lines exists with the snapshot columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_count_lines'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'count_line_id', 'count_id', 'batch_id', 'medication_id',
    'system_quantity', 'counted_quantity', 'variance',
    'system_quantity_at_finalisation', 'adjusted_quantity', 'created_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }

  for (const column of [
    'count_id', 'batch_id', 'medication_id', 'system_quantity',
    'counted_quantity', 'variance', 'created_at',
  ]) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // 10D.7 columns: declared, never populated by this phase
  for (const column of ['system_quantity_at_finalisation', 'adjusted_quantity']) {
    assert.equal(byName.get(column).is_nullable, 'YES', `${column} must stay nullable`);
  }

  // every quantity is NUMERIC(12,3): exact decimal, never a float
  for (const column of [
    'system_quantity', 'counted_quantity', 'variance',
    'system_quantity_at_finalisation', 'adjusted_quantity',
  ]) {
    assert.equal(byName.get(column).data_type, 'numeric', `${column} must be numeric`);
    assert.equal(num(byName.get(column).numeric_precision), 12);
    assert.equal(num(byName.get(column).numeric_scale), 3);
  }
});

/** 2-3. status + finalised_at consistency constraints exist */
test('SCHEMA: the status / finalised_at constraints exist', async () => {
  const rows = await q(`SELECT conname, pg_get_constraintdef(oid) AS def
                        FROM pg_constraint WHERE conrelid = 'stock_counts'::regclass`);
  const byName = new Map(rows.map((r) => [r.conname, String(r.def)]));

  assert.ok(byName.has('chk_sc_status_valid'), 'status is a controlled value');
  const statusDef = byName.get('chk_sc_status_valid')!;
  for (const status of ['OPEN', 'FINALISED', 'CANCELLED']) {
    assert.ok(statusDef.includes(`'${status}'`), `CHECK must allow ${status}`);
  }

  assert.ok(byName.has('chk_sc_finalised_consistent'), 'finalised_at must agree with status');
  const finalDef = byName.get('chk_sc_finalised_consistent')!;
  assert.match(finalDef, /finalised_at IS NOT NULL/);
  assert.match(finalDef, /finalised_at IS NULL/);
});

/** 5-6. line constraints: non-negative + the exact variance identity + uniqueness */
test('SCHEMA: the line constraints prove the variance formula and uniqueness', async () => {
  const rows = await q(`SELECT conname, pg_get_constraintdef(oid) AS def, contype
                        FROM pg_constraint WHERE conrelid = 'stock_count_lines'::regclass`);
  const byName = new Map(rows.map((r) => [r.conname, String(r.def)]));

  assert.ok(byName.has('chk_scl_system_nonneg'), 'the system snapshot can never be negative');
  assert.ok(byName.has('chk_scl_counted_nonneg'), 'a counted quantity can never be negative');
  assert.ok(byName.has('chk_scl_system_at_finalisation_nonneg'));
  assert.ok(byName.has('chk_scl_adjusted_nonneg'));

  assert.ok(
    byName.has('chk_scl_variance_consistent'),
    'the stored variance must be provably the counted minus the system quantity',
  );
  const varianceDef = byName.get('chk_scl_variance_consistent')!
    .replace(/\s+/g, ' ')
    .replace(/[()]/g, '');
  assert.match(
    varianceDef,
    /variance = counted_quantity - system_quantity/,
    'the CHECK must state the exact arithmetic identity',
  );

  // UNIQUE(count_id, batch_id) — a batch is counted once per count
  const unique = rows.filter((r) => r.contype === 'u');
  assert.equal(unique.length, 1, 'exactly one table-level unique constraint');
  assert.equal(unique[0].conname, 'uq_scl_count_batch');
  const uniqueDef = byName.get('uq_scl_count_batch')!.replace(/\s+/g, ' ');
  assert.match(uniqueDef, /UNIQUE \(count_id, batch_id\)/);
});

/** 7-8. every FK exists and nothing CASCADEs */
test('SCHEMA: every reference is a real FK and no FK cascades', async () => {
  const expected = [
    { table: 'stock_counts', target: 'clinics', columns: ['clinic_id'] },
    { table: 'stock_counts', target: 'users', columns: ['counted_by_user_id'] },
    { table: 'stock_counts', target: 'users', columns: ['approved_by_user_id'] },
    { table: 'stock_count_lines', target: 'stock_counts', columns: ['count_id'] },
    { table: 'stock_count_lines', target: 'inventory_batches', columns: ['batch_id'] },
    { table: 'stock_count_lines', target: 'medications', columns: ['medication_id'] },
  ];

  for (const link of expected) {
    for (const column of link.columns) {
      // pg_constraint is the authoritative catalog: information_schema's
      // constraint_column_usage is ambiguous when one table references the same
      // target twice (users is referenced twice on stock_counts).
      const rows = await q(
        `SELECT c.conname AS constraint_name,
                rc.delete_rule,
                ccu.relname AS target,
                pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_class ccu ON ccu.oid = c.confrelid
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = c.conname AND rc.constraint_schema = 'public'
         WHERE t.relname = $1 AND c.contype = 'f' AND ccu.relname = $2
           AND pg_get_constraintdef(c.oid) LIKE '%' || $3 || '%'`,
        [link.table, link.target, column],
      );
      const exact = rows.filter((r) =>
        new RegExp(`\\b${column}\\b`).test(String(r.def)) && String(r.target) === link.target,
      );
      assert.equal(exact.length, 1, `${link.table}.${column} must be a real FK on ${link.target}`);
      assert.equal(
        exact[0].delete_rule,
        'RESTRICT',
        `${link.table}.${column} must be RESTRICT, never CASCADE`,
      );
    }
  }

  // and the reverse direction: not one of these tables cascades into anything
  for (const table of ['stock_counts', 'stock_count_lines']) {
    const rows = await q(
      `SELECT rc.delete_rule, c.conname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = c.conname AND rc.constraint_schema = 'public'
       WHERE t.relname = $1 AND c.contype = 'f'`,
      [table],
    );
    assert.ok(rows.length > 0, `${table} must declare its references`);
    for (const row of rows) {
      assert.equal(row.delete_rule, 'RESTRICT', `${table}.${row.conname} must never CASCADE`);
    }
  }
});

/** index requirements */
test('SCHEMA: the count lookup indexes exist', async () => {
  const rows = await q(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'stock_counts' ORDER BY indexname`,
  );
  const names = rows.map((r) => r.indexname);
  assert.ok(names.includes('idx_sc_clinic_created'), 'clinic + created_at');
  assert.ok(names.includes('idx_sc_status_created'), 'status + created_at');
  assert.ok(names.includes('idx_sc_counted_by'), 'counted_by user');
  assert.ok(names.includes('idx_sc_approved_by'), 'approved_by user');

  const lineIndexes = await q(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'stock_count_lines' ORDER BY indexname`,
  );
  assert.ok(lineIndexes.map((r) => r.indexname).includes('idx_scl_count_id'));
});

test('SCHEMA: the migration is recorded exactly once and no new movement type exists', async () => {
  const applied = await q(
    `SELECT version FROM schema_migrations WHERE version = '037_stock_counts_foundation.sql'`,
  );
  assert.equal(applied.length, 1, 'the 10D.6 migration must be applied');

  // A stock count is not a stock movement: the vocabulary must be untouched
  const rows = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_movement_type_valid' AND conrelid = 'stock_movements'::regclass`,
  );
  const def = String(rows[0].def);
  assert.doesNotMatch(def, /COUNT/i, 'no COUNT movement type may be introduced');
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (writes — opt-in only)
 * ======================================================================== */

interface Fixture { clinic: number; user: number; medication: number; inventory: number; batch: number }

const NOTHING_SEEDED: Fixture = { clinic: 0, user: 0, medication: 0, inventory: 0, batch: 0 };

const seed = async (): Promise<Fixture> => {
  const stamp = `COUNT-SCHEMA-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [stamp],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Count Probe', `count-schema-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Count Probe'],
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
    `INSERT INTO stock_counts (clinic_id, status, counted_by_user_id, approved_by_user_id, notes, finalised_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING count_id`,
    [
      f.clinic,
      over.status ?? 'OPEN',
      f.user,
      over.approved_by_user_id ?? null,
      over.notes ?? null,
      over.finalised_at ?? null,
    ],
  );

const insertLine = (f: Fixture, countId: number, over: Record<string, unknown> = {}) =>
  q(
    `INSERT INTO stock_count_lines
       (count_id, batch_id, medication_id, system_quantity, counted_quantity, variance)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING count_line_id`,
    [
      countId,
      over.batch_id ?? f.batch,
      f.medication,
      over.system_quantity ?? 100,
      over.counted_quantity ?? 90,
      over.variance ?? num(over.counted_quantity ?? 90) - num(over.system_quantity ?? 100),
    ],
  );

/** RESTRICT يتطلّب هذا الترتيب: البنود ثم الرأس ثم الدفعة ثم الصنف ثم الدواء ثم المستخدم ثم العيادة */
const drop = async (f: Fixture) => {
  if (f.batch) {
    await pool.query(
      `DELETE FROM audit_logs WHERE resource_type = 'STOCK_COUNT'
         AND resource_id IN (SELECT count_id::text FROM stock_counts WHERE clinic_id = $1)`,
      [f.clinic],
    );
    await pool.query('DELETE FROM stock_count_lines WHERE batch_id = $1', [f.batch]);
    await pool.query('DELETE FROM stock_counts WHERE clinic_id = $1', [f.clinic]);
    await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  }
  if (f.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.user) await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

test('SCHEMA: a plain OPEN count and a zero-counted line are both accepted', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f);
    // "the shelf is empty" is a real answer, and it must be insertable
    const [line] = await insertLine(f, num(count.count_id), { system_quantity: 100, counted_quantity: 0 });
    assert.ok(line.count_line_id);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: an unknown status is refused by the database itself', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    await assert.rejects(() => insertCount(f, { status: 'APPROVED' }), 'status is a controlled value');
  } finally {
    await drop(f);
  }
});

test('SCHEMA: finalised_at must agree with status in both directions', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    // a FINALISED count with no timestamp is a lie about being finished
    await assert.rejects(() => insertCount(f, { status: 'FINALISED', finalised_at: null }));
    // an OPEN or CANCELLED count must carry no finished-at timestamp
    await assert.rejects(() => insertCount(f, { status: 'OPEN', finalised_at: new Date() }));
    await assert.rejects(() => insertCount(f, { status: 'CANCELLED', finalised_at: new Date() }));
    // and the one consistent pair is accepted
    const rows = await insertCount(f, { status: 'FINALISED', finalised_at: new Date() });
    assert.equal(rows.length, 1);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a negative counted or system quantity is refused', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f);
    const countId = num(count.count_id);
    await assert.rejects(
      () => insertLine(f, countId, { system_quantity: 100, counted_quantity: -1, variance: -101 }),
      'a counted quantity can never be negative',
    );
    await assert.rejects(
      () => insertLine(f, countId, { system_quantity: -5, counted_quantity: 0, variance: 5 }),
      'a snapshot can never be negative',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: a variance that disagrees with its inputs is refused', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f);
    const countId = num(count.count_id);
    // counted 90 against system 100 is -10, never +10 and never 0
    await assert.rejects(() => insertLine(f, countId, { system_quantity: 100, counted_quantity: 90, variance: 10 }));
    await assert.rejects(() => insertLine(f, countId, { system_quantity: 100, counted_quantity: 90, variance: 0 }));
    // the exact identity is accepted
    const rows = await insertLine(f, countId, { system_quantity: 100, counted_quantity: 90, variance: -10 });
    assert.equal(rows.length, 1);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: the same batch cannot be counted twice in one count', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f);
    const countId = num(count.count_id);
    await insertLine(f, countId);
    await assert.rejects(() => insertLine(f, countId), 'uq_scl_count_batch must refuse the second line');

    // but a different count may count the same batch
    const [other] = await insertCount(f);
    const rows = await insertLine(f, num(other.count_id));
    assert.equal(rows.length, 1);
  } finally {
    await drop(f);
  }
});

test('SCHEMA: counted history is protected — no CASCADE lets a batch or count be deleted', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f);
    const countId = num(count.count_id);
    await insertLine(f, countId);

    await assert.rejects(
      () => pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]),
      'counted history must block a batch delete',
    );
    await assert.rejects(
      () => pool.query('DELETE FROM stock_counts WHERE count_id = $1', [countId]),
      'counted history must block a count delete',
    );
    await assert.rejects(
      () => pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]),
      'counting history must block a clinic delete',
    );
  } finally {
    await drop(f);
  }
});

test('SCHEMA: 10D.6 declares the finalisation columns but writes no value into them', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await seed();
  try {
    const [count] = await insertCount(f);
    const [line] = await insertLine(f, num(count.count_id));
    const rows = await q(
      `SELECT system_quantity_at_finalisation, adjusted_quantity FROM stock_count_lines WHERE count_line_id = $1`,
      [line.count_line_id],
    );
    assert.equal(rows[0].system_quantity_at_finalisation, null, 'finalisation snapshot belongs to 10D.7');
    assert.equal(rows[0].adjusted_quantity, null, 'adjusted quantity belongs to 10D.7');
  } finally {
    await drop(f);
  }
});

void NOTHING_SEEDED;
