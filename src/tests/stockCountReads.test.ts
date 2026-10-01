import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { authenticateJWT, requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listStockCounts,
  getStockCount,
  getStockCountAudit,
} from '../modules/inventory/stockCounts.controller';
import stockCountsRouter from '../modules/inventory/stockCounts.routes';
import {
  DEFAULT_STOCK_COUNT_LIMIT,
  MAX_STOCK_COUNT_LIMIT,
} from '../validations/stockCountRead.validation';

/* ==========================================================================
 * Phase 10D.8 — Stock-count reads & audit
 *
 * Read-only phase. The suite proves the three properties that matter:
 *   1. every read is clinic-scoped, with an identical 404 for missing and
 *      out-of-scope counts,
 *   2. every returned number is the STORED history — never recomputed against
 *      current inventory state,
 *   3. no read path writes, locks, or opens a transaction.
 * ======================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);

const VIEWER = {
  userId: 43, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY'], clinicIds: [1],
};

const VIEWER_OTHER_CLINIC = {
  userId: 44, roleId: 4, clinicId: 2, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY'], clinicIds: [2],
};

const NO_CLINIC = { ...VIEWER, userId: 45, clinicId: null, clinicIds: [] };

const SYSTEM_ADMIN = {
  userId: 1, roleId: 2, clinicId: null, roleName: 'SYSTEM_ADMIN',
  permissions: ['VIEW_SYSTEM_LOGS'], clinicIds: [],
};

const SUPER_ADMIN = {
  userId: 2, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [], clinicIds: [],
};

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

/** A pharmacist who also holds VIEW_SYSTEM_LOGS — still not a system-log reader. */
const PHARMACIST_AUDIT = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY', 'VIEW_SYSTEM_LOGS'], clinicIds: [1],
};

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const readReq = (
  query: Record<string, unknown> = {},
  id?: string,
  user: unknown = VIEWER,
): AuthenticatedRequest =>
  ({ body: {}, params: id === undefined ? {} : { id }, query, user } as unknown as AuthenticatedRequest);

/* ==========================================================================
 * Harness
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
  count_id: 300, clinic_id: 1, status: 'FINALISED', notes: 'جرد شهري',
  created_at: '2026-03-01T10:00:00.000Z', finalised_at: '2026-03-02T09:00:02.000Z',
  counted_by_user_id: 42, finalised_by_user_id: 77,
  counted_by_name: 'Counter One', finalised_by_name: 'Finaliser Two',
  clinic_name: 'Main Clinic', line_count: 2,
};

const LINE_ROW: QueryRow = {
  count_line_id: 301, batch_id: 117, medication_id: 11,
  system_quantity: 100, counted_quantity: 90, variance: -10,
  system_quantity_at_finalisation: 80, adjusted_quantity: 10,
  created_at: '2026-03-01T10:05:00.000Z',
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg', dosage_form: 'CAPSULE',
  lot_number: 'LOT-2026-A', expiry_date: '2027-01-31',
};

/** A user scoped to nothing gets nothing: the scope clause is never dropped. */
const scopeAware = (rows: QueryRow[], params: unknown[]): QueryRow[] =>
  params.some((p) => Array.isArray(p) && p.length === 0) ? [] : rows;

/**
 * The detail and audit lookups filter on the count's own clinic AND on the
 * requested id. A count that does not exist, or that belongs to a clinic
 * outside the caller's scope, must simply not resolve — this mirrors what the
 * two predicates do in SQL.
 */
const scopedToClinic = (rows: QueryRow[], params: unknown[], clinicId = 1): QueryRow[] => {
  const requestedId = Number(params[0]);
  const scope = params.find((p) => Array.isArray(p)) as number[] | undefined;
  return rows.filter((row) => {
    const rowId = Number(row.count_id ?? row.resource_id);
    if (Number.isInteger(requestedId) && rowId !== requestedId) return false;
    if (scope !== undefined && !scope.includes(clinicId)) return false;
    return true;
  });
};

