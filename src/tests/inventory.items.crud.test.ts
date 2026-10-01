import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listInventoryItems,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  archiveInventoryItem,
} from '../modules/inventory/inventory.controller';

/* ==========================================================================
 * Phase 10B.2A — Inventory Items backend (direct controller tests, mocked pool.query)
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
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds,
});

const superAdmin = {
  userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [] as string[], clinicIds: [] as number[],
};

const itemRow = (over: Record<string, unknown> = {}): QueryRow => ({
  inventory_id: 5, clinic_id: 1, medication_id: 11, uom: 'TABLET',
  min_stock: 10, reorder_point: 20, max_stock: 100,
  created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
});

const inventoryReq = (
  opts: { body?: Record<string, unknown>; id?: string; query?: Record<string, unknown>; user?: unknown } = {},
): AuthenticatedRequest =>
  ({
    body: opts.body ?? {},
    params: opts.id === undefined ? {} : { id: opts.id },
    query: opts.query ?? {},
    user: opts.user ?? pharmacist(),
  } as unknown as AuthenticatedRequest);

const VALID_CREATE_BODY = {
  clinic_id: 1, medication_id: 11, uom: 'tablet',
  min_stock: 10, reorder_point: 20, max_stock: 100,
};

/* ==========================================================================
 * 1. LIST (VIEW_INVENTORY)
 * ========================================================================== */

test('LIST: authorized user gets active items scoped to their clinics only', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /FROM inventory_items i/);
      assert.match(text, /i\.deleted_at IS NULL/, 'archived items must be filtered out');
      return { rows: [itemRow()], rowCount: 1 };
    },
    async (calls) => {
      await listInventoryItems(inventoryReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.inventoryItems.length, 1);

      const list = calls[0]!;
      assert.match(list.text, /i\.clinic_id = ANY\(\$1::int\[\]\)/, 'clinic scope must be applied in SQL');
      assert.deepEqual(list.params[0], [1], 'scope must be the assigned clinic ids');
    },
  );
});

test('LIST: admin sees every clinic and the optional clinic_id filter is honoured', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [itemRow()], rowCount: 1 }),
    async (calls) => {
      await listInventoryItems(inventoryReq({ query: { clinic_id: '3' }, user: superAdmin }), res);

      assert.equal(captured.status, 200);
      const list = calls[0]!;
      assert.doesNotMatch(list.text, /ANY\(/, 'admin scope is unlimited');
      assert.match(list.text, /i\.clinic_id = \$1/);
      assert.equal(list.params[0], 3);
    },
  );
});

/* ==========================================================================
 * 2. CREATE (MANAGE_INVENTORY)
 * ========================================================================== */

test('CREATE: valid body persists the item and returns 201', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM medications')) return { rows: [{ medication_id: 11 }], rowCount: 1 };
      if (text.includes('FROM inventory_items')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_items')) return { rows: [itemRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY } }), res);

      assert.equal(captured.status, 201);
      assert.equal(captured.body.inventoryItem.inventory_id, 5);

      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_items'));
      assert.ok(insert, 'INSERT must be executed');
      assert.deepEqual(insert.params, [1, 11, 'TABLET', 10, 20, 100], 'uom normalised to upper case');
    },
  );
});

test('CREATE: null max_stock is stored as NULL (never coerced to 0)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM medications')) return { rows: [{ medication_id: 11 }], rowCount: 1 };
      if (text.includes('FROM inventory_items')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_items')) return { rows: [itemRow({ max_stock: null })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      const { min_stock, reorder_point, max_stock, ...body } = VALID_CREATE_BODY;
      await createInventoryItem(inventoryReq({ body }), res);

      assert.equal(captured.status, 201);
      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_items'));
      assert.equal(insert!.params[3], 0, 'min_stock defaults to 0');
      assert.equal(insert!.params[4], 0, 'reorder_point defaults to 0');
      assert.equal(insert!.params[5], null, 'max_stock stays NULL');
    },
  );
});

