import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listMedicationPrices,
  getMedicationPrice,
  createMedicationPrice,
  updateMedicationPrice,
  deactivateMedicationPrice,
} from '../modules/inventory/medicationPrices.controller';

/* ==========================================================================
 * Phase 10E.2 â€” Medication pricing backend (direct controller tests, mocked pool)
 * No real PostgreSQL: pool.query and pool.connect are stubbed and always restored.
 *
 * Covers: create, supersede/update history, deactivate, duplicate-active
 * prevention, clinic isolation, RBAC, invalid/negative price, zero price, and
 * historical price preservation.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface FakeClient {
  query: (text: string, params?: unknown[]) => Promise<MockResult>;
  released: boolean;
}

/**
 * Mock both pool.query and pool.connect. The client stub answers transaction
 * control statements with an empty result and delegates the rest to `handler`,
 * which sees every call (pool-level and client-level) in order.
 */
async function withMockedPool(
  handler: (text: string, params: unknown[]) => MockResult,
  run: (calls: QueryCall[], client: FakeClient) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  const record = (text: string, params: unknown[] = []): MockResult => {
    calls.push({ text, params });
    return handler(text, params);
  };

  const client: FakeClient = {
    query: async (text: string, params: unknown[] = []) => record(text, params),
    released: false,
  };

  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) =>
    record(text, params);
  (pool as unknown as { connect: unknown }).connect = async () => {
    (client.released = false);
    return {
      query: client.query,
      release: () => {
        client.released = true;
      },
    } as any;
  };

  try {
    await run(calls, client);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
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

const inventoryRow = (over: Record<string, unknown> = {}): QueryRow => ({
  inventory_id: 641, clinic_id: 1, ...over,
});

const priceRow = (over: Record<string, unknown> = {}): QueryRow => ({
  price_id: 900, clinic_id: 1, inventory_id: 641, unit_price: '2.50',
  is_active: true, effective_from: '2026-01-01T00:00:00.000Z', effective_to: null,
  created_by_user_id: 5, created_at: '2026-01-01T00:00:00.000Z', ...over,
});

const priceReq = (
  opts: { body?: Record<string, unknown>; id?: string; query?: Record<string, unknown>; user?: unknown } = {},
): AuthenticatedRequest =>
  ({
    body: opts.body ?? {},
    params: opts.id === undefined ? {} : { id: opts.id },
    query: opts.query ?? {},
    user: opts.user ?? pharmacist(),
  } as unknown as AuthenticatedRequest);

const VALID_CREATE_BODY = { inventory_id: 641, unit_price: 2.5 };

/* ==========================================================================
 * 1. AUTHORIZATION â€” VIEW_INVENTORY for reads, MANAGE_INVENTORY for writes
 * ========================================================================== */

test('AUTHORIZATION: reads require VIEW_INVENTORY and price writes require MANAGE_INVENTORY', () => {
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

  const deniedView = runMiddleware('VIEW_INVENTORY', 'ACCOUNTANT', ['MANAGE_INVENTORY']);
  assert.equal(deniedView.nextCalled, false, 'VIEW_INVENTORY must be enforced on GET');
  assert.equal(deniedView.error?.statusCode, 403);
  assert.equal(deniedView.error?.code, ApiErrorCode.FORBIDDEN);

  const deniedManage = runMiddleware('MANAGE_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY']);
  assert.equal(deniedManage.nextCalled, false, 'MANAGE_INVENTORY must be enforced on writes');
  assert.equal(deniedManage.error?.code, ApiErrorCode.FORBIDDEN);

  const allowedView = runMiddleware('VIEW_INVENTORY', 'PHARMACIST', ['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowedView.error, null);
  assert.equal(allowedView.nextCalled, true);

  const allowedAdmin = runMiddleware('MANAGE_INVENTORY', 'SYSTEM_ADMIN', []);
  assert.equal(allowedAdmin.nextCalled, true, 'admins bypass the permission check');
});

test('UNAUTHENTICATED: price mutations refuse to run without a server-derived user id', async () => {
  const { res, captured } = makeRes();
  const anonymous = priceReq({ body: VALID_CREATE_BODY, user: { clinicId: 1, roleName: 'PHARMACIST' } });

  let connectCalled = false;
  (pool as unknown as { connect: unknown }).connect = async () => {
    connectCalled = true;
    throw new Error('must not reach the database');
  };

  try {
    await createMedicationPrice(anonymous as AuthenticatedRequest, res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(connectCalled, false);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 2. CREATE â€” price, clinic derivation, audit, and client-derived-field rejection
 * ========================================================================== */

test('CREATE: creates an active price and derives clinic_id from the inventory item', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/SELECT price_id, unit_price, effective_from FROM medication_prices/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      if (/INSERT INTO audit_logs/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);

      assert.equal(captured.status, 201);
      assert.equal(captured.body.medicationPrice.unit_price, '2.50');

      const insert = calls.find((c) => /INSERT INTO medication_prices/.test(c.text))!;
      assert.ok(insert, 'a price row must be inserted');

      // clinic_id comes from inventory_items, never from the request
      assert.equal(insert.params[0], 1, 'clinic_id is the inventory item clinic');
      assert.equal(insert.params[1], 641);
      assert.equal(insert.params[2], 2.5);

      const audit = calls.find((c) => /INSERT INTO audit_logs/.test(c.text))!;
      assert.ok(audit, 'exactly one audit row is written');
      assert.match(audit.text, /'MEDICATION_PRICE'/);
      assert.ok(calls.some((c) => /BEGIN/.test(c.text)), 'wrapped in a transaction');
      assert.ok(calls.some((c) => /COMMIT/.test(c.text)), 'committed');
      assert.ok(!calls.some((c) => /ROLLBACK/.test(c.text)), 'no rollback on success');
    },
  );
});

test('CREATE: a client-supplied clinic_id is rejected before any database access', async () => {
  const { res, captured } = makeRes();

  let connectCalled = false;
  (pool as unknown as { connect: unknown }).connect = async () => {
    connectCalled = true;
    throw new Error('must not reach the database');
  };

  try {
    await createMedicationPrice(
      priceReq({ body: { ...VALID_CREATE_BODY, clinic_id: 2 } }),
      res,
    );
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(connectCalled, false, 'server-derived fields are refused before any query');
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  assert.match(captured.body.message, /clinic_id/);
});

test('CREATE: other server-derived fields (is_active, effective_to, price_id) are refused', async () => {
  const cases: Record<string, unknown>[] = [
    { is_active: true },
    { effective_to: '2026-02-01T00:00:00.000Z' },
    { price_id: 7 },
    { medication_id: 12 },
    { created_by_user_id: 99 },
  ];

  for (const extra of cases) {
    const { res, captured } = makeRes();
    await createMedicationPrice(priceReq({ body: { ...VALID_CREATE_BODY, ...extra } }), res);
    assert.equal(captured.status, 400, `field ${Object.keys(extra)[0]} must be refused`);
  }
});

test('CREATE: the active-price lock is taken before inserting, so two actives cannot race', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 201);

      const lockIndex = calls.findIndex((c) => /FOR UPDATE/.test(c.text) && /FROM medication_prices/.test(c.text));
      const insertIndex = calls.findIndex((c) => /INSERT INTO medication_prices/.test(c.text));
      assert.ok(lockIndex >= 0, 'the current active price is locked');
      assert.ok(lockIndex < insertIndex, 'lock precedes the insert');
    },
  );
});

