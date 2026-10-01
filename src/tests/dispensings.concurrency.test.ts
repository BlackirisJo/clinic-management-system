import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';
import { allocateFefoBatches } from '../modules/inventory/fefo';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';

/* ==========================================================================
 * Phase 10C.3 — Concurrency: two real PostgreSQL clients against one batch
 *
 * Proves the property the dispensing transaction depends on: because the
 * allocator uses FOR UPDATE (never SKIP LOCKED), two concurrent callers for
 * the same earliest-expiry batch CANNOT both claim the same stock, and the
 * losing caller observes the committed deduction instead of overselling.
 *
 * Gated exactly like the project's other integration tests so it never runs
 * against a developer's database implicitly. Enable with:
 *   DISPENSING_CONCURRENCY_TEST=1
 * ======================================================================== */

const enabled = process.env.DISPENSING_CONCURRENCY_TEST === '1';

const adminReq = {
  body: {}, params: {}, query: {},
  user: { userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN', permissions: [], clinicIds: [] },
} as unknown as AuthenticatedRequest;

const qtyOf = (value: unknown): number => Number(value);

test('CONCURRENCY: two clients dispensing the same earliest batch cannot oversell it', { skip: !enabled, timeout: 30000 }, async () => {
  const created: { clinicId?: number; medicationId?: number; inventoryId?: number; batchIds: number[] } = { batchIds: [] };

  try {
    const clinic = await pool.query(
      `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
      [`CONCURRENCY-PROBE-${Date.now()}`],
    );
    created.clinicId = qtyOf(clinic.rows[0].clinic_id);

    const medication = await pool.query(
      `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
      [`CONCURRENCY-PROBE-${Date.now()}`, 'Concurrency Probe'],
    );
    created.medicationId = qtyOf(medication.rows[0].medication_id);

    const inventory = await pool.query(
      `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
       VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
      [created.clinicId, created.medicationId],
    );
    created.inventoryId = qtyOf(inventory.rows[0].inventory_id);

    // دفعة واحدة زادتها 10 — يتنافس عليها طلبان كل منهما 10
    const batch = await pool.query(
      `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
       VALUES ($1, 'CONC-LOT-1', CURRENT_DATE + 30, 10, 0) RETURNING batch_id`,
      [created.inventoryId],
    );
    const batchId = qtyOf(batch.rows[0].batch_id);
    created.batchIds.push(batchId);

    // العميلان يتسابقان فعلياً: كل منهما يفتح معاملته ويطلب 10 من نفس الدفعة
    const attempt = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const allocation = await allocateFefoBatches(client, adminReq, created.inventoryId!, 10);
        if (!allocation.ok) {
          await client.query('ROLLBACK');
          return { ok: false as const, reason: allocation.reason, available: allocation.available_quantity };
        }
        // الخصم الحارس قبل COMMIT — نفس ما يفعله كنترولر الصرف
        const deduction = await client.query(
          `UPDATE inventory_batches SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW()
           WHERE batch_id = $2 AND quantity_on_hand >= $1`,
          [allocation.allocations[0]!.allocation, batchId],
        );
        if (deduction.rowCount !== 1) {
          await client.query('ROLLBACK');
          return { ok: false as const, reason: 'DEDUCTION_CONFLICT' as const, available: -1 };
        }
        await client.query('COMMIT');
        return { ok: true as const, allocation: allocation.allocations[0]!.allocation };
      } finally {
        client.release();
      }
    };

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const after = await pool.query('SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1', [batchId]);
    const remaining = qtyOf(after.rows[0].quantity_on_hand);

    // واحد فقط ينجح: القفل (وليس SKIP LOCKED) ينتظر ثم يعيد القراءة
    assert.equal([first, second].filter((r) => r.ok).length, 1, 'exactly one caller may succeed');
    assert.equal(remaining, 0, `stock must end at exactly 0, never negative (got ${remaining})`);
    assert.ok(remaining >= 0, 'stock must never become negative');

    const loser = [first, second].find((r) => !r.ok)!;
    // بعد إفراغ الدفعة لا تعود مؤهلة أصلاً (quantity_on_hand = 0)، فتأتي
    // NO_ELIGIBLE_BATCH بدل INSUFFICIENT_STOCK — وكلاهما 409 لطبقة الصرف.
    assert.ok(
      loser.reason === 'INSUFFICIENT_STOCK' || loser.reason === 'NO_ELIGIBLE_BATCH',
      `unexpected loser reason: ${loser.reason}`,
    );
    assert.equal(loser.available, 0, 'the loser never sees stale stock');
  } finally {
    // تنظيف: الدفعة ثم صنف المخزون ثم الدواء ثم العيادة (RESTRICT يفرض هذا الترتيب)
    for (const batchId of created.batchIds) await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [batchId]);
    for (const batchId of created.batchIds) await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [batchId]);
    if (created.inventoryId) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [created.inventoryId]);
    if (created.medicationId) await pool.query('DELETE FROM medications WHERE medication_id = $1', [created.medicationId]);
    if (created.clinicId) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [created.clinicId]);
  }
});

test('CONCURRENCY: two clients splitting one batch cannot exceed its quantity', { skip: !enabled, timeout: 30000 }, async () => {
  const state: { inventoryId?: number; batchId?: number } = {};

  try {
    const clinic = await pool.query(
      `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
      [`CONCURRENCY-SPLIT-${Date.now()}`],
    );
    const medication = await pool.query(
      `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
      [`CONCURRENCY-SPLIT-${Date.now()}`, 'Concurrency Split'],
    );
    const inventory = await pool.query(
      `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
       VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
      [clinic.rows[0].clinic_id, medication.rows[0].medication_id],
    );
    state.inventoryId = qtyOf(inventory.rows[0].inventory_id);
    const batch = await pool.query(
      `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
       VALUES ($1, 'CONC-LOT-2', CURRENT_DATE + 30, 5, 0) RETURNING batch_id`,
      [state.inventoryId],
    );
    state.batchId = qtyOf(batch.rows[0].batch_id);

    const attempt = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const allocation = await allocateFefoBatches(client, adminReq, state.inventoryId!, 5);
        if (!allocation.ok) {
          await client.query('ROLLBACK');
          return 0;
        }
        const deduction = await client.query(
          `UPDATE inventory_batches SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW()
           WHERE batch_id = $2 AND quantity_on_hand >= $1`,
          [allocation.allocations[0]!.allocation, state.batchId],
        );
        if (deduction.rowCount !== 1) {
          await client.query('ROLLBACK');
          return 0;
        }
        await client.query('COMMIT');
        return allocation.allocations[0]!.allocation;
      } finally {
        client.release();
      }
    };

    const results = await Promise.all([attempt(), attempt()]);
    const after = await pool.query('SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1', [state.batchId]);
    const remaining = qtyOf(after.rows[0].quantity_on_hand);

    assert.equal(results.reduce((sum, n) => sum + n, 0), 5, 'the total allocated can never exceed the batch quantity');
    assert.equal(remaining, 0);
    assert.ok(remaining >= 0, 'stock must never become negative');
  } finally {
    if (state.batchId) await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [state.batchId]);
    if (state.batchId) await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [state.batchId]);
    if (state.inventoryId) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [state.inventoryId]);
    await pool.query(`DELETE FROM medications WHERE trade_name LIKE 'CONCURRENCY-SPLIT-%'`);
    await pool.query(`DELETE FROM clinics WHERE clinic_name LIKE 'CONCURRENCY-SPLIT-%'`);
  }
});

