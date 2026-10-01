import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createInventoryWriteOff } from '../modules/inventory/writeOffs.controller';
import writeOffsRouter from '../modules/inventory/writeOffs.routes';
import inventoryRouter from '../modules/inventory/inventory.routes';
import * as writeOffsController from '../modules/inventory/writeOffs.controller';
import {
  INVENTORY_WRITE_OFF_TYPES,
  WRITE_OFF_MOVEMENT_TYPE,
  WRITE_OFF_AUDIT_ACTION,
  WRITE_OFF_REFERENCE_TYPE,
  FORBIDDEN_WRITE_OFF_FIELDS,
} from '../validations/writeOff.validation';

/* ==========================================================================
 * Phase 10D.3 — Damage/waste + expiry write-off (direct controller tests, mocked client)
 *
 * Only pool.connect() is stubbed; the whole operation must run in ONE
 * transaction on ONE client, and no write may escape a ROLLBACK.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface Scenario {
  onHand?: number;
  reserved?: number;
  /** (expiry_date < CURRENT_DATE) as the database computed it */
  expired?: boolean;
  expiryDate?: string;
  missing?: boolean;
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
        expiry_date: s.expiryDate ?? '2026-01-01',
        is_expired: s.expired ?? true,
        quantity_on_hand: s.onHand ?? 100,
        quantity_reserved: s.reserved ?? 0,
      }],
      rowCount: 1,
    };
  }
  if (t.startsWith('UPDATE inventory_batches')) {
    return {
      rows: [{ batch_id: 7, quantity_on_hand: params[0], quantity_reserved: s.reserved ?? 0 }],
      rowCount: s.updateRowCount ?? 1,
    };
  }
  if (t.startsWith('INSERT INTO inventory_write_offs')) {
    return { rows: [{ write_off_id: 600, ...paramsToHeaderRow(params) }], rowCount: 1 };
  }
  if (t.startsWith('INSERT INTO stock_movements')) {
    return { rows: [{ movement_id: 850, ...paramsToMovementRow(params) }], rowCount: 1 };
  }
  if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

  throw new Error(`Unexpected query: ${text}`);
};

const paramsToHeaderRow = (params: unknown[]) => ({
  clinic_id: params[0], batch_id: params[1], inventory_id: params[2], medication_id: params[3],
  type: params[4], quantity: params[5], quantity_before: params[6], quantity_after: params[7],
  reason: params[8], notes: params[9], performed_by_user_id: params[10],
});

const paramsToMovementRow = (params: unknown[]) => ({
  batch_id: params[0], movement_type: params[1], quantity: params[2],
  reference_type: params[3], reference_id: params[4],
  performed_by_user_id: params[5], notes: params[6],
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

async function run(scenario: Scenario = {}, body: Record<string, unknown> = {}, user: unknown = PHARMACIST): Promise<Run> {
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
    await createInventoryWriteOff(req(body, scenario.noUser ? {} : user), res);
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

const VALID_BODY = { batch_id: 7, quantity: 10, type: 'WASTE', reason: 'كسر أثناء النقل' };

const find = (calls: QueryCall[], needle: string) => calls.find((c) => c.text.includes(needle));
const findHeader = (calls: QueryCall[]) => find(calls, 'INSERT INTO inventory_write_offs');
const findUpdate = (calls: QueryCall[]) => find(calls, 'UPDATE inventory_batches');
const findMovement = (calls: QueryCall[]) => find(calls, 'INSERT INTO stock_movements');
const findAudit = (calls: QueryCall[]) => find(calls, 'INSERT INTO audit_logs');
const findLock = (calls: QueryCall[]) => find(calls, 'FOR UPDATE OF b');
/** أي كتابة ناتجة عن الفشل تُلغى بالمعاملة — نتحقق من التراجع لا من غياب النداء */
const writes = (calls: QueryCall[]) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text.trim()));

/* ==========================================================================
 * 1-2. WASTE / EXPIRE SUCCESS
 * ========================================================================== */

test('WASTE: a valid damage/loss write-off commits and reports the exact balance', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityBefore, 100);
  assert.equal(r.captured.body.quantityAfter, 90);
  assert.equal(findUpdate(r.calls)!.params[0], 90, 'a write-off only ever subtracts');
  assert.equal(r.wasCommitted, true);
  assert.equal(r.wasRolledBack, false);
});

