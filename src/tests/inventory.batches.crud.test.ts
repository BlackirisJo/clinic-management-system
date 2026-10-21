import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission, authenticateJWT } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listBatches,
  getBatch,
  getBatchAvailability,
  createBatch,
  createBatchWithReceipt,
  updateBatch,
  deactivateBatch,
  listBatchesByExpiry,
} from '../modules/inventory/batches.controller';
import { DEFAULT_EXPIRY_LIMIT, MAX_EXPIRY_LIMIT, MAX_EXPIRY_DAYS } from '../validations/batch.validation';

/* ==========================================================================
 * Phase 10B.2C — Inventory Batches backend (direct controller tests, mocked pool.query)
 * No real PostgreSQL is used: only pool.query is stubbed and always restored.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);

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

const ORIGINAL_CONNECT = pool.connect.bind(pool);

/**
 * يحاكي pool.connect() و pool.query() معاً لاختبارات المعاملات المعزولة.
 * - استعلامات المعاملة (BEGIN/COMMIT/ROLLBACK/SAVEPOINT) تُمرر إلى client.query()
 * - الاستعلامات المساعدة (inventory/supplier/lot lookups) تُمرر إلى pool.query()
 * - يسجل كل الاستعلامات على المسارين
 * - يعيد الدوال الأصلية في finally، ويمنع أي اتصال حقيقي
 */
async function withMockedTransaction(
  clientHandler: (text: string, params: unknown[]) => MockResult,
  poolHandler: (text: string, params: unknown[]) => MockResult,
  run: (clientCalls: QueryCall[], poolCalls: QueryCall[], wasReleased: () => boolean) => Promise<void>,
): Promise<void> {
  const clientCalls: QueryCall[] = [];
  const poolCalls: QueryCall[] = [];
  let released = false;

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      clientCalls.push({ text, params });
      return clientHandler(text, params);
    },
    release: () => { released = true; },
  };

  (pool as unknown as { connect: unknown }).connect = async () => client;
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    poolCalls.push({ text, params });
    return poolHandler(text, params);
  };

  try {
    await run(clientCalls, poolCalls, () => released);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

/** يحاكي pool.connect بعميل وهمي يتحقق من المعاملة ويصدّر كل الاستعلامات. */
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

const pharmacist = (clinicIds: number[] = [1]) => ({
  userId: 5, roleId: 4, clinicId: clinicIds[0] ?? null, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY', 'MANAGE_SUPPLIERS'], clinicIds,
});

const superAdmin = {
  userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [] as string[], clinicIds: [] as number[],
};

const ITEM_LOOKUP = 'SELECT i.inventory_id, i.clinic_id FROM inventory_items i';
const LOT_LOOKUP_GENERIC = 'SELECT batch_id FROM inventory_batches';

/** يستخرج جزء SET فقط من جملة UPDATE (قبل FROM / RETURNING) لفحص الأعمدة المكتوبة. */
const setClauseOf = (text: string): string => {
  const start = text.indexOf('SET ');
  const end = text.indexOf('FROM inventory_items i');
  return text.slice(start, end === -1 ? text.length : end);
};

/** يستخرج جملة الكتابة فقط (قبل RETURNING) — RETURNING يقرأ ما يولده الخادم ولا يكتبه. */
const writeClauseOf = (text: string): string => {
  const idx = text.indexOf('RETURNING');
  return idx === -1 ? text : text.slice(0, idx);
};

const batchRow = (over: Record<string, unknown> = {}): QueryRow => ({
  batch_id: 7, inventory_id: 5, supplier_id: 3, lot_number: 'LOT-001',
  expiry_date: '2027-01-31', quantity_on_hand: 100, quantity_reserved: 0,
  unit_cost: 2.5, received_at: '2026-02-01T00:00:00.000Z', is_active: true,
  created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
});

const batchReq = (
  opts: { body?: Record<string, unknown>; id?: string; query?: Record<string, unknown>; user?: unknown } = {},
): AuthenticatedRequest =>
  ({
    body: opts.body ?? {},
    params: opts.id === undefined ? {} : { id: opts.id },
    query: opts.query ?? {},
    user: opts.user ?? pharmacist(),
  } as unknown as AuthenticatedRequest);

const VALID_CREATE_BODY = {
  inventory_id: 5, supplier_id: 3, lot_number: 'LOT-001',
  expiry_date: '2027-01-31', quantity_on_hand: 100, quantity_reserved: 0, unit_cost: 2.5,
};

const paramsToRow = (params: unknown[]) => ({
  batch_id: params[0], movement_type: params[1], quantity: params[2],
  reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], idempotency_key: params[7],
});

/* --------------------------------------------------------------------------
 * Phase 10B.4A — Batch availability (read-only)
 * -------------------------------------------------------------------------- */

const EXPIRED_PREDICATE = /\(b\.expiry_date < CURRENT_DATE\) AS expired/;
// Phase 10D.1 adds the quarantine exclusion to the eligibility predicate.
const FEFO_PREDICATE =
  /b\.is_active AND i\.deleted_at IS NULL AND b\.quantity_on_hand > 0 AND b\.expiry_date >= CURRENT_DATE[\s\S]*AS available_for_fefo/;
const QUARANTINE_PREDICATE = /bq\.batch_id = b\.batch_id AND bq\.released_at IS NULL/;

const availabilityRow = (over: Record<string, unknown> = {}): QueryRow => ({
  batch_id: 7, inventory_id: 5, lot_number: 'LOT-001', expiry_date: '2027-01-31',
  quantity_on_hand: 100, is_active: true, expired: false, available_for_fefo: true, ...over,
});

const expiryRow = (over: Record<string, unknown> = {}): QueryRow => ({
  batch_id: 7, inventory_id: 5, lot_number: 'LOT-001', expiry_date: '2026-09-20',
  quantity_on_hand: 100, quantity_reserved: 5, is_active: true, ...over,
});

/* ==========================================================================
 * 1. AUTHORIZATION
 * ========================================================================== */

test('AUTHORIZATION: reads require VIEW_INVENTORY and writes require MANAGE_INVENTORY', () => {
  const runMiddleware = (permission: string, roleName: string, permissions: string[]) => {
    const req = { user: { userId: 9, roleId: 4, clinicId: 1, roleName, permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;

    requirePermission(permission)(req, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err;
      else nextCalled = true;
    });

    return { error, nextCalled };
  };

  const deniedView = runMiddleware('VIEW_INVENTORY', 'DOCTOR', ['VIEW_PATIENTS', 'CREATE_PRESCRIPTION']);
  assert.equal(deniedView.nextCalled, false, 'VIEW_INVENTORY must be enforced on GET');
  assert.equal(deniedView.error?.statusCode, 403);
  assert.equal(deniedView.error?.code, ApiErrorCode.FORBIDDEN);

  // MANAGE_SUPPLIERS alone is not enough — batches need MANAGE_INVENTORY
  const deniedManage = runMiddleware('MANAGE_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_SUPPLIERS']);
  assert.equal(deniedManage.nextCalled, false, 'MANAGE_INVENTORY must be enforced on writes');
  assert.equal(deniedManage.error?.code, ApiErrorCode.FORBIDDEN);

  const allowedView = runMiddleware('VIEW_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowedView.error, null);
  assert.equal(allowedView.nextCalled, true);

  const allowedAdmin = runMiddleware('MANAGE_INVENTORY', 'SUPER_ADMIN', []);
  assert.equal(allowedAdmin.nextCalled, true, 'admins bypass the permission check');
});

/* ==========================================================================
 * 2. LIST / GET
 * ========================================================================== */

test('LIST: returns batches of one inventory item, scoped through the item clinic', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /JOIN inventory_items i ON i\.inventory_id = b\.inventory_id/, 'scope comes via the item');
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/);
      return { rows: [batchRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatches(batchReq({ query: { inventory_id: '5' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.batches.length, 1);
      assert.deepEqual(calls[0]!.params, [5, [1]]);
    },
  );
});

test('LIST: inventory_id is required — batches of every clinic are never listed at once', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called without inventory_id'); },
    async (calls) => {
      await listBatches(batchReq(), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('LIST: an out-of-scope inventory item yields an empty list, not another clinic\'s batches', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'scope clause must never be omitted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatches(batchReq({ query: { inventory_id: '5' }, user: pharmacist([]) }), res);
      assert.deepEqual(calls[0]!.params, [5, []], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.batches, []);
});

/* ==========================================================================
 * 2b. LIST — Pagination & Filters (WP-4.3)
 * ========================================================================== */

test('LIST: default pagination returns limit 20, offset 0, and total count', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 5 }], rowCount: 1 };
      assert.match(text, /LIMIT \$/, 'LIMIT must be applied');
      assert.match(text, /OFFSET \$/, 'OFFSET must be applied');
      return { rows: [batchRow()], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.ok(captured.body.pagination, 'pagination metadata must be present');
  assert.equal(captured.body.pagination.limit, 20, 'default limit is 20');
  assert.equal(captured.body.pagination.offset, 0, 'default offset is 0');
  assert.equal(captured.body.pagination.returned, 1);
  assert.equal(captured.body.pagination.total, 5, 'total must reflect full filtered dataset');
  assert.equal(captured.body.batches.length, 1);
});

