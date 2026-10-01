import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { selectFefoBatches, DEFAULT_FEFO_LIMIT, MAX_FEFO_LIMIT } from '../modules/inventory/fefo';

/* ==========================================================================
 * Phase 10B.4A-2 — FEFO selector (direct helper tests, mocked pool.query)
 * The helper is SELECT-only: it is tested through its generated SQL, which is
 * the whole contract Phase 10C will rely on.
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

const pharmacist = (clinicIds: number[] = [1]) => ({
  userId: 5, roleId: 4, clinicId: clinicIds[0] ?? null, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds,
});

const req = (clinicIds: number[] = [1]): AuthenticatedRequest =>
  ({ body: {}, params: {}, query: {}, user: pharmacist(clinicIds) } as unknown as AuthenticatedRequest);

const batchRow = (over: Record<string, unknown> = {}): QueryRow => ({
  batch_id: 7, inventory_id: 5, lot_number: 'LOT-001', expiry_date: '2027-01-31', quantity_on_hand: 100, ...over,
});

/* ==========================================================================
 * 1. ELIGIBLE BATCHES
 * ========================================================================== */

test('FEFO: eligible future-expiry batches are returned with the minimal read-only fields', async () => {
  const calls: QueryCall[] = [];
  await withMockedPool(
    (text) => {
      calls.push({ text, params: [] });
      return { rows: [batchRow()], rowCount: 1 };
    },
    async (recorded) => {
      const result = await selectFefoBatches(req(), 5);

      assert.equal(result.length, 1);
      assert.deepEqual(result[0], {
        batch_id: 7, inventory_id: 5, lot_number: 'LOT-001', expiry_date: '2027-01-31', quantity_on_hand: 100,
      });
      assert.deepEqual(Object.keys(result[0]!).sort(), ['batch_id', 'expiry_date', 'inventory_id', 'lot_number', 'quantity_on_hand']);
      assert.deepEqual(recorded[0]!.params, [5, [1], DEFAULT_FEFO_LIMIT]);
    },
  );
});

/* ==========================================================================
 * 2-5. EVERY ELIGIBILITY RULE IS ENFORCED IN SQL
 * ========================================================================== */

test('FEFO: expired, inactive, zero-stock and archived batches are all excluded in the query', async () => {
  await withMockedPool(
    (text) => {
      assert.match(text, /b\.expiry_date >= CURRENT_DATE/, 'expired batches must be excluded');
      assert.match(text, /b\.is_active = TRUE/, 'inactive batches must be excluded');
      assert.match(text, /b\.quantity_on_hand > 0/, 'zero-stock batches must be excluded');
      assert.match(text, /i\.deleted_at IS NULL/, 'batches of an archived item must be excluded');
      assert.match(text, /b\.inventory_id = \$1/, 'only the requested inventory item');
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'clinic scope through the item join');
      return { rows: [], rowCount: 0 };
    },
    async () => {
      assert.deepEqual(await selectFefoBatches(req(), 5), []);
    },
  );
});

/* ==========================================================================
 * 6-7. DETERMINISTIC ORDERING
 * ========================================================================== */

test('FEFO: ordering is earliest expiry first with batch_id as a deterministic tie-breaker', async () => {
  await withMockedPool(
    (text) => {
      assert.match(text, /ORDER BY b\.expiry_date ASC, b\.batch_id ASC/);
      return {
        rows: [
          batchRow({ batch_id: 3, expiry_date: '2027-01-01' }),
          batchRow({ batch_id: 9, expiry_date: '2027-01-01' }),
          batchRow({ batch_id: 4, expiry_date: '2027-06-30' }),
        ],
        rowCount: 3,
      };
    },
    async () => {
      const result = await selectFefoBatches(req(), 5);
      assert.deepEqual(result.map((b) => b.batch_id), [3, 9, 4], 'same expiry must fall back to batch_id ASC');
    },
  );
});

/* ==========================================================================
 * 8-9. SCOPE AND EMPTY RESULTS
 * ========================================================================== */

