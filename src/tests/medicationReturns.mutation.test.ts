import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createMedicationReturn } from '../modules/inventory/medicationReturns.controller';
import medicationReturnsRouter from '../modules/inventory/medicationReturns.routes';
import {
  FORBIDDEN_RETURN_FIELDS,
  FORBIDDEN_RETURN_ITEM_FIELDS,
} from '../validations/medicationReturn.validation';

/* ==========================================================================
 * Phase 10D.5 — Patient medication return execution
 *
 * Only pool.connect() is stubbed; the whole operation must run in ONE
 * transaction on ONE client, and no write may escape a ROLLBACK.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface Allocation {
  dispensing_item_batch_id: number;
  batch_id: number;
  quantity: number;
  unit_cost_snapshot: string | null;
  medication_id?: number;
  inventory_item_id?: number;
  /** Phase 10E.7/10E.8 — the reversal and credit key off these */
  dispensing_id?: number;
  dispensing_item_id?: number;
}

interface Batch {
  batch_id: number;
  inventory_id?: number;
  is_active?: boolean;
  quantity_on_hand?: number;
  quantity_reserved?: number;
}

interface Scenario {
  /** false = the dispensing does not resolve inside the caller's clinic scope */
  dispensingFound?: boolean;
  dispensingStatus?: string;
  allocations?: Allocation[];
  batches?: Batch[];
  /** allocation_id -> already returned quantity (COMPLETED returns) */
  priorReturned?: Record<number, number>;
  /** batch_id -> an active quarantine already exists */
  quarantined?: number[];
  updateRowCount?: number;
  failOn?: string;
  noUser?: boolean;
  /** Phase 10E.8 — the charged invoice line per dispensing item */
  chargeLines?: ChargeLine[];
  /** Phase 10E.8 — already credited quantity per dispensing item */
  credited?: Array<{ dispensing_item_id: number; quantity: number }>;
}

interface ChargeLine {
  dispensing_item_id: number;
  charged_quantity: string;
  unit_price_snapshot: string;
  /** null = a pre-10E.8 line with no medication discount snapshot */
  medication_discount_value: string | null;
  net_amount: string;
  paid_amount: string;
  payment_type?: string;
  currency_code?: string;
}

const DEFAULT_ALLOCATION: Allocation = {
  dispensing_item_batch_id: 500, batch_id: 117, quantity: 30, unit_cost_snapshot: '2.5000',
};

const makeHandler = (s: Scenario) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

  if (s.failOn && t.includes(s.failOn)) {
    throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
  }

  // 1) lock the dispensing (clinic-scoped, VOIDED allowed through so we can reject it)
  if (t.startsWith('SELECT d.dispensing_id')) {
    if (s.dispensingFound === false) return { rows: [], rowCount: 0 };
    return {
      rows: [{ dispensing_id: 900, clinic_id: 1, patient_id: 200, status: s.dispensingStatus ?? 'COMPLETED' }],
      rowCount: 1,
    };
  }

  // 2) lock the requested allocations
  if (t.includes('FROM dispensing_item_batches dib') && t.includes('FOR UPDATE OF dib')) {
    const requested = (params[0] as number[]) ?? [];
    const rows = (s.allocations ?? [DEFAULT_ALLOCATION])
      .filter((a) => requested.includes(a.dispensing_item_batch_id))
      .map((a) => ({
        dispensing_item_batch_id: a.dispensing_item_batch_id,
        batch_id: a.batch_id,
        quantity: a.quantity,
        unit_cost_snapshot: a.unit_cost_snapshot,
        medication_id: a.medication_id ?? 11,
        inventory_item_id: a.inventory_item_id ?? 5,
        // Phase 10E.7/10E.8: the reversal and the credit both key off these.
        dispensing_id: a.dispensing_id ?? 100,
        dispensing_item_id: a.dispensing_item_id ?? 501,
      }));
    return { rows, rowCount: rows.length };
  }

  // 3) previously returned quantities
  if (t.includes('FROM medication_return_items mri') && t.includes('mr.status')) {
    const rows = Object.entries(s.priorReturned ?? {}).map(([id, qty]) => ({
      dispensing_item_batch_id: Number(id), returned_quantity: qty,
    }));
    return { rows, rowCount: rows.length };
  }

  // 4) lock the affected batches, deterministically ordered
  if (t.includes('FROM inventory_batches b') && t.includes('FOR UPDATE OF b')) {
    const wanted = (params[0] as number[]) ?? [];
    const rows = (s.batches ?? [{ batch_id: 117, inventory_id: 5, is_active: true, quantity_on_hand: 40, quantity_reserved: 5 }])
      .filter((b) => wanted.includes(b.batch_id))
      .map((b) => ({
        batch_id: b.batch_id,
        inventory_id: b.inventory_id ?? 5,
        is_active: b.is_active ?? true,
        quantity_on_hand: b.quantity_on_hand ?? 40,
        quantity_reserved: b.quantity_reserved ?? 5,
      }))
      .sort((a, b) => a.batch_id - b.batch_id);
    return { rows, rowCount: rows.length };
  }

  // 5) header
  if (t.startsWith('INSERT INTO medication_returns')) {
    return {
      rows: [{
        return_id: 700, clinic_id: params[0], returned_by_user_id: params[1],
        dispensed_to_patient_id: params[2], original_dispensing_id: params[3],
        status: 'COMPLETED', reason: params[4], notes: params[5],
        created_at: '2026-03-01T10:00:00.000Z',
      }],
      rowCount: 1,
    };
  }

  // 6) items
  if (t.startsWith('INSERT INTO medication_return_items')) {
    return {
      rows: [{
        return_item_id: 701 + Number(params[1]),
        dispensing_item_batch_id: params[1], batch_id: params[2], medication_id: params[3],
        quantity: params[4], unit_cost_snapshot: params[5], restock_decision: params[6],
        created_at: '2026-03-01T10:00:00.000Z',
      }],
      rowCount: 1,
    };
  }

  // 7b) Phase 10E.7 — financial reversal. The production statement computes the
  // amount in SQL, so the stub mirrors that: params are
  // [return_item_id, allocation, dispensing, item, clinic, qty, cost, decision].
  if (t.startsWith('INSERT INTO medication_return_reversals')) {
    const quantity = Number(params[5]);
    const cost = Number(params[6]);
    const decision = String(params[7]);
    const amount = quantity * cost;
    return {
      rows: [{
        reversal_id: 7500 + reversals, return_item_id: params[0],
        dispensing_item_batch_id: params[1], dispensing_id: params[2], dispensing_item_id: params[3],
        clinic_id: params[4], returned_quantity: params[5], unit_cost_snapshot: params[6],
        cogs_reversal_amount: String(amount),
        loss_amount: decision === 'WASTE' ? String(amount) : '0',
        restock_decision: decision, created_at: '2026-03-01T10:00:00.000Z',
      }],
      rowCount: 1,
    };
  }

  // 3a) Phase 10E.8 — the charged invoice line per dispensing item. Absent by
  // default, which is the "not invoiced yet" case: no revenue, so no credit.
  if (t.includes('FROM invoice_items ii')) {
    const rows = (s.chargeLines ?? []).map((line) => ({
      dispensing_item_id: line.dispensing_item_id,
      item_id: 7100 + line.dispensing_item_id, invoice_id: 7200 + line.dispensing_item_id,
      dispensed_quantity: line.charged_quantity, unit_price_snapshot: line.unit_price_snapshot,
      medication_discount_value: line.medication_discount_value,
      net_amount: line.net_amount, paid_amount: line.paid_amount,
      payment_type: line.payment_type ?? 'CASH', currency_code: line.currency_code ?? 'JOD',
    }));
    return { rows, rowCount: rows.length };
  }

  if (t.includes('FROM medication_return_credits')) {
    const ids = (params[0] as number[]) ?? [];
    const rows = (s.credited ?? [])
      .filter((c) => ids.includes(c.dispensing_item_id))
      .map((c) => ({ dispensing_item_id: c.dispensing_item_id, credited_quantity: c.quantity }));
    return { rows, rowCount: rows.length };
  }

  if (t.includes('INSERT INTO medication_return_credits')) {
    // Params follow the query: $4 quantity, $5 price, $6 discount,
    // $11 invoice net, $12 invoice paid, $13 payment type, $14 currency.
    const quantity = Number(params[3]);
    const price = Number(params[4]);
    const discount = Number(params[5]);
    const invoiceNet = Number(params[10]);
    const invoicePaid = Number(params[11]);
    const paymentType = String(params[12]);
    const gross = quantity * price;
    const net = gross - Math.round(gross * discount) / 100;
    const applied = Math.min(net, Math.max(invoiceNet - invoicePaid, 0));
    const refundDue =
      paymentType === 'CASH' || paymentType === 'CARD' ? net - applied : 0;
    return {
      rows: [{
        credit_id: 7800 + credits, return_item_id: params[0], reversal_id: params[1],
        dispensing_id: params[2], dispensing_item_id: params[6],
        invoice_id: params[7], invoice_item_id: params[8], clinic_id: params[9],
        returned_quantity: params[3], unit_price_snapshot: params[4],
        medication_discount_value: params[5], gross_amount: String(gross),
        net_amount: String(net), credit_amount: String(net),
        applied_to_outstanding: String(applied), refund_due_amount: String(refundDue),
        invoice_net_amount: params[10], invoice_paid_amount: params[11],
        currency_code: params[13], created_at: '2026-03-01T10:00:00.000Z',
      }],
      rowCount: 1,
    };
  }

  // 7) guarded batch update
  if (t.startsWith('UPDATE inventory_batches')) {
    return {
      rows: [{ batch_id: params[1], quantity_on_hand: params[0], quantity_reserved: params[2] }],
      rowCount: s.updateRowCount ?? 1,
    };
  }

  // 8) quarantine lookup
  if (t.includes('FROM batch_quarantines bq')) {
    const target = Number(params[0]);
    const rows = (s.quarantined ?? []).includes(target) ? [{ '?column?': 1 }] : [];
    return { rows, rowCount: rows.length };
  }
  if (t.startsWith('INSERT INTO batch_quarantines')) return { rows: [], rowCount: 1 };

  // 9) movement
  if (t.startsWith('INSERT INTO stock_movements')) {
    return {
      rows: [{
        movement_id: 8000 + movements, batch_id: params[0], movement_type: params[1],
        quantity: params[2], reference_type: 'MEDICATION_RETURN', reference_id: params[3],
        performed_by_user_id: params[4], notes: params[5],
        created_at: '2026-03-01T10:00:00.000Z',
      }],
      rowCount: 1,
    };
  }

  // 10) audit
  if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

  throw new Error(`Unexpected query: ${text}`);
};

