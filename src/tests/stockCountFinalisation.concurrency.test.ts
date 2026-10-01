import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createStockCount, addStockCountLine, finaliseStockCount } from '../modules/inventory/stockCounts.controller';

/* ==========================================================================
 * Phase 10D.7 — Concurrency: two real PostgreSQL clients finalising one count
 *
 * The property this phase depends on: finalising a count twice must be
 * impossible. The count row is locked FOR UPDATE (never SKIP LOCKED), so the
 * second caller waits, then finds status = 'FINALISED' and is refused. Stock is
 * therefore corrected exactly once, no matter how many callers arrive.
 *
 * The same suite pins the correction arithmetic against the real database: the
 * guarded UPDATE must keep quantity_reserved <= quantity_on_hand, and the real
 * NUMERIC columns must hold the three-decimal values exactly.
 *
 * Gated exactly like the project's other DB-backed concurrency tests:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const num = (value: unknown): number => Number(value);

const scopedReq = (
  body: Record<string, unknown>,
  params: Record<string, unknown>,
  f: Fixture,
): AuthenticatedRequest =>
  ({
    body, params, query: {},
    user: {
      userId: f.user, roleId: 4, clinicId: f.clinic, roleName: 'PHARMACIST',
      permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [f.clinic],
    },
  } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

interface Fixture {
  clinic: number;
  user: number;
  medication: number;
  inventory: number;
  batch: number;
}

const NOTHING_SEEDED: Fixture = { clinic: 0, user: 0, medication: 0, inventory: 0, batch: 0 };

const seed = async (onHand: number, reserved: number, tag: string): Promise<Fixture> => {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`FINAL-RACE-${stamp}`],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Finalisation Race', `fin-race-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [`FINAL-RACE-${stamp}`, 'Finalisation Race'],
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
    clinic: num(clinic.rows[0].clinic_id),
    user: num(user.rows[0].user_id),
    medication: num(medication.rows[0].medication_id),
    inventory: num(inventory.rows[0].inventory_id),
    batch: num(batch.rows[0].batch_id),
  };
};

/** RESTRICT يتطلّب هذا الترتيب: الحركات والتسويات والبنود ثم العدّ ثم الدفعات ثم الصنف ثم الدواء ثم المستخدم ثم العيادة */
const cleanup = async (f: Fixture) => {
  if (f.batch) {
    await pool.query(
      `DELETE FROM audit_logs WHERE resource_type = 'STOCK_COUNT'
         AND resource_id IN (SELECT count_id::text FROM stock_counts WHERE clinic_id = $1)`,
      [f.clinic],
    );
    await pool.query(
      `DELETE FROM stock_movements WHERE batch_id = $1 AND reference_type = 'STOCK_COUNT'`,
      [f.batch],
    );
    await pool.query('DELETE FROM stock_adjustments WHERE batch_id = $1', [f.batch]);
    await pool.query('DELETE FROM stock_count_lines WHERE batch_id = $1', [f.batch]);
    await pool.query('DELETE FROM stock_counts WHERE clinic_id = $1', [f.clinic]);
    await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [f.batch]);
  }
  if (f.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.user) await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

/** Opens a count with one line for the fixture batch, through the real 10D.6 path. */
const openCountWithLine = async (f: Fixture, countedQuantity: number): Promise<number> => {
  const opened = makeRes();
  await createStockCount(scopedReq({ notes: 'CONCURRENCY-RACE' }, {}, f), opened.res);
  assert.equal(opened.captured.status, 201);
  const countId = num(opened.captured.body.stock_count.count_id);

  const line = makeRes();
  await addStockCountLine(scopedReq({ batch_id: f.batch, counted_quantity: countedQuantity }, { id: String(countId) }, f), line.res);
  assert.equal(line.captured.status, 201);
  return countId;
};

const finalise = async (f: Fixture, countId: number) => {
  const { res, captured } = makeRes();
  await finaliseStockCount(scopedReq({}, { id: String(countId) }, f), res);
  return captured;
};

const stateOf = async (f: Fixture, countId: number) => {
  const count = await pool.query(
    `SELECT status, finalised_at, finalised_by_user_id, counted_by_user_id FROM stock_counts WHERE count_id = $1`,
    [countId],
  );
  const lines = await pool.query(
    `SELECT system_quantity, counted_quantity, variance, system_quantity_at_finalisation, adjusted_quantity
     FROM stock_count_lines WHERE count_id = $1`,
    [countId],
  );
  const batch = await pool.query(
    'SELECT quantity_on_hand, quantity_reserved FROM inventory_batches WHERE batch_id = $1',
    [f.batch],
  );
  const adjustments = await pool.query(
    `SELECT direction, quantity, quantity_before, quantity_after, reason, batch_id, performed_by_user_id
     FROM stock_adjustments WHERE batch_id = $1`,
    [f.batch],
  );
  const movements = await pool.query(
    `SELECT movement_type, quantity, reference_type, reference_id, batch_id
     FROM stock_movements WHERE batch_id = $1`,
    [f.batch],
  );
  const audit = await pool.query(
    `SELECT COUNT(*)::int AS total FROM audit_logs
     WHERE resource_type = 'STOCK_COUNT' AND resource_id = $1 AND action = 'STOCK_COUNT_FINALISED'`,
    [String(countId)],
  );
  return {
    count: count.rows[0],
    line: lines.rows[0],
    onHand: num(batch.rows[0].quantity_on_hand),
    reserved: num(batch.rows[0].quantity_reserved),
    adjustments: adjustments.rows,
    movements: movements.rows,
    auditCount: num(audit.rows[0].total),
  };
};