test('EXPIRE: a valid expiry write-off on an expired batch commits', async () => {
  const r = await run({ onHand: 100, expired: true, expiryDate: '2026-01-01' }, { ...VALID_BODY, type: 'EXPIRE' });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 90);
  assert.equal(findUpdate(r.calls)!.params[0], 90);
  assert.equal(r.wasCommitted, true);
});

/* ==========================================================================
 * 3-4. MOVEMENT TYPE AND POSITIVE QUANTITY
 * ========================================================================== */

test('MOVEMENT: WASTE is recorded as WASTE and EXPIRE as EXPIRE', async () => {
  const waste = await run({ onHand: 100, expired: true }, VALID_BODY);
  assert.equal(waste.captured.status, 201);
  assert.equal(findMovement(waste.calls)!.params[1], 'WASTE');
  assert.equal(waste.captured.body.movement.movement_type, 'WASTE');

  const expire = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type: 'EXPIRE' });
  assert.equal(expire.captured.status, 201);
  assert.equal(findMovement(expire.calls)!.params[1], 'EXPIRE');
  assert.equal(expire.captured.body.movement.movement_type, 'EXPIRE');
});

test('MOVEMENT: both types map to an existing movement type and are never re-signed', async () => {
  assert.deepEqual(Object.keys(WRITE_OFF_MOVEMENT_TYPE).sort(), [...INVENTORY_WRITE_OFF_TYPES].sort());
  assert.equal(WRITE_OFF_MOVEMENT_TYPE.WASTE, 'WASTE');
  assert.equal(WRITE_OFF_MOVEMENT_TYPE.EXPIRE, 'EXPIRE');

  for (const type of INVENTORY_WRITE_OFF_TYPES) {
    const r = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 201, type);
    const movement = findMovement(r.calls)!;
    assert.equal(movement.params[2], 10, type);
    assert.ok(Number(movement.params[2]) > 0, 'a write-off never persists a signed quantity');
  }
});

test('MOVEMENT: the movement references the write-off as INVENTORY_WRITE_OFF', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  const movement = findMovement(r.calls)!;
  assert.equal(movement.params[3], WRITE_OFF_REFERENCE_TYPE, 'reference_type is a server constant');
  assert.doesNotMatch(movement.text, /INVENTORY_WRITE_OFF/, 'the reference is bound, never interpolated');
  assert.equal(movement.params[4], '600', 'reference_id is the write_off_id as text');
  assert.equal(r.captured.body.movement.reference_type, WRITE_OFF_REFERENCE_TYPE);
  assert.equal(r.captured.body.movement.reference_id, '600');
});

/* ==========================================================================
 * 5. EXACT BEFORE/AFTER
 * ========================================================================== */

test('QUANTITY: the header records the exact before/after pair for both types', async () => {
  const waste = await run({ onHand: 100.5 }, { ...VALID_BODY, quantity: 0.25 });
  assert.equal(waste.captured.status, 201);
  assert.equal(Number(waste.captured.body.write_off.quantity_before), 100.5);
  assert.equal(Number(waste.captured.body.write_off.quantity_after), 100.25);

  const expire = await run({ onHand: 100.5, expired: true }, { ...VALID_BODY, type: 'EXPIRE', quantity: 0.25 });
  assert.equal(expire.captured.status, 201);
  assert.equal(Number(expire.captured.body.write_off.quantity_before), 100.5);
  assert.equal(Number(expire.captured.body.write_off.quantity_after), 100.25);
});

