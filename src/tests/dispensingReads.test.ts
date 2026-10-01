import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { authenticateJWT, requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  listDispensings,
  getDispensing,
  getDispensingMovements,
  getDispensingAudit,
} from '../modules/inventory/dispensingReads.controller';
import { DEFAULT_DISPENSING_LIMIT, MAX_DISPENSING_LIMIT } from '../validations/dispensingRead.validation';

/* ==========================================================================
 * Phase 10C.5 — Dispensing read & audit API
 * Every path must be SELECT-only, clinic-scoped, and leak nothing out of scope.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_PRESCRIPTIONS', 'VIEW_INVENTORY', 'DISPENSE_MEDICATIONS'], clinicIds: [1],
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

const HEADER_ROW: QueryRow = {
  dispensing_id: 900, prescription_id: 100, visit_id: 55, patient_id: 200, clinic_id: 1,
  status: 'COMPLETED', notes: 'ok', created_at: '2026-03-01T10:00:00.000Z',
  voided_at: null, voided_by_user_id: null, void_reason: null,
  patient_name: 'Patient One', patient_gender: 'MALE',
  dispensed_by_name: 'Pharmacist One', voided_by_name: null, clinic_name: 'Main Clinic',
};

const ITEM_ROW = (over: Record<string, unknown> = {}): QueryRow => ({
  dispensing_item_id: 901, prescription_item_id: 300, medication_id: 11, inventory_item_id: 5,
  prescribed_quantity: 30, dispensed_quantity: 30, remaining_quantity: 0, uom: 'TABLET', cycle_index: 0,
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg', dosage_form: 'CAPSULE',
  dispensing_item_batch_id: 500, batch_id: 117, allocated_quantity: 30,
  unit_cost_snapshot: 2.5, expiry_date_snapshot: '2027-01-31', lot_number: 'LOT-A', ...over,
});

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

const scopeAware = (rows: QueryRow[], params: unknown[]): QueryRow[] =>
  params.some((p) => Array.isArray(p) && p.length === 0) ? [] : rows;

const assertReadOnly = (calls: QueryCall[]) => {
  for (const call of calls) {
    assert.match(call.text.trim(), /^\s*SELECT\b/, `non-SELECT issued: ${call.text}`);
    assert.doesNotMatch(call.text, /^\s*(INSERT|UPDATE|DELETE)\b/i);
    assert.doesNotMatch(call.text, /FOR\s+(NO\s+KEY\s+)?UPDATE/i, 'read endpoints never lock rows');
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
    assert.doesNotMatch(call.text, /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/);
  }
};

/* ==========================================================================
 * LIST
 * ========================================================================== */

test('READ LIST: an authorized caller gets clinic-scoped dispensings', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text, params) => {
      assert.match(text, /FROM dispensings d/);
      assert.match(text, /d\.clinic_id = ANY\(\$1::int\[\]\)/);
      return { rows: scopeAware([{ dispensing_id: 900, status: 'COMPLETED', item_count: 2, cycle_index_max: 0 }], params), rowCount: 1 };
    },
    async (calls) => {
      await listDispensings(readReq(), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.dispensings.length, 1);
      assert.deepEqual(captured.body.pagination, { limit: DEFAULT_DISPENSING_LIMIT, offset: 0, returned: 1 });
      assert.deepEqual(calls[0]!.params, [[1], DEFAULT_DISPENSING_LIMIT, 0]);
    },
  );
  assertReadOnly([]);
});

test('READ LIST: ordering is newest first with dispensing_id as the tie-breaker', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /ORDER BY d\.created_at DESC, d\.dispensing_id DESC/);
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listDispensings(readReq(), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: the list does not load batch allocations', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.doesNotMatch(text, /dispensing_item_batches/, 'the list must stay lightweight');
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listDispensings(readReq(), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: out-of-clinic rows are excluded', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /d\.clinic_id = ANY\(\$1::int\[\]\)/, 'the scope clause is never omitted');
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listDispensings(readReq({}, undefined, { ...PHARMACIST, clinicIds: [] }), res);
      assert.deepEqual(calls[0]!.params[0], [], 'empty scope denies by default');
    },
  );

  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.dispensings, []);
});

