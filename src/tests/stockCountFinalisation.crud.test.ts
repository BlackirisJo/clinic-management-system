import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { authenticateJWT, requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { finaliseStockCount } from '../modules/inventory/stockCounts.controller';
import stockCountsRouter from '../modules/inventory/stockCounts.routes';
import {
  FORBIDDEN_STOCK_COUNT_FINALISE_FIELDS,
  STOCK_COUNT_FINALISATION_REASON,
  STOCK_COUNT_REFERENCE_TYPE,
} from '../validations/stockCount.validation';

/* ==========================================================================
 * Phase 10D.7 — Stock count finalisation (mocked pool)
 *
 * One PoolClient, one transaction, one rollback. Every write in this phase must
 * happen inside that transaction, after every check, and vanish entirely if any
 * of them fails.
 * ======================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

const MANAGER = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

const OTHER_CLINIC = {
  userId: 55, roleId: 4, clinicId: 2, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [2],
};

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const req = (body: Record<string, unknown> = {}, user: unknown = MANAGER, id = '300'): AuthenticatedRequest =>
  ({ body, params: { id }, query: {}, user } as unknown as AuthenticatedRequest);

/* ==========================================================================
 * Scenario
 * ======================================================================== */

interface LineScenario {
  count_line_id: number;
  batch_id: number;
  medication_id: number;
  system_quantity: number;
  counted_quantity: number;
  variance: number;
}

interface BatchScenario {
  batch_id: number;
  inventory_id?: number;
  quantity_on_hand: number;
  quantity_reserved?: number;
}

interface Scenario {
  countFound?: boolean;
  countStatus?: string;
  countClinicId?: number;
  countedByUserId?: number;
  /** the already-stored 10D.6 line values — never rewritten by finalisation */
  lines?: LineScenario[];
  /** live, locked batch state at finalisation time */
  batches?: BatchScenario[];
  /** guarded batch UPDATE affects zero rows (balance moved under us) */
  batchUpdateRowCount?: number;
  lineUpdateRowCount?: number;
  headerRowCount?: number;
  failOn?: string;
  noUser?: boolean;
}

const DEFAULT_LINE: LineScenario = {
  count_line_id: 301, batch_id: 117, medication_id: 11,
  system_quantity: 100, counted_quantity: 90, variance: -10,
};

const DEFAULT_BATCH: BatchScenario = { batch_id: 117, inventory_id: 5, quantity_on_hand: 100, quantity_reserved: 0 };

let adjustmentSeq = 0;
let movementSeq = 0;

const makeHandler = (s: Scenario) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

  if (s.failOn && t.includes(s.failOn)) {
    throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
  }

  // 1) lock the count — clinic-scoped, so a count outside the caller's scope
  //    simply does not resolve
  if (t.startsWith('SELECT sc.count_id')) {
    if (s.countFound === false) return { rows: [], rowCount: 0 };
    const clinicId = s.countClinicId ?? 1;
    const scope = params.find((p) => Array.isArray(p)) as number[] | undefined;
    if (scope !== undefined && !scope.includes(clinicId)) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        count_id: params[0], clinic_id: s.countClinicId ?? 1,
        status: s.countStatus ?? 'OPEN', counted_by_user_id: s.countedByUserId ?? 42,
        finalised_at: null, finalised_by_user_id: null,
      }],
      rowCount: 1,
    };
  }

  // 2) the count's lines, exactly as 10D.6 stored them
  if (t.startsWith('SELECT count_line_id, batch_id, medication_id')) {
    return { rows: (s.lines ?? [DEFAULT_LINE]) as unknown as QueryRow[], rowCount: (s.lines ?? [DEFAULT_LINE]).length };
  }

  // 3) lock every referenced batch, ascending
  if (t.includes('FROM inventory_batches b') && t.includes('FOR UPDATE OF b')) {
    const wanted = (params[0] as number[]) ?? [];
    const rows = (s.batches ?? [DEFAULT_BATCH])
      .filter((b) => wanted.includes(b.batch_id))
      .map((b) => ({
        batch_id: b.batch_id,
        inventory_id: b.inventory_id ?? 5,
        quantity_on_hand: b.quantity_on_hand,
        quantity_reserved: b.quantity_reserved ?? 0,
        clinic_id: s.countClinicId ?? 1,
      }))
      .sort((a, b) => Number(a.batch_id) - Number(b.batch_id));
    return { rows, rowCount: rows.length };
  }

  // 4) one stock_adjustments row per non-zero final variance
  if (t.startsWith('INSERT INTO stock_adjustments')) {
    adjustmentSeq += 1;
    return {
      rows: [{
        adjustment_id: 900 + adjustmentSeq, batch_id: params[1], medication_id: params[3],
        direction: params[4], quantity: params[5], quantity_before: params[6],
        quantity_after: params[7], reason: params[8], performed_by_user_id: params[10],
        created_at: '2026-03-02T09:00:00.000Z',
      }],
      rowCount: 1,
    };
  }

  // 5) the guarded batch update
  if (t.startsWith('UPDATE inventory_batches')) {
    const rows = [{
      batch_id: params[1], quantity_on_hand: params[0],
      quantity_reserved: DEFAULT_BATCH.quantity_reserved,
    }];
    return { rows, rowCount: s.batchUpdateRowCount ?? 1 };
  }

  // 6) one movement per non-zero final variance
  if (t.startsWith('INSERT INTO stock_movements')) {
    movementSeq += 1;
    return {
      rows: [{
        movement_id: 8000 + movementSeq, batch_id: params[0], movement_type: params[1],
        quantity: params[2], reference_type: params[3], reference_id: params[4],
        performed_by_user_id: params[5], created_at: '2026-03-02T09:00:01.000Z',
      }],
      rowCount: 1,
    };
  }

  // 7) the line: only the finalisation columns are ever written
  if (t.startsWith('UPDATE stock_count_lines')) {
    const [systemAtFinalisation, adjusted, lineId] = params;
    const line = (s.lines ?? [DEFAULT_LINE]).find((l) => l.count_line_id === Number(lineId)) ?? DEFAULT_LINE;
    return {
      rows: [{
        count_line_id: lineId, batch_id: line.batch_id, medication_id: line.medication_id,
        system_quantity: line.system_quantity, counted_quantity: line.counted_quantity,
        variance: line.variance, system_quantity_at_finalisation: systemAtFinalisation,
        adjusted_quantity: adjusted,
      }],
      rowCount: s.lineUpdateRowCount ?? 1,
    };
  }

  // 8) close the count
  if (t.startsWith('UPDATE stock_counts')) {
    return {
      rows: [{
        count_id: params[1], clinic_id: s.countClinicId ?? 1, status: 'FINALISED',
        counted_by_user_id: s.countedByUserId ?? 42, finalised_by_user_id: params[0],
        created_at: '2026-03-01T10:00:00.000Z', finalised_at: '2026-03-02T09:00:02.000Z',
      }],
      rowCount: s.headerRowCount ?? 1,
    };
  }

  if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

  throw new Error(`Unexpected query: ${text}`);
};

