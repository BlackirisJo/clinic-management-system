import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import {
  allocateFefoBatches,
  selectFefoBatches,
  type FefoAllocationResult,
} from '../modules/inventory/fefo';

/* ==========================================================================
 * Phase 10C.2 — Locked FEFO allocator
 * The allocator runs on a supplied transaction client, so pool.query must never
 * be touched. A real multi-process race is out of scope here; these structural
 * tests pin the locking contract the future dispensing transaction relies on.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const pharmacist = (clinicIds: number[] = [1]) => ({
  userId: 5, roleId: 4, clinicId: clinicIds[0] ?? null, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds,
});

const req = (clinicIds: number[] = [1]): AuthenticatedRequest =>
  ({ body: {}, params: {}, query: {}, user: pharmacist(clinicIds) } as unknown as AuthenticatedRequest);

const row = (over: Record<string, unknown> = {}): QueryRow => ({
  batch_id: 7, inventory_id: 5, lot_number: 'LOT-001', expiry_date: '2027-01-31', quantity_on_hand: 100, ...over,
});

/** Runs the allocator against a stub transaction client. */
async function withClient(
  rows: QueryRow[],
  run: (client: any, calls: QueryCall[], poolCalls: QueryCall[]) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  const poolCalls: QueryCall[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length } as MockResult;
    },
  };
  const ORIGINAL_QUERY = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    poolCalls.push({ text, params });
    return { rows: [], rowCount: 0 } as MockResult;
  };
  try {
    await run(client, calls, poolCalls);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

/** Runs the allocator against a stub transaction client and returns its outcome. */
async function allocate(
  rows: QueryRow[],
  qty: number,
  r: AuthenticatedRequest = req(),
): Promise<FefoAllocationResult> {
  let outcome!: FefoAllocationResult;
  await withClient(rows, async (client) => {
    outcome = await allocateFefoBatches(client, r, 5, qty);
  });
  return outcome;
}

/* ==========================================================================
 * 1-4. ALLOCATION + FEFO ORDERING
 * ========================================================================== */

test('ALLOC: a single eligible batch satisfies the full request', async () => {
  const result = await allocate([row({ quantity_on_hand: 100 })], 30);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0]!.batch_id, 7);
  assert.equal(result.allocations[0]!.allocation, 30);
  assert.equal(result.allocations[0]!.quantity_on_hand, 100, 'the locked on-hand value is reported');
  assert.equal(result.allocated_quantity, 30);
});

test('ALLOC: multiple batches are filled in FEFO order (5 + 7 + 3 of a 15 request)', async () => {
  const result = await allocate(
    [
      row({ batch_id: 1, lot_number: 'A', expiry_date: '2027-01-01', quantity_on_hand: 5 }),
      row({ batch_id: 2, lot_number: 'B', expiry_date: '2027-02-01', quantity_on_hand: 7 }),
      row({ batch_id: 3, lot_number: 'C', expiry_date: '2027-06-01', quantity_on_hand: 20 }),
    ],
    15,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.allocations.map((a) => a.lot_number), ['A', 'B', 'C']);
  assert.deepEqual(result.allocations.map((a) => a.allocation), [5, 7, 3]);
  assert.equal(result.allocated_quantity, 15);
});

test('ALLOC: allocation never exceeds the locked quantity_on_hand of a batch', async () => {
  const result = await allocate(
    [
      row({ batch_id: 1, quantity_on_hand: 5 }),
      row({ batch_id: 2, quantity_on_hand: 7 }),
      row({ batch_id: 3, quantity_on_hand: 20 }),
    ],
    12,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const allocation of result.allocations) {
    assert.ok(allocation.allocation <= allocation.quantity_on_hand, `batch ${allocation.batch_id}`);
    assert.ok(allocation.allocation > 0, 'an allocation is always positive');
  }
  assert.equal(result.allocated_quantity, 12);
});

test('ALLOC: unused eligible batches are not allocated beyond the request', async () => {
  const result = await allocate(
    [
      row({ batch_id: 1, quantity_on_hand: 5 }),
      row({ batch_id: 2, quantity_on_hand: 50 }),
    ],
    5,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.allocations.length, 1, 'a satisfied request stops at the first enough batches');
  assert.equal(result.allocations[0]!.batch_id, 1);
});

test('ALLOC: 3-decimal quantities allocate without floating point drift', async () => {
  const result = await allocate([row({ quantity_on_hand: 0.3 })], 0.1);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.allocations[0]!.allocation, 0.1);
  assert.equal(result.allocated_quantity, 0.1);
});

/* ==========================================================================
 * 5-9. ELIGIBILITY (asserted structurally on the generated SQL)
 * ========================================================================== */

test('ELIGIBILITY: the locked query applies every FEFO rule and FEFO ordering', async () => {
  await withClient([], async (client, calls) => {
    await allocateFefoBatches(client, req(), 5, 10);
    const sql = calls[0]!.text;

    assert.match(sql, /b\.inventory_id = \$1/);
    assert.match(sql, /b\.is_active = TRUE/, 'inactive batches excluded');
    assert.match(sql, /i\.deleted_at IS NULL/, 'archived items excluded');
    assert.match(sql, /b\.quantity_on_hand > 0/, 'zero-stock batches excluded');
    assert.match(sql, /b\.expiry_date >= CURRENT_DATE/, 'expired batches excluded');
    assert.match(sql, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'clinic scope through the item join');
    assert.match(sql, /ORDER BY b\.expiry_date ASC, b\.batch_id ASC/, 'earliest expiry then batch_id');
  });
});

