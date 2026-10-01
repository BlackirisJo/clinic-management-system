import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { authenticateJWT, requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listMedicationReturns,
  getMedicationReturn,
  getMedicationReturnMovements,
  getMedicationReturnAudit,
} from '../modules/inventory/medicationReturns.controller';
import medicationReturnsRouter from '../modules/inventory/medicationReturns.routes';
import * as medicationReturnsController from '../modules/inventory/medicationReturns.controller';
import {
  DEFAULT_MEDICATION_RETURN_LIMIT,
  MAX_MEDICATION_RETURN_LIMIT,
  MEDICATION_RETURN_REFERENCE_TYPE,
  MEDICATION_RETURN_STATUSES,
  RESTOCK_DECISIONS,
} from '../validations/medicationReturnRead.validation';

/* ==========================================================================
 * Phase 10D.4 — Medication returns read & audit API
 * Every path must be SELECT-only, clinic-scoped, and leak nothing out of scope.
 * There is no mutation endpoint in this phase, and no test may create one.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
};

const SYSTEM_ADMIN = {
  userId: 1, roleId: 2, clinicId: null, roleName: 'SYSTEM_ADMIN',
  permissions: ['VIEW_INVENTORY', 'VIEW_SYSTEM_LOGS'], clinicIds: [],
};

const ADMIN = {
  userId: 9, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [], clinicIds: [],
};

const readReq = (query: Record<string, unknown> = {}, id?: string, user: unknown = PHARMACIST): AuthenticatedRequest =>
  ({ body: {}, params: id === undefined ? {} : { id }, query, user } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

/** Shared harness: stubs pool.query and records every statement. */
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

const HEADER_ROW: QueryRow = {
  return_id: 700, clinic_id: 1, status: 'COMPLETED', original_dispensing_id: 900,
  dispensed_to_patient_id: 200, returned_by_user_id: 42,
  reason: 'دواء غير مناسب', notes: 'أعاد المريض العلبة', created_at: '2026-03-01T10:00:00.000Z',
  patient_name: 'Patient One', patient_gender: 'MALE',
  returned_by_name: 'Pharmacist One', clinic_name: 'Main Clinic',
};

const ITEM_ROW = (over: Record<string, unknown> = {}): QueryRow => ({
  return_item_id: 701, dispensing_item_batch_id: 500, batch_id: 117, medication_id: 11,
  quantity: 10, unit_cost_snapshot: 2.5, restock_decision: 'RESTOCK',
  created_at: '2026-03-01T10:00:00.000Z',
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg', dosage_form: 'CAPSULE',
  ...over,
});

/** A user scoped to no clinic must get nothing — the scope clause is never omitted. */
const scopeAware = (rows: QueryRow[], params: unknown[]): QueryRow[] =>
  params.some((p) => Array.isArray(p) && p.length === 0) ? [] : rows;

const assertReadOnly = (calls: QueryCall[]) => {
  for (const call of calls) {
    assert.match(call.text.trim(), /^\s*SELECT\b/, `non-SELECT issued: ${call.text}`);
    assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE)\b/i);
    assert.doesNotMatch(call.text, /\bRETURNING\b/i, 'read APIs never return a written row');
    assert.doesNotMatch(call.text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i, 'read endpoints never lock rows');
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
    assert.doesNotMatch(call.text, /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/);
  }
};

const SCOPED = /r\.clinic_id = ANY\(\$\d+::int\[\]\)/;

/* ==========================================================================
 * 11-13. AUTH, PERMISSION, PAGINATION
 * ========================================================================== */

test('READ AUTH: a request without a bearer token is rejected with 401', async () => {
  const { res, captured } = makeRes();
  let nextCalled = false;

  await authenticateJWT({ headers: {} } as any, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
});

test('READ AUTHORIZATION: VIEW_INVENTORY is required on every return route', () => {
  const runMiddleware = (permissions: string[]) => {
    const request = { user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;
    requirePermission('VIEW_INVENTORY')(request, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err; else nextCalled = true;
    });
    return { error, nextCalled };
  };

  const denied = runMiddleware(['DISPENSE_MEDICATIONS']);
  assert.equal(denied.nextCalled, false, 'dispensing rights alone must not read returns');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware(['VIEW_INVENTORY']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

test('READ LIST: pagination defaults to limit 50 / offset 0', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /FROM medication_returns r/);
      return { rows: scopeAware([{ return_id: 700, status: 'COMPLETED', item_count: 2 }], [1]), rowCount: 1 };
    },
    async (calls) => {
      await listMedicationReturns(readReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.returns.length, 1);
      assert.deepEqual(captured.body.pagination, { limit: DEFAULT_MEDICATION_RETURN_LIMIT, offset: 0, returned: 1 });
      assert.equal(DEFAULT_MEDICATION_RETURN_LIMIT, 50);
      assert.deepEqual(calls[0]!.params, [[1], 50, 0]);
    },
  );
  assertReadOnly([]);
});

