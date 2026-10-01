import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  createStockCount,
  addStockCountLine,
  listStockCounts,
  getStockCount,
} from '../modules/inventory/stockCounts.controller';
import stockCountsRouter from '../modules/inventory/stockCounts.routes';
import {
  FORBIDDEN_STOCK_COUNT_FIELDS,
  FORBIDDEN_STOCK_COUNT_LINE_FIELDS,
  INITIAL_STOCK_COUNT_STATUS,
  MAX_COUNT_QUANTITY,
} from '../validations/stockCount.validation';
import {
  DEFAULT_STOCK_COUNT_LIMIT,
  MAX_STOCK_COUNT_LIMIT,
} from '../validations/stockCountRead.validation';

/* ==========================================================================
 * Phase 10D.6 — Stock count creation, line entry and reads
 *
 * Only pool.connect() (writes) and pool.query (reads) are stubbed. The suite
 * proves three things above all:
 *   1. every identity and every snapshot value is server-derived,
 *   2. nothing in this phase mutates stock,
 *   3. every read is clinic-scoped and leaks nothing outside the scope.
 * ======================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);
const ORIGINAL_QUERY = pool.query.bind(pool);

const MANAGER = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

const VIEWER = {
  userId: 43, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY'], clinicIds: [1],
};

const MULTI_CLINIC = {
  userId: 44, roleId: 4, clinicId: 7, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [7, 8],
};

const ADMIN = {
  userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [], clinicIds: [],
};

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const req = (
  body: Record<string, unknown>,
  user: unknown = MANAGER,
  params: Record<string, unknown> = {},
): AuthenticatedRequest => ({ body, params, query: {}, user } as unknown as AuthenticatedRequest);

/* ==========================================================================
 * Write harness — pool.connect stub only
 * ======================================================================== */

interface BatchScenario {
  found?: boolean;
  quantity_on_hand?: number;
  medication_id?: number;
  clinic_id?: number;
  lot_number?: string;
  is_active?: boolean;
  quantity_reserved?: number;
}

interface CountScenario {
  found?: boolean;
  status?: string;
  clinic_id?: number;
}

interface Scenario {
  batch?: BatchScenario;
  count?: CountScenario;
  /** an identical line for this count/batch already exists */
  duplicateLine?: boolean;
  /** the DB raises uq_scl_count_batch (a concurrent insert won the race) */
  uniqueViolation?: boolean;
  failOn?: string;
  noUser?: boolean;
}

const DEFAULT_BATCH: BatchScenario = {
  found: true, quantity_on_hand: 100, medication_id: 11, clinic_id: 1,
  lot_number: 'LOT-1', is_active: true,
};

const makeWriteHandler = (s: Scenario) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

  if (s.failOn && t.includes(s.failOn)) {
    throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
  }

  if (t.startsWith('INSERT INTO stock_counts')) {
    return {
      rows: [{
        count_id: 300, clinic_id: params[0], status: params[1],
        counted_by_user_id: params[2], approved_by_user_id: null,
        notes: params[3], created_at: '2026-03-01T10:00:00.000Z', finalised_at: null,
      }],
      rowCount: 1,
    };
  }

  if (t.startsWith('INSERT INTO stock_count_lines')) {
    return {
      rows: [{
        count_line_id: 301, count_id: params[0], batch_id: params[1], medication_id: params[2],
        system_quantity: params[3], counted_quantity: params[4], variance: params[5],
        system_quantity_at_finalisation: null, adjusted_quantity: null,
        created_at: '2026-03-01T10:05:00.000Z',
      }],
      rowCount: 1,
    };
  }

  if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

  throw new Error(`Unexpected query: ${text}`);
};

interface WriteRun {
  captured: { status: number; body: any };
  calls: QueryCall[];
  wasCommitted: boolean;
  wasRolledBack: boolean;
  wasReleased: boolean;
}

const runWrite = async (
  invoke: (r: AuthenticatedRequest, res: Response) => Promise<unknown>,
  scenario: Scenario = {},
  request: AuthenticatedRequest = req({}),
): Promise<WriteRun> => {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = makeWriteHandler(scenario);
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
    await invoke(request, res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  return {
    captured,
    calls,
    wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
    wasReleased: released,
  };
};

const find = (calls: QueryCall[], needle: string) => calls.find((c) => c.text.includes(needle));
const findCountInsert = (calls: QueryCall[]) => find(calls, 'INSERT INTO stock_counts');
const findLineInsert = (calls: QueryCall[]) => find(calls, 'INSERT INTO stock_count_lines');
const findAudit = (calls: QueryCall[]) => find(calls, 'INSERT INTO audit_logs');

const writes = (calls: QueryCall[]) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text.trim()));