test('ELIGIBILITY: an out-of-clinic inventory item yields no eligible batch', async () => {
  await withClient([], async (client, calls) => {
    const outcome = await allocateFefoBatches(client, req([]), 5, 10);

    assert.deepEqual(calls[0]!.params[1], [], 'empty scope denies by default');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'NO_ELIGIBLE_BATCH');
    assert.equal(outcome.available_quantity, 0);
  });
});

test('ELIGIBILITY: an admin request is not clinic-restricted', async () => {
  const adminReq = {
    body: {}, params: {}, query: {},
    user: { userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
  } as unknown as AuthenticatedRequest;

  await withClient([], async (client, calls) => {
    await allocateFefoBatches(client, adminReq, 5, 10);
    assert.doesNotMatch(calls[0]!.text, /ANY\(/);
    assert.deepEqual(calls[0]!.params, [5]);
  });
});

/* ==========================================================================
 * 10. INSUFFICIENT STOCK
 * ========================================================================== */

test('STOCK: an unmet request returns a domain failure without any allocation', async () => {
  const result = await allocate(
    [
      row({ batch_id: 1, quantity_on_hand: 5 }),
      row({ batch_id: 2, quantity_on_hand: 7 }),
    ],
    20,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'INSUFFICIENT_STOCK');
  assert.equal(result.requested_quantity, 20);
  assert.equal(result.available_quantity, 12, 'the caller learns how much is actually available');
});

test('STOCK: an empty candidate set is distinguished from a shortage', async () => {
  const result = await allocate([], 10);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'NO_ELIGIBLE_BATCH');
});

test('STOCK: the allocator never partially allocates on failure', async () => {
  await withClient([row({ quantity_on_hand: 4 })], async (client, calls) => {
    const outcome = await allocateFefoBatches(client, req(), 5, 10);
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 1, 'only the locking read is issued — nothing else is attempted');
  });
});

/* ==========================================================================
 * 11-12. INPUT VALIDATION (rejected before any query)
 * ========================================================================== */

test('VALIDATION: invalid quantities are rejected before querying', async () => {
  for (const quantity of [0, -1, 1.2345, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000]) {
    await withClient([], async (client, calls) => {
      await assert.rejects(
        () => allocateFefoBatches(client, req(), 5, quantity),
        `quantity ${String(quantity)} should be rejected`,
      );
      assert.equal(calls.length, 0, `quantity ${String(quantity)} must be rejected before querying`);
    });
  }
});

test('VALIDATION: an invalid inventory_id is rejected before querying', async () => {
  for (const inventoryId of [0, -5, 1.5]) {
    await withClient([], async (client, calls) => {
      await assert.rejects(
        () => allocateFefoBatches(client, req(), inventoryId, 10),
        `inventory_id ${String(inventoryId)} should be rejected`,
      );
      assert.equal(calls.length, 0);
    });
  }
});

/* ==========================================================================
 * 13. TRANSACTION CLIENT
 * ========================================================================== */

test('CLIENT: the allocator runs entirely on the supplied transaction client', async () => {
  await withClient([row()], async (client, calls, poolCalls) => {
    await allocateFefoBatches(client, req(), 5, 10);
    assert.equal(calls.length, 1, 'the lock query goes through the client');
    assert.equal(poolCalls.length, 0, 'pool.query must never be used inside a transaction');
  });
});

test('CLIENT: the allocator does not commit or roll back the outer transaction', async () => {
  await withClient([row()], async (client, calls) => {
    await allocateFefoBatches(client, req(), 5, 10);
    for (const call of calls) {
      assert.notEqual(call.text, 'COMMIT');
      assert.notEqual(call.text, 'ROLLBACK');
      assert.notEqual(call.text, 'BEGIN');
    }
  });
});

/* ==========================================================================
 * 14-16. LOCKING CONTRACT
 * ========================================================================== */

test('LOCK: the allocator locks rows with FOR UPDATE', async () => {
  await withClient([row()], async (client, calls) => {
    await allocateFefoBatches(client, req(), 5, 10);
    assert.match(calls[0]!.text, /FOR UPDATE OF b/);
  });
});

test('LOCK: the allocator never uses SKIP LOCKED (strict FEFO must wait, not skip)', async () => {
  await withClient([row()], async (client, calls) => {
    await allocateFefoBatches(client, req(), 5, 10);
    assert.doesNotMatch(calls[0]!.text, /SKIP\s+LOCKED/i);
  });
});

test('LOCK: the allocator performs no INSERT, UPDATE or DELETE', async () => {
  await withClient([row()], async (client, calls) => {
    await allocateFefoBatches(client, req(), 5, 10);
    for (const call of calls) {
      assert.match(call.text, /^\s*SELECT\b/, `non-SELECT issued: ${call.text}`);
      assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE)\b/i);
      assert.doesNotMatch(call.text, /RETURNING/i);
      assert.doesNotMatch(call.text, /quantity_reserved/, 'reserved stock is never used or written');
      assert.doesNotMatch(call.text, /stock_movements/i, 'no movement is created by the allocator');
    }
  });
});

test('LOCK: the read-only selectFefoBatches() stays unlocked and unchanged', async () => {
  const calls: QueryCall[] = [];
  const ORIGINAL_QUERY = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return { rows: [row()], rowCount: 1 } as MockResult;
  };
  try {
    const batches = await selectFefoBatches(req(), 5);
    assert.equal(batches.length, 1);
    assert.doesNotMatch(calls[0]!.text, /FOR\s+UPDATE/i, 'the read helper must remain lock-free');
    assert.doesNotMatch(calls[0]!.text, /SKIP\s+LOCKED/i);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
});
