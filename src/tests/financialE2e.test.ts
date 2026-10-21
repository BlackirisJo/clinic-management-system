import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createDispensing, voidDispensing } from '../modules/inventory/dispensings.controller';
import { getPharmacyQueue } from '../modules/prescriptions/prescriptions.controller';
import { createMedicationCharge } from '../modules/billing/medicationCharges.controller';
import { createMedicationReturn } from '../modules/inventory/medicationReturns.controller';

/* ==========================================================================
 * Phase 10E.10 — End-to-end financial verification against real PostgreSQL
 *
 * One continuous production path, driven through the real controllers and the
 * real database, no mocks:
 *
 *   patient -> visit -> prescription -> pharmacy queue -> dispensing
 *   -> inventory deduction -> invoice / medication charge
 *   -> medication return -> inventory restoration -> COGS reversal
 *   -> revenue credit
 *
 * Nothing here asserts new behaviour. Every expectation is read back out of
 * the database after the production code ran, so this verifies what the system
 * actually does, not what it claims.
 *
 * Gated like the project's other DB-backed tests so it never runs against a
 * developer's database implicitly:
 *   FINANCIAL_E2E_TEST=1
 * ======================================================================== */

const enabled = process.env.FINANCIAL_E2E_TEST === '1';

const num = (value: unknown): number => Number(value);

interface Session {
  userId: number; clinicId: number | null; clinicIds: number[]; roleName: string;
}

const admin = (userId: number): Session =>
  ({ userId, clinicId: null, clinicIds: [], roleName: 'SUPER_ADMIN' });

const scoped = (userId: number, clinicId: number): Session =>
  ({ userId, clinicId, clinicIds: [clinicId], roleName: 'PHARMACIST' });