/* ==========================================================================
 * 9-12. COUNT CREATION
 * ======================================================================== */

test('CREATE: an authorised count opens as OPEN and commits', async () => {
  const r = await runWrite((request, res) => createStockCount(request, res), {}, req({ notes: 'جرد شهري' }));

  assert.equal(r.captured.status, 201);
  assert.equal(r.wasCommitted, true);
  assert.equal(r.wasRolledBack, false);
  assert.equal(r.wasReleased, true, 'the client is always released');

  const insert = findCountInsert(r.calls)!;
  assert.equal(insert.params[1], 'OPEN', 'status is decided by the server');
  assert.equal(insert.params[2], MANAGER.userId, 'the counter is the authenticated user');
  assert.equal(insert.params[3], 'جرد شهري');
});

test('CREATE: the clinic is derived from the authenticated user scope', async () => {
  const r = await runWrite((request, res) => createStockCount(request, res), {}, req({}, MANAGER));
  assert.equal(findCountInsert(r.calls)!.params[0], MANAGER.clinicId);

  // a user whose primary clinic is out of scope falls back to their single
  // accessible clinic, never to a value in the body
  const otherClinic = { ...MANAGER, userId: 45, clinicId: 99, clinicIds: [3] };
  const r2 = await runWrite((request, res) => createStockCount(request, res), {}, req({}, otherClinic));
  assert.equal(findCountInsert(r2.calls)!.params[0], 3, 'the only accessible clinic is used');

  // an ambiguous scope opens nothing at all
  const ambiguous = { ...MANAGER, userId: 46, clinicId: null, clinicIds: [7, 8] };
  const r3 = await runWrite((request, res) => createStockCount(request, res), {}, req({}, ambiguous));
  assert.equal(r3.captured.status, 400);
  assert.equal(findCountInsert(r3.calls), undefined, 'no header is written when no clinic can be derived');
  assert.equal(writes(r3.calls).length, 0);
});

test('CREATE: client clinic / user / status / finalisation fields are rejected', async () => {
  for (const field of FORBIDDEN_STOCK_COUNT_FIELDS) {
    const r = await runWrite(
      (request, res) => createStockCount(request, res),
      {},
      req({ [field]: 1 }),
    );
    assert.equal(r.captured.status, 400, `${field} must be refused`);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR);
    assert.equal(writes(r.calls).length, 0, `${field} must be refused before any database access`);
    assert.equal(r.wasCommitted, false);
  }
});

test('CREATE: notes are optional and an empty string is stored as NULL', async () => {
  const empty = await runWrite((request, res) => createStockCount(request, res), {}, req({ notes: '' }));
  assert.equal(empty.captured.status, 201);
  assert.equal(findCountInsert(empty.calls)!.params[3], null);

  const missing = await runWrite((request, res) => createStockCount(request, res), {}, req({}));
  assert.equal(missing.captured.status, 201);
  assert.equal(findCountInsert(missing.calls)!.params[3], null);
});

test('CREATE: the status is always the initial status, whatever the client believes', async () => {
  // FINALISED in the body is a forbidden field, not a transition
  const r = await runWrite(
    (request, res) => createStockCount(request, res),
    {},
    req({ status: 'FINALISED' }),
  );
  assert.equal(r.captured.status, 400);
  assert.equal(INITIAL_STOCK_COUNT_STATUS, 'OPEN');
});

test('CREATE: an unauthenticated request cannot open a count', async () => {
  const r = await runWrite(
    (request, res) => createStockCount(request, res),
    { noUser: true },
    req({}, {}),
  );
  assert.equal(r.captured.status, 400);
  assert.equal(writes(r.calls).length, 0);
});

test('CREATE: one audit event records who opened the count', async () => {
  const r = await runWrite((request, res) => createStockCount(request, res));
  const audit = findAudit(r.calls)!;
  assert.ok(audit, 'opening a count is audited');
  assert.match(audit.text, /'STOCK_COUNT_OPENED', 'STOCK_COUNT'/);
  assert.equal(audit.params[0], MANAGER.userId);
  assert.equal(audit.params[1], MANAGER.clinicId);
  assert.equal(audit.params[2], '300');
});

test('CREATE: a failing audit write rolls the whole count back', async () => {
  const r = await runWrite(
    (request, res) => createStockCount(request, res),
    { failOn: 'INSERT INTO audit_logs' },
  );
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasCommitted, false);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasReleased, true);
});

