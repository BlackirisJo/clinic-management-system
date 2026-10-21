import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10E.4 — Applied-schema verification for medication invoice lines
 *
 * Catalog assertions are read-only. Constraint-behaviour assertions insert
 * rows, so they are gated behind an opt-in flag:
 *   MEDICATION_CHARGE_SCHEMA_TEST=1
 * ========================================================================== */

const enabled = process.env.MEDICATION_CHARGE_SCHEMA_TEST === '1';

const q = async (text: string, params: unknown[] = []): Promise<any[]> =>
  (await pool.query(text, params)).rows;

/* ==========================================================================
 * CATALOG (read-only)
 * ========================================================================== */

test('SCHEMA: invoice_items carries the medication charge columns', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoice_items'`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  for (const column of [
    'dispensing_id', 'dispensing_item_id', 'medication_id',
    'dispensed_quantity', 'unit_price_snapshot', 'line_total',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
    // Nullable: an existing clinic-service line sets none of them
    assert.equal(byName.get(column).is_nullable, 'YES', `${column} must stay nullable`);
  }

  assert.equal(byName.get('unit_price_snapshot').numeric_precision, 10);
  assert.equal(byName.get('unit_price_snapshot').numeric_scale, 2);
  assert.equal(Number(byName.get('dispensed_quantity').numeric_scale), 3, 'fractional doses allowed');
});

test('SCHEMA: the legacy service columns are untouched', async () => {
  const rows = await q(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoice_items'`,
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  assert.equal(byName.get('price').is_nullable, 'NO', 'price stays NOT NULL');
  assert.equal(byName.get('quantity').data_type, 'integer', 'the legacy INT quantity is unchanged');
  assert.ok(byName.has('service_id'), 'service_id still exists for service lines');
  assert.ok(byName.has('doctor_share'), 'doctor_share still exists');
});

test('SCHEMA: the medication charge constraints exist', async () => {
  const rows = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'invoice_items'::regclass`);
  const names = rows.map((r) => r.conname);

  for (const expected of [
    'chk_ii_medication_line_complete',
    'chk_ii_medication_no_service',
    'chk_ii_dispensed_quantity_positive',
    'chk_ii_unit_price_nonneg',
    'chk_ii_medication_line_total',
  ]) {
    assert.ok(names.includes(expected), `missing constraint ${expected}`);
  }
  // The pre-existing service quantity check must still be there
  assert.ok(names.includes('invoice_items_quantity_check'), 'the service quantity check is untouched');
});

test('SCHEMA: one charge per dispensing item is a partial unique index', async () => {
  const rows = await q(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'invoice_items'`,
  );
  const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

  const unique = byName.get('uq_invoice_items_dispensing_item');
  assert.ok(unique, 'the duplicate-prevention index exists');
  assert.match(unique!, /UNIQUE/i);
  assert.match(unique!, /dispensing_item_id/);
  assert.match(unique!, /WHERE/, 'partial: service lines are exempt');
  assert.ok(!/WHERE service_id/.test(unique!), 'exemption is on dispensing_item_id IS NOT NULL');

  assert.ok(byName.has('idx_invoice_items_dispensing'), 'the already-charged lookup is indexed');
});

test('SCHEMA: the migration backfilled nothing and left service lines unconstrained', async () => {
  // No pre-existing row may have been given a medication identity, so every
  // stored line still classifies purely by whether it names a service.
  const rows = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(dispensing_item_id)::int AS medication_lines,
            COUNT(service_id)::int AS service_lines
     FROM invoice_items`,
  );

  assert.equal(Number(rows[0].medication_lines), 0, 'no medication line was backfilled');

  // Every CHECK must be guarded on the medication side, or it would reject a
  // legacy service line that sets none of the new columns.
  const constraints = await q(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'invoice_items'::regclass`,
  );
  const guards = new Map(constraints.map((r) => [r.conname, r.def]));

  for (const name of [
    'chk_ii_medication_line_complete',
    'chk_ii_medication_no_service',
    'chk_ii_dispensed_quantity_positive',
    'chk_ii_unit_price_nonneg',
    'chk_ii_medication_line_total',
  ]) {
    // Postgres renders these as `dispensing_item_id IS NULL OR (<condition>)`
    assert.match(
      guards.get(name)!,
      /dispensing_item_id IS NULL\)\s+OR/i,
      `${name} must only apply to medication lines`,
    );
  }
});

/* ==========================================================================
 * CONSTRAINT BEHAVIOUR (opt-in; inserts rows)
 * ========================================================================== */

type ChargeChain = Record<string, any>;

