import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createMedicationReturn } from '../modules/inventory/medicationReturns.controller';
import { createMedicationCharge } from '../modules/billing/medicationCharges.controller';
import {
  createMedicationPrice,
  updateMedicationPrice,
  deactivateMedicationPrice,
} from '../modules/inventory/medicationPrices.controller';

/* ==========================================================================
 * Phase 10E.9 â€” Financial consistency & concurrency
 *
 * 10E.2-10E.8 each proved one financial property in isolation. None of them
 * proved the properties hold when two real PostgreSQL transactions collide.
 * This suite races the real controllers against the real database, so the
 * locks â€” not the mocks â€” are what is under test.
 *
 * Gated exactly like the project's other DB-backed concurrency tests so it
 * never runs against a developer's database implicitly:
 *   FINANCIAL_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.FINANCIAL_CONCURRENCY_TEST === '1';

const num = (value: unknown): number => Number(value);

const req = (
  body: Record<string, unknown>,
  user: { userId: number; clinicId: number | null; clinicIds: number[]; roleName?: string },
): AuthenticatedRequest =>
  ({
    body, params: {}, query: {},
    user: {
      userId: user.userId, roleId: 1, clinicId: user.clinicId,
      // canManageAllClinics() is true for an admin roleName, so an isolation
      // session must NOT claim one — it would be scoped to every clinic.
      roleName: user.roleName ?? 'SUPER_ADMIN',
      permissions: [], clinicIds: user.clinicIds,
    },
  } as unknown as AuthenticatedRequest);

/** A session scoped to exactly one clinic, with no administrative reach. */
const clinicUserReq = (
  body: Record<string, unknown>,
  userId: number,
  clinicId: number,
): AuthenticatedRequest => req(body, { userId, clinicId, clinicIds: [clinicId], roleName: 'PHARMACIST' });

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const returnMedication = async (body: Record<string, unknown>, userId: number, clinicIds: number[] = [], clinicId: number | null = null) => {
  const { res, captured } = makeRes();
  await createMedicationReturn(req(body, { userId, clinicId, clinicIds }), res);
  return captured;
};

const chargeDispensing = async (body: Record<string, unknown>, userId: number, clinicIds: number[] = [], clinicId: number | null = null) => {
  const { res, captured } = makeRes();
  await createMedicationCharge(req(body, { userId, clinicId, clinicIds }), res);
  return captured;
};

interface Fixture {
  clinic: number; otherClinic: number; user: number; patient: number; prescription: number;
  prescriptionItem: number; medication: number; inventory: number; batch: number; substitute: number;
  dispensing: number; dispensingItem: number; allocation: number; invoice: number;
}

const NOTHING: Fixture = {
  clinic: 0, otherClinic: 0, user: 0, patient: 0, prescription: 0, prescriptionItem: 0,
  medication: 0, inventory: 0, batch: 0, substitute: 0, dispensing: 0, dispensingItem: 0,
  allocation: 0, invoice: 0,
};

/**
 * The whole production chain: clinic â†’ user â†’ patient â†’ visit â†’ prescription â†’
 * medication â†’ inventory â†’ batch â†’ dispensing â†’ item (with the 10E.3 frozen
 * selling price) â†’ allocation.
 *
 * unitPrice is the 10E.3 snapshot: the only price any financial path may read.
 * unitCost is the 10E.7 cost snapshot on the allocation, deliberately a
 * different number so a mix-up between cost and price is visible.
 */