/** 10D.8 is a read-only phase: this is the boundary it must never cross. */
const assertReadOnly = (calls: QueryCall[]) => {
  for (const call of calls) {
    assert.match(call.text.trim(), /^\s*SELECT\b/, `non-SELECT issued: ${call.text.slice(0, 80)}`);
    assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE)\b/i);
    assert.doesNotMatch(call.text, /\bRETURNING\b/i);
    assert.doesNotMatch(call.text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i, 'reads never lock rows');
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
    assert.doesNotMatch(call.text, /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i);
  }
};

/* ==========================================================================
 * 1-2. AUTHENTICATION AND AUTHORIZATION
 * ======================================================================== */

test('READ AUTH: every stock-count read rejects a missing bearer token with 401', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;
  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);

  // the router puts authenticateJWT in front of every route, reads included
  const guard = (stockCountsRouter as any).stack.find((l: any) => !l.route && l.name === 'authenticateJWT');
  assert.ok(guard, 'the whole router is behind authentication');
});

test('READ AUTHORIZATION: all three read routes require VIEW_INVENTORY', () => {
  const denied = (permissions: string[]) => {
    const request = {
      user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions },
    } as unknown as AuthenticatedRequest;
    let error: any = null;
    requirePermission('VIEW_INVENTORY')(request, {} as any, (err?: unknown) => { error = err ?? null; });
    return error !== null;
  };

  assert.equal(denied(['MANAGE_INVENTORY']), true, 'counting stock does not imply reading counts');
  assert.equal(denied(['VIEW_INVENTORY']), false);

  const readRoutes = (stockCountsRouter as any).stack
    .filter((l: any) => l.route && Object.keys(l.route.methods).includes('get'))
    .map((l: any) => l.route.path);
  assert.deepEqual(readRoutes.sort(), ['/', '/:id', '/:id/audit', '/reconciliation']);
});

test('READ ROUTES: no lines endpoint, no mutating verbs, no cancellation', () => {
  const layers = (stockCountsRouter as any).stack.filter((l: any) => l.route);
  const paths = layers.map((l: any) => l.route.path);

  assert.ok(!paths.includes('/:id/lines') || layers.some((l: any) => l.route.path === '/:id/lines' && !l.route.methods.get),
    'GET /:id/lines does not exist — lines live inside the detail response');
  const getPaths = layers.filter((l: any) => l.route.methods.get).map((l: any) => l.route.path);
  assert.ok(!getPaths.includes('/:id/lines'), 'there is no separate lines read route');

  const methods = layers.flatMap((l: any) => Object.keys(l.route.methods));
  for (const method of ['put', 'patch', 'delete']) {
    assert.equal(methods.includes(method), false, `no ${method.toUpperCase()} in this phase`);
  }
  for (const path of paths) {
    // 10D.9 adds the read-only /reconciliation report; the absent ones stay absent
    assert.doesNotMatch(path, /cancel|reopen|void|approve/i, `no such route may exist: ${path}`);
  }
});

/* ==========================================================================
 * 3-10. LIST
 * ======================================================================== */

test('LIST: returns the safe display fields, clinic-scoped', async () => {
  await withReads(
    (_text, params) => ({ rows: scopeAware([COUNT_ROW], params), rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.counts.length, 1);
      assertReadOnly(calls);
      assert.match(calls[0]!.text, /sc\.clinic_id = ANY\(\$\d+::int\[\]\)/, 'the scope predicate is in SQL');

      for (const field of [
        'count_id', 'clinic_id', 'status', 'counted_by_user_id', 'counted_by_name',
        'finalised_by_user_id', 'finalised_by_name', 'created_at', 'finalised_at', 'notes',
      ]) {
        assert.ok(field in COUNT_ROW, `the list carries ${field}`);
      }
    },
  );
});