const makeReq = (
  body: Record<string, unknown>,
  session: Session,
  params: Record<string, unknown> = {},
): AuthenticatedRequest =>
  ({
    body, params, query: {},
    user: { userId: session.userId, roleId: 1, clinicId: session.clinicId, roleName: session.roleName, permissions: [], clinicIds: session.clinicIds },
  } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const dispense = async (prescriptionId: number, session: Session) => {
  const { res, captured } = makeRes();
  await createDispensing(makeReq({ prescription_id: prescriptionId }, session), res);
  return captured;
};

const voidDispense = async (dispensingId: number, session: Session) => {
  const { res, captured } = makeRes();
  await voidDispensing(makeReq({ reason: 'E2E void check' }, session, { id: String(dispensingId) }), res);
  return captured;
};

const queue = async (session: Session) => {
  const { res, captured } = makeRes();
  await getPharmacyQueue(makeReq({}, session), res);
  return captured;
};

const charge = async (dispensingId: number, session: Session, extra: Record<string, unknown> = {}) => {
  const { res, captured } = makeRes();
  await createMedicationCharge(makeReq({ dispensing_id: dispensingId, ...extra }, session), res);
  return captured;
};

const returnMedication = async (
  body: Record<string, unknown>,
  session: Session,
) => {
  const { res, captured } = makeRes();
  await createMedicationReturn(makeReq(body, session), res);
  return captured;
};

interface Fixture {
  clinic: number; foreignClinic: number; doctor: number; patient: number; visit: number;
  prescription: number; prescriptionItem: number; medication: number; inventory: number;
  earlyBatch: number; lateBatch: number; dispensing: number; dispensingItem: number;
  allocation: number; invoice: number;
}

const NOTHING: Fixture = {
  clinic: 0, foreignClinic: 0, doctor: 0, patient: 0, visit: 0, prescription: 0,
  prescriptionItem: 0, medication: 0, inventory: 0, earlyBatch: 0, lateBatch: 0,
  dispensing: 0, dispensingItem: 0, allocation: 0, invoice: 0,
};

/**
 * Two batches with different expiry dates so FEFO has a real choice to make,
 * a known unit cost on each, and an active selling price — the last one is what
 * the dispensing snapshots (10E.3) and what the charge later bills.
 */
const seed = async (opts: { tag: string; prescribed: number; onHand: number; unitCost: string; unitPrice: string }): Promise<Fixture> => {
  const stamp = `${opts.tag}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`E2E-${stamp}`],
  );
  const foreign = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`E2E-FOREIGN-${stamp}`],
  );
  const doctor = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['E2E Doctor', `e2e-doc-${stamp}`, 'x'],
  );
  const patient = await pool.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ($1, $2, 'MALE', '1990-01-01', $3) RETURNING patient_id`,
    ['E2E Patient', `07${String(Date.now()).slice(-8)}`, clinic.rows[0].clinic_id],
  );
  const visit = await pool.query(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id) VALUES ($1, $2, $3) RETURNING visit_id`,
    [patient.rows[0].patient_id, clinic.rows[0].clinic_id, doctor.rows[0].user_id],
  );
  const prescription = await pool.query(
    `INSERT INTO prescriptions (visit_id, patient_id, doctor_id) VALUES ($1, $2, $3) RETURNING prescription_id`,
    [visit.rows[0].visit_id, patient.rows[0].patient_id, doctor.rows[0].user_id],
  );
  const medication = await pool.query(
    `INSERT INTO medications (trade_name, scientific_name, dosage_form) VALUES ($1, 'E2E Test', 'TABLET') RETURNING medication_id`,
    [stamp],
  );
  const prescriptionItem = await pool.query(
    `INSERT INTO prescription_items
       (prescription_id, medication_id, dosage, frequency, duration, prescribed_quantity, uom)
     VALUES ($1, $2, '1 x 2', 'BID', '5 days', $3, 'TABLET') RETURNING item_id`,
    [prescription.rows[0].prescription_id, medication.rows[0].medication_id, opts.prescribed],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  // The earlier-expiring batch is the one FEFO must choose.
  const early = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
     VALUES ($1, $2, CURRENT_DATE + 10, $3, 0, $4::numeric) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, `EARLY-${stamp}`, opts.onHand, opts.unitCost],
  );
  const late = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
     VALUES ($1, $2, CURRENT_DATE + 90, $3, 0, $4::numeric) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, `LATE-${stamp}`, opts.onHand, opts.unitCost],
  );
  // The active selling price the dispensing will snapshot.
  await pool.query(
    `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
     VALUES ($1, $2, $3::numeric, $4)`,
    [clinic.rows[0].clinic_id, inventory.rows[0].inventory_id, opts.unitPrice, doctor.rows[0].user_id],
  );

  return {
    clinic: num(clinic.rows[0].clinic_id), foreignClinic: num(foreign.rows[0].clinic_id),
    doctor: num(doctor.rows[0].user_id), patient: num(patient.rows[0].patient_id),
    visit: num(visit.rows[0].visit_id), prescription: num(prescription.rows[0].prescription_id),
    prescriptionItem: num(prescriptionItem.rows[0].item_id), medication: num(medication.rows[0].medication_id),
    inventory: num(inventory.rows[0].inventory_id), earlyBatch: num(early.rows[0].batch_id),
    lateBatch: num(late.rows[0].batch_id), dispensing: 0, dispensingItem: 0, allocation: 0, invoice: 0,
  };
};

/**
 * Everything this flow can create, removed in FK-RESTRICT-safe order.
 * Scoped entirely to the fixture's own rows: no WHERE clause here can match
 * another suite's data.
 */
const drop = async (f: Fixture) => {
  const invoices = f.dispensing
    ? (await pool.query('SELECT DISTINCT invoice_id FROM invoice_items WHERE dispensing_id = $1', [f.dispensing])).rows.map((r) => num(r.invoice_id))
    : [];
  const returns = f.dispensing
    ? (await pool.query('SELECT return_id FROM medication_returns WHERE original_dispensing_id = $1', [f.dispensing])).rows.map((r) => num(r.return_id))
    : [];

  if (f.dispensingItem) {
    await pool.query('DELETE FROM medication_return_credits WHERE dispensing_item_id = $1', [f.dispensingItem]);
  }
  if (f.allocation) {
    await pool.query('DELETE FROM medication_return_reversals WHERE dispensing_item_batch_id = $1', [f.allocation]);
    await pool.query('DELETE FROM medication_return_items WHERE dispensing_item_batch_id = $1', [f.allocation]);
  }
  for (const returnId of returns) {
    await pool.query(
      `DELETE FROM stock_movements WHERE reference_type = 'MEDICATION_RETURN' AND reference_id = $1`, [returnId],
    );
    await pool.query(
      `DELETE FROM audit_logs WHERE resource_type = 'MEDICATION_RETURN' AND resource_id = $1::text`, [returnId],
    );
    await pool.query('DELETE FROM batch_quarantines WHERE batch_id = ANY(ARRAY[$1::int, $2::int]) AND released_at IS NULL', [f.earlyBatch, f.lateBatch]);
  }
  await pool.query('DELETE FROM medication_returns WHERE original_dispensing_id = $1', [f.dispensing]);
  if (f.dispensing) {
    await pool.query(
      `DELETE FROM stock_movements WHERE reference_type IN ('DISPENSING','DISPENSING_VOID') AND reference_id = $1::text`,
      [f.dispensing],
    );
    await pool.query(
      `DELETE FROM audit_logs WHERE resource_type = 'DISPENSING' AND resource_id = $1::text`, [f.dispensing],
    );
  }
  if (invoices.length > 0) {
    await pool.query(
      `DELETE FROM audit_logs WHERE action = 'DISPENSING_INVOICED' AND resource_id = ANY($1::text[])`,
      [invoices.map(String)],
    );
    await pool.query('DELETE FROM invoice_items WHERE invoice_id = ANY($1::int[])', [invoices]);
    await pool.query('DELETE FROM invoices WHERE invoice_id = ANY($1::int[])', [invoices]);
  }
  if (f.dispensing) {
    await pool.query(
      `DELETE FROM dispensing_item_batches WHERE dispensing_item_id IN (SELECT dispensing_item_id FROM dispensing_items WHERE dispensing_id = $1)`,
      [f.dispensing],
    );
    await pool.query('DELETE FROM dispensing_items WHERE dispensing_id = $1', [f.dispensing]);
    await pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [f.dispensing]);
  }
  if (f.inventory) {
    await pool.query('DELETE FROM medication_prices WHERE inventory_id = $1', [f.inventory]);
    await pool.query('DELETE FROM inventory_batches WHERE batch_id = ANY(ARRAY[$1::int, $2::int])', [f.earlyBatch, f.lateBatch]);
    await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  }
  if (f.prescriptionItem) await pool.query('DELETE FROM prescription_items WHERE item_id = $1', [f.prescriptionItem]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.prescription) await pool.query('DELETE FROM prescriptions WHERE prescription_id = $1', [f.prescription]);
  if (f.patient) {
    await pool.query('DELETE FROM visits WHERE visit_id = $1', [f.visit]);
    await pool.query('DELETE FROM patients WHERE patient_id = $1', [f.patient]);
  }
  if (f.doctor) await pool.query('DELETE FROM users WHERE user_id = $1', [f.doctor]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = ANY(ARRAY[$1::int, $2::int])', [f.clinic, f.foreignClinic]);
};

/** Counts of every table this flow touches, so side effects can be compared. */
const snapshot = async () => {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM clinics) AS clinics,
      (SELECT COUNT(*)::int FROM patients) AS patients,
      (SELECT COUNT(*)::int FROM visits) AS visits,
      (SELECT COUNT(*)::int FROM prescriptions) AS prescriptions,
      (SELECT COUNT(*)::int FROM prescription_items) AS prescription_items,
      (SELECT COUNT(*)::int FROM medications) AS medications,
      (SELECT COUNT(*)::int FROM inventory_items) AS inventory_items,
      (SELECT COUNT(*)::int FROM inventory_batches) AS inventory_batches,
      (SELECT COUNT(*)::int FROM dispensing_item_batches) AS allocations,
      (SELECT COUNT(*)::int FROM dispensings) AS dispensings,
      (SELECT COUNT(*)::int FROM dispensing_items) AS dispensing_items,
      (SELECT COUNT(*)::int FROM invoices) AS invoices,
      (SELECT COUNT(*)::int FROM invoice_items) AS invoice_items,
      (SELECT COUNT(*)::int FROM medication_prices) AS prices,
      (SELECT COUNT(*)::int FROM medication_returns) AS returns,
      (SELECT COUNT(*)::int FROM medication_return_items) AS return_items,
      (SELECT COUNT(*)::int FROM medication_return_reversals) AS reversals,
      (SELECT COUNT(*)::int FROM medication_return_credits) AS credits,
      (SELECT COUNT(*)::int FROM stock_movements) AS movements,
      (SELECT COUNT(*)::int FROM audit_logs) AS audits,
      (SELECT COALESCE(SUM(quantity_on_hand), 0) FROM inventory_batches) AS total_stock
  `);
  return r.rows[0] as Record<string, number>;
};

