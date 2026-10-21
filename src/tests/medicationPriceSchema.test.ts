import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10E.2 — Applied-schema verification for medication_prices
 *
 * Catalog assertions are read-only (same convention as the 10D schema tests).
 * The constraint-behaviour assertions must insert rows, so they are gated
 * behind an opt-in flag and never touch a developer's database implicitly:
 *   MEDICATION_PRICE_SCHEMA_TEST=1
 * ========================================================================== */

const enabled = process.env.MEDICATION_PRICE_SCHEMA_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

/* ==========================================================================
 * CATALOG (read-only)
 * ========================================================================== */

test('SCHEMA: medication_prices exists with the clinic-scoped pricing columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'medication_prices'
     ORDER BY ordinal_position`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'price_id', 'clinic_id', 'inventory_id', 'unit_price', 'is_active',
    'effective_from', 'effective_to', 'created_by_user_id', 'created_at',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
  }

  // WHO / WHICH / WHERE / HOW MUCH / WHEN must all be mandatory
  for (const column of [
    'clinic_id', 'inventory_id', 'unit_price', 'is_active', 'effective_from', 'created_by_user_id',
  ]) {
    assert.equal(byName.get(column).is_nullable, 'NO', `${column} must be NOT NULL`);
  }
  // effective_to is the only optional business column: it is set on deactivation
  assert.equal(byName.get('effective_to').is_nullable, 'YES');
});

test('SCHEMA: the price is NUMERIC(10,2), not a float or a wider precision', async () => {
  const rows = await q(
    `SELECT data_type, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'medication_prices'
       AND column_name = 'unit_price'`,
  );
  assert.equal(rows[0].data_type, 'numeric');
  assert.equal(Number(rows[0].numeric_precision), 10);
  assert.equal(Number(rows[0].numeric_scale), 2, 'two decimal places, matching invoice_items.price');
});

test('SCHEMA: the pricing constraints exist', async () => {
  const rows = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'medication_prices'::regclass`);
  const names = rows.map((r) => r.conname);

  assert.ok(names.includes('chk_mp_unit_price_nonneg'), 'a price is never negative');
  assert.ok(names.includes('chk_mp_effective_consistent'), 'active ⟺ effective_to IS NULL');
});

test('SCHEMA: at most one active price per inventory item is enforced by a partial unique index', async () => {
  const rows = await q(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'medication_prices'`,
  );
  const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

  const partial = byName.get('uq_medication_prices_inventory_active');
  assert.ok(partial, 'the one-active-price-per-item index exists');
  assert.match(partial!, /UNIQUE/i);
  assert.match(partial!, /inventory_id/);
  assert.match(partial!, /WHERE is_active/, 'only active rows are constrained');

  assert.ok(byName.has('idx_medication_prices_inventory_history'), 'price history is queryable');
});

test('SCHEMA: pricing is linked to inventory_items, not to the global medication catalog', async () => {
  const rows = await q(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = 'medication_prices'
          AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'clinic_id')::int AS clinic_fks,
       (SELECT COUNT(*) FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = 'medication_prices'
          AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'inventory_id')::int AS inventory_fks,
       (SELECT COUNT(*) FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = 'medication_prices'
          AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'medication_id')::int AS medication_fks`,
  );

  assert.equal(Number(rows[0].clinic_fks), 1, 'the price is clinic-scoped');
  assert.equal(Number(rows[0].inventory_fks), 1, 'the price hangs off an inventory item');
  assert.equal(Number(rows[0].medication_fks), 0, 'no direct medication FK — the bridge is inventory_items');
});

test('SCHEMA: pricing never touched the invoices table', async () => {
  // 10E.2 kept itself out of billing entirely. 10E.4 later added the
  // medication references to invoice_items, so only `invoices` is asserted
  // here to be free of any pricing or medication column.
  const invoices = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices'`,
  );
  const names = invoices.map((r) => r.column_name);

  assert.ok(!names.some((n) => /medication|price|dispensing/.test(n)),
    '10E.2 added no medication or price column to invoices');
  assert.ok(names.includes('patient_id'), 'the existing invoice shape is intact');
});

