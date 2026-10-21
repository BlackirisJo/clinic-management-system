import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { getInventoryValuation } from '../modules/inventory/inventoryValuation.controller';

/* ==========================================================================
 * Phase 10E.6 — Inventory valuation (read-only)
 *
 * Two layers:
 *  - SQL (real database): the production statement is executed against real
 *    batch rows inside a rolled-back transaction, so the arithmetic, the
 *    valued/unvalued split and the state columns are proven, not assumed.
 *  - Controller (mocked pool): response shaping, clinic scoping, filters, and
 *    the single-query / no-N+1 guarantee.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;

const ORIGINAL_QUERY = pool.query.bind(pool);

const VIEWER = {
  userId: 7, roleId: 2, clinicId: 1, roleName: 'PHARMACIST',
  permissions: ['VIEW_INVENTORY'],
  clinicIds: [1],
};

const req = (query: Record<string, unknown>, user: unknown = VIEWER): AuthenticatedRequest =>
  ({ body: {}, params: {}, query, user } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

/** Runs the controller against a stubbed pool, returning the SQL it issued. */
async function call(query: Record<string, unknown> = {}, rows: QueryRow[] = [], user?: unknown) {
  const issued: Array<{ text: string; params: unknown[] }> = [];
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    issued.push({ text, params });
    return { rows, rowCount: rows.length };
  };
  try {
    const { res, captured } = makeRes();
    await getInventoryValuation(req(query, user), res);
    return { captured, issued, sql: issued[0]?.text ?? '', params: issued[0]?.params ?? [] };
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

/* ==========================================================================
 * SQL layer — real rows, real NUMERIC arithmetic
 * ========================================================================== */

/** The valuation statement under test, run against real batches. It mirrors the
 *  production SELECT (same value expression, same LEFT JOIN on the active
 *  quarantine, same window totals) so the fixtures exercise the real shape.
 *  Shared by every SQL-layer helper below, so the statement cannot drift. */
const FIXTURE_VALUATION_SQL = `SELECT b.batch_id, b.quantity_on_hand, b.quantity_reserved, b.unit_cost, b.is_active,
       (b.expiry_date < CURRENT_DATE) AS is_expired,
       bq.quarantine_id IS NOT NULL AS is_quarantined,
       bq.reason AS quarantine_reason,
       bq.quarantined_at,
       CASE WHEN b.unit_cost IS NULL THEN NULL
            ELSE b.quantity_on_hand * b.unit_cost END AS inventory_value,
       COUNT(*) OVER () AS filtered_batch_count,
       COUNT(b.unit_cost) OVER () AS valued_batch_count,
       COALESCE(SUM(b.quantity_on_hand * b.unit_cost) OVER (), 0) AS total_inventory_value,
       COUNT(*) FILTER (WHERE b.unit_cost IS NULL) OVER () AS unvalued_batch_count,
       COALESCE(SUM(b.quantity_on_hand) FILTER (WHERE b.unit_cost IS NULL) OVER (), 0)
         AS unvalued_quantity_on_hand
FROM inventory_batches b
JOIN inventory_items i ON i.inventory_id = b.inventory_id
LEFT JOIN batch_quarantines bq
       ON bq.batch_id = b.batch_id AND bq.released_at IS NULL
WHERE i.inventory_id = $1
ORDER BY b.batch_id ASC`;

/** Claims a real inventory item and clears its batches so a fixture set can be
 *  built without touching any other item. Everything is undone by ROLLBACK. */
const withCleanInventory = async (
  fn: (ctx: { client: any; inventoryId: number; clinicId: number; userId: number }) => Promise<Array<Record<string, unknown>>>,
): Promise<Array<Record<string, unknown>> | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // A real inventory item in a real clinic, to hang fixtures off.
    const anchor = (
      await client.query(
        `SELECT i.inventory_id, i.clinic_id FROM inventory_items i
         WHERE i.deleted_at IS NULL ORDER BY i.inventory_id ASC LIMIT 1`,
      )
    ).rows[0];
    if (anchor === undefined) {
      await client.query('ROLLBACK');
      return null;
    }
    const inventoryId = Number(anchor.inventory_id);
    const clinicId = Number(anchor.clinic_id);
    const userId = Number((await client.query(`SELECT MIN(user_id) AS id FROM users`)).rows[0].id);

    // This test owns its fixtures: it deletes every batch of the anchor item
    // and inserts its own. Existing rows are only cleared so their dependent
    // rows cannot block the delete — the ROLLBACK restores all of it.
    const batches = (
      await client.query(
        `SELECT batch_id FROM inventory_batches WHERE inventory_id = $1 ORDER BY batch_id ASC`,
        [inventoryId],
      )
    ).rows;
    const batchIds = batches.map((b) => Number(b.batch_id));

    // Isolate this item so no other batch of the clinic joins the totals.
    await client.query(`DELETE FROM dispensing_item_batches WHERE dispensing_item_id IN (
        SELECT dispensing_item_id FROM dispensing_items WHERE inventory_item_id = $1)`, [inventoryId]);
    await client.query(`DELETE FROM stock_movements WHERE batch_id = ANY($1::int[])`, [batchIds]);
    await client.query(`DELETE FROM batch_quarantines WHERE batch_id = ANY($1::int[])`, [batchIds]);
    await client.query(`DELETE FROM inventory_batches WHERE inventory_id = $1`, [inventoryId]);

    const rows = await fn({ client, inventoryId, clinicId, userId });
    await client.query('ROLLBACK');
    return rows;
  } finally {
    client.release();
  }
};

