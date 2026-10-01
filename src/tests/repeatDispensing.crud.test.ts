import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createDispensing } from '../modules/inventory/dispensings.controller';

/* ==========================================================================
 * Phase 10C.4C — Repeat dispensing cycles
 * max_cycles INCLUDES the initial dispensing: 1 = no repeats.
 * No authorization row => implicit max_cycles = 1. repeats_count is never read.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

const DOCTOR = {
  userId: 7, roleId: 2, clinicId: 1, roleName: 'DOCTOR',
  permissions: ['VIEW_PRESCRIPTIONS', 'CREATE_PRESCRIPTION'], clinicIds: [1],
};

const req = (body: Record<string, unknown> = {}, user: unknown = DOCTOR): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

interface HistoryRow {
  cycle_index: number;
  status: string;
  dispensed: number;
}

interface Scenario {
  prescribed?: number;
  maxCycles?: number | null;   // null = no authorization row
  authStatus?: 'ACTIVE' | 'CANCELLED';
  history?: HistoryRow[];      // persisted, non-VOIDED cycles
  stock?: number;
  uom?: string | null;
  failOn?: string;
  user?: unknown;
  nullPrescribed?: boolean;
}

async function run(scenario: Scenario = {}, user: unknown = DOCTOR) {
  const prescribed = scenario.nullPrescribed ? null : scenario.prescribed ?? 30;
  const stock = scenario.stock ?? 100;
  const history = scenario.history ?? [];
  const calls: QueryCall[] = [];

  const handler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();

    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (scenario.failOn && t.includes(scenario.failOn)) {
      throw Object.assign(new Error('simulated failure'), { code: 'XX000' });
    }

    if (t.startsWith('INSERT INTO dispensings')) return { rows: [{ dispensing_id: 900, status: 'COMPLETED' }], rowCount: 1 };
    if (t.startsWith('INSERT INTO dispensing_items')) return { rows: [{ dispensing_item_id: 901 }], rowCount: 1 };
    if (t.startsWith('INSERT INTO dispensing_item_batches')) return { rows: [], rowCount: 1 };
    if (t.startsWith('UPDATE inventory_batches')) return { rows: [], rowCount: 1 };
    if (t.startsWith('INSERT INTO stock_movements')) return { rows: [], rowCount: 1 };
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

    if (t.includes('FROM prescriptions p')) {
      if (params.some((p) => Array.isArray(p) && p.length === 0)) return { rows: [], rowCount: 0 };
      return { rows: [{ prescription_id: 100, patient_id: 200, clinic_id: 1 }], rowCount: 1 };
    }
    if (t.includes('FROM prescription_items pi')) {
      return {
        rows: [{ item_id: 300, medication_id: 11, prescribed_quantity: prescribed, uom: scenario.uom === undefined ? 'TABLET' : scenario.uom, dosage: '1 x 3', repeats_count: 5 }],
        rowCount: 1,
      };
    }
    // تفويض التكرار
    if (t.includes('FROM prescription_repeat_authorizations ra')) {
      if (scenario.maxCycles === null || scenario.maxCycles === undefined) return { rows: [], rowCount: 0 };
      return { rows: [{ repeat_auth_id: 1, prescription_item_id: 300, max_cycles: scenario.maxCycles, status: scenario.authStatus ?? 'ACTIVE' }], rowCount: 1 };
    }
    // تاريخ الصرف لكل بند/دورة
    if (t.includes('FROM dispensing_items di')) {
      return { rows: history.map((h) => ({ prescription_item_id: 300, cycle_index: h.cycle_index, status: h.status, dispensed_quantity: h.dispensed })), rowCount: history.length };
    }
    if (t.includes('FROM inventory_items')) return { rows: [{ inventory_id: 5, uom: 'TABLET' }], rowCount: 1 };
    if (t.includes('FOR UPDATE OF b')) {
      if (stock <= 0) return { rows: [], rowCount: 0 };
      return { rows: [{ batch_id: 117, inventory_id: 5, lot_number: 'LOT-A', expiry_date: '2027-01-31', quantity_on_hand: stock, unit_cost: 2.5 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return handler(text, params); },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  try {
    const { res, captured } = makeRes();
    await createDispensing(req({ prescription_id: 100 }, user), res);
    return {
      captured,
      calls,
      wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
      wasCommitted: calls.some((c) => c.text === 'COMMIT'),
      writes: calls.filter((c) => /^(INSERT|UPDATE)/i.test(c.text.trim()) && !c.text.trim().startsWith('UPDATE inventory_batches')),
      itemInsert: calls.find((c) => c.text.trim().startsWith('INSERT INTO dispensing_items')),
      audit: calls.find((c) => c.text.trim().startsWith('INSERT INTO audit_logs')),
    };
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

const cycleOf = (r: { itemInsert: QueryCall | undefined }): number => Number(r.itemInsert!.params[8]);

/* ==========================================================================
 * 1-2. max_cycles semantics
 * ========================================================================== */