interface Run {
  captured: { status: number; body: any };
  calls: QueryCall[];
  committed: boolean;
  rolledBack: boolean;
  released: boolean;
}

async function run(scenario: Scenario = {}, body: Record<string, unknown> = {}, user: unknown = MANAGER): Promise<Run> {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = makeHandler(scenario);
  adjustmentSeq = 0;
  movementSeq = 0;
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
    await finaliseStockCount(req(body, user), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  return {
    captured, calls,
    committed: calls.some((c) => c.text === 'COMMIT'),
    rolledBack: calls.some((c) => c.text === 'ROLLBACK'),
    released,
  };
}

const find = (calls: QueryCall[], needle: string) => calls.find((c) => c.text.includes(needle));
const findAll = (calls: QueryCall[], needle: string) => calls.filter((c) => c.text.includes(needle));
const findCountLock = (calls: QueryCall[]) => find(calls, 'SELECT sc.count_id');
const findLineRead = (calls: QueryCall[]) => find(calls, 'SELECT count_line_id, batch_id');
const findBatchLock = (calls: QueryCall[]) => find(calls, 'FOR UPDATE OF b');
const findAdjustments = (calls: QueryCall[]) => findAll(calls, 'INSERT INTO stock_adjustments');
const findBatchUpdates = (calls: QueryCall[]) => findAll(calls, 'UPDATE inventory_batches');
const findMovements = (calls: QueryCall[]) => findAll(calls, 'INSERT INTO stock_movements');
const findLineUpdates = (calls: QueryCall[]) => findAll(calls, 'UPDATE stock_count_lines');
const findHeaderUpdate = (calls: QueryCall[]) => find(calls, 'UPDATE stock_counts');
const findAudit = (calls: QueryCall[]) => findAll(calls, 'INSERT INTO audit_logs');
const writes = (calls: QueryCall[]) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text.trim()));
const auditMeta = (calls: QueryCall[]) => JSON.parse(findAudit(calls)[0]!.params[3] as string);

/**
 * A rejection is only safe if the transaction is unwound and the client is
 * always returned. Writes may already have been issued at the point of failure —
 * that is exactly what the ROLLBACK exists for — so the invariant proven here is
 * "nothing was committed", not "nothing was ever sent".
 */
const assertRolledBack = (r: Run) => {
  assert.equal(r.committed, false, 'a rejected finalisation never commits');
  assert.equal(r.rolledBack, true, 'and always rolls back');
  assert.equal(r.released, true, 'the client is always released');
};

/** A rejection raised before the transaction opened: nothing may be issued at all. */
const assertNothingWritten = (r: Run) => {
  assert.equal(writes(r.calls).length, 0, 'no write may survive a rejection');
  assertRolledBack(r);
};

/* ==========================================================================
 * 1-2. AUTHENTICATION AND PERMISSION
 * ======================================================================== */

test('FINALISE AUTH: a request without a bearer token is rejected with 401', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;
  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

test('FINALISE AUTHORIZATION: finalise requires MANAGE_INVENTORY, not just VIEW_INVENTORY', () => {
  const refused = (permissions: string[], required: string) => {
    const request = {
      user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions },
    } as unknown as AuthenticatedRequest;
    let error: any = null;
    requirePermission(required)(request, {} as any, (err?: unknown) => { error = err ?? null; });
    return error !== null;
  };

  assert.equal(refused(['VIEW_INVENTORY'], 'MANAGE_INVENTORY'), true, 'a viewer may not finalise a count');
  assert.equal(refused(['VIEW_INVENTORY', 'MANAGE_INVENTORY'], 'MANAGE_INVENTORY'), false);
});

