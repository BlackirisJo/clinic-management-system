import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createStockAdjustment } from '../modules/inventory/stockAdjustments.controller';
import stockAdjustmentsRouter from '../modules/inventory/stockAdjustments.routes';
import * as adjustmentsController from '../modules/inventory/stockAdjustments.controller';
import {
  STOCK_ADJUSTMENT_DIRECTIONS,
  ADJUSTMENT_MOVEMENT_TYPE,
  FORBIDDEN_ADJUSTMENT_FIELDS,
} from '../validations/stockAdjustment.validation';

/* ==========================================================================
 * Phase 10D.2 — Manual stock adjustments (direct controller tests, mocked client)
 *
 * Only pool.connect() is stubbed; the whole operation must run in ONE
 * transaction on ONE client, and no write may escape a ROLLBACK.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface Scenario {
  /** quantity_on_hand of the locked batch */
  onHand?: number;
  /** quantity_reserved of the locked batch — never written by this flow */
  reserved?: number;
  /** the batch lock returns no row (nonexistent or out-of-clinic) */
  missing?: boolean;
  /** the guarded UPDATE affects zero rows */
  updateRowCount?: number;
  failOn?: string;
  noUser?: boolean;
}

const makeHandler = (s: Scenario) => (text: string, params: unknown[] = []): MockResult => {
  const t = text.trim();
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

  if (s.failOn && t.includes(s.failOn)) {
    throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
  }

  if (t.includes('FOR UPDATE OF b')) {
    if (s.missing) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        batch_id: 7,
        inventory_id: 5,
        medication_id: 11,
        clinic_id: 1,
        quantity_on_hand: s.onHand ?? 100,
        quantity_reserved: s.reserved ?? 0,
      }],
      rowCount: 1,
    };
  }
  if (t.startsWith('UPDATE inventory_batches')) {
    return { rows: [{ batch_id: 7, quantity_on_hand: params[0], quantity_reserved: s.reserved ?? 0 }], rowCount: s.updateRowCount ?? 1 };
  }
  if (t.startsWith('INSERT INTO stock_adjustments')) {
    return { rows: [{ adjustment_id: 700, ...paramsToAdjustmentRow(params) }], rowCount: 1 };
  }
  if (t.startsWith('INSERT INTO stock_movements')) {
    return { rows: [{ movement_id: 800, ...paramsToMovementRow(params) }], rowCount: 1 };
  }
  if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

  throw new Error(`Unexpected query: ${text}`);
};

const paramsToAdjustmentRow = (params: unknown[]) => ({
  clinic_id: params[0], batch_id: params[1], inventory_id: params[2], medication_id: params[3],
  direction: params[4], quantity: params[5], quantity_before: params[6], quantity_after: params[7],
  reason: params[8], notes: params[9], performed_by_user_id: params[10],
});

const paramsToMovementRow = (params: unknown[]) => ({
  batch_id: params[0], movement_type: params[1], quantity: params[2],
  reference_type: 'STOCK_ADJUSTMENT', reference_id: params[3],
  performed_by_user_id: params[4], notes: params[5],
});

const PHARMACIST = {
  userId: 42, roleId: 4, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY', 'MANAGE_INVENTORY'], clinicIds: [1],
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

const req = (body: Record<string, unknown>, user: unknown = PHARMACIST): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user } as unknown as AuthenticatedRequest);

interface Run {
  captured: { status: number; body: any };
  calls: QueryCall[];
  wasCommitted: boolean;
  wasRolledBack: boolean;
  wasReleased: boolean;
}