test('READ LIST: filters are applied as parameters', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /d\.prescription_id = \$1/);
      assert.match(text, /d\.patient_id = \$2/);
      assert.match(text, /d\.status = \$3/);
      assert.match(text, /d\.dispensed_by_user_id = \$4/);
      assert.match(text, /ci\.cycle_index = \$5/);
      assert.match(text, /d\.created_at >= \$6::date/);
      assert.match(text, /d\.created_at < \(\$7::date/);
      assert.match(text, /d\.clinic_id = ANY\(\$8::int\[\]\)/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listDispensings(
        readReq({
          prescription_id: '100', patient_id: '200', status: 'COMPLETED', dispensed_by_user_id: '42',
          cycle_index: '1', date_from: '2026-01-01', date_to: '2026-03-31',
        }),
        res,
      );
      assert.deepEqual(calls[0]!.params, [100, 200, 'COMPLETED', 42, 1, '2026-01-01', '2026-03-31', [1], DEFAULT_DISPENSING_LIMIT, 0]);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: limit and offset are applied and echoed', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /LIMIT \$2 OFFSET \$3/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listDispensings(readReq({ limit: '25', offset: '10' }), res);
      assert.deepEqual(calls[0]!.params, [[1], 25, 10]);
    },
  );

  assert.deepEqual(captured.body.pagination, { limit: 25, offset: 10, returned: 0 });
});

test('READ LIST: the maximum limit is accepted and one above it is rejected', async () => {
  const ok = makeRes();
  await withReads(
    (text, params) => {
      assert.equal(params[1], MAX_DISPENSING_LIMIT);
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listDispensings(readReq({ limit: String(MAX_DISPENSING_LIMIT) }), ok.res);
    },
  );
  assert.equal(ok.captured.status, 200);

  for (const query of [
    { limit: String(MAX_DISPENSING_LIMIT + 1) },
    { limit: '0' },
    { offset: '-1' },
    { status: 'UNKNOWN' },
    { prescription_id: 'abc' },
    { date_from: '01-01-2026' },
    { date_from: '2026-05-01', date_to: '2026-01-01' },
  ]) {
    const bad = makeRes();
    await withReads(
      () => { throw new Error('no query may run for an invalid parameter'); },
      async (calls) => {
        await listDispensings(readReq(query), bad.res);
        assert.equal(calls.length, 0, JSON.stringify(query));
      },
    );
    assert.equal(bad.captured.status, 400, JSON.stringify(query));
  }
});

test('READ LIST: a client-supplied clinic_id is ignored entirely', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.doesNotMatch(text, /clinic_id = \$\d+/, 'no client clinic filter may be bound');
      assert.match(text, /d\.clinic_id = ANY\(\$\d+::int\[\]\)/);
      return { rows: [], rowCount: 0 };
    },
    async (calls) => {
      await listDispensings(readReq({ clinic_id: '2' }), res);
      assert.deepEqual(calls[0]!.params, [[1], DEFAULT_DISPENSING_LIMIT, 0], 'the clinic_id is ignored');
    },
  );

  assert.equal(captured.status, 200);
});

test('READ LIST: no ordering parameter can be injected by the client', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.match(text, /ORDER BY d\.created_at DESC, d\.dispensing_id DESC/);
      return { rows: [], rowCount: 0 };
    },
    async () => {
      await listDispensings(readReq({ order: 'created_at; DROP TABLE dispensings' }), res);
    },
  );

  assert.equal(captured.status, 200, 'unknown parameters are ignored, never interpolated');
});

/* ==========================================================================
 * DETAIL
 * ========================================================================== */

test('READ DETAIL: returns the header with items, cycles and batch allocations', async () => {
  const { res, captured } = makeRes();
  let calls: QueryCall[] = [];

  await withReads(
    (text, params) => {
      if (text.includes('LEFT JOIN dispensing_item_batches')) {
        return {
          rows: [
            ITEM_ROW(),
            ITEM_ROW({ dispensing_item_batch_id: 501, batch_id: 118, allocated_quantity: 12, lot_number: 'LOT-B', unit_cost_snapshot: 3.5, expiry_date_snapshot: '2027-06-30' }),
          ],
          rowCount: 2,
        };
      }
      assert.match(text, /d\.dispensing_id = \$1/);
      assert.match(text, /d\.clinic_id = ANY\(\$2::int\[\]\)/);
      void params;
      return { rows: scopeAware([HEADER_ROW], params), rowCount: 1 };
    },
    async (recorded) => {
      calls = recorded;
      await getDispensing(readReq({}, '900'), res);
    },
  );

  assert.equal(captured.status, 200);
  const d = captured.body.dispensing;
  assert.equal(d.dispensing_id, 900);
  assert.equal(d.patient_name, 'Patient One');
  assert.equal(d.dispensed_by_name, 'Pharmacist One');
  assert.equal(d.clinic_name, 'Main Clinic');
  assert.equal(d.void_reason, null);
  assert.equal(d.items.length, 1, 'both allocation rows belong to one dispensing item');
  assert.equal(d.items[0].cycle_index, 0);
  assert.equal(d.items[0].uom, 'TABLET');
  assert.equal(d.items[0].medication.trade_name, 'Amoxil');
  assert.equal(d.items[0].batches.length, 2);
  assert.deepEqual(d.items[0].batches.map((b: any) => b.allocated_quantity), [30, 12]);
  assertReadOnly(calls);
});