/* ==========================================================================
 * 3. UPDATE (MANAGE_INVENTORY)
 * ========================================================================== */

test('UPDATE: valid update returns 200 and writes only the supplied fields', async () => {
  const { res, captured } = makeRes();
  const updated = itemRow({ uom: 'BOTTLE', min_stock: 5, reorder_point: 30, max_stock: 90 });

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i')) return { rows: [itemRow()], rowCount: 1 };
      if (text.includes('UPDATE inventory_items SET')) return { rows: [updated], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateInventoryItem(
        inventoryReq({ id: '5', body: { uom: 'bottle', min_stock: 5, reorder_point: 30, max_stock: 90 } }),
        res,
      );

      assert.equal(captured.status, 200);
      assert.equal(captured.body.inventoryItem.uom, 'BOTTLE');

      const update = calls.find((c) => c.text.includes('UPDATE inventory_items SET'));
      assert.ok(update, 'UPDATE must be executed');
      const setClause = update.text.slice(update.text.indexOf('SET'), update.text.indexOf(' WHERE '));
      assert.match(setClause, /uom = \$1/);
      assert.doesNotMatch(setClause, /clinic_id/, 'clinic_id is never rewritten');
      assert.match(update.text, /AND deleted_at IS NULL/);
      assert.match(update.text, /inventory_items\.clinic_id = ANY\(\$6::int\[\]\)/);
      assert.deepEqual(update.params.slice(0, 4), ['BOTTLE', 5, 30, 90]);
      assert.deepEqual(update.params[4], 5, 'inventory id placeholder');
      assert.deepEqual(update.params[5], [1], 'clinic scope is the assigned clinic ids');
    },
  );
});

test('UPDATE: partial max_stock is validated against the stored reorder_point', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i')) return { rows: [itemRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      // stored reorder_point is 20, so max_stock 15 must be rejected without any UPDATE
      await updateInventoryItem(inventoryReq({ id: '5', body: { max_stock: 15 } }), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued for an inconsistent threshold pair');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('UPDATE: item outside the caller clinic scope returns 404 and never updates', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateInventoryItem(inventoryReq({ id: '5', body: { min_stock: 1 } }), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued when the scoped lookup returns nothing');
    },
  );

  assert.equal(captured.status, 404);
});

/* ==========================================================================
 * 4. ARCHIVE (soft delete only)
 * ========================================================================== */

test('ARCHIVE: sets deleted_at and never issues a physical DELETE', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /^\s*DELETE\b/, 'physical DELETE is forbidden');
      return { rows: [itemRow({ deleted_at: '2026-09-29 10:00:00' })], rowCount: 1 };
    },
    async (calls) => {
      await archiveInventoryItem(inventoryReq({ id: '5' }), res);

      assert.equal(captured.status, 200);
      const archive = calls[0]!;
      assert.match(archive.text, /UPDATE inventory_items SET deleted_at = NOW\(\)/);
      assert.match(archive.text, /AND deleted_at IS NULL/);
      assert.match(archive.text, /inventory_items\.clinic_id = ANY\(\$2::int\[\]\)/);
      assert.deepEqual(archive.params, [5, [1]]);
    },
  );
});

test('ARCHIVE: already-archived or unknown item returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async () => {
      await archiveInventoryItem(inventoryReq({ id: '999' }), res);
    },
  );

  assert.equal(captured.status, 404);
});

/* ==========================================================================
 * 5. DUPLICATE ACTIVE (clinic_id, medication_id)
 * ========================================================================== */

test('CREATE: duplicate active (clinic_id, medication_id) returns 409 and no INSERT', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM medications')) return { rows: [{ medication_id: 11 }], rowCount: 1 };
      if (text.includes('FROM inventory_items')) return { rows: [{ inventory_id: 5 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_items')), false);
    },
  );

  assert.equal(captured.status, 409);
});