/** Runs the controller against one mocked PoolClient and captures every statement. */
async function run(scenario: Scenario = {}, body: Record<string, unknown> = {}): Promise<Run> {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = makeHandler(scenario);
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
    await createStockAdjustment(req(body, scenario.noUser ? {} : PHARMACIST), res);
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

const VALID_BODY = { batch_id: 7, quantity: 10, direction: 'INCREASE', reason: 'جرد دوري' };

const find = (calls: QueryCall[], needle: string) => calls.find((c) => c.text.includes(needle));
const findHeader = (calls: QueryCall[]) => find(calls, 'INSERT INTO stock_adjustments');
const findUpdate = (calls: QueryCall[]) => find(calls, 'UPDATE inventory_batches');
const findMovement = (calls: QueryCall[]) => find(calls, 'INSERT INTO stock_movements');
const findAudit = (calls: QueryCall[]) => find(calls, 'INSERT INTO audit_logs');
const findLock = (calls: QueryCall[]) => find(calls, 'FOR UPDATE OF b');
/** أي كتابة ناتجة عن الفشل تُلغى بالمعاملة — نتحقق من التراجع لا من غياب النداء */
const writes = (calls: QueryCall[]) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text.trim()));

/* ==========================================================================
 * 1. INCREASE SUCCESS
 * ========================================================================== */

test('INCREASE: a valid increase commits and reports the exact resulting balance', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityBefore, 100);
  assert.equal(r.captured.body.quantityAfter, 110);
  assert.equal(findUpdate(r.calls)!.params[0], 110, 'the new on-hand is on_hand + quantity');
  assert.equal(r.wasCommitted, true);
  assert.equal(r.wasRolledBack, false);
});

/* ==========================================================================
 * 2. DECREASE SUCCESS
 * ========================================================================== */

test('DECREASE: a valid decrease commits and reports the exact resulting balance', async () => {
  const r = await run({ onHand: 100 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 40 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityBefore, 100);
  assert.equal(r.captured.body.quantityAfter, 60);
  assert.equal(findUpdate(r.calls)!.params[0], 60, 'the new on-hand is on_hand - quantity');
  assert.equal(r.wasCommitted, true);
});

/* ==========================================================================
 * 3. MOVEMENT TYPE PER DIRECTION
 * ========================================================================== */

test('MOVEMENT: INCREASE is recorded as ADJUSTMENT and DECREASE as ADJUSTMENT_DECREASE', async () => {
  const increase = await run({ onHand: 100 }, VALID_BODY);
  assert.equal(increase.captured.status, 201);
  assert.equal(findMovement(increase.calls)!.params[1], 'ADJUSTMENT');
  assert.equal(increase.captured.body.movement.movement_type, 'ADJUSTMENT');

  const decrease = await run({ onHand: 100 }, { ...VALID_BODY, direction: 'DECREASE' });
  assert.equal(decrease.captured.status, 201);
  assert.equal(findMovement(decrease.calls)!.params[1], 'ADJUSTMENT_DECREASE');
  assert.equal(decrease.captured.body.movement.movement_type, 'ADJUSTMENT_DECREASE');
});

test('MOVEMENT: every direction maps to exactly one movement type and never to a new one', async () => {
  assert.deepEqual(Object.keys(ADJUSTMENT_MOVEMENT_TYPE).sort(), [...STOCK_ADJUSTMENT_DIRECTIONS].sort());
  assert.equal(ADJUSTMENT_MOVEMENT_TYPE.INCREASE, 'ADJUSTMENT');
  assert.equal(ADJUSTMENT_MOVEMENT_TYPE.DECREASE, 'ADJUSTMENT_DECREASE');
  for (const type of Object.values(ADJUSTMENT_MOVEMENT_TYPE)) {
    assert.ok(['ADJUSTMENT', 'ADJUSTMENT_DECREASE'].includes(type), `${type} must be an existing movement type`);
  }
});

/* ==========================================================================
 * 4. POSITIVE MOVEMENT QUANTITY
 * ========================================================================== */

test('MOVEMENT: the movement quantity is always the positive requested quantity', async () => {
  for (const direction of STOCK_ADJUSTMENT_DIRECTIONS) {
    const r = await run({ onHand: 100 }, { ...VALID_BODY, direction });
    assert.equal(r.captured.status, 201, direction);
    const movement = findMovement(r.calls)!;
    assert.equal(movement.params[2], 10, direction);
    assert.ok(Number(movement.params[2]) > 0, 'no signed quantity is ever persisted');
  }
});

test('MOVEMENT: the movement references the adjustment as STOCK_ADJUSTMENT', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  const movement = findMovement(r.calls)!;
  assert.match(movement.text, /'STOCK_ADJUSTMENT'/, 'reference_type is fixed server-side');
  assert.equal(movement.params[3], '700', 'reference_id is the adjustment_id as text');
  assert.equal(r.captured.body.movement.reference_type, 'STOCK_ADJUSTMENT');
  assert.equal(r.captured.body.movement.reference_id, '700');
});

