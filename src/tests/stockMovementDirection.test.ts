import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import {
  STOCK_MOVEMENT_TYPES,
  STOCK_INCREASING_TYPES,
  STOCK_DECREASING_TYPES,
  isStockIncreasing,
} from '../validations/stockMovement.validation';
import { selectFefoBatches, allocateFefoBatches } from '../modules/inventory/fefo';

/* ==========================================================================
 * Phase 10D.1 — Movement direction + quarantine foundation
 * Foundation only: no adjustment/return/waste/expiry/count operations exist yet.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

const req: AuthenticatedRequest = {
  body: {}, params: {}, query: {},
  user: { userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
} as unknown as AuthenticatedRequest;

async function captureReads(
  run: (client: { query: (t: string, p?: unknown[]) => Promise<MockResult> }, calls: QueryCall[]) => Promise<void>,
) {
  const calls: QueryCall[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 } as MockResult;
    },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return { rows: [], rowCount: 0 } as MockResult;
  };
  try {
    await run(client, calls);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

/* ==========================================================================
 * 1. ADJUSTMENT_DECREASE IS ACCEPTED
 * ========================================================================== */

test('10D.1: ADJUSTMENT_DECREASE is a supported movement type', () => {
  assert.ok(STOCK_MOVEMENT_TYPES.includes('ADJUSTMENT_DECREASE'));
  assert.equal(STOCK_DECREASING_TYPES.includes('ADJUSTMENT_DECREASE'), true);
  assert.equal(STOCK_INCREASING_TYPES.includes('ADJUSTMENT_DECREASE'), false);
  assert.equal(isStockIncreasing('ADJUSTMENT_DECREASE'), false, 'it must decrease stock');
});

/* ==========================================================================
 * 2. EXISTING MOVEMENT TYPES STILL ACCEPTED
 * ========================================================================== */

test('10D.1: all six original movement types remain supported', () => {
  for (const type of ['RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'WASTE', 'EXPIRE'] as const) {
    assert.ok(STOCK_MOVEMENT_TYPES.includes(type), type);
  }
  assert.equal(STOCK_MOVEMENT_TYPES.length, 7, 'exactly one type was added');
});

/* ==========================================================================
 * 3. EXISTING ADJUSTMENT SEMANTICS UNCHANGED
 * ========================================================================== */

test('10D.1: ADJUSTMENT still increases stock — its meaning was never flipped', () => {
  assert.ok(STOCK_INCREASING_TYPES.includes('ADJUSTMENT'));
  assert.equal(STOCK_DECREASING_TYPES.includes('ADJUSTMENT'), false);
  assert.equal(isStockIncreasing('ADJUSTMENT'), true);
});

test('10D.1: direction is a total, non-overlapping partition of every type', () => {
  const increasing = new Set<string>(STOCK_INCREASING_TYPES);
  const decreasing = new Set<string>(STOCK_DECREASING_TYPES);

  for (const type of STOCK_MOVEMENT_TYPES) {
    assert.equal(increasing.has(type) !== decreasing.has(type), true, `${type} must have exactly one direction`);
  }
  assert.equal(increasing.size + decreasing.size, STOCK_MOVEMENT_TYPES.length, 'no type may be unclassified');
});

/* ==========================================================================
 * 4. QUANTITY REMAINS POSITIVE / NO SIGNED QUANTITIES
 * ========================================================================== */

test('10D.1: direction is derived from the type, not from a sign on the quantity', async () => {
  await captureReads(async (client, calls) => {
    const result = await allocateFefoBatches(client as never, req, 5, 5);
    assert.equal(result.ok, false, 'no eligible rows, so nothing is allocated');

    for (const call of calls) {
      assert.doesNotMatch(call.text, /direction/i, 'no direction column or literal is introduced');
      assert.doesNotMatch(call.text, /-\s*\$?\d*\s*quantity|quantity\s*<>\s*0/i, 'no signed quantity comparison');
    }
  });
});

/* ==========================================================================
 * 5. QUARANTINE IS EXCLUDED FROM FEFO (schema predicate only)
 * ========================================================================== */

test('10D.1: the locked allocator excludes actively quarantined batches', async () => {
  await captureReads(async (client, calls) => {
    await allocateFefoBatches(client as never, req, 5, 5);

    const sql = calls[0]!.text;
    assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM batch_quarantines bq/, 'quarantine must be excluded');
    assert.match(sql, /bq\.batch_id = b\.batch_id/);
    assert.match(sql, /bq\.released_at IS NULL/, 'a released quarantine no longer blocks dispensing');
    assert.match(sql, /FOR UPDATE OF b/, 'locking semantics are otherwise unchanged');
  });
});

test('10D.1: the read-only FEFO helper excludes quarantined batches too', async () => {
  await captureReads(async (_client, calls) => {
    await selectFefoBatches(req, 5);
    assert.match(calls[0]!.text, /NOT EXISTS \(\s*SELECT 1 FROM batch_quarantines bq/);
    assert.doesNotMatch(calls[0]!.text, /FOR\s+UPDATE/i, 'the read helper stays lock-free');
  });
});

test('10D.1: FEFO eligibility rules and ordering are otherwise untouched', async () => {
  await captureReads(async (client, calls) => {
    await allocateFefoBatches(client as never, req, 5, 5);
    const sql = calls[0]!.text;

    assert.match(sql, /b\.is_active = TRUE/);
    assert.match(sql, /i\.deleted_at IS NULL/);
    assert.match(sql, /b\.quantity_on_hand > 0/);
    assert.match(sql, /b\.expiry_date >= CURRENT_DATE/);
    assert.match(sql, /ORDER BY b\.expiry_date ASC, b\.batch_id ASC/);
    assert.doesNotMatch(sql, /SKIP\s+LOCKED/i);
    assert.doesNotMatch(sql, /quantity_reserved/, 'reserved stock is still never used here');
  });
});

/* ==========================================================================
 * 6. NO OPERATIONS EXIST YET
 * ========================================================================== */

test('10D.1: no quarantine mutation is possible through the FEFO helpers', async () => {
  await captureReads(async (client, calls) => {
    await allocateFefoBatches(client as never, req, 5, 5);
    for (const call of calls) {
      assert.match(call.text.trim(), /^\s*SELECT\b/, 'the foundation is read-only');
      assert.doesNotMatch(call.text, /INSERT INTO batch_quarantines/i);
      assert.doesNotMatch(call.text, /UPDATE batch_quarantines/i);
    }
  });
});
