import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { authenticateJWT, requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createStockMovement, listStockMovements, getStockMovement } from '../modules/inventory/stockMovements.controller';
import { DEFAULT_STOCK_MOVEMENT_LIMIT, MAX_STOCK_MOVEMENT_LIMIT } from '../validations/stockMovement.validation';

/* ==========================================================================
 * Phase 10B.3A — Stock Movements backend (direct controller tests, mocked client)
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

const ORIGINAL_QUERY = pool.query.bind(pool);

/** يحاكي استعلامات القراءة فقط (pool.query) مع تصدير نص الاستعلام. */
async function withMockedPool(
  handler: (text: string, params: unknown[]) => MockResult,
  run: (calls: QueryCall[]) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return handler(text, params);
  };
  try {
    await run(calls);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

const movementReq = (body: Record<string, unknown> = {}): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user: PHARMACIST } as unknown as AuthenticatedRequest);

/** استعلامات القراءة تستخدم pool.query ((Client مخصص للإنشاء) */
const listReq = (query: Record<string, unknown> = {}, id?: string): AuthenticatedRequest =>
  ({ body: {}, params: id === undefined ? {} : { id }, query, user: PHARMACIST } as unknown as AuthenticatedRequest);

const movementRow = (over: Record<string, unknown> = {}): QueryRow => ({
  movement_id: 9, batch_id: 7, movement_type: 'RECEIPT', quantity: 50,
  reference_type: 'PURCHASE_ORDER', reference_id: 'PO-1', performed_by_user_id: 42,
  notes: null, created_at: '2026-03-01T10:00:00.000Z',
  lot_number: 'LOT-001', inventory_id: 5, medication_id: 11, clinic_id: 1,
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg',
  dosage_form: 'CAPSULE', performed_by_name: 'Pharmacist One', ...over,
});

const VALID_BODY = { batch_id: 7, movement_type: 'RECEIPT', quantity: 50 };

/** معالج happy-path: قفل الدفعة، تحديث الكمية، إدراج الحركة (مع تمرير عبارات المعاملة). */
const happyPath = (onHand: number) => (text: string, params: unknown[]): MockResult => {
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
  if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
    // Early replay check - no existing movement
    return { rows: [], rowCount: 0 };
  }
  if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: onHand }], rowCount: 1 };
  if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: onHand }], rowCount: 1 };
  if (text.includes('INSERT INTO stock_movements')) {
    return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
  }
  throw new Error(`Unexpected query: ${text}`);
};

const paramsToRow = (params: unknown[]) => ({
  batch_id: params[0], movement_type: params[1], quantity: params[2],
  reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], idempotency_key: params[7],
});

const wasCommitted = (calls: QueryCall[]) => calls.some((c) => c.text === 'COMMIT');
const wasRolledBack = (calls: QueryCall[]) => calls.some((c) => c.text === 'ROLLBACK');
const findUpdate = (calls: QueryCall[]) => calls.find((c) => c.text.includes('UPDATE inventory_batches b'));
const findInsert = (calls: QueryCall[]) => calls.find((c) => c.text.includes('INSERT INTO stock_movements'));

/* ==========================================================================
 * 1. AUTH
 * ========================================================================== */

test('AUTH: a request without a bearer token is rejected with 401', async () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  let nextCalled = false;

  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'middleware must not continue without a token');
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

test('AUTH: a malformed authorization header is rejected with 401', async () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };

  await authenticateJWT({ headers: { authorization: 'Basic abc' } } as any, res, () => {});

  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

/* ==========================================================================
 * 2. PERMISSION DENIAL
 * ========================================================================== */

