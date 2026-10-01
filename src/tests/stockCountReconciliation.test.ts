import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { authenticateJWT, requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { getStockCountReconciliation } from '../modules/inventory/stockCounts.controller';
import stockCountsRouter from '../modules/inventory/stockCounts.routes';
import {
  DEFAULT_STOCK_COUNT_LIMIT,
  MAX_STOCK_COUNT_LIMIT,
} from '../validations/stockCountRead.validation';

/* ==========================================================================
 * Phase 10D.9 — Stock reconciliation report
 *
 * Read-only evidence report. The suite proves the properties that matter:
 *   1. only FINALISED counts participate, and the latest one is chosen when
 *      count_id is omitted,
 *   2. the current quantity is read LIVE from inventory_batches, never from
 *      the frozen snapshots,
 *   3. the frozen historical numbers are reported unchanged,
 *   4. no batch is excluded merely for being expired, inactive, quarantined
 *      or empty,
 *   5. the report writes nothing, locks nothing, and issues no N+1.
 * ======================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

/** Holds MANAGE_INVENTORY but not VIEW_INVENTORY: writing stock is not reading. */
const COUNTER_ONLY = {
  userId: 43, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['MANAGE_INVENTORY'], clinicIds: [1],
};

const OTHER_CLINIC = {
  userId: 44, roleId: 4, clinicId: 2, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY'], clinicIds: [2],
};

const NO_CLINIC = { ...PHARMACIST, userId: 45, clinicId: null, clinicIds: [] };

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const reportReq = (
  query: Record<string, unknown> = {},
  user: unknown = PHARMACIST,
): AuthenticatedRequest =>
  ({ body: {}, params: {}, query, user } as unknown as AuthenticatedRequest);

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

/** 10D.9 is a read-only phase: this is the boundary it must never cross. */
const assertReadOnly = (calls: QueryCall[]) => {
  for (const call of calls) {
    assert.match(call.text.trim(), /^\s*SELECT\b/i, `non-SELECT issued: ${call.text.slice(0, 90)}`);
    assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
    assert.doesNotMatch(call.text, /\bRETURNING\b/i);
    assert.doesNotMatch(call.text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i, 'a report never locks rows');
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
    assert.doesNotMatch(call.text, /\b(BEGIN|COMMIT|ROLLBACK)\b/i);
  }
};

/** The count header returned by the resolver query. */
const TARGET_ROW: QueryRow = {
  count_id: 300, created_at: '2026-03-01T10:00:00.000Z', finalised_at: '2026-03-02T09:00:02.000Z',
};

/** A report line: historical evidence next to live stock that has since moved. */
const ROW: QueryRow = {
  count_line_id: 301, count_id: 300,
  count_created_at: '2026-03-01T10:00:00.000Z', finalised_at: '2026-03-02T09:00:02.000Z',
  inventory_id: 11, batch_id: 117, medication_id: 21,
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg', dosage_form: 'CAPSULE',
  lot_number: 'LOT-2026-A', expiry_date: '2027-01-31',
  counted_quantity: '90.000', system_quantity_at_finalisation: '80.000', adjusted_quantity: '10.000',
  current_quantity_on_hand: '60.000', reconciliation_difference: '-30.000',
  quantity_reserved: '5.000', batch_is_active: true, is_quarantined: false,
};

/** Resolver answers the latest-finalised lookup; the report answers the rest. */
const live = (
  target: QueryRow | null = TARGET_ROW,
  rows: QueryRow[] = [ROW],
): ((text: string, params: unknown[]) => MockResult) => (text, params) => {
  if (text.includes('FROM stock_count_lines')) return { rows, rowCount: rows.length };
  void params;
  return target === null ? { rows: [], rowCount: 0 } : { rows: [target], rowCount: 1 };
};

/* ==========================================================================
 * 1-3. AUTHORIZATION AND VALIDATION
 * ======================================================================== */

test('RECON AUTH: a missing bearer token is a 401 and the whole router sits behind auth', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;
  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);

  const guard = (stockCountsRouter as any).stack.find((l: any) => !l.route && l.name === 'authenticateJWT');
  assert.ok(guard, 'every route, the report included, is authenticated');
});