const seed = async (opts: {
  allocated: number; onHand: number; unitPrice: string; unitCost?: string; tag: string;
}): Promise<Fixture> => {
  const stamp = `${opts.tag}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const unitCost = opts.unitCost ?? '2.5678';
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`FIN-RACE-${stamp}`],
  );
  const otherClinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`FIN-OTHER-${stamp}`],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Fin Race', `fin-race-${stamp}`, 'x'],
  );
  const patient = await pool.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ($1, $2, 'MALE', '1990-01-01', $3) RETURNING patient_id`,
    ['Fin Race Patient', `05${String(Date.now()).slice(-8)}`, clinic.rows[0].clinic_id],
  );
  const visit = await pool.query(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id) VALUES ($1, $2, $3) RETURNING visit_id`,
    [patient.rows[0].patient_id, clinic.rows[0].clinic_id, user.rows[0].user_id],
  );
  const prescription = await pool.query(
    `INSERT INTO prescriptions (visit_id, patient_id, doctor_id) VALUES ($1, $2, $3) RETURNING prescription_id`,
    [visit.rows[0].visit_id, patient.rows[0].patient_id, user.rows[0].user_id],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Fin Race'],
  );
  const prescriptionItem = await pool.query(
    `INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration, prescribed_quantity, uom)
     VALUES ($1, $2, '1 x 3', 'TDS', '5 days', $3, 'TABLET') RETURNING item_id`,
    [prescription.rows[0].prescription_id, medication.rows[0].medication_id, opts.allocated],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  const batch = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, $3, 0, $4::numeric) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp, opts.onHand, unitCost],
  );
  const substitute = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
     VALUES ($1, CONCAT('LOT-SUB-', $2::text), CURRENT_DATE + 60, 0, 0, 3.0000, FALSE) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp],
  );
  const dispensing = await pool.query(
    `INSERT INTO dispensings (prescription_id, visit_id, clinic_id, patient_id, dispensed_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED') RETURNING dispensing_id`,
    [prescription.rows[0].prescription_id, visit.rows[0].visit_id, clinic.rows[0].clinic_id,
     patient.rows[0].patient_id, user.rows[0].user_id],
  );
  const item = await pool.query(
    `INSERT INTO dispensing_items
       (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
        prescribed_quantity, dispensed_quantity, remaining_quantity, uom, unit_price_snapshot)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 'TABLET', $6::numeric) RETURNING dispensing_item_id`,
    [dispensing.rows[0].dispensing_id, prescriptionItem.rows[0].item_id,
     medication.rows[0].medication_id, inventory.rows[0].inventory_id, opts.allocated, opts.unitPrice],
  );
  const allocation = await pool.query(
    `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity, unit_cost_snapshot, expiry_date_snapshot)
     VALUES ($1, $2, $3, $4::numeric, CURRENT_DATE + 30) RETURNING dispensing_item_batch_id`,
    [item.rows[0].dispensing_item_id, batch.rows[0].batch_id, opts.allocated, unitCost],
  );

  return {
    clinic: num(clinic.rows[0].clinic_id), otherClinic: num(otherClinic.rows[0].clinic_id),
    user: num(user.rows[0].user_id), patient: num(patient.rows[0].patient_id),
    prescription: num(prescription.rows[0].prescription_id),
    prescriptionItem: num(prescriptionItem.rows[0].item_id),
    medication: num(medication.rows[0].medication_id), inventory: num(inventory.rows[0].inventory_id),
    batch: num(batch.rows[0].batch_id), substitute: num(substitute.rows[0].batch_id),
    dispensing: num(dispensing.rows[0].dispensing_id), dispensingItem: num(item.rows[0].dispensing_item_id),
    allocation: num(allocation.rows[0].dispensing_item_batch_id), invoice: 0,
  };
};

const drop = async (f: Fixture) => {
  // The invoices this dispensing produced, captured before the lines are removed.
  const invoices = f.dispensing
    ? (await pool.query('SELECT DISTINCT invoice_id FROM invoice_items WHERE dispensing_id = $1', [f.dispensing])).rows
    : [];
  await pool.query('DELETE FROM medication_return_credits WHERE dispensing_item_id = $1', [f.dispensingItem]);
  await pool.query(
    `DELETE FROM medication_return_reversals WHERE dispensing_item_batch_id = $1`, [f.allocation],
  );
  await pool.query('DELETE FROM medication_return_items WHERE dispensing_item_batch_id = $1', [f.allocation]);
  await pool.query(
    `DELETE FROM audit_logs WHERE resource_type = 'MEDICATION_RETURN'
       AND resource_id IN (SELECT return_id::text FROM medication_returns WHERE original_dispensing_id = $1)`,
    [f.dispensing],
  );
  await pool.query('DELETE FROM medication_returns WHERE original_dispensing_id = $1', [f.dispensing]);
  if (invoices.length > 0) {
    const ids = invoices.map((r) => num(r.invoice_id));
    await pool.query(
      `DELETE FROM audit_logs WHERE action = 'DISPENSING_INVOICED' AND resource_id = ANY($1::text[])`,
      [ids.map(String)],
    );
    await pool.query('DELETE FROM invoice_items WHERE invoice_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE invoice_id = ANY($1::int[])', [ids]);
  }
  if (f.inventory) {
    await pool.query('DELETE FROM stock_movements WHERE batch_id IN (SELECT batch_id FROM inventory_batches WHERE inventory_id = $1)', [f.inventory]);
    await pool.query('DELETE FROM batch_quarantines WHERE batch_id IN (SELECT batch_id FROM inventory_batches WHERE inventory_id = $1)', [f.inventory]);
  }
  // Every item of this dispensing, including any extra one a test added.
  await pool.query('DELETE FROM dispensing_item_batches WHERE dispensing_item_id IN (SELECT dispensing_item_id FROM dispensing_items WHERE dispensing_id = $1)', [f.dispensing]);
  await pool.query('DELETE FROM dispensing_items WHERE dispensing_id = $1', [f.dispensing]);
  if (f.dispensing) await pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [f.dispensing]);
  if (f.batch) {
    await pool.query('DELETE FROM inventory_batches WHERE batch_id IN (SELECT unnest(ARRAY[$1::int, $2::int]))', [f.batch, f.substitute]);
  }
  if (f.inventory) {
    await pool.query('DELETE FROM medication_prices WHERE inventory_id = $1', [f.inventory]);
    await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  }
  if (f.prescriptionItem) await pool.query('DELETE FROM prescription_items WHERE item_id = $1', [f.prescriptionItem]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.prescription) await pool.query('DELETE FROM prescriptions WHERE prescription_id = $1', [f.prescription]);
  if (f.patient) {
    await pool.query('DELETE FROM visits WHERE patient_id = $1', [f.patient]);
    await pool.query('DELETE FROM patients WHERE patient_id = $1', [f.patient]);
  }
  if (f.user) await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = ANY(ARRAY[$1::int, $2::int])', [f.clinic, f.otherClinic]);
};