/* ==========================================================================
 * 3. DUPLICATE ACTIVE PRICE PREVENTION
 * ========================================================================== */

test('CREATE: rejects a second active price for the same inventory item (409)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [{ price_id: 900, unit_price: '2.50' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);

      assert.equal(captured.status, 409);
      assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
      assert.ok(!calls.some((c) => /INSERT INTO medication_prices/.test(c.text)), 'no row inserted');
      assert.ok(calls.some((c) => /ROLLBACK/.test(c.text)), 'rolled back');
    },
  );
});

test('CREATE: a unique-violation race (23505) also surfaces as 409, never as 500', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) {
        const err: any = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 409);
    },
  );
});

/* ==========================================================================
 * 4. VALIDATION â€” negative, zero, non-numeric, over-precision, over-limit
 * ========================================================================== */

test('VALIDATION: a negative price is rejected (400)', async () => {
  const { res, captured } = makeRes();
  await createMedicationPrice(priceReq({ body: { ...VALID_CREATE_BODY, unit_price: -1 } }), res);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('VALIDATION: a zero price is accepted â€” free medication is a legitimate price', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) {
        return { rows: [priceRow({ unit_price: '0.00' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: { inventory_id: 641, unit_price: 0 } }), res);
      assert.equal(captured.status, 201);

      const insert = calls.find((c) => /INSERT INTO medication_prices/.test(c.text))!;
      assert.equal(insert.params[2], 0, 'zero is stored, not rejected or coerced away');
    },
  );
});