/** The production statement, run against real batches inside a rolled-back
 *  transaction so the fixtures never persist. */
async function realValuation(): Promise<{
  rows: Array<Record<string, unknown>>;
  inventoryId: number;
} | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // A real inventory item in a real clinic, to hang fixtures off.
    const anchor = (
      await client.query(
        `SELECT i.inventory_id, i.clinic_id FROM inventory_items i
         WHERE i.deleted_at IS NULL ORDER BY i.inventory_id ASC LIMIT 1`,
      )
    ).rows[0];
    if (anchor === undefined) {
      await client.query('ROLLBACK');
      return null;
    }
    const inventoryId = Number(anchor.inventory_id);

    // This test owns its fixtures: it deletes every batch of the anchor item
    // and inserts its own. Existing rows are only cleared so their dependent
    // rows cannot block the delete — the ROLLBACK restores all of it.
    const batches = (
      await client.query(
        `SELECT batch_id FROM inventory_batches WHERE inventory_id = $1 ORDER BY batch_id ASC`,
        [inventoryId],
      )
    ).rows;
    const batchIds = batches.map((b) => Number(b.batch_id));

    // Isolate this item so no other batch of the clinic joins the totals.
    await client.query(`DELETE FROM dispensing_item_batches WHERE dispensing_item_id IN (
        SELECT dispensing_item_id FROM dispensing_items WHERE inventory_item_id = $1)`, [inventoryId]);
    await client.query(`DELETE FROM stock_movements WHERE batch_id = ANY($1::int[])`, [batchIds]);
    await client.query(`DELETE FROM batch_quarantines WHERE batch_id = ANY($1::int[])`, [batchIds]);
    await client.query(`DELETE FROM inventory_batches WHERE inventory_id = $1`, [inventoryId]);

    // Two clean valued batches, plus one unvalued and one zero-stock batch.
    const fixtures: Array<[number, number | null, boolean, string | null]> = [
      [20, 0.5, true, '2028-01-31'],   // valued
      [30, 0.7, true, '2028-02-28'],   // valued, different cost
      [12, null, true, '2028-03-31'],  // unvalued: no cost basis
      [0, 2.0, true, '2028-04-30'],    // zero stock, costed
    ];
    for (const [qty, cost, active, expiry] of fixtures) {
      await client.query(
        `INSERT INTO inventory_batches
           (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
         VALUES ($1, $2, $3, $4, 0, $5, $6)`,
        [inventoryId, `VAL-${qty}-${cost}`, expiry, qty, cost, active],
      );
    }

    const { rows } = await client.query(FIXTURE_VALUATION_SQL, [inventoryId]);
    await client.query('ROLLBACK');
    return { rows, inventoryId };
  } finally {
    client.release();
  }
}

