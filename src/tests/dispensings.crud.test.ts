import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createDispensing, voidDispensing } from '../modules/inventory/dispensings.controller';

/* ==========================================================================
  // (note: Arabic comment removed during a re-encode; see the controller for the domain text)
 * Focus: atomicity. Every rejection path must ROLLBACK and issue no write.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE', 'VIEW_INVENTORY', 'MANAGE_INVENTORY', 'DISPENSE_MEDICATIONS'],
  clinicIds: [1],
};

const req = (body: Record<string, unknown>, user: unknown = PHARMACIST): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

/** Rejects anything that leaves the harness without a real outcome (rollback) */
interface ItemSpec {
  item_id: number;
  medication_id: number;
  prescribed_quantity: number | null;
  uom: string | null;
}

interface Scenario {
  items?: ItemSpec[];
  /** prescription_item_id -> quantity already dispensed in non-VOIDED dispensings */
  prior?: Record<number, number>;
  /** medication_id -> inventory item uom, or null = no active inventory item */
  inventoryUom?: Record<number, string | null>;
  /** medication_id -> available batch quantity (tests use inventory_id = medication_id) */
  stock?: Record<number, number>;
  /** Writes already rolled back by the transaction are not counted as leaks. */
  stock2?: number;
  failOn?: string;
  deductRowCount?: number;
  noInventory?: boolean;
}

const DEFAULT_ITEMS: ItemSpec[] = [{ item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'TABLET' }];

const makeHandler = (s: Scenario) => {
  const items = s.items ?? DEFAULT_ITEMS;
  const stock = s.stock ?? { 11: 100 };
  const uoms = s.inventoryUom ?? Object.fromEntries(items.map((i) => [i.medication_id, 'TABLET']));
  // (note: Arabic comment removed during a re-encode; see the controller for the domain text)
  const stockFor = (inventoryId: number): number => stock[inventoryId] ?? 0;

  return (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    const denied = params.some((p) => Array.isArray(p) && p.length === 0);

    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

    if (s.failOn && t.includes(s.failOn)) {
      throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
    }

  // (note: Arabic comment removed during a re-encode; see the controller for the domain text)
    if (t.startsWith('INSERT INTO dispensings')) {
      return { rows: [{ dispensing_id: 900, prescription_id: 100, clinic_id: 1, patient_id: 200, status: 'COMPLETED' }], rowCount: 1 };
    }
    if (t.startsWith('INSERT INTO dispensing_items')) {
      return { rows: [{ dispensing_item_id: 901 + Number(params[1]) }], rowCount: 1 };
    }
    if (t.startsWith('INSERT INTO dispensing_item_batches')) return { rows: [], rowCount: 1 };
    if (t.startsWith('UPDATE inventory_batches')) return { rows: [], rowCount: s.deductRowCount ?? 1 };
    if (t.startsWith('INSERT INTO stock_movements')) return { rows: [], rowCount: 1 };
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

    if (t.includes('FROM prescriptions p')) {
      if (denied) return { rows: [], rowCount: 0 };
      return { rows: [{ prescription_id: 100, patient_id: 200, clinic_id: 1 }], rowCount: 1 };
    }
    if (t.includes('FROM prescription_items pi')) {
      return {
        rows: items.map((i) => ({
          item_id: i.item_id, medication_id: i.medication_id,
          prescribed_quantity: i.prescribed_quantity, uom: i.uom, dosage: '1 x 3', repeats_count: 3,
        })),
        rowCount: items.length,
      };
    }
    if (t.includes('FROM dispensing_items di')) {
      // Since Phase 10C.4C the history is per cycle: a prior amount is an open
      // (PARTIAL) cycle 0, which is exactly what the 10C.4B scenarios describe.
      const rows = Object.entries(s.prior ?? {}).map(([id, qty]) => ({
        prescription_item_id: Number(id), cycle_index: 0, status: 'PARTIAL', dispensed_quantity: qty,
      }));
      return { rows, rowCount: rows.length };
    }
    if (t.includes('FROM inventory_items')) {
      const medicationId = Number(params[0]);
      const uom = s.noInventory ? null : uoms[medicationId] ?? null;
      if (uom === null) return { rows: [], rowCount: 0 };
      return { rows: [{ inventory_id: medicationId, uom }], rowCount: 1 };
    }
    if (t.includes('FOR UPDATE OF b')) {
      const inventoryId = Number(params[0]);
      const onHand = stockFor(inventoryId);
      if (onHand <= 0) return { rows: [], rowCount: 0 };
      const batches = [
        { batch_id: inventoryId * 10 + 7, inventory_id: inventoryId, lot_number: 'LOT-A', expiry_date: '2027-01-31', quantity_on_hand: onHand, unit_cost: 2.5 },
      ];
      if (s.stock2) {
        batches.push({ batch_id: inventoryId * 10 + 8, inventory_id: inventoryId, lot_number: 'LOT-B', expiry_date: '2027-06-30', quantity_on_hand: s.stock2, unit_cost: 3.5 });
      }
      return { rows: batches, rowCount: batches.length };
    }
    return { rows: [], rowCount: 1 };
  };
};