let movements = 0;
let reversals = 0;
let credits = 0;

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY', 'DISPENSE_MEDICATIONS'], clinicIds: [1],
};

const VIEWER = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY'], clinicIds: [1],
};

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const req = (body: Record<string, unknown>, user: unknown = PHARMACIST): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user } as unknown as AuthenticatedRequest);

interface Run {
  captured: { status: number; body: any };
  calls: QueryCall[];
  wasCommitted: boolean;
  wasRolledBack: boolean;
  wasReleased: boolean;
}

async function run(scenario: Scenario = {}, body: Record<string, unknown> = {}, user: unknown = PHARMACIST): Promise<Run> {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = makeHandler(scenario);
  movements = 0;
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
    await createMedicationReturn(req(body, scenario.noUser ? {} : user), res);
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
}

const VALID_BODY = {
  dispensing_id: 900,
  reason: 'دواء غير مناسب للمريض',
  notes: 'أعاد المريض العلبة',
  items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK' }],
};

const find = (calls: QueryCall[], needle: string) => calls.find((c) => c.text.includes(needle));
const findHeader = (calls: QueryCall[]) => find(calls, 'INSERT INTO medication_returns');
const findItems = (calls: QueryCall[]) => calls.filter((c) => c.text.includes('INSERT INTO medication_return_items'));
const findUpdate = (calls: QueryCall[]) => calls.filter((c) => c.text.includes('UPDATE inventory_batches'));
const findQuarantine = (calls: QueryCall[]) => calls.filter((c) => c.text.includes('batch_quarantines'));
const findMovement = (calls: QueryCall[]) => calls.filter((c) => c.text.includes('INSERT INTO stock_movements'));
const findAudit = (calls: QueryCall[]) => calls.filter((c) => c.text.includes('INSERT INTO audit_logs'));
const findDispensingLock = (calls: QueryCall[]) => find(calls, 'SELECT d.dispensing_id');
const findAllocationLock = (calls: QueryCall[]) => find(calls, 'FOR UPDATE OF dib');
const findPrior = (calls: QueryCall[]) => find(calls, 'mr.status');
const findReversal = (calls: QueryCall[]) =>
  calls.filter((c) => c.text.includes('INSERT INTO medication_return_reversals'));
const findBatchLock = (calls: QueryCall[]) => find(calls, 'FOR UPDATE OF b');

const writes = (calls: QueryCall[]) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text.trim()));

/* ==========================================================================
 * 1-3. RESTOCK / WASTE / QUARANTINE SUCCESS
 * ========================================================================== */

test('RESTOCK: a valid return commits and returns stock to the original batch', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(r.wasCommitted, true);
  assert.equal(r.wasRolledBack, false);
  assert.equal(findUpdate(r.calls).length, 1, 'exactly one batch is credited');
  assert.equal(findUpdate(r.calls)[0]!.params[0], 50, '40 on hand + 10 returned');
  assert.equal(findUpdate(r.calls)[0]!.params[1], 117, 'the original batch is credited');
  assert.equal(findMovement(r.calls).length, 1);
  assert.equal(findQuarantine(r.calls).length, 0, 'RESTOCK never quarantines');
});