test('AUTHORIZATION: MANAGE_INVENTORY is required', () => {
  const runMiddleware = (permission: string, roleName: string, permissions: string[]) => {
    const req = { user: { userId: 9, roleId: 9, clinicId: 1, roleName, permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;
    requirePermission(permission)(req, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err; else nextCalled = true;
    });
    return { error, nextCalled };
  };

  const denied = runMiddleware('MANAGE_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY']);
  assert.equal(denied.nextCalled, false, 'VIEW_INVENTORY alone must not record movements');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware('MANAGE_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

/* ==========================================================================
 * 3-4. VALIDATION
 * ========================================================================== */

test('VALIDATION: an unsupported movement_type returns 400 with no transaction', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    () => { throw new Error('no query may run for an invalid movement_type'); },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY, movement_type: 'TRANSFER' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('VALIDATION: zero and negative quantities return 400 with no transaction', async () => {
  for (const quantity of [0, -5]) {
    const { res, captured } = makeRes();
    await withMockedClient(
      () => { throw new Error('no query may run for a non-positive quantity'); },
      async (calls) => {
        await createStockMovement(movementReq({ ...VALID_BODY, quantity }), res);
        assert.equal(calls.length, 0);
      },
    );
    assert.equal(captured.status, 400);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('VALIDATION: more than 3 decimal places is rejected instead of being silently rounded', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    () => { throw new Error('no query may run for an over-precise quantity'); },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY, quantity: 1.2345 }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
});

test('VALIDATION: a missing batch_id or movement_type returns 400', async () => {
  for (const body of [{ movement_type: 'RECEIPT', quantity: 1 }, { batch_id: 7, quantity: 1 }]) {
    const { res, captured } = makeRes();
    await withMockedClient(
      () => { throw new Error('no query may run for an incomplete movement'); },
      async (calls) => {
        await createStockMovement(movementReq(body), res);
        assert.equal(calls.length, 0);
      },
    );
    assert.equal(captured.status, 400);
  }
});

/* ==========================================================================
 * 5-6. BATCH LOOKUP / CLINIC ISOLATION
 * ========================================================================== */

test('BATCH: a nonexistent batch returns 404 and rolls back', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE OF b')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY }), res);
      assert.equal(findUpdate(calls), undefined, 'no stock write for a missing batch');
      assert.equal(findInsert(calls), undefined, 'no movement row for a missing batch');
      assert.equal(wasRolledBack(calls), true);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: the batch lock is clinic-scoped through the inventory item join', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE OF b')) {
        assert.match(text, /JOIN inventory_items i ON i\.inventory_id = b\.inventory_id/);
        assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'the batch id alone is never trusted');
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY }), res);
      assert.deepEqual(calls[1]!.params, [7, [1]], 'scope is the assigned clinic ids');
    },
  );

  // نفس الاستجابة للمورد الغائب — لا يُكشف وجوده
  assert.equal(captured.status, 404);
  assert.equal(captured.body.message, 'الدفعة المطلوبة غير موجودة');
});

test('ISOLATION: an admin is not clinic-restricted', async () => {
  const { res, captured } = makeRes();
  const adminReq = {
    body: { ...VALID_BODY }, params: {}, query: {},
    user: { userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
  } as unknown as AuthenticatedRequest;

  await withMockedClient(
    (text) => {
      if (text === 'COMMIT' || text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
      if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
        // Early replay check - no existing movement
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FOR UPDATE OF b')) {
        assert.doesNotMatch(text, /ANY\(/);
        return { rows: [{ batch_id: 7, quantity_on_hand: 10 }], rowCount: 1 };
      }
      if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 60 }], rowCount: 1 };
      if (text.includes('INSERT INTO stock_movements')) return { rows: [{ movement_id: 1 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createStockMovement(adminReq, res);
    },
  );

  assert.equal(captured.status, 201);
});

/* ==========================================================================
 * 7-11. STOCK DIRECTION PER MOVEMENT TYPE
 * ========================================================================== */

test('DIRECTION: RECEIPT and RETURN increase quantity_on_hand', async () => {
  for (const movement_type of ['RECEIPT', 'RETURN']) {
    const { res, captured } = makeRes();
    await withMockedClient(happyPath(100), async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY, movement_type, quantity: 50 }), res);

      assert.equal(captured.status, 201, movement_type);
      assert.equal(captured.body.quantityOnHand, 150, `${movement_type} must increase stock`);
      assert.equal(findUpdate(calls)!.params[0], 150);
      assert.equal(wasCommitted(calls), true);
    });
  }
});

test('DIRECTION: DISPENSE, WASTE and EXPIRE decrease quantity_on_hand', async () => {
  for (const movement_type of ['DISPENSE', 'WASTE', 'EXPIRE']) {
    const { res, captured } = makeRes();
    await withMockedClient(happyPath(100), async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY, movement_type, quantity: 40 }), res);

      assert.equal(captured.status, 201, movement_type);
      assert.equal(captured.body.quantityOnHand, 60, `${movement_type} must decrease stock`);
      assert.equal(findUpdate(calls)!.params[0], 60);
      assert.equal(wasCommitted(calls), true);
    });
  }
});

/* ==========================================================================
 * 12. INSUFFICIENT STOCK
 * ========================================================================== */