test('VALIDATION: non-numeric, over-precision, over-limit, and missing ids are rejected', async () => {
  const invalidBodies: Record<string, unknown>[] = [
    { inventory_id: 641, unit_price: 'free' },
    { inventory_id: 641, unit_price: Number.POSITIVE_INFINITY },
    { inventory_id: 641, unit_price: NaN },
    { inventory_id: 641, unit_price: 2.555 },
    { inventory_id: 641, unit_price: 100_000_000 },
    { inventory_id: 0, unit_price: 2.5 },
    { inventory_id: -1, unit_price: 2.5 },
    { unit_price: 2.5 },
    { inventory_id: 641 },
  ];

  for (const body of invalidBodies) {
    const { res, captured } = makeRes();
    await createMedicationPrice(priceReq({ body }), res);
    assert.equal(captured.status, 400, `body ${JSON.stringify(body)} must be rejected`);
  }
});

test('VALIDATION: an invalid :id path parameter is rejected on every mutation', async () => {
  for (const id of ['abc', '0', '-5']) {
    const { res: updateRes, captured: updateCaptured } = makeRes();
    await updateMedicationPrice(priceReq({ id, body: { unit_price: 3 } }), updateRes);
    assert.equal(updateCaptured.status, 400);

    const { res: deactivateRes, captured: deactivateCaptured } = makeRes();
    await deactivateMedicationPrice(priceReq({ id }), deactivateRes);
    assert.equal(deactivateCaptured.status, 400);
  }
});

/* ==========================================================================
 * 5. CLINIC ISOLATION
 * ========================================================================== */

test('CLINIC ISOLATION: a price in another clinic cannot be created (404)', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY, user: pharmacist([1]) }), res);

      assert.equal(captured.status, 404, 'an out-of-scope item is reported as not found');
      assert.ok(!calls.some((c) => /INSERT INTO medication_prices/.test(c.text)), 'no row written');
      assert.ok(calls.some((c) => /ROLLBACK/.test(c.text)), 'rolled back');

      const lookup = calls.find((c) => /FROM inventory_items/.test(c.text))!;
      assert.match(lookup.text, /clinic_id = ANY\(\$2::int\[\]\)/, 'scope is enforced in SQL');
      assert.deepEqual(lookup.params[1], [1]);
    },
  );
});

test('CLINIC ISOLATION: an archived inventory item cannot be priced', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 404);

      const lookup = calls.find((c) => /FROM inventory_items/.test(c.text))!;
      assert.match(lookup.text, /deleted_at IS NULL/, 'archived items are out of scope for pricing');
    },
  );
});