test('WASTE: a valid waste return commits and restores no stock', async () => {
  const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'WASTE' }] });

  assert.equal(r.captured.status, 201);
  assert.equal(r.wasCommitted, true);
  assert.equal(findUpdate(r.calls).length, 0, 'WASTE must not touch any batch quantity');
  assert.equal(findQuarantine(r.calls).length, 0, 'WASTE must not quarantine');
  assert.equal(findMovement(r.calls).length, 1, 'but it is still recorded as a movement');
  assert.equal(findMovement(r.calls)[0]!.params[1], 'WASTE');
  assert.equal(findMovement(r.calls)[0]!.params[0], 117, 'recorded against the original allocation batch');
});

test('QUARANTINE: a valid quarantine return credits the batch and isolates it', async () => {
  const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'QUARANTINE' }] });

  assert.equal(r.captured.status, 201);
  assert.equal(r.wasCommitted, true);
  assert.equal(findUpdate(r.calls).length, 1, 'the stock physically returns to the batch');
  assert.equal(findQuarantine(r.calls).length, 2, 'an existence check and an insert');
  assert.match(findQuarantine(r.calls)[1]!.text, /INSERT INTO batch_quarantines/);
  assert.equal(findMovement(r.calls)[0]!.params[1], 'RETURN', 'a quarantine is still a stock return');
});

test('QUARANTINE: an already active quarantine is reused, not duplicated', async () => {
  const r = await run({ quarantined: [117] }, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'QUARANTINE' }] });

  assert.equal(r.captured.status, 201);
  assert.equal(findQuarantine(r.calls).filter((c) => c.text.includes('INSERT INTO batch_quarantines')).length, 0);
  assert.equal(findQuarantine(r.calls).filter((c) => c.text.includes('SELECT 1 FROM batch_quarantines')).length, 1);
  assert.equal(r.wasCommitted, true);
});

test('QUARANTINE: the batch stays FEFO-ineligible because an active quarantine exists', async () => {
  // FEFO eligibility is the existing predicate: is_active AND on hand > 0 AND
  // not expired AND NOT EXISTS an unreleased quarantine. The last clause is what
  // this operation is responsible for.
  const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'QUARANTINE' }] });

  assert.equal(r.captured.status, 201);
  const insert = findQuarantine(r.calls).find((c) => c.text.includes('INSERT INTO batch_quarantines'))!;
  assert.equal(insert.params[0], 117, 'the quarantine is on the credited batch');
  assert.equal(insert.params[1], 1, 'clinic is server-derived');
  assert.match(String(insert.params[2]), /إرجاع دواء من مريض/, 'the quarantine records why');
  assert.equal(insert.params[3], PHARMACIST.userId);
  // Nothing in this operation releases a quarantine
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /released_at\s*=\s*NOW/i, 'a return must never release a quarantine');
  }
});

/* ==========================================================================
 * 4-5. PARTIAL AND CUMULATIVE RETURNS
 * ========================================================================== */

test('PARTIAL: returning part of an allocation succeeds and the remainder stays returnable', async () => {
  const r = await run({ allocations: [{ ...DEFAULT_ALLOCATION, quantity: 30 }] }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(findItems(r.calls)[0]!.params[4], 10);
  assert.deepEqual(findPrior(r.calls)!.params[0], [500], 'the prior-return sum is always consulted');
  assert.equal(r.wasCommitted, true);
});

test('CUMULATIVE: returning more than the allocation minus what was already returned is refused', async () => {
  // allocation 30, already returned 25 -> only 5 remain
  const r = await run({ priorReturned: { 500: 25 } }, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 6, restock_decision: 'RESTOCK' }] });

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.returnable_quantity, 5);
  assert.equal(r.captured.body.previously_returned_quantity, 25);
  assert.equal(r.captured.body.allocated_quantity, 30);
  assert.equal(writes(r.calls).length, 0, 'no write escapes the cumulative check');
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('CUMULATIVE: returning exactly the remaining quantity succeeds', async () => {
  const r = await run({ priorReturned: { 500: 25 } }, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 5, restock_decision: 'RESTOCK' }] });

  assert.equal(r.captured.status, 201);
  assert.equal(r.wasCommitted, true);
});

test('CUMULATIVE: a VOIDED prior return does not consume the allocation', async () => {
  // The prior-return sum filters status = 'COMPLETED'; a VOIDED return returns nothing
  const r = await run({ priorReturned: { 500: 0 } }, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 30, restock_decision: 'RESTOCK' }] });

  assert.equal(r.captured.status, 201);
  assert.match(findPrior(r.calls)!.text, /mr\.status = 'COMPLETED'/, 'only completed returns consume the allocation');
});

/* ==========================================================================
 * 6-7. VOIDED / MISSING / OUT-OF-CLINIC DISPENSING
 * ========================================================================== */

test('VOIDED: a voided dispensing is rejected with 409 and writes nothing', async () => {
  const r = await run({ dispensingStatus: 'VOIDED' }, VALID_BODY);

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(writes(r.calls).length, 0);
  assert.equal(findAllocationLock(r.calls), undefined, 'the allocations are never even locked');
  assert.equal(r.wasRolledBack, true);
});

test('PARTIAL dispensing may still be returned from', async () => {
  const r = await run({ dispensingStatus: 'PARTIAL' }, VALID_BODY);

  assert.equal(r.captured.status, 201, 'only VOIDED is refused');
  assert.equal(r.wasCommitted, true);
});

test('NOT FOUND: a nonexistent and an out-of-clinic dispensing return an identical 404', async () => {
  const a = await run({ dispensingFound: false }, VALID_BODY);
  const b = await run({ dispensingFound: false }, VALID_BODY);

  assert.equal(a.captured.status, 404);
  assert.deepEqual(a.captured.body, b.captured.body);
  assert.equal(a.captured.body.message, 'سجل الصرف المطلوب غير موجود');
  for (const r of [a, b]) {
    assert.equal(writes(r.calls).length, 0, 'zero writes');
    assert.equal(findAllocationLock(r.calls), undefined, 'no secondary query may reveal existence');
    assert.equal(r.wasRolledBack, true);
  }
});

/* ==========================================================================
 * 8-10. BATCH TARGETING
 * ========================================================================== */