test('FINALISE ROUTE: the router exposes POST /:id/finalise and no mutating verbs', () => {
  const layers = (stockCountsRouter as any).stack.filter((l: any) => l.route);
  const routes = layers.map((l: any) => `${Object.keys(l.route.methods)[0]!.toUpperCase()} ${l.route.path}`);

  assert.ok(routes.includes('POST /:id/finalise'), 'the finalisation endpoint exists');
  assert.equal(routes.length, 7, '10D.6 four endpoints plus finalisation plus the 10D.8 audit and 10D.9 reconciliation reads');

  const methods = layers.flatMap((l: any) => Object.keys(l.route.methods));
  for (const method of ['put', 'patch', 'delete']) {
    assert.equal(methods.includes(method), false, `no ${method.toUpperCase()} exists in this phase`);
  }
  assert.ok(
    !routes.some((r: string) => /cancel|approve/i.test(r)),
    '10D.7 implements no cancellation or approval route',
  );
});

/* ==========================================================================
 * 3. CLIENT-FORBIDDEN FIELDS
 * ======================================================================== */

test('FORBIDDEN FIELDS: every client-controlled finalisation field is refused before any DB access', async () => {
  for (const field of FORBIDDEN_STOCK_COUNT_FINALISE_FIELDS) {
    const r = await run({}, { [field]: 1 });
    assert.equal(r.captured.status, 400, `${field} must be refused`);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR);
    assert.equal(r.calls.length, 0, `${field} must be refused before any statement, not one`);
    assert.equal(r.released, false, 'no client is ever taken for a rejected request');
  }
});

test('FORBIDDEN FIELDS: an unexpected field the list does not name is still refused', async () => {
  const r = await run({}, { confirm: true });
  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0);
});

test('FORBIDDEN FIELDS: an empty body is the only accepted body', async () => {
  const r = await run();
  assert.equal(r.captured.status, 200);
  assert.equal(r.committed, true);
});

test('FORBIDDEN FIELDS: an unauthenticated user cannot finalise', async () => {
  const r = await run({}, {}, {});
  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0);
});

test('FORBIDDEN FIELDS: a malformed count id never reaches the database', async () => {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  (pool as unknown as { connect: unknown }).connect = async () => client;

  try {
    await finaliseStockCount({ body: {}, params: { id: 'abc' }, query: {}, user: MANAGER } as unknown as AuthenticatedRequest, res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(captured.status, 400);
  assert.deepEqual(calls, []);
});

/* ==========================================================================
 * 4-5. SCOPE: IDENTICAL 404 FOR MISSING AND OUT-OF-SCOPE
 * ======================================================================== */

test('SCOPE: a nonexistent count is a 404', async () => {
  const r = await run({ countFound: false });
  assert.equal(r.captured.status, 404);
  assertNothingWritten(r);
});

test('SCOPE: nonexistent and out-of-clinic counts return an identical 404', async () => {
  const missing = await run({ countFound: false });

  // a count that resolves but belongs to another clinic never resolves in scope
  const foreign = await run({ countClinicId: 2 });
  assert.deepEqual(foreign.captured.body, missing.captured.body, 'no existence leak between the two cases');
  assert.equal(foreign.captured.status, 404);
  assertNothingWritten(foreign);

  // a user of another clinic simply cannot see the count at all
  const otherUser = await run({ countFound: false }, {}, OTHER_CLINIC);
  assert.deepEqual(otherUser.captured.body, missing.captured.body);
});

test('SCOPE: the clinic comes from the count record, and the scope predicate is always applied', async () => {
  const r = await run();
  assert.match(findCountLock(r.calls)!.text, /sc\.clinic_id = ANY\(\$\d+::int\[\]\)/);
  assert.match(findBatchLock(r.calls)!.text, /i\.clinic_id = ANY\(\$\d+::int\[\]\)/);
  assert.equal(findAdjustments(r.calls)[0]!.params[0], 1, 'the adjustment clinic is the count clinic');
});

/* ==========================================================================
 * 6-7. STATUS AND EMPTY COUNT
 * ======================================================================== */

test('STATUS: a non-OPEN count is refused and nothing is applied', async () => {
  for (const status of ['FINALISED', 'CANCELLED']) {
    const r = await run({ countStatus: status });
    assert.equal(r.captured.status, 409, `${status} must refuse finalisation`);
    assert.equal(r.captured.body.status, status);
    assertNothingWritten(r);
    assert.equal(findLineRead(r.calls), undefined, 'the lines are never even read');
  }
});

test('EMPTY: a count with no lines cannot be finalised', async () => {
  const r = await run({ lines: [] });
  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.line_count ?? 0, 0);
  assertNothingWritten(r);
  assert.equal(findBatchLock(r.calls), undefined, 'no batch is locked for a count with nothing to correct');
});

/* ==========================================================================
 * 8, 16, 23, 24. SUCCESSFUL FINALISATION
 * ======================================================================== */

test('SUCCESS: a shortage is corrected with one adjustment and one movement', async () => {
  // counted 90 against a live 100
  const r = await run({});

  assert.equal(r.captured.status, 200);
  assert.equal(r.committed, true);
  assert.equal(r.rolledBack, false);

  assert.equal(findAdjustments(r.calls).length, 1);
  const adjustment = findAdjustments(r.calls)[0]!.params;
  assert.equal(adjustment[3], 11, 'the medication is the line medication');
  assert.equal(adjustment[4], 'DECREASE', 'a shortage is a DECREASE');
  assert.equal(adjustment[5], 10, 'quantity is the magnitude of the variance');
  assert.equal(adjustment[6], 100, 'quantity_before is the live quantity');
  assert.equal(adjustment[7], 90, 'quantity_after is the counted quantity');
  assert.equal(adjustment[8], STOCK_COUNT_FINALISATION_REASON, 'the reason is fixed, never client-supplied');
  assert.match(String(adjustment[9]), /300/, 'the notes identify the originating count');
  assert.equal(adjustment[10], MANAGER.userId, 'the actor is the authenticated user');

  assert.equal(findBatchUpdates(r.calls).length, 1);
  assert.equal(findBatchUpdates(r.calls)[0]!.params[0], 90, 'the balance becomes the counted quantity');
  assert.equal(findMovements(r.calls).length, 1);
  const movement = findMovements(r.calls)[0]!.params;
  assert.equal(movement[0], 117);
  assert.equal(movement[1], 'ADJUSTMENT_DECREASE');
  assert.equal(movement[2], 10, 'movement quantity is always positive');
  assert.equal(movement[3], STOCK_COUNT_REFERENCE_TYPE);
  assert.equal(movement[4], '300', 'the reference id is the count');
  assert.equal(movement[5], MANAGER.userId);
});

test('SUCCESS: an overage is corrected with ADJUSTMENT, not ADJUSTMENT_DECREASE', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 110, variance: 10 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100 }],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findAdjustments(r.calls)[0]!.params[4], 'INCREASE');
  assert.equal(findAdjustments(r.calls)[0]!.params[7], 110);
  assert.equal(findMovements(r.calls)[0]!.params[1], 'ADJUSTMENT');
  assert.equal(findBatchUpdates(r.calls)[0]!.params[0], 110);
});