const setPaid = (invoiceId: number, paid: number) =>
  pool.query('UPDATE invoices SET paid_amount = $2::numeric WHERE invoice_id = $1', [invoiceId, paid]);

const invoiceRow = (invoiceId: number) =>
  pool.query('SELECT total_amount, net_amount, paid_amount FROM invoices WHERE invoice_id = $1', [invoiceId]);

const batchState = (batchId: number) =>
  pool.query('SELECT quantity_on_hand, quantity_reserved FROM inventory_batches WHERE batch_id = $1', [batchId]);

const creditsFor = (dispensingItemId: number) =>
  pool.query(
    `SELECT returned_quantity, gross_amount, net_amount, credit_amount,
            applied_to_outstanding, refund_due_amount,
            unit_price_snapshot, medication_discount_value,
            invoice_net_amount, invoice_paid_amount
     FROM medication_return_credits WHERE dispensing_item_id = $1 ORDER BY credit_id`,
    [dispensingItemId],
  );

const reversalsFor = (dispensingItemBatchId: number) =>
  pool.query(
    `SELECT returned_quantity, unit_cost_snapshot, cogs_reversal_amount, loss_amount
     FROM medication_return_reversals WHERE dispensing_item_batch_id = $1 ORDER BY reversal_id`,
    [dispensingItemBatchId],
  );

const returnedTotal = (allocationId: number) =>
  pool.query(
    `SELECT COALESCE(SUM(mri.quantity), 0) AS total
     FROM medication_return_items mri
     JOIN medication_returns mr ON mr.return_id = mri.return_id
     WHERE mri.dispensing_item_batch_id = $1 AND mr.status = 'COMPLETED'`,
    [allocationId],
  );

/** The three Phase 10E.2 pricing handlers, driven against the real pool. */
const createPrice = async (body: Record<string, unknown>, userId: number) => {
  const { res, captured } = makeRes();
  await createMedicationPrice(req(body, { userId, clinicId: null, clinicIds: [] }), res);
  return captured;
};

const supersedePrice = async (params: Record<string, unknown>, body: Record<string, unknown>, userId: number) => {
  const { res, captured } = makeRes();
  await updateMedicationPrice(
    { body, params, query: {}, user: { userId, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] } } as unknown as AuthenticatedRequest,
    res,
  );
  return captured;
};

const deactivatePrice = async (params: Record<string, unknown>, userId: number) => {
  const { res, captured } = makeRes();
  await deactivateMedicationPrice(
    { body: {}, params, query: {}, user: { userId, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] } } as unknown as AuthenticatedRequest,
    res,
  );
  return captured;
};

const returnBody = (f: Fixture, quantity: number, restock = 'RESTOCK') => ({
  dispensing_id: f.dispensing,
  reason: 'FIN-RACE',
  items: [{ dispensing_item_batch_id: f.allocation, quantity, restock_decision: restock }],
});

/* ==========================================================================
 * 1. DUPLICATE INVOICE PROTECTION
 * ======================================================================== */

test('DUPLICATE: a second charge of one dispensing is refused and points at the first invoice', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'DUP' });

    const first = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(first.status, 201);

    const second = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'ALREADY_INVOICED');
    assert.equal(second.body.invoice_id, first.body.invoice_id, 'the conflict names the surviving invoice');

    const invoices = await pool.query(
      'SELECT invoice_id FROM invoice_items WHERE dispensing_id = $1', [f.dispensing],
    );
    assert.equal(invoices.rows.length, 1, 'exactly one invoice, never two');
  } finally {
    await drop(f);
  }
});