test('RESTOCK TARGET: the original batch is used when no substitute is requested', async () => {
  const r = await run({ batches: [{ batch_id: 117, inventory_id: 5, is_active: true, quantity_on_hand: 40, quantity_reserved: 5 }] }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.deepEqual(findBatchLock(r.calls)!.params[0], [117], 'only the original batch is locked');
  assert.equal(findItems(r.calls)[0]!.params[2], 117, 'the return item records the original batch');
  assert.equal(findUpdate(r.calls)[0]!.params[1], 117);
});

test('SUBSTITUTE: a deactivated original batch permits a substitute with a reason', async () => {
  const r = await run(
    {
      batches: [
        { batch_id: 117, inventory_id: 5, is_active: false, quantity_on_hand: 0, quantity_reserved: 0 },
        { batch_id: 200, inventory_id: 5, is_active: true, quantity_on_hand: 0, quantity_reserved: 0 },
      ],
      allocations: [{ ...DEFAULT_ALLOCATION }],
    },
    {
      ...VALID_BODY,
      substitution_reason: 'الدفعة الأصلية معطّلة لظروف تخزين',
      items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK', batch_id: 200 }],
    },
  );

  assert.equal(r.captured.status, 201);
  assert.deepEqual(findBatchLock(r.calls)!.params[0], [117, 200], 'both batches are locked');
  assert.equal(findUpdate(r.calls)[0]!.params[1], 200, 'stock lands in the substitute batch');
  assert.equal(findMovement(r.calls)[0]!.params[0], 200, 'the movement names the substitute batch');
  assert.equal(findItems(r.calls)[0]!.params[2], 117, 'the return item still preserves the ORIGINAL batch');
  const metadata = JSON.parse(String(findAudit(r.calls)[0]!.params[3]));
  assert.equal(metadata.substitution_reason, 'الدفعة الأصلية معطّلة لظروف تخزين');
  assert.equal(metadata.items[0].original_batch_id, 117);
  assert.equal(metadata.items[0].restock_target_batch_id, 200, 'the substitute is recorded in the audit');
});

test('SUBSTITUTE: an active original batch refuses a substitute with 409', async () => {
  const r = await run(
    {
      batches: [
        { batch_id: 117, inventory_id: 5, is_active: true, quantity_on_hand: 40, quantity_reserved: 5 },
        { batch_id: 200, inventory_id: 5, is_active: true, quantity_on_hand: 0, quantity_reserved: 0 },
      ],
    },
    {
      ...VALID_BODY,
      substitution_reason: 'محاولة غير مسموحة',
      items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK', batch_id: 200 }],
    },
  );

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(writes(r.calls).length, 0);
  assert.equal(r.wasRolledBack, true);
});

test('SUBSTITUTE: a deactivated original batch without a reason is refused with 400', async () => {
  const r = await run(
    {
      batches: [
        { batch_id: 117, inventory_id: 5, is_active: false, quantity_on_hand: 0, quantity_reserved: 0 },
        { batch_id: 200, inventory_id: 5, is_active: true, quantity_on_hand: 0, quantity_reserved: 0 },
      ],
    },
    { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK', batch_id: 200 }] },
  );

  assert.equal(r.captured.status, 400);
  assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR);
  assert.equal(writes(r.calls).length, 0);
});

test('SUBSTITUTE: a batch from a different inventory item is refused with 400', async () => {
  const r = await run(
    {
      batches: [
        { batch_id: 117, inventory_id: 5, is_active: false, quantity_on_hand: 0, quantity_reserved: 0 },
        { batch_id: 200, inventory_id: 9, is_active: true, quantity_on_hand: 0, quantity_reserved: 0 },
      ],
    },
    {
      ...VALID_BODY,
      substitution_reason: 'سبب',
      items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK', batch_id: 200 }],
    },
  );

  assert.equal(r.captured.status, 400);
  assert.equal(writes(r.calls).length, 0);
});

test('SUBSTITUTE: batch_id is refused for a decision that restores no stock', async () => {
  for (const restock_decision of ['WASTE', 'QUARANTINE']) {
    const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision, batch_id: 200 }] });
    assert.equal(r.captured.status, 400, restock_decision);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR, restock_decision);
    assert.equal(r.calls.length, 0, restock_decision);
  }
});

/* ==========================================================================
 * 12-13. STOCK AND DISPENSING IMMUTABILITY
 * ========================================================================== */

test('WASTE: does not increase stock anywhere', async () => {
  const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'WASTE' }] });

  assert.equal(r.captured.status, 201);
  assert.equal(findUpdate(r.calls).length, 0, 'no batch update at all');
  assert.equal(findMovement(r.calls)[0]!.params[2], 10, 'but the returned quantity is recorded');
});

test('DISPENSING UNCHANGED: dispensed_quantity and remaining_quantity are never written', async () => {
  for (const restock_decision of ['RESTOCK', 'QUARANTINE', 'WASTE']) {
    const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision }] });
    assert.equal(r.captured.status, 201, restock_decision);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /dispensed_quantity\s*=/i, `${restock_decision} rewrote dispensed_quantity`);
      assert.doesNotMatch(call.text, /remaining_quantity\s*=/i, `${restock_decision} rewrote remaining_quantity`);
      assert.doesNotMatch(call.text, /UPDATE\s+dispensing_items/i, `${restock_decision} updated dispensing_items`);
      assert.doesNotMatch(call.text, /UPDATE\s+prescription/i, `${restock_decision} updated prescription history`);
    }
  }
});

test('RESERVED UNCHANGED: quantity_reserved is never assigned', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const update = findUpdate(r.calls)[0]!.text;
  assert.match(update, /SET\s+quantity_on_hand = \$1, updated_at = NOW\(\)/, 'the SET list is exactly these columns');
  assert.match(update, /\$1 >= b\.quantity_reserved/, 'the guard keeps reserved <= on hand');
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /quantity_reserved\s*=\s*\$/i);
  }
});

/* ==========================================================================
 * 14-15. MOVEMENT TYPES AND REFERENCES
 * ========================================================================== */

test('MOVEMENT: quantities are positive and reference the return', async () => {
  for (const restock_decision of ['RESTOCK', 'QUARANTINE', 'WASTE']) {
    const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision }] });
    assert.equal(r.captured.status, 201, restock_decision);

    const movement = findMovement(r.calls)[0]!;
    assert.equal(movement.params[2], 10, restock_decision);
    assert.ok(Number(movement.params[2]) > 0, 'movement quantity is never signed');
    assert.match(movement.text, /'MEDICATION_RETURN'/, 'reference type is a server constant');
    assert.equal(movement.params[3], '700', 'reference id is the return id as text');
    assert.equal(movement.params[4], PHARMACIST.userId, 'the performer is the authenticated user');
  }
});

test('MOVEMENT: RESTOCK and QUARANTINE are RETURN, WASTE is WASTE', async () => {
  const restock = await run({}, VALID_BODY);
  assert.equal(findMovement(restock.calls)[0]!.params[1], 'RETURN');

  const quarantine = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'QUARANTINE' }] });
  assert.equal(findMovement(quarantine.calls)[0]!.params[1], 'RETURN');

  const waste = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'WASTE' }] });
  assert.equal(findMovement(waste.calls)[0]!.params[1], 'WASTE');
});