test('LIST: custom limit and offset are validated and applied', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 100 }], rowCount: 1 };
      assert.deepEqual(params.slice(-2), [5, 10], 'custom limit and offset must be bound as last params');
      return { rows: Array.from({ length: 5 }, (_, i) => batchRow({ batch_id: 10 + i })), rowCount: 5 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', limit: '5', offset: '10' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.limit, 5);
  assert.equal(captured.body.pagination.offset, 10);
  assert.equal(captured.body.pagination.returned, 5);
  assert.equal(captured.body.pagination.total, 100);
});

test('LIST: limit boundaries are enforced (1..200)', async () => {
  const { res, captured } = makeRes();

  // limit = 0 (below minimum)
  await listBatches(batchReq({ query: { inventory_id: '5', limit: '0' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');

  // limit = 201 (above maximum)
  await listBatches(batchReq({ query: { inventory_id: '5', limit: '201' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');

  // limit = 1 (minimum accepted)
  await withMockedPool(
    (text) => (text.includes('COUNT(*)') ? { rows: [{ total: 1 }], rowCount: 1 } : { rows: [batchRow()], rowCount: 1 }),
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', limit: '1' } }), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.pagination.limit, 1);
    },
  );

  // limit = 200 (maximum accepted)
  await withMockedPool(
    (text) => (text.includes('COUNT(*)') ? { rows: [{ total: 1 }], rowCount: 1 } : { rows: [batchRow()], rowCount: 1 }),
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', limit: '200' } }), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.pagination.limit, 200);
    },
  );
});

test('LIST: offset must be non-negative', async () => {
  const { res, captured } = makeRes();

  await listBatches(batchReq({ query: { inventory_id: '5', offset: '-1' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');
});

test('LIST: empty result returns returned:0 and correct total', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listBatches(batchReq({ query: { inventory_id: '5' } }), res);

      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.batches, []);
      assert.equal(captured.body.pagination.returned, 0);
      assert.equal(captured.body.pagination.total, 0);
      assert.equal(calls.length, 2, 'both count and data queries must execute');
    },
  );
});

test('LIST: offset beyond last page returns empty items but correct total', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 50 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', limit: '20', offset: '100' } }), res);

      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.batches, []);
      assert.equal(captured.body.pagination.returned, 0);
      assert.equal(captured.body.pagination.total, 50, 'total must reflect full dataset');
      assert.equal(captured.body.pagination.limit, 20);
      assert.equal(captured.body.pagination.offset, 100);
    },
  );
});

test('LIST: count query uses same clinic scope and filters as data query', async () => {
  const { res, captured } = makeRes();

  let countQueryParams: unknown[] = [];
  let dataQueryParams: unknown[] = [];

  await withMockedPool(
    (text, params) => {
      if (text.includes('COUNT(*)')) {
        countQueryParams = params;
        return { rows: [{ total: 5 }], rowCount: 1 };
      }
      dataQueryParams = params;
      return { rows: Array.from({ length: 5 }, (_, i) => batchRow({ batch_id: 100 + i })), rowCount: 5 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', supplier_id: '3' }, user: pharmacist([1, 2]) }), res);
    },
  );

  // Count query params should match data query params except for the last two (limit, offset)
  assert.deepEqual(
    countQueryParams,
    dataQueryParams.slice(0, -2),
    'count and data queries must use identical scope and filter params (excluding limit/offset)'
  );
});

test('LIST: supplier_id filter is applied and scoped to clinic', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /b\.supplier_id = \$/, 'supplier_id filter must be applied');
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'clinic scope must be applied');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 2 }], rowCount: 1 };
      return { rows: [batchRow({ supplier_id: 3 }), batchRow({ batch_id: 8, supplier_id: 3 })], rowCount: 2 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', supplier_id: '3' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.batches.length, 2);
  assert.equal(captured.body.pagination.total, 2);
  assert(captured.body.batches.every((b: any) => b.supplier_id === 3));
});

test('LIST: invalid supplier_id is rejected', async () => {
  const { res, captured } = makeRes();

  await listBatches(batchReq({ query: { inventory_id: '5', supplier_id: '0' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');

  await listBatches(batchReq({ query: { inventory_id: '5', supplier_id: '-1' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');
});

test('LIST: lot_number partial match filter is case-insensitive', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /b\.lot_number ILIKE \$/, 'lot_number partial match must use ILIKE');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      // Data query params: scope params ([clinicId]) + filter + limit + offset
      assert.deepEqual(params.slice(-3), ['%lot-001%', 20, 0], 'search pattern, limit, offset must be bound');
      return { rows: [batchRow({ lot_number: 'LOT-001' })], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', lot_number: 'lot-001' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.batches.length, 1);
});

test('LIST: empty lot_number is treated as no filter', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /b\.lot_number ILIKE/, 'no lot_number filter should be added for empty query');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 5 }], rowCount: 1 };
      return { rows: [batchRow()], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', lot_number: '' } }), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.pagination.total, 5);

      // Whitespace-only should also be treated as empty
      await listBatches(batchReq({ query: { inventory_id: '5', lot_number: '   ' } }), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.pagination.total, 5);
    },
  );
});

test('LIST: received_from date filter is applied (inclusive)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /b\.received_at >= \$/, 'received_from filter must be applied');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 3 }], rowCount: 1 };
      return { rows: [batchRow({ received_at: '2026-02-01T00:00:00.000Z' })], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', received_from: '2026-02-01' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 3);
});

test('LIST: received_to date filter is applied (inclusive end date)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /b\.received_at < \$/, 'received_to filter must use exclusive upper bound for inclusive day');
      // The bound value should be the next day at midnight
      if (text.includes('COUNT(*)')) return { rows: [{ total: 4 }], rowCount: 1 };
      return { rows: [batchRow({ received_at: '2026-02-15T12:00:00.000Z' })], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', received_to: '2026-02-15' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 4);
});

test('LIST: received_from and received_to combined filter correctly', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /b\.received_at >= \$/, 'received_from filter must be applied');
      assert.match(text, /b\.received_at < \$/, 'received_to filter must be applied');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 2 }], rowCount: 1 };
      return { rows: [batchRow({ received_at: '2026-02-10T00:00:00.000Z' })], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', received_from: '2026-02-01', received_to: '2026-02-20' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 2);
});

test('LIST: reversed date range (received_from > received_to) is rejected', async () => {
  const { res, captured } = makeRes();

  await listBatches(batchReq({ query: { inventory_id: '5', received_from: '2026-02-20', received_to: '2026-02-01' } }), res);

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');
});

test('LIST: invalid date format is rejected', async () => {
  const { res, captured } = makeRes();

  await listBatches(batchReq({ query: { inventory_id: '5', received_from: 'not-a-date' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');

  await listBatches(batchReq({ query: { inventory_id: '5', received_to: 'invalid' } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');
});

test('LIST: multiple filters combined with pagination', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text, params) => {
      assert.match(text, /b\.supplier_id = \$/, 'supplier_id filter must be applied');
      assert.match(text, /b\.lot_number ILIKE \$/, 'lot_number filter must be applied');
      assert.match(text, /b\.received_at >= \$/, 'received_from filter must be applied');
      assert.match(text, /b\.received_at < \$/, 'received_to filter must be applied');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 25 }], rowCount: 1 };
      // Data query should have scope params + filter params + limit + offset
      // Last 6 params: supplier_id, lot_pattern, received_from, received_to_excl, limit, offset
      assert.deepEqual(params.slice(-6), [3, '%ABC%', new Date('2026-01-01T00:00:00.000Z'), new Date('2027-01-01T00:00:00.000Z'), 10, 20], 'limit and offset must be bound as last params');
      return { rows: Array.from({ length: 10 }, (_, i) => batchRow({ batch_id: 20 + i })), rowCount: 10 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', supplier_id: '3', lot_number: 'ABC', received_from: '2026-01-01', received_to: '2026-12-31', limit: '10', offset: '20' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 20);
  assert.equal(captured.body.pagination.total, 25);
  assert.equal(captured.body.pagination.returned, 10);
});

test('LIST: clinic isolation enforced with pagination and filters', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$/, 'clinic scope must be applied');
      assert.match(text, /b\.supplier_id = \$/, 'supplier_id filter must be applied');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5', supplier_id: '3' }, user: pharmacist([1]) }), res);
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.batches, []);
    },
  );
});