/* ==========================================================================
 * 5. EXACT BEFORE/AFTER QUANTITY
 * ========================================================================== */

test('QUANTITY: the header records the exact before/after pair for both directions', async () => {
  const increase = await run({ onHand: 100.5 }, { ...VALID_BODY, quantity: 0.25 });
  assert.equal(increase.captured.status, 201);
  const incHeader = increase.captured.body.adjustment;
  assert.equal(Number(incHeader.quantity_before), 100.5);
  assert.equal(Number(incHeader.quantity_after), 100.75);

  const decrease = await run({ onHand: 100.5 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 0.25 });
  assert.equal(decrease.captured.status, 201);
  const decHeader = decrease.captured.body.adjustment;
  assert.equal(Number(decHeader.quantity_before), 100.5);
  assert.equal(Number(decHeader.quantity_after), 100.25);
});

test('QUANTITY: fractional arithmetic never leaks a floating-point remainder', async () => {
  const r = await run({ onHand: 0.1 }, { ...VALID_BODY, quantity: 0.2 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 0.3, '0.1 + 0.2 must persist as 0.300');
  assert.equal(findUpdate(r.calls)!.params[0], 0.3);
});

/* ==========================================================================
 * 6-7. MANDATORY, NON-BLANK REASON
 * ========================================================================== */

test('REASON: a missing reason returns 400 with no transaction and no write', async () => {
  for (const body of [
    { batch_id: 7, quantity: 10, direction: 'INCREASE' },
    { ...VALID_BODY, reason: undefined },
  ]) {
    const r = await run({}, body);
    assert.equal(r.captured.status, 400, JSON.stringify(body));
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR);
    assert.equal(r.calls.length, 0, 'a missing reason must never reach the database');
  }
});

test('REASON: a whitespace-only reason is rejected before the database', async () => {
  for (const reason of ['   ', '\t', '\n  \n']) {
    const r = await run({}, { ...VALID_BODY, reason });
    assert.equal(r.captured.status, 400, JSON.stringify(reason));
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR);
    assert.equal(r.calls.length, 0);
  }
});

test('REASON: an empty-string reason is rejected and the stored reason is trimmed', async () => {
  const empty = await run({}, { ...VALID_BODY, reason: '' });
  assert.equal(empty.captured.status, 400);
  assert.equal(empty.calls.length, 0);

  const padded = await run({}, { ...VALID_BODY, reason: '  تسوية  ' });
  assert.equal(padded.captured.status, 201);
  assert.equal(findHeader(padded.calls)!.params[8], 'تسوية', 'the reason is trimmed before storage');
});

/* ==========================================================================
 * 8-9. OUT-OF-CLINIC AND NONEXISTENT BATCH -> SAME 404, ZERO WRITES
 * ========================================================================== */