/* ==========================================================================
 * LINE HARNESS — needs the two SELECTs the write handler does not serve
 * ======================================================================== */

const lineHandler = (s: Scenario) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

  if (s.failOn && t.includes(s.failOn)) {
    throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
  }

  // 1) lock the batch (clinic scope passes through inventory_items)
  if (t.startsWith('SELECT b.batch_id') && t.includes('FOR UPDATE OF b')) {
    if (s.batch?.found === false) return { rows: [], rowCount: 0 };
    const b = { ...DEFAULT_BATCH, ...(s.batch ?? {}) };
    return {
      rows: [{
        batch_id: params[0], inventory_id: 5, quantity_on_hand: b.quantity_on_hand,
        lot_number: b.lot_number, expiry_date: '2027-01-01', is_active: b.is_active,
        medication_id: b.medication_id, clinic_id: b.clinic_id,
      }],
      rowCount: 1,
    };
  }

  // 2) lock the count
  if (t.startsWith('SELECT sc.count_id')) {
    if (s.count?.found === false) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        count_id: params[0], clinic_id: s.count?.clinic_id ?? 1, status: s.count?.status ?? 'OPEN',
      }],
      rowCount: 1,
    };
  }

  // 3) duplicate check
  if (t.startsWith('SELECT count_line_id FROM stock_count_lines')) {
    if (s.duplicateLine) return { rows: [{ count_line_id: 999 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }

  if (s.uniqueViolation && t.startsWith('INSERT INTO stock_count_lines')) {
    throw Object.assign(new Error('duplicate key'), { code: '23505' });
  }

  if (t.startsWith('INSERT INTO stock_count_lines')) {
    return {
      rows: [{
        count_line_id: 301, count_id: params[0], batch_id: params[1], medication_id: params[2],
        system_quantity: params[3], counted_quantity: params[4], variance: params[5],
        system_quantity_at_finalisation: null, adjusted_quantity: null,
        created_at: '2026-03-01T10:05:00.000Z',
      }],
      rowCount: 1,
    };
  }

  throw new Error(`Unexpected query: ${text}`);
};

const runLine = async (
  body: Record<string, unknown>,
  scenario: Scenario = {},
  user: unknown = MANAGER,
  params: Record<string, unknown> = { id: '300' },
) => {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = lineHandler(scenario);
  let released = false;
  const client = {
    query: async (text: string, p: unknown[] = []) => {
      calls.push({ text, params: p });
      return handler(text, p);
    },
    release: () => { released = true; },
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;

  try {
    await addStockCountLine(req(body, user, params), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  return {
    captured, calls,
    wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
    wasReleased: released,
  };
};

const findBatchLock = (calls: QueryCall[]) => find(calls, 'FOR UPDATE OF b');
const findCountLock = (calls: QueryCall[]) => find(calls, 'SELECT sc.count_id');

/* ==========================================================================
 * 13-24. LINES
 * ======================================================================== */

test('LINE: a valid line commits with a server-derived snapshot and variance', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 90 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.wasCommitted, true);
  assert.equal(r.wasRolledBack, false);
  assert.equal(r.wasReleased, true);

  const insert = findLineInsert(r.calls)!;
  assert.equal(insert.params[0], 300, 'the count comes from the URL');
  assert.equal(insert.params[1], 117, 'the batch comes from the request');
  assert.equal(insert.params[2], 11, 'the medication is derived from the locked batch');
  assert.equal(insert.params[3], 100, 'system_quantity is read from the database row');
  assert.equal(insert.params[4], 90, 'the counted quantity is the physical count');
  assert.equal(insert.params[5], -10, 'variance = counted - system');
});

test('LINE: the snapshot comes from the locked row, never from the request', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 5 }, { batch: { quantity_on_hand: 250.5 } });
  assert.equal(findLineInsert(r.calls)!.params[3], 250.5, 'the DB value wins');

  // and the batch lock really happens before the snapshot is stored
  const order = r.calls.map((c) => c.text.trim());
  const lockIndex = order.findIndex((t) => t.includes('FOR UPDATE OF b'));
  const insertIndex = order.findIndex((t) => t.startsWith('INSERT INTO stock_count_lines'));
  assert.ok(lockIndex !== -1 && lockIndex < insertIndex, 'the batch must be locked before the line is written');
  assert.doesNotMatch(r.calls[lockIndex]!.text, /SKIP\s+LOCKED/i, 'SKIP LOCKED is never used');
});