test('QUANTITY: fractional arithmetic never leaks a floating-point remainder', async () => {
  const r = await run({ onHand: 0.3 }, { ...VALID_BODY, quantity: 0.1 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 0.2, '0.3 - 0.1 must persist as 0.200');
  assert.equal(findUpdate(r.calls)!.params[0], 0.2);
});

/* ==========================================================================
 * 6-7. MANDATORY, NON-BLANK REASON
 * ========================================================================== */

test('REASON: a missing reason returns 400 with no transaction and no write', async () => {
  for (const body of [
    { batch_id: 7, quantity: 10, type: 'WASTE' },
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

  const padded = await run({}, { ...VALID_BODY, reason: '  كسر  ' });
  assert.equal(padded.captured.status, 201);
  assert.equal(findHeader(padded.calls)!.params[8], 'كسر', 'the reason is trimmed before storage');
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

test('ISOLATION: an out-of-clinic batch produces identical behaviour to a missing one', async () => {
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

test('AVAILABILITY: a write-off beyond the available quantity is rejected with 409', async () => {
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, quantity: 71 });

  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(writes(r.calls).length, 0);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('AVAILABILITY: writing off into the reserved quantity is rejected even though on_hand allows it', async () => {
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, quantity: 80 });

  assert.equal(r.captured.status, 409, 'reserved stock is never silently consumed');
  assert.equal(findUpdate(r.calls), undefined);
});

test('AVAILABILITY: the exact available quantity succeeds and lands on reserved', async () => {
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, quantity: 70 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 30, 'on_hand may fall to reserved, never below it');
  assert.equal(findUpdate(r.calls)!.params[0], 30);
  assert.equal(r.wasCommitted, true);
});

test('AVAILABILITY: the whole on-hand is writable when nothing is reserved', async () => {
  const r = await run({ onHand: 10, reserved: 0 }, { ...VALID_BODY, quantity: 10 });

  assert.equal(r.captured.status, 201);
  assert.equal(r.captured.body.quantityAfter, 0);
});

/* ==========================================================================
 * 12. quantity_reserved IS NEVER WRITTEN
 * ========================================================================== */

test('RESERVED: quantity_reserved is never assigned by any statement', async () => {
  for (const type of INVENTORY_WRITE_OFF_TYPES) {
    const r = await run({ onHand: 100, reserved: 25, expired: true }, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 201, type);
    // The only UPDATE has a SET list of exactly these two columns — reserved is not among them
    const update = findUpdate(r.calls)!;
    assert.match(update.text, /SET\s+quantity_on_hand = \$1, updated_at = NOW\(\)/);
    // The header has no reserved column at all
    assert.doesNotMatch(findHeader(r.calls)!.text, /quantity_reserved/i, 'the header cannot carry a reserved value');
    // It may be READ for the availability rule and by the guard, never bound as a written value
    const header = findHeader(r.calls)!;
    assert.equal(header.params.includes(25), false, 'the reserved value is never written into the header');
  }
});

test('RESERVED: the guarded update can never push on_hand below reserved', async () => {
  const r = await run({ onHand: 100, reserved: 30 }, { ...VALID_BODY, quantity: 70 });

  assert.equal(r.captured.status, 201);
  const update = findUpdate(r.calls)!;
  assert.match(update.text, /b\.quantity_reserved <= \$1/, 'the DB guard enforces reserved <= on_hand');
  assert.match(update.text, /\$1 >= 0/, 'a negative resulting quantity is refused by the DB too');
});

/* ==========================================================================
 * 13-15. TYPE-SPECIFIC EXPIRY RULES
 * ========================================================================== */

test('EXPIRE RULE: a non-expired batch is rejected with 409 and no writes', async () => {
  for (const expiryDate of ['2027-12-31', '2030-01-01']) {
    const r = await run({ onHand: 100, expired: false, expiryDate }, { ...VALID_BODY, type: 'EXPIRE' });
    assert.equal(r.captured.status, 409, expiryDate);
    assert.equal(r.captured.body.code, ApiErrorCode.FORBIDDEN);
    assert.equal(writes(r.calls).length, 0, 'a non-expired batch is never written off as expired');
    assert.equal(r.wasRolledBack, true);
    assert.equal(r.wasCommitted, false);
  }
});

test('EXPIRE RULE: expiry is evaluated by the database as expiry_date < CURRENT_DATE', async () => {
  const r = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type: 'EXPIRE' });

  assert.equal(r.captured.status, 201);
  const lock = findLock(r.calls)!;
  assert.match(lock.text, /\(b\.expiry_date < CURRENT_DATE\) AS is_expired/, 'the rule is the DB rule, not a JS date');
  assert.doesNotMatch(lock.text, /toISOString|new Date/i);
});

test('WASTE RULE: WASTE does not depend on the expiry date at all', async () => {
  for (const expired of [true, false]) {
    const r = await run({ onHand: 100, expired, expiryDate: expired ? '2026-01-01' : '2030-01-01' }, VALID_BODY);
    assert.equal(r.captured.status, 201, `expired=${expired}`);
    assert.equal(r.captured.body.write_off.type, 'WASTE');
    assert.equal(findMovement(r.calls)!.params[1], 'WASTE');
  }
});

test('TYPE RULE: a non-expired batch is never silently converted into an EXPIRE', async () => {
  const r = await run({ onHand: 100, expired: false, expiryDate: '2030-01-01' }, { ...VALID_BODY, type: 'EXPIRE' });

  assert.equal(r.captured.status, 409, 'a future batch must be refused, not reclassified');
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /'WASTE'/, 'no write-off type is substituted behind the caller back');
  }
});