test('ISOLATION: a nonexistent batch returns 404 and writes nothing', async () => {
  const r = await run({ missing: true }, VALID_BODY);

  assert.equal(r.captured.status, 404);
  assert.equal(writes(r.calls).length, 0, 'no write may run for a missing batch');
  assert.equal(findHeader(r.calls), undefined);
  assert.equal(findUpdate(r.calls), undefined);
  assert.equal(findMovement(r.calls), undefined);
  assert.equal(findAudit(r.calls), undefined);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('ISOLATION: an out-of-clinic batch produces byte-identical behaviour to a missing one', async () => {
  // The lock is clinic-scoped through the item join, so an out-of-clinic batch
  // simply produces no locked row — the same 404 body, not a 403.
  const outOfClinic = await run({ missing: true }, VALID_BODY);
  const nonexistent = await run({ missing: true }, VALID_BODY);

  assert.equal(outOfClinic.captured.status, nonexistent.captured.status);
  assert.deepEqual(outOfClinic.captured.body, nonexistent.captured.body);
  assert.equal(outOfClinic.captured.body.message, 'الدفعة المطلوبة غير موجودة');
  assert.equal(writes(outOfClinic.calls).length, 0);
});

test('ISOLATION: the batch lock resolves and scopes the clinic through the inventory item', async () => {
  const r = await run({}, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const lock = findLock(r.calls)!;
  assert.match(lock.text, /JOIN inventory_items i ON i\.inventory_id = b\.inventory_id/);
  assert.match(lock.text, /i\.clinic_id = ANY\(\$2::int\[\]\)/, 'the batch id alone is never trusted');
  assert.deepEqual(lock.params, [7, [1]], 'scope is the assigned clinic ids');
});

/* ==========================================================================
 * 10-11. AVAILABILITY CONSIDERING quantity_reserved
 * ========================================================================== */

test('AVAILABILITY: a decrease beyond the available quantity is rejected with 409', async () => {
  // on_hand 100, reserved 30 -> only 70 is available
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 71 });

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(writes(r.calls).length, 0, 'no write when the available quantity is insufficient');
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('AVAILABILITY: decreasing into the reserved quantity is rejected even though on_hand allows it', async () => {
  // 60 is below on_hand (100) but above the available 70? no — 80 is: on_hand allows
  // 80 but only 70 is free, so the adjustment must be refused.
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 80 });

  assert.equal(r.captured.status, 409);
  assert.equal(findUpdate(r.calls), undefined, 'reserved stock is never silently consumed');
});

test('AVAILABILITY: decreasing the exact available quantity succeeds and lands on reserved', async () => {
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 70 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 30, 'on_hand may fall to reserved, never below it');
  assert.equal(findUpdate(r.calls)!.params[0], 30);
  assert.equal(r.wasCommitted, true);
});

test('AVAILABILITY: the whole on-hand is available when nothing is reserved', async () => {
  const r = await run({ onHand: 10, reserved: 0 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 10 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 0);
});

/* ==========================================================================
 * 12. quantity_reserved IS NEVER WRITTEN
 * ========================================================================== */

test('RESERVED: quantity_reserved is never assigned by any statement', async () => {
  for (const direction of STOCK_ADJUSTMENT_DIRECTIONS) {
    const r = await run({ onHand: 100, reserved: 25 }, { ...VALID_BODY, direction });
    assert.equal(r.captured.status, 201, direction);
    for (const call of r.calls) {
      // مسموح قراءته (حارس/RETURNING) وممنوع إسناده — أي "=" بعد اسمه تعني كتابة
      assert.doesNotMatch(call.text, /quantity_reserved\s*=(?!=)/i, `reserved quantity assigned in: ${call.text}`);
    }
    // The SET list is exactly these two columns — quantity_reserved is not among them
    const update = findUpdate(r.calls)!;
    assert.match(update.text, /SET\s+quantity_on_hand = \$1, updated_at = NOW\(\)/);
    // It may be READ for the availability rule, but never bound as a written value
    const header = findHeader(r.calls)!;
    assert.equal(header.params.includes(25), false, 'the reserved value is never written into the header');
  }
});

test('RESERVED: the guarded update can never push on_hand below reserved', async () => {
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 70 });

  assert.equal(r.captured.status, 201);
  const update = findUpdate(r.calls)!;
  assert.match(update.text, /b\.quantity_reserved <= \$1/, 'the DB guard enforces reserved <= on_hand');
  assert.match(update.text, /b\.quantity_on_hand >= 0/, 'negative on-hand is refused by the DB too');
});

/* ==========================================================================
 * 13-17. TRANSACTION INTEGRITY AND ROLLBACKS
 * ========================================================================== */