test('CLINIC ISOLATION: reading or mutating another clinicâ€™s price returns 404', async () => {
  // GET
  const { res: getRes, captured: getCaptured } = makeRes();
  await withMockedPool(
    (text) => (text === 'SELECT 1' ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }),
    async (calls) => {
      await getMedicationPrice(priceReq({ id: '900', user: pharmacist([1]) }), getRes);
      assert.equal(getCaptured.status, 404);
      const lookup = calls.find((c) => /WHERE mp.price_id/.test(c.text))!;
      assert.deepEqual(lookup.params[1], [1]);
    },
  );

  // PUT
  const { res: putRes, captured: putCaptured } = makeRes();
  await withMockedPool(
    (text) => (/BEGIN/.test(text) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }),
    async (calls) => {
      await updateMedicationPrice(
        priceReq({ id: '900', body: { unit_price: 4 }, user: pharmacist([1]) }),
        putRes,
      );
      assert.equal(putCaptured.status, 404);
      assert.ok(calls.some((c) => /ROLLBACK/.test(c.text)), 'rolled back');
    },
  );

  // DELETE
  const { res: delRes, captured: delCaptured } = makeRes();
  await withMockedPool(
    (text) => (/BEGIN/.test(text) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }),
    async (calls) => {
      await deactivateMedicationPrice(priceReq({ id: '900', user: pharmacist([1]) }), delRes);
      assert.equal(delCaptured.status, 404);
    },
  );
});

test('CLINIC ISOLATION: a user assigned to two clinics may price only within that set', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow({ clinic_id: 3 })], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow({ clinic_id: 3 })], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY, user: pharmacist([1, 3]) }), res);
      assert.equal(captured.status, 201);

      const lookup = calls.find((c) => /FROM inventory_items/.test(c.text))!;
      assert.deepEqual(lookup.params[1], [1, 3]);
      const insert = calls.find((c) => /INSERT INTO medication_prices/.test(c.text))!;
      assert.equal(insert.params[0], 3, 'clinic comes from the item the user can reach');
    },
  );
});

test('CLINIC ISOLATION: list is scoped, and SUPER_ADMIN is not restricted', async () => {
  const { res: scopedRes, captured: scopedCaptured } = makeRes();
  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listMedicationPrices(priceReq({ user: pharmacist([1]) }), scopedRes);
      assert.equal(scopedCaptured.status, 200);
      const list = calls.find((c) => /FROM medication_prices mp/.test(c.text))!;
      assert.match(list.text, /clinic_id = ANY\(\$1::int\[\]\)/);
      assert.deepEqual(list.params[0], [1]);
    },
  );

  const { res: adminRes, captured: adminCaptured } = makeRes();
  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listMedicationPrices(priceReq({ user: superAdmin }), adminRes);
      assert.equal(adminCaptured.status, 200);
      const list = calls.find((c) => /FROM medication_prices mp/.test(c.text))!;
      assert.ok(!/clinic_id = ANY/.test(list.text), 'admins are unrestricted');
    },
  );
});

test('CLINIC ISOLATION: an inaccessible clinic filter is ignored rather than leaking rows', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listMedicationPrices(priceReq({ query: { clinic_id: '2' }, user: pharmacist([1]) }), res);
      assert.equal(captured.status, 200);

      const list = calls.find((c) => /FROM medication_prices mp/.test(c.text))!;
      // The requested clinic and the access scope are BOTH applied, so the
      // intersection is empty rather than clinic 2 being returned.
      assert.match(list.text, /mp.clinic_id = \$1/);
      assert.match(list.text, /clinic_id = ANY\(\$2::int\[\]\)/);
      assert.deepEqual(list.params[0], 2);
      assert.deepEqual(list.params[1], [1]);
    },
  );
});

/* ==========================================================================
 * 6. UPDATE â€” append-only history, never an in-place amount change
 * ========================================================================== */

