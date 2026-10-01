import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
} from '../modules/inventory/suppliers.controller';

/* ==========================================================================
 * Phase 10B.2B — Suppliers backend (direct controller tests, mocked pool.query)
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

const supplierRow = (over: Record<string, unknown> = {}): QueryRow => ({
  supplier_id: 3, clinic_id: 1, name: 'Acme Pharma', contact_info: 'info@acme.test',
  is_active: true, created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
});

const supplierReq = (
  opts: { body?: Record<string, unknown>; id?: string; query?: Record<string, unknown>; user?: unknown } = {},
): AuthenticatedRequest =>
  ({
    body: opts.body ?? {},
    params: opts.id === undefined ? {} : { id: opts.id },
    query: opts.query ?? {},
    user: opts.user ?? pharmacist(),
  } as unknown as AuthenticatedRequest);

const VALID_CREATE_BODY = { clinic_id: 1, name: 'Acme Pharma', contact_info: 'info@acme.test' };

/* ==========================================================================
 * 1. AUTHORIZATION — VIEW_INVENTORY for reads, MANAGE_SUPPLIERS for writes
 * ========================================================================== */

test('AUTHORIZATION: reads require VIEW_INVENTORY and writes require MANAGE_SUPPLIERS', () => {
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

  // A role holding only MANAGE_SUPPLIERS still cannot read
  const deniedView = runMiddleware('VIEW_INVENTORY', 'ACCOUNTANT', ['MANAGE_SUPPLIERS']);
  assert.equal(deniedView.nextCalled, false, 'VIEW_INVENTORY must be enforced on GET');
  assert.equal(deniedView.error?.statusCode, 403);
  assert.equal(deniedView.error?.code, ApiErrorCode.FORBIDDEN);

  // VIEW_INVENTORY alone is not enough to manage suppliers
  const deniedManage = runMiddleware('MANAGE_SUPPLIERS', 'PHARMACIST', ['VIEW_INVENTORY']);
  assert.equal(deniedManage.nextCalled, false, 'MANAGE_SUPPLIERS must be enforced on writes');
  assert.equal(deniedManage.error?.code, ApiErrorCode.FORBIDDEN);

  const allowedView = runMiddleware('VIEW_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_SUPPLIERS']);
  assert.equal(allowedView.error, null);
  assert.equal(allowedView.nextCalled, true);

  const allowedAdmin = runMiddleware('MANAGE_SUPPLIERS', 'SYSTEM_ADMIN', []);
  assert.equal(allowedAdmin.nextCalled, true, 'admins bypass the permission check');
});

/* ==========================================================================
 * 2. LIST / GET
 * ========================================================================== */

test('LIST: authorized user gets suppliers scoped to their clinics only', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /FROM suppliers s/);
      return { rows: [supplierRow()], rowCount: 1 };
    },
    async (calls) => {
      await listSuppliers(supplierReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.suppliers.length, 1);

      const list = calls[0]!;
      assert.match(list.text, /s\.clinic_id = ANY\(\$1::int\[\]\)/, 'clinic scope must be applied in SQL');
      assert.deepEqual(list.params[0], [1]);
    },
  );
});

test('LIST: admin sees every clinic and the optional clinic_id filter is honoured', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [supplierRow()], rowCount: 1 }),
    async (calls) => {
      await listSuppliers(supplierReq({ query: { clinic_id: '3' }, user: superAdmin }), res);

      assert.equal(captured.status, 200);
      const list = calls[0]!;
      assert.doesNotMatch(list.text, /ANY\(/, 'admin scope is unlimited');
      assert.match(list.text, /s\.clinic_id = \$1/);
      assert.equal(list.params[0], 3);
    },
  );
});

test('GET: returns the supplier with its clinic name', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [supplierRow({ clinic_name: 'Main Clinic' })], rowCount: 1 }),
    async (calls) => {
      await getSupplier(supplierReq({ id: '3' }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.supplier.supplier_id, 3);
      assert.equal(captured.body.supplier.clinic_name, 'Main Clinic');
      assert.deepEqual(calls[0]!.params, [3, [1]]);
    },
  );
});

/* ==========================================================================
 * 3. CREATE
 * ========================================================================== */

test('CREATE: valid body persists the supplier with is_active defaulting to TRUE', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO suppliers')) return { rows: [supplierRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createSupplier(supplierReq({ body: { ...VALID_CREATE_BODY } }), res);

      assert.equal(captured.status, 201);
      assert.equal(captured.body.supplier.supplier_id, 3);

      const insert = calls.find((c) => c.text.includes('INSERT INTO suppliers'));
      assert.ok(insert, 'INSERT must be executed');
      assert.deepEqual(insert.params, [1, 'Acme Pharma', 'info@acme.test', true]);
    },
  );
});