test('LIST: no email, password, token or unrelated user field is ever selected', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listStockCounts(readReq(), makeRes().res);
      await getStockCount(readReq({}, '300'), makeRes().res);
      await getStockCountAudit(readReq({}, '300'), makeRes().res);

      for (const call of calls) {
        for (const forbidden of ['username', 'password', 'email', 'token', 'jwt', 'secret', 'phone', 'national_id']) {
          assert.doesNotMatch(
            call.text,
            new RegExp(`\\b${forbidden}\\b`, 'i'),
            `${forbidden} must never be selected by a stock-count read`,
          );
        }
      }
    },
  );
});

test('LIST: a user scoped to no clinic sees nothing (deny-by-default)', async () => {
  await withReads(
    (_text, params) => ({ rows: scopeAware([COUNT_ROW], params), rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq({}, undefined, NO_CLINIC), res);

      assert.deepEqual(captured.body.counts, [], 'an empty scope yields an empty list');
      assert.match(calls[0]!.text, /clinic_id = ANY\(\$\d+::int\[\]\)/, 'the clause is never omitted');
      assert.deepEqual(calls[0]!.params[0], [], 'the empty list is bound, never skipped');
    },
  );
});

test('LIST: a client-supplied clinic_id never narrows or widens the result', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq({ clinic_id: '2' }), res);

      assert.equal(captured.status, 200);
      assert.ok(!calls[0]!.params.includes(2), 'the client value is never even bound');
      assert.deepEqual(
        calls[0]!.params.filter((p) => Array.isArray(p)),
        [[1]],
        'the only clinic filter is the one derived from the session',
      );
      assert.match(calls[0]!.text, /sc\.clinic_id = ANY\(\$\d+::int\[\]\)/);
    },
  );
});

test('LIST: an empty result is a 200 with no rows, never a 404', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async () => {
      const { res, captured } = makeRes();
      await listStockCounts(readReq(), res);
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.counts, []);
      assert.equal(captured.body.pagination.returned, 0);
    },
  );
});

test('LIST: pagination defaults to 50, caps at 200 and requires offset >= 0', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const defaults = makeRes();
      await listStockCounts(readReq(), defaults.res);
      assert.equal(defaults.captured.body.pagination.limit, DEFAULT_STOCK_COUNT_LIMIT);
      assert.equal(defaults.captured.body.pagination.limit, 50);
      assert.equal(defaults.captured.body.pagination.offset, 0);
      assert.deepEqual(calls[0]!.params.slice(-2), [50, 0]);

      const max = makeRes();
      await listStockCounts(readReq({ limit: String(MAX_STOCK_COUNT_LIMIT) }), max.res);
      assert.equal(max.captured.status, 200);
      assert.deepEqual(calls[1]!.params.slice(-2), [200, 0], 'exactly the cap is accepted');
    },
  );

  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      for (const query of [{ limit: '201' }, { limit: '0' }, { limit: 'abc' }, { offset: '-1' }, { offset: 'x' }]) {
        const { res, captured } = makeRes();
        await listStockCounts(readReq(query), res);
        assert.equal(captured.status, 400, `${JSON.stringify(query)} must be refused`);
      }
      assert.equal(calls.length, 0, 'an invalid page never reaches the database');
    },
  );
});

test('LIST: the ordering is fixed and deterministic', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listStockCounts(readReq(), makeRes().res);
      assert.match(calls[0]!.text.replace(/\s+/g, ' '), /ORDER BY sc\.created_at DESC, sc\.count_id DESC/);
    },
  );
});

test('LIST: the status filter is validated, and an unknown status is refused before any query', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const ok = makeRes();
      await listStockCounts(readReq({ status: 'FINALISED' }), ok.res);
      assert.equal(ok.captured.status, 200);
      assert.equal(calls[0]!.params[0], 'FINALISED');

      const bad = makeRes();
      await listStockCounts(readReq({ status: 'APPROVED' }), bad.res);
      assert.equal(bad.captured.status, 400);
      assert.equal(calls.length, 1, 'the invalid filter never reached the database');
    },
  );
});