test('UPDATE: supersedes the old price and inserts a new one, preserving the old amount', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow({ unit_price: '2.50', is_active: true })], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) {
        return {
          rows: [priceRow({ unit_price: '2.50', is_active: false, effective_to: '2026-06-01T00:00:00.000Z' })],
          rowCount: 1,
        };
      }
      if (/INSERT INTO medication_prices/.test(text)) {
        return { rows: [priceRow({ price_id: 901, unit_price: '3.75', is_active: true })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 3.75 } }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.medicationPrice.unit_price, '3.75');
      assert.equal(captured.body.supersededPrice.unit_price, '2.50', 'the old amount is returned unchanged');

      const updates = calls.filter((c) => /UPDATE medication_prices/.test(c.text));
      assert.equal(updates.length, 1, 'the old row is closed exactly once');
      assert.match(updates[0]!.text, /is_active = FALSE/);
      assert.match(updates[0]!.text, /effective_to = COALESCE/);
      assert.ok(
        !/unit_price\s*=/.test(updates[0]!.text),
        'unit_price is never assigned on an existing row â€” history is immutable',
      );

      const inserts = calls.filter((c) => /INSERT INTO medication_prices/.test(c.text));
      assert.equal(inserts.length, 1, 'the new price is a new row');
      assert.equal(inserts[0]!.params[2], 3.75);

      const audit = calls.find((c) => /INSERT INTO audit_logs/.test(c.text))!;
      assert.match(audit.text, /'MEDICATION_PRICE'/);
      assert.equal(calls.filter((c) => /INSERT INTO audit_logs/.test(c.text)).length, 1);
      assert.ok(calls.some((c) => /COMMIT/.test(c.text)));
    },
  );
});

test('UPDATE: the closed and new rows share the same effective_from boundary', async () => {
  const { res, captured } = makeRes();
  const boundary = '2026-06-01T08:00:00.000Z';

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow()], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) {
        return { rows: [priceRow({ is_active: false, effective_to: boundary })], rowCount: 1 };
      }
      if (/INSERT INTO medication_prices/.test(text)) {
        return { rows: [priceRow({ price_id: 901, effective_from: boundary })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateMedicationPrice(
        priceReq({ id: '900', body: { unit_price: 4, effective_from: boundary } }),
        res,
      );

      assert.equal(captured.status, 200);
      const updates = calls.filter((c) => /UPDATE medication_prices/.test(c.text));
      const inserts = calls.filter((c) => /INSERT INTO medication_prices/.test(c.text));
      assert.equal(updates[0]!.params[1], boundary);
      assert.equal(inserts[0]!.params[3], boundary, 'one window boundary for both rows');
    },
  );
});

test('UPDATE: an already-inactive historical price cannot be reactivated', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return {
          rows: [priceRow({ is_active: false, effective_to: '2026-02-01T00:00:00.000Z' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 9 } }), res);

      assert.equal(captured.status, 409);
      assert.ok(!calls.some((c) => /INSERT INTO medication_prices/.test(c.text)), 'no new row');
      assert.ok(calls.some((c) => /ROLLBACK/.test(c.text)));
    },
  );
});

test('UPDATE: a lost close race (rowCount 0) rolls back instead of double-inserting', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow({ is_active: true })], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 5 } }), res);

      assert.equal(captured.status, 409);
      assert.ok(!calls.some((c) => /INSERT INTO medication_prices/.test(c.text)));
      assert.ok(calls.some((c) => /ROLLBACK/.test(c.text)));
    },
  );
});

test('UPDATE: a negative replacement price is rejected and never reaches the database', async () => {
  let connectCalled = false;
  (pool as unknown as { connect: unknown }).connect = async () => {
    connectCalled = true;
    throw new Error('must not reach the database');
  };

  const { res, captured } = makeRes();
  try {
    await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: -0.01 } }), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(connectCalled, false);
  assert.equal(captured.status, 400);
});

/* ==========================================================================
 * 7. DEACTIVATE â€” close only, never delete
 * ========================================================================== */