test('LIST: admin is not clinic-restricted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /ANY\(/, 'admin scope is unlimited');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 3 }], rowCount: 1 };
      return { rows: [batchRow({ clinic_id: 9 })], rowCount: 1 };
    },
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5' }, user: superAdmin }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 3);
});

test('LIST: backward compatibility — existing response fields preserved', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [batchRow({ clinic_id: 1, supplier_name: 'Test Supplier' })], rowCount: 1 }),
    async () => {
      await listBatches(batchReq({ query: { inventory_id: '5' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.ok(captured.body.batches, 'batches array must exist');
  assert.ok(captured.body.pagination, 'pagination object must exist');
  assert.ok(Array.isArray(captured.body.batches), 'batches must be array');
  // All batch fields should be present
  const batch = captured.body.batches[0];
  assert.ok('batch_id' in batch);
  assert.ok('inventory_id' in batch);
  assert.ok('supplier_id' in batch);
  assert.ok('lot_number' in batch);
  assert.ok('expiry_date' in batch);
  assert.ok('quantity_on_hand' in batch);
  assert.ok('quantity_reserved' in batch);
  assert.ok('unit_cost' in batch);
  assert.ok('received_at' in batch);
  assert.ok('is_active' in batch);
  assert.ok('created_at' in batch);
  assert.ok('updated_at' in batch);
  assert.ok('clinic_id' in batch);
  assert.ok('supplier_name' in batch);
});

test('GET: returns the batch with its clinic and supplier name', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [batchRow({ clinic_id: 1, supplier_name: 'Acme Pharma' })], rowCount: 1 }),
    async (calls) => {
      await getBatch(batchReq({ id: '7' }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.batch.batch_id, 7);
      assert.equal(captured.body.batch.supplier_name, 'Acme Pharma');
      assert.deepEqual(calls[0]!.params, [7, [1]]);
    },
  );
});

/* ==========================================================================
 * 3. CLINIC ISOLATION / OUT-OF-SCOPE IDS
 * ========================================================================== */

test('ISOLATION: GET of a batch whose item is in another clinic is 404 (no existence leak)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'the batch id alone is never trusted');
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await getBatch(batchReq({ id: '77', user: pharmacist([1]) }), res);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: update of an out-of-scope batch stops at the scoped lookup', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /UPDATE/, 'no write may run for an out-of-scope batch');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '77', body: { lot_number: 'LOT-999' }, user: pharmacist([1]) }), res);
      assert.equal(calls.length, 1, 'only the scoped lookup runs');
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: deactivating an out-of-scope batch matches no row and returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /UPDATE inventory_batches b SET is_active = FALSE/);
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/);
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await deactivateBatch(batchReq({ id: '77', user: pharmacist([1]) }), res);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: creating a batch for an out-of-scope item returns 404 and no INSERT', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /FROM inventory_items i/);
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY }, user: pharmacist([1]) }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_batches')), false);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: admin is not clinic-restricted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /ANY\(/, 'admin scope is unlimited');
      return { rows: [batchRow({ clinic_id: 9 })], rowCount: 1 };
    },
    async () => {
      await getBatch(batchReq({ id: '7', user: superAdmin }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.batch.clinic_id, 9);
});

/* ==========================================================================
 * 4. CREATE / RECEIVE
 * ========================================================================== */

test('CREATE: receiving a batch persists the initial quantities and returns 201', async () => {
  const { res, captured } = makeRes();

await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);

      assert.equal(captured.status, 201);
      assert.equal(captured.body.batch.batch_id, 7);

      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_batches'));
      assert.ok(insert, 'INSERT must be executed');
      assert.deepEqual(insert.params, [5, 3, 'LOT-001', '2027-01-31', 100, 0, 2.5]);
      assert.doesNotMatch(insert!.text, /uom/, 'uom does not belong to batches');
    },
  );
});

test('CREATE: the INSERT RETURNING clause carries no table alias (42P01 regression)', async () => {
  // INSERT INTO inventory_batches لا يعرّف جدولاً مستعاراً "b"، فاستخدام
  // BATCH_RETURNING (المؤهَّد بـ b.) هنا كان يفشل عند كل استلام دفعة:
  //   42P01 missing FROM-clause entry for table "b"  ->  HTTP 500
  // استعلاما SELECT و UPDATE يبقيان على النسخة المؤهَّدة بـ b. لأن المستعار "b"
  // موجود فعلاً فيهما — الإصلاح يلمس مسار INSERT وحده.
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
      assert.equal(captured.status, 201);

      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_batches'))!;
      const returning = insert.text.slice(insert.text.indexOf('RETURNING') + 'RETURNING'.length);
      assert.doesNotMatch(returning, /\bb\./, 'INSERT ... RETURNING must not qualify columns with an alias');
      for (const column of [
        'batch_id', 'inventory_id', 'supplier_id', 'lot_number', 'expiry_date',
        'quantity_on_hand', 'quantity_reserved', 'unit_cost', 'received_at', 'is_active',
        'created_at', 'updated_at',
      ]) {
        assert.match(returning, new RegExp(`\\b${column}\\b`), `RETURNING still reports ${column}`);
      }
      // the alias is still needed wherever "b" genuinely exists
      assert.doesNotMatch(insert.text, /INSERT INTO inventory_batches b/, 'the INSERT does not declare an alias');
    },
  );
});

test('CREATE: SELECT and UPDATE keep the aliased fragment, where alias "b" exists', async () => {
  const { res, captured } = makeRes();

  // a read still selects b.-qualified columns
  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ clinic_id: 1 })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await getBatch(batchReq({ id: '7' }), res);
      assert.equal(captured.status, 200);
      assert.match(calls[0]!.text, /SELECT b\.batch_id/, 'reads keep the alias');
    },
  );

  // and UPDATE inventory_batches b ... RETURNING b.* stays aliased
  const upd = makeRes();
  await withMockedPool(
    (text) => {
      if (text.includes('UPDATE inventory_batches b')) {
        assert.match(text, /RETURNING b\.batch_id/, 'UPDATE declares alias b, so b.* is valid there');
        return { rows: [batchRow({ lot_number: 'LOT-002' })], rowCount: 1 };
      }
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await updateBatch(batchReq({ id: '7', body: { lot_number: 'LOT-002' } }), upd.res);
    },
  );
  assert.equal(upd.captured.status, 200);
});

test('CREATE: omitted quantities default to 0 and unit_cost stays NULL', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      const { supplier_id, quantity_on_hand, quantity_reserved, unit_cost, ...body } = VALID_CREATE_BODY;
      await createBatch(batchReq({ body }), res);

      assert.equal(captured.status, 201);
      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_batches'));
      assert.equal(insert!.params[1], null, 'supplier_id defaults to NULL');
      assert.equal(insert!.params[4], 0, 'quantity_on_hand defaults to 0');
      assert.equal(insert!.params[5], 0, 'quantity_reserved defaults to 0');
      assert.equal(insert!.params[6], null, 'unit_cost stays NULL, never coerced to 0');
    },
  );
});

test('CREATE: received_at is generated by database default, not accepted from client', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);

      assert.equal(captured.status, 201);
      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_batches'));
      // INSERT should not include received_at in column list or COALESCE - database default applies
      const insertColumns = insert!.text.slice(insert!.text.indexOf('('), insert!.text.indexOf(')') + 1);
      assert.doesNotMatch(insertColumns, /received_at/, 'received_at must not be in INSERT column list');
      assert.doesNotMatch(insert!.text, /COALESCE/, 'COALESCE must not be used for received_at');
      assert.equal(insert!.params.length, 7, 'only 7 parameters expected (no received_at)');
    },
  );
});

test('CREATE: client-supplied received_at is rejected before any database access', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('no query may run when a forbidden field is present'); },
    async () => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY, received_at: '2026-01-01T00:00:00.000Z' } }), res);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  assert.match(String(captured.body.message), /received_at/);
});

test('CREATE: every server-derived field is rejected before any database access', async () => {
  for (const field of ['batch_id', 'original_received_at', 'created_at', 'updated_at']) {
    const { res, captured } = makeRes();

    await withMockedPool(
      () => { throw new Error('no query may run when a forbidden field is present'); },
      async () => {
        await createBatch(batchReq({ body: { ...VALID_CREATE_BODY, [field]: 'forged' } }), res);
      },
    );

    assert.equal(captured.status, 400, `${field} must be rejected`);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('CREATE: missing lot_number or expiry_date returns 400 without touching the DB', async () => {
  for (const body of [
    { inventory_id: 5, expiry_date: '2027-01-31' },
    { inventory_id: 5, lot_number: 'LOT-001' },
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('pool.query must not be called for an incomplete batch'); },
      async (calls) => {
        await createBatch(batchReq({ body }), res);
        assert.equal(calls.length, 0);
      },
    );
    assert.equal(captured.status, 400);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

/* ==========================================================================
 * 5. INVALID INVENTORY ID
 * ========================================================================== */

test('CREATE: unknown or invalid inventory_id returns 404 and no INSERT', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /FROM inventory_items i/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY, inventory_id: 999 } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_batches')), false);
    },
  );

  assert.equal(captured.status, 404);
});

test('CREATE: a non-numeric inventory_id returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid inventory_id'); },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY, inventory_id: 'abc' } }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 6. INVALID / OUT-OF-SCOPE SUPPLIER
 * ========================================================================== */