/* ==========================================================================
 * 16. QUARANTINE INTERACTION
 * ========================================================================== */

test('QUARANTINE: an active quarantine never blocks a write-off — both types remove stock', async () => {
  for (const type of INVENTORY_WRITE_OFF_TYPES) {
    const r = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 201, type);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /batch_quarantines/i, 'quarantine is neither read nor modified here');
    }
  }
});

test('QUARANTINE: no quarantine record is created or released by this operation', async () => {
  const r = await run({ onHand: 100, expired: true }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /INSERT INTO batch_quarantines/i);
    assert.doesNotMatch(call.text, /UPDATE batch_quarantines/i);
    assert.doesNotMatch(call.text, /DELETE FROM batch_quarantines/i);
  }
});

/* ==========================================================================
 * 17-20. TRANSACTION INTEGRITY AND ROLLBACKS
 * ========================================================================== */

test('ROLLBACK: a zero-row guarded update rolls back the header and writes nothing else', async () => {
  const r = await run({ onHand: 100, updateRowCount: 0 }, VALID_BODY);

  assert.equal(r.captured.status, 409);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
  assert.equal(findMovement(r.calls), undefined, 'no movement survives a lost guard');
  assert.equal(findAudit(r.calls), undefined, 'no audit survives a lost guard');
  const rollbackIndex = r.calls.findIndex((c) => c.text === 'ROLLBACK');
  const headerIndex = r.calls.findIndex((c) => c.text.includes('INSERT INTO inventory_write_offs'));
  const updateIndex = r.calls.findIndex((c) => c.text.includes('UPDATE inventory_batches'));
  assert.ok(headerIndex < updateIndex, 'the header is written before the guarded update');
  assert.ok(rollbackIndex > updateIndex, 'the rollback undoes the header and the update');
});

test('ROLLBACK: a header insert failure writes nothing at all', async () => {
  const r = await run({ failOn: 'INSERT INTO inventory_write_offs' }, VALID_BODY);

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
  assert.ok(rollbackIndex > r.calls.findIndex((c) => c.text.includes('INSERT INTO inventory_write_offs')));
});

test('ROLLBACK: internal SQL errors are never exposed to the client', async () => {
  const r = await run({ failOn: 'INSERT INTO audit_logs' }, VALID_BODY);

  assert.equal(r.captured.status, 500);
  assert.equal(r.captured.body.code, ApiErrorCode.INTERNAL_ERROR);
  assert.doesNotMatch(JSON.stringify(r.captured.body), /XX000|simulated|INSERT INTO/);
});

test('TRANSACTION: a DB constraint violation is reported, not bypassed', async () => {
  const r = await run({ failOn: 'INSERT INTO stock_movements' }, VALID_BODY);
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
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
  assert.match(order[1]!.text, /INSERT INTO inventory_write_offs/, '2) header');
  assert.match(order[2]!.text, /UPDATE inventory_batches/, '3) guarded quantity update');
  assert.match(order[3]!.text, /INSERT INTO stock_movements/, '4) movement');
  assert.match(order[4]!.text, /INSERT INTO audit_logs/, '5) audit');
});