test('DEACTIVATE: closes the price without deleting it and without creating a new one', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow()], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) {
        return { rows: [priceRow({ is_active: false, effective_to: '2026-06-01T00:00:00.000Z' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await deactivateMedicationPrice(priceReq({ id: '900' }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.medicationPrice.is_active, false);
      assert.equal(captured.body.medicationPrice.unit_price, '2.50', 'the amount is preserved');

      assert.ok(!calls.some((c) => /DELETE/i.test(c.text)), 'no delete statement exists at all');
      assert.ok(!calls.some((c) => /INSERT INTO medication_prices/.test(c.text)), 'no replacement row');

      const update = calls.find((c) => /UPDATE medication_prices/.test(c.text))!;
      assert.match(update.text, /is_active = FALSE/);
      assert.match(update.text, /effective_to = COALESCE/);
      assert.ok(!/unit_price\s*=/.test(update.text), 'the amount is never rewritten');

      const audit = calls.find((c) => /INSERT INTO audit_logs/.test(c.text))!;
      assert.match(audit.text, /'MEDICATION_PRICE'/);
      assert.equal(audit.params[2], 'MEDICATION_PRICE_DEACTIVATED', 'the deactivation action is recorded');
    },
  );
});

test('DEACTIVATE: deactivating an already-inactive price is a 409, not a silent success', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow({ is_active: false, effective_to: '2026-02-01T00:00:00.000Z' })], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await deactivateMedicationPrice(priceReq({ id: '900' }), res);
      assert.equal(captured.status, 409);
    },
  );
});

/* ==========================================================================
 * 8. HISTORICAL PRESERVATION â€” the model-level guarantee
 * ========================================================================== */

test('HISTORY: the price table has no DELETE path, and amounts are only ever inserted', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 201);

      for (const call of calls) {
        assert.ok(!/DELETE\s+FROM/i.test(call.text), 'no price row is ever deleted');
      }
    },
  );
});

test('HISTORY: an unchanged amount still supersedes rather than mutating the existing row', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices mp/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow({ unit_price: '2.50' })], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) {
        return { rows: [priceRow({ is_active: false, effective_to: '2026-06-01T00:00:00.000Z' })], rowCount: 1 };
      }
      if (/INSERT INTO medication_prices/.test(text)) {
        return { rows: [priceRow({ price_id: 901, unit_price: '2.50' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 2.5 } }), res);

      assert.equal(captured.status, 200);
      assert.notEqual(captured.body.supersededPrice.price_id, captured.body.medicationPrice.price_id);
      assert.ok(
        calls.some((c) => /INSERT INTO medication_prices/.test(c.text)),
        'a fresh row is appended even when the amount is identical',
      );
    },
  );
});

/* ==========================================================================
 * 9. NO FINANCIAL DOCUMENTS â€” the 10E.2 boundary
 * ========================================================================== */

test('BOUNDARY: no price operation writes an invoice, invoice item, or payment', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 201);

      for (const call of calls) {
        assert.ok(!/INSERT INTO invoices/i.test(call.text), 'no invoice is created');
        assert.ok(!/INSERT INTO invoice_items/i.test(call.text), 'no invoice line is created');
      }
    },
  );
});