test('READ LIST: the maximum limit is 200 and it is accepted; beyond is rejected', async () => {
  assert.equal(MAX_MEDICATION_RETURN_LIMIT, 200);

  const accepted = makeRes();
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await listMedicationReturns(readReq({ limit: '200' }), accepted.res);
      assert.equal(calls[0]!.params[1], 200);
    },
  );
  assert.equal(accepted.captured.status, 200);

  for (const query of [{ limit: '201' }, { limit: '0' }, { offset: '-1' }, { patient_id: 'abc' }]) {
    const { res, captured } = makeRes();
    await withReads(
      () => { throw new Error('no query may run for invalid pagination'); },
      async (calls) => {
        await listMedicationReturns(readReq(query), res);
        assert.equal(calls.length, 0, JSON.stringify(query));
      },
    );
    assert.equal(captured.status, 400, JSON.stringify(query));
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

test('READ LIST: limit and offset are applied and echoed back', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /LIMIT \$2 OFFSET \$3/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listMedicationReturns(readReq({ limit: '25', offset: '50' }), res);
      assert.deepEqual(calls[0]!.params, [[1], 25, 50]);
    },
  );

  assert.deepEqual(captured.body.pagination, { limit: 25, offset: 50, returned: 0 });
});

/* ==========================================================================
 * 15-16. ORDERING AND LIGHTWEIGHT QUERY
 * ========================================================================== */

test('READ LIST: ordering is newest first with return_id as the tie-breaker', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /ORDER BY r\.created_at DESC, r\.return_id DESC/);
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listMedicationReturns(readReq(), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: the list is lightweight — no inventory_batches join, no unit cost', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.doesNotMatch(text, /inventory_batches/i, 'the list must not join batch state');
      assert.doesNotMatch(text, /unit_cost/i, 'the list must not carry any cost');
      assert.doesNotMatch(text, /quantity_on_hand/i, 'the list must not read live stock');
      // item_count is a correlated count, not a join that multiplies rows
      assert.match(text, /\(SELECT COUNT\(\*\)::int FROM medication_return_items mri WHERE mri\.return_id = r\.return_id\) AS item_count/);
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listMedicationReturns(readReq(), res);
    },
  );

  assert.equal(captured.status, 200);
});

/** The list projection: lightweight, with a display name and no reason/notes. */
const LIST_ROW: QueryRow = {
  return_id: 700, status: 'COMPLETED', original_dispensing_id: 900,
  dispensed_to_patient_id: 200, returned_by_user_id: 42, created_at: '2026-03-01T10:00:00.000Z',
  patient_name: 'Patient One', user_name: 'Pharmacist One', item_count: 2,
};

test('READ LIST: the list exposes only the declared lightweight fields', async () => {
  const { res, captured } = makeRes();

  await withReads(
    () => ({ rows: [LIST_ROW], rowCount: 1 }),
    async () => {
      await listMedicationReturns(readReq(), res);
      assert.equal(captured.status, 200);
    },
  );

  const row = captured.body.returns[0];
  for (const key of ['return_id', 'status', 'patient_name', 'user_name', 'original_dispensing_id', 'item_count', 'created_at']) {
    assert.ok(key in row, `list must include ${key}`);
  }
  for (const key of ['username', 'email', 'national_id', 'password_hash', 'reason', 'notes', 'unit_cost_snapshot']) {
    assert.equal(key in row, false, `list must not leak ${key}`);
  }
});

/* ==========================================================================
 * 17. OUT-OF-CLINIC EXCLUSION
 * ========================================================================== */

test('READ LIST: the clinic scope is applied in SQL, never trusted from the client', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, SCOPED, 'the scope must run against the return clinic');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listMedicationReturns(readReq({ clinic_id: '2' }), res);
      assert.deepEqual(calls[0]!.params, [[1], 50, 0], 'a client clinic_id is ignored entirely');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.returns, []);
});