test('RECON PERMISSION: VIEW_INVENTORY is enough, and nothing weaker is', () => {
  const denied = (permissions: string[]) => {
    const request = {
      user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions },
    } as unknown as AuthenticatedRequest;
    let error: any = null;
    requirePermission('VIEW_INVENTORY')(request, {} as any, (err?: unknown) => { error = err ?? null; });
    return error !== null;
  };

  assert.equal(denied(['VIEW_INVENTORY']), false, 'a plain viewer may reconcile');
  assert.equal(denied([]), true, 'a user with no inventory right may not');
  assert.equal(denied(['MANAGE_INVENTORY']), true, 'counting stock does not imply reading counts');

  const reportRoute = (stockCountsRouter as any).stack
    .find((l: any) => l.route && l.route.path === '/reconciliation');
  assert.ok(reportRoute, 'the report route is registered');
  assert.deepEqual(Object.keys(reportRoute.route.methods), ['get'], 'read-only');
});

test('RECON ROUTE: /reconciliation is registered before /:id so it is never read as an id', () => {
  const paths = (stockCountsRouter as any).stack
    .filter((l: any) => l.route)
    .map((l: any) => l.route.path);

  const reportAt = paths.indexOf('/reconciliation');
  const idAt = paths.indexOf('/:id');
  assert.ok(reportAt > 0 && idAt > 0);
  assert.ok(reportAt < idAt, 'otherwise Express would treat "reconciliation" as a count id');
});

test('RECON VALIDATION: an invalid parameter is refused before any query', async () => {
  const badQueries = [
    { count_id: 'abc' }, { count_id: '0' }, { count_id: '-3' }, { count_id: '1.5' },
    { inventory_id: 'x' }, { batch_id: '-1' },
    { limit: '0' }, { limit: String(MAX_STOCK_COUNT_LIMIT + 1) }, { limit: 'many' },
    { offset: '-1' }, { offset: 'x' },
  ];

  await withReads(
    () => { throw new Error('no query may run for an invalid parameter'); },
    async (calls) => {
      for (const query of badQueries) {
        const { res, captured } = makeRes();
        await getStockCountReconciliation(reportReq(query), res);
        assert.equal(captured.status, 400, `${JSON.stringify(query)} must be refused`);
        assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
      }
      assert.equal(calls.length, 0, 'the database is never touched for invalid input');
    },
  );
});

test('RECON VALIDATION: a client-supplied clinic_id is never bound into the query', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq({ clinic_id: '2' }), res);

      assert.equal(captured.status, 200);
      assert.ok(!calls[0]!.params.includes(2), 'the client clinic is never even bound');
      assert.deepEqual(
        calls[0]!.params.filter((p) => Array.isArray(p)),
        [[1]],
        'the only clinic filter is the one derived from the session',
      );
      assert.match(calls[0]!.text, /sc\.clinic_id = ANY\(\$\d+::int\[\]\)/);
    },
  );
});

/* ==========================================================================
 * 4-7. WHICH COUNT IS RECONCILED
 * ======================================================================== */

test('RECON COUNT: the latest FINALISED count is selected when count_id is omitted', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.count_id, 300);
      assert.equal(captured.body.count_created_at, TARGET_ROW.created_at);
      assert.equal(captured.body.finalised_at, TARGET_ROW.finalised_at);

      const resolver = calls[0]!.text;
      assert.match(resolver, /sc\.status = 'FINALISED'/, 'only a finalised count qualifies');
      assert.match(resolver, /ORDER BY sc\.created_at DESC, sc\.count_id DESC/, 'the latest one wins, deterministically');
      assert.doesNotMatch(resolver, /sc\.status = 'OPEN'/, 'an open count is never inferred');
      assertReadOnly(calls);
    },
  );
});

test('RECON COUNT: an OPEN count is never selected, and a scope with no finalised count is empty', async () => {
  // The resolver only ever asks for FINALISED. When the clinic has none, the
  // report is an empty 200 — nothing is created, chosen or mutated.
  await withReads(
    live(null),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.count_id, null, 'no count is invented');
      assert.deepEqual(captured.body.rows, []);
      assert.equal(captured.body.pagination.returned, 0);
      assert.equal(calls.length, 1, 'an empty result costs only the resolver lookup');
      assertReadOnly(calls);
    },
  );
});