test('BOUNDARY: no price operation touches dispensing, movements, returns, or stock counts', async () => {
  const { res, captured } = makeRes();

  // Create runs first with no active price, so it must actually insert; the
  // supersede that follows then sees that price as active.
  let priceExists = false;

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      // Ù‚ÙÙ„ Ø§Ù„Ø³Ø¹Ø± Ø§Ù„Ù†Ø´Ø· Ø¹Ù†Ø¯ Ø§Ù„Ø¥Ù†Ø´Ø§Ø¡
      if (/FROM medication_prices/.test(text) && /WHERE inventory_id/.test(text) && /FOR UPDATE/.test(text)) {
        return priceExists ? { rows: [{ price_id: 900, unit_price: '2.50' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // ØªØ­Ù…ÙŠÙ„ Ø§Ù„Ø³Ø¹Ø± Ø§Ù„Ù…Ø³ØªÙ‡Ø¯Ù Ø¹Ù†Ø¯ Ø§Ù„ØªØ­Ø¯ÙŠØ«
      if (/FROM medication_prices mp/.test(text) && /WHERE mp.price_id/.test(text)) {
        return { rows: [priceRow({ is_active: true })], rowCount: 1 };
      }
      if (/INSERT INTO medication_prices/.test(text)) {
        priceExists = true;
        return { rows: [priceRow({ price_id: 901 })], rowCount: 1 };
      }
      if (/UPDATE medication_prices/.test(text)) {
        return { rows: [priceRow({ is_active: false, effective_to: '2026-06-01T00:00:00.000Z' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 201, 'the create must succeed for the writes below to be observed');
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 3 } }), res);
      assert.equal(captured.status, 200);

      const written = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.text));
      const tables = new Set<string>();
      for (const call of written) {
        const match = /(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(call.text);
        if (match) tables.add(match[1]!);
      }

      for (const forbidden of [
        'dispensing_items', 'dispensing_item_batches', 'dispensings',
        'inventory_batches', 'inventory_items', 'stock_movements',
        'medication_returns', 'medication_return_items', 'stock_counts',
        'stock_count_lines', 'invoices', 'invoice_items',
      ]) {
        assert.ok(!tables.has(forbidden), `${forbidden} must never be written by pricing`);
      }

      assert.ok(tables.has('medication_prices'), 'only the price table is written');
      assert.ok(
        tables.has('audit_logs') && tables.size === 2,
        `pricing writes only medication_prices plus its audit trail, got: ${[...tables].join(', ')}`,
      );
    },
  );
});

test('BOUNDARY: clinic_services is never read or written for medication pricing', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 201);

      for (const call of calls) {
        assert.ok(!/clinic_services/i.test(call.text), 'clinic_services must stay out of medication pricing');
      }
    },
  );
});
/* ==========================================================================
 * PHASE 10E.9 B1 â€” pooled connection leaks
 *
 * Every handler here acquired a PoolClient and never released it. Once the
 * pool's max (DB_POOL_MAX, default 10) was reached, every other query in the
 * process failed with "timeout exceeded when trying to connect" and the whole
 * API stopped responding â€” not just pricing.
 *
 * These tests are mocked, so they run in the normal suite: they assert the
 * release CONTRACT on the paths that used to leak. The real-database proof
 * (more operations than the pool has connections) lives in
 * financialConsistency.concurrency.test.ts under FINANCIAL_CONCURRENCY_TEST.
 * ========================================================================== */

test('LEAK: create releases its client on success', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (_calls, client) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 201);
      assert.equal(client.released, true, 'a committed create must hand its client back to the pool');
    },
  );
});

test('LEAK: create releases its client when the price is refused', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM inventory_items/.test(text)) return { rows: [inventoryRow()], rowCount: 1 };
      // an active price already exists -> 409 inside the transaction
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (calls, client) => {
      await createMedicationPrice(priceReq({ body: VALID_CREATE_BODY }), res);
      assert.equal(captured.status, 409);
      assert.ok(calls.some((c) => c.text === 'ROLLBACK'), 'the refused transaction rolls back');
      assert.equal(client.released, true, 'a refused create must hand its client back too');
    },
  );
});

test('LEAK: update releases its client on success', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      if (/UPDATE medication_prices/.test(text)) return { rows: [priceRow({ is_active: false })], rowCount: 1 };
      if (/INSERT INTO medication_prices/.test(text)) return { rows: [priceRow({ price_id: 901 })], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (_calls, client) => {
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 3.75 } }), res);
      assert.equal(captured.status, 200);
      assert.equal(client.released, true, 'a committed supersede must hand its client back');
    },
  );
});

