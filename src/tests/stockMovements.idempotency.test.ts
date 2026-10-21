import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { createStockMovement } from '../modules/inventory/stockMovements.controller';
import { FORBIDDEN_STOCK_MOVEMENT_FIELDS } from '../validations/stockMovement.validation';
import { ApiErrorCode } from '../utils/apiErrors';

/* ==========================================================================
 * Phase 4B.2 — Stock Movements Idempotency Tests
 * Tests the idempotency_key feature for RECEIPT movements.
 * Only pool.connect() is stubbed; the controller must use ONE transaction.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

/** يستبدل pool.connect بعميل وهمي يتحقق من المعاملة ويصدّر كل الاستعلامات. */
async function withMockedClient(
  handler: (text: string, params: unknown[]) => MockResult,
  run: (calls: QueryCall[], wasReleased: () => boolean) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  let released = false;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return handler(text, params);
    },
    release: () => { released = true; },
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  try {
    await run(calls, () => released);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

const movementReq = (body: Record<string, unknown> = {}): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user: PHARMACIST } as unknown as AuthenticatedRequest);

const VALID_RECEIPT_BODY = { batch_id: 7, movement_type: 'RECEIPT', quantity: 50, reference_type: 'BATCH_RECEIPT', reference_id: '7' };

const paramsToRow = (params: unknown[]) => ({
  batch_id: params[0], movement_type: params[1], quantity: params[2],
  reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], idempotency_key: params[7],
});

/** يكتب جملة الكتابة فقط (قبل RETURNING) — RETURNING يقرأ ما يولده الخادم. */
const writeClauseOf = (text: string): string => {
  const idx = text.indexOf('RETURNING');
  return idx === -1 ? text : text.slice(0, idx);
};

const wasCommitted = (calls: QueryCall[]) => calls.some((c) => c.text === 'COMMIT');
const wasRolledBack = (calls: QueryCall[]) => calls.some((c) => c.text === 'ROLLBACK');

/** Handler for first successful receipt */
const firstReceiptHandler = (onHand: number, key: string) => (text: string, params: unknown[]): MockResult => {
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
  if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
    // Early replay check - no existing movement for first call
    return { rows: [], rowCount: 0 };
  }
  if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: onHand }], rowCount: 1 };
  if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: onHand + (params[0] as number) }], rowCount: 1 };
  if (text.includes('INSERT INTO stock_movements')) {
    return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
  }
  throw new Error(`Unexpected query: ${text}`);
};

/** Handler for replay (existing movement found on early check) */
const replayHandler = (onHand: number, existingMovement: QueryRow) => (text: string, params: unknown[]): MockResult => {
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
  if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
    // Early replay check - return existing movement
    return { rows: [existingMovement], rowCount: 1 };
  }
  if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: onHand }], rowCount: 1 };
  // Should not reach UPDATE or INSERT because replay returns early
  throw new Error(`Unexpected query after replay: ${text}`);
};

/** Handler for concurrent test - first call succeeds, second hits unique constraint */
let concurrentBeginCount = 0;
const concurrentHandler = (text: string, params: unknown[]): MockResult => {
  if (text === 'BEGIN') {
    concurrentBeginCount++;
    return { rows: [], rowCount: 0 };
  }
  if (text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
  if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
    // Early replay check - first call: no existing, second call: existing (after first committed)
    if (concurrentBeginCount === 1) {
      return { rows: [], rowCount: 0 };
    } else {
      return { rows: [{ movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: 50, reference_type: 'BATCH_RECEIPT', reference_id: '7', performed_by_user_id: 42, notes: 'استلام', created_at: '2026-01-01T00:00:00.000Z', idempotency_key: 'concurrent-key' }], rowCount: 1 };
    }
  }
  if (text.includes('SELECT b.quantity_on_hand') && text.includes('inventory_batches b')) {
    // Re-lock query after unique constraint - return current stock (150 after first commit)
    return { rows: [{ quantity_on_hand: 150 }], rowCount: 1 };
  }
  if (text.includes('FOR UPDATE OF b')) {
    // Return 100 for first attempt, 150 for second (after first commit)
    const currentStock = concurrentBeginCount === 1 ? 100 : 150;
    return { rows: [{ batch_id: 7, quantity_on_hand: currentStock }], rowCount: 1 };
  }
  if (text.includes('UPDATE inventory_batches b')) {
    // Return updated stock: 150 for first, 200 for second (but second will rollback)
    const nextStock = concurrentBeginCount === 1 ? 150 : 200;
    return { rows: [{ batch_id: 7, quantity_on_hand: nextStock }], rowCount: 1 };
  }
  if (text.includes('INSERT INTO stock_movements')) {
    if (concurrentBeginCount === 1) {
      return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
    } else {
      throw { code: '23505' };
    }
  }
  throw new Error(`Unexpected query: ${text}`);
};