test('REPEAT: no authorization row means implicit max_cycles = 1', async () => {
  const r = await run({ maxCycles: null });
  assert.equal(r.captured.status, 201);
  assert.match(r.calls.find((c) => c.text.includes('FROM prescription_repeat_authorizations'))!.text, /FOR UPDATE OF ra/);
  assert.equal(cycleOf(r), 0, 'initial cycle is 0 without any authorization');
});

test('REPEAT: an explicit max_cycles = 2 allows a second cycle', async () => {
  const r = await run({
    maxCycles: 2,
    history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }],
  });
  assert.equal(r.captured.status, 201);
  assert.equal(cycleOf(r), 1, 'the second cycle uses cycle_index = 1');
});

/* ==========================================================================
 * 3-5. cycle numbering
 * ========================================================================== */

test('REPEAT: the initial cycle always uses cycle_index = 0', async () => {
  const r = await run({ maxCycles: 3 });
  assert.equal(cycleOf(r), 0);
  assert.equal(r.captured.body.dispensing.items[0].cycle_index, 0);
});

test('REPEAT: a completed initial cycle consumes one cycle and blocks a third by default', async () => {
  const blocked = await run({ maxCycles: null, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  assert.equal(blocked.captured.status, 409, 'implicit max_cycles = 1 forbids a repeat');
  assert.equal(blocked.writes.length, 0, 'zero writes on a blocked repeat');

  const allowed = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  assert.equal(allowed.captured.status, 201);
  assert.equal(cycleOf(allowed), 1);
});

test('REPEAT: a third cycle is refused when max_cycles = 2', async () => {
  const r = await run({
    maxCycles: 2,
    history: [
      { cycle_index: 0, status: 'COMPLETED', dispensed: 30 },
      { cycle_index: 1, status: 'COMPLETED', dispensed: 30 },
    ],
  });
  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.cycles_used, 2);
  assert.equal(r.captured.body.max_cycles, 2);
  assert.equal(r.writes.length, 0);
});

/* ==========================================================================
 * 6-7. PARTIAL is a continuation, not a cycle consumer
 * ========================================================================== */

test('REPEAT: a partial cycle does not consume a cycle and is continued later', async () => {
  const partial = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'PARTIAL', dispensed: 12 }] });
  assert.equal(partial.captured.status, 201);
  assert.equal(cycleOf(partial), 0, 'the open cycle continues at index 0');
  assert.equal(partial.captured.body.dispensing.items[0].dispensed_quantity, 18, 'only the 30 - 12 remaining');
  assert.equal(partial.captured.body.dispensing.items[0].remaining_quantity, 0);
  assert.equal(partial.captured.body.dispensing.status, 'COMPLETED');
});

test('REPEAT: a partial cycle is never treated as completed when counting cycles', async () => {
  const r = await run({ maxCycles: 1, history: [{ cycle_index: 0, status: 'PARTIAL', dispensed: 10 }] });
  assert.equal(r.captured.status, 201, 'max_cycles = 1 still permits finishing its own open cycle');
  assert.equal(cycleOf(r), 0);
});

/* ==========================================================================
 * 8-10. VOIDED / repeats_count
 * ========================================================================== */

test('REPEAT: a VOIDED cycle is excluded from the history query and does not consume a cycle', async () => {
  const r = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  const history = r.calls.find((c) => c.text.includes('FROM dispensing_items di'))!;
  assert.match(history.text, /d\.status <> 'VOIDED'/, 'voided dispensings must not be counted');
});

test('REPEAT: historical repeats_count has no effect on eligibility', async () => {
  // repeats_count = 5 is returned by the mock for every scenario
  const withHighRepeatsNoAuth = await run({ maxCycles: null, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  assert.equal(withHighRepeatsNoAuth.captured.status, 409, 'repeats_count = 5 must not enable a repeat');
  assert.equal(withHighRepeatsNoAuth.writes.length, 0);
});

test('REPEAT: repeats_count is never read by the dispensing code', async () => {
  const r = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /repeats_count/i, 'the dispensing transaction must not reference repeats_count');
  }
});

test('REPEAT: a CANCELLED authorization behaves as max_cycles = 1', async () => {
  const r = await run({
    maxCycles: 3,
    authStatus: 'CANCELLED',
    history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }],
  });
  assert.equal(r.captured.status, 409, 'a cancelled authorization must not permit repeats');
  assert.equal(r.writes.length, 0);
});