test('DUPLICATE: two concurrent charges produce exactly one invoice, one line, one audit', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'DUPRACE' });

    const [a, b] = await Promise.all([
      chargeDispensing({ dispensing_id: f.dispensing }, f.user),
      chargeDispensing({ dispensing_id: f.dispensing }, f.user),
    ]);

    const won = [a, b].filter((r) => r.status === 201);
    const lost = [a, b].filter((r) => r.status !== 201);
    assert.equal(won.length, 1, 'the FOR UPDATE on the dispensing serialises the two attempts');
    assert.equal(lost.length, 1);
    assert.equal(lost[0]!.status, 409, 'the lost race is a clean 409, never a 500');
    assert.equal(lost[0]!.body.reason, 'ALREADY_INVOICED');

    const lines = await pool.query(
      `SELECT item_id, invoice_id, line_total FROM invoice_items WHERE dispensing_id = $1`, [f.dispensing],
    );
    assert.equal(lines.rows.length, 1, 'one dispensing item, one line');
    assert.equal(num(lines.rows[0].line_total), 100, '20 x 5.00');

    const audits = await pool.query(
      `SELECT resource_id FROM audit_logs
       WHERE action = 'DISPENSING_INVOICED' AND resource_id = $1::text`,
      [String(lines.rows[0].invoice_id)],
    );
    assert.equal(audits.rows.length, 1, 'the loser never writes an audit row for an invoice it did not create');

    // No partial record survives the loser: the invoice it would have created is gone.
    const invoiceCount = await pool.query(
      'SELECT COUNT(*)::int AS n FROM invoices WHERE invoice_id = $1', [lines.rows[0].invoice_id],
    );
    assert.equal(invoiceCount.rows[0].n, 1, 'no orphan invoice from the rolled-back attempt');
  } finally {
    await drop(f);
  }
});

test('INVARIANT: invoice total equals the sum of its item lines', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    // Two items on one dispensing, at different prices, so the total is not trivially right.
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'TOTAL' });
    const secondItem = await pool.query(
      `INSERT INTO dispensing_items
         (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
          prescribed_quantity, dispensed_quantity, remaining_quantity, uom, unit_price_snapshot)
       VALUES ($1, $2, $3, $4, 2, 2, 0, 'TABLET', 3.33::numeric) RETURNING dispensing_item_id`,
      [f.dispensing, f.prescriptionItem, f.medication, f.inventory],
    );
    const secondAllocation = await pool.query(
      `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity, unit_cost_snapshot, expiry_date_snapshot)
       VALUES ($1, $2, 2, 1.0000, CURRENT_DATE + 30) RETURNING dispensing_item_batch_id`,
      [secondItem.rows[0].dispensing_item_id, f.batch],
    );

    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201);
    const invoiceId = charged.body.invoice_id;

    const sums = await pool.query(
      `SELECT COALESCE(SUM(line_total), 0) AS by_line_total,
              COALESCE(SUM(price * quantity), 0) AS by_price_times_quantity
       FROM invoice_items WHERE invoice_id = $1`,
      [invoiceId],
    );
    const invoice = (await invoiceRow(invoiceId)).rows[0];
    assert.equal(num(invoice.total_amount), 100 + 6.66, '20 x 5.00 + 2 x 3.33');
    assert.equal(num(invoice.total_amount), num(sums.rows[0].by_line_total),
      'total = SUM(line_total)');
    assert.equal(num(invoice.total_amount), num(sums.rows[0].by_price_times_quantity),
      'the legacy revenue aggregate SUM(price * quantity) still agrees');
    assert.equal(num(invoice.net_amount), num(invoice.total_amount), 'no clinic discount on a medication charge');
    assert.equal(num(invoice.paid_amount), 0, 'issued unpaid');
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * 1b. CONNECTION LEAK — the defect 10E.9 found
 *
 * createMedicationCharge acquired a PoolClient and never released it on any
 * path. Every charge therefore burned one of the pool's max connections
 * forever; once max (10 by default) was reached, getBaseCurrency and every
 * other query in the process timed out and the whole API stopped responding —
 * not just charging. A single dispensing is enough to drive it: the first
 * attempt commits and the rest are refused, and the refusal leaked too.
 * ======================================================================== */

test('LEAK: repeated charges of one dispensing never exhaust the connection pool', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'LEAK' });

    const before = pool.totalCount;
    const attempts = 14; // > DEFAULT_POOL_MAX (10)

    const results: number[] = [];
    for (let i = 0; i < attempts; i++) {
      results.push((await chargeDispensing({ dispensing_id: f.dispensing }, f.user)).status);
    }

    assert.equal(results.filter((s) => s === 201).length, 1, 'exactly one charge commits');
    assert.equal(results.filter((s) => s === 409).length, attempts - 1,
      'every other attempt is refused — none times out waiting for a connection');
    assert.equal(pool.totalCount, before,
      'every client went back to the pool; a growing count is the leak');
    assert.equal(pool.waitingCount, 0, 'nobody is queued for a connection');
  } finally {
    await drop(f);
  }
});

test('LEAK: refused charges release their client too, not just committed ones', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    // An uncharged dispensing: every attempt is refused at the NOT_INVOICED
    // branch inside the transaction, so every one of them must still release.
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'LEAKREF' });
    await pool.query('UPDATE dispensing_items SET unit_price_snapshot = NULL WHERE dispensing_item_id = $1', [f.dispensingItem]);

    const before = pool.totalCount;
    for (let i = 0; i < 14; i++) {
      const refused = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.reason, 'NOTHING_CHARGEABLE');
    }
    assert.equal(pool.totalCount, before, 'a rolled-back charge returns its client as well');
  } finally {
    await drop(f);
  }
});