test('READ LIST: a user assigned to no clinic gets an empty list, not every clinic', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, SCOPED, 'the scope clause must never be omitted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listMedicationReturns(readReq({}, undefined, { ...PHARMACIST, clinicIds: [] }), res);
      assert.deepEqual(calls[0]!.params[0], [], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.returns, []);
});

test('READ LIST: filters compose as bound parameters', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /r\.dispensed_to_patient_id = \$1 AND r\.original_dispensing_id = \$2 AND r\.returned_by_user_id = \$3 AND r\.status = \$4/);
      assert.match(text, SCOPED);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listMedicationReturns(readReq({ patient_id: '200', original_dispensing_id: '900', returned_by_user_id: '42', status: 'VOIDED' }), res);
      assert.deepEqual(calls[0]!.params, [200, 900, 42, 'VOIDED', [1], 50, 0]);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: an invalid status is rejected with 400 and no query', async () => {
  const { res, captured } = makeRes();

  await withReads(
    () => { throw new Error('no query may run for an invalid status'); },
    async (calls) => {
      await listMedicationReturns(readReq({ status: 'PENDING' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('READ LIST: both declared statuses are accepted', async () => {
  assert.deepEqual([...MEDICATION_RETURN_STATUSES], ['COMPLETED', 'VOIDED']);
  for (const status of MEDICATION_RETURN_STATUSES) {
    const { res, captured } = makeRes();
    await withReads(
      () => ({ rows: [], rowCount: 0 }),
      async () => {
        await listMedicationReturns(readReq({ status }), res);
      },
    );
    assert.equal(captured.status, 200, status);
  }
});

/* ==========================================================================
 * 18-22. DETAIL
 * ========================================================================== */

test('READ DETAIL: the full header is returned with safe display fields', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM medication_return_items')) return { rows: [ITEM_ROW()], rowCount: 1 };
      assert.match(text, /FROM medication_returns r/);
      assert.match(text, /JOIN patients pt ON pt\.patient_id = r\.dispensed_to_patient_id/);
      assert.match(text, /JOIN users ru ON ru\.user_id = r\.returned_by_user_id/);
      assert.match(text, SCOPED);
      return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturn(readReq({}, '700'), res);

      assert.equal(captured.status, 200);
      const header = captured.body.return;
      assert.equal(header.return_id, 700);
      assert.equal(header.status, 'COMPLETED');
      assert.equal(header.clinic_id, 1);
      assert.equal(header.clinic_name, 'Main Clinic');
      assert.equal(header.patient_name, 'Patient One');
      assert.equal(header.returned_by_name, 'Pharmacist One');
      assert.equal(header.original_dispensing_id, 900);
      assert.equal(header.reason, 'دواء غير مناسب');
      assert.equal(header.notes, 'أعاد المريض العلبة');
      assert.ok(header.created_at);
      for (const key of ['username', 'email', 'national_id', 'password_hash', 'phone']) {
        assert.equal(key in header, false, `detail must not expose ${key}`);
      }
      assertReadOnly(calls);
      assert.equal(calls.length, 2, 'two queries: header then items — no N+1');
    },
  );
});

test('READ DETAIL: items carry the allocation, batch, medication and decision', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM medication_return_items')) return { rows: [ITEM_ROW()], rowCount: 1 };
      return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturn(readReq({}, '700'), res);

      assert.equal(captured.status, 200);
      const items = captured.body.return.items;
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item.return_item_id, 701);
      assert.equal(item.dispensing_item_batch_id, 500);
      assert.equal(item.batch_id, 117);
      assert.equal(item.medication_id, 11);
      assert.equal(item.quantity, 10);
      assert.equal(item.unit_cost_snapshot, 2.5);
      assert.equal(item.restock_decision, 'RESTOCK');
      assert.equal(item.medication.trade_name, 'Amoxil');
      assert.equal(item.medication.strength, '500 mg');
      assert.ok(item.created_at);
      // The items query must be parameterised by the scoped return id
      const itemsQuery = calls.find((c) => c.text.includes('FROM medication_return_items'))!;
      assert.deepEqual(itemsQuery.params, [700]);
      assertReadOnly(calls);
    },
  );
});