/** A real dispensing chain to hang medication lines off, if one exists. */
const loadChain = async (): Promise<ChargeChain | null> => {
  const rows = await q(
    `SELECT d.dispensing_id, di.dispensing_item_id, di.medication_id,
            d.clinic_id, d.patient_id, d.visit_id
     FROM dispensings d
     JOIN dispensing_items di ON di.dispensing_id = d.dispensing_id
     WHERE d.status <> 'VOIDED' AND di.dispensed_quantity > 0
     ORDER BY d.dispensing_id ASC, di.dispensing_item_id ASC
     LIMIT 1`,
  );
  return rows.length === 0 ? null : (rows[0] as ChargeChain);
};

const insertInvoice = async (client: any, chain: ChargeChain): Promise<number> => {
  const invoice = await client.query(
    `INSERT INTO invoices (patient_id, visit_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, currency_code)
     VALUES ($1, $2, (SELECT MIN(user_id) FROM users), 10, 0, 10, 0, 'JOD')
     RETURNING invoice_id`,
    [chain.patient_id, chain.visit_id],
  );
  return invoice.rows[0].invoice_id;
};

test('CONSTRAINTS: the same dispensing item cannot be charged twice', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_CHARGE_SCHEMA_TEST=1 to run');

  const chain = await loadChain();
  if (chain === null) return t.skip('no dispensing with a positive quantity available');

  const client = await pool.connect();
  let invoiceId: number | null = null;
  try {
    await client.query('BEGIN');
    invoiceId = await insertInvoice(client, chain);

    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
          dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
       VALUES ($1, $2, $3, $4, $5, 5.000, 2.00, 10.00, 10.00, 1)`,
      [invoiceId, chain.clinic_id, chain.dispensing_id, chain.dispensing_item_id, chain.medication_id],
    );

    // The second charge must be refused by the database itself
    await assert.rejects(
      client.query(
        `INSERT INTO invoice_items
           (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
            dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
         VALUES ($1, $2, $3, $4, $5, 5.000, 3.00, 15.00, 15.00, 1)`,
        [invoiceId, chain.clinic_id, chain.dispensing_id, chain.dispensing_item_id, chain.medication_id],
      ),
      (error: any) => {
        assert.equal(error?.code, '23505', 'the partial unique index rejects the duplicate');
        return true;
      },
    );

    await client.query('ROLLBACK');
  } finally {
    client.release();
    if (invoiceId !== null) await pool.query('DELETE FROM invoices WHERE invoice_id = $1', [invoiceId]);
  }
});

test('CONSTRAINTS: two DIFFERENT dispensing items of one dispensing can coexist', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_CHARGE_SCHEMA_TEST=1 to run');

  const rows = await q(
    `SELECT d.dispensing_id, di.dispensing_item_id, di.medication_id, d.clinic_id,
            d.patient_id, d.visit_id
     FROM dispensings d
     JOIN dispensing_items di ON di.dispensing_id = d.dispensing_id
     WHERE d.status <> 'VOIDED' AND di.dispensed_quantity > 0
     ORDER BY d.dispensing_id ASC, di.dispensing_item_id ASC`,
  );
  const pairs = new Map<number, any[]>();
  for (const row of rows) {
    const list = pairs.get(row.dispensing_id) ?? [];
    list.push(row);
    pairs.set(row.dispensing_id, list);
  }
  const multi = [...pairs.values()].find((list) => list.length >= 2);
  if (multi === undefined) return t.skip('no dispensing with two items available');

  const chain = multi[0];
  const client = await pool.connect();
  let invoiceId: number | null = null;
  try {
    await client.query('BEGIN');
    invoiceId = await insertInvoice(client, chain);

    for (const item of multi) {
      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
            dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
         VALUES ($1, $2, $3, $4, $5, 2.000, 1.50, 3.00, 3.00, 1)`,
        [invoiceId, item.clinic_id, chain.dispensing_id, item.dispensing_item_id, item.medication_id],
      );
    }

    // Count through the SAME client: pool.query would run on another
    // connection and could not see the uncommitted rows.
    const stored = await client.query(`SELECT COUNT(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(Number(stored.rows[0].n), 2, 'both lines of the same dispensing were accepted');

    await client.query('ROLLBACK');
  } finally {
    client.release();
    if (invoiceId !== null) await pool.query('DELETE FROM invoices WHERE invoice_id = $1', [invoiceId]);
  }
});

test('CONSTRAINTS: a service line and a medication line coexist on one invoice', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_CHARGE_SCHEMA_TEST=1 to run');

  const chain = await loadChain();
  const service = await q(`SELECT service_id FROM clinic_services LIMIT 1`);
  if (chain === null || service.length === 0) return t.skip('no dispensing or service available');

  const client = await pool.connect();
  let invoiceId: number | null = null;
  try {
    await client.query('BEGIN');
    invoiceId = await insertInvoice(client, chain);

    // A medication line is accepted alongside a legacy service line
    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
          dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
       VALUES ($1, $2, $3, $4, $5, 1.000, 5.00, 5.00, 5.00, 1)`,
      [invoiceId, chain.clinic_id, chain.dispensing_id, chain.dispensing_item_id, chain.medication_id],
    );
    await client.query(
      `INSERT INTO invoice_items (invoice_id, clinic_id, service_id, price, quantity)
       VALUES ($1, $2, $3, 15.00, 1)`,
      [invoiceId, chain.clinic_id, service[0].service_id],
    );

    const stored = await client.query(`SELECT COUNT(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(Number(stored.rows[0].n), 2, 'service and medication lines coexist');

    await client.query('ROLLBACK');
  } finally {
    client.release();
    if (invoiceId !== null) await pool.query('DELETE FROM invoices WHERE invoice_id = $1', [invoiceId]);
  }
});

test('CONSTRAINTS: malformed medication lines are refused', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_CHARGE_SCHEMA_TEST=1 to run');

  const chain = await loadChain();
  if (chain === null) return t.skip('no dispensing available');

  // Each case perturbs one column of an otherwise valid medication line, and
  // each must be refused by a CHECK rather than stored. `used` is how many of
  // the shared $1..$5 bindings the statement actually references.
  const shared = [null, chain.clinic_id, chain.dispensing_id, chain.dispensing_item_id, chain.medication_id];
  const cases: Array<[string, string, number]> = [
    // a service and a drug on one line
    ['a medication line that also references a service',
     `INSERT INTO invoice_items
        (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
         dispensed_quantity, unit_price_snapshot, line_total, price, quantity, service_id)
      VALUES ($1, $2, $3, $4, $5, 2.000, 3.00, 6.00, 6.00, 1,
              (SELECT MIN(service_id) FROM clinic_services))`, 5],
    // frozen price missing
    ['a medication line without a frozen price',
     `INSERT INTO invoice_items
        (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
         dispensed_quantity, line_total, price, quantity)
      VALUES ($1, $2, $3, $4, $5, 2.000, 6.00, 6.00, 1)`, 5],
    // negative frozen price
    ['a negative frozen price',
     `INSERT INTO invoice_items
        (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
         dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
      VALUES ($1, $2, $3, $4, $5, 2.000, -3.00, -6.00, -6.00, 1)`, 5],
    // zero dispensed quantity
    ['a zero dispensed quantity',
     `INSERT INTO invoice_items
        (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
         dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
      VALUES ($1, $2, $3, $4, $5, 0, 3.00, 0.00, 0.00, 1)`, 5],
    // the medication identity omitted
    ['a medication line without a medication reference',
     `INSERT INTO invoice_items
        (invoice_id, clinic_id, dispensing_id, dispensing_item_id,
         dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
      VALUES ($1, $2, $3, $4, 2.000, 3.00, 6.00, 6.00, 1)`, 4],
  ];

  for (const [label, sql, used] of cases) {
    const client = await pool.connect();
    let invoiceId: number | null = null;
    try {
      await client.query('BEGIN');
      invoiceId = await insertInvoice(client, chain);
      await assert.rejects(
        client.query(sql, [invoiceId, ...shared.slice(1, used)]),
        (error: any) => {
          assert.equal(error?.code, '23514', `${label} must violate a CHECK`);
          return true;
        },
        label,
      );
      await client.query('ROLLBACK');
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      if (invoiceId !== null) await pool.query('DELETE FROM invoices WHERE invoice_id = $1', [invoiceId]);
    }
  }
});

test('CONSTRAINTS: an inconsistent line total is refused', async (t) => {
  if (!enabled) return t.skip('set MEDICATION_CHARGE_SCHEMA_TEST=1 to run');

  const chain = await loadChain();
  if (chain === null) return t.skip('no dispensing available');

  const client = await pool.connect();
  let invoiceId: number | null = null;
  try {
    await client.query('BEGIN');
    invoiceId = await insertInvoice(client, chain);

    // 2 x 3.00 = 6.00, so a claimed 9.00 is not derivable from the snapshot
    await assert.rejects(
      client.query(
        `INSERT INTO invoice_items
           (invoice_id, clinic_id, dispensing_id, dispensing_item_id, medication_id,
            dispensed_quantity, unit_price_snapshot, line_total, price, quantity)
         VALUES ($1, $2, $3, $4, $5, 2.000, 3.00, 9.00, 9.00, 1)`,
        [invoiceId, chain.clinic_id, chain.dispensing_id, chain.dispensing_item_id, chain.medication_id],
      ),
      (error: any) => {
        assert.equal(error?.code, '23514', 'line_total must equal quantity x frozen price');
        return true;
      },
    );

    await client.query('ROLLBACK');
  } finally {
    client.release();
    if (invoiceId !== null) await pool.query('DELETE FROM invoices WHERE invoice_id = $1', [invoiceId]);
  }
});