test('LIST: the query stays lightweight — one statement, no join explosion', async () => {
  await withReads(
    () => ({ rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      await listStockCounts(readReq(), makeRes().res);
      assert.equal(calls.length, 1, 'the list is a single query');
      const sql = calls[0]!.text;
      assert.doesNotMatch(sql, /JOIN stock_count_lines/i, 'the line count is a scalar subquery, not a join');
      assert.match(sql, /SELECT COUNT\(\*\)::int FROM stock_count_lines/, 'line_count without pulling the lines');
      assert.doesNotMatch(sql, /inventory_batches/, 'the list needs no batch data');
      assert.doesNotMatch(sql, /JOIN medications/i, 'the list needs no medication data');
    },
  );
});

/* ==========================================================================
 * 11-26. DETAIL
 * ======================================================================== */

test('DETAIL: returns the header and every stored line in two statements', async () => {
  await withReads(
    (text) => (text.includes('FROM stock_count_lines') ? { rows: [LINE_ROW], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);

      assert.equal(captured.status, 200);
      assertReadOnly(calls);
      assert.equal(calls.length, 2, 'header and lines only — no N+1');
      assert.match(calls[1]!.text, /JOIN medications m/, 'the medication identity is joined once');
      assert.match(calls[1]!.text, /LEFT JOIN inventory_batches b/, 'the batch identity is joined once');

      const count = captured.body.count;
      for (const field of [
        'count_id', 'clinic_id', 'status', 'counted_by_user_id', 'counted_by_name',
        'finalised_by_user_id', 'finalised_by_name', 'created_at', 'finalised_at', 'notes',
      ]) {
        assert.ok(field in count, `the header carries ${field}`);
      }
      assert.equal(count.line_count, 1);
    },
  );
});

test('DETAIL: every line carries identity, batch and stored numbers', async () => {
  await withReads(
    (text) => (text.includes('FROM stock_count_lines') ? { rows: [LINE_ROW], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async () => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);
      const line = captured.body.count.lines[0];

      assert.equal(line.count_line_id, 301);
      assert.equal(line.batch_id, 117);
      assert.equal(line.medication_id, 11);
      assert.deepEqual(line.medication, {
        trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg', dosage_form: 'CAPSULE',
      });
      assert.equal(line.lot_number, 'LOT-2026-A');
      assert.ok(String(line.expiry_date).startsWith('2027-01-31'));
      assert.equal(line.system_quantity, 100);
      assert.equal(line.counted_quantity, 90);
      assert.equal(line.variance, -10);
      assert.equal(line.system_quantity_at_finalisation, 80);
      assert.equal(line.adjusted_quantity, 10);
      assert.ok(line.created_at);
    },
  );
});

test('DETAIL: the numbers are the stored history, never recomputed from live stock', async () => {
  await withReads(
    (text) => (text.includes('FROM stock_count_lines') ? { rows: [LINE_ROW], rowCount: 0 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);
      const line = captured.body.count.lines[0];

      // the batch balance moved from 80 to 5 after finalisation: the line must
      // still report the snapshot it recorded, not the current balance
      assert.equal(line.system_quantity, 100, 'the count-time snapshot');
      assert.equal(line.variance, -10, 'the count-time variance');
      assert.equal(line.system_quantity_at_finalisation, 80, 'the finalisation-time snapshot');
      assert.equal(line.adjusted_quantity, 10, 'the applied correction');

      const lineSql = calls[1]!.text;
      assert.doesNotMatch(lineSql, /quantity_on_hand/, 'the live balance is never read for a count line');
      assert.doesNotMatch(lineSql, /counted_quantity\s*-\s*scl\.system_quantity/, 'the variance is never recomputed');
      assert.doesNotMatch(lineSql, /COALESCE\s*\(\s*scl\.system_quantity_at_finalisation/i, 'a finalisation value is never faked from the count-time one');
    },
  );
});

test('DETAIL: an unfinalised line reports null finalisation values, not zeroes', async () => {
  await withReads(
    (text) => (
      text.includes('FROM stock_count_lines')
        ? { rows: [{ ...LINE_ROW, system_quantity_at_finalisation: null, adjusted_quantity: null }], rowCount: 1 }
        : { rows: [{ ...COUNT_ROW, status: 'OPEN', finalised_at: null, finalised_by_user_id: null, finalised_by_name: null }], rowCount: 1 }
    ),
    async () => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);
      const line = captured.body.count.lines[0];

      assert.equal(line.system_quantity_at_finalisation, null, 'not yet finalised means unknown, not zero');
      assert.equal(line.adjusted_quantity, null);
      assert.equal(captured.body.count.finalised_by_user_id, null);
      assert.equal(captured.body.count.finalised_by_name, null);
    },
  );
});