/* ==========================================================================
 * 1. IDEMPOTENCY: First keyed receipt increases stock exactly once
 * ========================================================================== */

test('IDEMPOTENCY: first keyed RECEIPT succeeds and adds quantity once', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    firstReceiptHandler(100, 'test-key-123'),
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'test-key-123' }), res);
      assert.equal(wasCommitted(calls), true, 'transaction must commit');
    },
  );

  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, undefined); // Not a replay
  assert.equal(captured.body.quantityOnHand, 150); // 100 + 50
  assert.equal(captured.body.movement.idempotency_key, 'test-key-123');
});

/* ==========================================================================
 * 2. IDEMPOTENCY: Repeating same key and identical payload = replay, no double-count
 * ========================================================================== */

test('IDEMPOTENCY: repeat with same key and payload returns replay without changing stock', async () => {
  const { res, captured } = makeRes();

  const existingMovement = { movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: 50, reference_type: 'BATCH_RECEIPT', reference_id: '7', performed_by_user_id: 42, notes: 'استلام', created_at: '2026-01-01T00:00:00.000Z', idempotency_key: 'test-key-123' };

  await withMockedClient(
    replayHandler(150, existingMovement), // Stock already increased from first call
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'test-key-123' }), res);
      // Should rollback after finding existing movement
      assert.equal(wasRolledBack(calls), true, 'transaction must rollback on replay');
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.quantityOnHand, 150); // Stock unchanged
  assert.equal(captured.body.message, 'سبق تسجيل هذه الحركة بنفس مفتاح التكرار');
});

/* ==========================================================================
 * 3. IDEMPOTENCY: Concurrent duplicate requests produce one stock increase
 * ========================================================================== */

test('IDEMPOTENCY: concurrent requests with same key - one succeeds, one replays', async () => {
  concurrentBeginCount = 0; // Reset for this test

  // First request
  const { res: res1, captured: captured1 } = makeRes();
  await withMockedClient(concurrentHandler, async (calls) => {
    await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'concurrent-key' }), res1);
  });

  // Second request (concurrent)
  const { res: res2, captured: captured2 } = makeRes();
  await withMockedClient(concurrentHandler, async (calls) => {
    await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'concurrent-key' }), res2);
  });

  assert.equal(captured1.status, 201, 'first request should succeed');
  assert.equal(captured1.body.idempotent_replay, undefined);
  assert.equal(captured1.body.quantityOnHand, 150);

  assert.equal(captured2.status, 200, 'second request should replay');
  assert.equal(captured2.body.idempotent_replay, true);
  assert.equal(captured2.body.quantityOnHand, 150, 'stock should not increase again');
});

/* ==========================================================================
 * 4. IDEMPOTENCY: Reusing key with different quantity or batch returns 409
 * ========================================================================== */