test('READ DETAIL: historical cost and expiry come from snapshots, not current inventory', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('LEFT JOIN dispensing_item_batches')) {
        return { rows: [ITEM_ROW()], rowCount: 1 };
      }
      return { rows: [HEADER_ROW], rowCount: 1 };
    },
    async (calls) => {
      await getDispensing(readReq({}, '900'), res);

      const itemQuery = calls.find((c) => c.text.includes('LEFT JOIN dispensing_item_batches'))!;
      assert.match(itemQuery.text, /dib\.unit_cost_snapshot/);
      assert.match(itemQuery.text, /dib\.expiry_date_snapshot/);
      assert.doesNotMatch(itemQuery.text, /JOIN inventory_batches/, 'current batch data must not be read');
      assert.doesNotMatch(itemQuery.text, /b\.unit_cost\b/);
    },
  );

  const batch = captured.body.dispensing.items[0].batches[0];
  assert.equal(batch.unit_cost_snapshot, 2.5);
  assert.equal(batch.expiry_date_snapshot, '2027-01-31');
});

test('READ DETAIL: a VOIDED dispensing remains fully readable', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('LEFT JOIN dispensing_item_batches')) return { rows: [ITEM_ROW()], rowCount: 1 };
      return { rows: [{ ...HEADER_ROW, status: 'VOIDED', voided_at: '2026-03-02T00:00:00.000Z', voided_by_user_id: 7, void_reason: 'stock error', voided_by_name: 'Doctor One' }], rowCount: 1 };
    },
    async () => {
      await getDispensing(readReq({}, '900'), res);
    },
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.dispensing.status, 'VOIDED');
  assert.equal(captured.body.dispensing.void_reason, 'stock error');
  assert.equal(captured.body.dispensing.voided_by_name, 'Doctor One');
});

test('READ DETAIL: an out-of-clinic or nonexistent dispensing returns the same 404', async () => {
  for (const id of ['77', '999']) {
    const { res, captured } = makeRes();
    await withReads(
      (text, params) => {
        assert.match(text, /d\.clinic_id = ANY\(\$2::int\[\]\)/, 'scope is enforced on the header');
        return { rows: scopeAware([], params), rowCount: 0 };
      },
      async () => {
        await getDispensing(readReq({}, id), res);
      },
    );
    assert.equal(captured.status, 404, id);
    assert.equal(captured.body.message, 'سجل الصرف المطلوب غير موجود');
  }
});

test('READ DETAIL: an invalid id returns 400 without any query', async () => {
  for (const id of ['abc', '0', '-3']) {
    const { res, captured } = makeRes();
    await withReads(
      () => { throw new Error('no query for an invalid id'); },
      async (calls) => {
        await getDispensing(readReq({}, id), res);
        assert.equal(calls.length, 0, id);
      },
    );
    assert.equal(captured.status, 400, id);
  }
});

test('READ DETAIL: no sensitive user fields are exposed', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      assert.doesNotMatch(text, /u\.username|u\.email|u\.password_hash|pt\.national_id/i);
      return { rows: [HEADER_ROW], rowCount: 0 };
    },
    async () => {
      await getDispensing(readReq({}, '900'), res);
    },
  );

  const serialised = JSON.stringify(captured.body);
  assert.doesNotMatch(serialised, /username|email|password|national_id/i);
});

/* ==========================================================================
 * MOVEMENTS
 * ========================================================================== */

test('READ MOVEMENTS: returns only movements referencing this dispensing', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM stock_movements sm')) {
        assert.match(text, /sm\.reference_id = \$1/);
        assert.match(text, /sm\.reference_type IN \('DISPENSING', 'DISPENSING_VOID'\)/);
        assert.match(text, /i\.clinic_id = ANY\(\$2::int\[\]\)/);
        return { rows: [{ movement_id: 1, batch_id: 117, movement_type: 'DISPENSE', quantity: 30, reference_type: 'DISPENSING' }], rowCount: 1 };
      }
      return { rows: [{ dispensing_id: 900, clinic_id: 1 }], rowCount: 1 };
    },
    async (calls) => {
      await getDispensingMovements(readReq({}, '900'), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.movements.length, 1);
      assert.equal(captured.body.movements[0].movement_type, 'DISPENSE');
      assertReadOnly(calls);
    },
  );
});

test('READ MOVEMENTS: an out-of-scope dispensing returns 404 before touching movements', async () => {
  const { res, captured } = makeRes();

  await withReads(
    (text) => {
      if (text.includes('FROM dispensings d')) return { rows: [], rowCount: 0 };
      throw new Error('movements must not be queried for an out-of-scope dispensing');
    },
    async (calls) => {
      await getDispensingMovements(readReq({}, '77'), res);
      assert.equal(calls.length, 1, 'only the scope check runs');
    },
  );

  assert.equal(captured.status, 404);
});