test('DETAIL: a line whose batch was archived still resolves, with null batch identity', async () => {
  await withReads(
    (text) => (
      text.includes('FROM stock_count_lines')
        ? { rows: [{ ...LINE_ROW, lot_number: null, expiry_date: null }], rowCount: 1 }
        : { rows: [COUNT_ROW], rowCount: 1 }
    ),
    async () => {
      const { res, captured } = makeRes();
      await getStockCount(readReq({}, '300'), res);
      const line = captured.body.count.lines[0];
      assert.equal(line.lot_number, null, 'a missing batch must not drop the counted line');
      assert.equal(line.variance, -10, 'the evidence survives regardless');
    },
  );
});

test('DETAIL: nonexistent and out-of-clinic counts return an identical 404', async () => {
  await withReads(
    (_text, params) => ({ rows: scopedToClinic([COUNT_ROW], params), rowCount: 1 }),
    async (calls) => {
      const missing = makeRes();
      await getStockCount(readReq({}, '300', VIEWER_OTHER_CLINIC), missing.res);
      const first = { status: missing.captured.status, body: missing.captured.body };
      assert.equal(first.status, 404, 'the baseline case is out of scope');

      const nonexistent = makeRes();
      await getStockCount(readReq({}, '424242'), nonexistent.res);
      assert.equal(nonexistent.captured.status, 404);
      assert.deepEqual(nonexistent.captured.body, first.body, 'no existence leak');

      const foreign = makeRes();
      await getStockCount(readReq({}, '300', VIEWER_OTHER_CLINIC), foreign.res);
      assert.equal(foreign.captured.status, 404);
      assert.deepEqual(foreign.captured.body, first.body);

      const none = makeRes();
      await getStockCount(readReq({}, '300', NO_CLINIC), none.res);
      assert.equal(none.captured.status, 404);
      assert.deepEqual(none.captured.body, first.body);

      assertReadOnly(calls);
      assert.equal(calls.length, 4, 'each missing count costs exactly one lookup and no line query');
    },
  );
});

test('DETAIL: a malformed count id never reaches the database', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      for (const id of ['abc', '0', '-3']) {
        const { res, captured } = makeRes();
        await getStockCount(readReq({}, id), res);
        assert.equal(captured.status, 400);
      }
      assert.equal(calls.length, 0);
    },
  );
});