test('SCHEMA: Phase 10E.3 added the selling-price snapshot on dispensing_items', async () => {
  // 10E.2 deliberately stopped short of the snapshot; 10E.3 is where it landed.
  const dispensingItems = await q(
    `SELECT column_name, is_nullable, data_type, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dispensing_items'
       AND column_name = 'unit_price_snapshot'`,
  );

  assert.equal(dispensingItems.length, 1, 'dispensing_items.unit_price_snapshot exists');
  const column = dispensingItems[0];
  assert.equal(column.is_nullable, 'YES', 'pre-10E.3 rows stay valid without a snapshot');
  assert.equal(column.data_type, 'numeric');
  assert.equal(Number(column.numeric_precision), 10);
  assert.equal(Number(column.numeric_scale), 2, 'matches medication_prices and invoice_items exactly');

  const dispensingBatches = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dispensing_item_batches'`,
  );
  const batchNames = dispensingBatches.map((r) => r.column_name);
  assert.ok(
    !batchNames.includes('unit_price_snapshot'),
    'the selling price stays at dispensing-item level, never duplicated per batch',
  );

  const constraints = await q(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'dispensing_items'::regclass`,
  );
  assert.ok(
    constraints.map((r) => r.conname).includes('chk_di_unit_price_nonneg'),
    'a frozen selling price is never negative',
  );
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (opt-in; inserts rows)
 * ========================================================================== */

test('CONSTRAINTS: a negative price is refused, and zero is accepted', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_PRICE_SCHEMA_TEST=1 to run');

  const inventory = await q(
    `SELECT inventory_id, clinic_id FROM inventory_items WHERE deleted_at IS NULL LIMIT 1`,
  );
  if (inventory.length === 0) return t.skip('no inventory item available');
  const { inventory_id, clinic_id } = inventory[0];

  let rejected = false;
  try {
    await pool.query(
      `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
       VALUES ($1, $2, -1.00, (SELECT MIN(user_id) FROM users))`,
      [clinic_id, inventory_id],
    );
  } catch (error: any) {
    rejected = error?.code === '23514';
  }
  assert.ok(rejected, 'a negative price violates chk_mp_unit_price_nonneg');

  const zero = await pool.query(
    `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
     VALUES ($1, $2, 0.00, (SELECT MIN(user_id) FROM users))
     RETURNING price_id, unit_price`,
    [clinic_id, inventory_id],
  );
  assert.equal(Number(zero.rows[0].unit_price), 0, 'zero is a valid price');
  await pool.query('DELETE FROM medication_prices WHERE price_id = $1', [zero.rows[0].price_id]);
});

test('CONSTRAINTS: the one-active-price rule rejects a second active row', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_PRICE_SCHEMA_TEST=1 to run');

  const inventory = await q(
    `SELECT inventory_id, clinic_id FROM inventory_items WHERE deleted_at IS NULL LIMIT 1`,
  );
  if (inventory.length === 0) return t.skip('no inventory item available');
  const { inventory_id, clinic_id } = inventory[0];

  await pool.query(
    `UPDATE medication_prices SET is_active = FALSE, effective_to = NOW()
     WHERE inventory_id = $1 AND is_active`,
    [inventory_id],
  );

  const client = await pool.connect();
  const created: number[] = [];
  try {
    await client.query('BEGIN');
    for (const price of ['4.00', '5.00']) {
      const inserted = await client.query(
        `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
         VALUES ($1, $2, $3, (SELECT MIN(user_id) FROM users))
         RETURNING price_id`,
        [clinic_id, inventory_id, price],
      );
      created.push(inserted.rows[0].price_id);
    }
    await client.query('COMMIT');
    assert.fail('two active prices for one item must not commit');
  } catch (error: any) {
    await client.query('ROLLBACK');
    assert.equal(error?.code, '23505', 'the partial unique index rejects the second active price');
  } finally {
    client.release();
  }

  // A closed row is always insertable again: history accumulates without limit
  const reopened = await pool.query(
    `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
     VALUES ($1, $2, 6.00, (SELECT MIN(user_id) FROM users))
     RETURNING price_id`,
    [clinic_id, inventory_id],
  );
  assert.ok(Number(reopened.rows[0].price_id) > 0, 'a new price can follow a closed one');

  for (const priceId of [...created, reopened.rows[0].price_id]) {
    await pool.query('DELETE FROM medication_prices WHERE price_id = $1', [priceId]);
  }
});

test('CONSTRAINTS: an active row may not carry effective_to, and a closed row may not omit it', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_PRICE_SCHEMA_TEST=1 to run');

  const inventory = await q(
    `SELECT inventory_id, clinic_id FROM inventory_items WHERE deleted_at IS NULL LIMIT 1`,
  );
  if (inventory.length === 0) return t.skip('no inventory item available');
  const { inventory_id, clinic_id } = inventory[0];

  // chk_mp_effective_consistent forbids exactly two shapes:
  //   active + a closing time, and inactive without one.
  let activeWithClose: string | undefined;
  try {
    await pool.query(
      `INSERT INTO medication_prices
         (clinic_id, inventory_id, unit_price, is_active, effective_from, effective_to, created_by_user_id)
       VALUES ($1, $2, 7.00, TRUE, NOW() - INTERVAL '1 day', NOW(), (SELECT MIN(user_id) FROM users))`,
      [clinic_id, inventory_id],
    );
  } catch (error: any) {
    activeWithClose = error?.code;
  }
  assert.equal(activeWithClose, '23514', 'an active row may not carry a closing time');

  let inactiveWithoutClose: string | undefined;
  try {
    await pool.query(
      `INSERT INTO medication_prices
         (clinic_id, inventory_id, unit_price, is_active, effective_from, created_by_user_id)
       VALUES ($1, $2, 7.00, FALSE, NOW() - INTERVAL '1 day', (SELECT MIN(user_id) FROM users))`,
      [clinic_id, inventory_id],
    );
  } catch (error: any) {
    inactiveWithoutClose = error?.code;
  }
  assert.equal(inactiveWithoutClose, '23514', 'a closed row must state when it closed');

  // The two consistent shapes are accepted, so the constraint is not merely always-fail
  const closed = await pool.query(
    `INSERT INTO medication_prices
       (clinic_id, inventory_id, unit_price, is_active, effective_from, effective_to, created_by_user_id)
     VALUES ($1, $2, 7.00, FALSE, NOW() - INTERVAL '1 day', NOW(), (SELECT MIN(user_id) FROM users))
     RETURNING price_id`,
    [clinic_id, inventory_id],
  );
  assert.ok(Number(closed.rows[0].price_id) > 0, 'a closed row with a closing time is valid');
  await pool.query('DELETE FROM medication_prices WHERE price_id = $1', [closed.rows[0].price_id]);

  const live = await pool.query(
    `INSERT INTO medication_prices
       (clinic_id, inventory_id, unit_price, is_active, effective_from, created_by_user_id)
     VALUES ($1, $2, 8.00, TRUE, NOW(), (SELECT MIN(user_id) FROM users))
     RETURNING price_id`,
    [clinic_id, inventory_id],
  );
  assert.ok(Number(live.rows[0].price_id) > 0, 'an active row without a closing time is valid');
  await pool.query('DELETE FROM medication_prices WHERE price_id = $1', [live.rows[0].price_id]);
});