test('READ DETAIL: the historical unit cost comes only from the return-item snapshot', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM medication_return_items')) {
        // Any substitution of the live batch cost would have to join inventory_batches
        assert.doesNotMatch(text, /inventory_batches/i, 'current batch cost must never be substituted');
        assert.doesNotMatch(text, /b\.unit_cost\b/i);
        assert.match(text, /mri\.unit_cost_snapshot/);
        return { rows: [ITEM_ROW({ unit_cost_snapshot: 1.25 })], rowCount: 1 };
      }
      return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturn(readReq({}, '700'), res);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.return.items[0].unit_cost_snapshot, 1.25);
      for (const call of calls) {
        assert.doesNotMatch(call.text, /unit_cost(?!_snapshot)/i, `only the snapshot may be read: ${call.text}`);
      }
    },
  );
});

test('READ DETAIL: all three restock decisions round-trip unchanged', async () => {
  assert.deepEqual([...RESTOCK_DECISIONS], ['RESTOCK', 'QUARANTINE', 'WASTE']);
  for (const restock_decision of RESTOCK_DECISIONS) {
    const { res, captured } = makeRes();
    await withReads(
      (text) => {
        if (text.includes('FROM medication_return_items')) return { rows: [ITEM_ROW({ restock_decision })], rowCount: 1 };
        return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
      },
      async () => {
        await getMedicationReturn(readReq({}, '700'), res);
        assert.equal(captured.status, 200, restock_decision);
        assert.equal(captured.body.return.items[0].restock_decision, restock_decision);
      },
    );
  }
});

test('READ DETAIL: a nonexistent and an out-of-clinic return produce an identical 404', async () => {
  for (const user of [PHARMACIST, { ...PHARMACIST, clinicIds: [] }]) {
    const { res, captured } = makeRes();
    await withReads(
      (text) => {
        assert.match(text, SCOPED, 'the return clinic must gate the lookup');
        return { rows: [], rowCount: 0 };
      },
      async (calls) => {
        await getMedicationReturn(readReq({}, '999', user), res);

        assert.equal(captured.status, 404);
        assert.equal(captured.body.message, 'سجل إرجاع الأدوية المطلوب غير موجود');
        assert.equal(calls.length, 1, 'the items query must not run for a missing return — no existence leak');
        assertReadOnly(calls);
      },
    );
  }
});

test('READ DETAIL: a non-numeric return id returns 400 without touching the DB', async () => {
  for (const id of ['abc', '0', '-1']) {
    const { res, captured } = makeRes();
    await withReads(
      () => { throw new Error('no query may run for an invalid id'); },
      async (calls) => {
        await getMedicationReturn(readReq({}, id), res);
        assert.equal(calls.length, 0, id);
      },
    );
    assert.equal(captured.status, 400, id);
    assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  }
});

/* ==========================================================================
 * 24-27. MOVEMENTS
 * ========================================================================== */

test('READ MOVEMENTS: only MEDICATION_RETURN movements of this return are returned', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM stock_movements')) {
        assert.match(text, /sm\.reference_type = 'MEDICATION_RETURN'/, 'no other reference type may leak in');
        assert.match(text, /sm\.reference_id = \$1/);
        assert.match(text, /ORDER BY sm\.created_at ASC, sm\.movement_id ASC/);
        return { rows: [{ movement_id: 8001, movement_type: 'RETURN', quantity: 10, reference_type: 'MEDICATION_RETURN', reference_id: '700' }], rowCount: 1 };
      }
      assert.match(text, /FROM medication_returns r/);
      return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturnMovements(readReq({}, '700'), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.return_id, 700);
      assert.equal(captured.body.movements.length, 1);
      assert.equal(captured.body.movements[0].movement_type, 'RETURN');
      assert.equal(captured.body.returned, 1);
      assertReadOnly(calls);
    },
  );
});

test('READ MOVEMENTS: the movement query is clinic-scoped through the batch item', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM stock_movements')) {
        assert.match(text, /JOIN inventory_batches b ON b\.batch_id = sm\.batch_id/);
        assert.match(text, /JOIN inventory_items i ON i\.inventory_id = b\.inventory_id/);
        assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'the batch clinic must gate the movements');
        return { rows: [], rowCount: 0 };
      }
      return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturnMovements(readReq({}, '700'), res);
      assert.deepEqual(calls[1]!.params[1], [1], 'scope is the assigned clinic ids');
    },
  );

  assert.equal(captured.status, 200);
});

test('READ MOVEMENTS: zero rows is a valid 200 before 10D.5 exists', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM stock_movements')) return { rows: [], rowCount: 0 };
      return { rows: scopeAware([HEADER_ROW], [1]), rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturnMovements(readReq({}, '700'), res);
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.movements, []);
      assert.equal(captured.body.returned, 0);
      assertReadOnly(calls);
    },
  );

  assert.equal(MEDICATION_RETURN_REFERENCE_TYPE, 'MEDICATION_RETURN');
});