test('DETAIL: reading a count mutates nothing — no stock, no movements, no adjustments', async () => {
  await withReads(
    (text) => (text.includes('FROM stock_count_lines') ? { rows: [LINE_ROW], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      await listStockCounts(readReq(), makeRes().res);
      await getStockCount(readReq({}, '300'), makeRes().res);
      await getStockCountAudit(readReq({}, '300'), makeRes().res);

      assertReadOnly(calls);
      const all = calls.map((c) => c.text).join('\n');
      for (const forbidden of [
        /UPDATE\s+inventory_batches/i,
        /INSERT INTO stock_adjustments/i,
        /INSERT INTO stock_movements/i,
        /UPDATE stock_counts/i,
        /UPDATE stock_count_lines/i,
        /batch_quarantines/i,
      ]) {
        assert.doesNotMatch(all, forbidden, `a read must never issue ${forbidden}`);
      }
    },
  );
});

/* ==========================================================================
 * 27-34. AUDIT
 * ======================================================================== */

const AUDIT_ROW = (over: Record<string, unknown> = {}): QueryRow => ({
  audit_id: 9001, action: 'STOCK_COUNT_FINALISED', resource_type: 'STOCK_COUNT',
  resource_id: '300', metadata: { count_id: 300, clinic_id: 1, line_count: 2 },
  created_at: '2026-03-02T09:00:03.000Z', clinic_id: 1, user_name: 'Finaliser Two',
  ...over,
});

test('AUDIT: an authorised reader sees only this count audit trail', async () => {
  await withReads(
    (text, params) => (
      text.includes('FROM audit_logs')
        ? { rows: scopeAware([AUDIT_ROW(), AUDIT_ROW({ audit_id: 9000, action: 'STOCK_COUNT_OPENED', created_at: '2026-03-01T10:00:01.000Z' })], params), rowCount: 2 }
        : { rows: [COUNT_ROW], rowCount: 1 }
    ),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountAudit(readReq({}, '300', SUPER_ADMIN), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.count_id, 300);
      assert.equal(captured.body.audit_logs.length, 2);
      assertReadOnly(calls);

      const auditCall = calls.find((c) => c.text.includes('FROM audit_logs'))!;
      assert.match(auditCall.text, /a\.resource_type = 'STOCK_COUNT'/, 'unrelated resource types are excluded');
      assert.match(auditCall.text, /a\.resource_id = \$1/, 'only this count');
      assert.match(auditCall.text, /ORDER BY a\.created_at ASC/, 'chronological, like the returns audit');

      const actions = captured.body.audit_logs.map((row: any) => row.action);
      assert.ok(actions.includes('STOCK_COUNT_FINALISED'), 'the finalisation event is visible');
      assert.ok(actions.includes('STOCK_COUNT_OPENED'));
    },
  );
});

test('AUDIT: a SYSTEM_ADMIN holding VIEW_SYSTEM_LOGS is authorised', async () => {
  await withReads(
    (text) => (text.includes('FROM audit_logs') ? { rows: [AUDIT_ROW()], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async () => {
      const { res, captured } = makeRes();
      await getStockCountAudit(readReq({}, '300', SYSTEM_ADMIN), res);
      assert.equal(captured.status, 200);
    },
  );
});

test('AUDIT: an ordinary pharmacist is refused — no new permission is invented', async () => {
  for (const user of [VIEWER, PHARMACIST, VIEWER_OTHER_CLINIC, NO_CLINIC]) {
    await withReads(
      () => ({ rows: [COUNT_ROW], rowCount: 1 }),
      async (calls) => {
        const { res, captured } = makeRes();
        await getStockCountAudit(readReq({}, '300', user), res);
        assert.equal(captured.status, 403, `${user.roleName} must not read system logs`);
        assert.equal(calls.length, 0, 'and the refusal happens before any query');
      },
    );
  }
});

test('AUDIT: the audit trail of a nonexistent count is the same 404 a reader gets for any other missing count', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const missing = makeRes();
      await getStockCountAudit(readReq({}, '300', SUPER_ADMIN), missing.res);
      const first = { status: missing.captured.status, body: missing.captured.body };
      assert.equal(first.status, 404);

      const nonexistent = makeRes();
      await getStockCountAudit(readReq({}, '999999', SUPER_ADMIN), nonexistent.res);
      assert.equal(nonexistent.captured.status, 404);
      assert.deepEqual(nonexistent.captured.body, first.body, 'no existence leak');
      assertReadOnly(calls);
    },
  );
});