test('STOCK: a decrease below zero is rejected with 409 and leaves stock untouched', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 10 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY, movement_type: 'DISPENSE', quantity: 25 }), res);
      assert.equal(findUpdate(calls), undefined, 'no stock write when stock is insufficient');
      assert.equal(findInsert(calls), undefined, 'no movement row when the movement was rejected');
      assert.equal(wasRolledBack(calls), true);
      assert.equal(wasCommitted(calls), false);
    },
  );

  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
});

test('STOCK: dispensing the exact available quantity is allowed (result is 0, never negative)', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(10), async (calls) => {
    await createStockMovement(movementReq({ ...VALID_BODY, movement_type: 'DISPENSE', quantity: 10 }), res);

    assert.equal(captured.status, 201);
    assert.equal(captured.body.quantityOnHand, 0);
  });
});

/* ==========================================================================
 * 13. ADJUSTMENT
 * ========================================================================== */

test('ADJUSTMENT: increases stock only — the schema has no direction or sign field', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(100), async (calls) => {
    await createStockMovement(movementReq({ ...VALID_BODY, movement_type: 'ADJUSTMENT', quantity: 25 }), res);

    assert.equal(captured.status, 201);
    assert.equal(captured.body.quantityOnHand, 125, 'ADJUSTMENT is an increase in this foundation');
    assert.equal(findUpdate(calls)!.params[0], 125);
    assert.equal(wasCommitted(calls), true);
  });
});

/* ==========================================================================
 * 14-15. MOVEMENT ROW / AUDIT FIELDS
 * ========================================================================== */

test('MOVEMENT: a body-supplied performed_by_user_id is rejected', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    () => { throw new Error('no query may run when a forbidden field is present'); },
    async (calls) => {
      await createStockMovement(
        movementReq({
          ...VALID_BODY,
          reference_type: 'PURCHASE_ORDER',
          reference_id: 'PO-2026-0001',
          notes: 'توريد دوري',
          performed_by_user_id: 999,
        }),
        res,
      );

      assert.equal(captured.status, 400);
      assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
      assert.match(captured.body.message, /performed_by_user_id/);
    },
  );
});

test('MOVEMENT: optional reference and notes default to NULL', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(100), async (calls) => {
    await createStockMovement(movementReq({ ...VALID_BODY, reference_type: '', notes: '' }), res);

    assert.equal(captured.status, 201);
    // INSERT params: [batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes, idempotency_key]
    // slice(3) gives: [reference_type, reference_id, performed_by_user_id, notes, idempotency_key]
    assert.deepEqual(findInsert(calls)!.params.slice(3, 7), [null, null, 42, null]);
    assert.equal(findInsert(calls)!.params[7], null, 'idempotency_key should be null when not provided');
  });
});

/* ==========================================================================
 * 16. TRANSACTION INTEGRITY
 * ========================================================================== */

test('TRANSACTION: a failed movement insert rolls back and never leaves a stock change', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
      if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7, quantity_on_hand: 150 }], rowCount: 1 };
      if (text.includes('INSERT INTO stock_movements')) throw new Error('insert failed');
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY }), res);

      assert.equal(wasCommitted(calls), false, 'a partial movement must never commit');
      assert.equal(wasRolledBack(calls), true);
      const rollbackIndex = calls.findIndex((c) => c.text === 'ROLLBACK');
      const updateIndex = findUpdate(calls) ? calls.indexOf(findUpdate(calls)!) : -1;
      assert.ok(rollbackIndex > updateIndex, 'the rollback must come after the stock update it undoes');
    },
  );

  assert.equal(captured.status, 500);
  assert.equal(captured.body.code, ApiErrorCode.INTERNAL_ERROR);
});

test('TRANSACTION: a DB constraint violation is reported, not bypassed', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(
    (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text === 'SAVEPOINT insert_movement' || text === 'RELEASE SAVEPOINT insert_movement' || text === 'ROLLBACK TO SAVEPOINT insert_movement') return { rows: [], rowCount: 0 };
      if (text.includes('SELECT movement_id') && text.includes('idempotency_key')) {
        // Early replay check - no existing movement
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FOR UPDATE OF b')) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
      if (text.includes('UPDATE inventory_batches b')) return { rows: [{ batch_id: 7 }], rowCount: 1 };
      if (text.includes('INSERT INTO stock_movements')) {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createStockMovement(movementReq({ ...VALID_BODY }), res);
      assert.equal(wasRolledBack(calls), true);
      assert.equal(wasCommitted(calls), false);
    },
  );

  assert.equal(captured.status, 409);
});