test('IDEMPOTENCY: same key with different batch_id returns 409', async () => {
  // First, create a movement with key 'key-1' on batch 7
  const { res: res1, captured: captured1 } = makeRes();

  await withMockedClient(
    firstReceiptHandler(100, 'key-1'),
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'key-1' }), res1);
    },
  );

  assert.equal(captured1.status, 201);

  // Now try to use same key 'key-1' on batch 8 with different quantity
  const { res: res2, captured: captured2 } = makeRes();

  let handlerCallCount = 0;
  const conflictingHandler = (text: string, params: unknown[]): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
    if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
      // Early replay check - returns existing movement on batch 7
      return { rows: [{ movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: 50, reference_type: 'BATCH_RECEIPT', reference_id: '7', performed_by_user_id: 42, notes: 'استلام', created_at: '2026-01-01T00:00:00.000Z', idempotency_key: 'key-1' }], rowCount: 1 };
    }
    if (text.includes('FOR UPDATE OF b')) {
      // Second batch (8) - different batch
      return { rows: [{ batch_id: 8, quantity_on_hand: 50 }], rowCount: 1 };
    }
    if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 8, quantity_on_hand: 75 }], rowCount: 1 };
    if (text.includes('INSERT INTO stock_movements')) {
      handlerCallCount++;
      if (handlerCallCount === 1) {
        // Simulate unique constraint violation (same key, different batch)
        throw { code: '23505' };
      }
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await withMockedClient(conflictingHandler, async (calls) => {
    await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, batch_id: 8, quantity: 25, idempotency_key: 'key-1' }), res2);
  });

  // Should return 409 because the existing movement has different batch_id
  assert.equal(captured2.status, 409);
});

test('IDEMPOTENCY: same key with different quantity on same batch returns 409', async () => {
  // First, create a movement with key 'key-2' on batch 7 with quantity 50
  const { res: res1, captured: captured1 } = makeRes();

  await withMockedClient(
    firstReceiptHandler(100, 'key-2'),
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'key-2' }), res1);
    },
  );

  assert.equal(captured1.status, 201);

  // Now try to use same key 'key-2' on same batch 7 but different quantity
  const { res: res2, captured: captured2 } = makeRes();

  let handlerCallCount = 0;
  const conflictingHandler = (text: string, params: unknown[]): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
    if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
      // Early replay check - returns existing movement on batch 7 with quantity 50
      return { rows: [{ movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: 50, reference_type: 'BATCH_RECEIPT', reference_id: '7', performed_by_user_id: 42, notes: 'استلام', created_at: '2026-01-01T00:00:00.000Z', idempotency_key: 'key-2' }], rowCount: 1 };
    }
    if (text.includes('FOR UPDATE OF b')) {
      return { rows: [{ batch_id: 7, quantity_on_hand: 150 }], rowCount: 1 };
    }
    if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 175 }], rowCount: 1 };
    if (text.includes('INSERT INTO stock_movements')) {
      handlerCallCount++;
      if (handlerCallCount === 1) {
        // Simulate unique constraint violation (same key, same batch)
        throw { code: '23505' };
      }
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await withMockedClient(conflictingHandler, async (calls) => {
    await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, quantity: 25, idempotency_key: 'key-2' }), res2);
  });

  // Should return 409 because the existing movement has different quantity
  assert.equal(captured2.status, 409);
});

/* ==========================================================================
 * 5. IDEMPOTENCY: Failed transaction followed by retry with same key succeeds
 * ========================================================================== */

test('IDEMPOTENCY: failed transaction then retry with same key succeeds', async () => {
  // First attempt fails (e.g., DB error after lock but before insert)
  const { res: res1, captured: captured1 } = makeRes();

  const failingHandler = (text: string, params: unknown[]): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
    if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
      // Early replay check - no existing movement (first attempt)
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
    if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 150 }], rowCount: 1 };
    if (text.includes('INSERT INTO stock_movements')) {
      // Simulate DB error
      throw new Error('Database connection lost');
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await withMockedClient(failingHandler, async (calls) => {
    await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'retry-key' }), res1);
  });

  assert.equal(captured1.status, 500); // First attempt fails

  // Second attempt (retry) should succeed
  const { res: res2, captured: captured2 } = makeRes();

  await withMockedClient(
    firstReceiptHandler(100, 'retry-key'), // Stock is back to 100 because first transaction rolled back
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, idempotency_key: 'retry-key' }), res2);
    },
  );

  assert.equal(captured2.status, 201);
  assert.equal(captured2.body.idempotent_replay, undefined);
  assert.equal(captured2.body.quantityOnHand, 150);
});

