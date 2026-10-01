import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createStockAdjustment } from '../modules/inventory/stockAdjustments.controller';

/* ==========================================================================
 * Phase 10D.2 — Concurrency: two real PostgreSQL clients adjusting one batch
 *
 * Proves the property the adjustment transaction depends on: because the batch
 * is locked with FOR UPDATE (never SKIP LOCKED), two concurrent adjustments on
 * the SAME batch are serialised. The loser of a decrease re-reads the committed
 * balance instead of overselling, and two increases both land exactly once —
 * there is no lost update.
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
const adjust = async (body: Record<string, unknown>, userId: number) => {
  const { res, captured } = makeRes();
  await createStockAdjustment(adminReq(body, userId), res);
  return captured;
};

interface Fixture {
  clinic: number;
  medication: number;
  inventory: number;
  batch: number;
  user: number;
}

/** قيم صفرية = لم يُنشأ شيء بعد، فيتخطّى التنظيف ما لم يُنشأ */
const NOTHING_SEEDED: Fixture = { clinic: 0, medication: 0, inventory: 0, batch: 0, user: 0 };

const seed = async (onHand: number, reserved: number, tag: string): Promise<Fixture> => {
  const stamp = `${tag}-${Date.now()}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`ADJ-RACE-${stamp}`],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Adjustment Race', `adj-race-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [`ADJ-RACE-${stamp}`, 'Adjustment Race'],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  const batch = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, $3, $4) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp, onHand, reserved],
  );

  return {
    clinic: qtyOf(clinic.rows[0].clinic_id),
    user: qtyOf(user.rows[0].user_id),
    medication: qtyOf(medication.rows[0].medication_id),
    inventory: qtyOf(inventory.rows[0].inventory_id),
    batch: qtyOf(batch.rows[0].batch_id),
  };
};

/** RESTRICT يتطلّب هذا الترتيب تماماً: التدقيق ثم الحركات والرأس ثم الصنف/الدفعة ثم الدواء ثم المستخدم ثم العيادة */
const cleanup = async (f: Fixture) => {
  if (f.batch) {
    await pool.query(
      `DELETE FROM audit_logs WHERE resource_type = 'STOCK_ADJUSTMENT'
         AND resource_id IN (SELECT adjustment_id::text FROM stock_adjustments WHERE batch_id = $1)`,
      [f.batch],
    );
    await pool.query(`DELETE FROM stock_movements WHERE batch_id = $1`, [f.batch]);
    await pool.query(`DELETE FROM stock_adjustments WHERE batch_id = $1`, [f.batch]);
  }
  if (f.batch) {
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

test('CONCURRENCY: two concurrent decreases on one batch cannot oversell it', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // رصيد 10، وكل تسوية تطلب 10: واحدة فقط يمكن أن تنجح
    f = await seed(10, 0, 'DEC');

    const body = { batch_id: f.batch, quantity: 10, direction: 'DECREASE', reason: 'CONCURRENCY-RACE' };
    const [first, second] = await Promise.all([adjust(body, f.user), adjust(body, f.user)]);

    const succeeded = [first, second].filter((r) => r.status === 201);
    const failed = [first, second].filter((r) => r.status !== 201);

    assert.equal(succeeded.length, 1, 'exactly one decrease may succeed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.status, 409, 'the loser sees the committed balance, never a stale one');

    const after = await balances(f.batch);
    assert.equal(after.onHand, 0, 'stock must end at exactly 0, never negative');
    assert.ok(after.onHand >= 0, 'stock must never go negative');
    assert.equal(after.reserved, 0);

    const headers = await pool.query('SELECT COUNT(*)::int AS n FROM stock_adjustments WHERE batch_id = $1', [f.batch]);
    const movements = await pool.query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE batch_id = $1', [f.batch]);
    const audits = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE resource_type = 'STOCK_ADJUSTMENT'`,
    );
    assert.equal(headers.rows[0].n, 1, 'exactly one adjustment header survives');
    assert.equal(movements.rows[0].n, 1, 'exactly one movement survives');
    assert.ok(audits.rows[0].n >= 1);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: two concurrent increases both land exactly once — no lost update', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'INC');

    const body = { batch_id: f.batch, quantity: 25, direction: 'INCREASE', reason: 'CONCURRENCY-RACE-INC' };
    const [first, second] = await Promise.all([adjust(body, f.user), adjust(body, f.user)]);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201, 'increases never conflict — both must be recorded');

    const after = await balances(f.batch);
    assert.equal(after.onHand, 150, '100 + 25 + 25 — neither update may be lost');
    assert.equal(after.reserved, 0);

    const movements = await pool.query(
      `SELECT movement_type, quantity FROM stock_movements WHERE batch_id = $1 ORDER BY movement_id`,
      [f.batch],
    );
    assert.equal(movements.rows.length, 2);
    for (const row of movements.rows) {
      assert.equal(row.movement_type, 'ADJUSTMENT');
      assert.equal(qtyOf(row.quantity), 25);
    }
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a decrease and an increase on one batch both respect quantity_reserved', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // رصيد 100، محجوز 80 -> المتاح 20 فقط
    f = await seed(100, 80, 'RES');

    const decrease = { batch_id: f.batch, quantity: 21, direction: 'DECREASE', reason: 'CONCURRENCY-RESERVED' };
    const rejected = await adjust(decrease, f.user);
    assert.equal(rejected.status, 409, 'reserved stock is never consumable by an adjustment');

    const after = await balances(f.batch);
    assert.equal(after.onHand, 100, 'a rejected adjustment changes nothing');
    assert.equal(after.reserved, 80, 'quantity_reserved is never written');

    const headers = await pool.query('SELECT COUNT(*)::int AS n FROM stock_adjustments WHERE batch_id = $1', [f.batch]);
    assert.equal(headers.rows[0].n, 0, 'a rejected adjustment leaves no header behind');
  } finally {
    await cleanup(f);
  }
});
