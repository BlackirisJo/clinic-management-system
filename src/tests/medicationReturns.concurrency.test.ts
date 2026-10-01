import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createMedicationReturn } from '../modules/inventory/medicationReturns.controller';

/* ==========================================================================
 * Phase 10D.5 — Concurrency: two real PostgreSQL clients returning the same allocation
 *
 * Proves the property the operation depends on: because the dispensing
 * allocations are locked with FOR UPDATE (never SKIP LOCKED), two concurrent
 * returns of the same allocation are serialised. The second one re-reads the
 * committed return history and is refused rather than double-restocking.
 *
 * Gated exactly like the project's other DB-backed concurrency tests so it never
 * runs against a developer's database implicitly. Enable with:
 *   STOCK_ADJUSTMENT_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.STOCK_ADJUSTMENT_CONCURRENCY_TEST === '1';

const qtyOf = (value: unknown): number => Number(value);

const adminReq = (body: Record<string, unknown>, userId: number): AuthenticatedRequest =>
  ({
    body, params: {}, query: {},
    user: { userId, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
  } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

/** Runs the real controller against the real pool, so two calls get two real clients. */
const returnMedication = async (body: Record<string, unknown>, userId: number) => {
  const { res, captured } = makeRes();
  await createMedicationReturn(adminReq(body, userId), res);
  return captured;
};

interface Fixture {
  clinic: number; user: number; patient: number; prescription: number; prescriptionItem: number;
  medication: number; inventory: number; batch: number; substitute: number;
  dispensing: number; dispensingItem: number; allocation: number;
}

const NOTHING_SEEDED: Fixture = {
  clinic: 0, user: 0, patient: 0, prescription: 0, prescriptionItem: 0, medication: 0,
  inventory: 0, batch: 0, substitute: 0, dispensing: 0, dispensingItem: 0, allocation: 0,
};

const seed = async (allocated: number, onHand: number, tag: string): Promise<Fixture> => {
  const stamp = `${tag}-${Date.now()}`;
  const clinic = await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
    [`RET-RACE-${stamp}`],
  );
  const user = await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Return Race', `ret-race-${stamp}`, 'x'],
  );
  const patient = await pool.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ($1, $2, 'MALE', '1990-01-01', $3) RETURNING patient_id`,
    ['Return Race Patient', `0500${String(Date.now()).slice(-6)}`, clinic.rows[0].clinic_id],
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
    [stamp, 'Return Race'],
  );
  const prescriptionItem = await pool.query(
    `INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration, prescribed_quantity, uom)
     VALUES ($1, $2, '1 x 3', 'TDS', '5 days', $3, 'TABLET') RETURNING item_id`,
    [prescription.rows[0].prescription_id, medication.rows[0].medication_id, allocated],
  );
  const inventory = await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
    [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
  );
  // الدفعة الأصلية نشطة، ودفعة بديلة لنفس الصنف معطّلة
  const batch = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, $3, 0, 2.5678) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp, onHand],
  );
  const substitute = await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, is_active)
     VALUES ($1, CONCAT('LOT-SUB-', $2::text), CURRENT_DATE + 60, 0, 0, 3.0000, FALSE) RETURNING batch_id`,
    [inventory.rows[0].inventory_id, stamp],
  );
  const dispensing = await pool.query(
    `INSERT INTO dispensings (prescription_id, visit_id, clinic_id, patient_id, dispensed_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED') RETURNING dispensing_id`,
    [prescription.rows[0].prescription_id, visit.rows[0].visit_id, clinic.rows[0].clinic_id, patient.rows[0].patient_id, user.rows[0].user_id],
  );
  const item = await pool.query(
    `INSERT INTO dispensing_items
       (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
        prescribed_quantity, dispensed_quantity, remaining_quantity, uom)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 'TABLET') RETURNING dispensing_item_id`,
    [dispensing.rows[0].dispensing_id, prescriptionItem.rows[0].item_id, medication.rows[0].medication_id, inventory.rows[0].inventory_id, allocated],
  );
  const allocation = await pool.query(
    `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity, unit_cost_snapshot, expiry_date_snapshot)
     VALUES ($1, $2, $3, 2.5678, CURRENT_DATE + 30) RETURNING dispensing_item_batch_id`,
    [item.rows[0].dispensing_item_id, batch.rows[0].batch_id, allocated],
  );

  return {
    clinic: qtyOf(clinic.rows[0].clinic_id), user: qtyOf(user.rows[0].user_id), patient: qtyOf(patient.rows[0].patient_id),
    prescription: qtyOf(prescription.rows[0].prescription_id), prescriptionItem: qtyOf(prescriptionItem.rows[0].item_id),
    medication: qtyOf(medication.rows[0].medication_id), inventory: qtyOf(inventory.rows[0].inventory_id),
    batch: qtyOf(batch.rows[0].batch_id), substitute: qtyOf(substitute.rows[0].batch_id),
    dispensing: qtyOf(dispensing.rows[0].dispensing_id), dispensingItem: qtyOf(item.rows[0].dispensing_item_id),
    allocation: qtyOf(allocation.rows[0].dispensing_item_batch_id),
  };
};

