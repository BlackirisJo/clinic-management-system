import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createStockCount, addStockCountLine } from '../modules/inventory/stockCounts.controller';

/* ==========================================================================
 * Phase 10D.6 — Concurrency: two real PostgreSQL clients, one count
 *
 * The property the line transaction depends on: two concurrent attempts to add
 * the SAME batch to ONE count can never both succeed. The batch is locked with
 * FOR UPDATE (never SKIP LOCKED) so the second attempt waits rather than
 * overtaking, and uq_scl_count_batch is the final authority if both reach the
 * insert. Either way exactly one line exists afterwards.
 *
 * The same test also pins the other half of the snapshot contract: recording a
 * count never moves stock, never writes a movement, and never touches
 * quantity_reserved.
 *
 * Gated exactly like the project's other DB-backed concurrency tests so it never
 * runs against a developer's database implicitly. Enable with:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const num = (value: unknown): number => Number(value);

/** A pharmacist scoped to exactly the fixture's clinic: real scope, no admin shortcut. */
const scopedReq = (body: Record<string, unknown>, params: Record<string, unknown>, f: Fixture): AuthenticatedRequest =>
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

const openCount = async (f: Fixture) => {
  const { res, captured } = makeRes();
  await createStockCount(scopedReq({ notes: 'CONCURRENCY-RACE' }, {}, f), res);
  return captured;
};

const addLine = async (f: Fixture, countId: number, batchId: number, countedQuantity: number) => {
  const { res, captured } = makeRes();
  await addStockCountLine(scopedReq({ batch_id: batchId, counted_quantity: countedQuantity }, { id: String(countId) }, f), res);
  return captured;
};

interface Fixture {
  clinic: number;
  user: number;
  medication: number;
  inventory: number;
  batch: number;
}

const NOTHING_SEEDED: Fixture = { clinic: 0, user: 0, medication: 0, inventory: 0, batch: 0 };

const seed = async (onHand: number, tag: string): Promise<Fixture> => {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`COUNT-RACE-${stamp}`],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Count Race', `count-race-${stamp}`, 'x'],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [`COUNT-RACE-${stamp}`, 'Count Race'],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  const batch = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, $3, 0) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp, onHand],
  );

  return {
    clinic: num(clinic.rows[0].clinic_id),
    user: num(user.rows[0].user_id),
    medication: num(medication.rows[0].medication_id),
    inventory: num(inventory.rows[0].inventory_id),
    batch: num(batch.rows[0].batch_id),
  };
};