test('RECON COUNT: an explicit count_id reconciles that count only', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq({ count_id: '300' }), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.count_id, 300);
      assert.match(calls[0]!.text, /WHERE sc\.count_id = \$1/);
      assert.match(calls[0]!.text, /sc\.status = 'FINALISED'/);
      assert.doesNotMatch(calls[0]!.text, /sc\.status = 'OPEN'/, 'an unfinalised count is never reconciled');
      assert.equal(calls[1]!.params[0], 300, 'the report is bound to that count');
    },
  );
});

test('RECON COUNT: a missing, out-of-scope or unfinalised count is the same 404', async () => {
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      const missing = makeRes();
      await getStockCountReconciliation(reportReq({ count_id: '300' }), missing.res);
      const first = { status: missing.captured.status, body: missing.captured.body };
      assert.equal(first.status, 404);

      for (const query of [{ count_id: '999999' }, { count_id: '300' }]) {
        for (const user of [OTHER_CLINIC, NO_CLINIC]) {
          const { res, captured } = makeRes();
          await getStockCountReconciliation(reportReq(query, user), res);
          assert.equal(captured.status, 404, 'a count outside the caller scope is unreachable');
          assert.deepEqual(captured.body, first.body, 'no existence leak between the cases');
        }
      }

      assertReadOnly(calls);
    },
  );
});

/* ==========================================================================
 * 8-12. LIVE STOCK versus FROZEN EVIDENCE
 * ======================================================================== */

test('RECON DATA: the current quantity is read live, never from a frozen snapshot', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      const row = captured.body.rows[0];
      assert.equal(row.current_quantity_on_hand, '60.000', 'the live balance is reported as read');
      assert.notEqual(row.current_quantity_on_hand, row.system_quantity_at_finalisation,
        'live stock and the finalisation snapshot are genuinely different numbers here');

      const report = calls[1]!.text;
      assert.match(report, /b\.quantity_on_hand AS current_quantity_on_hand/, 'the live column is selected');
      assert.doesNotMatch(report, /scl\.system_quantity AS current/i, 'the line snapshot is never restated as current');
    },
  );
});

test('RECON DATA: the difference is current minus counted, computed in SQL', async () => {
  await withReads(
    live(TARGET_ROW, [
      { ...ROW, counted_quantity: '90.000', current_quantity_on_hand: '60.000', reconciliation_difference: '-30.000' },
      { ...ROW, count_line_id: 302, batch_id: 118, counted_quantity: '40.000', current_quantity_on_hand: '40.000', reconciliation_difference: '0.000' },
      { ...ROW, count_line_id: 303, batch_id: 119, counted_quantity: '10.000', current_quantity_on_hand: '25.000', reconciliation_difference: '15.000' },
    ]),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      const [down, even, up] = captured.body.rows;
      assert.equal(down.reconciliation_difference, '-30.000', 'stock fell after finalisation');
      assert.equal(even.reconciliation_difference, '0.000', 'no current difference is distinguishable');
      assert.equal(up.reconciliation_difference, '15.000', 'stock rose after finalisation');

      const report = calls[1]!.text;
      assert.match(report, /b\.quantity_on_hand - scl\.counted_quantity AS reconciliation_difference/,
        'exact NUMERIC arithmetic in the database, never a JS float');
      assert.doesNotMatch(report, /scl\.variance/, 'the frozen variance is not reused as the result');
      assert.doesNotMatch(report, /scl\.variance[^\n]*AS reconciliation/i);
    },
  );
});

test('RECON DATA: the historical evidence is reported unchanged', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      const row = captured.body.rows[0];
      assert.equal(row.counted_quantity, '90.000', 'what was counted is what is reported');
      assert.equal(row.system_quantity_at_finalisation, '80.000', 'the pre-correction snapshot is untouched');
      assert.equal(row.adjusted_quantity, '10.000', 'the finalisation correction is untouched');

      const report = calls[1]!.text;
      for (const column of [
        'scl.counted_quantity', 'scl.system_quantity_at_finalisation', 'scl.adjusted_quantity',
      ]) {
        assert.match(report, new RegExp(column.replace('.', '\\.')), `${column} is reported`);
      }
      assert.doesNotMatch(report, /UPDATE\s+stock_count_lines/i);
      assert.doesNotMatch(report, /\bSET\s+\w+\s*=/i, 'no historical column is recomputed or rewritten');
    },
  );
});

