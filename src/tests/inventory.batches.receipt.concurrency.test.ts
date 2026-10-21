import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { createBatchWithReceipt } from '../modules/inventory/batches.controller';

/* ==========================================================================
 * Phase 4B.3 - Real PostgreSQL concurrency verification
 *
 * These tests run against the isolated clinic_db_test database ONLY.
 * Each concurrency case fires two genuinely overlapping requests: a
 * start gate holds both invocations until both have entered, so two
 * real transactions are open at once and race on the database's own
 * unique constraints. Sequential mocked requests cannot prove this.
 *
 * The real guard is the partial unique index
 * uq_stock_movements_receipt_idempotency (migration 051):
 * two transactions racing on the same idempotency_key cannot both
 * commit a RECEIPT movement. The controller's savepoints turn the
 * resulting 23505 collision into a replay instead of a 500.
 *
 * The database generates received_at (DEFAULT CURRENT_TIMESTAMP,
 * migration 029); clients cannot supply it, and the legacy
 * original_received_at column (migration 052) is never written -
 * NULL means unknown provenance.
 * ========================================================================== */

const EXPECTED_DATABASE = 'clinic_db_test';

type Captured = { status: number; body: any };

const makeRes = (): { res: Response; captured: Captured } => {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  } as unknown as Response;
  return { res, captured };
};

/** Safety gate: refuse to run against anything but the isolated test database. */
const requireTestDatabase = async (): Promise<void> => {
  const result = await pool.query('SELECT current_database() AS db');
  assert.equal(
    result.rows[0].db,
    EXPECTED_DATABASE,
    `refusing to run: connected to "${result.rows[0].db}" - only ${EXPECTED_DATABASE} is allowed`,
  );
};

type TestContext = { inventoryId: number; supplierId: number; clinicId: number };

const loadTestContext = async (): Promise<TestContext> => {
  const item = await pool.query(
    `SELECT i.inventory_id, i.clinic_id
       FROM inventory_items i
      WHERE i.deleted_at IS NULL
      ORDER BY i.inventory_id
      LIMIT 1`,
  );
  assert.ok((item.rowCount ?? 0) > 0, 'clinic_db_test must contain at least one live inventory item');
  const { inventory_id: inventoryId, clinic_id: clinicId } = item.rows[0];
  const supplier = await pool.query(
    `SELECT supplier_id FROM suppliers WHERE clinic_id = $1 ORDER BY supplier_id LIMIT 1`,
    [clinicId],
  );
  assert.ok((supplier.rowCount ?? 0) > 0, `clinic ${clinicId} must contain at least one supplier`);
  return { inventoryId, supplierId: supplier.rows[0].supplier_id, clinicId };
};

const receiveReq = (body: Record<string, unknown>, clinicId: number): AuthenticatedRequest =>
  ({
    body,
    params: {},
    query: {},
    user: {
      userId: 1,
      roleId: 4,
      clinicId,
      roleName: 'PHARMACIST',
      permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'],
      clinicIds: [clinicId],
    },
  }) as unknown as AuthenticatedRequest;

const invokeOnce = async (body: Record<string, unknown>, clinicId: number): Promise<Captured> => {
  const { res, captured } = makeRes();
  await createBatchWithReceipt(receiveReq(body, clinicId), res);
  return captured;
};

/**
 * Runs two requests that genuinely overlap: neither proceeds past the
 * gate until both have entered, so both transactions are open at the
 * same time and race on the database's unique constraints.
 */
const invokeOverlapping = async (
  bodyA: Record<string, unknown>,
  bodyB: Record<string, unknown>,
  clinicId: number,
): Promise<[Captured, Captured]> => {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const invoke = async (body: Record<string, unknown>): Promise<Captured> => {
    arrived += 1;
    if (arrived === 2) release();
    await gate;
    return invokeOnce(body, clinicId);
  };
  return Promise.all([invoke(bodyA), invoke(bodyB)]);
};

const cleanupBatch = async (batchId: number): Promise<void> => {
  await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [batchId]);
  await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [batchId]);
};