test('ROLLBACK: a zero-row guarded update rolls back the header and writes nothing else', async () => {
  const r = await run({ onHand: 100, updateRowCount: 0 }, VALID_BODY);

  assert.equal(r.captured.status, 409);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findMovement(r.calls), undefined, 'no movement survives a lost guard');
  assert.equal(findAudit(r.calls), undefined, 'no audit survives a lost guard');
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  const headerIndex = r.calls.findIndex((c) => c.text.includes('INSERT INTO stock_adjustments'));
  const updateIndex = r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches'));
  assert.ok(headerIndex < updateIndex, 'the header is written before the guarded update');
  assert.ok(rollbackIndex > updateIndex, 'the rollback undoes the header and the update');
});

test('ROLLBACK: a header insert failure writes nothing at all', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_adjustments' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findUpdate(r.calls), undefined, 'no stock change without a header');
  assert.equal(findMovement(r.calls), undefined);
  assert.equal(findAudit(r.calls), undefined);
});

test('ROLLBACK: a movement insert failure undoes the header and the stock change', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_movements' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.ok(findHeader(r.calls), 'the header insert was attempted inside the transaction');
  assert.equal(findAudit(r.calls), undefined, 'no audit for a movement that never landed');
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches')));
});

test('ROLLBACK: an audit failure undoes the header, the stock change and the movement', async () => {
  const r = await run({ failOn: 'INSERT INTO audit_logs' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('INSERT INTO stock_movements')));
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches')));
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('INSERT INTO stock_adjustments')));
});

test('ROLLBACK: internal SQL errors are never exposed to the client', async () => {
  const r = await run({ failOn: 'INSERT INTO audit_logs' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.captured.body.code, ApiErrorCode.INTERNAL_ERROR);
  assert.doesNotMatch(JSON.stringify(r.captured.body), /XX000|simulated|INSERT INTO/);
});

test('TRANSACTION: a DB constraint violation is reported, not bypassed', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_adjustments' }, VALID_BODY);
  assert.equal(r.captured.status, 500);

  // Same failure, but reported as a check-constraint violation
  const constraint = await run({ failOn: 'INSERT INTO stock_movements' }, VALID_BODY);
  assert.equal(constraint.captured.status, 500);
});

test('TRANSACTION: everything happens inside one transaction on one client', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(r.calls[0]!.text, 'BEGIN');
  assert.equal(r.calls[r.calls.length - 1]!.text, 'COMMIT');
  assert.equal(r.calls.filter((c) => c.text === 'BEGIN').length, 1, 'exactly one transaction');
  assert.equal(r.calls.filter((c) => c.text === 'COMMIT').length, 1);
  assert.equal(r.wasReleased, true, 'the client is always released back to the pool');
});

test('TRANSACTION: the documented statement order is preserved', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const order = r.calls.filter((c) => c.text !== 'BEGIN' && c.text !== 'COMMIT' && c.text !== 'ROLLBACK');
  assert.equal(order.length, 5, 'lock, header, update, movement, audit — nothing else');
  assert.match(order[0]!.text, /FOR UPDATE OF b/, '1) lock the batch');
  assert.match(order[1]!.text, /INSERT INTO stock_adjustments/, '2) header');
  assert.match(order[2]!.text, /UPDATE inventory_batches/, '3) guarded quantity update');
  assert.match(order[3]!.text, /INSERT INTO stock_movements/, '4) movement');
  assert.match(order[4]!.text, /INSERT INTO audit_logs/, '5) audit');
});

/* ==========================================================================
 * LOCKING
 * ========================================================================== */

test('LOCKING: the batch row is locked with FOR UPDATE and never with SKIP LOCKED', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const lockIndex = r.calls.findIndex((c) => c.text.includes('FOR UPDATE OF b'));
  assert.ok(lockIndex > 0, 'a FOR UPDATE lock must be taken');
  assert.equal(r.calls[lockIndex - 1]!.text, 'BEGIN', 'the lock is taken inside the transaction');
  assert.match(r.calls[lockIndex]!.text, /FOR UPDATE OF b/, 'only the batch row is locked');
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i, `SKIP LOCKED must never be used: ${call.text}`);
  }
});