test('TRANSACTION: no write is issued before validation completes', async () => {
  // Every rejection path must be a pure read + ROLLBACK
  for (const [scenario, body] of [
    [{ missing: true }, VALID_BODY],
    [{ onHand: 100, reserved: 95 }, VALID_BODY],
    [{ onHand: 100, expired: false }, { ...VALID_BODY, type: 'EXPIRE' }],
  ] as const) {
    const r = await run(scenario, body);
    assert.ok(r.captured.status >= 400, JSON.stringify(scenario));
    assert.equal(writes(r.calls).length, 0, `a write escaped validation in ${JSON.stringify(scenario)}`);
    assert.equal(r.wasCommitted, false);
  }
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

test('LOCKING: the guarded update verifies batch, quantity, reservation and the derived clinic', async () => {
  const r = await run({ onHand: 100, reserved: 10 }, { ...VALID_BODY, quantity: 40 });

  assert.equal(r.captured.status, 201);
  const update = findUpdate(r.calls)!;
  assert.match(update.text, /b\.batch_id = \$2/, 'the batch id is part of the guard');
  assert.match(update.text, /b\.quantity_on_hand = \$3/, 'the quantity read under the lock is part of the guard');
  assert.match(update.text, /b\.quantity_reserved = \$6/, 'the reservation read under the lock is part of the guard');
  assert.deepEqual(update.params.slice(0, 6), [60, 7, 100, 5, 1, 10], 'after, batch, on_hand, inventory, clinic, reserved');
  assert.deepEqual(update.params[6], [1], 'the clinic scope is re-applied to the derived clinic');
});

test('LOCKING: all statements are parameterised — no value is interpolated into SQL', async () => {
  const r = await run({ onHand: 100 }, { ...VALID_BODY, reason: "'; DROP TABLE inventory_write_offs; --" });

  assert.equal(r.captured.status, 201);
  for (const call of r.calls) {
    assert.doesNotMatch(call.text, /DROP TABLE/, 'user input must never reach the SQL text');
  }
  assert.equal(findHeader(r.calls)!.params[8], "'; DROP TABLE inventory_write_offs; --");
});

/* ==========================================================================
 * 21. AUDIT
 * ========================================================================== */

test('AUDIT: WASTE is audited as STOCK_WASTED and EXPIRE as STOCK_EXPIRED', async () => {
  for (const type of INVENTORY_WRITE_OFF_TYPES) {
    const r = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 201, type);

    const audits = r.calls.filter((c) => c.text.includes('INSERT INTO audit_logs'));
    assert.equal(audits.length, 1, 'exactly one audit row per write-off');

    const audit = audits[0]!;
    assert.equal(audit.params[2], WRITE_OFF_AUDIT_ACTION[type], `${type} must have its own audit action`);
    assert.match(audit.text, /'INVENTORY_WRITE_OFF'/);
    assert.doesNotMatch(audit.text, /'STOCK_WASTED'|'STOCK_EXPIRED'/, 'the action is bound, never interpolated');
    assert.equal(audit.params[0], PHARMACIST.userId, 'the audit actor is the authenticated user');
    assert.equal(audit.params[1], 1, 'the audit clinic is the derived one');
    assert.equal(audit.params[3], '600', 'the audit resource is the write-off');
  }
});

test('AUDIT: the metadata carries the full before/after and identity picture', async () => {
  const r = await run(
    { onHand: 100, reserved: 20, expired: true, expiryDate: '2026-01-01' },
    { ...VALID_BODY, type: 'EXPIRE', quantity: 30, reason: 'انتهاء صلاحية', notes: 'جرد المستودع' },
  );

  assert.equal(r.captured.status, 201);
  const metadata = JSON.parse(String(findAudit(r.calls)!.params[4]));

  for (const key of [
    'write_off_id', 'clinic_id', 'batch_id', 'inventory_id', 'medication_id', 'type',
    'quantity', 'reason', 'notes', 'before_quantity', 'after_quantity',
    'available_before', 'performed_by_user_id',
  ]) {
    assert.ok(key in metadata, `metadata must include ${key}`);
  }
  assert.equal(metadata.write_off_id, 600);
  assert.equal(metadata.clinic_id, 1);
  assert.equal(metadata.batch_id, 7);
  assert.equal(metadata.inventory_id, 5);
  assert.equal(metadata.medication_id, 11);
  assert.equal(metadata.type, 'EXPIRE');
  assert.equal(metadata.quantity, 30);
  assert.equal(metadata.reason, 'انتهاء صلاحية');
  assert.equal(metadata.notes, 'جرد المستودع');
  assert.equal(metadata.before_quantity, 100);
  assert.equal(metadata.after_quantity, 70);
  assert.equal(metadata.available_before, 80, 'available excludes the reserved quantity');
  assert.equal(metadata.performed_by_user_id, PHARMACIST.userId);
  assert.equal(metadata.movement_type, 'EXPIRE');
  assert.equal(metadata.expiry_date, '2026-01-01');
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
 * 22. IMMUTABLE HISTORY
 * ========================================================================== */

test('IMMUTABLE: the router exposes POST only — no update or delete route exists', () => {
  const layers = (writeOffsRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  }).stack;

  const methods = layers
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.entries(layer.route!.methods).filter(([, on]) => on).map(([method]) => method));

  assert.deepEqual(methods, ['post'], 'a single POST is the whole surface');
  for (const forbidden of ['put', 'patch', 'delete', 'get']) {
    assert.equal(methods.includes(forbidden), false, `${forbidden.toUpperCase()} must not exist`);
  }
});

test('IMMUTABLE: the controller exposes no read, update or delete operation', () => {
  assert.deepEqual(Object.keys(writeOffsController), ['createInventoryWriteOff'], 'create only — history is append-only');
});

test('ROUTING: the write-off mount is registered before the broader /api/inventory mount', async () => {
  // /api/inventory/write-offs is narrower than /api/inventory. Express takes the
  // first matching mount, so the write-off router must be registered first.
  const { default: app } = await import('../app');
  const stack = ((app as any).router ?? (app as any)._router).stack as { handle: unknown }[];
  const indexOf = (target: unknown) => stack.findIndex((layer) => layer.handle === target);

  const writeOffsIndex = indexOf(writeOffsRouter);
  const inventoryIndex = indexOf(inventoryRouter);
  assert.ok(writeOffsIndex >= 0, 'the write-off router must be mounted on the app');
  assert.ok(inventoryIndex >= 0, 'the inventory router must be mounted on the app');
  assert.ok(writeOffsIndex < inventoryIndex, 'the narrower path must be registered first');
});

test('ROUTING: the inventory router has no route that can swallow POST /write-offs', () => {
  const routes = (inventoryRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  }).stack.filter((layer) => layer.route);

  // Only "POST /" exists — there is no "POST /:id", so /write-offs falls through
  const postPaths = routes
    .filter((layer) => layer.route!.methods.post)
    .map((layer) => layer.route!.path);
  assert.deepEqual(postPaths, ['/']);
});

