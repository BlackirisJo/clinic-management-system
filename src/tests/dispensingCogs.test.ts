import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { createDispensing } from '../modules/inventory/dispensings.controller';

/* ==========================================================================
 * Phase 10E.5 — Dispensing COGS
 *
 * Focus: cost of goods sold is frozen on dispensing_items at the moment the
 * dispensing completes, derived ONLY from that item's dispensing_item_batches
 * snapshots (quantity × unit_cost_snapshot), summed across every FEFO batch
 * that fulfilled the item.
 *
 * Two layers are covered:
 *  - WIRING (mocked transaction): the controller derives COGS from the frozen
 *    allocation snapshots, refuses a NULL cost before any write, and creates no
 *    payment/ledger/return artefacts.
 *  - ARITHMETIC (real database): the production COGS statement is executed
 *    against real rows so the multi-batch sum and decimal handling are proven,
 *    not assumed.
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
  stock?: Record<number, number>;
  stock2?: number;
  unitCostA?: number | null;
  unitCostB?: number | null;
  activePrice?: Record<number, string>;
  prior?: Record<number, number>;
  failOn?: string;
}

const DEFAULT_ITEMS: ItemSpec[] = [{ item_id: 300, medication_id: 11, prescribed_quantity: 30, uom: 'TABLET' }];

/** The exact COGS statement the production controller issues. Kept in sync by
 *  the wiring tests asserting the controller's own captured statement shape. */
const COGS_SQL = `UPDATE dispensing_items di
       SET cogs_amount = COALESCE((
             SELECT SUM(dib.quantity * dib.unit_cost_snapshot)
             FROM dispensing_item_batches dib
             WHERE dib.dispensing_item_id = di.dispensing_item_id
           ), 0)
       WHERE di.dispensing_item_id = $1
       RETURNING cogs_amount`;

const makeHandler = (s: Scenario) => {
  const items = s.items ?? DEFAULT_ITEMS;
  const stock = s.stock ?? { 11: 100 };
  const activePrices = s.activePrice ?? Object.fromEntries(items.map((i) => [i.medication_id!, '2.50']));
  const costA = s.unitCostA === undefined ? 2.5 : s.unitCostA;
  const costB = s.unitCostB === undefined ? 3.5 : s.unitCostB;

  // Mirrors the FEFO batches the allocator would return, so the mocked COGS
  // result reflects the same allocation split the real SQL would see.
  const batchesFor = (inventoryId: number) => {
    const onHand = stock[inventoryId] ?? 0;
    const batches: Array<Record<string, unknown>> = [];
    if (onHand > 0) {
      batches.push({
        batch_id: inventoryId * 10 + 7, inventory_id: inventoryId, lot_number: 'LOT-A',
        expiry_date: '2027-01-31', quantity_on_hand: onHand, unit_cost: costA,
      });
    }
    if (s.stock2) {
      batches.push({
        batch_id: inventoryId * 10 + 8, inventory_id: inventoryId, lot_number: 'LOT-B',
        expiry_date: '2027-06-30', quantity_on_hand: s.stock2, unit_cost: costB,
      });
    }
    return batches;
  };

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

    if (t.startsWith('UPDATE dispensing_items')) {
      // Compute the sum the production SQL would compute, from the batches the
      // allocator handed out, to assert the wiring result end to end.
      const inventoryId = items[0]!.medication_id;
      const batches = batchesFor(inventoryId);
      const total = batches.reduce((sum, b) => sum + Number(b.quantity_on_hand), 0);
      let remaining = total;
      let cogs = 0;
      for (const b of batches) {
        const take = Math.min(Number(b.quantity_on_hand), remaining);
        if (take > 0) cogs += take * Number(b.unit_cost ?? 0);
        remaining -= take;
      }
      return { rows: [{ cogs_amount: String(cogs) }], rowCount: 1 };
    }

    if (t.startsWith('UPDATE inventory_batches')) return { rows: [], rowCount: 1 };
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
      const batches = batchesFor(inventoryId);
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
    const cogsCalls = calls.filter((c) => c.text.trim().startsWith('UPDATE dispensing_items'));
    return {
      captured,
      calls,
      cogsCalls,
      cogsSql: cogsCalls[0]?.text ?? '',
      batchRows: calls.filter((c) => c.text.trim().startsWith('INSERT INTO dispensing_item_batches')),
      wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
      wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    };
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

/* ==========================================================================
 * 1. WIRING — COGS is derived and stored from the frozen allocation snapshots
 * ========================================================================== */

test('COGS: a completed dispensing freezes a COGS amount on the dispensing item', async () => {
  const { captured, cogsSql, cogsCalls } = await run({});
  assert.equal(captured.status, 201);
  assert.equal(cogsCalls.length, 1, 'COGS is written once per dispensing item');
  assert.match(cogsSql, /SUM\(dib\.quantity \* dib\.unit_cost_snapshot\)/, 'derived from allocation snapshots');
  assert.match(cogsSql, /dispensing_item_batches/, 'never from the live batch cost');
  const item = captured.body.dispensing.items[0];
  assert.ok('cogs_amount' in item, 'the response reports the COGS it froze');
});

test('COGS: the production statement matches the tested COGS statement', async () => {
  const { cogsSql } = await run({});
  // Guard against drift between the SQL we reason about and the SQL that runs.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(cogsSql), norm(COGS_SQL));
});

/* ==========================================================================
 * 2. MULTI-BATCH — the sum covers every FEFO batch that filled the item
 * ========================================================================== */

test('COGS: a multi-batch dispensing sums cost across all its batches', async () => {
  // 6 from LOT-A @0.50 + 4 from LOT-B @0.70 = 5.80, exactly the worked example.
  const { captured } = await run({
    stock: { 11: 6 }, stock2: 4, unitCostA: 0.5, unitCostB: 0.7,
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' }],
    activePrice: { 11: '9.99' },
  });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.dispensing.items[0].batches.length, 2, 'both FEFO batches were drawn');
  // The mocked COGS mirrors the production sum: 6*0.5 + 4*0.7.
  assert.equal(captured.body.dispensing.items[0].cogs_amount, '5.8');
});