test('MOVEMENT: multi-item returns write one movement per item', async () => {
  const r = await run(
    {
      allocations: [
        { dispensing_item_batch_id: 500, batch_id: 117, quantity: 30, unit_cost_snapshot: '2.5000' },
        { dispensing_item_batch_id: 501, batch_id: 118, quantity: 20, unit_cost_snapshot: '1.0000' },
      ],
      batches: [
        { batch_id: 117, inventory_id: 5, is_active: true, quantity_on_hand: 40, quantity_reserved: 5 },
        { batch_id: 118, inventory_id: 5, is_active: true, quantity_on_hand: 10, quantity_reserved: 0 },
      ],
    },
    {
      ...VALID_BODY,
      items: [
        { dispensing_item_batch_id: 500, quantity: 5, restock_decision: 'RESTOCK' },
        { dispensing_item_batch_id: 501, quantity: 4, restock_decision: 'WASTE' },
      ],
    },
  );

  assert.equal(r.captured.status, 201);
  assert.equal(findMovement(r.calls).length, 2);
  assert.equal(findItems(r.calls).length, 2);
  assert.equal(findAudit(r.calls).length, 1, 'one audit row for the whole return');
  assert.deepEqual(findBatchLock(r.calls)!.params[0], [117, 118], 'batches locked in ascending id order');
  assert.equal(r.captured.body.return.items.length, 2);
});

/* ==========================================================================
 * 16-17. SERVER-DERIVED IDENTITY AND COST
 * ========================================================================== */

test('IDENTITY: clinic, patient, actor, medication and batch are all server-derived', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const header = findHeader(r.calls)!;
  assert.equal(header.params[0], 1, 'clinic from the dispensing');
  assert.equal(header.params[1], PHARMACIST.userId, 'actor from the token');
  assert.equal(header.params[2], 200, 'patient from the dispensing');
  assert.equal(header.params[3], 900, 'original dispensing from the request');
  assert.match(header.text, /'COMPLETED'/, 'status is fixed by the server — no void path in this phase');

  const item = findItems(r.calls)[0]!;
  assert.equal(item.params[2], 117, 'batch from the allocation, not the request');
  assert.equal(item.params[3], 11, 'medication from the dispensing item');
});

test('COST: the historical allocation cost is copied and rounded to 3 decimals by PostgreSQL', async () => {
  const r = await run({ allocations: [{ ...DEFAULT_ALLOCATION, unit_cost_snapshot: '2.5678' }] }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const item = findItems(r.calls)[0]!;
  assert.match(item.text, /ROUND\(\$6::numeric, 3\)/, 'the rounding is explicit in PostgreSQL');
  assert.equal(item.params[5], '2.5678', 'the raw 4-decimal allocation cost is passed through');
  assert.doesNotMatch(item.text, /inventory_batches/i, 'cost is never re-read from the batch');
});

test('COST: rounding boundary values are handed to PostgreSQL unchanged', async () => {
  // 10,4 -> 12,3: the DB rounds, the app never rounds a cost itself
  for (const snapshot of ['0.0001', '2.5000', '9999.9999', '0.0005']) {
    const r = await run({ allocations: [{ ...DEFAULT_ALLOCATION, unit_cost_snapshot: snapshot }] }, VALID_BODY);
    assert.equal(r.captured.status, 201, snapshot);
    assert.equal(findItems(r.calls)[0]!.params[5], snapshot, snapshot);
  }
});

test('COST: an allocation with no recorded historical cost is refused, never re-read from the batch', async () => {
  const r = await run({ allocations: [{ ...DEFAULT_ALLOCATION, unit_cost_snapshot: null }] }, VALID_BODY);

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(writes(r.calls).length, 0);
  for (const call of r.calls) {
    // dib.unit_cost_snapshot is the historical source; inventory_batches.unit_cost is not
    assert.doesNotMatch(call.text, /(^|[^_a-zA-Z])b\.unit_cost/i, 'the current batch cost must never be substituted');
  }
});

/* ==========================================================================
 * 18-19. AUDIT
 * ========================================================================== */

test('AUDIT: exactly one MEDICATION_RETURNED row with the full picture', async () => {
  const r = await run({ priorReturned: { 500: 5 } }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const audits = findAudit(r.calls);
  assert.equal(audits.length, 1, 'exactly one audit row');

  const audit = audits[0]!;
  assert.match(audit.text, /'MEDICATION_RETURNED'/);
  assert.match(audit.text, /'MEDICATION_RETURN'/);
  assert.equal(audit.params[0], PHARMACIST.userId);
  assert.equal(audit.params[1], 1);
  assert.equal(audit.params[2], '700');

  const metadata = JSON.parse(String(audit.params[3]));
  assert.equal(metadata.return_id, 700);
  assert.equal(metadata.clinic_id, 1);
  assert.equal(metadata.original_dispensing_id, 900);
  assert.equal(metadata.patient_id, 200);
  assert.equal(metadata.returned_by_user_id, PHARMACIST.userId);
  assert.equal(metadata.reason, 'دواء غير مناسب للمريض');
  assert.equal(metadata.notes, 'أعاد المريض العلبة');
  assert.equal(metadata.items.length, 1);
  const item = metadata.items[0];
  assert.equal(item.dispensing_item_batch_id, 500);
  assert.equal(item.medication_id, 11);
  assert.equal(item.original_batch_id, 117);
  assert.equal(item.restock_target_batch_id, 117);
  assert.equal(item.quantity, 10);
  assert.equal(item.restock_decision, 'RESTOCK');
  assert.equal(item.movement_type, 'RETURN');
  assert.equal(item.previously_returned_quantity, 5);
});

test('AUDIT FAILURE: an audit insert failure rolls back the complete operation', async () => {
  const r = await run({ failOn: 'INSERT INTO audit_logs' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.captured.body.code, ApiErrorCode.INTERNAL_ERROR);
  assert.doesNotMatch(JSON.stringify(r.captured.body), /XX000|simulated|INSERT INTO/);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('INSERT INTO stock_movements')));
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches')));
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('INSERT INTO medication_return_items')));
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('INSERT INTO medication_returns')));
});

/* ==========================================================================
 * 20. FAILURE ROLLBACKS
 * ========================================================================== */

test('ROLLBACK: a header insert failure writes nothing', async () => {
  const r = await run({ failOn: 'INSERT INTO medication_returns' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(findItems(r.calls).length, 0);
  assert.equal(findUpdate(r.calls).length, 0);
  assert.equal(findMovement(r.calls).length, 0);
  assert.equal(findAudit(r.calls).length, 0);
});

test('ROLLBACK: a return-item insert failure leaves no header and no stock change', async () => {
  const r = await run({ failOn: 'INSERT INTO medication_return_items' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.ok(findHeader(r.calls), 'the header was attempted inside the transaction');
  assert.equal(findUpdate(r.calls).length, 0);
  assert.equal(findMovement(r.calls).length, 0);
  assert.equal(findAudit(r.calls).length, 0);
});

test('ROLLBACK: a movement insert failure undoes the header, items and stock change', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_movements' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findAudit(r.calls).length, 0, 'no audit for a movement that never landed');
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches')));
});

test('ROLLBACK: a quarantine insert failure undoes the whole return', async () => {
  const r = await run({ failOn: 'INSERT INTO batch_quarantines' }, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'QUARANTINE' }] });

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findMovement(r.calls).length, 0);
  assert.equal(findAudit(r.calls).length, 0);
});