/* ==========================================================================
 * 6. IDEMPOTENCY: Two distinct keys allow two legitimate receipts for same batch
 * ========================================================================== */

test('IDEMPOTENCY: two distinct keys allow two legitimate receipts for same batch', async () => {
  // First receipt with key 'key-a'
  const { res: res1, captured: captured1 } = makeRes();

  await withMockedClient(
    firstReceiptHandler(100, 'key-a'),
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, quantity: 50, idempotency_key: 'key-a' }), res1);
    },
  );

  assert.equal(captured1.status, 201);
  assert.equal(captured1.body.quantityOnHand, 150);

  // Second receipt with key 'key-b' on same batch
  const { res: res2, captured: captured2 } = makeRes();

  await withMockedClient(
    firstReceiptHandler(150, 'key-b'), // Stock is now 150
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, quantity: 30, idempotency_key: 'key-b' }), res2);
    },
  );

  assert.equal(captured2.status, 201);
  assert.equal(captured2.body.idempotent_replay, undefined);
  assert.equal(captured2.body.quantityOnHand, 180); // 150 + 30
});

/* ==========================================================================
 * 7. IDEMPOTENCY: Requests without key remain backward compatible
 * ========================================================================== */

test('IDEMPOTENCY: requests without idempotency_key work as before', async () => {
  const { res, captured } = makeRes();

  // Handler for no key - should not do early replay check
  const noKeyHandler = (text: string, params: unknown[]): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
    if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
      // Should not be called when no key provided
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
    if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 150 }], rowCount: 1 };
    if (text.includes('INSERT INTO stock_movements')) {
      return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await withMockedClient(
    noKeyHandler,
    async (calls) => {
      await createStockMovement(movementReq(VALID_RECEIPT_BODY), res); // No idempotency_key
    },
  );

  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, undefined);
  assert.equal(captured.body.quantityOnHand, 150);
  assert.equal(captured.body.movement.idempotency_key, null);
});

/* ==========================================================================
 * 8. IDEMPOTENCY: Other movement types (DISPENSE, RETURN, ADJUSTMENT) unaffected
 * ========================================================================== */

test('IDEMPOTENCY: DISPENSE with key is NOT idempotent (index scoped to RECEIPT only)', async () => {
  const { res, captured } = makeRes();

  // DISPENSE with idempotency_key should work normally (no replay logic)
  const dispenseHandler = (text: string, params: unknown[]): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
    if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
      // Should not be called for DISPENSE (only for RECEIPT)
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 200 }], rowCount: 1 };
    if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 150 }], rowCount: 1 };
    if (text.includes('INSERT INTO stock_movements')) {
      return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await withMockedClient(
    dispenseHandler,
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, movement_type: 'DISPENSE', quantity: 50, idempotency_key: 'dispense-key' }), res);
    },
  );

  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, undefined);
  assert.equal(captured.body.quantityOnHand, 150); // 200 - 50
  assert.equal(captured.body.movement.idempotency_key, 'dispense-key'); // Key stored but no replay logic
});

test('IDEMPOTENCY: RETURN with key is NOT idempotent (index scoped to RECEIPT only)', async () => {
  const { res, captured } = makeRes();

  const returnHandler = (text: string, params: unknown[]): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
    if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
      // Should not be called for RETURN (only for RECEIPT)
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
    if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 125 }], rowCount: 1 };
    if (text.includes('INSERT INTO stock_movements')) {
      return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await withMockedClient(
    returnHandler,
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_RECEIPT_BODY, movement_type: 'RETURN', quantity: 25, idempotency_key: 'return-key' }), res);
    },
  );

  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, undefined);
  assert.equal(captured.body.quantityOnHand, 125); // 100 + 25
  assert.equal(captured.body.movement.idempotency_key, 'return-key');
});