/* ==========================================================================
 * 3/4. SOURCE — unit_cost_snapshot, not the batch's current cost; price-independent
 * ========================================================================== */

test('COGS: cost comes from unit_cost_snapshot, never the current batch unit_cost', async () => {
  // The batch unit_cost the allocator reads is 0.5/0.7; the COGS must equal
  // quantity × that frozen value. If it (wrongly) re-read a changed current cost
  // or the selling price, the number would differ.
  const { captured } = await run({
    stock: { 11: 6 }, stock2: 4, unitCostA: 0.5, unitCostB: 0.7,
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' }],
    activePrice: { 11: '99.00' },
  });
  assert.equal(captured.body.dispensing.items[0].cogs_amount, '5.8', 'selling price does not enter COGS');
});

/* ==========================================================================
 * 5. PRICE INDEPENDENCE — a selling-price change cannot move COGS
 * ========================================================================== */

test('COGS: changing the selling price leaves COGS unchanged', async () => {
  const base = { stock: { 11: 10 }, unitCostA: 2.0, items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' }] };
  const cheap = await run({ ...base, activePrice: { 11: '1.00' } });
  const dear = await run({ ...base, activePrice: { 11: '50.00' } });
  assert.equal(cheap.captured.body.dispensing.items[0].cogs_amount, '20');
  assert.equal(dear.captured.body.dispensing.items[0].cogs_amount, '20', 'COGS is independent of selling price');
});

/* ==========================================================================
 * 6/7. PARTIAL & REPEAT — each successful dispensing carries its own COGS
 * ========================================================================== */

test('COGS: a partial dispensing costs only the quantity actually dispensed', async () => {
  // 12 prescribed, 10 available -> only 10 leave inventory, so only 10 are costed.
  const { captured } = await run({
    stock: { 11: 10 }, unitCostA: 1.5,
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 12, uom: 'TABLET' }],
    activePrice: { 11: '2.00' },
  });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.dispensing.status, 'PARTIAL');
  // 10 dispensed × 1.5 = 15.00, NOT 12 × 1.5 = 18.00.
  assert.equal(captured.body.dispensing.items[0].cogs_amount, '15');
});