test('ROLLBACK: a zero-row guarded batch update rolls back the header and the items', async () => {
  const r = await run({ updateRowCount: 0 }, VALID_BODY);

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findMovement(r.calls).length, 0, 'no movement survives a lost guard');
  assert.equal(findAudit(r.calls).length, 0);
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches')));
});

/* ==========================================================================
 * 21-22. LOCKING
 * ========================================================================== */

test('LOCKING: no SKIP LOCKED anywhere in the operation', async () => {
  for (const restock_decision of ['RESTOCK', 'QUARANTINE', 'WASTE']) {
    const r = await run({}, { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision }] });
    assert.equal(r.captured.status, 201, restock_decision);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i, `SKIP LOCKED in: ${call.text}`);
    }
  }
});

test('LOCKING: the dispensing, the allocations and the batches are all locked', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.match(findDispensingLock(r.calls)!.text, /FOR UPDATE OF d/, 'the dispensing is locked');
  assert.match(findAllocationLock(r.calls)!.text, /FOR UPDATE OF dib/, 'the allocations are locked');
  assert.match(findBatchLock(r.calls)!.text, /FOR UPDATE OF b/, 'the batches are locked');
  assert.equal(r.calls[0]!.text, 'BEGIN', 'every lock is taken inside the transaction');
  assert.equal(r.calls[r.calls.length - 1]!.text, 'COMMIT');
  assert.equal(r.wasReleased, true);
});

test('LOCKING: batches are locked in ascending batch_id order', async () => {
  const r = await run(
    {
      allocations: [
        { dispensing_item_batch_id: 501, batch_id: 200, quantity: 20, unit_cost_snapshot: '1.0000' },
        { dispensing_item_batch_id: 500, batch_id: 117, quantity: 30, unit_cost_snapshot: '2.5000' },
      ],
      batches: [
        { batch_id: 200, inventory_id: 5, is_active: true, quantity_on_hand: 10, quantity_reserved: 0 },
        { batch_id: 117, inventory_id: 5, is_active: true, quantity_on_hand: 40, quantity_reserved: 5 },
      ],
    },
    {
      ...VALID_BODY,
      items: [
        { dispensing_item_batch_id: 501, quantity: 5, restock_decision: 'RESTOCK' },
        { dispensing_item_batch_id: 500, quantity: 5, restock_decision: 'RESTOCK' },
      ],
    },
  );

  assert.equal(r.captured.status, 201);
  const lock = findBatchLock(r.calls)!;
  assert.match(lock.text, /ORDER BY b\.batch_id ASC/, 'the order is stated in SQL, not left to chance');
  assert.deepEqual(lock.params[0], [117, 200], 'and the bound ids are already ascending');
  assert.match(findAllocationLock(r.calls)!.text, /ORDER BY dib\.dispensing_item_batch_id ASC/);
  assert.deepEqual(findAllocationLock(r.calls)!.params[0], [500, 501]);
});

test('LOCKING: an allocation that is not part of the dispensing is refused', async () => {
  const r = await run({ allocations: [] }, VALID_BODY);

  assert.equal(r.captured.status, 400);
  assert.equal(writes(r.calls).length, 0);
  assert.equal(r.wasRolledBack, true);
});

test('LOCKING: the dispensing lookup is clinic-scoped, never trusted from the client', async () => {
  const r = await run({}, { ...VALID_BODY, clinic_id: 2, patient_id: 999 } as any);

  assert.equal(r.captured.status, 400, 'a client clinic_id is refused outright');
  assert.equal(r.calls.length, 0);
});

/* ==========================================================================
 * 23-24. NO CLIENT-CONTROLLED FIELDS / ROUTER
 * ========================================================================== */

test('IDENTITY: every forbidden top-level field is refused before DB access', async () => {
  for (const field of FORBIDDEN_RETURN_FIELDS) {
    const r = await run({}, { ...VALID_BODY, [field]: 2 } as any);
    assert.equal(r.captured.status, 400, `${field} must be refused`);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR, field);
    assert.equal(r.calls.length, 0, `${field} must be refused before any database access`);
  }
});

test('IDENTITY: every forbidden item-level field is refused before DB access', async () => {
  for (const field of FORBIDDEN_RETURN_ITEM_FIELDS) {
    const body = {
      ...VALID_BODY,
      items: [{ ...VALID_BODY.items[0]!, [field]: 2 }],
    } as any;
    const r = await run({}, body);
    assert.equal(r.captured.status, 400, `${field} must be refused`);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR, field);
    assert.equal(r.calls.length, 0, `${field} must be refused before any database access`);
  }
});

test('IDENTITY: unit_cost_snapshot, movement_type and financial fields are server-only', async () => {
  for (const field of ['unit_cost_snapshot', 'movement_type', 'reference_type', 'reference_id', 'quantity_before', 'quantity_after']) {
    const r = await run({}, { ...VALID_BODY, [field]: 'RETURN' } as any);
    assert.equal(r.captured.status, 400, field);
    assert.equal(r.calls.length, 0, field);
  }
});

test('VALIDATION: malformed requests are refused before any transaction', async () => {
  const bodies: [Record<string, unknown>, string][] = [
    [{ ...VALID_BODY, dispensing_id: 0 }, 'zero dispensing id'],
    [{ ...VALID_BODY, reason: '   ' }, 'whitespace reason'],
    [{ ...VALID_BODY, reason: undefined }, 'missing reason'],
    [{ ...VALID_BODY, items: [] }, 'no items'],
    [{ ...VALID_BODY, items: { dispensing_item_batch_id: 500 } }, 'items is not an array'],
    [{ ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 0, restock_decision: 'RESTOCK' }] }, 'zero quantity'],
    [{ ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: -5, restock_decision: 'RESTOCK' }] }, 'negative quantity'],
    [{ ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 1.2345, restock_decision: 'RESTOCK' }] }, 'over-precise quantity'],
    [{ ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 1, restock_decision: 'RECYCLE' }] }, 'unknown decision'],
    [{ ...VALID_BODY, items: [{ quantity: 1, restock_decision: 'RESTOCK' }] }, 'missing allocation id'],
    [
      {
        ...VALID_BODY,
        items: [
          { dispensing_item_batch_id: 500, quantity: 1, restock_decision: 'RESTOCK' },
          { dispensing_item_batch_id: 500, quantity: 1, restock_decision: 'RESTOCK' },
        ],
      },
      'duplicate allocation in one request',
    ],
  ];

  for (const [body, label] of bodies) {
    const r = await run({}, body as any);
    assert.equal(r.captured.status, 400, label);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR, label);
    assert.equal(r.calls.length, 0, label);
  }
});

