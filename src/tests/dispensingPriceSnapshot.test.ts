import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createDispensing } from '../modules/inventory/dispensings.controller';

/* ==========================================================================
 * Phase 10E.3 — Dispensing financial snapshot
 *
 * Focus: the SELLING price is frozen on dispensing_items at the moment of the
 * dispensing, inside the same transaction, and is never rewritten afterwards.
 * The historical cost snapshot on dispensing_item_batches is untouched.
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

interface ItemSpec {
  item_id: number;
  medication_id: number;
  prescribed_quantity: number | null;
  uom: string | null;
}

interface Scenario {
  items?: ItemSpec[];
  prior?: Record<number, number>;
  stock?: Record<number, number>;
  /** second FEFO batch, to exercise multi-batch dispensing */
  stock2?: number;
  /** inventory_id -> active unit_price; absent = no active price */
  activePrice?: Record<number, string>;
  failOn?: string;
  deductRowCount?: number;
}

const DEFAULT_ITEMS: ItemSpec[] = [{ item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'TABLET' }];

const makeHandler = (s: Scenario) => {
  const items = s.items ?? DEFAULT_ITEMS;
  const stock = s.stock ?? { 11: 100 };
  const activePrices = s.activePrice ?? Object.fromEntries(items.map((i) => [i.medication_id, '2.50']));

  return (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();

    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

    if (s.failOn && t.includes(s.failOn)) {
      throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
    }

    if (t.startsWith('INSERT INTO dispensings')) {
      return { rows: [{ dispensing_id: 900, prescription_id: 100, clinic_id: 1, patient_id: 200, status: 'COMPLETED' }], rowCount: 1 };
    }
    if (t.startsWith('INSERT INTO dispensing_items')) {
      return { rows: [{ dispensing_item_id: 901 + Number(params[1]) }], rowCount: 1 };
    }
    if (t.startsWith('INSERT INTO dispensing_item_batches')) return { rows: [], rowCount: 1 };
    if (t.startsWith('UPDATE dispensing_items')) return { rows: [{ cogs_amount: '0' }], rowCount: 1 };
    if (t.startsWith('UPDATE inventory_batches')) return { rows: [], rowCount: s.deductRowCount ?? 1 };
    if (t.startsWith('INSERT INTO stock_movements')) return { rows: [], rowCount: 1 };
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

    if (t.includes('FROM prescriptions p')) {
      if (params.some((p) => Array.isArray(p) && p.length === 0)) return { rows: [], rowCount: 0 };
      return { rows: [{ prescription_id: 100, patient_id: 200, clinic_id: 1 }], rowCount: 1 };
    }
    if (t.includes('FROM prescription_items pi')) {
      return {
        rows: items.map((i) => ({
          item_id: i.item_id, medication_id: i.medication_id,
          prescribed_quantity: i.prescribed_quantity, uom: i.uom, dosage: '1 x 3',
        })),
        rowCount: items.length,
      };
    }
    if (t.includes('FROM dispensing_items di')) {
      const rows = Object.entries(s.prior ?? {}).map(([id, qty]) => ({
        prescription_item_id: Number(id), cycle_index: 0, status: 'PARTIAL', dispensed_quantity: qty,
      }));
      return { rows, rowCount: rows.length };
    }
    if (t.includes('FROM inventory_items')) {
      const medicationId = Number(params[0]);
      return { rows: [{ inventory_id: medicationId, uom: 'TABLET' }], rowCount: 1 };
    }
    if (t.includes('FROM medication_prices mp')) {
      const requested = (params[0] as number[]) ?? [];
      const rows = requested
        .filter((inventoryId) => activePrices[inventoryId] !== undefined)
        .map((inventoryId) => ({ inventory_id: inventoryId, unit_price: activePrices[inventoryId] }));
      return { rows, rowCount: rows.length };
    }
    if (t.includes('FOR UPDATE OF b')) {
      const inventoryId = Number(params[0]);
      const onHand = stock[inventoryId] ?? 0;
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
      itemRows: calls.filter((c) => c.text.trim().startsWith('INSERT INTO dispensing_items')),
      batchRows: calls.filter((c) => c.text.trim().startsWith('INSERT INTO dispensing_item_batches')),
      movements: calls.filter((c) => c.text.trim().startsWith('INSERT INTO stock_movements')),
      priceLocks: calls.filter((c) => c.text.includes('FROM medication_prices mp')),
    };
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

/* ==========================================================================
 * 1. SNAPSHOT STORED — the active price lands on dispensing_items
 * ========================================================================== */

test('SNAPSHOT: a dispensing with an active price stores that exact price', async () => {
  const { captured, itemRows } = await run({ activePrice: { 11: '3.25' } });

  assert.equal(captured.status, 201);
  assert.equal(itemRows.length, 1);

  // unit_price_snapshot is the 10th bound value on the dispensing_items insert
  assert.match(itemRows[0]!.text, /unit_price_snapshot/, 'the column is written');
  assert.equal(itemRows[0]!.params[9], '3.25', 'the frozen value is the active price');

  // The response reports the same frozen amount
  assert.equal(captured.body.dispensing.items[0].unit_price_snapshot, '3.25');
});

test('SNAPSHOT: the audit metadata records the frozen price per item', async () => {
  const { calls } = await run({ activePrice: { 11: '4.50' } });
  const audit = calls.find((c) => c.text.trim().startsWith('INSERT INTO audit_logs'))!;

  assert.ok(audit, 'the audit row exists');
  const metadata = JSON.parse(audit.params[3] as string);
  assert.equal(metadata.items[0].unit_price_snapshot, '4.50');
});

test('SNAPSHOT: a zero price is frozen as 0.00, not treated as missing', async () => {
  const { captured, itemRows } = await run({ activePrice: { 11: '0.00' } });

  assert.equal(captured.status, 201, 'free medication still dispenses');
  assert.equal(itemRows[0]!.params[9], '0.00');
});

/* ==========================================================================
 * 2. MISSING ACTIVE PRICE — refuse with zero side effects
 * ========================================================================== */

test('MISSING PRICE: a medication with no active price blocks the dispensing', async () => {
  const { captured, writes, wasRolledBack, wasCommitted, itemRows, batchRows, movements } = await run({
    activePrice: {}, // no active price for inventory 11
  });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.match(captured.body.message, /سعر بيع/);

  // لا خصم، ولا سجل صرف، ولا حركة، ولا تدقيق
  assert.deepEqual(writes, [], 'no write of any kind escapes');
  assert.equal(itemRows.length, 0, 'no dispensing_items row');
  assert.equal(batchRows.length, 0, 'no allocation row');
  assert.equal(movements.length, 0, 'no stock movement');
  // No stock deduction, no audit side effect
  const asStrings: string[] = writes as unknown as string[];
  assert.ok(!asStrings.some((w) => w.startsWith('INSERT INTO audit_logs')), 'no audit side effect');
  assert.ok(!asStrings.some((w) => w.startsWith('UPDATE inventory_batches')), 'no stock deduction');
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('MISSING PRICE: the rejection names the reason and the unpriced items', async () => {
  const { captured } = await run({ activePrice: {} });

  assert.equal(captured.body.reason, 'MISSING_SELLING_PRICE');
  assert.deepEqual(captured.body.inventory_ids, [11]);
});

test('MISSING PRICE: one unpriced item blocks the whole prescription atomically', async () => {
  const items: ItemSpec[] = [
    { item_id: 300, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' },
    { item_id: 301, medication_id: 12, prescribed_quantity: 10, uom: 'TABLET' },
  ];
  const { captured, writes, itemRows } = await run({
    items,
    stock: { 11: 100, 12: 100 },
    // 11 is priced, 12 is not
    activePrice: { 11: '2.00' },
  });

  assert.equal(captured.status, 409, 'a partially-priced prescription is refused, not half-dispensed');
  assert.deepEqual(captured.body.inventory_ids, [12]);
  assert.deepEqual(writes, [], 'no line is written when any line is unpriced');
  assert.equal(itemRows.length, 0);
});

/* ==========================================================================
 * 3. PRICE CHANGES AFTER THE FACT
 * ========================================================================== */

test('PRICE HISTORY: a later price change does not alter an earlier snapshot', async () => {
  // First dispensing: the price in force at that moment
  const first = await run({ activePrice: { 11: '2.00' } });
  assert.equal(first.captured.status, 201);
  assert.equal(first.itemRows[0]!.params[9], '2.00');

  // The price is then changed to something else. The stored snapshot is a
  // written value on the dispensing row — nothing rewrites it.
  const afterChange = await run({ activePrice: { 11: '9.99' } });
  assert.equal(afterChange.itemRows[0]!.params[9], '9.99', 'the NEW dispensing uses the new price');

  // The first row's value was never re-issued: the first insert still carried 2.00
  assert.equal(first.itemRows[0]!.params[9], '2.00', 'the earlier snapshot is untouched');
});

test('PRICE HISTORY: no code path ever UPDATEs unit_price_snapshot', async () => {
  const { calls } = await run({ activePrice: { 11: '5.00' } });

  for (const call of calls) {
    const t = call.text.trim();
    if (!t.startsWith('UPDATE')) continue;
    assert.ok(
      !t.includes('dispensing_items') || !/unit_price_snapshot\s*=/.test(t),
      'unit_price_snapshot is never assigned outside the INSERT',
    );
  }
});

/* ==========================================================================
 * 4. PARTIAL / REPEAT DISPENSING
 * ========================================================================== */

test('PARTIAL: a later partial dispensing snapshots the then-current price', async () => {
  // 30 prescribed, 10 already given, but only 5 on hand — so each run is a
  // genuine partial dispensing that leaves the cycle open.
  const first = await run({
    activePrice: { 11: '2.00' },
    prior: { 300: 10 },
    stock: { 11: 5 },
  });
  assert.equal(first.captured.status, 201);
  assert.equal(first.captured.body.dispensing.status, 'PARTIAL');
  assert.equal(first.captured.body.dispensing.items[0].dispensed_quantity, 5);
  assert.equal(first.captured.body.dispensing.items[0].remaining_quantity, 15);
  assert.equal(first.itemRows[0]!.params[9], '2.00');

  // The price moves, then the remainder is dispensed
  const second = await run({
    activePrice: { 11: '7.75' },
    prior: { 300: 15 },
    stock: { 11: 5 },
  });
  assert.equal(second.captured.status, 201);
  assert.equal(second.itemRows[0]!.params[9], '7.75', 'the repeat snapshots the current price');

  // Neither row was modified by the other
  assert.equal(first.itemRows[0]!.params[9], '2.00');
});

/* ==========================================================================
 * 5. MULTI-BATCH — one selling price per dispensing item
 * ========================================================================== */

test('MULTI-BATCH: several FEFO batches still store exactly one selling-price snapshot', async () => {
  const { captured, itemRows, batchRows } = await run({
    activePrice: { 11: '6.00' },
    stock: { 11: 20 },
    stock2: 30,
  });

  assert.equal(captured.status, 201);
  assert.equal(itemRows.length, 1, 'one dispensing item');
  assert.equal(itemRows[0]!.params[9], '6.00', 'one selling price for the item');

  assert.equal(batchRows.length, 2, 'the item was filled from two batches');
  for (const batch of batchRows) {
    assert.ok(
      !batch.text.includes('unit_price'),
      'the selling price is NOT duplicated into dispensing_item_batches',
    );
  }

  // The cost snapshot on each allocation is still there and unchanged
  for (const batch of batchRows) {
    assert.match(batch.text, /unit_cost_snapshot/, 'the historical cost stays per batch');
  }
});

/* ==========================================================================
 * 6. TRANSACTION INTEGRITY
 * ========================================================================== */

test('TRANSACTION: the price is locked inside the dispensing transaction, before writes', async () => {
  const { calls, wasCommitted } = await run({ activePrice: { 11: '3.00' } });

  const beginIndex = calls.findIndex((c) => c.text === 'BEGIN');
  const lockIndex = calls.findIndex((c) => c.text.includes('FROM medication_prices mp'));
  const itemIndex = calls.findIndex((c) => c.text.trim().startsWith('INSERT INTO dispensing_items'));
  const commitIndex = calls.findIndex((c) => c.text === 'COMMIT');

  assert.equal(wasCommitted, true);
  assert.ok(beginIndex >= 0 && beginIndex < lockIndex, 'the lock is inside the transaction');
  assert.ok(lockIndex < itemIndex, 'the price is frozen before the row is written');
  assert.ok(itemIndex < commitIndex, 'and committed in the same transaction');

  const lock = calls[lockIndex]!;
  assert.match(lock.text, /FOR UPDATE/, 'the price row is locked, not merely read');
  assert.ok(!/SKIP LOCKED/i.test(lock.text), 'no SKIP LOCKED: a pending price change is awaited');
});

test('TRANSACTION: the price lookup is scoped to the authorized inventory item', async () => {
  const { priceLocks } = await run({ activePrice: { 11: '2.50' } });

  assert.equal(priceLocks.length, 1);
  const lock = priceLocks[0]!;
  assert.match(lock.text, /mp\.inventory_id = ANY\(\$1::int\[\]\)/, 'scoped by inventory id only');
  assert.match(lock.text, /mp\.is_active/, 'only the active price is read');
  assert.deepEqual(lock.params[0], [11], 'the ids come from the resolved inventory items');
});

test('TRANSACTION: no client clinic_id or price_id reaches the lookup', async () => {
  const { captured, priceLocks } = await run(
    { activePrice: { 11: '2.50' } },
    // A hostile body tries to dictate the price source
    { prescription_id: 100, clinic_id: 2, price_id: 999, unit_price: 0.01 },
  );

  assert.equal(captured.status, 201, 'extra fields cannot redirect the price');
  const lock = priceLocks[0]!;
  assert.ok(!lock.text.includes('clinic_id'), 'the lookup is not clinic-filtered from the body');
  assert.deepEqual(lock.params[0], [11]);
});

test('TRANSACTION: a failure after the snapshot leaves nothing behind', async () => {
  const { captured, wasRolledBack, wasCommitted, itemRows, movements } = await run({
    activePrice: { 11: '2.50' },
    failOn: 'INSERT INTO stock_movements',
  });

  assert.notEqual(captured.status, 201, 'the dispensing failed');
  assert.equal(wasRolledBack, true, 'the whole transaction rolled back');
  assert.equal(wasCommitted, false);
  assert.equal(itemRows.length, 1, 'the insert was issued...');
  assert.equal(movements.length, 1, '...and then the failure hit');
});

/* ==========================================================================
 * 7. NO FINANCIAL DOCUMENTS — the 10E.3 boundary
 * ========================================================================== */

test('BOUNDARY: the snapshot creates no invoice, invoice item, or payment', async () => {
  const { calls } = await run({ activePrice: { 11: '2.50' } });

  for (const call of calls) {
    assert.ok(!/INSERT INTO invoices/i.test(call.text), 'no invoice');
    assert.ok(!/INSERT INTO invoice_items/i.test(call.text), 'no invoice line');
  }
});

test('BOUNDARY: the snapshot writes only dispensing tables', async () => {
  const { calls } = await run({ activePrice: { 11: '2.50' } });

  const written = new Set<string>();
  for (const call of calls) {
    const t = call.text.trim();
    const match = /^(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(t);
    if (match) written.add(match[1]!.toLowerCase());
  }

  for (const forbidden of ['invoices', 'invoice_items', 'medication_prices', 'clinic_services']) {
    assert.ok(!written.has(forbidden), `${forbidden} must not be written by a dispensing snapshot`);
  }

  assert.ok(written.has('dispensing_items'), 'the snapshot lands on dispensing_items');
});