test('TRANSACTION: the client is always released back to the pool', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(100), async (_calls, wasReleased) => {
    await createStockMovement(movementReq({ ...VALID_BODY }), res);
    assert.equal(wasReleased(), true);
  });

  assert.equal(captured.status, 201);
});

/* ==========================================================================
 * 17-18. RESERVED QUANTITY / ROW LOCKING
 * ========================================================================== */

test('RESERVED: quantity_reserved is never written by any statement', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(100), async (calls) => {
    await createStockMovement(movementReq({ ...VALID_BODY, movement_type: 'DISPENSE', quantity: 30 }), res);

    assert.equal(captured.status, 201);
    for (const call of calls) {
      assert.doesNotMatch(call.text, /quantity_reserved/, `reserved quantity touched in: ${call.text}`);
    }
    assert.equal(captured.body.quantityOnHand, 70, 'reserved stock is not silently consumed');
  });
});

test('LOCKING: the batch row is locked with FOR UPDATE inside the transaction', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(100), async (calls) => {
    await createStockMovement(movementReq({ ...VALID_BODY }), res);

    assert.equal(captured.status, 201);
    const lockIndex = calls.findIndex((c) => c.text.includes('FOR UPDATE OF b'));
    const updateIndex = calls.findIndex((c) => c.text.includes('UPDATE inventory_batches b'));
    assert.ok(lockIndex > 0, 'a FOR UPDATE lock must be taken');
    assert.equal(calls[lockIndex - 1]!.text, 'BEGIN', 'the lock must be taken inside the transaction');
    assert.ok(lockIndex < updateIndex, 'the lock must be taken before the stock is updated');
    assert.match(calls[lockIndex]!.text, /FOR UPDATE OF b/, 'only the batch row is locked');
  });
});

test('LOCKING: all statements are parameterised — no value is interpolated into SQL', async () => {
  const { res, captured } = makeRes();

  await withMockedClient(happyPath(100), async (calls) => {
    await createStockMovement(
      movementReq({ ...VALID_BODY, notes: "'; DROP TABLE stock_movements; --", reference_id: 'PO-1' }),
      res,
    );

    assert.equal(captured.status, 201);
    for (const call of calls) {
      assert.doesNotMatch(call.text, /DROP TABLE/, 'user input must never reach the SQL text');
    }
    assert.equal(findInsert(calls)!.params[6], "'; DROP TABLE stock_movements; --");
  });
});

/* ==========================================================================
 * Phase 10B.3B — قراءة/تدقيق حركات المخزون (قراءة فقط)
 * ========================================================================== */

const SCOPED_LIST_MATCH = /i\.clinic_id = ANY\(\$\d+::int\[\]\)/;

test('READ AUTH: a request without a bearer token is rejected with 401', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;

  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

test('READ AUTHORIZATION: VIEW_INVENTORY is required for both read endpoints', () => {
  const runMiddleware = (roleName: string, permissions: string[]) => {
    const req = { user: { userId: 9, roleId: 4, clinicId: 1, roleName, permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;
    requirePermission('VIEW_INVENTORY')(req, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err; else nextCalled = true;
    });
    return { error, nextCalled };
  };

  const denied = runMiddleware('DOCTOR', ['VIEW_PATIENTS']);
  assert.equal(denied.nextCalled, false, 'VIEW_INVENTORY must be enforced on reads');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  // صلاحية الإدارة وحدها لا تكفي للقراءة
  const manageOnly = runMiddleware('PHARMACIST', ['MANAGE_INVENTORY']);
  assert.equal(manageOnly.nextCalled, false);

  const allowed = runMiddleware('PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

test('READ LIST: returns only movements of accessible clinics with pagination metadata', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /FROM stock_movements sm/);
      assert.match(text, /JOIN inventory_batches b ON b\.batch_id = sm\.batch_id/);
      assert.match(text, /JOIN inventory_items i ON i\.inventory_id = b\.inventory_id/);
      assert.match(text, SCOPED_LIST_MATCH, 'scope must run through the item join');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 2 }], rowCount: 1 };
      return { rows: [movementRow(), movementRow({ movement_id: 8 })], rowCount: 2 };
    },
    async (calls) => {
      await listStockMovements(listReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.movements.length, 2);
      assert.deepEqual(captured.body.pagination, { limit: DEFAULT_STOCK_MOVEMENT_LIMIT, offset: 0, returned: 2, total: 2 });
      // Data query is the second call (first is COUNT)
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.deepEqual(dataCall.params, [[1], DEFAULT_STOCK_MOVEMENT_LIMIT, 0]);
    },
  );
});