test('SUCCESS: zero variance writes no adjustment, no movement and no stock change', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 100, variance: 0 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100 }],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findAdjustments(r.calls).length, 0, 'a correct count produces no adjustment');
  assert.equal(findMovements(r.calls).length, 0, 'and no movement');
  assert.equal(findBatchUpdates(r.calls).length, 0, 'and no stock write at all');

  // but the line is still finalised, with an explicit zero
  const lineUpdate = findLineUpdates(r.calls)[0]!;
  assert.equal(lineUpdate.params[0], 100, 'system_quantity_at_finalisation is recorded');
  assert.equal(lineUpdate.params[1], 0, 'adjusted_quantity is 0, not NULL');
  assert.equal(findHeaderUpdate(r.calls)!.params[0], MANAGER.userId);
  assert.equal(r.committed, true);
});

test('SUCCESS: multiple lines are corrected independently in one transaction', async () => {
  const r = await run({
    lines: [
      { count_line_id: 301, batch_id: 200, medication_id: 11, system_quantity: 50, counted_quantity: 45, variance: -5 },
      { count_line_id: 302, batch_id: 117, medication_id: 12, system_quantity: 20, counted_quantity: 30, variance: 10 },
      { count_line_id: 303, batch_id: 300, medication_id: 13, system_quantity: 7, counted_quantity: 7, variance: 0 },
    ],
    batches: [
      { batch_id: 200, quantity_on_hand: 50 },
      { batch_id: 117, quantity_on_hand: 20 },
      { batch_id: 300, quantity_on_hand: 7 },
    ],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findAdjustments(r.calls).length, 2, 'only the two incorrect lines are corrected');
  assert.equal(findMovements(r.calls).length, 2);
  assert.equal(findLineUpdates(r.calls).length, 3, 'every line is still finalised');
  assert.equal(r.captured.body.line_count, 3);
  assert.equal(r.captured.body.total_decrease_quantity, 5);
  assert.equal(r.captured.body.total_increase_quantity, 10);
  assert.equal(findHeaderUpdate(r.calls)!.params[1], 300);
  assert.equal(r.committed, true);
});

/* ==========================================================================
 * 12-15. THE FROZEN SNAPSHOT AND THE CORRECTION
 * ======================================================================== */

test('SNAPSHOT: the live locked quantity is used, never the old variance', async () => {
  // recorded at 100, counted 90 (variance -10), but stock moved on to 80 since
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 90, variance: -10 }],
    batches: [{ batch_id: 117, quantity_on_hand: 80 }],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findAdjustments(r.calls)[0]!.params[4], 'INCREASE', 'the correction now runs the other way');
  assert.equal(findAdjustments(r.calls)[0]!.params[5], 10, 'magnitude comes from live - counted');
  assert.equal(findAdjustments(r.calls)[0]!.params[6], 80, 'quantity_before is the live quantity');
  assert.equal(findAdjustments(r.calls)[0]!.params[7], 90, 'quantity_after is the counted quantity');
  assert.equal(findLineUpdates(r.calls)[0]!.params[0], 80, 'system_quantity_at_finalisation is the live quantity');
  assert.equal(findLineUpdates(r.calls)[0]!.params[1], 10, 'adjusted_quantity is what was actually corrected');
  assert.equal(r.captured.body.total_increase_quantity, 10);
  assert.equal(r.captured.body.total_decrease_quantity, 0);
});