const drop = async (f: Fixture) => {
  // RESTRICT يتطلّب الترتيب: سجلات الإرجاع تشير إلى التخصيص، والتخصيص يشير إلى بند الصرف
  await pool.query('DELETE FROM medication_return_items WHERE dispensing_item_batch_id = $1', [f.allocation]);
  await pool.query(
    `DELETE FROM audit_logs WHERE resource_type = 'MEDICATION_RETURN'
       AND resource_id IN (SELECT return_id::text FROM medication_returns WHERE original_dispensing_id = $1)`,
    [f.dispensing],
  );
  await pool.query('DELETE FROM medication_returns WHERE original_dispensing_id = $1', [f.dispensing]);
  if (f.clinic) {
    await pool.query('DELETE FROM stock_movements WHERE batch_id IN (SELECT batch_id FROM inventory_batches WHERE inventory_id = $1)', [f.inventory]);
    await pool.query('DELETE FROM batch_quarantines WHERE batch_id IN (SELECT batch_id FROM inventory_batches WHERE inventory_id = $1)', [f.inventory]);
  }
  if (f.allocation) await pool.query('DELETE FROM dispensing_item_batches WHERE dispensing_item_batch_id = $1', [f.allocation]);
  if (f.dispensingItem) await pool.query('DELETE FROM dispensing_items WHERE dispensing_item_id = $1', [f.dispensingItem]);
  if (f.dispensing) await pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [f.dispensing]);
  if (f.batch) await pool.query('DELETE FROM inventory_batches WHERE batch_id IN (SELECT unnest(ARRAY[$1::int, $2::int]))', [f.batch, f.substitute]);
  if (f.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [f.inventory]);
  if (f.prescriptionItem) await pool.query('DELETE FROM prescription_items WHERE item_id = $1', [f.prescriptionItem]);
  if (f.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [f.medication]);
  if (f.prescription) await pool.query('DELETE FROM prescriptions WHERE prescription_id = $1', [f.prescription]);
  if (f.patient) {
    await pool.query('DELETE FROM visits WHERE patient_id = $1', [f.patient]);
    await pool.query('DELETE FROM patients WHERE patient_id = $1', [f.patient]);
  }
  if (f.user) await pool.query('DELETE FROM users WHERE user_id = $1', [f.user]);
  if (f.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [f.clinic]);
};

const onHand = async (batchId: number) =>
  qtyOf((await pool.query('SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1', [batchId])).rows[0].quantity_on_hand);

const returnRow = (f: Fixture) => pool.query(
  `SELECT return_id, status FROM medication_returns WHERE original_dispensing_id = $1 ORDER BY return_id`,
  [f.dispensing],
);

const baseBody = (f: Fixture, quantity: number, restock_decision = 'RESTOCK') => ({
  dispensing_id: f.dispensing,
  reason: 'CONCURRENCY-RACE',
  items: [{ dispensing_item_batch_id: f.allocation, quantity, restock_decision }],
});

test('CONCURRENCY: two concurrent returns of the same allocation cannot both restock it', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // تخصيص 20 مرّة واحدة لكل من العمليتين: واحدة فقط يمكن أن تنجح
    f = await seed(20, 50, 'RACE');

    const body = baseBody(f, 20);
    const [first, second] = await Promise.all([returnMedication(body, f.user), returnMedication(body, f.user)]);

    const succeeded = [first, second].filter((r) => r.status === 201);
    const failed = [first, second].filter((r) => r.status !== 201);
    assert.equal(succeeded.length, 1, 'the allocation may only be returned once');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.status, 409, 'the loser sees the committed return history');

    const headers = await returnRow(f);
    assert.equal(headers.rows.length, 1, 'exactly one return header survives');

    const items = await pool.query(
      'SELECT quantity, unit_cost_snapshot FROM medication_return_items WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    );
    assert.equal(items.rows.length, 1, 'the allocation is consumed exactly once');
    assert.equal(qtyOf(items.rows[0].quantity), 20);

    assert.equal(await onHand(f.batch), 70, '50 + 20 exactly once');
  } finally {
    await drop(f);
  }
});

test('CONCURRENCY: concurrent partial returns accumulate but never exceed the allocation', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    // تخصيص 20، وثلاثة طلبات 10: اثنان فقط يمكن أن ينجحا
    f = await seed(20, 0, 'PARTIAL');

    const body = baseBody(f, 10);
    const results = await Promise.all([
      returnMedication(body, f.user),
      returnMedication(body, f.user),
      returnMedication(body, f.user),
    ]);

    const succeeded = results.filter((r) => r.status === 201);
    assert.equal(succeeded.length, 2, '20 of 20 is exactly two returns of 10');
    assert.equal(results.filter((r) => r.status === 409).length, 1);

    const total = await pool.query(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM medication_return_items WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    );
    assert.equal(qtyOf(total.rows[0].total), 20, 'the cumulative return equals the allocation exactly');
    assert.ok(qtyOf(total.rows[0].total) <= 20, 'never more than the allocation');
    assert.equal(await onHand(f.batch), 20, 'stock returned exactly twice, never three times');
  } finally {
    await drop(f);
  }
});