test('CONCURRENCY: two concurrent finalisations of one count apply the correction exactly once', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'FINAL');
    const countId = await openCountWithLine(f, 90);

    const [first, second] = await Promise.all([finalise(f, countId), finalise(f, countId)]);
    const succeeded = [first, second].filter((r) => r.status === 200);
    const refused = [first, second].filter((r) => r.status !== 200);

    assert.equal(succeeded.length, 1, 'exactly one finalisation may succeed');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.status, 409, 'the loser is refused, never applied twice');

    const state = await stateOf(f, countId);
    assert.equal(state.count.status, 'FINALISED');
    assert.equal(state.adjustments.length, 1, 'exactly one adjustment row, not two');
    assert.equal(state.movements.length, 1, 'exactly one movement row');
    assert.equal(state.auditCount, 1, 'exactly one finalisation audit event');
    assert.equal(state.onHand, 90, 'stock is corrected once, not twice');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a count cannot be finalised twice sequentially either', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'TWICE');
    const countId = await openCountWithLine(f, 95);

    assert.equal((await finalise(f, countId)).status, 200);
    const second = await finalise(f, countId);
    assert.equal(second.status, 409, 'an already-finalised count is refused');

    const state = await stateOf(f, countId);
    assert.equal(state.adjustments.length, 1);
    assert.equal(state.movements.length, 1);
    assert.equal(state.auditCount, 1);
    assert.equal(state.onHand, 95);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: the live quantity decides the correction, not the recorded variance', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'DRIFT');
    // counted 90 against a system snapshot of 100 -> recorded variance -10
    const countId = await openCountWithLine(f, 90);

    // stock moves after the count was recorded but before it is finalised
    await pool.query('UPDATE inventory_batches SET quantity_on_hand = 80 WHERE batch_id = $1', [f.batch]);

    const result = await finalise(f, countId);
    assert.equal(result.status, 200);

    const state = await stateOf(f, countId);
    assert.equal(num(state.line.system_quantity), 100, 'the original snapshot is preserved');
    assert.equal(num(state.line.counted_quantity), 90, 'the counted quantity is preserved');
    assert.equal(num(state.line.variance), -10, 'the original variance is never restated');
    assert.equal(num(state.line.system_quantity_at_finalisation), 80, 'the live quantity is recorded separately');
    assert.equal(num(state.line.adjusted_quantity), 10, '10 units were corrected');
    assert.equal(state.onHand, 90, 'the balance becomes the counted quantity');
    assert.equal(state.adjustments[0].direction, 'INCREASE', 'the correction runs the other way');
    assert.equal(num(state.adjustments[0].quantity_before), 80);
    assert.equal(num(state.adjustments[0].quantity_after), 90);
    assert.equal(state.movements[0].movement_type, 'ADJUSTMENT');
    assert.equal(num(state.movements[0].quantity), 10);
    assert.equal(state.movements[0].reference_type, 'STOCK_COUNT');
    assert.equal(state.movements[0].reference_id, String(countId));
    assert.equal(state.adjustments[0].reason, 'STOCK_COUNT', 'a fixed, server-owned reason');
    assert.equal(state.count.finalised_by_user_id, f.user);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a zero-variance count finalises without touching stock', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'EXACT');
    const countId = await openCountWithLine(f, 100);

    const result = await finalise(f, countId);
    assert.equal(result.status, 200);

    const state = await stateOf(f, countId);
    assert.equal(state.adjustments.length, 0, 'no adjustment for a correct count');
    assert.equal(state.movements.length, 0, 'no movement either');
    assert.equal(state.onHand, 100);
    assert.equal(num(state.line.system_quantity_at_finalisation), 100);
    assert.equal(num(state.line.adjusted_quantity), 0, 'recorded as an explicit zero');
    assert.equal(state.auditCount, 1, 'the finalisation itself is still audited');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a decrease below the reserved quantity rolls the whole finalisation back', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 30, 'RESERVED');
    const countId = await openCountWithLine(f, 10);

    const result = await finalise(f, countId);
    assert.equal(result.status, 409, 'correcting down to 10 would break the 30 reserved');
    assert.equal(result.body.quantity_reserved, 30);

    const state = await stateOf(f, countId);
    assert.equal(state.count.status, 'OPEN', 'the count stays open');
    assert.equal(state.count.finalised_at, null);
    assert.equal(state.count.finalised_by_user_id, null);
    assert.equal(state.onHand, 100, 'no partial correction');
    assert.equal(state.adjustments.length, 0);
    assert.equal(state.movements.length, 0);
    assert.equal(state.line.system_quantity_at_finalisation, null, 'the line was never marked corrected');
    assert.equal(state.line.adjusted_quantity, null);
    assert.equal(state.auditCount, 0, 'and nothing was recorded as finalised');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: an empty count cannot be finalised', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'EMPTY');
    const opened = makeRes();
    await createStockCount(scopedReq({}, {}, f), opened.res);
    const countId = num(opened.captured.body.stock_count.count_id);

    const result = await finalise(f, countId);
    assert.equal(result.status, 409);

    const state = await stateOf(f, countId);
    assert.equal(state.count.status, 'OPEN');
    assert.equal(state.onHand, 100);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: three decimal quantities survive the whole correction exactly', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(10.005, 0, 'DECIMAL');
    const countId = await openCountWithLine(f, 10.13);

    const result = await finalise(f, countId);
    assert.equal(result.status, 200);

    const state = await stateOf(f, countId);
    assert.equal(state.onHand, 10.13);
    assert.equal(num(state.line.system_quantity_at_finalisation), 10.005);
    assert.equal(num(state.line.adjusted_quantity), 0.125, 'no floating-point drift');
    assert.equal(num(state.adjustments[0].quantity), 0.125);
    assert.equal(num(state.movements[0].quantity), 0.125);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: an expired, inactive or quarantined batch is still corrected', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'EXPIRED');
    // an expired, deactivated, quarantined lot: finalisation is not FEFO
    await pool.query(
      `UPDATE inventory_batches SET expiry_date = CURRENT_DATE - 5, is_active = FALSE WHERE batch_id = $1`,
      [f.batch],
    );
    await pool.query(
      `INSERT INTO batch_quarantines (batch_id, clinic_id, reason, quarantined_by_user_id)
       VALUES ($1, $2, 'CONCURRENCY-PROBE', $3)`,
      [f.batch, f.clinic, f.user],
    );

    const countId = await openCountWithLine(f, 88);
    const result = await finalise(f, countId);
    assert.equal(result.status, 200, 'a quarantine does not exempt a batch from being counted');

    const state = await stateOf(f, countId);
    assert.equal(state.onHand, 88);

    // quarantine state is untouched: still open, never released
    const quarantine = await pool.query(
      'SELECT released_at, released_by_user_id FROM batch_quarantines WHERE batch_id = $1',
      [f.batch],
    );
    assert.equal(quarantine.rows[0].released_at, null, 'finalisation never releases a quarantine');
    assert.equal(quarantine.rows[0].released_by_user_id, null);

    await pool.query('DELETE FROM batch_quarantines WHERE batch_id = $1', [f.batch]);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a finalisation is refused for a count of another clinic, identically to a missing one', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  let other: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 0, 'OWNER');
    other = await seed(50, 0, 'STRANGER');
    const countId = await openCountWithLine(f, 90);

    // a pharmacist of a different clinic sees nothing at all
    const stranger = { ...other, clinicId: other.clinic };
    const opened = makeRes();
    await createStockCount(
      { body: {}, params: {}, query: {}, user: { userId: other.user, roleId: 4, clinicId: other.clinic, roleName: 'PHARMACIST', permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [other.clinic] } } as unknown as AuthenticatedRequest,
      opened.res,
    );
    void stranger;

    const foreign = makeRes();
    await finaliseStockCount(
      { body: {}, params: { id: String(countId) }, query: {}, user: { userId: other.user, roleId: 4, clinicId: other.clinic, roleName: 'PHARMACIST', permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [other.clinic] } } as unknown as AuthenticatedRequest,
      foreign.res,
    );
    assert.equal(foreign.captured.status, 404);

    const missing = makeRes();
    await finaliseStockCount(
      { body: {}, params: { id: '424242' }, query: {}, user: { userId: other.user, roleId: 4, clinicId: other.clinic, roleName: 'PHARMACIST', permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [other.clinic] } } as unknown as AuthenticatedRequest,
      missing.res,
    );
    assert.equal(missing.captured.status, 404);
    assert.deepEqual(foreign.captured.body, missing.captured.body, 'no existence leak');

    const state = await stateOf(f, countId);
    assert.equal(state.count.status, 'OPEN', 'the owner count was never touched');
    assert.equal(state.onHand, 100);
  } finally {
    await cleanup(f);
    await cleanup(other);
  }
});