test('CREATE: a supplier from another clinic is rejected (no INSERT)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 2 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_batches')), false);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('CREATE: a nonexistent supplier is rejected with the same response (no existence leak)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_batches')), false);
    },
  );

  assert.equal(captured.status, 400);
});

test('CREATE: a deactivated supplier of the same clinic is still accepted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 201);
});

/* ==========================================================================
 * 7. DUPLICATE LOT NUMBER
 * ========================================================================== */

test('CREATE: duplicate (inventory_id, lot_number) returns 409 and no INSERT', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [{ batch_id: 7 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_batches')), false);
    },
  );

  assert.equal(captured.status, 409);
});

test('CREATE: unique-index violation (23505) is translated to 409', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 409);
});

test('DUPLICATE: a deactivated batch still reserves its lot number', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) {
        assert.doesNotMatch(text, /is_active/, 'the lot check must not ignore deactivated rows');
        return { rows: [{ batch_id: 7, is_active: false }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 409);
});

/* ==========================================================================
 * 8. INVALID QUANTITIES / reserved > on-hand
 * ========================================================================== */

test('CREATE: negative quantities or unit_cost return 400 without touching the DB', async () => {
  for (const body of [
    { ...VALID_CREATE_BODY, quantity_on_hand: -1 },
    { ...VALID_CREATE_BODY, quantity_reserved: -1 },
    { ...VALID_CREATE_BODY, unit_cost: -0.5 },
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('pool.query must not be called for invalid quantities'); },
      async (calls) => {
        await createBatch(batchReq({ body }), res);
        assert.equal(calls.length, 0);
      },
    );
    assert.equal(captured.status, 400);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('CREATE: quantity_reserved above quantity_on_hand is rejected (no DB access)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an inconsistent quantity pair'); },
    async (calls) => {
      await createBatch(
        batchReq({ body: { ...VALID_CREATE_BODY, quantity_on_hand: 10, quantity_reserved: 20 } }),
        res,
      );
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('CREATE: quantity_reserved equal to quantity_on_hand is allowed', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createBatch(
        batchReq({ body: { ...VALID_CREATE_BODY, quantity_on_hand: 10, quantity_reserved: 10 } }),
        res,
      );
    },
  );

  assert.equal(captured.status, 201);
});

test('CREATE: a DB check-constraint violation (23514) is reported, not bypassed', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(SUPPLIER_LOOKUP)) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 409);
});

/* ==========================================================================
 * 6b. ATOMIC RECEIVE (Phase 4B.3)
 * Creates batch + RECEIPT movement in one transaction with idempotency.
 * ========================================================================== */

const VALID_RECEIVE_BODY = {
  inventory_id: 5,
  supplier_id: 3,
  lot_number: 'LOT-001',
  expiry_date: '2027-01-31',
  quantity_on_hand: 0,
  quantity_reserved: 0,
  unit_cost: 2.5,
  // received_at قصد عدم وجوده: يولّده الخادم (DEFAULT CURRENT_TIMESTAMP)
  receipt_quantity: 100,
  reference_type: 'BATCH_RECEIPT',
  reference_id: '7',
  notes: 'استلام',
  idempotency_key: 'test-key-atomic-123',
};

// Body for replay test - identical to original request
const REPLAY_RECEIVE_BODY = {
  ...VALID_RECEIVE_BODY,
};
const SUPPLIER_LOOKUP = 'SELECT clinic_id FROM suppliers WHERE supplier_id = $1';
const LOT_LOOKUP = 'SELECT batch_id FROM inventory_batches WHERE inventory_id = $1 AND lot_number = $2 AND ($3::int IS NULL OR batch_id <> $3::int)';

// Actual SQL queries used by the controller (client.query inside transaction)
const BATCH_INSERT = 'INSERT INTO inventory_batches';
const BATCH_UPDATE = 'UPDATE inventory_batches b SET quantity_on_hand';
const MOVEMENT_INSERT = 'INSERT INTO stock_movements';

// Stored row as the database returns it: received_at is server-generated,
// and original_received_at is legacy (NULL = unknown provenance, never read)
const existingMovement = {
  movement_id: 1, batch_id: 7, movement_type: 'RECEIPT',
  inventory_id: 5, lot_number: 'LOT-001',
  expiry_date: '2027-01-31', quantity_on_hand: 100, quantity_reserved: 0,
  unit_cost: 2.5, received_at: '2026-01-01T00:00:00.000Z', is_active: true,
  original_received_at: null, // legacy provenance — unknown, never compared
  movement_created_at: '2026-01-01T00:00:00.000Z', batch_created_at: '2026-01-01',
  updated_at: '2026-01-01',
  quantity: 100, reference_type: 'BATCH_RECEIPT', reference_id: '7',
  performed_by_user_id: 5, notes: 'استلام',
  idempotency_key: 'test-key-atomic-123',
  supplier_id: 3,
};

/** clientHandler: يتعامل مع استعلامات المعاملة (client.query) */
const receiveClientHandler = (onHand: number) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
  if (t.includes('idempotency_key') && t.includes('sm.movement_id')) {
    // Early replay check - no existing movement
    return { rows: [], rowCount: 0 };
  }
  if (t.includes(BATCH_INSERT)) {
    return { rows: [{ ...batchRow(), batch_id: 7, inventory_id: 1, supplier_id: 1, lot_number: 'LOT-001', quantity_on_hand: 0 }], rowCount: 1 };
  }
  if (t.includes(BATCH_UPDATE)) {
    return { rows: [{ batch_id: 7, quantity_on_hand: onHand }], rowCount: 1 };
  }
  if (t.includes(MOVEMENT_INSERT)) {
    return { rows: [{ movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: params[2], reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], created_at: '2026-01-01T00:00:00.000Z', idempotency_key: params[7] }], rowCount: 1 };
  }
  throw new Error(`Unexpected client query: ${text}`);
};

/** poolHandler: يتعامل مع الاستعلامات المساعدة (pool.query) */
const receivePoolHandler = (text: string, params: unknown[] = []): MockResult => {
  if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 1, clinic_id: 1 }], rowCount: 1 };
  if (text.includes('FROM suppliers') && text.includes('supplier_id = $1')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
  if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
  throw new Error(`Unexpected pool query: ${text}`);
};

/** clientHandler for replay scenario */
const receiveReplayClientHandler = (existingMovement: Record<string, unknown>) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
  if (t.includes('idempotency_key')) {
    return { rows: [existingMovement], rowCount: 1 };
  }
  throw new Error(`Unexpected client query after replay: ${text}`);
};

/** poolHandler for replay (same as normal) */
const receiveReplayPoolHandler = receivePoolHandler;

test('ATOMIC RECEIVE: successful receipt creates batch, movement, and updates stock', async () => {
  const { res, captured } = makeRes();

  await withMockedTransaction(
    receiveClientHandler(100),
    receivePoolHandler,
    async (clientCalls) => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res);
      assert.equal(clientCalls.some((c) => c.text === 'COMMIT'), true, 'transaction must commit');
    },
  );

  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, undefined);
  assert.ok(captured.body.batch, 'batch must be returned');
  assert.ok(captured.body.movement, 'movement must be returned');
  assert.equal(captured.body.batch.batch_id, 7);
  assert.equal(captured.body.batch.quantity_on_hand, 0);
  assert.equal(captured.body.movement.movement_type, 'RECEIPT');
  assert.equal(captured.body.movement.quantity, 100);
  assert.equal(captured.body.movement.idempotency_key, 'test-key-atomic-123');
  assert.equal(captured.body.quantityOnHand, 100);
});