/* ==========================================================================
 * AUDIT
 * ========================================================================== */

test('READ AUDIT: system-log visibility stays restricted to SUPER_ADMIN / VIEW_SYSTEM_LOGS', async () => {
  for (const user of [
    PHARMACIST,
    { ...PHARMACIST, roleName: 'DOCTOR' },
    { ...PHARMACIST, roleName: 'SYSTEM_ADMIN', permissions: ['VIEW_PRESCRIPTIONS'] },
  ]) {
    const { res, captured } = makeRes();
    await withReads(
      () => { throw new Error('audit must not be queried for an unauthorized role'); },
      async (calls) => {
        await getDispensingAudit(readReq({}, '900', user), res);
        assert.equal(calls.length, 0, user.roleName);
      },
    );
    assert.equal(captured.status, 403, user.roleName);
    assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
  }
});

test('READ AUDIT: SUPER_ADMIN can read the audit trail for a dispensing', async () => {
  const { res, captured } = makeRes();
  const admin = { ...PHARMACIST, roleName: 'SUPER_ADMIN' };

  await withReads(
    (text) => {
      if (text.includes('FROM audit_logs a')) {
        assert.match(text, /a\.resource_type = 'DISPENSING'/);
        return { rows: [{ audit_id: 1, action: 'DISPENSED', metadata: { dispensing_id: 900 } }], rowCount: 1 };
      }
      return { rows: [{ dispensing_id: 900, clinic_id: 1 }], rowCount: 1 };
    },
    async (calls) => {
      await getDispensingAudit(readReq({}, '900', admin), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.audit_logs.length, 1);
      assert.equal(captured.body.audit_logs[0].action, 'DISPENSED');
      assertReadOnly(calls);
    },
  );
});

test('READ AUDIT: clinic scoping is defense-in-depth for the (global) log-reading roles', async () => {
  // canAccessLogs admits only SUPER_ADMIN and SYSTEM_ADMIN+VIEW_SYSTEM_LOGS, and both
  // are global admin roles, so the clinic clause is structurally present but cannot be
  // exercised by a clinic-restricted role today. The real gate is the existence check.
  const { res, captured } = makeRes();
  const admin = { ...PHARMACIST, roleName: 'SUPER_ADMIN' };

  await withReads(
    (text) => {
      if (text.includes('FROM audit_logs a')) {
        assert.match(text, /JOIN dispensings d ON d\.dispensing_id/, 'the scope is joined, not guessed');
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ dispensing_id: 900, clinic_id: 1 }], rowCount: 1 };
    },
    async () => {
      await getDispensingAudit(readReq({}, '900', admin), res);
    },
  );

  assert.equal(captured.status, 200);
});

test('READ AUDIT: SYSTEM_ADMIN with VIEW_SYSTEM_LOGS is allowed, without it is not', async () => {
  const allowed = { ...PHARMACIST, roleName: 'SYSTEM_ADMIN', permissions: ['VIEW_PRESCRIPTIONS', 'VIEW_SYSTEM_LOGS'] };
  const res1 = makeRes();
  await withReads(
    (text) => (text.includes('FROM audit_logs a') ? { rows: [], rowCount: 0 } : { rows: [{ dispensing_id: 900, clinic_id: 1 }], rowCount: 1 }),
    async () => {
      await getDispensingAudit(readReq({}, '900', allowed), res1.res);
    },
  );
  assert.equal(res1.captured.status, 200);
});

/* ==========================================================================
 * SECURITY
 * ========================================================================== */

test('READ AUTH: an unauthenticated request is rejected with 401', async () => {
  for (const op of [listDispensings, getDispensing, getDispensingMovements, getDispensingAudit]) {
    const captured = { status: 0, body: undefined as any };
    const res: any = { status(c: number) { captured.status = c; return res; }, json(p: unknown) { captured.body = p; return res; } };
    let next = false;
    await authenticateJWT({ headers: {} } as any, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(captured.status, 401, op.name);
    assert.equal(captured.body.code, ApiErrorCode.TOKEN_MISSING);
  }
});

test('READ AUTH: reads require VIEW_PRESCRIPTIONS and dispensing rights alone are not enough', () => {
  const check = (permissions: string[]) => {
    const r = { user: { userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions } } as unknown as AuthenticatedRequest;
    let error: any = null; let next = false;
    requirePermission('VIEW_PRESCRIPTIONS')(r, { status: () => ({ json: () => {} }) } as any, (e?: any) => {
      if (e) error = e; else next = true;
    });
    return { error, next };
  };

  assert.equal(check(['DISPENSE_MEDICATIONS']).next, false, 'dispensing rights must not grant history access');
  assert.equal(check(['VIEW_PRESCRIPTIONS']).next, true);
});