const batchState = (batchId: number) =>
  pool.query('SELECT quantity_on_hand, quantity_reserved FROM inventory_batches WHERE batch_id = $1', [batchId]);

const movementsFor = (referenceType: string, referenceId: number) =>
  pool.query(
    `SELECT movement_id, batch_id, movement_type, quantity, reference_type, reference_id
     FROM stock_movements WHERE reference_type = $1 AND reference_id = $2::text ORDER BY movement_id`,
    [referenceType, String(referenceId)],
  );

const auditsFor = (resourceType: string, resourceId: number) =>
  pool.query(
    `SELECT audit_id, action FROM audit_logs WHERE resource_type = $1 AND resource_id = $2::text ORDER BY audit_id`,
    [resourceType, String(resourceId)],
  );

/** The controller nests its payload under `dispensing`. */
const dispensingIdOf = (body: any): number => num(body.dispensing.dispensing_id);

/** Dispense, then read back the ids the flow produced. */
const runDispensing = async (f: Fixture): Promise<Fixture> => {
  const result = await dispense(f.prescription, admin(f.doctor));
  assert.equal(result.status, 201, `dispensing failed: ${JSON.stringify(result.body)}`);

  const item = (await pool.query(
    `SELECT di.dispensing_item_id FROM dispensing_items di WHERE di.dispensing_id = $1`, [dispensingIdOf(result.body)],
  )).rows[0];
  const allocation = (await pool.query(
    `SELECT dispensing_item_batch_id FROM dispensing_item_batches WHERE dispensing_item_id = $1`, [item.dispensing_item_id],
  )).rows[0];

  return {
    ...f,
    dispensing: dispensingIdOf(result.body),
    dispensingItem: num(item.dispensing_item_id),
    allocation: num(allocation.dispensing_item_batch_id),
  };
};