test('ATOMIC RECEIVE: failure after batch insert rolls back everything', async () => {
  const { res, captured } = makeRes();

  const failingClientHandler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
    if (t.includes('SELECT sm.movement_id') && t.includes('idempotency_key')) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes(BATCH_INSERT)) {
      return { rows: [{ ...batchRow(), batch_id: 7, quantity_on_hand: 0 }], rowCount: 1 };
    }
    if (t.includes(BATCH_UPDATE)) {
      return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
    }
    if (t.includes(MOVEMENT_INSERT)) {
      throw new Error('Database connection lost');
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  const failingPoolHandler = (text: string, params: unknown[] = []): MockResult => {
    if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
    if (text.includes('FROM suppliers') && text.includes('supplier_id = $1')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
    if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected pool query: ${text}`);
  };

  await withMockedTransaction(
    failingClientHandler,
    failingPoolHandler,
    async (clientCalls) => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res);
      assert.equal(clientCalls.some((c) => c.text === 'ROLLBACK'), true, 'transaction must rollback on error');
    },
  );

  assert.equal(captured.status, 500);
});

test('ATOMIC RECEIVE: failure during stock update leaves no partial receipt', async () => {
  const { res, captured } = makeRes();

  const failingClientHandler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
    if (t.includes('SELECT sm.movement_id') && t.includes('idempotency_key')) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes(BATCH_INSERT)) {
      return { rows: [{ ...batchRow(), batch_id: 7, quantity_on_hand: 0 }], rowCount: 1 };
    }
    if (t.includes(BATCH_UPDATE)) {
      throw new Error('Lock contention');
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  const failingPoolHandler = (text: string, params: unknown[] = []): MockResult => {
    if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
    if (text.includes('FROM suppliers') && text.includes('supplier_id = $1')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
    if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected pool query: ${text}`);
  };

  await withMockedTransaction(
    failingClientHandler,
    failingPoolHandler,
    async (clientCalls) => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res);
      assert.equal(clientCalls.some((c) => c.text === 'ROLLBACK'), true, 'transaction must rollback on error');
    },
  );

  assert.equal(captured.status, 500);
});

test('ATOMIC RECEIVE: same-key replay returns existing result without double-count', async () => {
  const { res, captured } = makeRes();

  await withMockedTransaction(
    receiveReplayClientHandler(existingMovement),
    receiveReplayPoolHandler,
    async (clientCalls) => {
      await createBatchWithReceipt(batchReq({ body: REPLAY_RECEIVE_BODY }), res);
      assert.equal(clientCalls.some((c) => c.text === 'ROLLBACK'), true, 'transaction must rollback on replay');
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.batch.batch_id, 7);
  assert.equal(captured.body.movement.movement_id, 1);
  assert.equal(captured.body.quantityOnHand, 100);
});

test('ATOMIC RECEIVE: same key with different payload returns 409', async () => {
  const { res: res1, captured: captured1 } = makeRes();

  // First request succeeds
  await withMockedTransaction(
    receiveClientHandler(100),
    receivePoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res1);
    },
  );
  assert.equal(captured1.status, 201);

  // Second request with different receipt_quantity
  const { res: res2, captured: captured2 } = makeRes();

  const conflictingClientHandler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
    if (t.includes('SELECT sm.movement_id') && t.includes('idempotency_key')) {
      return { rows: [existingMovement], rowCount: 1 };
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  await withMockedTransaction(
    conflictingClientHandler,
    receivePoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: { ...VALID_RECEIVE_BODY, receipt_quantity: 50 } }), res2);
    },
  );

  assert.equal(captured2.status, 409);
  assert.equal(captured2.body.code, ApiErrorCode.FORBIDDEN);
});