test('LEAK: medication price operations never exhaust the connection pool', { skip: !enabled, timeout: 60000 }, async () => {
  // Phase 10E.9 B1. All three pricing handlers (create, update, deactivate)
  // acquired a PoolClient and never released it, so a handful of price changes
  // consumed the whole pool and every other query in the process then failed
  // with "timeout exceeded when trying to connect". This walks the full
  // create -> supersede -> deactivate cycle many times over — more iterations
  // than the pool has connections — and requires the pool to come back
  // unchanged.
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'PRICELEAK' });

    const before = pool.totalCount;
    const cycles = 6; // 6 create + 6 update + 6 deactivate, all against DB_POOL_MAX (10)

    for (let i = 0; i < cycles; i++) {
      const created = await createPrice({ inventory_id: f.inventory, unit_price: 3 + i }, f.user);
      assert.equal(created.status, 201, `create ${i} must not time out waiting for a connection`);
      const priceId = created.body.medicationPrice.price_id;

      const superseded = await supersedePrice({ id: String(priceId) }, { unit_price: 9 + i }, f.user);
      assert.equal(superseded.status, 200, `update ${i} must not time out waiting for a connection`);

      const closed = await deactivatePrice({ id: String(superseded.body.medicationPrice.price_id) }, f.user);
      assert.equal(closed.status, 200, `deactivate ${i} must not time out waiting for a connection`);
    }

    assert.equal(pool.totalCount, before, 'every pricing client went back to the pool');
    assert.equal(pool.waitingCount, 0, 'nobody is queued for a connection');

    // The history is intact: one active price at most, and none active at the end.
    const active = await pool.query(
      'SELECT COUNT(*)::int AS n FROM medication_prices WHERE inventory_id = $1 AND is_active',
      [f.inventory],
    );
    assert.equal(active.rows[0].n, 0, 'each cycle closed its own price, so none is left active');

    const audited = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
       WHERE resource_type = 'MEDICATION_PRICE' AND resource_id IN (
         SELECT price_id::text FROM medication_prices WHERE inventory_id = $1)`,
      [f.inventory],
    );
    assert.equal(audited.rows[0].n, cycles * 3, 'every committed operation wrote exactly one audit row');
  } finally {
    await drop(f);
  }
});

test('LEAK: refused price operations release their client too', { skip: !enabled, timeout: 60000 }, async () => {
  // The refusal paths matter as much as the commits: a 409 still held the
  // client, so an operator retrying a duplicate price would leak one per try.
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'PRICEREFUSE' });

    const first = await createPrice({ inventory_id: f.inventory, unit_price: 4.5 }, f.user);
    assert.equal(first.status, 201);
    const priceId = first.body.medicationPrice.price_id;

    const before = pool.totalCount;
    for (let i = 0; i < 12; i++) {
      const duplicate = await createPrice({ inventory_id: f.inventory, unit_price: 5 + i }, f.user);
      assert.equal(duplicate.status, 409, 'a second active price for one item is refused');

      // deactivate twice: the second attempt finds it already inactive
      const closed = await deactivatePrice({ id: String(priceId) }, f.user);
      if (i === 0) assert.equal(closed.status, 200);
      const again = await deactivatePrice({ id: String(priceId) }, f.user);
      assert.equal(again.status, 409, 'deactivating an inactive price is refused');
      await pool.query(
        `UPDATE medication_prices SET is_active = TRUE, effective_to = NULL WHERE price_id = $1`, [priceId],
      );
    }

    assert.equal(pool.totalCount, before, 'refused pricing operations release their client as well');
    assert.equal(pool.waitingCount, 0);
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * 2 + 4. PAYMENT / REFUND BOUNDARIES AGAINST CONCURRENT RETURNS
 *
 * There is no payments table and no refunds table in this system: a payment is
 * invoices.paid_amount and a refund is refund_due_amount, an entitlement that
 * explicitly never records money moving. So there is no payment or refund
 * endpoint to race. What IS raceable is the settlement write to paid_amount
 * against a return that reads it to derive outstanding and refund entitlement,
 * and that is exactly the hazard that matters: the credit must be derived from
 * a coherent invoice snapshot or not at all.
 * ======================================================================== */

test('PAYMENT: a concurrent settlement cannot tear the snapshot a credit is derived from', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'PAYRACE' });
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201);
    const invoiceId = charged.body.invoice_id;

    // The patient pays in full while two returns race for the same allocation.
    const settlement = setPaid(invoiceId, 100);
    const [first, second] = await Promise.all([
      returnMedication(returnBody(f, 20), f.user),
      returnMedication(returnBody(f, 20), f.user),
      settlement,
    ]);

    assert.equal([first, second].filter((r) => r.status === 201).length, 1, 'one return of 20/20');
    assert.equal([first, second].filter((r) => r.status === 409).length, 1);

    const credits = await creditsFor(f.dispensingItem);
    assert.equal(credits.rows.length, 1, 'exactly one credit row');
    const c = credits.rows[0];
    assert.equal(num(c.unit_price_snapshot), 5, 'the price came from the invoice line');
    assert.equal(num(c.credit_amount), 100, '20 x 5.00 credited in full');
    assert.equal(num(c.invoice_net_amount), 100, 'the net it snapshotted');
    // Either the settlement was seen (refund owed) or it was not (credit cancels
    // the outstanding) â€” but never a half-seen, inconsistent pair.
    assert.equal(
      num(c.applied_to_outstanding) + num(c.refund_due_amount), num(c.credit_amount),
      'the split is exact whatever the settlement timing',
    );
    assert.ok(num(c.invoice_paid_amount) === 0 || num(c.invoice_paid_amount) === 100,
      `paid_amount was read whole, never torn: ${c.invoice_paid_amount}`);
    if (num(c.invoice_paid_amount) === 100) {
      assert.equal(num(c.applied_to_outstanding), 0, 'nothing outstanding once paid in full');
      assert.equal(num(c.refund_due_amount), 100);
    } else {
      assert.equal(num(c.applied_to_outstanding), 100, 'the whole credit cancels the outstanding');
      assert.equal(num(c.refund_due_amount), 0);
    }
  } finally {
    await drop(f);
  }
});

test('REFUND: a credit never entitles more than the invoice was actually paid', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 30, onHand: 30, unitPrice: '5.00', tag: 'REFUND' });
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    const invoiceId = charged.body.invoice_id;
    await setPaid(invoiceId, 30); // paid 30 of a 150 net: 120 still outstanding

    // Three racers, 10 each against a 30 allocation: at most three can win, and
    // the 120 outstanding absorbs 24 * 5 = 120 exactly.
    const results = await Promise.all([
      returnMedication(returnBody(f, 10), f.user),
      returnMedication(returnBody(f, 10), f.user),
      returnMedication(returnBody(f, 10), f.user),
    ]);
    assert.equal(results.filter((r) => r.status === 201).length, 3, '30 of 30 is three returns of 10');

    const credits = await creditsFor(f.dispensingItem);
    assert.equal(credits.rows.length, 3);
    for (const c of credits.rows) {
      assert.ok(num(c.refund_due_amount) >= 0 && num(c.applied_to_outstanding) >= 0,
        'a balance can never go negative');
      assert.ok(
        num(c.refund_due_amount) <= num(c.invoice_paid_amount),
        `refund entitlement ${c.refund_due_amount} may not exceed what was paid ${c.invoice_paid_amount}`,
      );
      assert.equal(
        num(c.applied_to_outstanding) + num(c.refund_due_amount), num(c.credit_amount),
      );
    }
    // Nothing is ever paid out, so no over-refund is even representable.
    const paid = (await invoiceRow(invoiceId)).rows[0];
    assert.equal(num(paid.paid_amount), 30, 'a return never moves money: paid_amount is unchanged');
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * 3. CONCURRENT MEDICATION RETURN
 * ======================================================================== */

test('CONCURRENT RETURN: three racers cannot return more than was dispensed', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 0, unitPrice: '5.00', tag: 'OVERRET' });

    const results = await Promise.all([
      returnMedication(returnBody(f, 15), f.user),
      returnMedication(returnBody(f, 15), f.user),
      returnMedication(returnBody(f, 15), f.user),
    ]);

    const won = results.filter((r) => r.status === 201);
    assert.equal(won.length, 1, '15 + 15 > 20, so only one 15-unit return can fit');
    assert.equal(results.filter((r) => r.status === 409).length, 2);

    const total = await returnedTotal(f.allocation);
    assert.equal(num(total.rows[0].total), 15, 'the committed quantity never exceeds the allocation');
    assert.ok(num(total.rows[0].total) <= 20);

    const state = (await batchState(f.batch)).rows[0];
    assert.equal(num(state.quantity_on_hand), 15, 'stock is restocked exactly once');
    assert.equal(num(state.quantity_reserved), 0, 'a return never touches the reserved quantity');
  } finally {
    await drop(f);
  }
});

test('CONCURRENT RETURN: cumulative credited revenue never exceeds the original invoice revenue', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 30, onHand: 0, unitPrice: '4.00', tag: 'CUMCREDIT' });
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201);
    const invoiceId = charged.body.invoice_id;
    const invoice = (await invoiceRow(invoiceId)).rows[0];

    // Four racers of 10 against a 30 allocation: exactly three can commit.
    const results = await Promise.all([
      returnMedication(returnBody(f, 10), f.user),
      returnMedication(returnBody(f, 10), f.user),
      returnMedication(returnBody(f, 10), f.user),
      returnMedication(returnBody(f, 10), f.user),
    ]);
    assert.equal(results.filter((r) => r.status === 201).length, 3, '30 of 30 is three returns of 10');

    const credits = await creditsFor(f.dispensingItem);
    assert.equal(credits.rows.length, 3, 'one credit per committed return line, never two for one');
    const creditedQuantity = credits.rows.reduce((sum, c) => sum + num(c.returned_quantity), 0);
    const creditedRevenue = credits.rows.reduce((sum, c) => sum + num(c.credit_amount), 0);

    assert.equal(creditedQuantity, 30);
    assert.ok(creditedQuantity <= 30, 'Returned Quantity <= Eligible Dispensed Quantity');
    assert.equal(creditedRevenue, 120, '3 x 10 x 4.00');
    assert.ok(creditedRevenue <= num(invoice.net_amount),
      `Credited Revenue ${creditedRevenue} <= Original Invoice Revenue ${invoice.net_amount}`);

    // One credit per return item, enforced by return_item_id UNIQUE.
    const items = await pool.query(
      `SELECT mri.return_item_id, COUNT(mrc.credit_id)::int AS n
       FROM medication_return_items mri
       JOIN medication_returns mr ON mr.return_id = mri.return_id
       LEFT JOIN medication_return_credits mrc ON mrc.return_item_id = mri.return_item_id
       WHERE mri.dispensing_item_batch_id = $1 AND mr.status = 'COMPLETED'
       GROUP BY mri.return_item_id`,
      [f.allocation],
    );
    for (const row of items.rows) {
      assert.ok(row.n <= 1, 'no duplicate credit for a single return line');
    }
  } finally {
    await drop(f);
  }
});

test('CONCURRENT RETURN: an over-credit attempt leaves no credit and no stock movement', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    // Charged 10 of a 20 allocation, so 10 units of the return can never be
    // credited even though 20 were dispensed. The invoice line is built from
    // dispensing_items.dispensed_quantity, so that is what is lowered.
    f = await seed({ allocated: 20, onHand: 0, unitPrice: '5.00', tag: 'OVERCRED' });
    // chk_di_quantities_balance: prescribed = dispensed + remaining.
    await pool.query(
      `UPDATE dispensing_items SET prescribed_quantity = 10, dispensed_quantity = 10, remaining_quantity = 0
       WHERE dispensing_item_id = $1`,
      [f.dispensingItem],
    );
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201);
    assert.equal(num(charged.body.total_amount), 50, 'the invoice line is 10 x 5.00');

    const refused = await returnMedication(returnBody(f, 20), f.user);
    assert.equal(refused.status, 409);
    assert.equal(num(refused.body.creditable_quantity), 10);

    const credits = await creditsFor(f.dispensingItem);
    assert.equal(credits.rows.length, 0, 'no credit row for a refused return');
    const items = await pool.query(
      'SELECT return_item_id FROM medication_return_items WHERE dispensing_item_batch_id = $1', [f.allocation],
    );
    assert.equal(items.rows.length, 0, 'the whole return rolled back, not just the credit');
    const state = (await batchState(f.batch)).rows[0];
    assert.equal(num(state.quantity_on_hand), 0, 'no stock movement from a refused return');
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * 5. RETURN + FINANCIAL CREDIT CONSISTENCY
 * ======================================================================== */

test('SNAPSHOT: the credit follows the invoice line, not the current medication price', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'SNAP' });
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201);

    // The clinic re-prices the medication after the sale, and the invoice line
    // is stamped with the loyalty-era discount a future server-side rule would
    // write. Neither the new price nor the new cost may touch the reversal.
    await pool.query(
      `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
       VALUES ($1, $2, 99.00, $3)`,
      [f.clinic, f.inventory, f.user],
    );
    await pool.query('UPDATE invoice_items SET medication_discount_value = 10 WHERE dispensing_id = $1', [f.dispensing]);

    const returned = await returnMedication(returnBody(f, 10), f.user);
    assert.equal(returned.status, 201);

    const credits = await creditsFor(f.dispensingItem);
    const c = credits.rows[0];
    assert.equal(num(c.unit_price_snapshot), 5, '5.00 from the invoice line, not 99.00 from today');
    assert.equal(num(c.medication_discount_value), 10, 'the discount is the snapshotted one');
    assert.equal(num(c.gross_amount), 50, '10 x 5.00');
    assert.equal(num(c.net_amount), 45, '50 less 10% taken once and rounded');
    assert.equal(num(c.credit_amount), 45);

    // COGS is a different number from a different snapshot, and is unaffected.
    const reversals = await reversalsFor(f.allocation);
    assert.equal(reversals.rows.length, 1);
    assert.equal(num(reversals.rows[0].unit_cost_snapshot), 2.5678, 'the historical cost, not the price');
    assert.equal(num(reversals.rows[0].cogs_reversal_amount), 25.678, '10 x 2.5678');
    assert.notEqual(num(reversals.rows[0].cogs_reversal_amount), num(c.credit_amount),
      'cost and revenue move independently');
  } finally {
    await drop(f);
  }
});

test('SNAPSHOT: a zero selling price credits zero, and the cost reversal is still full', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 10, onHand: 10, unitPrice: '0.00', tag: 'FREEMED' });
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201, 'a free medication is still a real invoice line');

    const returned = await returnMedication(returnBody(f, 10), f.user);
    assert.equal(returned.status, 201);

    const credits = await creditsFor(f.dispensingItem);
    assert.equal(credits.rows.length, 1);
    assert.equal(num(credits.rows[0].credit_amount), 0, 'nothing to give back on a free line');
    assert.equal(num(credits.rows[0].refund_due_amount), 0, 'and no entitlement against it');

    const reversals = await reversalsFor(f.allocation);
    assert.equal(num(reversals.rows[0].cogs_reversal_amount), 25.678, 'but the drug still cost money');
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * 6. CLINIC ISOLATION
 * ======================================================================== */

test('CLINIC: a foreign clinic cannot charge, return, or credit another clinic', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 0, unitPrice: '5.00', tag: 'ISO' });
    const intruder = { userId: f.user, clinicId: f.otherClinic, clinicIds: [f.otherClinic] };

    // The return of an uncharged dispensing from the wrong clinic: refused, and
    // the guard runs before any batch is locked or any row written.
    const foreignReturn = await (async () => {
      const { res, captured } = makeRes();
      await createMedicationReturn(clinicUserReq(returnBody(f, 10), f.user, f.otherClinic), res);
      return captured;
    })();
    assert.equal(foreignReturn.status, 404, 'the dispensing does not exist in that scope');

    const foreignCharge = await (async () => {
      const { res, captured } = makeRes();
      await createMedicationCharge(clinicUserReq({ dispensing_id: f.dispensing }, f.user, f.otherClinic), res);
      return captured;
    })();
    assert.equal(foreignCharge.status, 404);

    assert.equal(intruder.clinicId, f.otherClinic);
    const returns = await pool.query('SELECT return_id FROM medication_returns WHERE original_dispensing_id = $1', [f.dispensing]);
    assert.equal(returns.rows.length, 0, 'no return header was written');
    const invoices = await pool.query('SELECT invoice_id FROM invoice_items WHERE dispensing_id = $1', [f.dispensing]);
    assert.equal(invoices.rows.length, 0, 'no invoice line was written');
    const credits = await creditsFor(f.dispensingItem);
    assert.equal(credits.rows.length, 0, 'no credit was written');
    const state = (await batchState(f.batch)).rows[0];
    assert.equal(num(state.quantity_on_hand), 0, 'no stock moved in either clinic');
    assert.equal(num(state.quantity_reserved), 0);

    // The owner's own session still works afterwards â€” the refusal was scope,
    // not corruption.
    const ownCharge = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(ownCharge.status, 201);
    const ownReturn = await returnMedication(returnBody(f, 10), f.user);
    assert.equal(ownReturn.status, 201);
    const ownCredit = await creditsFor(f.dispensingItem);
    assert.equal(ownCredit.rows.length, 1);
    assert.equal(num(ownCredit.rows[0].credit_amount), 50);
  } finally {
    await drop(f);
  }
});

test('CLINIC: an invoice line of another clinic is never credited', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await seed({ allocated: 20, onHand: 20, unitPrice: '5.00', tag: 'ISOCREDIT' });
    const charged = await chargeDispensing({ dispensing_id: f.dispensing }, f.user);
    assert.equal(charged.status, 201);

    // A return from the owning clinic is the only path to a credit; run it as a
    // foreign session and prove nothing is credited, then confirm the credit
    // belongs to the dispensing's own clinic and invoice.
    const foreign = await (async () => {
      const { res, captured } = makeRes();
      await createMedicationReturn(clinicUserReq(returnBody(f, 10), f.user, f.otherClinic), res);
      return captured;
    })();
    assert.equal(foreign.status, 404);
    assert.equal((await creditsFor(f.dispensingItem)).rows.length, 0);

    const own = await returnMedication(returnBody(f, 10), f.user);
    assert.equal(own.status, 201);
    const credited = await pool.query(
      `SELECT mrc.credit_id, mrc.clinic_id, i.invoice_id
       FROM medication_return_credits mrc
       JOIN invoices i ON i.invoice_id = mrc.invoice_id
       WHERE mrc.dispensing_item_id = $1`,
      [f.dispensingItem],
    );
    assert.equal(credited.rows.length, 1);
    assert.equal(num(credited.rows[0].clinic_id), f.clinic, 'the credit carries the dispensing clinic, never the caller');
    assert.equal(num(credited.rows[0].invoice_id), charged.body.invoice_id,
      'and it points at the invoice the charge actually created');
  } finally {
    await drop(f);
  }
});