/* ==========================================================================
 * THE PRODUCTION PATH, END TO END
 * ======================================================================== */

test('E2E: patient -> dispensing -> charge -> return, verified in the database', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  const baseline = await snapshot();
  try {
    // ---------------------------------------------------------------- 0. seed
    // 20 prescribed at 5.00/unit and 2.50/unit cost; two batches of 30 so FEFO
    // must pick the earlier-expiring one and leave the later one untouched.
    f = await seed({ tag: 'FLOW', prescribed: 20, onHand: 30, unitCost: '2.50', unitPrice: '5.00' });

    /* ------------------------------------------------------- 1. prescription */
    const item = (await pool.query(
      'SELECT prescribed_quantity, uom FROM prescription_items WHERE item_id = $1', [f.prescriptionItem],
    )).rows[0];
    assert.equal(num(item.prescribed_quantity), 20, 'the prescribed quantity is what the doctor wrote');
    assert.equal(item.uom, 'TABLET');

    const queueForAdmin = await queue(admin(f.doctor));
    assert.equal(queueForAdmin.status, 200);
    const queued = (queueForAdmin.body.prescriptions as any[]).find((p) => p.prescription_id === f.prescription);
    assert.ok(queued, 'the prescription appears in the pharmacy queue');
    assert.equal(num(queued.items[0].prescribed_quantity), 20, 'with its quantity intact');
    assert.equal(queued.items[0].uom, 'TABLET');

    /* ---------------------------------------------------------- 2. dispensing */
    const beforeEarly = (await batchState(f.earlyBatch)).rows[0];
    const beforeLate = (await batchState(f.lateBatch)).rows[0];
    assert.equal(num(beforeEarly.quantity_reserved), 0);
    assert.equal(num(beforeLate.quantity_reserved), 0);

    // Exactly one dispense for this prescription.
    f = await runDispensing(f);

    const allocation = (await pool.query(
      `SELECT dib.dispensing_item_batch_id, dib.batch_id, dib.quantity, dib.unit_cost_snapshot
       FROM dispensing_item_batches dib
       JOIN dispensing_items di ON di.dispensing_item_id = dib.dispensing_item_id
       WHERE di.dispensing_id = $1`, [f.dispensing],
    )).rows;
    assert.equal(allocation.length, 1, 'one allocation line');
    assert.equal(num(allocation[0].batch_id), f.earlyBatch, 'FEFO chose the earlier-expiring batch');
    assert.equal(num(allocation[0].quantity), 20, 'the whole prescribed quantity fitted one batch');
    assert.equal(num(allocation[0].unit_cost_snapshot), 2.5, 'the historical cost is frozen on the allocation');

    const afterEarly = (await batchState(f.earlyBatch)).rows[0];
    const afterLate = (await batchState(f.lateBatch)).rows[0];
    assert.equal(num(afterEarly.quantity_on_hand), 10, '30 - 20 deducted exactly');
    assert.equal(num(afterLate.quantity_on_hand), 30, 'the later batch was never touched');
    assert.equal(num(afterEarly.quantity_reserved), 0, 'dispensing never touches the reserved quantity');
    assert.equal(num(afterLate.quantity_reserved), 0);

    const dispenseMovements = await movementsFor('DISPENSING', f.dispensing);
    assert.equal(dispenseMovements.rows.length, 1, 'exactly one DISPENSE movement');
    assert.equal(dispenseMovements.rows[0].movement_type, 'DISPENSE');
    assert.equal(num(dispenseMovements.rows[0].quantity), 20);
    assert.equal(num(dispenseMovements.rows[0].batch_id), f.earlyBatch,
      'the movement names the batch FEFO actually consumed');

    const dispenseAudit = await auditsFor('DISPENSING', f.dispensing);
    assert.ok(dispenseAudit.rows.some((a) => a.action === 'DISPENSED'), 'the dispensing is audited');

    const snapshotPrice = (await pool.query(
      'SELECT unit_price_snapshot FROM dispensing_items WHERE dispensing_item_id = $1', [f.dispensingItem],
    )).rows[0];
    assert.equal(num(snapshotPrice.unit_price_snapshot), 5, '10E.3 froze the selling price at dispensing time');

    // dispensing exists exactly once
    const dispRow = (await pool.query('SELECT status FROM dispensings WHERE dispensing_id = $1', [f.dispensing])).rows[0];
    assert.equal(dispRow.status, 'COMPLETED');

    /* ------------------------------------------------------------- 3. invoice */
    const charged = await charge(f.dispensing, admin(f.doctor));
    assert.equal(charged.status, 201, `charge failed: ${JSON.stringify(charged.body)}`);
    const invoiceId = num(charged.body.invoice_id);
    f.invoice = invoiceId;

    const invoice = (await pool.query(
      'SELECT total_amount, net_amount, paid_amount, discount_amount FROM invoices WHERE invoice_id = $1', [invoiceId],
    )).rows[0];
    const lines = (await pool.query(
      `SELECT item_id, clinic_id, service_id, dispensing_id, dispensing_item_id, medication_id,
              dispensed_quantity, unit_price_snapshot, line_total, price, quantity, medication_discount_value
       FROM invoice_items WHERE invoice_id = $1`, [invoiceId],
    )).rows;

    assert.equal(lines.length, 1, 'exactly one medication invoice line');
    assert.equal(num(lines[0].line_total), 100, '20 x 5.00');
    assert.equal(num(invoice.total_amount), num(lines[0].line_total), 'invoice total equals the line total');
    assert.equal(num(invoice.total_amount), 100);
    assert.equal(num(invoice.net_amount), 100, 'no clinic discount on a medication charge');
    assert.equal(num(invoice.discount_amount), 0);
    assert.equal(num(invoice.paid_amount), 0, 'issued unpaid — there is no settlement in this phase');
    assert.equal(num(lines[0].unit_price_snapshot), 5, 'the historical price snapshot');
    assert.equal(num(lines[0].medication_discount_value), 0, 'the historical discount snapshot');
    assert.equal(num(lines[0].price), 100, 'price carries the line total for the legacy aggregate');
    assert.equal(num(lines[0].quantity), 1);
    assert.equal(lines[0].service_id, null, 'a medication line is never a clinic service');
    assert.equal(num(lines[0].clinic_id), f.clinic);

    /* -------------------------------------------------------------- 4. return */
    // A controlled partial: 10 of the 20 dispensed.
    const returned = await returnMedication(
      {
        dispensing_id: f.dispensing,
        reason: 'E2E partial return',
        items: [{ dispensing_item_batch_id: f.allocation, quantity: 10, restock_decision: 'RESTOCK' }],
      },
      admin(f.doctor),
    );
    assert.equal(returned.status, 201, `return failed: ${JSON.stringify(returned.body)}`);
    const returnId = num(returned.body.return.return_id);

    const returnItem = (await pool.query(
      `SELECT dispensing_item_batch_id, batch_id, quantity, restock_decision, unit_cost_snapshot
       FROM medication_return_items WHERE dispensing_item_batch_id = $1`, [f.allocation],
    )).rows;
    assert.equal(returnItem.length, 1, 'the return references the exact dispensing allocation');
    assert.equal(num(returnItem[0].dispensing_item_batch_id), f.allocation);
    assert.equal(num(returnItem[0].batch_id), f.earlyBatch, 'and preserves the original batch');
    assert.equal(num(returnItem[0].quantity), 10);
    assert.equal(returnItem[0].restock_decision, 'RESTOCK');
    assert.equal(num(returnItem[0].unit_cost_snapshot), 2.5, 'the historical cost, not a re-read');

    const afterReturn = (await batchState(f.earlyBatch)).rows[0];
    assert.equal(num(afterReturn.quantity_on_hand), 20, '10 - 20 + 10 = 20 restored to the original batch');
    assert.equal(num(afterReturn.quantity_reserved), 0, 'a return never touches the reserved quantity');

    const returnMovements = await movementsFor('MEDICATION_RETURN', returnId);
    assert.equal(returnMovements.rows.length, 1, 'exactly one RETURN movement');
    assert.equal(returnMovements.rows[0].movement_type, 'RETURN');
    assert.equal(num(returnMovements.rows[0].quantity), 10);
    assert.equal(num(returnMovements.rows[0].batch_id), f.earlyBatch);

    const returnAudit = await auditsFor('MEDICATION_RETURN', returnId);
    assert.ok(returnAudit.rows.some((a) => a.action === 'MEDICATION_RETURNED'), 'the return is audited');

    /* ------------------------------------------------- 5. financial reversal */
    const reversal = (await pool.query(
      `SELECT returned_quantity, unit_cost_snapshot, cogs_reversal_amount, loss_amount
       FROM medication_return_reversals WHERE dispensing_item_batch_id = $1`, [f.allocation],
    )).rows[0];
    assert.equal(num(reversal.returned_quantity), 10);
    assert.equal(num(reversal.unit_cost_snapshot), 2.5, 'COGS uses the historical cost');
    assert.equal(num(reversal.cogs_reversal_amount), 25, '10 x 2.50 reversed out of cost');
    assert.equal(num(reversal.loss_amount), 0, 'a RESTOCK loses nothing');

    const credit = (await pool.query(
      `SELECT returned_quantity, unit_price_snapshot, medication_discount_value,
              gross_amount, net_amount, credit_amount, applied_to_outstanding, refund_due_amount,
              invoice_net_amount, invoice_paid_amount, currency_code
       FROM medication_return_credits WHERE dispensing_item_id = $1`, [f.dispensingItem],
    )).rows[0];
    assert.equal(num(credit.returned_quantity), 10);
    assert.equal(num(credit.unit_price_snapshot), 5, 'the credit price is the invoice line snapshot');
    assert.equal(num(credit.medication_discount_value), 0, 'the invoice line discount snapshot');
    assert.equal(num(credit.gross_amount), 50, '10 x 5.00');
    assert.equal(num(credit.net_amount), 50);
    assert.equal(num(credit.credit_amount), 50, 'the revenue credit');
    assert.equal(num(credit.invoice_net_amount), 100, 'the invoice net it snapshotted');
    assert.equal(num(credit.invoice_paid_amount), 0);
    assert.equal(num(credit.applied_to_outstanding), 50, 'the whole credit cancels the unpaid balance');
    assert.equal(num(credit.refund_due_amount), 0, 'nothing was paid, so nothing can be refunded');

    // The arithmetic the books care about:
    assert.equal(num(invoice.total_amount) - num(credit.credit_amount), 50,
      'original revenue 100 less the 50 credit leaves 50 of revenue still earned');
    const stillHeldStock = num(afterReturn.quantity_on_hand);
    assert.equal(stillHeldStock, 20, 'and the clinic still holds 20 units for the 10 the patient kept');
    assert.equal(num(reversal.cogs_reversal_amount) / num(credit.credit_amount), 0.5,
      'cost 25 against revenue 50 — the 25 margin is exactly what a return should release');

    /* ---------------------------------------------- 6. no unrelated writes */
    const during = await snapshot();
    for (const key of Object.keys(baseline)) {
      if (key === 'total_stock') continue;
      assert.ok(
        num(during[key]) >= num(baseline[key]),
        `${key} only ever grows during the flow (baseline ${baseline[key]}, now ${during[key]})`,
      );
    }
  } finally {
    await drop(f);
  }

  // After cleanup every count must be exactly what it was before the seed.
  const after = await snapshot();
  for (const key of Object.keys(baseline)) {
    assert.equal(
      num(after[key]),
      num(baseline[key]),
      `${key} returned to its baseline value (baseline ${JSON.stringify(baseline[key])}, after ${JSON.stringify(after[key])})`,
    );
  }
});