test('LINE: a positive variance is computed with the same sign convention', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 130 }, { batch: { quantity_on_hand: 100 } });
  assert.equal(findLineInsert(r.calls)!.params[5], 30);
});

test('LINE: a zero counted quantity is a valid, recorded answer', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 0 }, { batch: { quantity_on_hand: 40 } });
  assert.equal(r.captured.status, 201, 'an empty shelf is not an error');
  assert.equal(findLineInsert(r.calls)!.params[4], 0);
  assert.equal(findLineInsert(r.calls)!.params[5], -40, 'the whole stock is missing');
});

test('LINE: a three-decimal counted quantity keeps its exact scale', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 10.125 }, { batch: { quantity_on_hand: 10.005 } });
  assert.equal(r.captured.status, 201);
  assert.equal(findLineInsert(r.calls)!.params[5], 0.12);
});

test('LINE: a negative counted quantity is refused before any database access', async () => {
  for (const value of [-1, -0.001]) {
    const r = await runLine({ batch_id: 117, counted_quantity: value });
    assert.equal(r.captured.status, 400, `${value} must be refused`);
    assert.equal(r.calls.length, 0, 'no statement at all may be issued');
  }
});

test('LINE: more than three decimal places is refused', async () => {
  for (const value of [1.0001, 0.12345, 10.1234567]) {
    const r = await runLine({ batch_id: 117, counted_quantity: value });
    assert.equal(r.captured.status, 400, `${value} must be refused`);
    assert.equal(r.calls.length, 0);
  }
});

test('LINE: an out-of-scope or nonexistent batch is refused with the same 404', async () => {
  const outOfScope = await runLine({ batch_id: 117, counted_quantity: 5 }, { batch: { found: false } });
  assert.equal(outOfScope.captured.status, 404);
  assert.equal(outOfScope.wasCommitted, false);
  assert.equal(outOfScope.wasRolledBack, true);
  assert.equal(findLineInsert(outOfScope.calls), undefined);
  // the scope predicate is on the batch's own inventory item, not the batch alone
  assert.match(findBatchLock(outOfScope.calls)!.text, /i\.clinic_id = ANY\(\$\d+::int\[\]\)/);

  const nonexistent = await runLine({ batch_id: 999999999, counted_quantity: 5 }, { batch: { found: false } });
  assert.deepEqual(nonexistent.captured.body, outOfScope.captured.body, 'no existence leak');
});

test('LINE: an invalid batch id is refused', async () => {
  for (const batch_id of [0, -1, 'abc']) {
    const r = await runLine({ batch_id, counted_quantity: 5 });
    assert.equal(r.captured.status, 400);
    assert.equal(r.calls.length, 0);
  }
});

test('LINE: a batch counted twice in one count is refused', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 5 }, { duplicateLine: true });

  assert.equal(r.captured.status, 409);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findLineInsert(r.calls), undefined, 'nothing is written for a duplicate line');

  // the duplicate check is always consulted, before the insert
  assert.ok(find(r.calls, 'SELECT count_line_id FROM stock_count_lines'), 'the duplicate check runs');
});

test('LINE: a concurrent insert that wins the race is refused by the unique index', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 5 }, { uniqueViolation: true });
  assert.equal(r.captured.status, 409, 'uq_scl_count_batch is the last word');
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasReleased, true);
});

test('LINE: a non-OPEN count refuses new lines', async () => {
  for (const status of ['FINALISED', 'CANCELLED']) {
    const r = await runLine({ batch_id: 117, counted_quantity: 5 }, { count: { status } });
    assert.equal(r.captured.status, 409, `${status} must refuse a new line`);
    assert.equal(r.captured.body.status, status);
    assert.equal(findLineInsert(r.calls), undefined);
    assert.equal(r.wasRolledBack, true);
  }
});

test('LINE: a nonexistent or out-of-scope count is refused with the same 404', async () => {
  const outOfScope = await runLine({ batch_id: 117, counted_quantity: 5 }, { count: { found: false } });
  assert.equal(outOfScope.captured.status, 404);
  assert.equal(findLineInsert(outOfScope.calls), undefined);
  assert.equal(outOfScope.wasRolledBack, true);
  assert.match(findCountLock(outOfScope.calls)!.text, /sc\.clinic_id = ANY\(\$\d+::int\[\]\)/);

  const nonexistent = await runLine({ batch_id: 117, counted_quantity: 5 }, { count: { found: false } });
  assert.deepEqual(nonexistent.captured.body, outOfScope.captured.body, 'no existence leak');
});