test('READ LIST: ordering is newest first with movement_id as a tie-breaker', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /ORDER BY sm\.created_at DESC, sm\.movement_id DESC/);
      return { rows: [movementRow()], rowCount: 1 };
    },
    async () => {
      await listStockMovements(listReq(), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: a user assigned to no clinic gets an empty list, not every clinic', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, SCOPED_LIST_MATCH, 'the scope clause must never be omitted');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listStockMovements(
        { query: {}, params: {}, body: {}, user: { ...PHARMACIST, clinicIds: [] } } as unknown as AuthenticatedRequest,
        res,
      );
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.deepEqual(dataCall.params[0], [], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.movements, []);
});

test('READ LIST: a batch filter outside the caller scope returns an empty list (no leak)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /sm\.batch_id = \$1/);
      assert.match(text, SCOPED_LIST_MATCH);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listStockMovements(listReq({ batch_id: '999' }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.deepEqual(dataCall.params, [999, [1], DEFAULT_STOCK_MOVEMENT_LIMIT, 0]);
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.movements, []);
});

test('READ LIST: a client-supplied clinic_id is ignored entirely', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /clinic_id = \$/, 'a client clinic_id must never be bound as a filter');
      assert.match(text, SCOPED_LIST_MATCH);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listStockMovements(listReq({ clinic_id: '2' }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.deepEqual(dataCall.params, [[1], DEFAULT_STOCK_MOVEMENT_LIMIT, 0]);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: a valid movement_type filter is bound as a parameter', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /sm\.movement_type = \$1/);
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ movement_type: 'DISPENSE' }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.equal(dataCall.params[0], 'DISPENSE');
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: all six movement types are accepted', async () => {
  for (const movement_type of ['RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'WASTE', 'EXPIRE']) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => ({ rows: [], rowCount: 0 }),
      async () => {
        await listStockMovements(listReq({ movement_type }), res);
      },
    );
    assert.equal(captured.status, 200, movement_type);
  }
});

test('READ LIST: an invalid movement_type is rejected with 400 and no query', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('no query may run for an invalid movement_type'); },
    async (calls) => {
      await listStockMovements(listReq({ movement_type: 'TRANSFER' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('READ LIST: batch_id, reference and performer filters compose as parameters', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /sm\.batch_id = \$1 AND sm\.movement_type = \$2 AND sm\.reference_type = \$3 AND sm\.reference_id = \$4 AND sm\.performed_by_user_id = \$5/);
      assert.match(text, SCOPED_LIST_MATCH);
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(
        listReq({
          batch_id: '7', movement_type: 'RETURN', reference_type: 'PURCHASE_ORDER',
          reference_id: 'PO-1', performed_by_user_id: '42',
        }),
        res,
      );
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.deepEqual(dataCall.params, [7, 'RETURN', 'PURCHASE_ORDER', 'PO-1', 42, [1], DEFAULT_STOCK_MOVEMENT_LIMIT, 0]);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: limit and offset are applied and echoed back', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /LIMIT \$2 OFFSET \$3/);
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ limit: '25', offset: '50' }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.deepEqual(dataCall.params, [[1], 25, 50]);
    },
  );

  assert.deepEqual(captured.body.pagination, { limit: 25, offset: 50, returned: 1, total: 1 });
});

test('READ LIST: limit has a bounded maximum and offset must be non-negative', async () => {
  for (const query of [
    { limit: String(MAX_STOCK_MOVEMENT_LIMIT + 1) },
    { limit: '0' },
    { offset: '-1' },
    { batch_id: 'abc' },
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('no query may run for invalid pagination'); },
      async (calls) => {
        await listStockMovements(listReq(query), res);
        assert.equal(calls.length, 0, JSON.stringify(query));
      },
    );
    assert.equal(captured.status, 400, JSON.stringify(query));
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('READ LIST: the maximum limit itself is accepted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listStockMovements(listReq({ limit: String(MAX_STOCK_MOVEMENT_LIMIT) }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.equal(dataCall.params[1], MAX_STOCK_MOVEMENT_LIMIT);
    },
  );

  assert.equal(captured.status, 200);
});

/* ==========================================================================
 * READ LIST: Date Filters (created_from / created_to)
 * ========================================================================== */