test('CREATE: omitted contact_info is stored as NULL', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO suppliers')) return { rows: [supplierRow({ contact_info: null })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      const { contact_info, ...body } = VALID_CREATE_BODY;
      await createSupplier(supplierReq({ body }), res);

      assert.equal(captured.status, 201);
      const insert = calls.find((c) => c.text.includes('INSERT INTO suppliers'));
      assert.equal(insert!.params[2], null, 'contact_info defaults to NULL');
    },
  );
});

test('CREATE: missing name returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called without a name'); },
    async (calls) => {
      await createSupplier(supplierReq({ body: { clinic_id: 1 } }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 4. DUPLICATE SUPPLIER (UNIQUE(clinic_id, name))
 * ========================================================================== */

test('CREATE: duplicate name in the same clinic returns 409 and no INSERT', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers')) return { rows: [{ supplier_id: 3 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createSupplier(supplierReq({ body: { ...VALID_CREATE_BODY } }), res);
      assert.equal(calls.some((c) => c.text.includes('INSERT INTO suppliers')), false);
    },
  );

  assert.equal(captured.status, 409);
});

test('CREATE: duplicate match ignores case (name is compared case-insensitively)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers')) return { rows: [{ supplier_id: 3 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createSupplier(supplierReq({ body: { ...VALID_CREATE_BODY, name: 'ACME pharma' } }), res);
      assert.match(calls[0]!.text, /lower\(name\) = lower\(\$2\)/);
    },
  );

  assert.equal(captured.status, 409);
});

test('CREATE: unique-index violation (23505) is translated to 409', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO suppliers')) {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createSupplier(supplierReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 409);
});

test('DUPLICATE: a deactivated supplier still reserves its name (unique index covers all rows)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers')) {
        assert.doesNotMatch(text, /is_active/, 'the name check must not ignore deactivated rows');
        return { rows: [{ supplier_id: 3, is_active: false }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      await createSupplier(supplierReq({ body: { ...VALID_CREATE_BODY } }), res);
    },
  );

  assert.equal(captured.status, 409);
});

/* ==========================================================================
 * 5. UPDATE
 * ========================================================================== */

test('UPDATE: valid update returns 200 and writes only the supplied fields', async () => {
  const { res, captured } = makeRes();
  const updated = supplierRow({ name: 'Acme Pharma Intl', contact_info: null });

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow()], rowCount: 1 };
      if (text.includes('lower(name) = lower($2)')) return { rows: [], rowCount: 0 };
      if (text.includes('UPDATE suppliers SET')) return { rows: [updated], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(
        supplierReq({ id: '3', body: { name: 'Acme Pharma Intl', contact_info: null } }),
        res,
      );

      assert.equal(captured.status, 200);
      assert.equal(captured.body.supplier.name, 'Acme Pharma Intl');

      const update = calls.find((c) => c.text.includes('UPDATE suppliers SET'));
      assert.ok(update, 'UPDATE must be executed');
      assert.match(update.text, /name = \$1/);
      assert.match(update.text, /contact_info = \$2/);
      assert.match(update.text, /updated_at = NOW\(\)/);
      assert.match(update.text, /suppliers\.clinic_id = ANY\(\$4::int\[\]\)/);
      assert.deepEqual(update.params, ['Acme Pharma Intl', null, 3, [1]]);
    },
  );
});

test('UPDATE: renaming to an existing name returns 409 and issues no UPDATE', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow()], rowCount: 1 };
      if (text.includes('FROM suppliers')) return { rows: [{ supplier_id: 9 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(supplierReq({ id: '3', body: { name: 'Other Pharma' } }), res);
      assert.equal(calls.some((c) => c.text.includes('UPDATE suppliers SET')), false);
    },
  );

  assert.equal(captured.status, 409);
});

test('UPDATE: keeping the same name (any case) does not collide with itself', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow()], rowCount: 1 };
      if (text.includes('UPDATE suppliers SET')) return { rows: [supplierRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(supplierReq({ id: '3', body: { name: 'acme pharma' } }), res);

      assert.equal(captured.status, 200);
      assert.equal(calls.length, 2, 'no duplicate-name lookup is issued for an unchanged name');
    },
  );
});

test('UPDATE: is_active accepts the string "false" as FALSE (not coerced to TRUE)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow()], rowCount: 1 };
      if (text.includes('UPDATE suppliers SET')) return { rows: [supplierRow({ is_active: false })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(supplierReq({ id: '3', body: { is_active: 'false' } }), res);

      assert.equal(captured.status, 200);
      const update = calls.find((c) => c.text.includes('UPDATE suppliers SET'));
      assert.equal(update!.params[0], false, '"false" must become the boolean false');
    },
  );
});