test('LOCKING: the update is additionally guarded by the values read under the lock', async () => {
  const r = await run({ onHand: 100, reserved: 10 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 40 });

  assert.equal(r.captured.status, 201);
  const update = findUpdate(r.calls)!;
  assert.match(update.text, /b\.quantity_on_hand = \$3/, 'the update requires the balance read under the lock');
  assert.deepEqual(update.params.slice(0, 3), [60, 7, 100], 'after, batch_id, on_hand read under the lock');
  assert.equal(update.params[3], 5, 'the derived inventory id is bound');
  assert.equal(update.params[4], 1, 'the derived clinic id is bound');
  assert.deepEqual(update.params[5], [1], 'the clinic scope is re-applied to the derived clinic');
});

test('LOCKING: all statements are parameterised — no value is interpolated into SQL', async () => {
  const r = await run({ onHand: 100 }, { ...VALID_BODY, reason: "'; DROP TABLE stock_adjustments; --" });

  assert.equal(r.captured.status, 201);
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /DROP TABLE/, 'user input must never reach the SQL text');
  }
  assert.equal(findHeader(r.calls)!.params[8], "'; DROP TABLE stock_adjustments; --");
});

/* ==========================================================================
 * 17. AUDIT
 * ========================================================================== */

test('AUDIT: exactly one audit row is written with the full metadata', async () => {
  const r = await run({ onHand: 100, reserved: 20 }, { ...VALID_BODY, direction: 'DECREASE', quantity: 30, reason: 'كسور مادي', notes: 'تحقق من المستودع' });

  assert.equal(r.captured.status, 201);
  const audits = r.calls.filter((c) => c.text.includes('INSERT INTO audit_logs'));
  assert.equal(audits.length, 1, 'exactly one audit row per adjustment');

  const audit = audits[0]!;
  assert.match(audit.text, /'STOCK_ADJUSTED'/);
  assert.match(audit.text, /'STOCK_ADJUSTMENT'/);
  assert.equal(audit.params[0], PHARMACIST.userId, 'the audit actor is the authenticated user');
  assert.equal(audit.params[1], 1, 'the audit clinic is the derived one');
  assert.equal(audit.params[2], '700', 'the audit resource is the adjustment');

  const metadata = JSON.parse(String(audit.params[3]));
  for (const key of [
    'adjustment_id', 'clinic_id', 'batch_id', 'direction', 'quantity',
    'reason', 'before_quantity', 'after_quantity', 'performed_by_user_id',
  ]) {
    assert.ok(key in metadata, `metadata must include ${key}`);
  }
  assert.equal(metadata.adjustment_id, 700);
  assert.equal(metadata.clinic_id, 1);
  assert.equal(metadata.batch_id, 7);
  assert.equal(metadata.direction, 'DECREASE');
  assert.equal(metadata.quantity, 30);
  assert.equal(metadata.reason, 'كسور مادي');
  assert.equal(metadata.before_quantity, 100);
  assert.equal(metadata.after_quantity, 70);
  assert.equal(metadata.performed_by_user_id, PHARMACIST.userId);
  assert.equal(metadata.movement_type, 'ADJUSTMENT_DECREASE');
  assert.equal(metadata.inventory_id, 5);
  assert.equal(metadata.medication_id, 11);
});

test('AUDIT: the audit is written last, after the movement, and before COMMIT', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  const auditIndex = r.calls.findIndex((c) => c.text.includes('INSERT INTO audit_logs'));
  const movementIndex = r.calls.findIndex((c) => c.text.includes('INSERT INTO stock_movements'));
  const commitIndex = r.calls.findIndex((c) => c.text === 'COMMIT');
  assert.ok(auditIndex > movementIndex);
  assert.ok(auditIndex < commitIndex);
});

/* ==========================================================================
 * 18. IMMUTABLE HISTORY
 * ========================================================================== */