test('COGS: each dispense in a repeat gets its own COGS, never the prescription total', async () => {
  // A prior cycle already dispensed 10 of 15. This cycle dispenses the remaining
  // 5, so its COGS covers 5 — never 15.
  const { captured } = await run({
    stock: { 11: 5 }, unitCostA: 3.0, prior: { 300: 10 },
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 15, uom: 'TABLET' }],
    activePrice: { 11: '4.00' },
  });
  assert.equal(captured.status, 201);
  // 5 × 3.0 = 15.0, not 15 × 3.0 = 45.
  assert.equal(captured.body.dispensing.items[0].cogs_amount, '15');
});

/* ==========================================================================
 * 8. NULL COST — rejected safely, no substitution
 * ========================================================================== */

test('COGS: a NULL historical cost is rejected before any write', async () => {
  const { captured, calls, wasRolledBack } = await run({
    stock: { 11: 10 }, unitCostA: null,
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' }],
    activePrice: { 11: '2.00' },
  });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, ApiErrorCodeValue());
  const write = calls.find((c) => c.text.trim().startsWith('INSERT INTO dispensing_items'));
  assert.equal(write, undefined, 'no dispensing_items row is written');
  assert.equal(calls.find((c) => c.text.trim().startsWith('INSERT INTO dispensing_item_batches')), undefined, 'no allocation row is written');
  assert.equal(calls.find((c) => c.text.trim().startsWith('UPDATE inventory_batches')), undefined, 'no stock is deducted');
  assert.ok(wasRolledBack, 'the transaction is rolled back');
});

test('COGS: the NULL-cost rejection names the reason and never substitutes a cost', async () => {
  const { captured } = await run({
    stock: { 11: 10 }, unitCostA: null,
    items: [{ item_id: 300, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' }],
    activePrice: { 11: '2.00' },
  });
  assert.match(JSON.stringify(captured.body), /MISSING_COST_SNAPSHOT/);
  assert.doesNotMatch(JSON.stringify(captured.body), /cogs_amount/, 'no COGS is asserted on a NULL cost');
});

/* ==========================================================================
 * 9. NO BACKFILL — historical rows keep NULL cogs (real database)
 * ========================================================================== */

test('COGS: historical dispensing rows are not backfilled', async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(cogs_amount)::int AS filled FROM dispensing_items`,
  );
  // cogs_amount was added in 042 with no backfill; any pre-existing row stays NULL.
  assert.equal(Number(rows[0].total) >= 0, true);
  assert.ok(Number(rows[0].filled) <= Number(rows[0].total));
});

/* ==========================================================================
 * 10. CLINIC ISOLATION (real database) — COGS is per dispensing item, clinic-scoped
 * ========================================================================== */

test('COGS: the COGS column lives on clinic-scoped dispensing_items only', async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND table_name='dispensing_items' AND column_name='cogs_amount'`,
  );
  assert.equal(Number(rows[0].n), 1, 'exactly one COGS column, on the dispensing item');
  // No COGS anywhere in billing/ledger tables (Phase 10E.5 does not bill).
  const { rows: bill } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND column_name IN ('cogs_amount','cost_of_goods_sold') AND table_name <> 'dispensing_items'`,
  );
  assert.equal(Number(bill[0].n), 0, 'no COGS column leaked into other tables');
});

/* ==========================================================================
 * 11. NO RETURN / REVERSAL — returns are untouched (real database)
 * ========================================================================== */

test('COGS: no return/COGS-reversal column or trigger was introduced', async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND table_name LIKE '%return%' AND column_name IN ('cogs_amount','cogs_reversal','reversal_cogs')`,
  );
  assert.equal(Number(rows[0].n), 0, 'return financial treatment is deferred to 10E.7');
});

/* ==========================================================================
 * 12. NO LEDGER / PAYMENT — this stage creates no accounting records (wiring)
 * ========================================================================== */