test('READ LIST: created_from filter is applied and scoped', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /sm\.created_at >= \$/, 'created_from filter must be applied');
      // params order for data query: [created_from_date, clinic_ids_array, limit, offset]
      // z.coerce.date() returns a Date object
      assert.ok(params[0] instanceof Date, 'created_from date must be a Date object');
      assert.equal((params[0] as Date).toISOString(), '2026-01-15T00:00:00.000Z', 'created_from date must be bound as first param');
      assert.deepEqual(params[1], [1], 'clinic scope must be second param');
      assert.deepEqual(params.slice(-2), [DEFAULT_STOCK_MOVEMENT_LIMIT, 0], 'limit, offset must be last');
      return { rows: [movementRow({ created_at: '2026-01-15T10:00:00.000Z' })], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ created_from: '2026-01-15' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.movements.length, 1);
});

test('READ LIST: created_to filter is applied with inclusive end date (exclusive next-day boundary)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /sm\.created_at < \$/, 'created_to filter must use exclusive upper bound');
      // created_to '2026-01-31' should become 2026-02-01T00:00:00.000Z
      const expectedTo = new Date('2026-02-01T00:00:00.000Z');
      assert.deepEqual(params[0], expectedTo, 'created_to (exclusive next day) must be bound as first param');
      assert.deepEqual(params[1], [1], 'clinic scope must be second param');
      assert.deepEqual(params.slice(-2), [DEFAULT_STOCK_MOVEMENT_LIMIT, 0], 'limit, offset must be last');
      return { rows: [movementRow({ created_at: '2026-01-31T23:59:59.000Z' })], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ created_to: '2026-01-31' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.movements.length, 1);
});

test('READ LIST: created_from and created_to combined filter correctly', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /sm\.created_at >= \$/, 'created_from filter must be applied');
      assert.match(text, /sm\.created_at < \$/, 'created_to filter must be applied');
      // params order for data query: [created_from, created_to_exclusive, clinic_ids_array, limit, offset]
      const fromDate = new Date('2026-01-01T00:00:00.000Z');
      const toDate = new Date('2026-02-01T00:00:00.000Z'); // 2026-01-31 + 1 day
      assert.deepEqual(params[0], fromDate, 'created_from must be first param');
      assert.deepEqual(params[1], toDate, 'created_to (exclusive next day) must be second param');
      assert.deepEqual(params[2], [1], 'clinic scope must be third param');
      assert.deepEqual(params.slice(-2), [DEFAULT_STOCK_MOVEMENT_LIMIT, 0], 'limit, offset must be last');
      return { rows: [movementRow({ created_at: '2026-01-15T10:00:00.000Z' })], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ created_from: '2026-01-01', created_to: '2026-01-31' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.movements.length, 1);
});

test('READ LIST: invalid date format is rejected', async () => {
  for (const query of [
    { created_from: 'invalid-date' },
    { created_to: 'not-a-date' },
    { created_from: '2026-13-45' },
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('no query may run for invalid date'); },
      async (calls) => {
        await listStockMovements(listReq(query), res);
        assert.equal(calls.length, 0);
      },
    );
    assert.equal(captured.status, 400, JSON.stringify(query));
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('READ LIST: reversed date range (created_from > created_to) is rejected', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('no query may run for reversed range'); },
    async (calls) => {
      await listStockMovements(listReq({ created_from: '2026-02-01', created_to: '2026-01-31' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('READ LIST: date filters combined with existing filters and pagination', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.match(text, /sm\.batch_id = \$/, 'batch_id filter must be applied');
      assert.match(text, /sm\.movement_type = \$/, 'movement_type filter must be applied');
      assert.match(text, /sm\.created_at >= \$/, 'created_from filter must be applied');
      assert.match(text, /sm\.created_at < \$/, 'created_to filter must be applied');
      // params order for data query: [batch_id, movement_type, created_from, created_to_excl, clinic_ids_array, limit, offset]
      const fromDate = new Date('2026-01-10T00:00:00.000Z');
      const toDate = new Date('2026-01-21T00:00:00.000Z'); // 2026-01-20 + 1 day
      assert.deepEqual(params[0], 7, 'batch_id must be first param');
      assert.deepEqual(params[1], 'RECEIPT', 'movement_type must be second param');
      assert.deepEqual(params[2], fromDate, 'created_from must be third param');
      assert.deepEqual(params[3], toDate, 'created_to (exclusive next day) must be fourth param');
      assert.deepEqual(params[4], [1], 'clinic scope must be fifth param');
      assert.deepEqual(params.slice(-2), [10, 20], 'limit, offset must be last');
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({
        batch_id: '7',
        movement_type: 'RECEIPT',
        created_from: '2026-01-10',
        created_to: '2026-01-20',
        limit: '10',
        offset: '20',
      }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 20);
});

test('READ LIST: clinic isolation enforced with date filters', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      assert.match(text, /i\.clinic_id = ANY\(\$/, 'clinic scope must be applied');
      assert.match(text, /sm\.created_at >= \$/, 'created_from filter must be applied');
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listStockMovements(
        { query: { created_from: '2026-01-01' }, params: {}, body: {}, user: { ...PHARMACIST, clinicIds: [999] } } as unknown as AuthenticatedRequest,
        res,
      );
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.movements, []);
    },
  );
});

test('READ LIST: admin is not clinic-restricted with date filters', async () => {
  const { res, captured } = makeRes();
  const adminReq = {
    query: { created_from: '2026-01-01', created_to: '2026-12-31' },
    params: {}, body: {},
    user: { userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
  } as unknown as AuthenticatedRequest;

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      assert.doesNotMatch(text, /ANY\(/);
      assert.match(text, /sm\.created_at >= \$/);
      assert.match(text, /sm\.created_at < \$/);
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(adminReq, res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query must be executed');
      assert.equal(dataCall.params.length, 4); // from, to, limit, offset (no scope)
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: backward compatibility — no date filters returns same response shape', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      // Should not have WHERE clause filters for created_at
      assert.doesNotMatch(text, /WHERE.*sm\.created_at/, 'no date filters should appear in WHERE clause');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 2 }], rowCount: 1 };
      return { rows: [movementRow(), movementRow({ movement_id: 8 })], rowCount: 2 };
    },
    async (calls) => {
      await listStockMovements(listReq(), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.movements.length, 2);
      assert.ok('pagination' in captured.body);
      assert.equal(captured.body.pagination.limit, DEFAULT_STOCK_MOVEMENT_LIMIT);
      assert.equal(captured.body.pagination.offset, 0);
      assert.equal(captured.body.pagination.returned, 2);
      assert.equal(captured.body.pagination.total, 2);
    },
  );
});