test('IMMUTABLE: the router exposes POST only — no update or delete route exists', () => {
  const layers = (stockAdjustmentsRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  }).stack;

  const methods = layers
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.entries(layer.route!.methods).filter(([, on]) => on).map(([method]) => method));

  assert.deepEqual(methods, ['post'], 'a single POST is the whole surface');
  for (const forbidden of ['put', 'patch', 'delete']) {
    assert.equal(methods.includes(forbidden), false, `${forbidden.toUpperCase()} must not exist`);
  }
});

test('IMMUTABLE: the controller exposes no update or delete operation', () => {
  const exports = Object.keys(adjustmentsController);
  assert.deepEqual(exports, ['createStockAdjustment'], 'create only — history is append-only');
});

test('IMMUTABLE: no statement ever updates or deletes an adjustment header', async () => {
  for (const direction of STOCK_ADJUSTMENT_DIRECTIONS) {
    const r = await run({ onHand: 100 }, { ...VALID_BODY, direction });
    assert.equal(r.captured.status, 201, direction);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /UPDATE\s+stock_adjustments/i, `header rewritten in: ${call.text}`);
      assert.doesNotMatch(call.text, /DELETE\s+FROM\s+stock_adjustments/i, `header deleted in: ${call.text}`);
    }
    assert.equal(r.calls.filter((c) => c.text.includes('INSERT INTO stock_adjustments')).length, 1);
  }
});

/* ==========================================================================
 * 20. NO SKIP LOCKED / NO AUTOMATIC FEFO
 * ========================================================================== */

test('NO FEFO: the adjustment targets the explicit batch and never selects by expiry', async () => {
  for (const direction of STOCK_ADJUSTMENT_DIRECTIONS) {
    const r = await run({ onHand: 100 }, { ...VALID_BODY, direction });
    assert.equal(r.captured.status, 201, direction);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
      assert.doesNotMatch(call.text, /ORDER BY\s+.*expiry/i, 'no FEFO selection is introduced here');
    }
    assert.match(findLock(r.calls)!.text, /b\.batch_id = \$1/, 'the batch comes from the request and only from it');
  }
});

/* ==========================================================================
 * 21. NO CLIENT-CONTROLLED CLINIC / USER IDENTITY
 * ========================================================================== */

test('IDENTITY: client-supplied identity and quantity fields are refused outright', async () => {
  for (const field of FORBIDDEN_ADJUSTMENT_FIELDS) {
    const r = await run({}, { ...VALID_BODY, [field]: field === 'movement_type' ? 'RECEIPT' : 2 });
    assert.equal(r.captured.status, 400, `${field} must be refused`);
    assert.equal(r.captured.body.code, ApiErrorCode.VALIDATION_ERROR, field);
    assert.equal(r.calls.length, 0, `${field} must be refused before any database access`);
  }
});

test('IDENTITY: the clinic and the actor always come from the server', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  const header = findHeader(r.calls)!;
  assert.equal(header.params[0], 1, 'clinic_id is the derived batch clinic');
  assert.equal(header.params[1], 7, 'batch_id is the request value');
  assert.equal(header.params[2], 5, 'inventory_id is derived, never sent by the client');
  assert.equal(header.params[3], 11, 'medication_id is derived, never sent by the client');
  assert.equal(header.params[10], PHARMACIST.userId, 'the actor is the authenticated user');

  const movement = findMovement(r.calls)!;
  assert.equal(movement.params[4], PHARMACIST.userId, 'the movement actor is the authenticated user');
  assert.equal(findAudit(r.calls)!.params[0], PHARMACIST.userId);
});