test('LINE: a count line cannot be forced onto a batch from another clinic', async () => {
  // The batch resolves inside the caller's scope but belongs to a different
  // clinic than the count — the count scope check happens first, so the batch
  // lock is what must fail here.
  const r = await runLine({ batch_id: 117, counted_quantity: 5 }, { batch: { found: false } });
  assert.equal(r.captured.status, 404);
  assert.equal(findLineInsert(r.calls), undefined);

  // and when both resolve, an explicit clinic mismatch is refused, never merged
  const mismatch = await runLine(
    { batch_id: 117, counted_quantity: 5 },
    { batch: { clinic_id: 2 }, count: { clinic_id: 1 } },
  );
  assert.equal(mismatch.captured.status, 404);
  assert.equal(findLineInsert(mismatch.calls), undefined, 'batches of another clinic never become a line');
});

test('LINE: client snapshot and identity fields are rejected', async () => {
  for (const field of FORBIDDEN_STOCK_COUNT_LINE_FIELDS) {
    const r = await runLine({ batch_id: 117, counted_quantity: 5, [field]: 1 });
    assert.equal(r.captured.status, 400, `${field} must be refused`);
    assert.equal(r.calls.length, 0, `${field} must be refused before any database access`);
  }
});

test('LINE: the variance is stored once and never recomputed later', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 90 }, { batch: { quantity_on_hand: 100 } });
  assert.equal(r.captured.body.line.variance, -10);
  // the response exposes the frozen snapshot, not a live re-read
  assert.equal(r.captured.body.line.system_quantity, 100);
  assert.equal(r.captured.body.line.counted_quantity, 90);
  assert.equal(r.captured.body.line.system_quantity_at_finalisation, null, '10D.7 owns that column');
  assert.equal(r.captured.body.line.adjusted_quantity, null, '10D.7 owns that column');
  // nothing re-reads inventory_batches after the insert
  const reads = r.calls.filter((c) => c.text.trim().startsWith('SELECT b.batch_id'));
  assert.equal(reads.length, 1, 'the batch is read exactly once, under the lock');
});

test('LINE: no stock is mutated and no movement is created', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 5 });

  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /UPDATE\s+inventory_batches/i, 'a count never writes a batch quantity');
    assert.doesNotMatch(call.text, /INSERT\s+INTO\s+stock_movements/i, 'a count creates no movement');
    assert.doesNotMatch(call.text, /batch_quarantines/i, 'a count neither creates nor releases a quarantine');
    assert.doesNotMatch(call.text, /quantity_reserved\s*=/i, 'quantity_reserved is never written');
  }
  assert.equal(find(r.calls, 'INSERT INTO audit_logs'), undefined, 'recording a count line is not audited');
  assert.deepEqual(
    writes(r.calls).map((c) => c.text.trim().split(/\s+/).slice(0, 3).join(' ')),
    ['INSERT INTO stock_count_lines'],
    'the line insert is the only write of this phase',
  );
});

test('LINE: an expired, quarantined or inactive batch is still countable', async () => {
  // the count records physical state; it does not judge the batch
  for (const batch of [{ is_active: false }, { lot_number: 'EXPIRED-LOT' }]) {
    const r = await runLine({ batch_id: 117, counted_quantity: 4 }, { batch });
    assert.equal(r.captured.status, 201, 'a batch is never silently excluded');
    assert.equal(r.captured.body.line.batch_is_active, batch.is_active ?? true);
  }
  const r = await runLine({ batch_id: 117, counted_quantity: 0 }, { batch: { quantity_on_hand: 0 } });
  assert.equal(r.captured.status, 201, 'a zero-stock batch is countable too');
});

test('LINE: a failing insert rolls back and releases the client', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: 5 }, { failOn: 'INSERT INTO stock_count_lines' });
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasCommitted, false);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasReleased, true);
});

test('LINE: a malformed count id in the URL is refused', async () => {
  for (const id of ['abc', '0', '-3']) {
    const r = await runLine({ batch_id: 117, counted_quantity: 5 }, {}, MANAGER, { id });
    assert.equal(r.captured.status, 400);
    assert.equal(r.calls.length, 0);
  }
});

test('LINE: a counted quantity beyond the NUMERIC ceiling is refused', async () => {
  const r = await runLine({ batch_id: 117, counted_quantity: MAX_COUNT_QUANTITY + 1 });
  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0);
});

/* ==========================================================================
 * READ HARNESS
 * ======================================================================== */

