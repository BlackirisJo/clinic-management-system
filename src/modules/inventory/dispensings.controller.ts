import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { dispensingCreateSchema, dispensingVoidSchema, type DispensingCreateInput } from '../../validations/dispensing.validation';
import { buildClinicScope } from './clinicScope';
import { allocateFefoBatches, type FefoAllocation } from './fefo';

/* ==========================================================================
 * Phase 10C.3 — صرف دواء كامل (Full dispensing only)
 *
 * المعاملة الواحدة: تحميل الروشتة → التحقق من الكميات والوحدات → حساب
 * المتبقي → قفل الدفعات بـ FEFO → إنشاء سجلات الصرف → خصم المخزون →
 * حركات DISPENSE → تدقيق → COMMIT. أي خطأ يؤدي إلى ROLLBACK كامل.
 *
 * لا خصم جزئي صامت: إمّا صرف كامل أو رفض.
 * ========================================================================== */

/** خطأ نطاقي: يؤدي دائماً إلى ROLLBACK ثم استجابة واضحة. */
class DispensingError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = { message, code, ...extra };
  }
}

interface PrescriptionItemRow {
  item_id: number;
  medication_id: number;
  prescribed_quantity: number | null;
  uom: string | null;
  dosage: string;
}

const toNumber = (value: unknown): number => Number(value);
const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const round3 = (value: number): number => Number(value.toFixed(3));

/**
 * Phase 10C.4B — التوزيع بأقصى المتاح دون تجاوز المتبقي.
 * يستدعي الموزّع المقفل مرة للمتبقي؛ فإن نقص، يُعاد استدعاؤه بالمتاح فعلياً
 * (الصفوف مقفلة أصلاً داخل نفس المعاملة). لا تغيير في عقدة FEFO نفسها.
 */
const allocateBestEffort = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  inventoryId: number,
  remaining: number,
): Promise<FefoAllocation[]> => {
  if (remaining <= 0) return [];

  const attempt = await allocateFefoBatches(client, req, inventoryId, remaining);
  if (attempt.ok) return attempt.allocations;

  if (attempt.reason === 'INSUFFICIENT_STOCK' && attempt.available_quantity > 0) {
    const best = await allocateFefoBatches(client, req, inventoryId, attempt.available_quantity);
    if (best.ok) return best.allocations;
  }
  return [];
};