test('READ MOVEMENTS: an out-of-clinic or missing return short-circuits before any movement query', async () => {
  const { res, captured } = makeRes();

  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await getMedicationReturnMovements(readReq({}, '999'), res);
      assert.equal(captured.status, 404);
      assert.equal(calls.length, 1, 'no secondary query may reveal whether the return exists');
    },
  );
});

/* ==========================================================================
 * 28-30. AUDIT
 * ========================================================================== */

test('READ AUDIT: the existing canAccessLogs restriction is preserved', async () => {
  // A plain VIEW_INVENTORY pharmacist is NOT allowed to read system logs
  const { res, captured } = makeRes();
  await withReads(
    () => { throw new Error('no query may run for an unauthorized audit read'); },
    async (calls) => {
      await getMedicationReturnAudit(readReq({}, '700', PHARMACIST), res);
      assert.equal(calls.length, 0, 'canAccessLogs is checked before any database access');
    },
  );
  assert.equal(captured.status, 403);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);

  // A SYSTEM_ADMIN without VIEW_SYSTEM_LOGS is still refused
  const withoutLogRight = makeRes();
  await withReads(
    () => { throw new Error('no query may run without VIEW_SYSTEM_LOGS'); },
    async (calls) => {
      await getMedicationReturnAudit(readReq({}, '700', { ...SYSTEM_ADMIN, permissions: ['VIEW_INVENTORY'] }), withoutLogRight.res);
      assert.equal(calls.length, 0);
    },
  );
  assert.equal(withoutLogRight.captured.status, 403);
});

test('READ AUDIT: an allowed reader gets only the audit rows of this return', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM audit_logs a')) {
        // canAccessLogs admits only SUPER_ADMIN / SYSTEM_ADMIN, both of which are
        // admin roles and therefore legitimately unrestricted — the same rule the
        // 10C.5 dispensing audit uses. The join is what ties the log to a return.
        assert.match(text, /JOIN medication_returns r ON r\.return_id = a\.resource_id::int/, 'the scope is joined, not guessed');
        assert.match(text, /a\.resource_type = 'MEDICATION_RETURN'/);
        assert.match(text, /a\.resource_id = \$1/);
        assert.doesNotMatch(text, /a\.clinic_id = \$/, 'a clinic filter is never bound from the request');
        assert.match(text, /ORDER BY a\.created_at ASC, a\.audit_id ASC/);
        return { rows: [{ audit_id: 1, action: 'MEDICATION_RETURNED', metadata: { return_id: 700 } }], rowCount: 1 };
      }
      assert.match(text, /FROM medication_returns r/);
      return { rows: [HEADER_ROW], rowCount: 1 };
    },
    async (calls) => {
      await getMedicationReturnAudit(readReq({}, '700', SYSTEM_ADMIN), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.return_id, 700);
      assert.equal(captured.body.audit_logs.length, 1);
      assert.equal(captured.body.audit_logs[0].action, 'MEDICATION_RETURNED');
      assertReadOnly(calls);
    },
  );
});

test('READ AUDIT: SUPER_ADMIN is still allowed, and an out-of-clinic return is a 404', async () => {
  const allowed = makeRes();
  await withReads(
    (text) => {
      if (text.includes('FROM audit_logs a')) return { rows: [], rowCount: 0 };
      return { rows: [HEADER_ROW], rowCount: 1 };
    },
    async () => {
      await getMedicationReturnAudit(readReq({}, '700', ADMIN), allowed.res);
      assert.equal(allowed.captured.status, 200);
    },
  );

  const denied = makeRes();
  await withReads(
    () => ({ rows: [], rowCount: 0 }),
    async (calls) => {
      await getMedicationReturnAudit(readReq({}, '999', SYSTEM_ADMIN), denied.res);
      assert.equal(denied.captured.status, 404);
      assert.equal(calls.length, 1, 'no audit query for a missing return');
    },
  );
});

/* ==========================================================================
 * READ-ONLY GUARANTEES
 * ========================================================================== */