test('FEFO: an out-of-scope inventory item yields no eligible batches', async () => {
  await withMockedPool(
    (text) => {
      assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'the scope clause must never be omitted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      assert.deepEqual(await selectFefoBatches(req([]), 5), []);
      assert.deepEqual(calls[0]!.params[1], [], 'empty scope denies by default');
    },
  );
});

test('FEFO: no eligible batches returns an empty array, not an error', async () => {
  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async () => {
      const result = await selectFefoBatches(req(), 5);
      assert.ok(Array.isArray(result));
      assert.deepEqual(result, []);
    },
  );
});

test('FEFO: an invalid inventory id short-circuits without touching the database', async () => {
  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid inventory id'); },
    async (calls) => {
      assert.deepEqual(await selectFefoBatches(req(), 0), []);
      assert.deepEqual(await selectFefoBatches(req(), -1), []);
      assert.deepEqual(await selectFefoBatches(req(), 1.5), []);
      assert.equal(calls.length, 0);
    },
  );
});

/* ==========================================================================
 * 10-12. STRICTLY READ-ONLY
 * ========================================================================== */

test('FEFO: the helper issues a single SELECT-only statement', async () => {
  await withMockedPool(
    (text) => {
      assert.match(text, /^\s*SELECT\b/, 'the helper must only read');
      assert.doesNotMatch(text, /^\s*(INSERT|UPDATE|DELETE)\b/i);
      assert.doesNotMatch(text, /\bRETURNING\b/i);
      return { rows: [batchRow()], rowCount: 1 };
    },
    async (calls) => {
      await selectFefoBatches(req(), 5);
      assert.equal(calls.length, 1, 'exactly one statement per selection');
    },
  );
});

test('FEFO: the helper never locks rows with FOR UPDATE', async () => {
  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i, 'locking belongs to Phase 10C dispensing');
      return { rows: [batchRow()], rowCount: 1 };
    },
    async () => {
      await selectFefoBatches(req(), 5);
    },
  );
});

test('FEFO: the helper never writes quantities or reserved quantities', async () => {
  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /quantity_reserved/);
      assert.doesNotMatch(text, /SET\s+\w*quantity/i);
      assert.doesNotMatch(text, /stock_movements/i, 'no movement is created by a read');
      return { rows: [batchRow()], rowCount: 1 };
    },
    async () => {
      const result = await selectFefoBatches(req(), 5);
      assert.equal(result[0]!.quantity_on_hand, 100, 'stock is reported as-is, never changed');
      assert.equal((result[0] as unknown as Record<string, unknown>).quantity_reserved, undefined, 'reserved is not exposed or altered');
    },
  );
});

/* ==========================================================================
 * LIMIT HANDLING
 * ========================================================================== */

test('FEFO: the limit is applied and clamped to a safe maximum', async () => {
  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const cases: readonly [number | undefined, number][] = [
        [3, 3],
        [MAX_FEFO_LIMIT + 500, MAX_FEFO_LIMIT],
        [undefined, DEFAULT_FEFO_LIMIT],
      ];
      for (const [input, expected] of cases) {
        await selectFefoBatches(req(), 5, input);
        assert.equal(calls[calls.length - 1]!.params[2], expected, `limit ${String(input)}`);
      }
    },
  );
});

test('FEFO: a non-positive or non-numeric limit falls back to the default', async () => {
  await withMockedPool(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      for (const input of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await selectFefoBatches(req(), 5, input);
        assert.equal(calls[calls.length - 1]!.params[2], DEFAULT_FEFO_LIMIT, String(input));
      }
    },
  );
});

test('FEFO: an admin request is not clinic-restricted', async () => {
  const adminReq = {
    body: {}, params: {}, query: {},
    user: { userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
  } as unknown as AuthenticatedRequest;

  await withMockedPool(
    (text) => {
      assert.doesNotMatch(text, /ANY\(/, 'admin scope is unlimited');
      return { rows: [batchRow()], rowCount: 1 };
    },
    async (calls) => {
      const result = await selectFefoBatches(adminReq, 5);
      assert.equal(result.length, 1);
      assert.deepEqual(calls[0]!.params, [5, DEFAULT_FEFO_LIMIT]);
    },
  );
});