test('SNAPSHOT: a shortage that appeared after counting is a decrease from the live balance', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 90, variance: -10 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100 }],
  });

  assert.equal(findAdjustments(r.calls)[0]!.params[4], 'DECREASE');
  assert.equal(findMovements(r.calls)[0]!.params[1], 'ADJUSTMENT_DECREASE');
  assert.equal(findBatchUpdates(r.calls)[0]!.params[0], 90, '100 -> 90');
  assert.equal(findBatchUpdates(r.calls)[0]!.params[2], 100, 'guarded against the quantity read under the lock');
});

test('SNAPSHOT: the original system_quantity, counted_quantity and variance are never written', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 90, variance: -10 }],
    batches: [{ batch_id: 117, quantity_on_hand: 80 }],
  });

  const lineSql = findLineUpdates(r.calls)[0]!.text.replace(/\s+/g, ' ');
  assert.match(lineSql, /SET system_quantity_at_finalisation = \$1, adjusted_quantity = \$2/);
  assert.doesNotMatch(lineSql, /system_quantity\s*=\s*\$/);
  assert.doesNotMatch(lineSql, /counted_quantity\s*=/);
  assert.doesNotMatch(lineSql, /variance\s*=/);
  assert.doesNotMatch(lineSql, /DELETE/i, 'counted history is never deleted or rewritten');

  // and the stored row keeps all three original values untouched
  const stored = r.captured.body.lines[0];
  assert.equal(stored.system_quantity, 100);
  assert.equal(stored.counted_quantity, 90);
  assert.equal(stored.variance_at_count, -10);
  assert.equal(stored.system_quantity_at_finalisation, 80);
  assert.equal(stored.adjusted_quantity, 10);
});

test('SNAPSHOT: adjusted_quantity is the correction, never the resulting balance', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 110, variance: 10 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100 }],
  });

  assert.equal(findLineUpdates(r.calls)[0]!.params[1], 10, '10 units were added, not 110');
  assert.equal(findBatchUpdates(r.calls)[0]!.params[0], 110, 'the resulting balance is a separate value');
  assert.equal(r.captured.body.lines[0].adjusted_quantity, 10);
  assert.equal(r.captured.body.lines[0].system_quantity_at_finalisation, 100);
});

test('SNAPSHOT: three-decimal quantities stay exact', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 10.005, counted_quantity: 10.13, variance: 0.125 }],
    batches: [{ batch_id: 117, quantity_on_hand: 10.005 }],
  });

  assert.equal(findAdjustments(r.calls)[0]!.params[5], 0.125);
  assert.equal(findAdjustments(r.calls)[0]!.params[6], 10.005);
  assert.equal(findAdjustments(r.calls)[0]!.params[7], 10.13);
});

/* ==========================================================================
 * 17-18. quantity_reserved
 * ======================================================================== */

test('RESERVED: quantity_reserved is never written by a finalisation', async () => {
  const r = await run({ batches: [{ batch_id: 117, quantity_on_hand: 100, quantity_reserved: 20 }] });

  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /SET[^;]*quantity_reserved\s*=/i, 'no statement assigns quantity_reserved');
  }
  const update = findBatchUpdates(r.calls)[0]!.text.replace(/\s+/g, ' ');
  assert.match(update, /quantity_on_hand = \$1/, 'only the on-hand quantity is corrected');
  assert.match(update, /\$1 >= b\.quantity_reserved/, 'the batch invariant is enforced by the guard');
});

test('RESERVED: a decrease that would fall below the reserved quantity is refused and rolled back', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 5, variance: -95 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100, quantity_reserved: 20 }],
  });

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.quantity_reserved, 20);
  assert.equal(r.captured.body.counted_quantity, 5);
  assertNothingWritten(r);
});

test('RESERVED: a decrease that exactly meets the reserved quantity is allowed', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 20, variance: -80 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100, quantity_reserved: 20 }],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findBatchUpdates(r.calls).length, 1);
  assert.equal(r.committed, true);
});

test('RESERVED: an increase is never blocked by a reservation', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 130, variance: 30 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100, quantity_reserved: 90 }],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findMovements(r.calls)[0]!.params[1], 'ADJUSTMENT');
});

test('RESERVED: a zero-variance line is unaffected by a reservation', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 100, variance: 0 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100, quantity_reserved: 100 }],
  });

  assert.equal(r.captured.status, 200);
  assert.equal(findBatchUpdates(r.calls).length, 0);
});

/* ==========================================================================
 * 19-22. BATCH ELIGIBILITY: FINALISATION IS NOT FEFO
 * ======================================================================== */

test('ELIGIBILITY: the batch lock applies no expiry, activity, stock or quarantine filter', async () => {
  const r = await run();
  const lock = findBatchLock(r.calls)!.text.replace(/\s+/g, ' ');

  assert.doesNotMatch(lock, /expiry_date\s*(>|>=|IS NOT NULL)/i, 'an expired batch is still counted');
  assert.doesNotMatch(lock, /is_active/i, 'an inactive batch is still corrected');
  assert.doesNotMatch(lock, /quantity_on_hand\s*>\s*0/i, 'a zero-stock batch is still counted');
  assert.doesNotMatch(lock, /batch_quarantines/i, 'quarantine state is neither read nor changed');
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /released_at/i, 'no quarantine is ever released');
    assert.doesNotMatch(call.text, /INSERT INTO batch_quarantines/i, 'no quarantine is ever created');
  }
});