test('IMMUTABLE: no statement ever updates or deletes a write-off header', async () => {
  for (const type of INVENTORY_WRITE_OFF_TYPES) {
    const r = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 201, type);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /UPDATE\s+inventory_write_offs/i, `header rewritten in: ${call.text}`);
      assert.doesNotMatch(call.text, /DELETE\s+FROM\s+inventory_write_offs/i, `header deleted in: ${call.text}`);
    }
    assert.equal(r.calls.filter((c) => c.text.includes('INSERT INTO inventory_write_offs')).length, 1);
  }
});

/* ==========================================================================
 * 24. NO SKIP LOCKED / NO FEFO
 * ========================================================================== */

test('NO FEFO: the write-off targets the explicit batch and never selects by expiry', async () => {
  for (const type of INVENTORY_WRITE_OFF_TYPES) {
    const r = await run({ onHand: 100, expired: true }, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 201, type);
    for (const call of r.calls) {
      assert.doesNotMatch(call.text, /SKIP\s+LOCKED/i);
      assert.doesNotMatch(call.text, /ORDER BY\s+.*expiry/i, 'no FEFO selection is introduced here');
    }
    assert.match(findLock(r.calls)!.text, /b\.batch_id = \$1/, 'the batch comes from the request and only from it');
  }
});

/* ==========================================================================
 * 25. NO CLIENT-CONTROLLED IDENTITY / DERIVED FIELDS
 * ========================================================================== */