test('AUTHORIZATION: DISPENSE_MEDICATIONS is required to execute a return', () => {
  const runMiddleware = (permissions: string[]) => {
    const request = { user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;
    requirePermission('DISPENSE_MEDICATIONS')(request, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err; else nextCalled = true;
    });
    return { error, nextCalled };
  };

  const denied = runMiddleware(['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(denied.nextCalled, false, 'inventory rights alone must not return dispensed medication');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware(['VIEW_INVENTORY', 'DISPENSE_MEDICATIONS']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

test('AUTHORIZATION: the read-only permission set cannot execute a return', async () => {
  // The middleware gate is what blocks this; assert the direct controller is
  // always reached behind that gate and never trusts the body for identity.
  const r = await run({}, VALID_BODY, VIEWER);
  assert.equal(r.captured.status, 201, 'the controller itself does not re-check permissions — the route does');
});

test('ROUTER: exactly one POST, and no update or delete route', () => {
  const layers = (medicationReturnsRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  }).stack;

  const routes = layers.filter((layer) => layer.route);
  const methods = routes.flatMap((layer) =>
    Object.entries(layer.route!.methods).filter(([, on]) => on).map(([method]) => method));

  assert.equal(methods.filter((m) => m === 'post').length, 1, 'one create surface');
  for (const forbidden of ['put', 'patch', 'delete']) {
    assert.equal(methods.includes(forbidden), false, `${forbidden.toUpperCase()} must not exist`);
  }
});

/* ==========================================================================
 * TRANSACTION INTEGRITY
 * ========================================================================== */

test('TRANSACTION: everything happens inside one transaction on one client', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(r.calls.filter((c) => c.text === 'BEGIN').length, 1, 'exactly one transaction');
  assert.equal(r.calls.filter((c) => c.text === 'COMMIT').length, 1);
  assert.equal(r.wasReleased, true);
});

test('TRANSACTION: no write is issued before validation completes', async () => {
  const cases: [Scenario, Record<string, unknown>][] = [
    [{ dispensingFound: false }, VALID_BODY],
    [{ dispensingStatus: 'VOIDED' }, VALID_BODY],
    [{ priorReturned: { 500: 30 } }, VALID_BODY],
    [{ allocations: [{ ...DEFAULT_ALLOCATION, unit_cost_snapshot: null }] }, VALID_BODY],
  ];

  for (const [scenario, body] of cases) {
    const r = await run(scenario, body);
    assert.ok(r.captured.status >= 400, JSON.stringify(scenario));
    assert.equal(writes(r.calls).length, 0, `a write escaped validation in ${JSON.stringify(scenario)}`);
    assert.equal(r.wasCommitted, false);
  }
});

test('TRANSACTION: the documented order is preserved', async () => {
  // A charged line is supplied so the full order, including the 10E.8 revenue
  // credit, is exercised. Without one the credit step is legitimately absent.
  const r = await run(
    {
      chargeLines: [{
        dispensing_item_id: 501, charged_quantity: '10.000', unit_price_snapshot: '5.00',
        medication_discount_value: '0', net_amount: '50.00', paid_amount: '0.00',
      }],
    },
    { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK' }] },
  );

  assert.equal(r.captured.status, 201);
  const order = r.calls.filter((c) => !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(c.text.trim()));
  assert.match(order[0]!.text, /SELECT d\.dispensing_id/, '1) lock the dispensing');
  assert.match(order[1]!.text, /FOR UPDATE OF dib/, '2) lock the allocations');
  assert.match(order[2]!.text, /mr\.status = 'COMPLETED'/, '3) validate against return history');
  // Phase 10E.8: the invoice line is locked after the allocations and before the
  // batches, keeping one global order: dispensing → allocations → invoice → batches.
  assert.match(order[3]!.text, /FOR UPDATE OF ii/, '4) lock the charged invoice lines');
  assert.match(order[4]!.text, /FROM medication_return_credits/, '5) validate credited quantity');
  assert.match(order[5]!.text, /FOR UPDATE OF b/, '6) lock the batches, ordered');
  assert.match(order[6]!.text, /INSERT INTO medication_returns/, '7) header');
  assert.match(order[7]!.text, /INSERT INTO medication_return_items/, '8) items');
  // Phase 10E.7: the reversal is written inside the same item loop, so it lands
  // immediately after the return line it reverses — never in a second transaction.
  assert.match(order[8]!.text, /INSERT INTO medication_return_reversals/, '9) financial reversal');
  // Phase 10E.8: the revenue credit follows it, in the same transaction.
  assert.match(order[9]!.text, /INSERT INTO medication_return_credits/, '10) revenue credit');
  assert.match(order[10]!.text, /UPDATE inventory_batches/, '11) guarded stock update');
  assert.match(order[11]!.text, /INSERT INTO stock_movements/, '12) movement');
  assert.match(order[12]!.text, /INSERT INTO audit_logs/, '13) audit');
});

test('TRANSACTION: the response never echoes a client-supplied identity', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const body = JSON.stringify(r.captured.body);
  assert.equal(r.captured.body.return.clinic_id, 1);
  assert.equal(r.captured.body.return.returned_by_user_id, PHARMACIST.userId);
  assert.equal(r.captured.body.return.dispensed_to_patient_id, 200);
  assert.doesNotMatch(body, /password_hash|username|email|national_id/);
});

/* ==========================================================================
 * 10E.8 — REVENUE CREDIT ON A MEDICATION RETURN
 * ========================================================================== */

const CHARGED: ChargeLine = {
  dispensing_item_id: 501, charged_quantity: '30.000', unit_price_snapshot: '5.00',
  medication_discount_value: '0', net_amount: '150.00', paid_amount: '0.00',
};

const ONE_RESTOCK = { dispensing_item_batch_id: 500, quantity: 10, restock_decision: 'RESTOCK' };

const findCredits = (calls: QueryCall[]) =>
  calls.filter((c) => c.text.includes('INSERT INTO medication_return_credits'));

test('CREDIT: an invoiced line yields a credit derived only from invoice snapshots', async () => {
  const r = await run({ chargeLines: [CHARGED] }, { ...VALID_BODY, items: [ONE_RESTOCK] });

  assert.equal(r.captured.status, 201);
  const credit = findCredits(r.calls)[0]!;
  const params = credit.params;
  assert.equal(params[3], 10, 'the returned quantity');
  assert.equal(params[4], '5.00', 'the price is copied from the invoice line, never the current price');
  assert.equal(params[5], '0', 'the discount is copied from the invoice line');
  assert.equal(params[10], '150.00', 'the invoice net is snapshotted on the credit');
  assert.equal(params[11], '0.00', 'the invoice paid is snapshotted on the credit');
  assert.deepEqual(r.captured.body.return.revenue_credits_skipped, [], 'nothing skipped');
const credited = r.captured.body.return.revenue_credits[0];
  assert.equal(Number(credited.credit_amount), 50, '10 x 5.00 with no discount');
  assert.equal(credited.dispensing_item_id, 501, 'keyed to the dispensing item, not the batch');
});

test('CREDIT: the medication discount is taken off the gross, rounded once', async () => {
  // 3 x 9.99 at 10% = gross 29.97, discount 2.997 -> 3.00, net 26.97.
  const r = await run(
    {
      chargeLines: [{
        dispensing_item_id: 501, charged_quantity: '30.000', unit_price_snapshot: '9.99',
        medication_discount_value: '10', net_amount: '300.00', paid_amount: '0.00',
      }],
    },
    { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 3, restock_decision: 'RESTOCK' }] },
  );

  assert.equal(r.captured.status, 201);
  const credited = r.captured.body.return.revenue_credits[0];
  assert.equal(Number(credited.gross_amount), 29.97);
  assert.equal(Number(credited.net_amount), 26.97);
  assert.equal(credited.net_amount, credited.credit_amount, 'the credit IS the net');
});