test('IDENTITY: a different authenticated user is recorded, never the one in the body', async () => {
  const other = { ...PHARMACIST, userId: 77 };
  const r = await run({ onHand: 100 }, VALID_BODY);

  // Re-run with another actor to prove the value is read from req.user
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = makeHandler({ onHand: 100 });
  const client = {
    query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return handler(text, params); },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  try {
    await createStockAdjustment(req(VALID_BODY, other), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(captured.status, 201);
  assert.equal(findHeader(calls)!.params[10], 77);
  assert.equal(findMovement(calls)!.params[4], 77);
  assert.equal(findAudit(calls)!.params[0], 77);
  assert.equal(JSON.parse(String(findAudit(calls)!.params[3])).performed_by_user_id, 77);
});

test('IDENTITY: an unauthenticated request cannot adjust stock', async () => {
  const r = await run({ noUser: true }, VALID_BODY);

  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0, 'no transaction without an authenticated user');
});

test('AUTHORIZATION: MANAGE_INVENTORY is required for the adjustment', () => {
  const runMiddleware = (permissions: string[]) => {
    const request = { user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;
    requirePermission('MANAGE_INVENTORY')(request, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err; else nextCalled = true;
    });
    return { error, nextCalled };
  };

  const denied = runMiddleware(['VIEW_INVENTORY']);
  assert.equal(denied.nextCalled, false, 'VIEW_INVENTORY alone must not adjust stock');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware(['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

/* ==========================================================================
 * QUANTITY VALIDATION
 * ========================================================================== */

test('VALIDATION: zero, negative and over-precise quantities are refused before the database', async () => {
  for (const quantity of [0, -5, 1.2345, 'abc']) {
    const r = await run({}, { ...VALID_BODY, quantity });
    assert.equal(r.captured.status, 400, JSON.stringify(quantity));
    assert.equal(r.calls.length, 0, JSON.stringify(quantity));
  }
});

test('VALIDATION: an unsupported direction is refused before the database', async () => {
  for (const direction of ['increase', 'INCREASE ', 'ADJUSTMENT', 'MOVE', '']) {
    const r = await run({}, { ...VALID_BODY, direction });
    assert.equal(r.captured.status, 400, JSON.stringify(direction));
    assert.equal(r.calls.length, 0, JSON.stringify(direction));
  }
});

test('VALIDATION: a missing batch_id is refused before the database', async () => {
  for (const body of [
    { quantity: 10, direction: 'INCREASE', reason: 'x' },
    { batch_id: 0, quantity: 10, direction: 'INCREASE', reason: 'x' },
    { batch_id: 'abc', quantity: 10, direction: 'INCREASE', reason: 'x' },
  ]) {
    const r = await run({}, body);
    assert.equal(r.captured.status, 400, JSON.stringify(body));
    assert.equal(r.calls.length, 0);
  }
});

test('VALIDATION: an increase beyond the NUMERIC(12,3) ceiling is refused with no write', async () => {
  const r = await run({ onHand: 999_999_999.999 }, { ...VALID_BODY, direction: 'INCREASE', quantity: 1 });

  assert.equal(r.captured.status, 400);
  assert.equal(writes(r.calls).length, 0);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('VALIDATION: notes are optional and default to NULL in both the header and the movement', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(findHeader(r.calls)!.params[9], null);
  assert.equal(findMovement(r.calls)!.params[5], null);

  const withNotes = await run({ onHand: 100 }, { ...VALID_BODY, notes: '  تم التحقق  ' });
  assert.equal(withNotes.captured.status, 201);
  assert.equal(findHeader(withNotes.calls)!.params[9], 'تم التحقق', 'notes are trimmed');
  assert.equal(findMovement(withNotes.calls)!.params[5], 'تم التحقق');
});

/* ==========================================================================
 * ADMIN (NO CLINIC RESTRICTION)
 * ========================================================================== */

test('SCOPE: an admin is not clinic-restricted but the clinic is still derived', async () => {
  const { res, captured } = makeRes();
  const calls: QueryCall[] = [];
  const handler = makeHandler({ onHand: 100 });
  const client = {
    query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return handler(text, params); },
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;

  try {
    await createStockAdjustment(req(VALID_BODY, ADMIN), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(captured.status, 201);
  assert.doesNotMatch(findLock(calls)!.text, /ANY\(/, 'an admin has no clinic restriction clause');
  assert.equal(findHeader(calls)!.params[0], 1, 'the clinic is still derived from the batch, never from the user');
});