test('CONCURRENCY: two overlapping same-key receipts produce exactly one movement and one stock increment', async () => {
  await requireTestDatabase();
  const ctx = await loadTestContext();

  const runId = `${Date.now()}-${process.pid}`;
  const lotNumber = `CONC-${runId}`;
  const idempotencyKey = `key-conc-${runId}`;
  const receiptQuantity = 50;

  const body = {
    inventory_id: ctx.inventoryId,
    supplier_id: ctx.supplierId,
    lot_number: lotNumber,
    expiry_date: '2099-12-31',
    quantity_on_hand: 0,
    quantity_reserved: 0,
    unit_cost: 2.5,
    receipt_quantity: receiptQuantity,
    reference_type: 'BATCH_RECEIPT',
    notes: 'real-postgresql concurrency test',
    idempotency_key: idempotencyKey,
  };

  const [first, second] = await invokeOverlapping(body, body, ctx.clinicId);

  // Exactly one request creates the receipt; the overlapping one replays it.
  const created = [first, second].filter((r) => r.status === 201);
  const replayed = [first, second].filter((r) => r.status === 200);
  assert.equal(created.length, 1, 'exactly one of the overlapping requests creates the receipt');
  assert.equal(replayed.length, 1, 'the other overlapping request replays the recorded receipt');
  assert.equal(replayed[0]!.body.idempotent_replay, true, 'the replay is flagged as such');
  assert.equal(created[0]!.body.movement.idempotency_key, idempotencyKey);
  assert.equal(created[0]!.body.quantityOnHand, receiptQuantity);
  assert.equal(replayed[0]!.body.quantityOnHand, receiptQuantity, 'the replay reports the same single increment');

  // Database truth: exactly one batch and exactly one movement for the key.
  const batches = await pool.query(
    `SELECT b.batch_id, b.quantity_on_hand, b.received_at
       FROM inventory_batches b
      WHERE b.inventory_id = $1 AND b.lot_number = $2`,
    [ctx.inventoryId, lotNumber],
  );
  assert.equal(batches.rowCount, 1, 'exactly one batch exists for the lot');
  const batch = batches.rows[0];
  assert.equal(Number(batch.quantity_on_hand), receiptQuantity, 'stock was incremented exactly once');
  assert.ok(batch.received_at != null, 'received_at is generated by the database, never by the client');

  const movements = await pool.query(
    `SELECT sm.movement_id, sm.quantity, sm.original_received_at
       FROM stock_movements sm
      WHERE sm.idempotency_key = $1 AND sm.movement_type = 'RECEIPT'`,
    [idempotencyKey],
  );
  assert.equal(movements.rowCount, 1, 'exactly one receipt movement carries the shared key');
  assert.equal(Number(movements.rows[0].quantity), receiptQuantity);
  assert.equal(
    movements.rows[0].original_received_at,
    null,
    'legacy provenance stays NULL - no client timestamp intent is recorded',
  );

  await cleanupBatch(Number(batch.batch_id));
});