/* ==========================================================================
 * Phase 4B.3 - Database-controlled timestamps
 * created_at (and received_at in the receipt path) are generated by
 * the database, never written by the client, and never take part in
 * the idempotency comparison.
 * ========================================================================== */

test('DATABASE TIMESTAMPS: movement INSERT writes no timestamp columns', async () => {
  let insertQuery: QueryCall | undefined;

  const clientHandler = (text: string, params: unknown[] = []): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.startsWith('SAVEPOINT') || text.startsWith('RELEASE SAVEPOINT') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FOR UPDATE OF b')) {
      return { rows: [{ batch_id: 1, quantity_on_hand: 10 }], rowCount: 1 };
    }
    if (text.includes('FROM stock_movements') && text.includes('idempotency_key')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('UPDATE inventory_batches b')) {
      return { rows: [{ batch_id: 1, quantity_on_hand: 20 }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO stock_movements')) {
      insertQuery = { text, params };
      return { rows: [{ movement_id: 42, batch_id: 1, movement_type: 'RECEIPT', quantity: 10, performed_by_user_id: 5, created_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  const { res, captured } = makeRes();
  await withMockedClient(
    clientHandler,
    async () => {
      await createStockMovement(movementReq({ batch_id: 1, movement_type: 'RECEIPT', quantity: 10 }), res);
    },
  );

  assert.equal(captured.status, 201);
  assert.ok(insertQuery, 'movement INSERT must be executed');
  assert.doesNotMatch(writeClauseOf(insertQuery!.text), /received_at|original_received_at|created_at|updated_at/, 'timestamps are database-controlled and must never be written by the client path');
  assert.ok(insertQuery!.params.every((p) => !(p instanceof Date)), 'no Date value is bound for a timestamp column');
});

test('DATABASE TIMESTAMPS: server-derived fields are rejected before any database access', async () => {
  for (const field of FORBIDDEN_STOCK_MOVEMENT_FIELDS) {
    const { res, captured } = makeRes();
    await withMockedClient(
      () => { throw new Error('no query may run when a forbidden field is present'); },
      async () => {
        await createStockMovement(movementReq({ batch_id: 1, movement_type: 'RECEIPT', quantity: 10, [field]: 'forged' }), res);
      },
    );
    assert.equal(captured.status, 400, `${field} must be rejected`);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('IDEMPOTENCY: replay matches on operation fields - stored timestamps are irrelevant', async () => {
  // The stored row's created_at is server-generated and unknown to the
  // client; a replay must still match regardless of the stored timestamp.
  const stored = {
    movement_id: 1, batch_id: 1, movement_type: 'RECEIPT', quantity: 10,
    reference_type: null, reference_id: null, performed_by_user_id: 42,
    notes: 'استلام', created_at: '2030-12-31T23:59:59.000Z', idempotency_key: 'replay-key',
  };

  const clientHandler = (text: string, params: unknown[] = []): MockResult => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.startsWith('SAVEPOINT') || text.startsWith('RELEASE SAVEPOINT') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FOR UPDATE OF b')) {
      return { rows: [{ batch_id: 1, quantity_on_hand: 10 }], rowCount: 1 };
    }
    if (text.includes('FROM stock_movements') && text.includes('idempotency_key')) {
      return { rows: [stored], rowCount: 1 };
    }
    if (text.includes('UPDATE inventory_batches b')) {
      return { rows: [{ batch_id: 1, quantity_on_hand: 20 }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO stock_movements')) {
      return { rows: [{ movement_id: 42, batch_id: 1, movement_type: 'RECEIPT', quantity: 10, performed_by_user_id: 5, created_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  const { res, captured } = makeRes();
  await withMockedClient(
    clientHandler,
    async () => {
      await createStockMovement(
        movementReq({ batch_id: 1, movement_type: 'RECEIPT', quantity: 10, idempotency_key: 'replay-key' }),
        res,
      );
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.movement.movement_id, 1);
});