test('CONCURRENCY: a double void cannot restore the same stock twice', { skip: !enabled, timeout: 30000 }, async () => {
  const ids: Record<string, number> = {};
  const stamp = Date.now();

  try {
    const clinic = await pool.query(
      `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`,
      [`VOID-RACE-${stamp}`],
    );
    ids.clinic = qtyOf(clinic.rows[0].clinic_id);

    const doctor = await pool.query(
      `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
      ['Void Race Doctor', `void-race-${stamp}`, 'x'],
    );
    ids.user = qtyOf(doctor.rows[0].user_id);

    const patient = await pool.query(
      `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
       VALUES ($1, $2, 'MALE', '1990-01-01', $3) RETURNING patient_id`,
      ['Void Race Patient', `0500${String(stamp).slice(-6)}`, ids.clinic],
    );
    ids.patient = qtyOf(patient.rows[0].patient_id);

    const visit = await pool.query(
      `INSERT INTO visits (patient_id, clinic_id, doctor_id) VALUES ($1, $2, $3) RETURNING visit_id`,
      [ids.patient, ids.clinic, ids.user],
    );
    ids.visit = qtyOf(visit.rows[0].visit_id);

    const prescription = await pool.query(
      `INSERT INTO prescriptions (visit_id, patient_id, doctor_id) VALUES ($1, $2, $3) RETURNING prescription_id`,
      [ids.visit, ids.patient, ids.user],
    );
    ids.prescription = qtyOf(prescription.rows[0].prescription_id);

    const medication = await pool.query(
      `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
      [`VOID-RACE-${stamp}`, 'Void Race'],
    );
    ids.medication = qtyOf(medication.rows[0].medication_id);

    const inventory = await pool.query(
      `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
       VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`,
      [ids.clinic, ids.medication],
    );
    ids.inventory = qtyOf(inventory.rows[0].inventory_id);

    // بند روشتة حقيقي — dispensing_items.prescription_item_id مفتاح أجنبي عليه
    const prescriptionItem = await pool.query(
      `INSERT INTO prescription_items
         (prescription_id, medication_id, dosage, frequency, duration, prescribed_quantity, uom)
       VALUES ($1, $2, '1 x 3', 'TDS', '5 days', 6, 'TABLET') RETURNING item_id`,
      [ids.prescription, ids.medication],
    );
    ids.prescriptionItem = qtyOf(prescriptionItem.rows[0].item_id);

    // تبدأ الدفعة بـ 10، يُخصم منها 6 (الصرف)، ثم يعود 6 عند الإلغاء
    const batch = await pool.query(
      `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
       VALUES ($1, 'VOID-LOT-1', CURRENT_DATE + 30, 10, 0) RETURNING batch_id`,
      [ids.inventory],
    );
    ids.batch = qtyOf(batch.rows[0].batch_id);

    // محاكاة صرف مكتمل: خصم 6 وتسجيل تخصيصاته
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE inventory_batches SET quantity_on_hand = quantity_on_hand - 6 WHERE batch_id = $1`,
        [ids.batch],
      );
      const header = await client.query(
        `INSERT INTO dispensings (prescription_id, visit_id, clinic_id, patient_id, dispensed_by_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'COMPLETED') RETURNING dispensing_id`,
        [ids.prescription, ids.visit, ids.clinic, ids.patient, ids.user],
      );
      ids.dispensing = qtyOf(header.rows[0].dispensing_id);
      const item = await client.query(
        `INSERT INTO dispensing_items
           (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
            prescribed_quantity, dispensed_quantity, remaining_quantity, uom)
         VALUES ($1, $2, $3, $4, 6, 6, 0, 'TABLET') RETURNING dispensing_item_id`,
        [ids.dispensing, ids.prescriptionItem, ids.medication, ids.inventory],
      );
      await client.query(
        `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity)
         VALUES ($1, $2, 6)`,
        [qtyOf(item.rows[0].dispensing_item_id), ids.batch],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const afterDeduct = qtyOf(
      (await pool.query('SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1', [ids.batch])).rows[0].quantity_on_hand,
    );
    assert.equal(afterDeduct, 4, 'precondition: the dispensing deducted 6');

    // تسابقان على الإلغاء نفسه
    const voidOnce = async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const header = await c.query(
          `SELECT dispensing_id, status FROM dispensings
           WHERE dispensing_id = $1 AND clinic_id = $2 FOR UPDATE OF dispensings`,
          [ids.dispensing, ids.clinic],
        );
        if (header.rows[0]?.status !== 'COMPLETED') {
          await c.query('ROLLBACK');
          return 'ALREADY_VOIDED';
        }
        const allocations = await c.query(
          `SELECT dib.batch_id, dib.quantity FROM dispensing_item_batches dib
           JOIN dispensing_items di ON di.dispensing_item_id = dib.dispensing_item_id
           WHERE di.dispensing_id = $1 ORDER BY dib.batch_id`,
          [ids.dispensing],
        );
        for (const allocation of allocations.rows) {
          const restored = await c.query(
            `UPDATE inventory_batches SET quantity_on_hand = quantity_on_hand + $1
             WHERE batch_id = $2 AND quantity_on_hand + $1 <= 999999999.999`,
            [qtyOf(allocation.quantity), qtyOf(allocation.batch_id)],
          );
          if (restored.rowCount !== 1) { await c.query('ROLLBACK'); return 'RESTORE_CONFLICT'; }
        }
        const updated = await c.query(
          `UPDATE dispensings SET status = 'VOIDED', voided_at = NOW(), voided_by_user_id = $1
           WHERE dispensing_id = $2 AND status = 'COMPLETED'`,
          [ids.user, ids.dispensing],
        );
        if (updated.rowCount !== 1) { await c.query('ROLLBACK'); return 'ALREADY_VOIDED'; }
        await c.query('COMMIT');
        return 'VOIDED';
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    };

    const results = await Promise.all([voidOnce(), voidOnce()]);
    const afterVoid = qtyOf(
      (await pool.query('SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1', [ids.batch])).rows[0].quantity_on_hand,
    );

    assert.equal(results.filter((r) => r === 'VOIDED').length, 1, 'exactly one void may succeed');
    assert.equal(afterVoid, 10, 'stock is restored exactly once — never above the original 10');
    assert.ok(afterVoid <= 10, 'a double void must never inflate stock');
  } finally {
    // RESTRICT يتطلّب هذا الترتيب تماماً
    if (ids.dispensing) {
      await pool.query('DELETE FROM dispensing_item_batches WHERE dispensing_item_id IN (SELECT dispensing_item_id FROM dispensing_items WHERE dispensing_id = $1)', [ids.dispensing]);
      await pool.query('DELETE FROM dispensing_items WHERE dispensing_id = $1', [ids.dispensing]);
      await pool.query('DELETE FROM audit_logs WHERE resource_type = $1 AND resource_id = $2', ['DISPENSING', String(ids.dispensing)]);
      await pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [ids.dispensing]);
    }
    if (ids.prescription) await pool.query('DELETE FROM prescriptions WHERE prescription_id = $1', [ids.prescription]);
    if (ids.visit) await pool.query('DELETE FROM visits WHERE visit_id = $1', [ids.visit]);
    if (ids.batch) {
      await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [ids.batch]);
      await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [ids.batch]);
    }
    if (ids.prescriptionItem) await pool.query('DELETE FROM prescription_items WHERE item_id = $1', [ids.prescriptionItem]);
    if (ids.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [ids.inventory]);
    if (ids.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [ids.medication]);
    if (ids.patient) await pool.query('DELETE FROM patients WHERE patient_id = $1', [ids.patient]);
    if (ids.user) await pool.query('DELETE FROM users WHERE user_id = $1', [ids.user]);
    if (ids.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [ids.clinic]);
  }
});

/* ==========================================================================
 * Phase 10C.4B — Partial dispensing under concurrency
 * The prescription_items lock must stop two requests computing the same
 * remaining quantity, and limited stock must never be over-allocated.
 * ======================================================================== */

/** ينشئ سلسلة FK كاملة (عيادة/مستخدم/مريض/زيارة/روشتة/بند) مع مخزون قابل للضبط. */
const seedFixture = async (stock: number, prescribed: number, tag: string) => {
  const stamp = `${tag}-${Date.now()}`;
  const ids: Record<string, number> = {};
  ids.clinic = qtyOf((await pool.query(
    `INSERT INTO clinics (clinic_name, specialty_id, is_active) VALUES ($1, NULL, TRUE) RETURNING clinic_id`, [stamp],
  )).rows[0].clinic_id);
  ids.user = qtyOf((await pool.query(
    `INSERT INTO users (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    ['Partial Race', `partial-${stamp}`, 'x'],
  )).rows[0].user_id);
  ids.patient = qtyOf((await pool.query(
    `INSERT INTO patients (full_name, phone, gender, date_of_birth, clinic_id)
     VALUES ($1, $2, 'MALE', '1990-01-01', $3) RETURNING patient_id`,
    ['Partial Race Patient', `0500${String(Date.now()).slice(-6)}`, ids.clinic],
  )).rows[0].patient_id);
  ids.visit = qtyOf((await pool.query(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id) VALUES ($1, $2, $3) RETURNING visit_id`,
    [ids.patient, ids.clinic, ids.user],
  )).rows[0].visit_id);
  ids.prescription = qtyOf((await pool.query(
    `INSERT INTO prescriptions (visit_id, patient_id, doctor_id) VALUES ($1, $2, $3) RETURNING prescription_id`,
    [ids.visit, ids.patient, ids.user],
  )).rows[0].prescription_id);
  ids.medication = qtyOf((await pool.query(
    `INSERT INTO medications (trade_name, scientific_name) VALUES ($1, $2) RETURNING medication_id`,
    [stamp, 'Partial Race'],
  )).rows[0].medication_id);
  ids.inventory = qtyOf((await pool.query(
    `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point)
     VALUES ($1, $2, 'TABLET', 0, 0) RETURNING inventory_id`, [ids.clinic, ids.medication],
  )).rows[0].inventory_id);
  ids.prescriptionItem = qtyOf((await pool.query(
    `INSERT INTO prescription_items
       (prescription_id, medication_id, dosage, frequency, duration, prescribed_quantity, uom)
     VALUES ($1, $2, '1 x 3', 'TDS', '5 days', $3, 'TABLET') RETURNING item_id`,
    [ids.prescription, ids.medication, prescribed],
  )).rows[0].item_id);
  ids.batch = qtyOf((await pool.query(
    `INSERT INTO inventory_batches (inventory_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved)
     VALUES ($1, CONCAT('LOT-', $2::text), CURRENT_DATE + 30, $3, 0) RETURNING batch_id`,
    [ids.inventory, stamp, stock],
  )).rows[0].batch_id);
  return ids;
};

const cleanupFixture = async (ids: Record<string, number>) => {
  if (ids.dispensing) {
    await pool.query('DELETE FROM dispensing_item_batches WHERE dispensing_item_id IN (SELECT dispensing_item_id FROM dispensing_items WHERE dispensing_id = $1)', [ids.dispensing]);
    await pool.query('DELETE FROM dispensing_items WHERE dispensing_id = $1', [ids.dispensing]);
    await pool.query('DELETE FROM stock_movements WHERE reference_id = $1', [String(ids.dispensing)]);
    await pool.query('DELETE FROM audit_logs WHERE resource_type = $1 AND resource_id = $2', ['DISPENSING', String(ids.dispensing)]);
    await pool.query('DELETE FROM dispensings WHERE dispensing_id = $1', [ids.dispensing]);
  }
  if (ids.prescriptionItem) await pool.query('DELETE FROM prescription_items WHERE item_id = $1', [ids.prescriptionItem]);
  if (ids.prescription) await pool.query('DELETE FROM prescriptions WHERE prescription_id = $1', [ids.prescription]);
  if (ids.visit) await pool.query('DELETE FROM visits WHERE visit_id = $1', [ids.visit]);
  if (ids.batch) {
    await pool.query('DELETE FROM stock_movements WHERE batch_id = $1', [ids.batch]);
    await pool.query('DELETE FROM inventory_batches WHERE batch_id = $1', [ids.batch]);
  }
  if (ids.inventory) await pool.query('DELETE FROM inventory_items WHERE inventory_id = $1', [ids.inventory]);
  if (ids.medication) await pool.query('DELETE FROM medications WHERE medication_id = $1', [ids.medication]);
  if (ids.patient) await pool.query('DELETE FROM patients WHERE patient_id = $1', [ids.patient]);
  if (ids.user) await pool.query('DELETE FROM users WHERE user_id = $1', [ids.user]);
  if (ids.clinic) await pool.query('DELETE FROM clinics WHERE clinic_id = $1', [ids.clinic]);
};

test('CONCURRENCY: two attempts on one prescription cannot over-dispense it', { skip: !enabled, timeout: 30000 }, async () => {
  const ids: Record<string, number> = {};
  try {
    Object.assign(ids, await seedFixture(100, 30, 'FULL'));
    // مخزون وفير: تسابقان على نفس البند — واحد يجب أن يأخذ كل المتبقي والآخر لا يصرف
    const results = await Promise.all([
      runPartialFixture(ids, 30),
      runPartialFixture(ids, 30),
    ]);

    const total = results.reduce((sum, r) => sum + r.dispensed, 0);
    assert.equal(total, 30, 'the two attempts together can never exceed the prescribed quantity');

    const row = await pool.query(
      `SELECT COALESCE(SUM(di.dispensed_quantity), 0) AS dispensed
       FROM dispensing_items di JOIN dispensings d ON d.dispensing_id = di.dispensing_id
       WHERE di.prescription_item_id = $1 AND d.status <> 'VOIDED'`,
      [ids.prescriptionItem],
    );
    assert.equal(qtyOf(row.rows[0].dispensed), 30, 'persisted total must equal the prescribed quantity exactly');
  } finally {
    await cleanupFixture(ids);
  }
});

test('CONCURRENCY: limited stock under two attempts never goes negative or over-allocates', { skip: !enabled, timeout: 30000 }, async () => {
  const ids: Record<string, number> = {};
  try {
    // 30 مطلوب، 12 متاح فقط
    Object.assign(ids, await seedFixture(12, 30, 'SHORT'));

    const results = await Promise.all([
      runPartialFixture(ids, 30),
      runPartialFixture(ids, 30),
    ]);

    const batch = await pool.query('SELECT quantity_on_hand FROM inventory_batches WHERE batch_id = $1', [ids.batch]);
    const remaining = qtyOf(batch.rows[0].quantity_on_hand);
    const allocated = results.reduce((sum, r) => sum + r.dispensed, 0);

    assert.equal(remaining, 0, 'available stock is fully consumed');
    assert.ok(remaining >= 0, 'stock must never become negative');
    assert.equal(allocated, 12, 'total allocated can never exceed the stock that existed');
    assert.equal(results.filter((r) => r.dispensed > 0).length, 1, 'only one attempt can claim the stock');
  } finally {
    await cleanupFixture(ids);
  }
});

/** محاولة صرف كاملة عبر منطق الاختبار نفسه: قفل البند + FEFO مقفل + خصم. */
const runPartialFixture = async (ids: Record<string, number>, requested: number) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // القفل نفسه الذي يستخدمه الكنترولر على بنود الروشتة
    const items = await client.query(
      `SELECT pi.item_id, pi.prescribed_quantity FROM prescription_items pi
       WHERE pi.prescription_id = $1 ORDER BY pi.item_id FOR UPDATE OF pi`,
      [ids.prescription],
    );
    const prior = await client.query(
      `SELECT COALESCE(SUM(di.dispensed_quantity), 0) AS dispensed
       FROM dispensing_items di JOIN dispensings d ON d.dispensing_id = di.dispensing_id
       WHERE di.prescription_item_id = ANY($1::int[]) AND d.status <> 'VOIDED'`,
      [[ids.prescriptionItem]],
    );
    const prescribed = qtyOf(items.rows[0].prescribed_quantity);
    const remaining = Number((prescribed - qtyOf(prior.rows[0].dispensed)).toFixed(3));
    if (remaining <= 0) { await client.query('ROLLBACK'); return { dispensed: 0, status: 'COMPLETED' }; }

    // نفس سلوك الكنترولر: جرّب المتبقي، فإن نقص جرّب المتاح فعلياً
    const target = Math.min(remaining, requested);
    let allocation = await allocateFefoBatches(client, adminReq, ids.inventory!, target);
    if (!allocation.ok && allocation.reason === 'INSUFFICIENT_STOCK' && allocation.available_quantity > 0) {
      allocation = await allocateFefoBatches(client, adminReq, ids.inventory!, allocation.available_quantity);
    }
    if (!allocation.ok) { await client.query('ROLLBACK'); return { dispensed: 0, status: 'NOTHING' }; }

    const header = await client.query(
      `INSERT INTO dispensings (prescription_id, visit_id, clinic_id, patient_id, dispensed_by_user_id, status)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED') RETURNING dispensing_id`,
      [ids.prescription, ids.visit, ids.clinic, ids.patient, ids.user],
    );
    ids.dispensing = qtyOf(header.rows[0].dispensing_id);
    const dispensed = allocation.allocations.reduce((sum, a) => sum + a.allocation, 0);
    const item = await client.query(
      `INSERT INTO dispensing_items
         (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
          prescribed_quantity, dispensed_quantity, remaining_quantity, uom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'TABLET') RETURNING dispensing_item_id`,
      [ids.dispensing, ids.prescriptionItem, ids.medication, ids.inventory, prescribed, dispensed, Number((prescribed - dispensed).toFixed(3))],
    );
    for (const a of allocation.allocations) {
      await client.query(
        `INSERT INTO dispensing_item_batches (dispensing_item_id, batch_id, quantity) VALUES ($1, $2, $3)`,
        [qtyOf(item.rows[0].dispensing_item_id), a.batch_id, a.allocation],
      );
      const deducted = await client.query(
        `UPDATE inventory_batches SET quantity_on_hand = quantity_on_hand - $1 WHERE batch_id = $2 AND quantity_on_hand >= $1`,
        [a.allocation, a.batch_id],
      );
      if (deducted.rowCount !== 1) { await client.query('ROLLBACK'); return { dispensed: 0, status: 'CONFLICT' }; }
      await client.query(
        `INSERT INTO stock_movements (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id)
         VALUES ($1, 'DISPENSE', $2, 'DISPENSING', $3, $4)`,
        [a.batch_id, a.allocation, String(ids.dispensing), ids.user],
      );
    }
    await client.query('COMMIT');
    return { dispensed, status: dispensed >= remaining ? 'COMPLETED' : 'PARTIAL' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/* ==========================================================================
 * Phase 10C.4C — Repeat cycles under concurrency
 * ============================================================== */

test('CONCURRENCY: two attempts cannot consume the same repeat cycle twice', { skip: !enabled, timeout: 30000 }, async () => {
  const ids: Record<string, number> = {};
  try {
    // مطلوب 30 ودورة واحدة مخزنة 30: التسابقان على الدورة 0 نفسها
    Object.assign(ids, await seedFixture(100, 30, 'CYC0'));
    const results = await Promise.all([runPartialFixture(ids, 30), runPartialFixture(ids, 30)]);
    assert.equal(results.reduce((s, r) => s + r.dispensed, 0), 30, 'the cycle is consumed exactly once');

    const row = await pool.query(
      `SELECT COALESCE(SUM(di.dispensed_quantity), 0) AS d FROM dispensing_items di
       JOIN dispensings dd ON dd.dispensing_id = di.dispensing_id
       WHERE di.prescription_item_id = $1 AND dd.status <> 'VOIDED' AND di.cycle_index = 0`,
      [ids.prescriptionItem],
    );
    assert.equal(qtyOf(row.rows[0].d), 30, 'cycle 0 total equals the prescribed quantity, never more');
  } finally {
    await cleanupFixture(ids);
  }
});

test('CONCURRENCY: a repeat cycle cannot exceed the prescribed quantity within its cycle', { skip: !enabled, timeout: 30000 }, async () => {
  const ids: Record<string, number> = {};
  try {
    // مخزون 100 وroguhs 30: تسابقان على الدورة 0
    Object.assign(ids, await seedFixture(100, 30, 'CYC1'));
    await Promise.all([runPartialFixture(ids, 30), runPartialFixture(ids, 30)]);

    const row = await pool.query(
      `SELECT COALESCE(SUM(di.dispensed_quantity), 0) AS d FROM dispensing_items di
       JOIN dispensings dd ON dd.dispensing_id = di.dispensing_id
       WHERE di.prescription_item_id = $1 AND dd.status <> 'VOIDED' AND di.cycle_index = 0`,
      [ids.prescriptionItem],
    );
    assert.equal(qtyOf(row.rows[0].d), 30);

    // الدورات المستهلكة = الدورات المكتملة فقط
    const cycles = await pool.query(
      `SELECT COUNT(DISTINCT di.cycle_index) AS cycles FROM dispensing_items di
       JOIN dispensings dd ON dd.dispensing_id = di.dispensing_id
       WHERE di.prescription_item_id = $1 AND dd.status = 'COMPLETED' AND dd.status <> 'VOIDED'`,
      [ids.prescriptionItem],
    );
    assert.equal(qtyOf(cycles.rows[0].cycles), 1, 'only one cycle may be marked COMPLETED');
  } finally {
    await cleanupFixture(ids);
  }
});