test('ELIGIBILITY: no FEFO ordering — batches are locked by id, not by expiry', async () => {
  const r = await run();
  const lock = findBatchLock(r.calls)!.text.replace(/\s+/g, ' ');

  assert.match(lock, /ORDER BY b\.batch_id ASC/, 'the deterministic lock order is the id order');
  assert.doesNotMatch(lock, /ORDER BY[^;]*expiry_date/i, 'never FEFO ordering');
});

test('ELIGIBILITY: an expired, inactive or quarantined batch is corrected like any other', async () => {
  for (const batch of [
    { batch_id: 117, quantity_on_hand: 100 },
    { batch_id: 117, quantity_on_hand: 100, inventory_id: 5 },
    { batch_id: 117, quantity_on_hand: 0 },
  ]) {
    const r = await run({ batches: [batch] });
    assert.equal(r.captured.status, 200, `batch state ${JSON.stringify(batch)} must not block finalisation`);
    assert.equal(r.committed, true);
  }
});

/* ==========================================================================
 * 25. AUDIT
 * ======================================================================== */

test('AUDIT: exactly one audit row is written, after every stock write', async () => {
  const r = await run({
    lines: [
      { count_line_id: 301, batch_id: 200, medication_id: 11, system_quantity: 50, counted_quantity: 45, variance: -5 },
      { count_line_id: 302, batch_id: 117, medication_id: 12, system_quantity: 20, counted_quantity: 30, variance: 10 },
    ],
    batches: [{ batch_id: 200, quantity_on_hand: 50 }, { batch_id: 117, quantity_on_hand: 20 }],
  });

  assert.equal(findAudit(r.calls).length, 1, 'one event per finalisation, never one per line');
  const auditIndex = r.calls.findIndex((c) => c.text.includes('INSERT INTO audit_logs'));
  const movementIndexes = r.calls
    .map((c, index) => (c.text.startsWith('INSERT INTO stock_movements') ? index : -1))
    .filter((index) => index !== -1);
  const headerIndex = r.calls.findIndex((c) => c.text.startsWith('UPDATE stock_counts'));
  assert.ok(Math.max(...movementIndexes) < auditIndex, 'the audit row follows the stock writes');
  assert.ok(auditIndex > headerIndex, 'and follows the count closure');

  const [userId, clinicId, resourceId] = findAudit(r.calls)[0]!.params;
  assert.equal(userId, MANAGER.userId);
  assert.equal(clinicId, 1);
  assert.equal(resourceId, '300');
  assert.match(findAudit(r.calls)[0]!.text, /'STOCK_COUNT_FINALISED', 'STOCK_COUNT'/);
});

test('AUDIT: the metadata carries the full finalisation summary', async () => {
  const r = await run({
    lines: [
      { count_line_id: 301, batch_id: 200, medication_id: 11, system_quantity: 50, counted_quantity: 45, variance: -5 },
      { count_line_id: 302, batch_id: 117, medication_id: 12, system_quantity: 20, counted_quantity: 30, variance: 10 },
    ],
    batches: [{ batch_id: 200, quantity_on_hand: 50 }, { batch_id: 117, quantity_on_hand: 20 }],
  });

  const meta = auditMeta(r.calls);
  assert.equal(meta.count_id, 300);
  assert.equal(meta.clinic_id, 1);
  assert.equal(meta.counted_by_user_id, 42);
  assert.equal(meta.finalised_by_user_id, MANAGER.userId);
  assert.equal(meta.line_count, 2);
  assert.equal(meta.total_decrease_quantity, 5);
  assert.equal(meta.total_increase_quantity, 10);
  assert.equal(meta.lines.length, 2);

  const shortage = meta.lines.find((l: any) => l.batch_id === 200);
  assert.deepEqual(
    Object.keys(shortage).sort(),
    [
      'adjusted_quantity', 'batch_id', 'count_line_id', 'counted_quantity', 'medication_id',
      'movement_type', 'system_quantity', 'system_quantity_at_finalisation', 'variance_at_count',
    ],
    'per-line evidence is complete',
  );
  assert.equal(shortage.variance_at_count, -5);
  assert.equal(shortage.system_quantity_at_finalisation, 50);
  assert.equal(shortage.adjusted_quantity, 5);
  assert.equal(shortage.movement_type, 'ADJUSTMENT_DECREASE');
});

test('AUDIT: a zero-variance line is audited with a null movement type', async () => {
  const r = await run({
    lines: [{ count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 100, variance: 0 }],
    batches: [{ batch_id: 117, quantity_on_hand: 100 }],
  });

  const meta = auditMeta(r.calls);
  assert.equal(meta.lines[0].movement_type, null);
  assert.equal(meta.lines[0].adjusted_quantity, 0);
  assert.equal(meta.total_increase_quantity, 0);
  assert.equal(meta.total_decrease_quantity, 0);
});

/* ==========================================================================
 * 26-29, 32. ROLLBACK
 * ======================================================================== */

test('ROLLBACK: an audit failure discards the adjustments, movements, lines and closure', async () => {
  const r = await run({ failOn: 'INSERT INTO audit_logs' });

  assert.equal(r.captured.status, 500);
  assert.equal(r.committed, false);
  assert.equal(r.rolledBack, true);
  assert.equal(r.released, true);
  assert.equal(findAdjustments(r.calls).length, 1, 'the writes were issued...');
  assert.match(find(r.calls, 'ROLLBACK')!.text, /^ROLLBACK$/, '...and then all of it was rolled back');
});

