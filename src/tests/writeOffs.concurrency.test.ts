import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createInventoryWriteOff } from '../modules/inventory/writeOffs.controller';

/* ==========================================================================
 * Phase 10D.3 — Concurrency: two real PostgreSQL clients writing off one batch
 *
 * Proves the property the write-off transaction depends on: because the batch
 * is locked with FOR UPDATE (never SKIP LOCKED), two concurrent write-offs on
 * the SAME batch are serialised. The loser re-reads the committed balance
 * instead of driving stock negative or eating the reserved quantity.
 *
 * Gated exactly like the project's other DB-backed concurrency tests so it never
 * runs against a developer's database implicitly. Enable with:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const qtyOf = (value: unknown): number => Number(value);

const adminReq = (body: Record<string, unknown>, userId: number): AuthenticatedRequest =>
  ({
    body, params: {}, query: {},
    user: { userId, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
  } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

/** Runs the real controller against the real pool, so two calls get two real clients. */
const writeOff = async (body: Record<string, unknown>, userId: number) => {
  const { res, captured } = makeRes();
  await createInventoryWriteOff(adminReq(body, userId), res);
  return captured;
};

interface Fixture { clinic: number; medication: number; inventory: number; batch: number; user: number }

/** A fixture with no rows at all — cleanup skips everything it never created. */
const NOTHING_SEEDED: Fixture = { clinic: 0, medication: 0, inventory: 0, batch: 0, user: 0 };

const seed = async (onHand: number, reserved: number, daysToExpiry: number, tag: string): Promise<Fixture> => {
  const stamp = `${tag}-${Date.now()}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`WO-RACE-${stamp}`],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Write-off Race', `wo-race-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [`WO-RACE-${stamp}`, 'Write-off Race'],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  const batch = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + $3::int, $4, $5) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp, daysToExpiry, onHand, reserved],
  );

  return {
    clinic: qtyOf(clinic.rows[0].clinic_id),
    user: qtyOf(user.rows[0].user_id),
    medication: qtyOf(medication.rows[0].medication_id),
    inventory: qtyOf(inventory.rows[0].inventory_id),
    batch: qtyOf(batch.rows[0].batch_id),
  };
};

/** RESTRICT يتطلّب هذا الترتيب تماماً: التدقيق ثم الحركات والرأس ثم الدفعة ثم الصنف ثم الدواء ثم المستخدم ثم العيادة */
const cleanup = async (f: Fixture) => {
  if (f.batch) {
    await pool.query(
      `DELETE FROM audit_logs WHERE resource_type = 'INVENTORY_WRITE_OFF'
         AND resource_id IN (SELECT write_off_id::text FROM inventory_write_offs WHERE batch_id = $1)`,
      [f.batch],
    );
    await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [f.batch]);
    await pool.query('DELETE FROM inventory_write_offs WHERE batch_id = $1', [f.batch]);
    await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  }
  if (f.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.user) await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

const balances = async (batchId: number) => {
  const row = await pool.query(
    'SELECT quantity_on_hand, quantity_reserved FROM inventory_batches WHERE batch_id = $1',
    [batchId],
  );
  return { onHand: qtyOf(row.rows[0].quantity_on_hand), reserved: qtyOf(row.rows[0].quantity_reserved) };
};

test('CONCURRENCY: two concurrent write-offs on one batch cannot drive it negative', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // رصيد 10، وكل كتابة-off تطلب 10: واحدة فقط يمكن أن تنجح
    f = await seed(10, 0, 30, 'WASTE');

    const body = { batch_id: f.batch, quantity: 10, type: 'WASTE', reason: 'CONCURRENCY-RACE' };
    const [first, second] = await Promise.all([writeOff(body, f.user), writeOff(body, f.user)]);

    assert.equal([first, second].filter((r) => r.status === 201).length, 1, 'exactly one write-off may succeed');
    assert.equal([first, second].filter((r) => r.status !== 201).length, 1);
    assert.equal([first, second].find((r) => r.status !== 201)!.status, 409, 'the loser sees the committed balance');

    const after = await balances(f.batch);
    assert.equal(after.onHand, 0, 'stock must end at exactly 0, never negative');
    assert.ok(after.onHand >= 0, 'stock must never go negative');
    assert.equal(after.reserved, 0);

    const headers = await pool.query('SELECT COUNT(*)::int AS n FROM inventory_write_offs WHERE batch_id = $1', [f.batch]);
    const movements = await pool.query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE batch_id = $1', [f.batch]);
    assert.equal(headers.rows[0].n, 1, 'exactly one write-off header survives');
    assert.equal(movements.rows[0].n, 1, 'exactly one movement survives');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: concurrent write-offs can never eat the reserved quantity', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // رصيد 100، محجوز 80 -> المتاح 20، وكل طلب 15 (إجمالي 30 > 20)
    f = await seed(100, 80, 30, 'RES');

    const body = { batch_id: f.batch, quantity: 15, type: 'WASTE', reason: 'CONCURRENCY-RESERVED' };
    const results = await Promise.all([writeOff(body, f.user), writeOff(body, f.user)]);

    const succeeded = results.filter((r) => r.status === 201);
    assert.equal(succeeded.length, 1, 'only the first attempt fits into the 20 available');
    assert.equal(results.find((r) => r.status !== 201)!.status, 409);

    const after = await balances(f.batch);
    assert.equal(after.onHand, 85, '100 - 15 exactly once');
    assert.equal(after.reserved, 80, 'quantity_reserved is never written');
    assert.ok(after.onHand >= after.reserved, 'chk_batch_qty_reserved_le_on_hand still holds');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: two concurrent EXPIRE calls on an expired batch leave exactly one history row', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // منتهية فعلاً: CURRENT_DATE - 5
    f = await seed(20, 0, -5, 'EXPIRE');

    const body = { batch_id: f.batch, quantity: 20, type: 'EXPIRE', reason: 'CONCURRENCY-EXPIRED' };
    const [first, second] = await Promise.all([writeOff(body, f.user), writeOff(body, f.user)]);

    assert.equal([first, second].filter((r) => r.status === 201).length, 1);
    const after = await balances(f.batch);
    assert.equal(after.onHand, 0, 'the batch is written off exactly once');

    const rows = await pool.query(
      'SELECT type, quantity FROM inventory_write_offs WHERE batch_id = $1 ORDER BY write_off_id',
      [f.batch],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].type, 'EXPIRE');
    assert.equal(qtyOf(rows.rows[0].quantity), 20);

    const movements = await pool.query(
      'SELECT movement_type, quantity FROM stock_movements WHERE batch_id = $1',
      [f.batch],
    );
    assert.equal(movements.rows.length, 1);
    assert.equal(movements.rows[0].movement_type, 'EXPIRE');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a non-expired batch is refused under concurrency too, with zero writes', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(20, 0, 30, 'NOTEXPIRED');

    const body = { batch_id: f.batch, quantity: 20, type: 'EXPIRE', reason: 'CONCURRENCY-NOT-EXPIRED' };
    const [first, second] = await Promise.all([writeOff(body, f.user), writeOff(body, f.user)]);

    assert.equal(first.status, 409);
    assert.equal(second.status, 409);
    const after = await balances(f.batch);
    assert.equal(after.onHand, 20, 'nothing was written off');

    const headers = await pool.query('SELECT COUNT(*)::int AS n FROM inventory_write_offs WHERE batch_id = $1', [f.batch]);
    assert.equal(headers.rows[0].n, 0, 'no header is created for a refused expiry');
  } finally {
    await cleanup(f);
  }
});