test('CREATE: unique-index violation (23505) is translated to 409', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM medications')) return { rows: [{ medication_id: 11 }], rowCount: 1 };
      if (text.includes('FROM inventory_items')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_items')) {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 409);
});

/* ==========================================================================
 * 6. INVALID MEDICATION
 * ========================================================================== */

test('CREATE: unknown medication returns 400 and no INSERT', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM medications')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY, medication_id: 999 } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO inventory_items')), false);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 7. INVALID UOM
 * ========================================================================== */

test('CREATE: UOM outside migration 029 codes returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid UOM'); },
    async (calls) => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY, uom: 'SACK' } }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('CREATE: dosage-form code that is not a UOM code is rejected (separate code sets)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid UOM'); },
    async () => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY, uom: 'INJECTION' } }), res);
    },
  );

  assert.equal(captured.status, 400);
});

/* ==========================================================================
 * 8. INVALID THRESHOLDS
 * ========================================================================== */

test('CREATE: negative min_stock / reorder_point return 400 without touching the DB', async () => {
  for (const body of [
    { ...VALID_CREATE_BODY, min_stock: -1 },
    { ...VALID_CREATE_BODY, reorder_point: -5 },
  ]) {
    const { res, captured } = makeRes();
    await withMockedPool(
      () => { throw new Error('pool.query must not be called for invalid thresholds'); },
      async (calls) => {
        await createInventoryItem(inventoryReq({ body }), res);
        assert.equal(calls.length, 0);
      },
    );
    assert.equal(captured.status, 400);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('CREATE: max_stock below reorder_point returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for inconsistent thresholds'); },
    async (calls) => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY, reorder_point: 50, max_stock: 10 } }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 9. CROSS-CLINIC ISOLATION
 * ========================================================================== */

test('ISOLATION: GET/:id of an item in another clinic is scoped in SQL and returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'clinic scope must be applied in SQL');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await getInventoryItem(inventoryReq({ id: '77', user: pharmacist([1]) }), res);
      assert.deepEqual(calls[0]!.params, [77, [1]]);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: creating an item for a clinic the user is not assigned to returns 403 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for a cross-clinic create'); },
    async (calls) => {
      await createInventoryItem(inventoryReq({ body: { ...VALID_CREATE_BODY, clinic_id: 2 }, user: pharmacist([1]) }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 403);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
});

test('ISOLATION: moving an item to another clinic is refused', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_items i')) return { rows: [itemRow({ clinic_id: 1 })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateInventoryItem(inventoryReq({ id: '5', body: { clinic_id: 2 }, user: pharmacist([1, 2]) }), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued when the clinic change is refused');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('ISOLATION: a user assigned to no clinic gets an empty list, not every clinic', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$1::int\[\]\)/, 'scope clause must never be omitted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listInventoryItems(inventoryReq({ user: pharmacist([]) }), res);
      assert.deepEqual(calls[0]!.params, [[]], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.inventoryItems, []);
});

/* ==========================================================================
 * 10. PERMISSION DENIAL
 * ========================================================================== */

test('AUTHORIZATION: VIEW_INVENTORY / MANAGE_INVENTORY are required', () => {
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
  assert.equal(deniedView.nextCalled, false, 'VIEW_INVENTORY must be enforced');
  assert.equal(deniedView.error?.statusCode, 403);
  assert.equal(deniedView.error?.code, ApiErrorCode.FORBIDDEN);

  const deniedManage = runMiddleware('MANAGE_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY']);
  assert.equal(deniedManage.nextCalled, false, 'MANAGE_INVENTORY must be enforced for write operations');
  assert.equal(deniedManage.error?.code, ApiErrorCode.FORBIDDEN);

  const allowedView = runMiddleware('VIEW_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowedView.error, null);
  assert.equal(allowedView.nextCalled, true);

  const allowedAdmin = runMiddleware('MANAGE_INVENTORY', 'SUPER_ADMIN', []);
  assert.equal(allowedAdmin.nextCalled, true, 'admins bypass the permission check');
});