test('REPLAY: a sequential retry of the same key returns the recorded receipt without a second increment', async () => {
  await requireTestDatabase();
  const ctx = await loadTestContext();

  const runId = `${Date.now()}-${process.pid}`;
  const lotNumber = `SEQ-${runId}`;
  const idempotencyKey = `key-seq-${runId}`;
  const receiptQuantity = 30;

  const body = {
    inventory_id: ctx.inventoryId,
    supplier_id: ctx.supplierId,
    lot_number: lotNumber,
    expiry_date: '2099-12-31',
    quantity_on_hand: 0,
    quantity_reserved: 0,
    unit_cost: 2.5,
    receipt_quantity: receiptQuantity,
    reference_type: 'BATCH_RECEIPT',
    notes: 'sequential replay test',
    idempotency_key: idempotencyKey,
  };

  const first = await invokeOnce(body, ctx.clinicId);
  assert.equal(first.status, 201);

  const second = await invokeOnce(body, ctx.clinicId);
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotent_replay, true);
  assert.equal(Number(second.body.quantityOnHand), receiptQuantity);

  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stock_movements WHERE idempotency_key = $1 AND movement_type = 'RECEIPT'`,
    [idempotencyKey],
  );
  assert.equal(count.rows[0].n, 1, 'a sequential retry must not create a second movement');

  const batch = await pool.query(
    `SELECT batch_id FROM inventory_batches WHERE inventory_id = $1 AND lot_number = $2`,
    [ctx.inventoryId, lotNumber],
  );
  assert.equal(batch.rowCount, 1);
  await cleanupBatch(Number(batch.rows[0].batch_id));
});

test('CONFLICT: overlapping requests with the same key but different quantities produce one receipt and one 409', async () => {
  await requireTestDatabase();
  const ctx = await loadTestContext();

  const runId = `${Date.now()}-${process.pid}`;
  const lotNumber = `CFL-${runId}`;
  const idempotencyKey = `key-cfl-${runId}`;

  const base = {
    inventory_id: ctx.inventoryId,
    supplier_id: ctx.supplierId,
    lot_number: lotNumber,
    expiry_date: '2099-12-31',
    quantity_on_hand: 0,
    quantity_reserved: 0,
    unit_cost: 2.5,
    reference_type: 'BATCH_RECEIPT',
    notes: 'conflict test',
    idempotency_key: idempotencyKey,
  };

  const [first, second] = await invokeOverlapping(
    { ...base, receipt_quantity: 100 },
    { ...base, receipt_quantity: 50 },
    ctx.clinicId,
  );

  const created = [first, second].filter((r) => r.status === 201);
  const conflicted = [first, second].filter((r) => r.status === 409);
  assert.equal(created.length, 1, 'exactly one request creates the receipt');
  assert.equal(conflicted.length, 1, 'a conflicting payload under the same key is refused');
  assert.equal(conflicted[0]!.body.code, 'FORBIDDEN');

  const movements = await pool.query(
    `SELECT quantity FROM stock_movements WHERE idempotency_key = $1 AND movement_type = 'RECEIPT'`,
    [idempotencyKey],
  );
  assert.equal(movements.rowCount, 1);
  const winningQuantity = Number(movements.rows[0].quantity);
  assert.ok(winningQuantity === 100 || winningQuantity === 50, 'the winning quantity must be one of the two conflicting payloads');

  // Strengthened: verify final quantity_on_hand equals initial + winning quantity (no double increment)
  const batch = await pool.query(
    `SELECT batch_id, quantity_on_hand FROM inventory_batches WHERE inventory_id = $1 AND lot_number = $2`,
    [ctx.inventoryId, lotNumber],
  );
  assert.equal(batch.rowCount, 1, 'exactly one batch exists for the lot');
  const finalQty = Number(batch.rows[0].quantity_on_hand);
  const initialQty = Number(base.quantity_on_hand);
  assert.equal(finalQty, initialQty + winningQuantity, 'final quantity must equal initial plus winning receipt quantity — no double increment');

  await cleanupBatch(Number(batch.rows[0].batch_id));
});

test('UNAFFECTED: non-RECEIPT movements are not blocked by a receipt idempotency key', async () => {
  await requireTestDatabase();
  const ctx = await loadTestContext();

  const runId = `${Date.now()}-${process.pid}`;
  const lotNumber = `ADJ-${runId}`;
  const idempotencyKey = `key-adj-${runId}`;

  // Create a receipt: a batch plus a RECEIPT movement carrying the key.
  const created = await invokeOnce(
    {
      inventory_id: ctx.inventoryId,
      supplier_id: ctx.supplierId,
      lot_number: lotNumber,
      expiry_date: '2099-12-31',
      quantity_on_hand: 0,
      quantity_reserved: 0,
      unit_cost: 2.5,
      receipt_quantity: 40,
      reference_type: 'BATCH_RECEIPT',
      notes: 'adjustment base',
      idempotency_key: idempotencyKey,
    },
    ctx.clinicId,
  );
  assert.equal(created.status, 201);
  const batchId = Number(created.body.batch.batch_id);

  // The partial index covers RECEIPT rows only, so a non-RECEIPT movement
  // may carry the same key at the database level without violating it.
  const adjustment = await pool.query(
    `INSERT INTO stock_movements
       (batch_id, movement_type, quantity, performed_by_user_id, idempotency_key)
     VALUES ($1, 'ADJUSTMENT', 1, 1, $2)
     RETURNING movement_id`,
    [batchId, idempotencyKey],
  );
  assert.equal(adjustment.rowCount, 1, 'a non-RECEIPT movement with the same key is accepted by the database');

  const byKey = await pool.query(
    `SELECT movement_type, COUNT(*)::int AS n
       FROM stock_movements
      WHERE idempotency_key = $1
      GROUP BY movement_type`,
    [idempotencyKey],
  );
  const types = new Map(byKey.rows.map((r) => [r.movement_type, r.n]));
  assert.equal(types.get('RECEIPT'), 1);
  assert.equal(types.get('ADJUSTMENT'), 1);

  await cleanupBatch(batchId);
});

test('SCHEMA: the receipt idempotency index is partial over RECEIPT movements', async () => {
  await requireTestDatabase();
  const idx = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_stock_movements_receipt_idempotency'`,
  );
  assert.equal(idx.rowCount, 1, 'the partial idempotency index from migration 051 must exist');
  assert.match(idx.rows[0].indexdef, /idempotency_key/);
  assert.match(idx.rows[0].indexdef, /movement_type.*=.*'RECEIPT'/, 'the index must cover RECEIPT rows only');
  assert.match(idx.rows[0].indexdef, /idempotency_key IS NOT NULL/, 'the index must ignore rows without a key');
});