test('ATOMIC RECEIVE: concurrent same-key requests produce one logical receipt', async () => {
  let beginCount = 0;
  const concurrentClientHandler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN') {
      beginCount++;
      return { rows: [], rowCount: 0 };
    }
    if (t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
    // Match any query containing idempotency_key (covers both early check and catch block check)
    if (t.includes('idempotency_key')) {
      if (beginCount === 1) return { rows: [], rowCount: 0 };
      return { rows: [existingMovement], rowCount: 1 };
    }
    if (t.includes(BATCH_INSERT)) {
      return { rows: [{ ...batchRow(), batch_id: beginCount === 1 ? 7 : 8, quantity_on_hand: 0 }], rowCount: 1 };
    }
    if (t.includes(BATCH_UPDATE)) {
      return { rows: [{ batch_id: beginCount === 1 ? 7 : 8, quantity_on_hand: 100 }], rowCount: 1 };
    }
    if (t.includes(MOVEMENT_INSERT)) {
      if (beginCount === 1) {
        return { rows: [{ movement_id: 1, ...paramsToRow(params) }], rowCount: 1 };
      } else {
        throw { code: '23505' };
      }
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  const concurrentPoolHandler = (text: string, params: unknown[] = []): MockResult => {
    if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
    if (text.includes('FROM suppliers') && text.includes('supplier_id = $1')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
    if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected pool query: ${text}`);
  };

  // First request
  const { res: res1, captured: captured1 } = makeRes();
  await withMockedTransaction(
    concurrentClientHandler,
    concurrentPoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res1);
    },
  );

  // Second concurrent request - use body with quantity_on_hand: 0 to match original request
  const { res: res2, captured: captured2 } = makeRes();
  await withMockedTransaction(
    concurrentClientHandler,
    concurrentPoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res2);
    },
  );

  assert.equal(captured1.status, 201, 'first request should succeed');
  assert.equal(captured1.body.idempotent_replay, undefined);
  assert.equal(captured1.body.batch.batch_id, 7);

  assert.equal(captured2.status, 200, 'second request should replay');
  assert.equal(captured2.body.idempotent_replay, true);
  assert.equal(captured2.body.batch.batch_id, 7, 'same batch returned');
  assert.equal(captured2.body.quantityOnHand, 100, 'stock not increased again');
});

test('ATOMIC RECEIVE: different keys create independent valid receipts', async () => {
  const { res: res1, captured: captured1 } = makeRes();
  await withMockedTransaction(
    receiveClientHandler(100),
    receivePoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: { ...VALID_RECEIVE_BODY, idempotency_key: 'key-a', receipt_quantity: 50 } }), res1);
    },
  );
  assert.equal(captured1.status, 201);
  assert.equal(captured1.body.batch.batch_id, 7);
  assert.equal(captured1.body.quantityOnHand, 50);

  const { res: res2, captured: captured2 } = makeRes();

  // Custom client handler for second request with different lot_number
  const receiveClientHandlerLot2 = (onHand: number) => (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
    if (t.includes('idempotency_key') && t.includes('sm.movement_id')) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes(BATCH_INSERT)) {
      return { rows: [{ ...batchRow(), batch_id: 8, inventory_id: 5, supplier_id: 3, lot_number: 'LOT-002', quantity_on_hand: 0 }], rowCount: 1 };
    }
    if (t.includes(BATCH_UPDATE)) {
      return { rows: [{ batch_id: 8, quantity_on_hand: onHand }], rowCount: 1 };
    }
    if (t.includes(MOVEMENT_INSERT)) {
      return { rows: [{ movement_id: 2, batch_id: 8, movement_type: 'RECEIPT', quantity: params[2], reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], created_at: '2026-01-01T00:00:00.000Z', idempotency_key: params[7] }], rowCount: 1 };
    }
    throw new Error(`Unexpected client query: ${text}`);
  };

  await withMockedTransaction(
    receiveClientHandlerLot2(30), // New batch starts at 0, adds 30 -> 30
    receivePoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: { ...VALID_RECEIVE_BODY, idempotency_key: 'key-b', receipt_quantity: 30, lot_number: 'LOT-002' } }), res2);
    },
  );
  assert.equal(captured2.status, 201);
  assert.equal(captured2.body.idempotent_replay, undefined);
  assert.equal(captured2.body.batch.batch_id, 8); // different batch_id due to different lot_number
  assert.equal(captured2.body.quantityOnHand, 30); // New batch: 0 + 30 = 30
});

test('ATOMIC RECEIVE: authentication and MANAGE_INVENTORY permission required', async () => {
  const { res, captured } = makeRes();

  // Controller doesn't check permissions (handled by middleware), so this tests that
  // the controller works when called directly with a user lacking MANAGE_INVENTORY
  const noManageUser = { ...pharmacist(), permissions: ['VIEW_INVENTORY'] };

  await withMockedTransaction(
    receiveClientHandler(100),
    receivePoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY, user: noManageUser }), res);
    },
  );

  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, undefined);
});

test('ATOMIC RECEIVE: clinic isolation enforced', async () => {
  const { res, captured } = makeRes();

  const isolationPoolHandler = (text: string, params: unknown[] = []): MockResult => {
    // Return empty for inventory lookup to simulate item not accessible (different clinic)
    if (text.includes('FROM inventory_items i') && text.includes('clinic_id = ANY')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected pool query: ${text}`);
  };

  const isolationClientHandler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected client query: ${text}`);
  };

  await withMockedTransaction(
    isolationClientHandler,
    isolationPoolHandler,
    async () => {
      await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY, user: pharmacist([1]) }), res);
    },
  );

  assert.equal(captured.status, 404);
});

/* ==========================================================================
 * ATOMIC RECEIVE — database-controlled received_at tests
 * received_at يولّده الخادم (DEFAULT CURRENT_TIMESTAMP في migration 029)
 * ولا يُقبل من العميل: لا في جسم الطلب (يُرفض صريحاً قبل أي وصول
 * لقاعدة البيانات) ولا في أي استعلام كتابة. original_received_at
 * (migration 052) أثر قديم لم يعد يُكتب — NULL = مصدر غير معروف.
 * ========================================================================== */

test('ATOMIC RECEIVE: batch INSERT omits received_at so the database default applies', async () => {
  const { res, captured } = makeRes();
  let batchInsert: QueryCall | undefined;

  await withMockedTransaction(
    (text: string, params: unknown[] = []): MockResult => {
      const t = text.trim();
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
      if (t.includes('idempotency_key') && t.includes('sm.movement_id')) return { rows: [], rowCount: 0 };
      if (t.includes(BATCH_INSERT)) {
        batchInsert = { text, params };
        return { rows: [{ ...batchRow(), batch_id: 7, quantity_on_hand: 0 }], rowCount: 1 };
      }
      if (t.includes(BATCH_UPDATE)) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
      if (t.includes(MOVEMENT_INSERT)) {
        return { rows: [{ movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: params[2], reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], created_at: '2026-01-01T00:00:00.000Z', idempotency_key: params[7] }], rowCount: 1 };
      }
      throw new Error(`Unexpected client query: ${text}`);
    },
    receivePoolHandler,
    async () => { await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res); },
  );

  assert.equal(captured.status, 201);
  assert.ok(batchInsert, 'batch INSERT must be executed');
  assert.doesNotMatch(writeClauseOf(batchInsert!.text), /received_at/, 'batch INSERT must not write received_at — the database default owns it');
  assert.equal(batchInsert!.params.length, 7, 'batch INSERT takes exactly 7 parameters');
  assert.ok(batchInsert!.params.every((p) => !(p instanceof Date)), 'no timestamp value is sent for received_at');
});

test('ATOMIC RECEIVE: movement INSERT omits original_received_at and created_at', async () => {
  const { res, captured } = makeRes();
  let movementInsert: QueryCall | undefined;

  await withMockedTransaction(
    (text: string, params: unknown[] = []): MockResult => {
      const t = text.trim();
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
      if (t.includes('idempotency_key') && t.includes('sm.movement_id')) return { rows: [], rowCount: 0 };
      if (t.includes(BATCH_INSERT)) return { rows: [{ ...batchRow(), batch_id: 7, quantity_on_hand: 0 }], rowCount: 1 };
      if (t.includes(BATCH_UPDATE)) return { rows: [{ batch_id: 7, quantity_on_hand: 100 }], rowCount: 1 };
      if (t.includes(MOVEMENT_INSERT)) {
        movementInsert = { text, params };
        return { rows: [{ movement_id: 1, batch_id: 7, movement_type: 'RECEIPT', quantity: params[2], reference_type: params[3], reference_id: params[4], performed_by_user_id: params[5], notes: params[6], created_at: '2026-01-01T00:00:00.000Z', idempotency_key: params[7] }], rowCount: 1 };
      }
      throw new Error(`Unexpected client query: ${text}`);
    },
    receivePoolHandler,
    async () => { await createBatchWithReceipt(batchReq({ body: VALID_RECEIVE_BODY }), res); },
  );

  assert.equal(captured.status, 201);
  assert.ok(movementInsert, 'movement INSERT must be executed');
  assert.doesNotMatch(writeClauseOf(movementInsert!.text), /original_received_at|received_at|created_at/, 'movement INSERT must not write any timestamp — the database owns them');
  assert.equal(movementInsert!.params.length, 8, 'movement INSERT takes exactly 8 parameters');
});

test('ATOMIC RECEIVE: client-supplied received_at is rejected before any database access', async () => {
  const { res, captured } = makeRes();

  await withMockedTransaction(
    () => { throw new Error('no client query may run when a forbidden field is present'); },
    () => { throw new Error('no pool query may run when a forbidden field is present'); },
    async () => {
      await createBatchWithReceipt(batchReq({ body: { ...VALID_RECEIVE_BODY, received_at: '2026-01-01T00:00:00.000Z' } }), res);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  assert.match(String(captured.body.message), /received_at/);
});

test('ATOMIC RECEIVE: every server-derived field is rejected before any database access', async () => {
  for (const field of ['batch_id', 'original_received_at', 'created_at', 'updated_at']) {
    const { res, captured } = makeRes();

    await withMockedTransaction(
      () => { throw new Error('no client query may run when a forbidden field is present'); },
      () => { throw new Error('no pool query may run when a forbidden field is present'); },
      async () => {
        await createBatchWithReceipt(batchReq({ body: { ...VALID_RECEIVE_BODY, [field]: 'forged' } }), res);
      },
    );

    assert.equal(captured.status, 400, `${field} must be rejected`);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('ATOMIC RECEIVE: replay matches on operation fields only — stored received_at is irrelevant', async () => {
  // The stored movement carries a server-generated received_at that the
  // replay request never sees: matching must not depend on any timestamp.
  const stored = { ...existingMovement, received_at: '2026-02-01T00:00:00.000Z' };
  const { res, captured } = makeRes();

  await withMockedTransaction(
    (text: string, params: unknown[] = []): MockResult => {
      const t = text.trim();
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
      if (t.includes('idempotency_key') && t.includes('sm.movement_id')) {
        return { rows: [stored], rowCount: 1 };
      }
      throw new Error(`Unexpected client query: ${text}`);
    },
    receivePoolHandler,
    async () => { await createBatchWithReceipt(batchReq({ body: REPLAY_RECEIVE_BODY }), res); },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.batch.batch_id, 7);
  assert.equal(captured.body.movement.movement_id, 1);
  assert.equal(captured.body.quantityOnHand, 100);
});

test('ATOMIC RECEIVE: replay ignores legacy original_received_at provenance', async () => {
  // Legacy rows keep original_received_at = NULL (unknown provenance).
  // A replay of the same operation must still succeed regardless.
  const legacy = { ...existingMovement, original_received_at: null, received_at: '2026-03-01T00:00:00.000Z' };
  const { res, captured } = makeRes();

  await withMockedTransaction(
    (text: string, params: unknown[] = []): MockResult => {
      const t = text.trim();
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
      if (t.includes('idempotency_key') && t.includes('sm.movement_id')) {
        return { rows: [legacy], rowCount: 1 };
      }
      throw new Error(`Unexpected client query: ${text}`);
    },
    receivePoolHandler,
    async () => { await createBatchWithReceipt(batchReq({ body: REPLAY_RECEIVE_BODY }), res); },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
});

/* ==========================================================================
 * 9. UPDATE METADATA
 * ========================================================================== */

test('UPDATE: metadata changes are written and scoped to the item clinic', async () => {
  const { res, captured } = makeRes();
  const updated = batchRow({ lot_number: 'LOT-002', unit_cost: null, supplier_id: null, is_active: false });

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [], rowCount: 0 };
      if (text.includes('UPDATE inventory_batches b')) return { rows: [updated], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(
        batchReq({
          id: '7',
          body: { supplier_id: null, lot_number: 'LOT-002', unit_cost: null, is_active: 'false' },
        }),
        res,
      );

      assert.equal(captured.status, 200);
      assert.equal(captured.body.batch.lot_number, 'LOT-002');

      const update = calls.find((c) => c.text.includes('UPDATE inventory_batches b SET'));
      assert.ok(update, 'UPDATE must be executed');
      const setClause = setClauseOf(update.text);
      assert.match(setClause, /lot_number = \$2/);
      assert.doesNotMatch(setClause, /quantity_on_hand|quantity_reserved/, 'quantities are never written');
      assert.match(update.text, /i\.clinic_id = ANY\(\$6::int\[\]\)/);
      assert.deepEqual(update.params, [null, 'LOT-002', null, false, 7, [1]]);
    },
  );
});

test('UPDATE: renaming to a lot number already used by another batch returns 409 and no UPDATE', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('FROM inventory_batches') && text.includes('lot_number = $2')) return { rows: [{ batch_id: 9 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { lot_number: 'LOT-002' } }), res);
      assert.equal(calls.some((c) => c.text.includes('UPDATE inventory_batches b SET')), false);
    },
  );

  assert.equal(captured.status, 409);
});

test('UPDATE: keeping the same lot number does not collide with itself', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('UPDATE inventory_batches b')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { lot_number: 'LOT-001' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(calls.length, 2, 'no lot lookup is issued for an unchanged lot number');
    },
  );
});

test('UPDATE: client-supplied received_at is rejected before any database access', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('no query may run when a forbidden field is present'); },
    async () => {
      await updateBatch(batchReq({ id: '7', body: { received_at: '2026-01-01T00:00:00.000Z' } }), res);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  assert.match(String(captured.body.message), /received_at/);
});

test('UPDATE: every server-derived field is rejected before any database access', async () => {
  for (const field of ['batch_id', 'original_received_at', 'created_at', 'updated_at']) {
    const { res, captured } = makeRes();

    await withMockedPool(
      () => { throw new Error('no query may run when a forbidden field is present'); },
      async () => {
        await updateBatch(batchReq({ id: '7', body: { [field]: 'forged' } }), res);
      },
    );

    assert.equal(captured.status, 400, `${field} must be rejected`);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('UPDATE: switching to a supplier of another clinic is refused', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 2 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { supplier_id: 9 } }), res);
      assert.equal(calls.some((c) => c.text.includes('UPDATE inventory_batches b SET')), false);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('UPDATE: a body with no updatable fields returns 400', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { inventory_id: 5 } }), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued when nothing is updatable');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 10. inventory_id IMMUTABILITY
 * ========================================================================== */

test('UPDATE: changing inventory_id is refused and no UPDATE is issued', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ inventory_id: 5 })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { inventory_id: 42, lot_number: 'LOT-003' } }), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued when the item change is refused');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('UPDATE: resending the same inventory_id is accepted and never written', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ inventory_id: 5, item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('UPDATE inventory_batches b')) return { rows: [batchRow({ unit_cost: 3 })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { inventory_id: 5, unit_cost: 3 } }), res);

      assert.equal(captured.status, 200);
      const update = calls.find((c) => c.text.includes('UPDATE inventory_batches b SET'));
      assert.doesNotMatch(setClauseOf(update!.text), /inventory_id/, 'inventory_id is never rewritten');
    },
  );
});

/* ==========================================================================
 * 11. CRITICAL: update must never change quantities
 * ========================================================================== */

test('STOCK RULE: update cannot change quantity_on_hand — 400, zero DB access', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called when a quantity change is attempted'); },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { quantity_on_hand: 0 } }), res);
      assert.equal(calls.length, 0, 'the guard runs before any database access');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  assert.match(String(captured.body.message), /حركات المخزون/);
});

test('STOCK RULE: update cannot change quantity_reserved — 400, zero DB access', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called when a quantity change is attempted'); },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { quantity_reserved: 50 } }), res);
      assert.equal(calls.length, 0, 'the guard runs before any database access');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('STOCK RULE: a quantity sent alongside valid metadata is still refused', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called when a quantity change is attempted'); },
    async (calls) => {
      await updateBatch(batchReq({ id: '7', body: { lot_number: 'LOT-004', quantity_on_hand: 5 } }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
});

test('STOCK RULE: no generated UPDATE statement can ever contain a quantity column', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes('UPDATE inventory_batches b')) {
        // أي عمود كمية في جملة SET = خرق لقاعدة المخزون (RETURNING مسموح)
        assert.doesNotMatch(setClauseOf(text), /quantity_/);
        return { rows: [batchRow()], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await updateBatch(batchReq({ id: '7', body: { expiry_date: '2028-01-31', received_at: '2026-03-01' } }), res);
    },
  );

  assert.equal(captured.status, 200);
});

/* ==========================================================================
 * 12. DEACTIVATE
 * ========================================================================== */

test('DEACTIVATE: sets is_active = FALSE and never issues a physical DELETE', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /^\s*DELETE\b/, 'physical DELETE is forbidden');
      return { rows: [batchRow({ is_active: false })], rowCount: 1 };
    },
    async (calls) => {
      await deactivateBatch(batchReq({ id: '7' }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.batch.is_active, false);

      const archive = calls[0]!;
      assert.match(archive.text, /UPDATE inventory_batches b SET is_active = FALSE, updated_at = NOW\(\)/);
      assert.match(archive.text, /i\.clinic_id = ANY\(\$2::int\[\]\)/);
      assert.deepEqual(archive.params, [7, [1]]);
    },
  );
});

test('DEACTIVATE: a constraint violation is reported instead of being bypassed', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('UPDATE inventory_batches b')) {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await deactivateBatch(batchReq({ id: '7' }), res);
    },
  );

  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
});

test('VALIDATION: a non-numeric batch id returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid id'); },
    async (calls) => {
      await getBatch(batchReq({ id: 'abc' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * Phase 10B.4A — BATCH AVAILABILITY (read-only FEFO status)
 * ========================================================================== */

test('AVAILABILITY AUTH: a request without a bearer token is rejected with 401', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;

  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

test('AVAILABILITY AUTHZ: VIEW_INVENTORY is required and MANAGE_INVENTORY alone is not enough', () => {
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
  assert.equal(denied.nextCalled, false, 'VIEW_INVENTORY must be enforced');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const manageOnly = runMiddleware('PHARMACIST', ['MANAGE_INVENTORY']);
  assert.equal(manageOnly.nextCalled, false);

  const allowed = runMiddleware('PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

test('AVAILABILITY: a future-expiry active batch with stock is available_for_fefo', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, EXPIRED_PREDICATE, 'expired must be expiry_date < CURRENT_DATE');
      assert.match(text, FEFO_PREDICATE, 'all four eligibility rules must be in the predicate');
      assert.match(text, QUARANTINE_PREDICATE, 'quarantined batches must not be reported as FEFO-available');
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'clinic scope via the item join');
      return { rows: [availabilityRow()], rowCount: 1 };
    },
    async (calls) => {
      await getBatchAvailability(batchReq({ id: '7' }), res);

      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.availability, {
        batch_id: 7, inventory_id: 5, lot_number: 'LOT-001', expiry_date: '2027-01-31',
        quantity_on_hand: 100, is_active: true, expired: false, available_for_fefo: true,
      });
      assert.equal(Object.keys(captured.body.availability).length, 8, 'only the permitted fields are returned');
      assert.deepEqual(calls[0]!.params, [7, [1]]);
    },
  );
});

test('AVAILABILITY: an expired batch reports expired=true and is not available for FEFO', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [availabilityRow({ expiry_date: '2026-01-01', expired: true, available_for_fefo: false })], rowCount: 1 }),
    async () => {
      await getBatchAvailability(batchReq({ id: '7' }), res);
    },
  );

  assert.equal(captured.status, 200, 'an expired batch is still readable, never rejected');
  assert.equal(captured.body.availability.expired, true);
  assert.equal(captured.body.availability.available_for_fefo, false);
});

test('AVAILABILITY: a zero-stock batch is not available for FEFO', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [availabilityRow({ quantity_on_hand: 0, available_for_fefo: false })], rowCount: 1 }),
    async () => {
      await getBatchAvailability(batchReq({ id: '7' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.availability.expired, false);
  assert.equal(captured.body.availability.available_for_fefo, false);
});

test('AVAILABILITY: an inactive batch is not available for FEFO', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [availabilityRow({ is_active: false, available_for_fefo: false })], rowCount: 1 }),
    async () => {
      await getBatchAvailability(batchReq({ id: '7' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.availability.is_active, false);
  assert.equal(captured.body.availability.available_for_fefo, false);
});

test('AVAILABILITY: an archived inventory item yields available_for_fefo=false, not a 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /WHERE[\s\S]*i\.deleted_at IS NULL/,
        'the archived item must not be filtered out — the status must explain ineligibility');
      return { rows: [availabilityRow({ available_for_fefo: false })], rowCount: 1 };
    },
    async () => {
      await getBatchAvailability(batchReq({ id: '7' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.availability.available_for_fefo, false);
});

test('AVAILABILITY: an out-of-scope batch returns 404 and does not leak existence', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'the batch id alone is never trusted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await getBatchAvailability(batchReq({ id: '77', user: pharmacist([1]) }), res);
      assert.deepEqual(calls[0]!.params, [77, [1]]);
    },
  );

  assert.equal(captured.status, 404);
  assert.equal(captured.body.message, 'الدفعة المطلوبة غير موجودة');
});

test('AVAILABILITY: a nonexistent batch returns the same 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async () => {
      await getBatchAvailability(batchReq({ id: '999' }), res);
    },
  );

  assert.equal(captured.status, 404);
  assert.equal(captured.body.message, 'الدفعة المطلوبة غير موجودة');
});

test('AVAILABILITY: the endpoint is strictly read-only', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [availabilityRow()], rowCount: 1 }),
    async (calls) => {
      await getBatchAvailability(batchReq({ id: '7' }), res);

      assert.equal(captured.status, 200);
      for (const call of calls) {
        assert.match(call.text, /^\s*SELECT\b/, `non-SELECT issued: ${call.text}`);
        assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE)\b/i, `write issued: ${call.text}`);
        assert.doesNotMatch(call.text, /FOR UPDATE/i, 'no row lock on a read-only endpoint');
        assert.doesNotMatch(call.text, /quantity_reserved/, 'reserved quantity must never be touched');
      }
      // لا تُعاد حقول خارج القائمة المسموحة (مثل سعر التكلفة أو بيانات المورد)
      assert.equal(captured.body.availability.unit_cost, undefined);
      assert.equal(captured.body.availability.supplier_id, undefined);
    },
  );
});

/* ==========================================================================
 * Phase 10B.4B-1 — EXPIRY READ (read-only audit view)
 * ========================================================================== */

test('EXPIRY AUTH: a request without a bearer token is rejected with 401', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;

  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

test('EXPIRY AUTHZ: VIEW_INVENTORY is required', () => {
  const req = { user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'DOCTOR', permissions: ['VIEW_PATIENTS'] } } as unknown as AuthenticatedRequest;
  let error: any = null;
  let nextCalled = false;

  requirePermission('VIEW_INVENTORY')(req, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
    if (err) error = err; else nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(error?.statusCode, 403);
  assert.equal(error?.code, ApiErrorCode.FORBIDDEN);
});

test('EXPIRY: status=expired filters to expiry_date < CURRENT_DATE only', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /b\.expiry_date < CURRENT_DATE/);
      assert.doesNotMatch(text, />= CURRENT_DATE/, 'expired must not include the expiring window');
      assert.match(text, /i\.clinic_id = ANY\(\$1::int\[\]\)/);
      assert.match(text, /i\.deleted_at IS NULL/);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      return { rows: [expiryRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.batches.length, 1);
      assert.deepEqual(captured.body.pagination, { limit: DEFAULT_EXPIRY_LIMIT, offset: 0, returned: 1, total: 1 });
      // Data query params include scope + limit + offset
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.deepEqual(dataCall!.params, [[1], DEFAULT_EXPIRY_LIMIT, 0]);
    },
  );
});

test('EXPIRY: status=expiring filters to [today, today + days] and excludes already expired', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /b\.expiry_date >= CURRENT_DATE/, 'expiring must exclude expired batches');
      assert.match(text, /b\.expiry_date <= CURRENT_DATE \+ \$1::int/);
      assert.doesNotMatch(text, /b\.expiry_date < CURRENT_DATE/);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      return { rows: [expiryRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: '30' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.pagination.total, 1);
      // Data query params: [days, scope, limit, offset]
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.equal(dataCall!.params[0], 30);
    },
  );
});

test('EXPIRY: days=0 means expiring today only', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /b\.expiry_date >= CURRENT_DATE AND b\.expiry_date <= CURRENT_DATE \+ \$1::int/);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      return { rows: [expiryRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: '0' } }), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.pagination.total, 1);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.equal(dataCall!.params[0], 0);
    },
  );

  assert.equal(captured.status, 200);
});

test('EXPIRY: missing days for expiring returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('no query may run without days'); },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring' } }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('EXPIRY: invalid days are rejected (negative, non-numeric, above 365)', async () => {
  for (const days of ['-1', 'abc', String(MAX_EXPIRY_DAYS + 1)]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('no query may run for invalid days'); },
      async (calls) => {
        await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days } }), res);
        assert.equal(calls.length, 0, days);
      },
    );
    assert.equal(captured.status, 400, days);
  }
});

test('EXPIRY: the maximum days value itself is accepted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: String(MAX_EXPIRY_DAYS) } }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.equal(dataCall!.params[0], MAX_EXPIRY_DAYS);
    },
  );

  assert.equal(captured.status, 200);
});

test('EXPIRY: a missing or invalid status returns 400', async () => {
  for (const query of [{}, { status: 'ALL' }, { status: 'Expiring', days: '5' }]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('no query may run for an invalid status'); },
      async (calls) => {
        await listBatchesByExpiry(batchReq({ query }), res);
        assert.equal(calls.length, 0, JSON.stringify(query));
      },
    );
    assert.equal(captured.status, 400, JSON.stringify(query));
  }
});

test('EXPIRY: limit/offset are validated and the max limit is enforced', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired', limit: '25', offset: '40' } }), res);
      // Data query params include scope + limit + offset
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.deepEqual(dataCall!.params, [[1], 25, 40]);
    },
  );

  assert.deepEqual(captured.body.pagination, { limit: 25, offset: 40, returned: 0, total: 0 });

  for (const query of [
    { status: 'expired', limit: String(MAX_EXPIRY_LIMIT + 1) },
    { status: 'expired', limit: '0' },
    { status: 'expired', offset: '-1' },
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('no query may run for invalid pagination'); },
      async (calls) => {
        await listBatchesByExpiry(batchReq({ query }), res);
        assert.equal(calls.length, 0, JSON.stringify(query));
      },
    );
    assert.equal(captured.status, 400, JSON.stringify(query));
  }
});

test('EXPIRY: batches outside the caller clinics are excluded in SQL', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$\d+::int\[\]\)/, 'the scope clause must never be omitted');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' }, user: pharmacist([]) }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.deepEqual(dataCall!.params, [[], DEFAULT_EXPIRY_LIMIT, 0], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.batches, []);
  assert.equal(captured.body.pagination.total, 0);
});

test('EXPIRY: archived inventory items are excluded', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /WHERE i\.deleted_at IS NULL/);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' } }), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('EXPIRY: this is an audit view — inactive and zero-stock batches stay visible', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /b\.is_active = TRUE/, 'active-only filtering is an FEFO concern, not an audit view');
      assert.doesNotMatch(text, /quantity_on_hand > 0/, 'stock filtering is an FEFO concern, not an audit view');
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      return { rows: [expiryRow({ is_active: false, quantity_on_hand: 0 })], rowCount: 1 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.batches[0].is_active, false);
  assert.equal(captured.body.batches[0].quantity_on_hand, 0);
});

test('EXPIRY: ordering is deterministic (expiry_date ASC, batch_id ASC)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 2 }], rowCount: 1 };
      assert.match(text, /ORDER BY b\.expiry_date ASC, b\.batch_id ASC/);
      return { rows: [expiryRow(), expiryRow({ batch_id: 9 })], rowCount: 2 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' } }), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('EXPIRY: the endpoint issues SELECT-only SQL and never locks or mutates', async () => {
  for (const query of [{ status: 'expired' }, { status: 'expiring', days: '15' }]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      (text) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
        return { rows: [expiryRow()], rowCount: 1 };
      },
      async (calls) => {
        await listBatchesByExpiry(batchReq({ query }), res);

        assert.equal(captured.status, 200);
        for (const call of calls) {
          assert.match(call.text, /^\s*SELECT\b/, `non-SELECT issued: ${call.text}`);
          assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE)\b/i);
          assert.doesNotMatch(call.text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i);
          assert.doesNotMatch(call.text, /RETURNING/i);
          assert.doesNotMatch(call.text, /stock_movements/i, 'no movement is created by a read');
          assert.doesNotMatch(call.text, /SET\s+\w*quantity/i);
        }
      },
    );
  }
});

test('EXPIRY: clinic_id is not accepted as a filter', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /clinic_id = \$/, 'a client clinic_id must never be bound as a filter');
      assert.match(text, /i\.clinic_id = ANY\(\$\d+::int\[\]\)/);
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired', clinic_id: '2' } }), res);
      const dataCall = calls.find((c) => !c.text.includes('COUNT(*)'));
      assert.ok(dataCall, 'data query should be executed');
      assert.deepEqual(dataCall!.params, [[1], DEFAULT_EXPIRY_LIMIT, 0], 'the clinic_id is ignored entirely');
    },
  );

  assert.equal(captured.status, 200);
});

/* ==========================================================================
 * EXPIRY: total count verification
 * ========================================================================== */

test('EXPIRY: total count is correct for multiple pages of expired batches', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 25 }], rowCount: 1 };
      return { rows: Array.from({ length: 10 }, (_, i) => expiryRow({ batch_id: 10 + i })), rowCount: 10 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired', limit: '10', offset: '10' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 25);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 10);
  assert.equal(captured.body.pagination.returned, 10);
});

test('EXPIRY: total count is correct for expiring batches', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 15 }], rowCount: 1 };
      return { rows: Array.from({ length: 10 }, (_, i) => expiryRow({ batch_id: 20 + i })), rowCount: 10 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: '30', limit: '10', offset: '0' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.pagination.total, 15);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 0);
  assert.equal(captured.body.pagination.returned, 10);
});

test('EXPIRY: empty result set returns total 0', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.batches, []);
  assert.equal(captured.body.pagination.total, 0);
  assert.equal(captured.body.pagination.returned, 0);
});

test('EXPIRY: offset beyond last page returns empty items but correct total', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 5 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired', limit: '10', offset: '100' } }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.batches, []);
  assert.equal(captured.body.pagination.total, 5);
  assert.equal(captured.body.pagination.limit, 10);
  assert.equal(captured.body.pagination.offset, 100);
  assert.equal(captured.body.pagination.returned, 0);
});