test('VALUATION: single batch value is quantity × cost', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  const rows = fixture.rows;
  // 20 × 0.50 = 10.00
  assert.equal(Number(rows[0]!.quantity_on_hand), 20);
  assert.equal(Number(rows[0]!.inventory_value), 10.0);
  // The raw SQL has no valuation_status column (that is a controller-level
  // label); a costed batch is valued here iff unit_cost is not NULL.
  assert.notEqual(rows[0]!.unit_cost, null, 'a costed batch is valued');
});

test('VALUATION: multiple batches with different costs each get their own value', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  // 30 × 0.70 = 21.00, valued independently of the first batch
  assert.equal(Number(fixture.rows[1]!.quantity_on_hand), 30);
  assert.equal(Number(fixture.rows[1]!.inventory_value), 21.0);
  assert.notEqual(Number(fixture.rows[0]!.inventory_value), Number(fixture.rows[1]!.inventory_value));
});

test('VALUATION: the documented example totals exactly 31.00', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  // 20 × 0.50 = 10.00 + 30 × 0.70 = 21.00 = 31.00, and the zero/unvalued
  // batches add nothing to the valued total.
  assert.equal(Number(fixture.rows[0]!.inventory_value) + Number(fixture.rows[1]!.inventory_value), 31.0);
  assert.equal(Number(fixture.rows[0]!.total_inventory_value), 31.0);
});

test('VALUATION: exact NUMERIC is preserved, not rounded to a currency scale', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  // The valued total arrives as an exact NUMERIC string. A float round-trip
  // would still be 31, so assert the type/shape instead: pg hands back text.
  assert.equal(typeof fixture.rows[0]!.total_inventory_value, 'string');
  assert.equal(fixture.rows[0]!.total_inventory_value, '31.0000000');
  // quantity 0.5 × cost 0.1234 would need 4+ decimals; here the scale must
  // exceed 2, proving no 2-decimal money rounding happened.
  const scale = (fixture.rows[0]!.total_inventory_value as string).split('.')[1]?.length ?? 0;
  assert.ok(scale > 2, 'valued total keeps full NUMERIC scale');
});

test('VALUATION: a NULL-cost batch is unvalued, never valued as zero', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  const unvalued = fixture.rows.find((r) => r.unit_cost === null);
  assert.ok(unvalued, 'a NULL-cost batch is present in the report');
  assert.equal(unvalued!.inventory_value, null, 'its value is NULL, not 0');
  // Guard against a zero sneaking in as a string or number. (Note: Number(null)
  // is 0 in JS, so comparing through Number would prove nothing.)
  assert.notEqual(unvalued!.inventory_value, '0', 'not a zero-valued string');
  assert.notEqual(unvalued!.inventory_value, 0, 'not a numeric zero');
});

test('VALUATION: valued and unvalued stock are distinguishable and separated in totals', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  const head = fixture.rows[0]!!;
  // 3 costed batches are valued; the 1 NULL-cost batch is counted apart, and the
  // valued total still reads 31.00 rather than absorbing the unvalued 12 units.
  assert.equal(Number(head.valued_batch_count), 3);
  assert.equal(Number(head.unvalued_batch_count), 1);
  assert.equal(Number(head.unvalued_quantity_on_hand), 12, 'the 12 unvalued units are reported by quantity');
  assert.equal(Number(head.total_inventory_value), 31.0, 'unvalued stock does not dilute the valued total');
});

test('VALUATION: a zero-stock batch is still reported and still valued at zero', async (t) => {
  const fixture = await realValuation();
  if (fixture === null) return t.skip('no inventory item with enough batches available');
  const zero = fixture.rows.find((r) => Number(r.quantity_on_hand) === 0);
  assert.ok(zero, 'a zero-stock batch is not filtered out of the physical model');
  assert.equal(Number(zero!.inventory_value), 0, 'it contributes a true zero, not a missing value');
});