async function run(scenario: Scenario = {}, body: Record<string, unknown> = { prescription_id: 100 }, user?: unknown) {
  const calls: QueryCall[] = [];
  const handler = makeHandler(scenario);
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return handler(text, params);
    },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  try {
    const { res, captured } = makeRes();
    await createDispensing(req(body, user), res);

  // (note: Arabic comment removed during a re-encode; see the controller for the domain text)
    const writes = calls
      .filter((c) => !(scenario.failOn && c.text.includes(scenario.failOn)))
      .map((c) => c.text.trim())
      .filter((t) => /^(INSERT|UPDATE|DELETE)/i.test(t) && t !== 'ROLLBACK')
      .map((t) => t.split(/\s+/).slice(0, 4).join(' '));

    return {
      captured,
      calls,
      writes,
      wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
      wasCommitted: calls.some((c) => c.text === 'COMMIT'),
      writesOf: (prefix: string) => calls.filter((c) => c.text.trim().startsWith(prefix)),
      itemRows: calls.filter((c) => c.text.trim().startsWith('INSERT INTO dispensing_items')),
      batchRows: calls.filter((c) => c.text.trim().startsWith('INSERT INTO dispensing_item_batches')),
      movements: calls.filter((c) => c.text.trim().startsWith('INSERT INTO stock_movements')),
    };
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

const GOOD: Scenario = {};

/* ==========================================================================
 * 1-2. FULL STOCK -> COMPLETED, INSUFFICIENT -> PARTIAL
 * ========================================================================== */

test('DISPENSE: full stock produces COMPLETED with exact arithmetic', async () => {
  const { captured, itemRows } = await run({ stock: { 11: 100 } });

  assert.equal(captured.status, 201);
  assert.equal(captured.body.dispensing.status, 'COMPLETED');
  assert.equal(captured.body.dispensing.items[0].dispensed_quantity, 30);
  assert.equal(captured.body.dispensing.items[0].remaining_quantity, 0);
  // prescribed = previously + dispensed + remaining
  assert.deepEqual(itemRows[0]!.params.slice(4, 8), [30, 30, 0, 'TABLET']);
});

test('DISPENSE: insufficient stock produces PARTIAL with the available amount only', async () => {
  const { captured, itemRows } = await run({ stock: { 11: 12 } });

  assert.equal(captured.status, 201);
  assert.equal(captured.body.dispensing.status, 'PARTIAL');
  assert.equal(captured.body.dispensing.items[0].dispensed_quantity, 12);
  assert.equal(captured.body.dispensing.items[0].remaining_quantity, 18, '30 prescribed - 12 dispensed');
  assert.deepEqual(itemRows[0]!.params.slice(4, 7), [30, 12, 18]);
});

/* ==========================================================================
 * 3. NOTHING TO DISPENSE -> 409, ZERO WRITES
 * ========================================================================== */

test('DISPENSE: zero stock across all items returns 409 and writes nothing', async () => {
  const { captured, writes, wasRolledBack, wasCommitted } = await run({ stock: { 11: 0 } });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.reason, 'NOTHING_TO_DISPENSE');
  assert.equal(writes.length, 0, 'no header, items, movements or audit');
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

/* ==========================================================================
 * 4. MULTI-ITEM MIXED AVAILABILITY
 * ========================================================================== */

test('DISPENSE: a multi-item prescription with mixed availability is PARTIAL', async () => {
  const { captured, itemRows } = await run({
    items: [
      { item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'TABLET' },
      { item_id: 301, medication_id: 12, prescribed_quantity: 20, uom: 'ML' },
      { item_id: 302, medication_id: 13, prescribed_quantity: 5, uom: 'TABLET' },
    ],
    inventoryUom: { 11: 'TABLET', 12: 'ML', 13: 'TABLET' },
    stock: { 11: 100, 12: 0, 13: 2 },
  });

  assert.equal(captured.status, 201);
  assert.equal(captured.body.dispensing.status, 'PARTIAL');
  assert.equal(itemRows.length, 3, 'every prescription item gets a row');

  const byItem = new Map(itemRows.map((r) => [r.params[1], r.params.slice(4, 7)]));
  assert.deepEqual(byItem.get(300), [30, 30, 0], 'fully dispensed');
  assert.deepEqual(byItem.get(301), [20, 0, 20], 'no stock: dispensed 0, remaining preserved');
  assert.deepEqual(byItem.get(302), [5, 2, 3], 'partially dispensed');
});

/* ==========================================================================
 * 5-6. REPEATED PARTIAL DISPENSING
 * ========================================================================== */

test('DISPENSE: a second request continues a PARTIAL prescription and completes it', async () => {
  const { captured, itemRows } = await run({ stock: { 11: 100 }, prior: { 300: 12 } });

  assert.equal(captured.status, 201);
  assert.equal(captured.body.dispensing.status, 'COMPLETED', 'all items reach zero remaining');
  assert.equal(captured.body.dispensing.items[0].previously_dispensed_quantity, 12);
  assert.equal(captured.body.dispensing.items[0].dispensed_quantity, 18, 'only the remaining 18');
  // prescribed = prior(12) + current(18) + remaining(0)
  assert.deepEqual(itemRows[0]!.params.slice(4, 7), [30, 18, 0]);
});

test('DISPENSE: a fully completed prescription still returns 409', async () => {
  const { captured, writes, wasRolledBack } = await run({ stock: { 11: 100 }, prior: { 300: 30 } });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN, 'a completed prescription cannot be dispensed again');
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

/* ==========================================================================
 * 7. VOIDED EXCLUDED FROM REMAINING
 * ========================================================================== */

test('DISPENSE: VOIDED dispensings are excluded from the remaining calculation', async () => {
  // The prior query itself filters VOIDED; assert the SQL keeps that guarantee.
  const { calls } = await run({ stock: { 11: 100 } });
  const prior = calls.find((c) => c.text.includes('FROM dispensing_items di'))!;
  assert.match(prior.text, /d\.status <> 'VOIDED'/, 'voided dispensing must not count as dispensed');
});

test('DISPENSE: remaining is computed from persisted records, not the previous status', async () => {
  const { captured } = await run({ stock: { 11: 100 }, prior: { 300: 25 } });
  assert.equal(captured.body.dispensing.items[0].dispensed_quantity, 5, '30 - 25, regardless of any status flag');
});

/* ==========================================================================
 * 8-10. NO INFERENCE, UOM, NO OVER-DISPENSE
 * ========================================================================== */

test('DISPENSE: quantity is never inferred from dosage or repeats_count', async () => {
  const { itemRows } = await run({ items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'TABLET' }] });
  const prescriptionItems = itemRows[0]!.params;
  assert.equal(prescriptionItems[4], 30, 'the stored prescribed_quantity is used verbatim');
  assert.equal(prescriptionItems[7], 'TABLET');
});

test('DISPENSE: UOM mismatch is still rejected with zero writes', async () => {
  const { captured, writes, wasRolledBack } = await run({
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'ML' }],
    inventoryUom: { 11: 'TABLET' },
  });

  assert.equal(captured.status, 400);
  assert.equal(captured.body.prescription_uom, 'ML');
  assert.equal(captured.body.inventory_uom, 'TABLET');
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

test('DISPENSE: never more than the remaining quantity is allocated', async () => {
  const { captured } = await run({ stock: { 11: 500 }, prior: { 300: 25 } });
  assert.equal(captured.body.dispensing.items[0].dispensed_quantity, 5);
  assert.equal(captured.body.dispensing.items[0].remaining_quantity, 0);
});

/* ==========================================================================
 * 11. NO ZERO-QUANTITY ALLOCATION ROWS
 * ========================================================================== */

test('DISPENSE: no allocation, deduction or movement is created for a zero quantity', async () => {
  const { itemRows, batchRows, movements, writes } = await run({
    items: [
      { item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'TABLET' },
      { item_id: 301, medication_id: 12, prescribed_quantity: 20, uom: 'ML' },
    ],
    inventoryUom: { 11: 'TABLET', 12: 'ML' },
    stock: { 11: 100, 12: 0 },
  });

  assert.equal(itemRows.length, 2, 'both items are recorded');
  assert.equal(batchRows.length, 1, 'only the dispensed item gets an allocation row');
  assert.equal(movements.length, 1);
  assert.ok(writes.some((w) => w.startsWith('INSERT INTO dispensing_items')));
  for (const row of batchRows) assert.ok(Number(row.params[2]) > 0, 'allocation quantity is always positive');
});

/* ==========================================================================
 * 12-14. FEFO, DEDUCTION, MOVEMENTS
 * ========================================================================== */

test('DISPENSE: FEFO spreads the allocation across batches in expiry order', async () => {
  const { captured, batchRows, movements } = await run({ stock: { 11: 5 }, stock2: 7 });

  assert.equal(captured.body.dispensing.status, 'PARTIAL');
  assert.equal(captured.body.dispensing.items[0].dispensed_quantity, 12, '5 + 7');
  assert.deepEqual(batchRows.map((r) => r.params.slice(1, 3)), [[117, 5], [118, 7]]);
  assert.equal(movements.length, 2, 'one DISPENSE movement per batch');
});

test('DISPENSE: stock is deducted exactly once per allocation with a guard', async () => {
  const { calls } = await run({ stock: { 11: 100 } });
  const deductions = calls.filter((c) => c.text.includes('quantity_on_hand = quantity_on_hand - $1'));
  assert.equal(deductions.length, 1);
  assert.deepEqual(deductions[0]!.params, [30, 117]);
  assert.match(deductions[0]!.text, /AND quantity_on_hand >= \$1/);
});

test('DISPENSE: DISPENSE movements stay positive and reference the new dispensing', async () => {
  const { movements } = await run({ stock: { 11: 100 } });
  assert.match(movements[0]!.text, /VALUES \(\$1, 'DISPENSE', \$2, 'DISPENSING', \$3, \$4, \$5\)/);
  assert.equal(movements[0]!.params[1], 30);
  assert.equal(movements[0]!.params[2], '900');
  assert.equal(movements[0]!.params[3], PHARMACIST.userId);
});

/* ==========================================================================
 * 15-16. STATUS + AUDIT
 * ========================================================================== */

test('DISPENSE: the server chooses the status and never accepts one from the client', async () => {
  const { captured } = await run({ stock: { 11: 12 } }, { prescription_id: 100, status: 'COMPLETED' });
  assert.equal(captured.body.dispensing.status, 'PARTIAL', 'a client-supplied status is ignored');

  const full = await run({ stock: { 11: 100 } });
  assert.equal(full.captured.body.dispensing.status, 'COMPLETED');
});

test('DISPENSE: the audit records the resulting status and per-item arithmetic', async () => {
  const { calls } = await run({ stock: { 11: 12 } });
  const audit = calls.find((c) => c.text.trim().startsWith('INSERT INTO audit_logs'))!;
  const metadata = JSON.parse(String(audit.params[3]));

  assert.equal(audit.params[2], '900');
  assert.equal(metadata.status, 'PARTIAL');
  assert.equal(metadata.prescription_id, 100);
  assert.equal(metadata.patient_id, 200);
  assert.equal(metadata.pharmacist_user_id, PHARMACIST.userId);
  assert.equal(metadata.items[0].prescribed_quantity, 30);
  assert.equal(metadata.items[0].dispensed_quantity, 12);
  assert.equal(metadata.items[0].remaining_quantity, 18);
  assert.equal(metadata.items[0].uom, 'TABLET');
  assert.equal(metadata.items[0].batches[0].quantity, 12);
  assert.equal(metadata.items[0].batches[0].unit_cost_snapshot, 2.5);
});

/* ==========================================================================
 * 17-20. ROLLBACK
 * ========================================================================== */

test('ROLLBACK: a header failure writes nothing', async () => {
  const { captured, writes, wasRolledBack, wasCommitted } = await run({ ...GOOD, failOn: 'INSERT INTO dispensings' });
  assert.equal(captured.status, 500);
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('ROLLBACK: a batch deduction failure rolls back the whole dispensing', async () => {
  const { captured, movements, wasRolledBack, wasCommitted } = await run({ failOn: 'quantity_on_hand = quantity_on_hand -' });
  assert.equal(captured.status, 500);
  assert.equal(movements.length, 0, 'no movement after a failed deduction');
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('ROLLBACK: a movement failure undoes the deduction', async () => {
  const { captured, wasRolledBack, wasCommitted } = await run({ failOn: 'INSERT INTO stock_movements' });
  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('ROLLBACK: an audit failure rolls back the entire dispensing', async () => {
  const { captured, wasRolledBack, wasCommitted } = await run({ failOn: 'INSERT INTO audit_logs' });
  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

/* ==========================================================================
 * 21. ISOLATION
 * ========================================================================== */

test('DISPENSE: an out-of-clinic prescription returns 404 with zero writes', async () => {
  const { captured, writes, wasRolledBack } = await run({ stock: { 11: 100 } }, { prescription_id: 100 }, { ...PHARMACIST, clinicIds: [] });
  assert.equal(captured.status, 404);
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

/* ==========================================================================
 * 22. CONCURRENCY LOCK
 * ========================================================================== */

test('CONCURRENCY: prescription items are locked early so remaining cannot be computed twice', async () => {
  const { calls } = await run({ stock: { 11: 100 } });
  const itemsIndex = calls.findIndex((c) => c.text.includes('FROM prescription_items pi'));
  const firstWrite = calls.findIndex((c) => /^(INSERT|UPDATE)/i.test(c.text.trim()));

  assert.ok(itemsIndex > 0, 'prescription items are read');
  assert.match(calls[itemsIndex]!.text, /FOR UPDATE OF pi/, 'they must be locked');
  assert.ok(firstWrite > itemsIndex, 'nothing is written before the lock');
});

/* ==========================================================================
 * PERMISSION + SAFETY (unchanged from 10C.3)
 * ========================================================================== */

test('DISPENSE: DISPENSE_MEDICATIONS is required', () => {
  const runMw = (permissions: string[]) => {
    const r = { user: { userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions } } as unknown as AuthenticatedRequest;
    let error: any = null; let next = false;
    requirePermission('DISPENSE_MEDICATIONS')(r, { status: () => ({ json: () => {} }) } as any, (e?: any) => {
      if (e) error = e; else next = true;
    });
    return { error, next };
  };

  const denied = runMw(['VIEW_PRESCRIPTIONS', 'MANAGE_INVENTORY']);
  assert.equal(denied.next, false, 'inventory permissions must not imply dispensing rights');
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);
  assert.equal(runMw(['DISPENSE_MEDICATIONS']).next, true);
});

test('DISPENSE: the pharmacist identity comes from the session, never the body', async () => {
  const { calls } = await run({ stock: { 11: 100 } }, { prescription_id: 100, performed_by_user_id: 999 });
  assert.equal(calls.find((c) => c.text.includes('INSERT INTO dispensings'))!.params[1], PHARMACIST.userId);
  assert.equal(calls.find((c) => c.text.trim().startsWith('INSERT INTO stock_movements'))!.params[3], PHARMACIST.userId);
});

test('DISPENSE: an invalid request body returns 400 before any query', async () => {
  for (const body of [{}, { prescription_id: 0 }, { prescription_id: 'abc' }]) {
    const { captured, calls, wasRolledBack } = await run({ stock: { 11: 100 } }, body);
    assert.equal(captured.status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
    assert.equal(wasRolledBack, false);
  }
});

test('DISPENSE: a historical item with NULL quantity or UOM writes nothing', async () => {
  for (const item of [
    { item_id: 300, medication_id: 11, prescribed_quantity: null, uom: 'TABLET' },
    { item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: null },
  ]) {
    const { captured, writes, wasRolledBack } = await run({ items: [item], stock: { 11: 100 } });
    assert.equal(captured.status, 400);
    assert.equal(writes.length, 0);
    assert.equal(wasRolledBack, true);
  }
});

test('DISPENSE: a missing active inventory item performs zero writes', async () => {
  const { captured, writes, wasRolledBack } = await run({ stock: { 11: 100 }, noInventory: true });
  assert.equal(captured.status, 404);
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

test('DISPENSE: quantity_reserved is never written', async () => {
  const { calls } = await run({ stock: { 11: 100 } });
  for (const call of calls) {
    if (/^UPDATE/i.test(call.text.trim())) assert.doesNotMatch(call.text, /quantity_reserved/);
  }
});

test('DISPENSE: a defensive deduction matching no row aborts the transaction', async () => {
  const { captured, movements, wasRolledBack, wasCommitted } = await run({ stock: { 11: 100 }, deductRowCount: 0 });
  assert.equal(captured.status, 409);
  assert.equal(movements.length, 0);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('DISPENSE: internal SQL errors are never exposed to the client', async () => {
  const { captured } = await run({ failOn: 'INSERT INTO audit_logs' });
  assert.equal(captured.status, 500);
  assert.equal(captured.body.code, ApiErrorCode.INTERNAL_ERROR);
  assert.doesNotMatch(JSON.stringify(captured.body), /XX000|simulated|INSERT INTO/);
});

/* ==========================================================================
 * Phase 10C.4A - Void a dispensing and restore exactly what it deducted
 * Restored quantities come from dispensing_item_batches only.
 * ========================================================================== */

interface VoidScenario {
  status?: 'COMPLETED' | 'VOIDED' | 'PARTIAL';
  allocations?: { batch_id: number; quantity: number; dispensing_item_id: number }[];
  noBatches?: boolean;
  restoreRowCount?: number;
  failOn?: string;
}

const voidReq = (body: Record<string, unknown> = {}, id = '900', user: unknown = PHARMACIST) =>
  ({ body, params: { id }, query: {}, user } as unknown as AuthenticatedRequest);

async function runVoid(scenario: VoidScenario = {}, body: Record<string, unknown> = {}, id = '900') {
  const status = scenario.status ?? 'COMPLETED';
  const allocations = scenario.allocations ?? [{ dispensing_item_id: 901, batch_id: 7, quantity: 30 }];
  const calls: QueryCall[] = [];

  const handler = (text: string): MockResult => {
    const t = text.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (scenario.failOn && t.includes(scenario.failOn)) {
      throw Object.assign(new Error(`simulated failure in ${scenario.failOn}`), { code: 'XX000' });
    }
    if (t.startsWith('SELECT d.dispensing_id')) {
      if (calls[0]!.params.some((p) => Array.isArray(p) && p.length === 0)) return { rows: [], rowCount: 0 };
      return { rows: [{ dispensing_id: 900, prescription_id: 100, patient_id: 200, clinic_id: 1, status }], rowCount: 1 };
    }
    if (t.includes('FROM dispensing_item_batches dib')) {
      return {
        rows: allocations.map((a, i) => ({
          dispensing_item_batch_id: 5000 + i, dispensing_item_id: a.dispensing_item_id, batch_id: a.batch_id,
          quantity: a.quantity, unit_cost_snapshot: 2.5, expiry_date_snapshot: '2027-01-31',
          prescription_item_id: 300 + i, medication_id: 11 + i, dispensing_uom: 'TABLET',
        })),
        rowCount: allocations.length,
      };
    }
    if (t.startsWith('SELECT b.batch_id FROM inventory_batches b')) {
      return { rows: [], rowCount: scenario.noBatches ? 0 : new Set(allocations.map((a) => a.batch_id)).size };
    }
    if (t.startsWith('UPDATE inventory_batches')) return { rows: [], rowCount: scenario.restoreRowCount ?? 1 };
    if (t.startsWith('UPDATE dispensings SET status')) {
      return { rows: [{ dispensing_id: 900, status: 'VOIDED', voided_at: 'now', void_reason: body.reason ?? null }], rowCount: 1 };
    }
    if (t.startsWith('INSERT INTO stock_movements')) return { rows: [], rowCount: 1 };
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return handler(text);
    },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  try {
    const { res, captured } = makeRes();
    await voidDispensing(voidReq(body, id), res);
    const writes = calls
      .filter((c) => !(scenario.failOn && c.text.includes(scenario.failOn)))
      .map((c) => c.text.trim())
      .filter((t) => /^(INSERT|UPDATE|DELETE)/i.test(t) && t !== 'ROLLBACK');
    return {
      captured,
      calls,
      writes,
      wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
      wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    };
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

test('VOID: a successful void restores stock and marks the record VOIDED', async () => {
  const { captured, wasCommitted, wasRolledBack } = await runVoid({}, { reason: 'void reason' });

  assert.equal(captured.status, 200);
  assert.equal(captured.body.dispensing.status, 'VOIDED');
  assert.equal(wasCommitted, true);
  assert.equal(wasRolledBack, false);
});

test('VOID: stock is restored by exactly the recorded allocation quantity', async () => {
  const { calls } = await runVoid();

  const restore = calls.find((c) => c.text.includes('quantity_on_hand = quantity_on_hand + $1'))!;
  assert.deepEqual(restore.params, [30, 7], 'restores the recorded allocation, nothing derived');
  assert.match(restore.text, /AND quantity_on_hand \+ \$1 <= 999999999\.999/);
});

test('VOID: one RETURN movement per allocation, referencing the void', async () => {
  const { calls } = await runVoid();

  const movements = calls.filter((c) => c.text.includes('INSERT INTO stock_movements'));
  assert.equal(movements.length, 1);
  assert.match(movements[0]!.text, /VALUES \(\$1, 'RETURN', \$2, 'DISPENSING_VOID', \$3, \$4, \$5\)/);
  assert.equal(movements[0]!.params[1], 30, 'the movement quantity is positive');
  assert.equal(movements[0]!.params[2], '900', 'reference_id is the dispensing id');
  assert.equal(movements[0]!.params[3], PHARMACIST.userId, 'the performer is the session user');
});

test('VOID: status, voided_at, voided_by_user_id and reason are persisted together', async () => {
  const { calls } = await runVoid({}, { reason: 'void reason' });

  const update = calls.find((c) => c.text.includes("SET status = 'VOIDED'"))!;
  assert.match(update.text, /voided_at = NOW\(\), voided_by_user_id = \$1, void_reason = \$2/);
  assert.match(update.text, /WHERE dispensing_id = \$3 AND status = 'COMPLETED'/);
  assert.equal(update.params[0], PHARMACIST.userId);
  assert.equal(update.params[1], 'void reason');
});

test('VOID: the audit record captures the void, items and restored quantities', async () => {
  const { calls } = await runVoid({}, { reason: 'void reason' });

  const audit = calls.find((c) => c.text.includes('INSERT INTO audit_logs'))!;
  const metadata = JSON.parse(String(audit.params[3]));
  assert.equal(audit.params[1], 1, 'audit carries the dispensing clinic');
  assert.equal(audit.params[2], '900');
  assert.equal(metadata.dispensing_id, 900);
  assert.equal(metadata.prescription_id, 100);
  assert.equal(metadata.patient_id, 200);
  assert.equal(metadata.voided_by_user_id, PHARMACIST.userId);
  assert.equal(metadata.reason, 'void reason');
  assert.equal(metadata.items[0].batch_id, 7);
  assert.equal(metadata.items[0].restored_quantity, 30);
});

test('VOID: multiple items and batches restore correctly', async () => {
  const { captured, calls } = await runVoid({
    allocations: [
      { dispensing_item_id: 901, batch_id: 7, quantity: 5 },
      { dispensing_item_id: 901, batch_id: 8, quantity: 7 },
      { dispensing_item_id: 902, batch_id: 9, quantity: 3 },
    ],
  });

  assert.equal(captured.status, 200);
  assert.equal(captured.body.dispensing.restored_items, 3);
  assert.deepEqual(captured.body.dispensing.restored_batches, [7, 8, 9]);

  const restores = calls.filter((c) => c.text.includes('quantity_on_hand = quantity_on_hand + $1'));
  assert.deepEqual(restores.map((c) => c.params), [[5, 7], [7, 8], [3, 9]]);
  assert.equal(calls.filter((c) => c.text.includes('INSERT INTO stock_movements')).length, 3);
});

test('VOID: batches are locked in batch_id order to avoid deadlocks', async () => {
  const { calls } = await runVoid({
    allocations: [
      { dispensing_item_id: 901, batch_id: 9, quantity: 1 },
      { dispensing_item_id: 901, batch_id: 7, quantity: 1 },
      { dispensing_item_id: 902, batch_id: 8, quantity: 1 },
    ],
  });

  const lock = calls.find((c) => c.text.includes('SELECT b.batch_id FROM inventory_batches b'))!;
  assert.match(lock.text, /ORDER BY b\.batch_id ASC/);
  assert.match(lock.text, /FOR UPDATE OF b/);
  assert.doesNotMatch(lock.text, /SKIP\s+LOCKED/i);
  assert.deepEqual(lock.params, [[7, 8, 9]], 'locked in sorted order, not allocation order');
});

test('VOID: the header is locked before anything is read or written', async () => {
  const { calls } = await runVoid();

  const headerLock = calls.findIndex((c) => c.text.includes('SELECT d.dispensing_id'));
  const firstWrite = calls.findIndex((c) => /^(INSERT|UPDATE)/i.test(c.text.trim()));
  assert.ok(headerLock > 0, 'the header is locked');
  assert.match(calls[headerLock]!.text, /FOR UPDATE OF d/);
  assert.ok(firstWrite > headerLock, 'nothing is written before the header lock');
});

test('VOID: the header status update is guarded so a double void cannot restore twice', async () => {
  const { calls } = await runVoid();
  const update = calls.find((c) => c.text.includes("SET status = 'VOIDED'"))!;
  assert.match(update.text, /AND status = 'COMPLETED'/);
});

test('VOID: an already VOIDED dispensing is rejected with zero writes', async () => {
  const { captured, writes, wasRolledBack } = await runVoid({ status: 'VOIDED' });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.status, 'VOIDED');
  assert.equal(writes.length, 0, 'no stock restoration, no movement, no audit');
  assert.equal(wasRolledBack, true);
});

test('VOID: a PARTIAL dispensing is rejected with zero writes', async () => {
  const { captured, writes, wasRolledBack } = await runVoid({ status: 'PARTIAL' });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.status, 'PARTIAL', 'the partial lifecycle is a later subphase');
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

test('VOID: an out-of-clinic dispensing returns 404 with zero writes', async () => {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 } as MockResult;
    },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  try {
    await voidDispensing(voidReq({}, '900', { ...PHARMACIST, clinicIds: [] }), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(captured.status, 404);
  assert.equal(calls.filter((c) => /^(INSERT|UPDATE)/i.test(c.text.trim())).length, 0);
});

test('VOID: a dispensing with no allocations cannot be voided', async () => {
  const { captured, writes, wasRolledBack } = await runVoid({ allocations: [] });
  assert.equal(captured.status, 409);
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

test('VOID: a failed batch lock aborts before any restoration', async () => {
  const { captured, writes, wasRolledBack } = await runVoid({ noBatches: true });
  assert.equal(captured.status, 409);
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

test('VOID: a defensive restore that matches no row rolls back everything', async () => {
  const { captured, writes, wasRolledBack, wasCommitted } = await runVoid({ restoreRowCount: 0 });

  assert.equal(captured.status, 409);
  assert.equal(writes.some((w) => w.startsWith('INSERT INTO stock_movements')), false);
  assert.equal(writes.some((w) => w.startsWith('INSERT INTO audit_logs')), false);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('VOID: a batch restore failure rolls back the whole void', async () => {
  const { captured, wasRolledBack, wasCommitted } = await runVoid({ failOn: 'quantity_on_hand = quantity_on_hand +' });

  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('VOID: a movement insertion failure rolls back the restored stock', async () => {
  const { captured, wasRolledBack, wasCommitted } = await runVoid({ failOn: 'INSERT INTO stock_movements' });

  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true, 'the restore already applied must be undone');
  assert.equal(wasCommitted, false);
});

test('VOID: an audit failure rolls back the entire void', async () => {
  const { captured, wasRolledBack, wasCommitted } = await runVoid({ failOn: 'INSERT INTO audit_logs' });

  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true, 'restored stock, movements and status are all undone');
  assert.equal(wasCommitted, false);
});

test('VOID: quantity_reserved and prescription data are never touched', async () => {
  const { calls } = await runVoid();

  for (const call of calls) {
    assert.doesNotMatch(call.text, /quantity_reserved/);
    assert.doesNotMatch(call.text, /UPDATE prescription_items/i);
    assert.doesNotMatch(call.text, /UPDATE medications/i);
  }
});

test('VOID: an invalid dispensing id or body is rejected before any query', async () => {
  for (const id of ['abc', '0', '-1']) {
    const { res, captured } = makeRes();
    let connected = false;
    (pool as unknown as { connect: unknown }).connect = async () => { connected = true; return {} as never; };
    try {
      await voidDispensing(voidReq({}, id), res);
    } finally {
      (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
    }
    assert.equal(captured.status, 400, id);
    assert.equal(connected, false, 'no transaction is opened for an invalid id');
  }

  const { captured } = await runVoid({}, { reason: 'x'.repeat(2000) });
  assert.equal(captured.status, 400, 'an over-long reason is rejected');
});