/* ==========================================================================
 * RESTOCK PATH VARIANTS
 * ======================================================================== */

test('E2E: WASTE restores no stock and books the full cost as a loss', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await runDispensing(await seed({ tag: 'WASTE', prescribed: 20, onHand: 20, unitCost: '2.50', unitPrice: '5.00' }));
    assert.equal(num((await batchState(f.earlyBatch)).rows[0].quantity_on_hand), 0);

    const returned = await returnMedication(
      {
        dispensing_id: f.dispensing,
        reason: 'E2E waste',
        items: [{ dispensing_item_batch_id: f.allocation, quantity: 20, restock_decision: 'WASTE' }],
      },
      admin(f.doctor),
    );
    assert.equal(returned.status, 201);

    const state = (await batchState(f.earlyBatch)).rows[0];
    assert.equal(num(state.quantity_on_hand), 0, 'WASTE returns nothing to inventory');
    assert.equal(num(state.quantity_reserved), 0);

    const returnId = num(returned.body.return.return_id);
    const movements = await movementsFor('MEDICATION_RETURN', returnId);
    assert.equal(movements.rows.length, 1);
    assert.equal(movements.rows[0].movement_type, 'WASTE', 'a WASTE movement, not a RETURN');

    const reversal = (await pool.query(
      'SELECT cogs_reversal_amount, loss_amount FROM medication_return_reversals WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    )).rows[0];
    assert.equal(num(reversal.cogs_reversal_amount), 50, '20 x 2.50');
    assert.equal(num(reversal.loss_amount), 50, 'the whole reversal is a loss when nothing goes back');
  } finally {
    await drop(f);
  }
});