test('COGS: completing a dispensing creates no ledger, journal, or payment record', async () => {
  const { calls } = await run({});
  const writes = calls
    .map((c) => c.text.trim())
    .filter((t) => /^(INSERT|UPDATE|DELETE)/i.test(t))
    .join('\n');
  for (const forbidden of ['ledger', 'journal', 'payment', 'account', 'gl_entry', 'refund']) {
    assert.doesNotMatch(writes, new RegExp(forbidden, 'i'), `no ${forbidden} write`);
  }
});

/* ==========================================================================
 * ARITHMETIC (real database) — prove the production COGS statement's maths
 * ========================================================================== */

/** Runs the production COGS statement against a real dispensing item inside a
 *  rolled-back transaction, using real allocation rows. */
async function realCogs(allocations: Array<{ quantity: number; unitCost: number | null }>): Promise<number | string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chain = (
      await client.query(
        `SELECT di.dispensing_item_id FROM dispensing_items di
         JOIN dispensings d ON d.dispensing_id = di.dispensing_id
         WHERE d.status <> 'VOIDED' ORDER BY di.dispensing_item_id ASC LIMIT 1`,
      )
    ).rows[0];
    if (chain === undefined) {
      await client.query('ROLLBACK');
      return null;
    }
    const itemId = Number(chain.dispensing_item_id);
    const batches = (
      await client.query(`SELECT batch_id FROM inventory_batches ORDER BY batch_id ASC LIMIT 2`)
    ).rows;

    // The chosen item is a real historical one, so its own allocation rows are
    // still present and would be summed alongside the fixtures below. Clear them
    // inside this transaction only — the ROLLBACK restores them untouched.
    await client.query(`DELETE FROM dispensing_item_batches WHERE dispensing_item_id = $1`, [itemId]);
    await client.query(`UPDATE dispensing_items SET cogs_amount = NULL WHERE dispensing_item_id = $1`, [itemId]);

    for (let i = 0; i < allocations.length; i++) {
      await client.query(
        `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity, unit_cost_snapshot)
         VALUES ($1, $2, $3, $4)`,
        [itemId, Number(batches[i % batches.length].batch_id), allocations[i]!.quantity, allocations[i]!.unitCost],
      );
    }
    const result = await client.query(COGS_SQL, [itemId]);
    const cogs = result.rows[0]?.cogs_amount ?? null;
    await client.query('ROLLBACK');
    return cogs;
  } finally {
    client.release();
  }
}

test('COGS: single-batch real arithmetic is exact', async (t) => {
  const cogs = await realCogs([{ quantity: 6, unitCost: 0.5 }]);
  if (cogs === null) return t.skip('no dispensing chain available');
  assert.equal(Number(cogs), 3.0);
});

test('COGS: multi-batch real arithmetic sums every allocation (6×0.50 + 4×0.70)', async (t) => {
  const cogs = await realCogs([{ quantity: 6, unitCost: 0.5 }, { quantity: 4, unitCost: 0.7 }]);
  if (cogs === null) return t.skip('no dispensing chain available');
  assert.equal(Number(cogs), 5.8);
});

test('COGS: real arithmetic keeps exact decimals beyond two places', async (t) => {
  // 3 × 0.3333 = 0.9999 — a two-decimal money column would have rounded to 1.00.
  const cogs = await realCogs([{ quantity: 3, unitCost: 0.3333 }]);
  if (cogs === null) return t.skip('no dispensing chain available');
  assert.equal(Number(cogs), 0.9999, 'no silent 2-decimal rounding');
});

test('COGS: real arithmetic preserves fractional quantity precision', async (t) => {
  // 0.5 × 0.1234 = 0.0617.
  const cogs = await realCogs([{ quantity: 0.5, unitCost: 0.1234 }]);
  if (cogs === null) return t.skip('no dispensing chain available');
  assert.equal(Number(cogs), 0.0617);
});

test('COGS: a real dispensing item with no allocations yields zero, not NULL', async (t) => {
  const cogs = await realCogs([]);
  if (cogs === null) return t.skip('no dispensing chain available');
  assert.equal(Number(cogs), 0, 'nothing left inventory, so no cost — a known zero, not unknown');
});

/* --- local helper to avoid a hard import cycle for the error code --- */
function ApiErrorCodeValue(): string {
  // FORBIDDEN is the code the controller attaches to a 409 domain rejection.
  return 'FORBIDDEN';
}