async function withReads(
  handler: (text: string, params: unknown[]) => MockResult,
  run: (calls: QueryCall[]) => Promise<void>,
) {
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

const COUNT_ROW: QueryRow = {
  count_id: 300, clinic_id: 1, status: 'OPEN', notes: null,
  created_at: '2026-03-01T10:00:00.000Z', finalised_at: null,
  counted_by_user_id: 42, approved_by_user_id: null,
  counted_by_name: 'Pharmacist One', approved_by_name: null, clinic_name: 'Main Clinic',
};

const LINE_ROW: QueryRow = {
  count_line_id: 301, batch_id: 117, medication_id: 11,
  system_quantity: 100, counted_quantity: 90, variance: -10,
  system_quantity_at_finalisation: null, adjusted_quantity: null,
  created_at: '2026-03-01T10:05:00.000Z',
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg', dosage_form: 'CAPSULE',
};

/** A user scoped to no clinic gets nothing — the scope clause is never omitted. */
const scopeAware = (rows: QueryRow[], params: unknown[]): QueryRow[] =>
  params.some((p) => Array.isArray(p) && p.length === 0) ? [] : rows;

const readReq = (query: Record<string, unknown> = {}, id?: string, user: unknown = VIEWER): AuthenticatedRequest =>
  ({ body: {}, params: id === undefined ? {} : { id }, query, user } as unknown as AuthenticatedRequest);

const assertReadOnly = (calls: QueryCall[]) => {
  for (const call of calls) {
    assert.match(call.text.trim(), /^\s*SELECT\b/, `non-SELECT issued: ${call.text}`);
    assert.doesNotMatch(call.text, /\bRETURNING\b/i, 'read endpoints never return a written row');
    assert.doesNotMatch(call.text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i, 'read endpoints never lock rows');
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
    assert.doesNotMatch(call.text, /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/);
  }
};

/* ==========================================================================
 * 25-31. READS
 * ======================================================================== */

test('READ: the list requires VIEW_INVENTORY and returns clinic-scoped rows', async () => {
  await withReads(
    (_text, params) => ({ rows: scopeAware([{ ...COUNT_ROW, line_count: 2 }], params), rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.counts.length, 1);
      assert.equal(captured.body.counts[0].line_count, 2);
      assertReadOnly(calls);
      assert.match(calls[0]!.text, /sc\.clinic_id = ANY\(\$\d+::int\[\]\)/, 'the scope clause is present');
      assert.match(calls[0]!.text, /JOIN users cu/, 'the display name is joined');
      assert.match(calls[0]!.text, /COUNT\(\*\)::int FROM stock_count_lines/, 'line_count comes from the lines table');
    },
  );
});

test('READ: a clinic_id in the query never widens the result', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq({ clinic_id: '2' }), res);
      assert.equal(captured.status, 200);
      assert.doesNotMatch(calls[0]!.text, /clinic_id\s*=\s*\$\d+\s+AND/i, 'no client clinic filter is applied');
      assert.ok(!calls[0]!.params.includes(2), 'the client value is never even bound');
    },
  );
});

test('READ: a user scoped to no clinic sees an empty list', async () => {
  await withReads(
    (_text, params) => ({ rows: scopeAware([COUNT_ROW], params), rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      const noClinic = { ...VIEWER, clinicId: null, clinicIds: [] };
      await listStockCounts(readReq({}, undefined, noClinic), res);
      assert.deepEqual(captured.body.counts, [], 'deny-by-default: an empty scope yields nothing');
      assert.match(calls[0]!.text, /clinic_id = ANY\(\$\d+::int\[\]\)/, 'the scope clause is never omitted');
      assert.deepEqual(calls[0]!.params[0], [], 'an empty clinic list is bound, not skipped');
    },
  );
});

test('READ: an admin sees every clinic without a scope clause', async () => {
  await withReads(
    () => ({ rows: [{ ...COUNT_ROW }], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq({}, undefined, ADMIN), res);
      assert.equal(captured.status, 200);
      assert.doesNotMatch(calls[0]!.text, /clinic_id = ANY/, 'a global admin is not restricted');
    },
  );
});

test('READ: pagination defaults to 50 and is capped at 200', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const first = makeRes();
      await listStockCounts(readReq(), first.res);
      assert.equal(first.captured.body.pagination.limit, DEFAULT_STOCK_COUNT_LIMIT);
      assert.equal(first.captured.body.pagination.limit, 50);
      assert.equal(first.captured.body.pagination.offset, 0);
      assert.deepEqual(calls[0]!.params.slice(-2), [50, 0], 'the defaults are bound, not left to SQL');

      const second = makeRes();
      await listStockCounts(readReq({ limit: '10', offset: '30' }), second.res);
      assert.deepEqual(calls[1]!.params.slice(-2), [10, 30]);
    },
  );

  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const tooLarge = makeRes();
      await listStockCounts(readReq({ limit: String(MAX_STOCK_COUNT_LIMIT + 1) }), tooLarge.res);
      assert.equal(tooLarge.captured.status, 400, 'a limit beyond the cap is refused');

      const negative = makeRes();
      await listStockCounts(readReq({ offset: '-1' }), negative.res);
      assert.equal(negative.captured.status, 400, 'a negative offset is refused');
      assert.equal(calls.length, 0, 'no query runs for an invalid page');
    },
  );
});