test('E2E: QUARANTINE restores stock to the batch but isolates it', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await runDispensing(await seed({ tag: 'QUAR', prescribed: 10, onHand: 20, unitCost: '2.50', unitPrice: '5.00' }));
    assert.equal(num((await batchState(f.earlyBatch)).rows[0].quantity_on_hand), 10);

    const returned = await returnMedication(
      {
        dispensing_id: f.dispensing,
        reason: 'E2E quarantine',
        items: [{ dispensing_item_batch_id: f.allocation, quantity: 10, restock_decision: 'QUARANTINE' }],
      },
      admin(f.doctor),
    );
    assert.equal(returned.status, 201);

    const state = (await batchState(f.earlyBatch)).rows[0];
    assert.equal(num(state.quantity_on_hand), 20, 'the returned stock is back on the shelf');
    assert.equal(num(state.quantity_reserved), 0);

    const quarantines = (await pool.query(
      'SELECT batch_id FROM batch_quarantines WHERE batch_id = $1 AND released_at IS NULL', [f.earlyBatch],
    )).rows;
    assert.equal(quarantines.length, 1, 'exactly one active quarantine on that batch');

    const returnId = num(returned.body.return.return_id);
    const movements = await movementsFor('MEDICATION_RETURN', returnId);
    assert.equal(movements.rows[0].movement_type, 'RETURN');
    assert.equal(num(returnId) > 0, true);

    const reversal = (await pool.query(
      'SELECT cogs_reversal_amount, loss_amount FROM medication_return_reversals WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    )).rows[0];
    assert.equal(num(reversal.cogs_reversal_amount), 25, '10 x 2.50 reversed');
    assert.equal(num(reversal.loss_amount), 0, 'quarantined stock is not written off');
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * HISTORICAL SNAPSHOTS — the current price must not rewrite the past
 * ======================================================================== */

test('E2E: re-pricing the medication cannot alter the credit already earned', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await runDispensing(await seed({ tag: 'REPRICE', prescribed: 20, onHand: 20, unitCost: '2.50', unitPrice: '5.00' }));
    const charged = await charge(f.dispensing, admin(f.doctor));
    assert.equal(charged.status, 201);
    f.invoice = num(charged.body.invoice_id);

    // The clinic re-prices the drug and the invoice line is stamped with the
    // loyalty-era discount a future server-side rule would record.
    await pool.query(
      `UPDATE medication_prices SET is_active = FALSE, effective_to = NOW() WHERE inventory_id = $1`, [f.inventory],
    );
    await pool.query(
      `INSERT INTO medication_prices (clinic_id, inventory_id, unit_price, created_by_user_id)
       VALUES ($1, $2, 99.00, $3)`, [f.clinic, f.inventory, f.doctor],
    );
    await pool.query('UPDATE invoice_items SET medication_discount_value = 10 WHERE invoice_id = $1', [f.invoice]);

    const returned = await returnMedication(
      {
        dispensing_id: f.dispensing,
        reason: 'E2E reprice',
        items: [{ dispensing_item_batch_id: f.allocation, quantity: 10, restock_decision: 'RESTOCK' }],
      },
      admin(f.doctor),
    );
    assert.equal(returned.status, 201);

    const credit = (await pool.query(
      `SELECT unit_price_snapshot, medication_discount_value, gross_amount, net_amount, credit_amount
       FROM medication_return_credits WHERE dispensing_item_id = $1`, [f.dispensingItem],
    )).rows[0];
    assert.equal(num(credit.unit_price_snapshot), 5, '5.00 from the invoice line, never 99.00 from today');
    assert.equal(num(credit.medication_discount_value), 10, 'the snapshotted discount, taken once and rounded');
    assert.equal(num(credit.gross_amount), 50, '10 x 5.00');
    assert.equal(num(credit.net_amount), 45, '50 less 10% = 45.00');
    assert.equal(num(credit.credit_amount), 45, 'the credit follows the invoice, not the price list');

    const reversal = (await pool.query(
      'SELECT unit_cost_snapshot, cogs_reversal_amount FROM medication_return_reversals WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    )).rows[0];
    assert.equal(num(reversal.unit_cost_snapshot), 2.5, 'the re-price did not touch the historical cost either');
    assert.equal(num(reversal.cogs_reversal_amount), 25);
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * NEGATIVE CHECKS
 * ======================================================================== */

test('NEGATIVE: duplicate charge, over-return, cross-clinic and VOIDED are all rejected', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await runDispensing(await seed({ tag: 'NEG', prescribed: 20, onHand: 20, unitCost: '2.50', unitPrice: '5.00' }));

    // --- duplicate charge
    const first = await charge(f.dispensing, admin(f.doctor));
    assert.equal(first.status, 201);
    const second = await charge(f.dispensing, admin(f.doctor));
    assert.equal(second.status, 409, 'a dispensing may be charged exactly once');
    assert.equal(second.body.reason, 'ALREADY_INVOICED');
    const invoiceCount = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM invoice_items WHERE dispensing_id = $1', [f.dispensing],
    )).rows[0].n;
    assert.equal(invoiceCount, 1, 'and no second invoice line exists');

    // --- client-supplied financial values are refused outright
    const forged = await charge(f.dispensing, admin(f.doctor), {
      total_amount: 1, net_amount: 1, paid_amount: 999999, unit_price_snapshot: 0.01, line_total: 0.01, medication_discount_value: 100,
    });
    assert.equal(forged.status, 400, 'financial fields in the body are rejected before any database access');

    // --- over-return: 25 against an allocation of 20
    const tooMany = await returnMedication(
      {
        dispensing_id: f.dispensing,
        reason: 'E2E over-return',
        items: [{ dispensing_item_batch_id: f.allocation, quantity: 25, restock_decision: 'RESTOCK' }],
      },
      admin(f.doctor),
    );
    assert.equal(tooMany.status, 409, 'more than the allocation was dispensed');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM medication_return_items WHERE dispensing_item_batch_id = $1', [f.allocation])).rows[0].n, 0);

    // --- client-supplied money on a return cannot alter the credit
    const valid = await returnMedication(
      {
        dispensing_id: f.dispensing,
        reason: 'E2E valid partial',
        credit_amount: 999999,
        medication_discount_value: 100,
        items: [{
          dispensing_item_batch_id: f.allocation, quantity: 10, restock_decision: 'RESTOCK',
          unit_price_snapshot: 0.01, cogs_reversal_amount: 0.01,
        }],
      },
      admin(f.doctor),
    );
    assert.equal(valid.status, 201);
    const credit = (await pool.query(
      'SELECT credit_amount, unit_price_snapshot, medication_discount_value FROM medication_return_credits WHERE dispensing_item_id = $1',
      [f.dispensingItem],
    )).rows[0];
    assert.equal(num(credit.credit_amount), 50, 'the credit comes from the invoice, not from the request body');
    assert.equal(num(credit.unit_price_snapshot), 5);
    assert.equal(num(credit.medication_discount_value), 0);

    // --- cross-clinic: a session scoped to another clinic sees nothing
    const outsider = scoped(f.doctor, f.foreignClinic);
    const foreignCharge = await charge(f.dispensing, outsider);
    assert.equal(foreignCharge.status, 404, 'the dispensing does not exist in that scope');
    const foreignReturn = await returnMedication(
      { dispensing_id: f.dispensing, reason: 'E2E foreign', items: [{ dispensing_item_batch_id: f.allocation, quantity: 5, restock_decision: 'RESTOCK' }] },
      outsider,
    );
    assert.equal(foreignReturn.status, 404);
    const creditsAfter = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM medication_return_credits WHERE dispensing_item_id = $1', [f.dispensingItem],
    )).rows[0].n;
    assert.equal(creditsAfter, 1, 'the foreign attempt wrote no second credit');

    // --- VOIDED dispensing
    const voided = await voidDispense(f.dispensing, admin(f.doctor));
    assert.equal(voided.status, 200, 'the dispensing voids');
    const returnAfterVoid = await returnMedication(
      { dispensing_id: f.dispensing, reason: 'E2E voided', items: [{ dispensing_item_batch_id: f.allocation, quantity: 5, restock_decision: 'RESTOCK' }] },
      admin(f.doctor),
    );
    assert.equal(returnAfterVoid.status, 409, 'a voided dispensing cannot be returned against');
  } finally {
    await drop(f);
  }
});