/* ==========================================================================
 * READ LIST: Total Count (WP-4.6.1)
 * ========================================================================== */

test('READ LIST: total count is correct for multiple pages', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 25 }], rowCount: 1 };
      return { rows: Array.from({ length: 10 }, (_, i) => movementRow({ movement_id: 10 + i })), rowCount: 10 };
    },
    async () => {
      await listStockMovements(listReq({ limit: '10', offset: '10' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 25);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 10);
  assert.equal(captured.body.pagination.returned, 10);
});

test('READ LIST: total count reflects filters (movement_type)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /sm\.movement_type = \$1/, 'movement_type filter must be in count query');
      assert.match(text, SCOPED_LIST_MATCH, 'clinic scope must be in count query');
      if (text.includes('COUNT(*)')) {
        assert.deepEqual(params, ['DISPENSE', [1]], 'count query params must match data query params except limit/offset');
        return { rows: [{ total: 8 }], rowCount: 1 };
      }
      return { rows: [movementRow({ movement_type: 'DISPENSE' })], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ movement_type: 'DISPENSE' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 8);
});

test('READ LIST: total count reflects date filters (created_from / created_to)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /sm\.created_at >= \$/, 'created_from filter must be in count query');
      assert.match(text, /sm\.created_at < \$/, 'created_to filter must be in count query');
      assert.match(text, SCOPED_LIST_MATCH, 'clinic scope must be in count query');
      if (text.includes('COUNT(*)')) {
        const fromDate = new Date('2026-01-01T00:00:00.000Z');
        const toDate = new Date('2026-02-01T00:00:00.000Z');
        assert.deepEqual(params[0], fromDate, 'created_from must be first param');
        assert.deepEqual(params[1], toDate, 'created_to (exclusive next day) must be second param');
        assert.deepEqual(params[2], [1], 'clinic scope must be third param');
        return { rows: [{ total: 15 }], rowCount: 1 };
      }
      return { rows: [movementRow({ created_at: '2026-01-15T10:00:00.000Z' })], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({ created_from: '2026-01-01', created_to: '2026-01-31' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 15);
});

test('READ LIST: total count reflects combined filters and pagination', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /sm\.batch_id = \$/, 'batch_id filter must be in count query');
      assert.match(text, /sm\.movement_type = \$/, 'movement_type filter must be in count query');
      assert.match(text, /sm\.created_at >= \$/, 'created_from filter must be in count query');
      assert.match(text, /sm\.created_at < \$/, 'created_to filter must be in count query');
      assert.match(text, SCOPED_LIST_MATCH, 'clinic scope must be in count query');
      if (text.includes('COUNT(*)')) {
        // count query params exclude limit/offset
        assert.deepEqual(params.slice(-1), [[1]], 'clinic scope must be last param in count query');
        return { rows: [{ total: 42 }], rowCount: 1 };
      }
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await listStockMovements(listReq({
        batch_id: '7',
        movement_type: 'RECEIPT',
        created_from: '2026-01-10',
        created_to: '2026-01-20',
        limit: '10',
        offset: '20',
      }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 42);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 20);
  assert.equal(captured.body.pagination.returned, 1);
});