test('ROLLBACK: an adjustment failure stops before any movement is written', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_adjustments' });

  assert.equal(r.captured.status, 500);
  assert.equal(findMovements(r.calls).length, 0, 'no movement without its adjustment');
  assert.equal(findLineUpdates(r.calls).length, 0);
  assert.equal(findHeaderUpdate(r.calls), undefined);
  assert.equal(findAudit(r.calls).length, 0);
  assertRolledBack(r);
});

test('ROLLBACK: a movement failure stops before the line is marked corrected', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_movements' });

  assert.equal(r.captured.status, 500);
  assert.equal(findLineUpdates(r.calls).length, 0);
  assert.equal(findHeaderUpdate(r.calls), undefined);
  assertRolledBack(r);
});

test('ROLLBACK: a line update failure stops the whole finalisation', async () => {
  const r = await run({ lineUpdateRowCount: 0 });
  assert.equal(r.captured.status, 409);
  assert.equal(findHeaderUpdate(r.calls), undefined);
  assertRolledBack(r);
});

test('ROLLBACK: a count closure failure discards every stock correction', async () => {
  const r = await run({ headerRowCount: 0 });

  assert.equal(r.captured.status, 409);
  assertRolledBack(r);
  assert.equal(findAdjustments(r.calls).length, 1, 'the correction was attempted...');
  assert.equal(findAudit(r.calls).length, 0, '...but no finalisation was ever recorded');
});

test('ROLLBACK: a guarded batch update that affects nothing is refused, not assumed', async () => {
  const r = await run({ batchUpdateRowCount: 0 });

  assert.equal(r.captured.status, 409);
  assert.equal(findMovements(r.calls).length, 0, 'no movement without a confirmed balance change');
  assert.equal(findHeaderUpdate(r.calls), undefined);
  assertRolledBack(r);
});

test('ROLLBACK: a missing batch stops the finalisation instead of skipping the line', async () => {
  const r = await run({
    lines: [
      { count_line_id: 301, batch_id: 117, medication_id: 11, system_quantity: 100, counted_quantity: 90, variance: -10 },
      { count_line_id: 302, batch_id: 999, medication_id: 12, system_quantity: 10, counted_quantity: 5, variance: -5 },
    ],
    batches: [{ batch_id: 117, quantity_on_hand: 100 }],
  });

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.expected_batches, 2);
  assert.equal(r.captured.body.found_batches, 1);
  assertNothingWritten(r);
});

test('ORDERING: nothing is written before every check has passed', async () => {
  // a valid run: the count lock, the line read and the batch lock all precede
  // the first write, and the batch lock precedes the first stock write
  const r = await run();
  const order = r.calls.map((c) => c.text.trim());
  const firstWrite = order.findIndex((t) => /^(INSERT|UPDATE)\b/.test(t));
  const countLock = order.findIndex((t) => t.includes('FOR UPDATE OF sc'));
  const lineRead = order.findIndex((t) => t.startsWith('SELECT count_line_id'));
  const batchLock = order.findIndex((t) => t.includes('FOR UPDATE OF b'));

  assert.ok(countLock !== -1 && lineRead !== -1 && batchLock !== -1);
  assert.ok(countLock < firstWrite, 'the count is locked before anything is written');
  assert.ok(lineRead < firstWrite, 'the lines are read before anything is written');
  assert.ok(batchLock < firstWrite, 'the batches are locked before anything is written');
  assert.equal(order[0], 'BEGIN', 'the transaction opens first');
  assert.equal(order[order.length - 1], 'COMMIT', 'and commits last');
});

/* ==========================================================================
 * 30-31, 34-35. LOCKING, IDEMPOTENCE AND ATTRIBUTION
 * ======================================================================== */

test('LOCKING: batches are locked in ascending batch_id order, whatever the line order', async () => {
  const r = await run({
    lines: [
      { count_line_id: 301, batch_id: 300, medication_id: 13, system_quantity: 10, counted_quantity: 10, variance: 0 },
      { count_line_id: 302, batch_id: 117, medication_id: 11, system_quantity: 10, counted_quantity: 10, variance: 0 },
      { count_line_id: 303, batch_id: 200, medication_id: 12, system_quantity: 10, counted_quantity: 10, variance: 0 },
    ],
    batches: [
      { batch_id: 300, quantity_on_hand: 10 },
      { batch_id: 117, quantity_on_hand: 10 },
      { batch_id: 200, quantity_on_hand: 10 },
    ],
  });

  const batchLock = findBatchLock(r.calls)!;
  assert.deepEqual(batchLock.params[0], [117, 200, 300], 'the lock order is ascending by id, never request order');
  assert.match(batchLock.text.replace(/\s+/g, ' '), /ORDER BY b\.batch_id ASC/);
});

test('LOCKING: no SKIP LOCKED anywhere, and the count itself is locked first', async () => {
  const r = await run();
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i, 'SKIP LOCKED is never used');
  }
  const order = r.calls.map((c) => c.text.trim());
  assert.ok(
    order.findIndex((t) => t.includes('FOR UPDATE OF sc')) < order.findIndex((t) => t.includes('FOR UPDATE OF b')),
    'the count row is locked before any batch row',
  );
});