/* ==========================================================================
 * KNOWN DEFERRED LIMITATION — recorded, not fixed
 * ======================================================================== */

test('DEFERRED: the reporting layer does not consume the return credit', { skip: !enabled, timeout: 60000 }, async () => {
  let f: Fixture = NOTHING;
  try {
    f = await runDispensing(await seed({ tag: 'DEFER', prescribed: 20, onHand: 20, unitCost: '2.50', unitPrice: '5.00' }));
    const charged = await charge(f.dispensing, admin(f.doctor));
    f.invoice = num(charged.body.invoice_id);
    const returned = await returnMedication(
      { dispensing_id: f.dispensing, reason: 'E2E deferred', items: [{ dispensing_item_batch_id: f.allocation, quantity: 10, restock_decision: 'RESTOCK' }] },
      admin(f.doctor),
    );
    assert.equal(returned.status, 201);

    // The credit exists...
    const credit = (await pool.query(
      'SELECT credit_amount FROM medication_return_credits WHERE dispensing_item_id = $1', [f.dispensingItem],
    )).rows[0];
    assert.equal(num(credit.credit_amount), 50);

    // ...and the invoice still shows the full 100 as revenue and outstanding,
    // because no report reads medication_return_credits and applied_to_outstanding
    // never touches settlement state. This is the documented Phase 10F deferral,
    // asserted here so it cannot drift silently.
    const invoice = (await pool.query(
      'SELECT total_amount, net_amount, paid_amount, net_amount - paid_amount AS outstanding FROM invoices WHERE invoice_id = $1',
      [f.invoice],
    )).rows[0];
    assert.equal(num(invoice.total_amount), 100, 'the invoice total is untouched by a return');
    assert.equal(num(invoice.outstanding), 100, 'outstanding still counts the returned medication');
  } finally {
    await drop(f);
  }
});