test('CREDIT: a line with no invoice earns no credit and is reported, not guessed', async () => {
  const r = await run({}, { ...VALID_BODY, items: [ONE_RESTOCK] });

  assert.equal(r.captured.status, 201);
  assert.equal(findCredits(r.calls).length, 0, 'no revenue was recorded, so none is reversed');
assert.deepEqual(r.captured.body.return.revenue_credits, []);
  assert.equal(r.captured.body.return.revenue_credits_skipped[0].reason, 'NOT_INVOICED');
  // 10E.7 is unaffected: the cost reversal still happens.
  assert.equal(findReversal(r.calls).length, 1, 'the cost reversal is independent of the charge');
});

test('CREDIT: a pre-10E.8 line with no discount snapshot is skipped, never zeroed', async () => {
  const r = await run(
    { chargeLines: [{ ...CHARGED, medication_discount_value: null }] },
    { ...VALID_BODY, items: [ONE_RESTOCK] },
  );

  assert.equal(r.captured.status, 201);
  assert.equal(findCredits(r.calls).length, 0);
  assert.equal(
    r.captured.body.return.revenue_credits_skipped[0].reason,
    'MISSING_MEDICATION_DISCOUNT_SNAPSHOT',
  );
});

test('CREDIT: an insurance invoice books the full credit and owes no refund', async () => {
  const r = await run(
    {
      chargeLines: [{ ...CHARGED, payment_type: 'INSURANCE', net_amount: '150.00', paid_amount: '150.00' }],
    },
    { ...VALID_BODY, items: [ONE_RESTOCK] },
  );

  assert.equal(r.captured.status, 201);
  const credited = r.captured.body.return.revenue_credits[0];
  assert.equal(Number(credited.credit_amount), 50, 'the revenue is reversed in full');
  assert.equal(Number(credited.applied_to_outstanding), 0, 'nothing is outstanding');
  assert.equal(Number(credited.refund_due_amount), 0, 'the payer is not the patient');
});

test('CREDIT: a cash invoice splits the credit between the balance and the refund', async () => {
  // 10 returned at 5.00 = 50.00 credit. The invoice already has 120.00 against a
  // 150.00 net, so only 30.00 is outstanding: 30 cancels it, 20 is owed back.
  const r = await run(
    { chargeLines: [{ ...CHARGED, payment_type: 'CASH', net_amount: '150.00', paid_amount: '120.00' }] },
    { ...VALID_BODY, items: [ONE_RESTOCK] },
  );

  assert.equal(r.captured.status, 201);
  const credited = r.captured.body.return.revenue_credits[0];
  assert.equal(Number(credited.applied_to_outstanding), 30);
  assert.equal(Number(credited.refund_due_amount), 20);
  assert.equal(
    Number(credited.applied_to_outstanding) + Number(credited.refund_due_amount),
    Number(credited.credit_amount),
    'the credit is split, never lost and never duplicated',
  );
});

test('CREDIT: the refund is capped by what was actually paid, not by the net', async () => {
  // Paid 20.00 against a 150.00 net: the patient already owes 130.00, so the
  // whole 50.00 credit cancels the balance and nothing is refunded.
  const r = await run(
    { chargeLines: [{ ...CHARGED, payment_type: 'CASH', net_amount: '150.00', paid_amount: '20.00' }] },
    { ...VALID_BODY, items: [ONE_RESTOCK] },
  );

  const credited = r.captured.body.return.revenue_credits[0];
  assert.equal(Number(credited.applied_to_outstanding), 50);
  assert.equal(Number(credited.refund_due_amount), 0);
});

test('CREDIT: returning more than the charged quantity is refused', async () => {
  const r = await run(
    { chargeLines: [{ ...CHARGED, charged_quantity: '5.000' }] },
    { ...VALID_BODY, items: [ONE_RESTOCK] },
  );

  assert.equal(r.captured.status, 409);
  assert.equal(findCredits(r.calls).length, 0);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('CREDIT: a second return can only credit what the first one did not', async () => {
  // 30 charged, 25 already credited, so 5 remain. 10 is still too many.
  const r = await run(
    {
      chargeLines: [CHARGED],
      credited: [{ dispensing_item_id: 501, quantity: 25 }],
    },
    { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 5, restock_decision: 'RESTOCK' }] },
  );

  assert.equal(r.captured.status, 201, '30 charged - 25 credited = 5 still creditable');
  assert.equal(Number(r.captured.body.return.revenue_credits[0].credit_amount), 25);
});

test('CREDIT: the over-credit guard reports what is still creditable', async () => {
  const r = await run(
    {
      chargeLines: [CHARGED],
      credited: [{ dispensing_item_id: 501, quantity: 25 }],
    },
    { ...VALID_BODY, items: [{ dispensing_item_batch_id: 500, quantity: 6, restock_decision: 'RESTOCK' }] },
  );

assert.equal(r.captured.status, 409);
  // The error carries the arithmetic so a client can retry without guessing.
  assert.equal(Number(r.captured.body.creditable_quantity), 5);
  assert.equal(Number(r.captured.body.previously_credited_quantity), 25);
  assert.equal(Number(r.captured.body.charged_quantity), 30);
});

test('CREDIT: the client never supplies the money', async () => {
  const r = await run(
    { chargeLines: [CHARGED] },
    {
      ...VALID_BODY,
items: [{
        ...ONE_RESTOCK,
        unit_price_snapshot: '0.01',
        credit_amount: '999999',
        medication_discount_value: '100',
      }],
    },
  );

  assert.equal(r.captured.status, 201);
  const credit = findCredits(r.calls)[0]!;
  assert.equal(credit.params[4], '5.00', 'the invoice price, not the client value');
  assert.equal(credit.params[5], '0', 'the invoice discount, not the client value');
  assert.equal(Number(r.captured.body.return.revenue_credits[0].credit_amount), 50);
});