test('RECON DATA: a line whose batch is gone reports nulls instead of a fabricated quantity', async () => {
  await withReads(
    live(TARGET_ROW, [{
      ...ROW,
      inventory_id: null, lot_number: null, expiry_date: null,
      current_quantity_on_hand: null, reconciliation_difference: null, quantity_reserved: null,
      batch_is_active: null,
    }]),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      const row = captured.body.rows[0];
      assert.equal(captured.status, 200, 'the line still exists as evidence');
      assert.equal(row.current_quantity_on_hand, null, 'a missing live quantity is never invented');
      assert.equal(row.reconciliation_difference, null, 'and no difference is invented from it');
      assert.equal(row.quantity_reserved, null);
      assert.equal(row.batch_is_active, null);
      assert.equal(row.counted_quantity, '90.000', 'the frozen count is still reported');

      assert.match(calls[1]!.text, /LEFT JOIN inventory_batches b ON b\.batch_id = scl\.batch_id/,
        'the batch is joined, never required — a lost batch stays visible');
    },
  );
});

/* ==========================================================================
 * 13-14. ELIGIBILITY AND SCOPE
 * ======================================================================== */

test('RECON ELIGIBILITY: expired, inactive, quarantined and empty batches are all still reported', async () => {
  const unusual = [
    { ...ROW, count_line_id: 401, batch_id: 201, lot_number: 'EXPIRED', expiry_date: '2020-01-01', current_quantity_on_hand: '5.000', reconciliation_difference: '-85.000' },
    { ...ROW, count_line_id: 402, batch_id: 202, batch_is_active: false, current_quantity_on_hand: '90.000', reconciliation_difference: '0.000' },
    { ...ROW, count_line_id: 403, batch_id: 203, is_quarantined: true, current_quantity_on_hand: '90.000', reconciliation_difference: '0.000' },
    { ...ROW, count_line_id: 404, batch_id: 204, current_quantity_on_hand: '0.000', reconciliation_difference: '-90.000' },
  ];

  await withReads(
    live(TARGET_ROW, unusual),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq({ limit: '200' }), res);

      assert.equal(captured.body.rows.length, 4, 'reconciliation is evidence, not FEFO selection');
      assert.deepEqual(
        captured.body.rows.map((r: any) => r.batch_id),
        [201, 202, 203, 204],
      );

      const report = calls[1]!.text;
      // No eligibility predicate of any kind may hide a counted batch
      for (const forbidden of [
        /expiry_date\s*>/i, /expiry_date\s*>=/i, /is_active\s*=\s*TRUE/i,
        /released_at\s+IS\s+NOT\s+NULL/i, /quantity_on_hand\s*>\s*0/i, /i\.deleted_at/i,
      ]) {
        assert.doesNotMatch(report, forbidden, `a report must never filter on ${forbidden}`);
      }
      // Quarantine state is exposed read-only, never used as a rule
      assert.match(report, /LEFT JOIN batch_quarantines q ON q\.batch_id = scl\.batch_id AND q\.released_at IS NULL/);
      assert.match(report, /\(q\.quarantine_id IS NOT NULL\) AS is_quarantined/);
    },
  );
});

test('RECON SCOPE: the report is scoped through the count, and filters are bound, not interpolated', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq({ inventory_id: '11', batch_id: '117' }), res);

      assert.equal(captured.status, 200);
      const resolver = calls[0]!;
      const report = calls[1]!;
      assert.match(resolver.text, /sc\.clinic_id = ANY\(\$1::int\[\]\)/, 'scope rides on the count');
      assert.deepEqual(resolver.params[0], [1], 'the caller clinic scope is bound');

      assert.match(report.text, /b\.inventory_id = \$2/);
      assert.match(report.text, /scl\.batch_id = \$3/);
      assert.deepEqual(report.params.slice(0, 3), [300, 11, 117], 'every filter is a bound parameter');
      assert.ok(!report.text.includes('11') || /\$\d/.test(report.text), 'no literal is spliced into SQL');
      assertReadOnly(calls);
    },
  );
});