test('READ: the list ordering is deterministic — created_at DESC then count_id DESC', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listStockCounts(readReq(), makeRes().res);
      const order = calls[0]!.text.replace(/\s+/g, ' ');
      assert.match(order, /ORDER BY sc\.created_at DESC, sc\.count_id DESC/);
    },
  );
});

test('READ: a status filter is the only supported filter', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const first = makeRes();
      await listStockCounts(readReq({ status: 'FINALISED' }), first.res);
      assert.equal(first.captured.status, 200);
      assert.match(calls[0]!.text, /sc\.status = \$\d+/);
      assert.equal(calls[0]!.params[0], 'FINALISED');

      const unknown = makeRes();
      await listStockCounts(readReq({ status: 'APPROVED' }), unknown.res);
      assert.equal(unknown.captured.status, 400, 'an unknown status is refused');
      assert.equal(calls.length, 1, 'and it never reaches the database');
    },
  );
});

test('READ: the detail returns the header and the frozen lines', async () => {
  await withReads(
    (text) => (text.includes('FROM stock_count_lines') ? { rows: [LINE_ROW], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);

      assert.equal(captured.status, 200);
      assertReadOnly(calls);
      assert.equal(calls.length, 2, 'header and lines, no N+1');

      const count = captured.body.count;
      assert.equal(count.count_id, 300);
      assert.equal(count.status, 'OPEN');
      assert.equal(count.counted_by_name, 'Pharmacist One');
      assert.equal(count.line_count, 1);

      const line = count.lines[0];
      assert.equal(line.batch_id, 117);
      assert.equal(line.medication.trade_name, 'Amoxil');
      assert.equal(line.medication.strength, '500 mg');
      assert.equal(line.medication.dosage_form, 'CAPSULE');
      assert.equal(line.system_quantity, 100, 'the snapshot, not a live balance');
      assert.equal(line.counted_quantity, 90);
      assert.equal(line.variance, -10);
      assert.ok(line.created_at);

      // The 10D.6 invariant still holds: the line read never pulls a live
      // balance. 10D.8 joins inventory_batches for display identity only
      // (lot number and expiry), still in the same single statement.
      assert.doesNotMatch(calls[1]!.text, /quantity_on_hand/i);
      assert.doesNotMatch(calls[1]!.text, /quantity_reserved/i);
      assert.match(calls[1]!.text, /LEFT JOIN inventory_batches b ON b\.batch_id = scl\.batch_id/);
      assert.match(calls[1]!.text, /b\.lot_number, b\.expiry_date/);
    },
  );
});

test('READ: nonexistent and out-of-scope counts return an identical 404', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async () => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);
      const first = { status: captured.status, body: captured.body };

      const other = makeRes();
      await getStockCount(readReq({}, '424242'), other.res);
      assert.equal(other.captured.status, first.status);
      assert.deepEqual(other.captured.body, first.body, 'no existence leak between the two cases');
      assert.equal(first.status, 404);

      // and a count belonging to another clinic is not reachable at all
      const foreign = makeRes();
      await getStockCount(readReq({}, '300', { ...VIEWER, clinicId: 2, clinicIds: [2] }), foreign.res);
      assert.deepEqual(foreign.captured.body, first.body);
      assert.equal(foreign.captured.status, 404);
    },
  );
});

test('READ: a malformed count id never reaches the database', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, 'abc'), res);
      assert.equal(captured.status, 400);
      assert.equal(calls.length, 0);
    },
  );
});