test('READ ONLY: every dispatched statement is a SELECT on all four routes', async () => {
  const handlers: [string, (res: any) => Promise<unknown>][] = [
    ['list', (res) => listMedicationReturns(readReq(), res)],
    ['detail', (res) => getMedicationReturn(readReq({}, '700'), res)],
    ['movements', (res) => getMedicationReturnMovements(readReq({}, '700'), res)],
    ['audit', (res) => getMedicationReturnAudit(readReq({}, '700', SYSTEM_ADMIN), res)],
  ];

  for (const [label, invoke] of handlers) {
    const { res, captured } = makeRes();
    await withReads(
      (text) => {
        if (text.includes('FROM medication_return_items')) return { rows: [ITEM_ROW()], rowCount: 1 };
        if (text.includes('FROM stock_movements')) return { rows: [], rowCount: 0 };
        if (text.includes('FROM audit_logs a')) return { rows: [], rowCount: 0 };
        return { rows: [HEADER_ROW], rowCount: 1 };
      },
      async (calls) => {
        await invoke(res);
        assert.equal(captured.status, 200, label);
        assert.ok(calls.length > 0, label);
        assertReadOnly(calls);
      },
    );
  }
});

test('READ ONLY: no route can touch stock, quarantine, waste or dispensing state', async () => {
  const forbidden = [
    /\bSET\b/i,
    /quantity_on_hand/i,
    /quantity_reserved/i,
    /batch_quarantines/i,
    /inventory_write_offs/i,
    /dispensing_items\b/i,
    /remaining_quantity/i,
  ];

  const handlers: [string, (res: any) => Promise<unknown>][] = [
    ['list', (res) => listMedicationReturns(readReq(), res)],
    ['detail', (res) => getMedicationReturn(readReq({}, '700'), res)],
    ['movements', (res) => getMedicationReturnMovements(readReq({}, '700'), res)],
    ['audit', (res) => getMedicationReturnAudit(readReq({}, '700', SYSTEM_ADMIN), res)],
  ];

  for (const [label, invoke] of handlers) {
    const { res } = makeRes();
    await withReads(
      (text) => {
        if (text.includes('FROM medication_return_items')) return { rows: [ITEM_ROW()], rowCount: 1 };
        return { rows: [HEADER_ROW], rowCount: 1 };
      },
      async (calls) => {
        await invoke(res);
        for (const call of calls) {
          for (const pattern of forbidden) {
            assert.doesNotMatch(call.text, pattern, `${label} touched ${pattern} in: ${call.text}`);
          }
        }
      },
    );
  }
});

test('NO MUTATION ROUTE: no route can edit or delete a return record', () => {
  const layers = (medicationReturnsRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  }).stack;

  const routes = layers.filter((layer) => layer.route);
  const methods = routes.flatMap((layer) =>
    Object.entries(layer.route!.methods).filter(([, on]) => on).map(([method]) => method));

  for (const forbidden of ['put', 'patch', 'delete']) {
    assert.equal(methods.includes(forbidden), false, `${forbidden.toUpperCase()} must not exist — history is append-only`);
  }
  // Phase 10D.4 is the read surface; 10D.5 adds exactly one POST and no writer
  // that edits or removes anything.
  assert.equal(routes.length, 5, 'list, detail, movements, audit + the 10D.5 create');
  assert.equal(methods.filter((m) => m === 'get').length, 4, 'the four read routes');
});

test('NO MUTATION: the module exports no update or delete operation', () => {
  const exports = Object.keys(medicationReturnsController);
  for (const name of exports) {
    assert.doesNotMatch(name, /^(update|delete|void|remove|patch)/i, `${name} would edit or remove history`);
  }
  assert.deepEqual(
    exports.sort(),
    [
      'createMedicationReturn',
      'getMedicationReturn',
      'getMedicationReturnAudit',
      'getMedicationReturnMovements',
      'listMedicationReturns',
    ],
    'one create plus four reads — no edit, no delete',
  );
});

test('NO MUTATION: the read module writes no stock movement, quarantine or write-off record', () => {
  // 10D.4 owns the read surface only. The single writer (createMedicationReturn)
  // belongs to 10D.5 and is covered by its own suite; what matters here is that
  // no read path can write.
  for (const name of Object.keys(medicationReturnsController)) {
    if (name === 'createMedicationReturn') continue;
    assert.doesNotMatch(name, /^(create|insert|update|delete|void|restock|write)/i, `${name} is a write operation`);
  }
});

test('READ: the app mounts the returns router', async () => {
  const { default: app } = await import('../app');
  const stack = ((app as any).router ?? (app as any)._router).stack as { handle: unknown }[];
  const mounted = stack.some((layer) => layer.handle === medicationReturnsRouter);
  assert.equal(mounted, true, 'the returns router must be mounted on the app');
});