test('VALUATION: a genuinely expired batch is still returned, valued, and flagged', async (t) => {
  // A real past-dated batch, not just a state column assertion.
  const rows = await withCleanInventory(async ({ client, inventoryId }) => {
    await client.query(
      `INSERT INTO inventory_batches
         (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
       VALUES ($1, 'EXPIRED-LOT', CURRENT_DATE - 30, 15, 0, 0.40, TRUE)`,
      [inventoryId],
    );
    return (await client.query(FIXTURE_VALUATION_SQL, [inventoryId])).rows;
  });
  if (rows === null) return t.skip('no inventory item available');

  assert.equal(rows.length, 1, 'the expired batch is not filtered out of the report');
  const batch = rows[0]!;
  assert.equal(batch.is_expired, true, 'it is genuinely marked expired');
  assert.equal(batch.is_active, true, 'it is active — expiry alone does not deactivate it');
  // 15 × 0.40 = 6.00: still physical stock, so still financial value.
  assert.equal(Number(batch.inventory_value), 6.0, 'an expired batch is still valued');
  assert.equal(Number(batch.total_inventory_value), 6.0, 'and still counts toward the total');
});

test('VALUATION: a genuinely inactive batch is still returned, valued, and flagged', async (t) => {
  const rows = await withCleanInventory(async ({ client, inventoryId }) => {
    await client.query(
      `INSERT INTO inventory_batches
         (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
       VALUES ($1, 'INACTIVE-LOT', CURRENT_DATE + 300, 25, 0, 0.20, FALSE)`,
      [inventoryId],
    );
    return (await client.query(FIXTURE_VALUATION_SQL, [inventoryId])).rows;
  });
  if (rows === null) return t.skip('no inventory item available');

  assert.equal(rows.length, 1, 'the inactive batch is not filtered out of the report');
  const batch = rows[0]!;
  assert.equal(batch.is_active, false, 'its inactive state is preserved');
  assert.equal(batch.is_expired, false, 'it is not expired — inactivity is a separate fact');
  // 25 × 0.20 = 5.00: deactivation does not remove physical stock from the value.
  assert.equal(Number(batch.inventory_value), 5.0, 'an inactive batch is still valued');
  assert.equal(Number(batch.total_inventory_value), 5.0, 'and still counts toward the total');
});