test('UPDATE: a body with no updatable fields returns 400', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow()], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(supplierReq({ id: '3', body: { clinic_id: 1 } }), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued when nothing is updatable');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 6. clinic_id IMMUTABILITY
 * ========================================================================== */

test('UPDATE: changing clinic_id is refused and no UPDATE is issued', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow({ clinic_id: 1 })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(
        supplierReq({ id: '3', body: { clinic_id: 2, name: 'Renamed' }, user: pharmacist([1, 2]) }),
        res,
      );
      assert.equal(calls.length, 1, 'no UPDATE is issued when the clinic change is refused');
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('UPDATE: resending the same clinic_id is accepted and never written', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('FROM suppliers s WHERE')) return { rows: [supplierRow({ clinic_id: 1 })], rowCount: 1 };
      if (text.includes('UPDATE suppliers SET')) return { rows: [supplierRow({ contact_info: 'new' })], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateSupplier(supplierReq({ id: '3', body: { clinic_id: 1, contact_info: 'new' } }), res);

      assert.equal(captured.status, 200);
      const update = calls.find((c) => c.text.includes('UPDATE suppliers SET'));
      const setClause = update!.text.slice(update!.text.indexOf('SET'), update!.text.indexOf(' WHERE '));
      assert.doesNotMatch(setClause, /clinic_id/, 'clinic_id is never rewritten');
    },
  );
});

/* ==========================================================================
 * 7. DEACTIVATE (no physical delete)
 * ========================================================================== */

test('DEACTIVATE: sets is_active = FALSE and never issues a physical DELETE', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /^\s*DELETE\b/, 'physical DELETE is forbidden');
      return { rows: [supplierRow({ is_active: false })], rowCount: 1 };
    },
    async (calls) => {
      await deactivateSupplier(supplierReq({ id: '3' }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.supplier.is_active, false);

      const archive = calls[0]!;
      assert.match(archive.text, /UPDATE suppliers SET is_active = FALSE, updated_at = NOW\(\)/);
      assert.match(archive.text, /suppliers\.clinic_id = ANY\(\$2::int\[\]\)/);
      assert.deepEqual(archive.params, [3, [1]]);
    },
  );
});

test('DEACTIVATE: an already-inactive supplier stays deactivated (idempotent, no row loss)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [supplierRow({ is_active: false })], rowCount: 1 }),
    async () => {
      await deactivateSupplier(supplierReq({ id: '3' }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.supplier.supplier_id, 3);
});

/* ==========================================================================
 * 8. CLINIC ISOLATION / OUT-OF-SCOPE IDs
 * ========================================================================== */

test('ISOLATION: GET of a supplier in another clinic is scoped in SQL and returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /s\.clinic_id = ANY\(\$2::int\[\]\)/, 'clinic scope must be applied in SQL');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await getSupplier(supplierReq({ id: '77', user: pharmacist([1]) }), res);
      assert.deepEqual(calls[0]!.params, [77, [1]]);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: creating a supplier for a clinic the user is not assigned to returns 403 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for a cross-clinic create'); },
    async (calls) => {
      await createSupplier(supplierReq({ body: { ...VALID_CREATE_BODY, clinic_id: 2 }, user: pharmacist([1]) }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 403);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
});

test('ISOLATION: updating an out-of-scope supplier stops at the scoped lookup', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /FROM suppliers s WHERE/, 'only the scoped lookup may run');
      assert.match(text, /s\.clinic_id = ANY\(\$2::int\[\]\)/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateSupplier(supplierReq({ id: '77', body: { name: 'Hijack' }, user: pharmacist([1]) }), res);
      assert.equal(calls.length, 1, 'no write is issued for an out-of-scope supplier');
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: deactivating an out-of-scope supplier matches no row and returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      // الأرشفة/إلغاء التنسيط مُقيَّد بالعيادة داخل نفس جملة UPDATE — لا يكتب خارج النطاق
      assert.match(text, /UPDATE suppliers SET is_active = FALSE/);
      assert.match(text, /suppliers\.clinic_id = ANY\(\$2::int\[\]\)/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await deactivateSupplier(supplierReq({ id: '77', user: pharmacist([1]) }), res);
      assert.deepEqual(calls[0]!.params, [77, [1]]);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: a user assigned to no clinic gets an empty list, not every clinic', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.match(text, /s\.clinic_id = ANY\(\$1::int\[\]\)/, 'scope clause must never be omitted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listSuppliers(supplierReq({ user: pharmacist([]) }), res);
      assert.deepEqual(calls[0]!.params, [[]], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.suppliers, []);
});

test('ISOLATION: a clinic_id query filter outside the caller scope returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for a cross-clinic filter'); },
    async (calls) => {
      await listSuppliers(supplierReq({ query: { clinic_id: '2' }, user: pharmacist([1]) }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 404);
});

test('ISOLATION: admin is not clinic-restricted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /ANY\(/, 'admin scope is unlimited');
      return { rows: [supplierRow({ clinic_id: 9 })], rowCount: 1 };
    },
    async () => {
      await getSupplier(supplierReq({ id: '3', user: superAdmin }), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.supplier.clinic_id, 9);
});

test('VALIDATION: a non-numeric supplier id returns 400 without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid id'); },
    async (calls) => {
      await getSupplier(supplierReq({ id: 'abc' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});