/** RESTRICT يتطلّب هذا الترتيب: البنود ثم رؤوس العدّ ثم الدفعات ثم الصنف ثم الدواء ثم المستخدم ثم العيادة */
const cleanup = async (f: Fixture) => {
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

const balanceOf = async (batchId: number) => {
  const row = await pool.query(
    'SELECT quantity_on_hand, quantity_reserved FROM inventory_batches WHERE batch_id = $1',
    [batchId],
  );
  return { onHand: num(row.rows[0].quantity_on_hand), reserved: num(row.rows[0].quantity_reserved) };
};

const movementCount = async (batchId: number) => {
  const row = await pool.query('SELECT COUNT(*)::int AS total FROM stock_movements WHERE batch_id = $1', [batchId]);
  return num(row.rows[0].total);
};

const lineCount = async (countId: number) => {
  const row = await pool.query('SELECT COUNT(*)::int AS total FROM stock_count_lines WHERE count_id = $1', [countId]);
  return num(row.rows[0].total);
};

test('CONCURRENCY: two concurrent attempts to count the same batch in one count cannot both win', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 'DUP');
    const opened = await openCount(f);
    assert.equal(opened.status, 201, 'the count session opens first');
    const countId = num(opened.body.stock_count.count_id);
    assert.equal(opened.body.stock_count.status, 'OPEN');

    const [first, second] = await Promise.all([
      addLine(f, countId, f.batch, 90),
      addLine(f, countId, f.batch, 95),
    ]);

    const succeeded = [first, second].filter((r) => r.status === 201);
    const refused = [first, second].filter((r) => r.status !== 201);

    assert.equal(succeeded.length, 1, 'exactly one line may be recorded for a batch in a count');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.status, 409, 'the loser is refused, never silently merged');

    assert.equal(await lineCount(countId), 1, 'the table holds exactly one line');

    // The surviving line is a coherent record, not a blend of both attempts
    const row = await pool.query(
      'SELECT system_quantity, counted_quantity, variance FROM stock_count_lines WHERE count_id = $1',
      [countId],
    );
    const line = row.rows[0];
    assert.equal(num(line.system_quantity), 100, 'the snapshot is the real on-hand quantity');
    assert.ok([90, 95].includes(num(line.counted_quantity)), 'one of the two counted values is stored whole');
    assert.equal(
      num(line.variance),
      num(line.counted_quantity) - num(line.system_quantity),
      'the stored variance matches exactly the two stored inputs',
    );
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: counting never moves stock and never writes a movement', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(73.5, 'NOEFFECT');
    const before = await balanceOf(f.batch);
    const movementsBefore = await movementCount(f.batch);

    const opened = await openCount(f);
    const countId = num(opened.body.stock_count.count_id);

    const result = await addLine(f, countId, f.batch, 0);
    assert.equal(result.status, 201, 'counting an empty shelf is a normal operation');

    const after = await balanceOf(f.batch);
    assert.equal(after.onHand, before.onHand, 'on-hand is untouched');
    assert.equal(after.reserved, before.reserved, 'the reservation is untouched');
    assert.equal(await movementCount(f.batch), movementsBefore, 'no stock movement is created');
    assert.equal(num(result.body.line.variance), -73.5, 'the whole shortfall is still only recorded');
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a stored variance is never restated by later stock movement', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(100, 'FROZEN');
    const opened = await openCount(f);
    const countId = num(opened.body.stock_count.count_id);
    assert.equal((await addLine(f, countId, f.batch, 90)).status, 201);

    // The warehouse then dispenses ten units out from under the open count.
    await pool.query(
      'UPDATE inventory_batches SET quantity_on_hand = 90, updated_at = NOW() WHERE batch_id = $1',
      [f.batch],
    );

    const row = await pool.query(
      'SELECT system_quantity, counted_quantity, variance FROM stock_count_lines WHERE count_id = $1',
      [countId],
    );
    assert.equal(num(row.rows[0].system_quantity), 100, 'the snapshot is a moment in time, not a live balance');
    assert.equal(num(row.rows[0].variance), -10, 'the variance is not restated against the newer quantity');

    await pool.query('UPDATE inventory_batches SET quantity_on_hand = 100 WHERE batch_id = $1', [f.batch]);
  } finally {
    await cleanup(f);
  }
});

test('CONCURRENCY: a line may only be added while the count is OPEN', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(50, 'STATUS');
    const opened = await openCount(f);
    const countId = num(opened.body.stock_count.count_id);
    assert.equal((await addLine(f, countId, f.batch, 49)).status, 201);

    // 10D.6 has no finalisation endpoint, so the transition is simulated at the
    // database level to prove the write path refuses a closed count.
    await pool.query(
      `UPDATE stock_counts SET status = 'FINALISED', finalised_at = NOW(), approved_by_user_id = $2
       WHERE count_id = $1`,
      [countId, f.user],
    );

    await pool.query(
      `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
       VALUES ($1, CONCAT('LOT-EXTRA-', $2::text), CURRENT_DATE + 30, 10, 0) RETURNING batch_id`,
      [f.inventory, `STATUS-${Date.now()}`],
    );
    const extra = await pool.query(
      `SELECT batch_id FROM inventory_batches WHERE inventory_id = $1 ORDER BY batch_id DESC LIMIT 1`,
      [f.inventory],
    );
    const extraBatchId = num(extra.rows[0].batch_id);

    const refused = await addLine(f, countId, extraBatchId, 9);
    assert.equal(refused.status, 409, 'a closed count accepts no further lines');
    assert.equal(refused.body.status, 'FINALISED');

    await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [extraBatchId]);
  } finally {
    await cleanup(f);
  }
});