/** ينفّذ الصرف داخل معاملة قائمة — يرمي DispensingError عند أي رفض. */
const runDispensing = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  input: DispensingCreateInput,
  dispensedByUserId: number,
): Promise<{ message: string; dispensing: Record<string, unknown> }> => {
  // 1) الروشتة والعيادة عبر الزيارة — النطاق من جدول الزيارات، لا من العميل
  const scope = buildClinicScope(req, [input.prescription_id], 'v.clinic_id');
  const prescriptionResult = await client.query(
    `SELECT p.prescription_id, p.patient_id, v.clinic_id
     FROM prescriptions p
     JOIN visits v ON v.visit_id = p.visit_id
     WHERE p.prescription_id = $1${scope.clause}`,
    scope.params,
  );
  if (prescriptionResult.rows.length === 0) {
    throw new DispensingError(404, ApiErrorCode.VALIDATION_ERROR, 'الروشتة المطلوبة غير موجودة');
  }

  const prescription = prescriptionResult.rows[0];
  const prescriptionId = toNumber(prescription.prescription_id);
  const patientId = toNumber(prescription.patient_id);
  // عيادة الزيارة مُتحقَّق منها أصلاً عبر نطاق المستخدم أعلاه
  const clinicId = toNumber(prescription.clinic_id);

  // 2) بنود الروشتة — يجب أن تحمل كمية ووحدة مُعرَّفتين.
  // القفل هنا (وليس على prescriptions) هو ما يمنع حسابين متزامنين لنفس المتبقي.
  const itemsResult = await client.query(
    `SELECT pi.item_id, pi.medication_id, pi.prescribed_quantity, pi.uom, pi.dosage
     FROM prescription_items pi
     WHERE pi.prescription_id = $1
     ORDER BY pi.item_id ASC
     FOR UPDATE OF pi`,
    [prescriptionId],
  );
  const items = itemsResult.rows.map((row) => ({
    item_id: toNumber(row.item_id),
    medication_id: toNumber(row.medication_id),
    prescribed_quantity: toNumberOrNull(row.prescribed_quantity),
    uom: row.uom === null || row.uom === undefined ? null : String(row.uom),
  })) as PrescriptionItemRow[];

  if (items.length === 0) {
    throw new DispensingError(400, ApiErrorCode.VALIDATION_ERROR, 'لا توجد أدوية في الروشتة');
  }

  for (const item of items) {
    // بنود تاريخية بلا كمية/وحدة: تُقرأ عادةً لكن لا تُصرف، ولا تُستنتج من dosage أو repeats_count
    if (item.prescribed_quantity === null || item.prescribed_quantity <= 0 || !item.uom) {
      throw new DispensingError(
        400,
        ApiErrorCode.VALIDATION_ERROR,
        'أحد بنود الروشتة بلا كمية أو وحدة قياس معرَّفة — لا يمكن الصرف',
        { prescription_item_id: item.item_id },
      );
    }
  }

  // 3) تفويض التكرار + تاريخ الصرف — الدورات تُحسم لكل الروشتة دفعة واحدة
  const itemIds = items.map((item) => item.item_id);

  // 3a) تفويض التكرار (اختياري). يُقفل لإلغاء سباق تخصيص الدورة.
//      غياب الصف = max_cycles = 1 ضمنياً. CANCELLED = لا تكرار.
  const authResult = await client.query(
    `SELECT ra.repeat_auth_id, ra.prescription_item_id, ra.max_cycles, ra.status
     FROM prescription_repeat_authorizations ra
     WHERE ra.prescription_item_id = ANY($1::int[])
     ORDER BY ra.prescription_item_id ASC
     FOR UPDATE OF ra`,
    [itemIds],
  );
  const authByItem = new Map<number, { max_cycles: number; status: string }>(
    authResult.rows.map((row) => [
      toNumber(row.prescription_item_id),
      { max_cycles: toNumber(row.max_cycles), status: String(row.status) },
    ]),
  );

  // 3b) تاريخ الصرف لكل بند لكل دورة. VOIDED مستبعَد فلا يستهلك دورة
  //     ولا يُحتسب ضمن المتبقي.
  const historyResult = await client.query(
    `SELECT di.prescription_item_id, di.cycle_index, d.status, di.dispensed_quantity
     FROM dispensing_items di
     JOIN dispensings d ON d.dispensing_id = di.dispensing_id
     WHERE di.prescription_item_id = ANY($1::int[])
       AND d.status <> 'VOIDED'`,
    [itemIds],
  );

  const dispensedInCycle = new Map<string, number>();
  const completedCycles = new Set<number>();
  let maxCycleSeen = -1;
  for (const row of historyResult.rows) {
    const itemId = toNumber(row.prescription_item_id);
    const cycle = toNumber(row.cycle_index);
    if (cycle > maxCycleSeen) maxCycleSeen = cycle;
    if (String(row.status) === 'COMPLETED') completedCycles.add(cycle);
    const key = `${itemId}:${cycle}`;
    dispensedInCycle.set(key, (dispensedInCycle.get(key) ?? 0) + toNumber(row.dispensed_quantity));
  }

  // 3c) حسم الدورة على مستوى الروشتة (لا تتنازع بنودها بين دورتين):
  //      دورة جارية فيها متبقي ← متابعة، وإلا فدورة جديدة إن سمح التفويض.
  const maxCyclesForItem = new Map<number, number>();
  for (const item of items) {
    const auth = authByItem.get(item.item_id);
    maxCyclesForItem.set(item.item_id, !auth || auth.status !== 'ACTIVE' ? 1 : auth.max_cycles);
  }
  const prescriptionMaxCycles = Math.min(...maxCyclesForItem.values());

  const prescribedByItem = new Map(items.map((i) => [i.item_id, i.prescribed_quantity!]));
  const lastCycleRemaining = (cycle: number): number =>
    items.reduce(
      (sum, item) =>
        sum + Math.max(0, prescribedByItem.get(item.item_id)! - (dispensedInCycle.get(`${item.item_id}:${cycle}`) ?? 0)),
      0,
    );

  let cycleIndex: number;
  if (maxCycleSeen < 0) {
    cycleIndex = 0; // الدورة الابتدائية
  } else if (lastCycleRemaining(maxCycleSeen) > 0) {
    cycleIndex = maxCycleSeen; // متابعة دورة جارية
  } else {
    // الدورة السابقة مكتملة: إما تبدأ التالية أو يُرفض
    const cyclesUsed = maxCycleSeen + 1;
    if (cyclesUsed >= prescriptionMaxCycles) {
      throw new DispensingError(
        409,
        ApiErrorCode.FORBIDDEN,
        'اكتملت كل دورات الصرف المسموحة لهذه الروشتة',
        { cycles_used: cyclesUsed, max_cycles: prescriptionMaxCycles },
      );
    }
    cycleIndex = maxCycleSeen + 1;
  }

  // 3d) المتبقي محسوب داخل الدورة الحالية فقط
  const lines = items.map((item) => {
    const dispensedHere = round3(dispensedInCycle.get(`${item.item_id}:${cycleIndex}`) ?? 0);
    return {
      item,
      cycleIndex,
      maxCycles: maxCyclesForItem.get(item.item_id)!,
      prior: dispensedHere,
      remaining: round3(item.prescribed_quantity! - dispensedHere),
    };
  });

  if (lines.every((line) => line.remaining <= 0)) {
    throw new DispensingError(409, ApiErrorCode.FORBIDDEN, 'تم صرف هذه الروشتة بالكامل مسبقاً');
  }
  // Phase 10C.4B: الصرف الجزئي المتكرر مسموح — المتبقي يُحسب من السجلات المحفوظة،
  // ولا تُشتق أي كمية من dosage أو repeats_count.

  // 4) صنف المخزون لكل دواء داخل عيادة الروشتة + مطابقة الوحدة
  const inventoryByMedication = new Map<number, { inventory_id: number; uom: string }>();
  for (const line of lines) {
    const inventoryResult = await client.query(
      `SELECT inventory_id, uom FROM inventory_items
       WHERE medication_id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [line.item.medication_id, clinicId],
    );
    if (inventoryResult.rows.length === 0) {
      throw new DispensingError(
        404,
        ApiErrorCode.VALIDATION_ERROR,
        'لا يوجد صنف مخزون نشط لهذا الدواء في عيادة الروشتة',
        { medication_id: line.item.medication_id },
      );
    }
    const inventory = inventoryResult.rows[0];
    const inventoryUom = String(inventory.uom);
    if (inventoryUom !== line.item.uom) {
      // لا تحويل بين الوحدات — يُرفض بوضوح
      throw new DispensingError(
        400,
        ApiErrorCode.VALIDATION_ERROR,
        'وحدة قياس الروشتة لا تطابق وحدة صنف المخزون',
        {
          prescription_item_id: line.item.item_id,
          prescription_uom: line.item.uom,
          inventory_uom: inventoryUom,
        },
      );
    }
    inventoryByMedication.set(line.item.medication_id, {
      inventory_id: toNumber(inventory.inventory_id),
      uom: inventoryUom,
    });
  }

  // 5) قفل وتوزيع FEFO على نفس PoolClient — بأقصى المتاح دون تجاوز المتبقي
  const planned: {
    line: (typeof lines)[number];
    inventoryId: number;
    allocations: FefoAllocation[];
  }[] = [];

  for (const line of lines) {
    const inventoryId = inventoryByMedication.get(line.item.medication_id)!.inventory_id;
    planned.push({ line, inventoryId, allocations: await allocateBestEffort(client, req, inventoryId, line.remaining) });
  }

  // 5b) لا سجل صرف فارغ — إن لم يُخصم أي شيء فلا معنى لإنشاء معاملة
  const totalDispensed = round3(
    planned.reduce(
      (sum, entry) => sum + entry.allocations.reduce((inner, a) => inner + a.allocation, 0),
      0,
    ),
  );
  if (totalDispensed <= 0) {
    throw new DispensingError(
      409,
      ApiErrorCode.FORBIDDEN,
      'لا توجد كميات متاحة للصرف من أي بند في هذه الروشتة',
      {
        reason: 'NOTHING_TO_DISPENSE',
        items: planned.map((entry) => ({
          prescription_item_id: entry.line.item.item_id,
          remaining_quantity: entry.line.remaining,
        })),
      },
    );
  }

  // الحالة: مكتملة فقط إذا انتهى متبقي كل بند، وإلا جزئية
  const dispensedByItem = new Map<number, number>();
  for (const entry of planned) {
    dispensedByItem.set(
      entry.line.item.item_id,
      round3(entry.allocations.reduce((sum, a) => sum + a.allocation, 0)),
    );
  }
  const isCompleted = lines.every((line) => {
    const after = round3(line.remaining - (dispensedByItem.get(line.item.item_id) ?? 0));
    return after <= 0;
  });
  const status = isCompleted ? 'COMPLETED' : 'PARTIAL';

  // 6) رأس سجل الصرف — الحالة يحددها الخادم من المخزون الفعلي
  const header = await client.query(
    `INSERT INTO dispensings
       (prescription_id, visit_id, clinic_id, patient_id, dispensed_by_user_id, status, notes)
     SELECT p.prescription_id, v.visit_id, v.clinic_id, p.patient_id, $2, $3, $4
     FROM prescriptions p JOIN visits v ON v.visit_id = p.visit_id
     WHERE p.prescription_id = $1
     RETURNING dispensing_id, prescription_id, clinic_id, patient_id, status, created_at`,
    [prescriptionId, dispensedByUserId, status, input.notes ?? null],
  );
  const dispensingId = toNumber(header.rows[0].dispensing_id);

  // 7) بنود الصرف وتخصيصاتها — صف لكل بند، مع حفظ الحساب الدقيق
  for (const entry of planned) {
    const currentDispensed = dispensedByItem.get(entry.line.item.item_id) ?? 0;
    const finalRemaining = round3(entry.line.item.prescribed_quantity! - entry.line.prior - currentDispensed);
    const itemInsert = await client.query(
      `INSERT INTO dispensing_items
         (dispensing_id, prescription_item_id, medication_id, inventory_item_id,
          prescribed_quantity, dispensed_quantity, remaining_quantity, uom, cycle_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING dispensing_item_id`,
      [
        dispensingId,
        entry.line.item.item_id,
        entry.line.item.medication_id,
        entry.inventoryId,
        entry.line.item.prescribed_quantity,
        currentDispensed,
        finalRemaining,
        entry.line.item.uom,
        entry.line.cycleIndex,
      ],
    );
    const dispensingItemId = toNumber(itemInsert.rows[0].dispensing_item_id);

    // لا صفوف تخصيص لكميات صفرية
    for (const allocation of entry.allocations) {
      if (allocation.allocation <= 0) continue;
      await client.query(
        `INSERT INTO dispensing_item_batches
           (dispensing_item_id, batch_id, quantity, unit_cost_snapshot, expiry_date_snapshot)
         VALUES ($1, $2, $3, $4, $5)`,
        [dispensingItemId, allocation.batch_id, allocation.allocation, allocation.unit_cost, allocation.expiry_date],
      );
    }
  }

  // 8) خصم المخزون من الدفعات المقفلة — بحارس يمنع السالب
  for (const entry of planned) {
    for (const allocation of entry.allocations) {
      if (allocation.allocation <= 0) continue;
      const deduction = await client.query(
        `UPDATE inventory_batches
         SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW()
         WHERE batch_id = $2 AND quantity_on_hand >= $1`,
        [allocation.allocation, allocation.batch_id],
      );
      if (deduction.rowCount !== 1) {
        // لا يمكن الاستمرار: الرصيد تغيّر بعد القفل
        throw new DispensingError(
          409,
          ApiErrorCode.FORBIDDEN,
          'تغيّر رصيد الدفعة أثناء الصرف — أعد المحاولة',
          { batch_id: allocation.batch_id },
        );
      }

      // 9) حركة صرف واحدة لكل دفعة — الكمية موجبة والاتجاه يحدده DISPENSE
      await client.query(
        `INSERT INTO stock_movements
           (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
         VALUES ($1, 'DISPENSE', $2, 'DISPENSING', $3, $4, $5)`,
        [
          allocation.batch_id,
          allocation.allocation,
          String(dispensingId),
          dispensedByUserId,
          input.notes ?? null,
        ],
      );
    }
  }

  // 10) التدقيق — داخل نفس المعاملة، فشله يُسقط الصرف بالكامل
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'DISPENSED', 'DISPENSING', $3, $4)`,
    [
      dispensedByUserId,
      clinicId,
      String(dispensingId),
      JSON.stringify({
        dispensing_id: dispensingId,
        prescription_id: prescriptionId,
        patient_id: patientId,
        pharmacist_user_id: dispensedByUserId,
        status,
        items: planned.map((entry) => ({
          prescription_item_id: entry.line.item.item_id,
          medication_id: entry.line.item.medication_id,
          inventory_item_id: entry.inventoryId,
          prescribed_quantity: entry.line.item.prescribed_quantity,
          previously_dispensed_quantity: entry.line.prior,
          dispensed_quantity: dispensedByItem.get(entry.line.item.item_id) ?? 0,
          remaining_quantity: round3(
            entry.line.item.prescribed_quantity! - entry.line.prior - (dispensedByItem.get(entry.line.item.item_id) ?? 0),
          ),
          uom: entry.line.item.uom,
          cycle_index: entry.line.cycleIndex,
          max_cycles: entry.line.maxCycles,
          cycle_state: isCompleted ? 'COMPLETED' : 'PARTIAL',
          batches: entry.allocations
            .filter((allocation) => allocation.allocation > 0)
            .map((allocation) => ({
              batch_id: allocation.batch_id,
              lot_number: allocation.lot_number,
              expiry_date: allocation.expiry_date,
              quantity: allocation.allocation,
              unit_cost_snapshot: allocation.unit_cost,
            })),
        })),
      }),
    ],
  );

  return {
    message: isCompleted ? 'تم صرف الروشتة بنجاح' : 'تم صرف جزء من الروشتة — المتبقي لم يُصرف',
    dispensing: {
      ...header.rows[0],
      dispensing_id: dispensingId,
      prescription_id: prescriptionId,
      clinic_id: clinicId,
      status,
      items: planned.map((entry) => {
        const currentDispensed = dispensedByItem.get(entry.line.item.item_id) ?? 0;
        return {
          prescription_item_id: entry.line.item.item_id,
          medication_id: entry.line.item.medication_id,
          inventory_item_id: entry.inventoryId,
          prescribed_quantity: entry.line.item.prescribed_quantity,
          previously_dispensed_quantity: entry.line.prior,
          dispensed_quantity: currentDispensed,
          remaining_quantity: round3(entry.line.item.prescribed_quantity! - entry.line.prior - currentDispensed),
          uom: entry.line.item.uom,
          cycle_index: entry.line.cycleIndex,
          max_cycles: entry.line.maxCycles,
          batches: entry.allocations
            .filter((allocation) => allocation.allocation > 0)
            .map((allocation) => ({
              batch_id: allocation.batch_id,
              lot_number: allocation.lot_number,
              quantity: allocation.allocation,
            })),
        };
      }),
    },
  };
};

export const createDispensing = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = dispensingCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      message: 'بيانات طلب الصرف غير صالحة',
      code: ApiErrorCode.VALIDATION_ERROR,
    });
  }

  // هوية الصيدلي من الجلسة حصراً — لا تُقرأ من جسم الطلب أبداً
  const dispensedByUserId = req.user?.userId;
  if (dispensedByUserId === undefined || dispensedByUserId === null) {
    return res.status(401).json({ message: 'المستخدم غير موثق', code: ApiErrorCode.UNAUTHENTICATED });
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const outcome = await runDispensing(client, req, parsed.data, dispensedByUserId);
    await client.query('COMMIT');
    return res.status(201).json(outcome);
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — العملية فشلت أصلاً
      }
    }
    if (error instanceof DispensingError) {
      return res.status(error.status).json(error.payload);
    }
    const dbError = error as { code?: string } | null;
    if (dbError?.code === '23503') {
      return res.status(400).json({
        message: 'أحد المراجع المرتبطة غير موجود',
        code: ApiErrorCode.VALIDATION_ERROR,
      });
    }
    if (dbError?.code === '23514') {
      return res.status(409).json({
        message: 'العملية تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    if (dbError?.code === '23505') {
      return res.status(409).json({
        message: 'تعارض في سجلات الصرف',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    // لا تُسرَّب أخطاء SQL الداخلية إلى العميل
    console.error('Create Dispensing Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تنفيذ الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};

/* ==========================================================================
 * Phase 10C.4A — Void a dispensing and restore exactly what it deducted
 *
 * الكميات المستعادة تُؤخذ من dispensing_item_batches.quantity حصراً — لا يُعاد
 * بناؤها من بيانات الروشتة. قفل الرأس أولاً يمنع الإلغاء المزدوج: المحاولة
 * الثانية تنتظر القفل ثم ترى VOIDED.
 * ========================================================================== */

const runVoid = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  dispensingId: number,
  reason: string | null,
  voidedByUserId: number,
): Promise<{ message: string; dispensing: Record<string, unknown> }> => {
  // 1) قفل الرأس مع نطاق العيادة — القفل هو حارس الإلغاء المزدوج
  const scope = buildClinicScope(req, [dispensingId], 'd.clinic_id');
  const header = await client.query(
    `SELECT d.dispensing_id, d.prescription_id, d.patient_id, d.clinic_id, d.status
     FROM dispensings d
     WHERE d.dispensing_id = $1${scope.clause}
     FOR UPDATE OF d`,
    scope.params,
  );
  if (header.rows.length === 0) {
    throw new DispensingError(404, ApiErrorCode.VALIDATION_ERROR, 'سجل الصرف المطلوب غير موجود');
  }

  const record = header.rows[0];
  const status = String(record.status);
  if (status !== 'COMPLETED') {
    // VOIDED → إلغاء مزدوج، PARTIAL → دورة حياة غير مدعومة بعد
    throw new DispensingError(409, ApiErrorCode.FORBIDDEN, 'لا يمكن إلغاء سجل صرف ليس مكتملاً', { status });
  }

  // 2) بنود الصرف وتخصيصاتها — المصدر الوحيد للكمية المستعادة
  const allocations = await client.query(
    `SELECT dib.dispensing_item_batch_id, dib.dispensing_item_id, dib.batch_id,
            dib.quantity, dib.unit_cost_snapshot, dib.expiry_date_snapshot,
            di.prescription_item_id, di.medication_id, di.uom AS dispensing_uom
     FROM dispensing_item_batches dib
     JOIN dispensing_items di ON di.dispensing_item_id = dib.dispensing_item_id
     WHERE di.dispensing_id = $1
     ORDER BY dib.batch_id ASC, dib.dispensing_item_batch_id ASC`,
    [dispensingId],
  );
  if (allocations.rows.length === 0) {
    throw new DispensingError(
      409,
      ApiErrorCode.FORBIDDEN,
      'سجل الصرف لا يحتوي على تخصيصات لإرجاعها',
    );
  }

  const rows = allocations.rows.map((row) => ({
    allocation_id: toNumber(row.dispensing_item_batch_id),
    dispensing_item_id: toNumber(row.dispensing_item_id),
    batch_id: toNumber(row.batch_id),
    quantity: toNumber(row.quantity),
    prescription_item_id: toNumber(row.prescription_item_id),
    medication_id: toNumber(row.medication_id),
  }));

  // 3) قفل الدفعات المتأثرة — مرتبة بـ batch_id لتفادي الجمود بين عمليتين
  const batchIds = [...new Set(rows.map((row) => row.batch_id))].sort((a, b) => a - b);
  const locked = await client.query(
    `SELECT b.batch_id FROM inventory_batches b
     WHERE b.batch_id = ANY($1::int[])
     ORDER BY b.batch_id ASC
     FOR UPDATE OF b`,
    [batchIds],
  );
  if (locked.rowCount !== batchIds.length) {
    throw new DispensingError(409, ApiErrorCode.FORBIDDEN, 'تعذّر قفل دفعات الصرف — أعد المحاولة');
  }

  // 4) استعادة المخزون + حركة RETURN لكل تخصيص
  for (const row of rows) {
    if (!(row.quantity > 0)) {
      throw new DispensingError(409, ApiErrorCode.FORBIDDEN, 'كمية تخصيص غير صالحة');
    }

    // إضافة صرفة للكمية المسجّلة، مع حارس يمنع تجاوز حد NUMERIC(12,3)
    const restore = await client.query(
      `UPDATE inventory_batches
       SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW()
       WHERE batch_id = $2
         AND quantity_on_hand + $1 <= 999999999.999
         AND quantity_on_hand >= 0`,
      [row.quantity, row.batch_id],
    );
    if (restore.rowCount !== 1) {
      throw new DispensingError(
        409,
        ApiErrorCode.FORBIDDEN,
        'تعذّرت استعادة رصيد الدفعة — أعد المحاولة',
        { batch_id: row.batch_id },
      );
    }

    await client.query(
      `INSERT INTO stock_movements
         (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
       VALUES ($1, 'RETURN', $2, 'DISPENSING_VOID', $3, $4, $5)`,
      [row.batch_id, row.quantity, String(dispensingId), voidedByUserId, reason],
    );
  }

  // 5) حالة السجل — الثلاثة تُكتب معاً لتلبية قيد اتساق الإلغاء
  const voided = await client.query(
    `UPDATE dispensings
     SET status = 'VOIDED', voided_at = NOW(), voided_by_user_id = $1, void_reason = $2
     WHERE dispensing_id = $3 AND status = 'COMPLETED'
     RETURNING dispensing_id, prescription_id, patient_id, clinic_id, status, voided_at, void_reason`,
    [voidedByUserId, reason, dispensingId],
  );
  if (voided.rowCount !== 1) {
    throw new DispensingError(409, ApiErrorCode.FORBIDDEN, 'سبق إلغاء سجل الصرف هذا');
  }

  // 6) التدقيق — داخل نفس المعاملة
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'DISPENSING_VOIDED', 'DISPENSING', $3, $4)`,
    [
      voidedByUserId,
      toNumber(record.clinic_id),
      String(dispensingId),
      JSON.stringify({
        dispensing_id: dispensingId,
        prescription_id: toNumber(record.prescription_id),
        patient_id: toNumber(record.patient_id),
        voided_by_user_id: voidedByUserId,
        reason,
        items: rows.map((row) => ({
          dispensing_item_id: row.dispensing_item_id,
          prescription_item_id: row.prescription_item_id,
          medication_id: row.medication_id,
          batch_id: row.batch_id,
          restored_quantity: row.quantity,
        })),
      }),
    ],
  );

  return {
    message: 'تم إلغاء سجل الصرف وإرجاع الكميات',
    dispensing: {
      dispensing_id: dispensingId,
      prescription_id: toNumber(record.prescription_id),
      status: 'VOIDED',
      void_reason: reason,
      restored_items: rows.length,
      restored_batches: batchIds,
    },
  };
};

export const voidDispensing = async (req: AuthenticatedRequest, res: Response) => {
  const dispensingId = Number(req.params.id);
  if (!Number.isInteger(dispensingId) || dispensingId <= 0) {
    return res.status(400).json({ message: 'معرّف سجل الصرف غير صالح', code: ApiErrorCode.VALIDATION_ERROR });
  }

  const parsed = dispensingVoidSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'بيانات الإلغاء غير صالحة', code: ApiErrorCode.VALIDATION_ERROR });
  }

  const voidedByUserId = req.user?.userId;
  if (voidedByUserId === undefined || voidedByUserId === null) {
    return res.status(401).json({ message: 'المستخدم غير موثق', code: ApiErrorCode.UNAUTHENTICATED });
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const outcome = await runVoid(client, req, dispensingId, parsed.data.reason ?? null, voidedByUserId);
    await client.query('COMMIT');
    return res.status(200).json(outcome);
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — العملية فشلت أصلاً
      }
    }
    if (error instanceof DispensingError) {
      return res.status(error.status).json(error.payload);
    }
    const dbError = error as { code?: string } | null;
    if (dbError?.code === '23514' || dbError?.code === '23505') {
      return res.status(409).json({ message: 'تعذّر إتمام الإلغاء', code: ApiErrorCode.FORBIDDEN });
    }
    console.error('Void Dispensing Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إلغاء الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};