test('LEAK: update releases its client when a historical price is refused', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [priceRow({ is_active: false })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async (calls, client) => {
      await updateMedicationPrice(priceReq({ id: '900', body: { unit_price: 3.75 } }), res);
      assert.equal(captured.status, 409, 'a superseded price cannot be edited');
      assert.ok(calls.some((c) => c.text === 'ROLLBACK'));
      assert.equal(client.released, true, 'a refused update must hand its client back too');
    },
  );
});

test('LEAK: deactivate releases its client on success', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      if (/UPDATE medication_prices/.test(text)) return { rows: [priceRow({ is_active: false })], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (_calls, client) => {
      await deactivateMedicationPrice(priceReq({ id: '900' }), res);
      assert.equal(captured.status, 200);
      assert.equal(client.released, true, 'a committed deactivate must hand its client back');
    },
  );
});

test('LEAK: deactivate releases its client when the price is already inactive', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (/BEGIN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM medication_prices/.test(text) && /FOR UPDATE/.test(text)) return { rows: [priceRow()], rowCount: 1 };
      // the guarded UPDATE matches nothing -> 409
      if (/UPDATE medication_prices/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async (calls, client) => {
      await deactivateMedicationPrice(priceReq({ id: '900' }), res);
      assert.equal(captured.status, 409);
      assert.ok(calls.some((c) => c.text === 'ROLLBACK'));
      assert.equal(client.released, true, 'a refused deactivate must hand its client back too');
    },
  );
});

/**
 * Comments are removed before scanning, because the fix's own comment names the
 * pattern it removes â€” a guard that matched its own explanation would be
 * unusable.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\S\n]*\/\/[^\n]*$/gm, ' ');

test('LEAK: no transaction handler sets client = null, which would skip the release', () => {
  const source = stripComments(
    readFileSync(require.resolve('../modules/inventory/medicationPrices.controller'), 'utf8'),
  );

  // `client = null` after COMMIT was the original leak: the finally block then
  // saw a null and released nothing, on the only path that commits.
  assert.doesNotMatch(
    source,
    /^[^\S\n]*client\s*=\s*null\s*;/m,
    'nulling the client defeats the release; COMMIT must leave it set for finally',
  );

  const connects = (source.match(/pool\.connect\(\)/g) ?? []).length;
  const releases = (source.match(/\.release\(\)/g) ?? []).length;
  assert.equal(connects, 3, 'create, update and deactivate each take a client');
  assert.equal(releases, 3, 'and each must release it in a finally');
});

test('LEAK: structural guard â€” every Phase 10E handler that connects also releases', () => {
  // A deliberately small sweep: the 10E/10D module surface, read as text and
  // checked for the one shape this defect took. Not a static-analysis
  // framework â€” just a tripwire so a fourth handler cannot repeat the leak.
  const audited = [
    '../modules/inventory/medicationPrices.controller',
    '../modules/inventory/medicationReturns.controller',
    '../modules/inventory/dispensings.controller',
    '../modules/inventory/inventoryValuation.controller',
    '../modules/billing/medicationCharges.controller',
    '../modules/billing/billing.controller',
  ];

  for (const specifier of audited) {
    const file = basename(require.resolve(specifier));
    const source = stripComments(readFileSync(require.resolve(specifier), 'utf8'));
    const connects = (source.match(/pool\.connect\(\)/g) ?? []).length;
    if (connects === 0) continue;

    const releases = (source.match(/\.release\(\)/g) ?? []).length;
    assert.ok(
      releases >= connects,
      `${file}: ${connects} pool.connect() but only ${releases} release() â€” a leaked client exhausts the pool and takes the API down`,
    );
    assert.doesNotMatch(
      source,
      /^[^\S\n]*client\s*=\s*null\s*;/m,
      `${file}: nulling the client after COMMIT makes finally release nothing`,
    );
  }
});