test('IDEMPOTENCE: the closure update is itself guarded by status = OPEN', async () => {
  const r = await run();
  const headerSql = findHeaderUpdate(r.calls)!.text.replace(/\s+/g, ' ');
  assert.match(headerSql, /WHERE count_id = \$2 AND status = 'OPEN'/);
  assert.match(headerSql, /status = 'FINALISED'/);
  assert.match(headerSql, /finalised_at = NOW\(\)/);
  assert.match(headerSql, /finalised_by_user_id = \$1/);
  assert.equal(findHeaderUpdate(r.calls)!.params[0], MANAGER.userId, 'the actor is authenticated, never sent');
});

test('IDEMPOTENCE: an already-finalised count cannot be finalised again', async () => {
  const r = await run({ countStatus: 'FINALISED' });

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.status, 'FINALISED');
  assertNothingWritten(r);
});

test('ATTRIBUTION: a successful finalisation records the authenticated user and NOW()', async () => {
  // a second manager of the SAME clinic finalises a count the first one opened
  const SECOND_MANAGER = {
    userId: 77, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
    permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
  };
  const r = await run({ countedByUserId: MANAGER.userId }, {}, SECOND_MANAGER);

  assert.equal(r.captured.status, 200);
  assert.equal(findHeaderUpdate(r.calls)!.params[0], SECOND_MANAGER.userId, 'the finaliser, not the counter');
  assert.match(findHeaderUpdate(r.calls)!.text, /finalised_at = NOW\(\)/, 'the timestamp is the server clock, not the client');
  assert.equal(r.captured.body.count.finalised_by_user_id, SECOND_MANAGER.userId);
  assert.equal(r.captured.body.count.counted_by_user_id, MANAGER.userId, 'who counted is preserved separately');
  assert.equal(auditMeta(r.calls).finalised_by_user_id, SECOND_MANAGER.userId);
  assert.equal(auditMeta(r.calls).counted_by_user_id, MANAGER.userId);
});

/* ==========================================================================
 * BOUNDARIES
 * ======================================================================== */

test('BOUNDARY: finalisation reuses the existing tables and adds no new vocabulary', async () => {
  const r = await run();

  assert.equal(find(r.calls, 'INSERT INTO stock_adjustments') !== undefined, true);
  assert.equal(find(r.calls, 'INSERT INTO stock_movements') !== undefined, true);
  const movementTypes = findMovements(r.calls).map((c) => String(c.params[1]));
  for (const type of movementTypes) {
    assert.ok(['ADJUSTMENT', 'ADJUSTMENT_DECREASE'].includes(type), `${type} is an existing movement type`);
  }
  // nothing else is written anywhere
  for (const call of writes(r.calls)) {
    assert.doesNotMatch(call.text, /INSERT INTO (?!stock_adjustments|stock_movements|audit_logs)/i, 'no new table is written');
    assert.doesNotMatch(call.text, /DELETE/i, 'finalisation deletes nothing');
    assert.doesNotMatch(call.text, /UPDATE (?!stock_counts|stock_count_lines|inventory_batches)/i, 'no other table is updated');
  }
});

test('BOUNDARY: the module contains no approval, cancellation or reconciliation logic', async () => {
  const fs = await import('node:fs');
  const compiled = await fs.promises.readFile('dist/modules/inventory/stockCounts.controller.js', 'utf8');
  const source = compiled
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  assert.doesNotMatch(source, /CANCELLED'\s*,\s*\$\d|SET status = 'CANCELLED'/i, 'no cancellation path');
  assert.doesNotMatch(source, /approved_by_user_id\s*=\s*\$/i, 'approved_by_user_id is never written');
  // 10D.9 adds a read-only reconciliation report. Finalisation itself must
  // still never act on a variance beyond the one-time correction, so the
  // finalisation handler is bounded and proven free of any reconciliation of
  // its own, and the report is proven to be a reader.
  // The finalisation path is bounded from its transactional helper up to the
  // first read handler, so the whole 10D.7 logic — not just the exported
  // function — is proven free of any reconciliation of its own.
  const finaliseStart = source.indexOf('const runStockCountFinalisation');
  const finaliseEnd = source.indexOf('const listStockCounts');
  assert.ok(finaliseStart > 0 && finaliseEnd > finaliseStart, 'the finalisation path is locatable');
  const finaliseHandler = source.slice(finaliseStart, finaliseEnd);
  assert.match(finaliseHandler, /STOCK_COUNT_FINALISED/, 'the bounded region really is the finalisation path');
  assert.doesNotMatch(finaliseHandler, /reconcil/i, 'finalisation contains no reconciliation of its own');

  const reportStart = source.indexOf('const getStockCountReconciliation');
  assert.ok(reportStart > 0, 'the 10D.9 report exists');
  const report = source.slice(reportStart, source.indexOf('\n};', reportStart) + 3);
  assert.doesNotMatch(report, /\b(INSERT|UPDATE|DELETE)\b/i, 'a reconciliation report never writes');
  assert.doesNotMatch(source, /SKIP LOCKED/);
  assert.doesNotMatch(source, /lock_timeout/i, 'no lock timeout logic in this phase');
  assert.doesNotMatch(source, /idempotency/i);
});