test('IDENTITY: client-supplied identity and derived fields are refused outright', async () => {
  for (const field of FORBIDDEN_WRITE_OFF_FIELDS) {
    const r = await run({}, { ...VALID_BODY, [field]: field === 'movement_type' || field === 'reference_type' ? 'RECEIPT' : 2 });
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
  assert.equal(header.params[4], 'WASTE', 'type is the request value, mapped server-side');
  assert.equal(header.params[10], PHARMACIST.userId, 'the actor is the authenticated user');

  const movement = findMovement(r.calls)!;
  assert.equal(movement.params[5], PHARMACIST.userId, 'the movement actor is the authenticated user');
  assert.equal(findAudit(r.calls)!.params[0], PHARMACIST.userId);
});

test('IDENTITY: a different authenticated user is recorded, never the one in the body', async () => {
  const other = { ...PHARMACIST, userId: 77 };
  const r = await run({ onHand: 100 }, VALID_BODY, other);

  assert.equal(r.captured.status, 201);
  assert.equal(findHeader(r.calls)!.params[10], 77);
  assert.equal(findMovement(r.calls)!.params[5], 77);
  assert.equal(findAudit(r.calls)!.params[0], 77);
  assert.equal(JSON.parse(String(findAudit(r.calls)!.params[4])).performed_by_user_id, 77);
});

test('IDENTITY: an unauthenticated request cannot write off stock', async () => {
  const r = await run({ noUser: true }, VALID_BODY);

  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0, 'no transaction without an authenticated user');
});

test('AUTHORIZATION: MANAGE_INVENTORY is required for the write-off', () => {
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
  assert.equal(denied.nextCalled, false, 'VIEW_INVENTORY alone must not write off stock');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware(['VIEW_INVENTORY', 'MANAGE_INVENTORY']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true);
});

/* ==========================================================================
 * QUANTITY AND TYPE VALIDATION
 * ========================================================================== */

test('VALIDATION: zero, negative and over-precise quantities are refused before the database', async () => {
  for (const quantity of [0, -5, 1.2345, 'abc']) {
    const r = await run({}, { ...VALID_BODY, quantity });
    assert.equal(r.captured.status, 400, JSON.stringify(quantity));
    assert.equal(r.calls.length, 0, JSON.stringify(quantity));
  }
});

test('VALIDATION: an unsupported type is refused before the database', async () => {
  for (const type of ['waste', 'WASTE ', 'EXPIRED', 'RETURN', '']) {
    const r = await run({}, { ...VALID_BODY, type });
    assert.equal(r.captured.status, 400, JSON.stringify(type));
    assert.equal(r.calls.length, 0, JSON.stringify(type));
  }
});

test('VALIDATION: a missing batch_id is refused before the database', async () => {
  for (const body of [
    { quantity: 10, type: 'WASTE', reason: 'x' },
    { batch_id: 0, quantity: 10, type: 'WASTE', reason: 'x' },
    { batch_id: 'abc', quantity: 10, type: 'WASTE', reason: 'x' },
  ]) {
    const r = await run({}, body);
    assert.equal(r.captured.status, 400, JSON.stringify(body));
    assert.equal(r.calls.length, 0);
  }
});

test('VALIDATION: notes are optional and default to NULL in both the header and the movement', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY);

  assert.equal(r.captured.status, 201);
  assert.equal(findHeader(r.calls)!.params[9], null);
  assert.equal(findMovement(r.calls)!.params[6], null);

  const withNotes = await run({ onHand: 100 }, { ...VALID_BODY, notes: '  تم التحقق  ' });
  assert.equal(withNotes.captured.status, 201);
  assert.equal(findHeader(withNotes.calls)!.params[9], 'تم التحقق', 'notes are trimmed');
  assert.equal(findMovement(withNotes.calls)!.params[6], 'تم التحقق');
});

/* ==========================================================================
 * ADMIN (NO CLINIC RESTRICTION)
 * ========================================================================== */

test('SCOPE: an admin is not clinic-restricted but the clinic is still derived', async () => {
  const r = await run({ onHand: 100 }, VALID_BODY, ADMIN);

  assert.equal(r.captured.status, 201);
  assert.doesNotMatch(findLock(r.calls)!.text, /ANY\(/, 'an admin has no clinic restriction clause');
  assert.equal(findHeader(r.calls)!.params[0], 1, 'the clinic is still derived from the batch, never from the user');
});