test('RECON SCOPE: a caller scoped to no clinic reaches no count at all', async () => {
  await withReads(
    (_text, params) => ({
      rows: params.some((p) => Array.isArray(p) && p.length === 0) ? [] : [TARGET_ROW],
      rowCount: 1,
    }),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq({}, NO_CLINIC), res);

      // the empty scope is bound, never dropped, and the mock honours it
      assert.deepEqual(calls[0]!.params, [[]], 'deny-by-default: the empty list is bound');
      assert.match(calls[0]!.text, /clinic_id = ANY\(\$1::int\[\]\)/, 'the clause is never omitted');
    },
  );
});

/* ==========================================================================
 * 15-17. SHAPE, MUTATION AND QUERY DISCIPLINE
 * ======================================================================== */

test('RECON PAGE: limit and offset behave and are echoed back', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      assert.deepEqual(captured.body.pagination, {
        limit: DEFAULT_STOCK_COUNT_LIMIT, offset: 0, returned: 1,
      });
      assert.deepEqual(calls[1]!.params.slice(-2), [DEFAULT_STOCK_COUNT_LIMIT, 0], 'defaults are bound');

      const explicit = makeRes();
      await getStockCountReconciliation(reportReq({ limit: '10', offset: '20' }), explicit.res);
      assert.deepEqual(calls[3]!.params.slice(-2), [10, 20]);
      assert.deepEqual(explicit.captured.body.pagination, { limit: 10, offset: 20, returned: 1 });

      const capped = makeRes();
      await getStockCountReconciliation(reportReq({ limit: String(MAX_STOCK_COUNT_LIMIT) }), capped.res);
      assert.equal(capped.captured.body.pagination.limit, MAX_STOCK_COUNT_LIMIT, 'the cap is accepted exactly');
    },
  );
});

test('RECON PAGE: the report is deterministic and carries only reconciliation fields', async () => {
  await withReads(
    live(),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      assert.match(calls[1]!.text, /ORDER BY scl\.count_line_id ASC/, 'a stable order, not a guess');
      assert.deepEqual(Object.keys(captured.body).sort(), [
        'count_created_at', 'count_id', 'finalised_at', 'pagination', 'rows',
      ]);
      assert.deepEqual(Object.keys(captured.body.rows[0]).sort(), [
        'adjusted_quantity', 'batch_id', 'batch_is_active', 'count_created_at', 'count_id', 'count_line_id',
        'counted_quantity', 'current_quantity_on_hand', 'expiry_date', 'finalised_at', 'inventory_id',
        'is_quarantined', 'lot_number', 'medication', 'medication_id', 'quantity_reserved',
        'reconciliation_difference', 'system_quantity_at_finalisation',
      ]);

      const report = calls[1]!.text;
      for (const forbidden of ['username', 'password', 'email', 'token', 'national_id', 'counted_by', 'finalised_by']) {
        assert.doesNotMatch(report, new RegExp(forbidden, 'i'), `${forbidden} must never be selected`);
      }
    },
  );
});

test('RECON DISCIPLINE: two statements, no N+1, no join explosion, no mutation', async () => {
  await withReads(
    live(TARGET_ROW, [ROW, { ...ROW, count_line_id: 302, batch_id: 118 }, { ...ROW, count_line_id: 303, batch_id: 119 }]),
    async (calls) => {
      const { res, captured } = makeRes();
      await getStockCountReconciliation(reportReq(), res);

      assert.equal(captured.body.rows.length, 3);
      assert.equal(calls.length, 2, 'a resolver lookup and one set-based report — never one per row');
      assertReadOnly(calls);

      const all = calls.map((c) => c.text).join('\n');
      for (const forbidden of [
        /INSERT INTO stock_adjustments/i,
        /INSERT INTO stock_movements/i,
        /UPDATE inventory_batches/i,
        /UPDATE stock_counts/i,
        /UPDATE stock_count_lines/i,
        /INSERT INTO batch_quarantines/i,
        /INSERT INTO audit_logs/i,
      ]) {
        assert.doesNotMatch(all, forbidden, `a report must never issue ${forbidden}`);
      }
    },
  );
});