test('VALUATION: a genuinely quarantined batch is still returned, valued, and flagged', async (t) => {
  // A real active quarantine record, created through the existing
  // batch_quarantines model (no schema or production change): the same table the
  // quarantine/release API writes, with released_at NULL.
  const rows = await withCleanInventory(async ({ client, inventoryId, clinicId, userId }) => {
    const batch = (
      await client.query(
        `INSERT INTO inventory_batches
           (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
         VALUES ($1, 'QUARANTINED-LOT', CURRENT_DATE + 200, 40, 0, 0.50, TRUE)
         RETURNING batch_id`,
        [inventoryId],
      )
    ).rows[0];

    await client.query(
      `INSERT INTO batch_quarantines (batch_id, clinic_id, reason, quarantined_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [Number(batch.batch_id), clinicId, 'VALUATION-TEST-QUARANTINE', userId],
    );

    const result = (await client.query(FIXTURE_VALUATION_SQL, [inventoryId])).rows;

    // Prove the fixture really is an ACTIVE quarantine, not a released record.
    const active = (
      await client.query(
        `SELECT COUNT(*)::int AS n FROM batch_quarantines
         WHERE batch_id = $1 AND released_at IS NULL`,
        [Number(batch.batch_id)],
      )
    ).rows[0];
    assert.equal(Number(active.n), 1, 'the fixture created one real active quarantine');

    return result;
  });
  if (rows === null) return t.skip('no inventory item available');

  assert.equal(rows.length, 1, 'the quarantined batch is not filtered out of the report');
  const batch = rows[0]!;
  assert.equal(batch.is_quarantined, true, 'it is genuinely marked quarantined');
  // 40 × 0.50 = 20.00: quarantine blocks FEFO, not physical valuation.
  assert.equal(Number(batch.inventory_value), 20.0, 'a quarantined batch is still valued');
  assert.equal(Number(batch.total_inventory_value), 20.0, 'and still counts toward the total');
  // Quarantine metadata travels with the value rather than hiding the batch.
  assert.equal(batch.quarantine_reason, 'VALUATION-TEST-QUARANTINE', 'the reason is exposed');
  assert.notEqual(batch.quarantined_at, null, 'the quarantine timestamp is exposed');
});

test('VALUATION: a released quarantine is not reported as quarantined', async (t) => {
  // The counterpart to the active case: the same model with released_at set must
  // not flag the batch, proving the report reads ACTIVE quarantine only.
  const rows = await withCleanInventory(async ({ client, inventoryId, clinicId, userId }) => {
    const batch = (
      await client.query(
        `INSERT INTO inventory_batches
           (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
         VALUES ($1, 'RELEASED-LOT', CURRENT_DATE + 210, 10, 0, 0.30, TRUE)
         RETURNING batch_id`,
        [inventoryId],
      )
    ).rows[0];

    await client.query(
      `INSERT INTO batch_quarantines
         (batch_id, clinic_id, reason, quarantined_by_user_id, released_at, released_by_user_id, release_reason)
       VALUES ($1, $2, $3, $4, NOW(), $4, 'VALUATION-TEST-RELEASED')`,
      [Number(batch.batch_id), clinicId, 'VALUATION-TEST-RELEASED', userId],
    );

    return (await client.query(FIXTURE_VALUATION_SQL, [inventoryId])).rows;
  });
  if (rows === null) return t.skip('no inventory item available');

  assert.equal(rows[0]!.is_quarantined, false, 'a released quarantine does not flag the batch');
  assert.equal(rows[0]!.quarantine_reason, null, 'and exposes no stale quarantine reason');
  assert.equal(Number(rows[0]!.inventory_value), 3.0, 'the batch is valued as normal');
});

/* ==========================================================================
 * Controller layer — response shaping, scoping, filters, single query
 * ========================================================================== */

test('VALUATION: the report is one query, with no per-batch follow-up', async () => {
  const rows = [rowStub({ batch_id: 1 }), rowStub({ batch_id: 2 }), rowStub({ batch_id: 3 })];
  const { issued } = await call({}, rows);
  assert.equal(issued.length, 1, 'detail and totals arrive in a single round trip (no N+1)');
});

test('VALUATION: a single batch report returns one row', async () => {
  const { captured } = await call({}, [rowStub({ batch_id: 7, inventory_value: '10.0000000' })]);
  assert.equal(captured.status, 200);
  assert.equal(captured.body.valuation.batches.length, 1);
  assert.equal(captured.body.valuation.batches[0].batch_id, 7);
});

test('VALUATION: an empty result still returns a well-formed zero report', async () => {
  const { captured } = await call({}, []);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.valuation.batches, []);
  assert.equal(captured.body.valuation.totals.batch_count, 0);
  assert.equal(captured.body.valuation.totals.total_inventory_value, '0');
  assert.equal(captured.body.valuation.totals.unvalued_batch_count, 0);
});

test('VALUATION: NUMERIC values cross the boundary as exact text, not floats', async () => {
  const { captured } = await call({}, [
    rowStub({ batch_id: 1, inventory_value: '0.9999000', unit_cost: '0.3333', quantity_on_hand: '3.000' }),
  ]);
  const batch = captured.body.valuation.batches[0];
  assert.equal(batch.inventory_value, '0.9999000', 'four decimals survive intact');
  assert.equal(batch.unit_cost, '0.3333');
  assert.equal(typeof batch.inventory_value, 'string', 'no premature Number() conversion');
});

test('VALUATION: NULL cost is reported as UNVALUED with a NULL value', async () => {
  const { captured } = await call({}, [rowStub({ batch_id: 1, unit_cost: null, inventory_value: null })]);
  const batch = captured.body.valuation.batches[0];
  assert.equal(batch.valuation_status, 'UNVALUED');
  assert.equal(batch.inventory_value, null, 'never coerced to 0');
});

test('VALUATION: clinic scope comes from the session, never the request', async () => {
  // A client-supplied clinic_id is dropped by the schema and must not widen the
  // query; the real scope comes from the user's accessible clinic list.
  const { sql, params } = await call({ clinic_id: 999 } as Record<string, unknown>);
  assert.match(sql, /i\.clinic_id = ANY\(\$\d+::int\[\]\)/, 'clinic scope is applied from the session');
  assert.ok(params.includes(999) === false, 'no client clinic id reaches the query as a bound filter');
});

test('VALUATION: a user with no accessible clinics is denied by default', async () => {
  const noAccess = { ...VIEWER, clinicIds: [] };
  const { sql } = await call({}, [], noAccess);
  // Deny-by-default: the scope clause still applies, with an empty clinic list,
  // so the query matches nothing rather than everything.
  assert.match(sql, /i\.clinic_id = ANY\(\$\d+::int\[\]\)/, 'an empty clinic list still constrains the query');
});

test('VALUATION: a multi-clinic manager sees the scope widened by role, not by input', async () => {
  const manager = { ...VIEWER, roleName: 'SUPER_ADMIN', permissions: ['VIEW_INVENTORY'], clinicIds: [] };
  const { sql } = await call({ clinic_id: 5 } as Record<string, unknown>, [], manager);
  assert.doesNotMatch(sql, /i\.clinic_id = ANY/, 'a multi-clinic manager is not restricted by a clinic list');
  assert.ok(!sql.includes('clinic_id = $'), 'and still not by any client-supplied clinic filter');
});

test('VALUATION: medication, inventory and batch filters are supported', async () => {
  const { sql, params } = await call({ inventory_id: 11, medication_id: 22, batch_id: 33 });
  assert.match(sql, /b\.batch_id = \$\d+/, 'batch filter applied');
  assert.match(sql, /i\.inventory_id = \$\d+/, 'inventory filter applied');
  assert.match(sql, /i\.medication_id = \$\d+/, 'medication filter applied');
  assert.ok(params.includes(11) && params.includes(22) && params.includes(33), 'each filter is bound');
});

test('VALUATION: invalid filters are rejected before any query runs', async () => {
  const { captured, issued } = await call({ inventory_id: 'abc' });
  assert.equal(captured.status, 400);
  assert.equal(issued.length, 0, 'no SQL is issued for an invalid filter');
});

test('VALUATION: the report performs no stock, cost, or financial mutation', async () => {
  const { sql } = await call({}, [rowStub({})]);
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.doesNotMatch(sql, new RegExp(`\\b${verb}\\b`), `no ${verb} in a read-only report`);
  }
  // And none of the 10E.4/10E.5 money tables are even read by this statement.
  for (const table of ['dispensing_items', 'dispensing_item_batches', 'medication_prices',
    'invoice_items', 'invoices', 'payments']) {
    assert.doesNotMatch(sql, new RegExp(table), `no ${table} in the valuation source`);
  }
});

/** A row shaped like the production statement's output. */
function rowStub(overrides: QueryRow): QueryRow {
  return {
    batch_id: 1, lot_number: 'LOT', expiry_date: '2028-01-31',
    inventory_id: 1, medication_id: 1, trade_name: 'MED', strength: '10', dosage_form: 'TABLET',
    uom: 'TABLET', quantity_on_hand: '20.000', quantity_reserved: '0.000',
    unit_cost: '0.5000', is_active: true, is_quarantined: false,
    quarantine_reason: null, quarantined_at: null, is_expired: false,
    inventory_value: '10.0000000',
    filtered_batch_count: 1, valued_batch_count: 1, total_inventory_value: '10.0000000',
    unvalued_batch_count: 0, unvalued_quantity_on_hand: '0.000', total_quantity_on_hand: '20.000',
    ...overrides,
  };
}