/* ==========================================================================
 * 11-12. authorization is clinic-scoped / no implicit rows
 * ========================================================================== */

test('REPEAT: an out-of-clinic prescription returns 404 with zero writes', async () => {
  const r = await run({ maxCycles: 5 }, { ...DOCTOR, clinicIds: [] });
  assert.equal(r.captured.status, 404);
  assert.equal(r.writes.length, 0);
  assert.equal(r.wasRolledBack, true);
});

test('REPEAT: a dispensing never creates a repeat authorization row', async () => {
  const r = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /INSERT INTO prescription_repeat_authorizations/,
      'dispensing must never authorize its own repeats');
  }
});

/* ==========================================================================
 * 13-14. remaining is cycle-scoped
 * ========================================================================== */

test('REPEAT: remaining is scoped to the current cycle, not the whole prescription', async () => {
  // cycle 0 was fully dispensed; the new cycle starts from the full prescribed quantity
  const r = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'COMPLETED', dispensed: 30 }] });
  assert.equal(r.captured.body.dispensing.items[0].prescribed_quantity, 30);
  assert.equal(r.captured.body.dispensing.items[0].previously_dispensed_quantity, 0,
    'a new cycle starts fresh rather than subtracting prior cycles');
  assert.equal(r.captured.body.dispensing.items[0].dispensed_quantity, 30);
  assert.equal(r.captured.body.dispensing.items[0].remaining_quantity, 0);
});

test('REPEAT: the cycle-scoped history query is the only source of remaining', async () => {
  const r = await run({ maxCycles: 2, history: [{ cycle_index: 0, status: 'PARTIAL', dispensed: 7 }] });
  const history = r.calls.find((c) => c.text.includes('FROM dispensing_items di'))!;
  assert.match(history.text, /di\.cycle_index/, 'history must be read per cycle');
  assert.deepEqual(history.params, [[300]]);
});

/* ==========================================================================
 * 15-18. audit + rollback
 * ========================================================================== */

test('REPEAT: the audit records cycle information for each item', async () => {
  const r = await run({ maxCycles: 3, history: [{ cycle_index: 0, status: 'PARTIAL', dispensed: 5 }] });
  const metadata = JSON.parse(String(r.audit!.params[3]));
  const item = metadata.items[0];

  assert.equal(item.prescription_item_id, 300);
  assert.equal(item.cycle_index, 0);
  assert.equal(item.max_cycles, 3);
  assert.equal(item.cycle_state, 'COMPLETED', 'the open cycle is completed by this dispensing');
  assert.equal(item.prescribed_quantity, 30);
  assert.equal(item.dispensed_quantity, 25);
  assert.equal(item.remaining_quantity, 0);
  assert.equal(item.uom, 'TABLET');
});

test('REPEAT: a failure during the dispensing rolls back completely', async () => {
  const r = await run({ maxCycles: 2, failOn: 'INSERT INTO stock_movements' });
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('REPEAT: zero allocatable stock still rolls back with no record', async () => {
  const r = await run({ maxCycles: 2, stock: 0 });
  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.reason, 'NOTHING_TO_DISPENSE');
  assert.equal(r.writes.length, 0);
  assert.equal(r.wasRolledBack, true);
});

test('REPEAT: UOM mismatch is still refused before any cycle work', async () => {
  const r = await run({ maxCycles: 2, uom: 'ML' });
  assert.equal(r.captured.status, 400);
  assert.equal(r.writes.length, 0);
});

test('REPEAT: a historical item with NULL quantity is still refused', async () => {
  const r = await run({ maxCycles: 2, nullPrescribed: true });
  assert.equal(r.captured.status, 400);
  assert.equal(r.writes.length, 0);
});

/* ==========================================================================
 * 19. permission
 * ========================================================================== */

test('REPEAT: authorization uses the existing CREATE_PRESCRIPTION permission', () => {
  const runMw = (permissions: string[]) => {
    const r = { user: { userId: 7, roleId: 2, clinicId: 1, roleName: 'DOCTOR', permissions } } as unknown as AuthenticatedRequest;
    let error: any = null; let next = false;
    requirePermission('CREATE_PRESCRIPTION')(r, { status: () => ({ json: () => {} }) } as any, (e?: any) => {
      if (e) error = e; else next = true;
    });
    return { error, next };
  };

  assert.equal(runMw(['VIEW_PRESCRIPTIONS']).next, false, 'viewing must not allow authorizing refills');
  assert.equal(runMw(['CREATE_PRESCRIPTION']).next, true);
  assert.equal(runMw(['DISPENSE_MEDICATIONS']).next, false, 'dispensing must not authorize refills');
});