test('READ LIST: empty result set returns total 0', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listStockMovements(listReq({ batch_id: '999' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.movements, []);
  assert.equal(captured.body.pagination.total, 0);
  assert.equal(captured.body.pagination.returned, 0);
});

test('READ LIST: offset beyond last page returns empty items but correct total', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 5 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listStockMovements(listReq({ limit: '10', offset: '100' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.movements, []);
  assert.equal(captured.body.pagination.total, 5);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 100);
  assert.equal(captured.body.pagination.returned, 0);
});

test('READ LIST: count and data queries use identical scope and filter params', async () => {
  const { res, captured } = makeRes();

  let countQueryParams: unknown[] = [];
  let dataQueryParams: unknown[] = [];

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) {
        countQueryParams = params;
        return { rows: [{ total: 8 }], rowCount: 1 };
      }
      dataQueryParams = params;
      return { rows: Array.from({ length: 3 }, (_, i) => movementRow({ movement_id: 30 + i })), rowCount: 3 };
    },
    async () => {
      await listStockMovements(listReq({ movement_type: 'RECEIPT', limit: '3' }), res);
    },
  );

  // Count query params should match data query params except for the last two (limit, offset)
  assert.deepEqual(
    countQueryParams,
    dataQueryParams.slice(0, -2),
    'count and data queries must use identical scope and filter params (excluding limit/offset)'
  );
});

test('READ GET: returns the movement with its audit context', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /WHERE sm\.movement_id = \$1/);
      assert.match(text, SCOPED_LIST_MATCH, 'never query by movement_id alone');
      return { rows: [movementRow()], rowCount: 1 };
    },
    async (calls) => {
      await getStockMovement(listReq({}, '9'), res);

      assert.equal(captured.status, 200);
      const movement = captured.body.movement;
      assert.equal(movement.movement_id, 9);
      assert.equal(movement.lot_number, 'LOT-001');
      assert.equal(movement.inventory_id, 5);
      assert.equal(movement.medication_id, 11);
      assert.equal(movement.trade_name, 'Amoxil');
      assert.equal(movement.performed_by_user_id, 42);
      assert.equal(movement.performed_by_name, 'Pharmacist One');
      assert.ok(movement.created_at);
      assert.equal(movement.username, undefined, 'no username exposure');
      assert.equal(movement.email, undefined, 'no email exposure');
      assert.deepEqual(calls[0]!.params, [9, [1]]);
    },
  );
});

test('READ GET: an out-of-scope or nonexistent movement returns the same 404', async () => {
  for (const id of ['77', '999']) {
    const { res, captured } = makeRes();
    await withMockedPool(
      (text) => {
        assert.match(text, SCOPED_LIST_MATCH, 'the batch clinic must gate the lookup');
        return { rows: [], rowCount: 0 };
      },
      async () => {
        await getStockMovement(listReq({}, id), res);
      },
    );
    assert.equal(captured.status, 404, id);
    assert.equal(captured.body.message, 'حركة المخزون المطلوبة غير موجودة');
  }
});

test('READ GET: a non-numeric movement id returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('no query may run for an invalid id'); },
    async (calls) => {
      await getStockMovement(listReq({}, 'abc'), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('READ ONLY: no read statement can write to inventory_batches or stock_movements', async () => {
  for (const run of [
    (res: any) => listStockMovements(listReq({ batch_id: '7' }), res),
    (res: any) => listStockMovements(listReq(), res),
    (res: any) => getStockMovement(listReq({}, '9'), res),
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => ({ rows: [movementRow()], rowCount: 1 }),
      async (calls) => {
        await run(res);
        assert.equal(captured.status, 200);
        for (const call of calls) {
          assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE|SELECT\s+.*\s+FOR\s+UPDATE)/i, `write statement: ${call.text}`);
          assert.doesNotMatch(call.text, /quantity_reserved/, 'reserved quantity must never be touched');
          assert.match(call.text, /^\s*SELECT\b/, `read endpoint issued a non-SELECT: ${call.text}`);
        }
      },
    );
  }
});