test('AUDIT: the scope predicate stays in SQL for an audit read too', async () => {
  // VIEW_SYSTEM_LOGS on a PHARMACIST does not make them a system-log reader
  await withReads(
    () => ({ rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountAudit(readReq({}, '300', PHARMACIST_AUDIT), res);
      assert.equal(captured.status, 403);
      assert.equal(calls.length, 0);
    },
  );

  // canAccessLogs admits only SUPER_ADMIN / SYSTEM_ADMIN, and both are admin
  // roles that are legitimately unrestricted (canManageAllClinics). The scope is
  // therefore tied to the count by a join, never guessed from the request —
  // exactly the rule the 10D.4 returns audit uses.
  await withReads(
    (text) => {
      if (text.includes('FROM audit_logs a')) {
        assert.match(text, /JOIN stock_counts sc ON sc\.count_id = a\.resource_id::int/, 'the scope is joined, not guessed');
        assert.match(text, /a\.resource_type = 'STOCK_COUNT'/);
        assert.match(text, /a\.resource_id = \$1/);
        assert.doesNotMatch(text, /a\.clinic_id = \$/, 'a clinic filter is never bound from the request');
        assert.match(text, /ORDER BY a\.created_at ASC, a\.audit_id ASC/);
        return { rows: [AUDIT_ROW()], rowCount: 1 };
      }
      assert.match(text, /FROM stock_counts sc/, 'the existence check is scoped too');
      return { rows: [COUNT_ROW], rowCount: 1 };
    },
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountAudit(readReq({}, '300', SYSTEM_ADMIN), res);
      assert.equal(captured.status, 200);
      assertReadOnly(calls);
    },
  );
});

test('AUDIT: reading a trail never writes a new audit row', async () => {
  await withReads(
    (text) => (text.includes('FROM audit_logs') ? { rows: [AUDIT_ROW()], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      await getStockCountAudit(readReq({}, '300', SUPER_ADMIN), makeRes().res);
      await getStockCountAudit(readReq({}, '300', SUPER_ADMIN), makeRes().res);
      for (const call of calls) {
        assert.doesNotMatch(call.text, /INSERT INTO audit_logs/i, 'a read is not an event');
      }
      assertReadOnly(calls);
    },
  );
});

test('AUDIT: the response carries audit fields only — no user identity beyond the display name', async () => {
  await withReads(
    (text) => (text.includes('FROM audit_logs') ? { rows: [AUDIT_ROW()], rowCount: 1 } : { rows: [COUNT_ROW], rowCount: 1 }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountAudit(readReq({}, '300', SUPER_ADMIN), res);
      const row = captured.body.audit_logs[0];

      assert.deepEqual(
        Object.keys(row).sort(),
        ['action', 'audit_id', 'clinic_id', 'created_at', 'metadata', 'resource_id', 'resource_type', 'user_name'],
        'the same shape the returns audit exposes, and nothing more',
      );
      assert.doesNotMatch(calls.find((c) => c.text.includes('FROM audit_logs'))!.text, /\bu\.\w*username\b/i);
    },
  );
});

test('AUDIT: metadata is limited to this count and never another resource', async () => {
  await withReads(
    (text) => (
      text.includes('FROM audit_logs')
        ? {
          rows: [
            AUDIT_ROW({
              metadata: {
                count_id: 300, clinic_id: 1, counted_by_user_id: 42, finalised_by_user_id: 77,
                line_count: 1, total_increase_quantity: 0, total_decrease_quantity: 10,
                lines: [{ batch_id: 117, counted_quantity: 90, adjusted_quantity: 10 }],
              },
            }),
          ],
          rowCount: 1,
        }
        : { rows: [COUNT_ROW], rowCount: 1 }
    ),
    async () => {
      const { res, captured } = makeRes();
      await getStockCountAudit(readReq({}, '300', SUPER_ADMIN), res);
      const meta = captured.body.audit_logs[0].metadata;

      assert.equal(meta.count_id, 300, 'only this count');
      for (const forbiddenKey of ['password', 'token', 'jwt', 'refresh_token', 'authorization', 'secret']) {
        assert.ok(!(forbiddenKey in meta), `${forbiddenKey} must never appear in audit metadata`);
      }
      assert.ok(meta.lines.every((l: any) => l.batch_id === 117), 'no unrelated batch leaks in');
    },
  );
});