test('CONCURRENCY: concurrent QUARANTINE returns create at most one active quarantine', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(20, 0, 'QUAR');

    const body = baseBody(f, 20, 'QUARANTINE');
    const [first, second] = await Promise.all([returnMedication(body, f.user), returnMedication(body, f.user)]);

    assert.equal([first, second].filter((r) => r.status === 201).length, 1);

    const quarantines = await pool.query(
      'SELECT COUNT(*)::int AS n FROM batch_quarantines WHERE batch_id = $1 AND released_at IS NULL',
      [f.batch],
    );
    assert.equal(quarantines.rows[0].n, 1, 'exactly one active quarantine, never two');
    assert.equal(await onHand(f.batch), 20, 'the stock was returned once');
  } finally {
    await drop(f);
  }
});

test('CONCURRENCY: the historical cost is copied from the allocation, never re-read', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(10, 0, 'COST');

    const result = await returnMedication(baseBody(f, 10), f.user);
    assert.equal(result.status, 201);

    // 2.5678 (NUMERIC 10,4) must land as 2.568 (NUMERIC 12,3) via ROUND(..., 3)
    const items = await pool.query(
      'SELECT unit_cost_snapshot FROM medication_return_items WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    );
    assert.equal(items.rows.length, 1);
    assert.equal(qtyOf(items.rows[0].unit_cost_snapshot), 2.568, 'the 4th decimal is rounded, not truncated');

    // and the allocation itself is unchanged
    const allocation = await pool.query(
      'SELECT unit_cost_snapshot FROM dispensing_item_batches WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    );
    assert.equal(qtyOf(allocation.rows[0].unit_cost_snapshot), 2.5678, 'the source snapshot is never rewritten');
  } finally {
    await drop(f);
  }
});

test('CONCURRENCY: a substitute batch requires a deactivated original under real rows', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(10, 0, 'SUB');

    // الدفعة الأصلية نشطة هنا — البديلة مرفوضة
    const refused = await returnMedication(
      { ...baseBody(f, 10), substitution_reason: 'محاولة', items: [{ ...baseBody(f, 10).items[0]!, batch_id: f.substitute }] },
      f.user,
    );
    assert.equal(refused.status, 409, 'an active original batch blocks a substitute');
    assert.equal(await onHand(f.substitute), 0);

    // نعطّل الأصل — الآن تُقبل البديلة مع سبب
    await pool.query('UPDATE inventory_batches SET is_active = FALSE WHERE batch_id = $1', [f.batch]);
    const accepted = await returnMedication(
      { ...baseBody(f, 10), substitution_reason: 'الدفعة الأصلية معطّلة', items: [{ ...baseBody(f, 10).items[0]!, batch_id: f.substitute }] },
      f.user,
    );
    assert.equal(accepted.status, 201);
    assert.equal(await onHand(f.substitute), 10, 'stock lands in the substitute');
    assert.equal(await onHand(f.batch), 0, 'the deactivated original is untouched');

    const items = await pool.query(
      'SELECT batch_id FROM medication_return_items WHERE dispensing_item_batch_id = $1',
      [f.allocation],
    );
    assert.equal(qtyOf(items.rows[0].batch_id), f.batch, 'the return item still preserves the original batch');
  } finally {
    await drop(f);
  }
});

test('CONCURRENCY: a VOIDED dispensing is refused against real rows', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(10, 0, 'VOID');
    // chk_dispensing_void_consistent يتطلب طابع الإلغاء ومَن ألغى ولماذا
    await pool.query(
      `UPDATE dispensings
       SET status = 'VOIDED', voided_at = NOW(), voided_by_user_id = $2, void_reason = 'test'
       WHERE dispensing_id = $1`,
      [f.dispensing, f.user],
    );

    const result = await returnMedication(baseBody(f, 10), f.user);
    assert.equal(result.status, 409);
    assert.equal(await onHand(f.batch), 0, 'nothing was restocked');

    const headers = await returnRow(f);
    assert.equal(headers.rows.length, 0, 'no return header for a voided dispensing');
  } finally {
    await drop(f);
  }
});

test('CONCURRENCY: dispensing quantities are never rewritten by a return', { skip: !enabled, timeout: 30000 }, async () => {
  let f: Fixture = NOTHING_SEEDED;
  try {
    f = await seed(30, 0, 'IMMUT');
    const before = await pool.query(
      `SELECT dispensed_quantity, remaining_quantity FROM dispensing_items WHERE dispensing_item_id = $1`,
      [f.dispensingItem],
    );

    const result = await returnMedication(baseBody(f, 30), f.user);
    assert.equal(result.status, 201);

    const after = await pool.query(
      `SELECT dispensed_quantity, remaining_quantity FROM dispensing_items WHERE dispensing_item_id = $1`,
      [f.dispensingItem],
    );
    assert.equal(qtyOf(after.rows[0].dispensed_quantity), qtyOf(before.rows[0].dispensed_quantity));
    assert.equal(qtyOf(after.rows[0].remaining_quantity), qtyOf(before.rows[0].remaining_quantity));
  } finally {
    await drop(f);
  }
});