test('READ: only safe user display fields are exposed', async () => {
  await withReads(
    (text) => (text.includes('FROM stock_count_lines') ? { rows: [LINE_ROW], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq(), res);
      await getStockCount(readReq({}, '300'), res);

      for (const call of calls) {
        assert.doesNotMatch(call.text, /username/i, 'usernames are never selected');
        assert.doesNotMatch(call.text, /password/i);
        assert.doesNotMatch(call.text, /email/i);
      }
      const row = captured.body.count;
      const allowedNames = ['counted_by_name', 'approved_by_name', 'finalised_by_name', 'clinic_name'];
      for (const key of Object.keys(row).filter((k) => k.endsWith('_name'))) {
        assert.ok(allowedNames.includes(key), `${key} is not a display field`);
      }
      assert.deepEqual(
        Object.keys(row).filter((k) => k.endsWith('_name')),
        ['counted_by_name', 'approved_by_name', 'clinic_name'],
        'names only, and nothing identifying',
      );
    },
  );
});

/* ==========================================================================
 * ROUTING / PERMISSIONS
 * ======================================================================== */

test('ROUTES: writes require MANAGE_INVENTORY and reads require VIEW_INVENTORY', () => {
  const denied = (permissions: string[], required: string) => {
    const request = {
      user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions },
    } as unknown as AuthenticatedRequest;
    let error: any = null;
    requirePermission(required)(request, {} as any, (err?: unknown) => { error = err ?? null; });
    return error !== null;
  };

  assert.equal(denied(['VIEW_INVENTORY'], 'MANAGE_INVENTORY'), true, 'a viewer may not count stock');
  assert.equal(denied(['MANAGE_INVENTORY'], 'VIEW_INVENTORY'), true, 'counting implies no read access');
  assert.equal(denied(['VIEW_INVENTORY', 'MANAGE_INVENTORY'], 'MANAGE_INVENTORY'), false);
  assert.equal(denied(['VIEW_INVENTORY', 'MANAGE_INVENTORY'], 'VIEW_INVENTORY'), false);
});

test('ROUTES: the 10D.6 endpoints are unchanged by later phases', () => {
  const layers = (stockCountsRouter as any).stack.filter((l: any) => l.route);
  const routes = layers.map((l: any) => `${Object.keys(l.route.methods)[0]!.toUpperCase()} ${l.route.path}`);

  for (const route of ['GET /', 'GET /:id', 'POST /', 'POST /:id/lines']) {
    assert.ok(routes.includes(route), `10D.6 route ${route} still exists`);
  }

  const methods = layers.flatMap((l: any) => Object.keys(l.route.methods));
  for (const method of ['put', 'patch', 'delete']) {
    assert.equal(methods.includes(method), false, `a recorded count line is never ${method.toUpperCase()}-ed`);
  }
});

test('BOUNDARY: reconciliation is a read-only report, and the count model gains no cron', async () => {
  // Comments are stripped first: the module explains in prose what it must never
  // do, and that prose is not code. (Phases after 10D.6 legitimately make the
  // module write stock, so the forbidden list is the inventory machinery itself.)
  const fs = await import('node:fs');
  const compiled = await fs.promises.readFile('dist/modules/inventory/stockCounts.controller.js', 'utf8');
  const source = compiled
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  // 10D.9 adds reconciliation, so the question is no longer "does the word
  // exist" but "does it ever act". Extract the report handler and prove it is
  // a single set-based reader with no statement that mutates anything.
  const start = source.indexOf('const getStockCountReconciliation');
  assert.ok(start > 0, 'the 10D.9 report exists');
  const report = source.slice(start, source.indexOf('\n};', start) + 3);
  assert.match(report, /FROM stock_count_lines scl/);
  assert.doesNotMatch(report, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i, 'a reconciliation report never writes');
  assert.doesNotMatch(report, /FOR\s+(NO\s+KEY\s+)?UPDATE/i);
  assert.doesNotMatch(report, /\bRETURNING\b/i);
  assert.doesNotMatch(report, /\b(BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.doesNotMatch(report, /SKIP\s+LOCKED/i);
  assert.doesNotMatch(report, /audit/i, 'viewing a report is not itself an auditable event');

  // quarantine is still only ever read, never created or released here
  assert.doesNotMatch(source, /INSERT INTO batch_quarantines/i);
  assert.doesNotMatch(source, /UPDATE batch_quarantines/i);
  assert.doesNotMatch(source, /DELETE FROM batch_quarantines/i);
  assert.doesNotMatch(source, /SKIP LOCKED/);
  assert.doesNotMatch(source, /setInterval|setTimeout|cron/i, 'no scheduled or automatic counting');
  assert.doesNotMatch(source, /idempotency/i);
});
