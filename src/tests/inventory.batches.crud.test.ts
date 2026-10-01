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
const LOT_LOOKUP = 'SELECT batch_id FROM inventory_batches';

/** يستخرج جزء SET فقط من جملة UPDATE (قبل FROM / RETURNING) لفحص الأعمدة المكتوبة. */
const setClauseOf = (text: string): string => {
  const start = text.indexOf('SET ');
  const end = text.indexOf('FROM inventory_items i');
  return text.slice(start, end === -1 ? text.length : end);
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);

      assert.equal(captured.status, 201);
      assert.equal(captured.body.batch.batch_id, 7);

      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_batches'));
      assert.ok(insert, 'INSERT must be executed');
      assert.deepEqual(insert.params, [5, 3, 'LOT-001', '2027-01-31', 100, 0, 2.5, null]);
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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

test('CREATE: received_at falls back to NOW() when omitted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO inventory_batches')) return { rows: [batchRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createBatch(batchReq({ body: { ...VALID_CREATE_BODY } }), res);

      assert.equal(captured.status, 201);
      const insert = calls.find((c) => c.text.includes('INSERT INTO inventory_batches'));
      assert.match(insert!.text, /COALESCE\(\$8, NOW\(\)\)/);
      assert.equal(insert!.params[7], null);
    },
  );
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 2 }], rowCount: 1 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [], rowCount: 0 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [{ batch_id: 7 }], rowCount: 1 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) {
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
      if (text.includes(ITEM_LOOKUP)) return { rows: [{ inventory_id: 5, clinic_id: 1 }], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ clinic_id: 1 }], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
 * 9. UPDATE METADATA
 * ========================================================================== */

test('UPDATE: metadata changes are written and scoped to the item clinic', async () => {
  const { res, captured } = makeRes();
  const updated = batchRow({ lot_number: 'LOT-002', unit_cost: null, supplier_id: null, is_active: false });

  await withMockedPool(
    (text) => {
      if (text.includes('FROM inventory_batches b')) return { rows: [batchRow({ item_clinic_id: 1 })], rowCount: 1 };
      if (text.includes(LOT_LOOKUP)) return { rows: [], rowCount: 0 };
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
      if (text.includes(LOT_LOOKUP)) return { rows: [{ batch_id: 9 }], rowCount: 1 };
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
      return { rows: [expiryRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.batches.length, 1);
      assert.deepEqual(captured.body.pagination, { limit: DEFAULT_EXPIRY_LIMIT, offset: 0, returned: 1 });
      assert.deepEqual(calls[0]!.params, [[1], DEFAULT_EXPIRY_LIMIT, 0]);
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
      return { rows: [expiryRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: '30' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(calls[0]!.params[0], 30);
    },
  );
});

test('EXPIRY: days=0 means expiring today only', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /b\.expiry_date >= CURRENT_DATE AND b\.expiry_date <= CURRENT_DATE \+ \$1::int/);
      return { rows: [expiryRow()], rowCount: 1 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: '0' } }), res);
      assert.equal(calls[0]!.params[0], 0);
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
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expiring', days: String(MAX_EXPIRY_DAYS) } }), res);
      assert.equal(calls[0]!.params[0], MAX_EXPIRY_DAYS);
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
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired', limit: '25', offset: '40' } }), res);
      assert.deepEqual(calls[0]!.params, [[1], 25, 40]);
    },
  );

  assert.deepEqual(captured.body.pagination, { limit: 25, offset: 40, returned: 0 });

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
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired' }, user: pharmacist([]) }), res);
      assert.deepEqual(calls[0]!.params, [[], DEFAULT_EXPIRY_LIMIT, 0], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.batches, []);
});

test('EXPIRY: archived inventory items are excluded', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /WHERE i\.deleted_at IS NULL/);
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
      () => ({ rows: [expiryRow()], rowCount: 1 }),
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
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listBatchesByExpiry(batchReq({ query: { status: 'expired', clinic_id: '2' } }), res);
      assert.deepEqual(calls[0]!.params, [[1], DEFAULT_EXPIRY_LIMIT, 0], 'the clinic_id is ignored entirely');
    },
  );

  assert.equal(captured.status, 200);
});
