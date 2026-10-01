import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { canAccessLogs } from '../audit/audit.controller';
import {
  medicationReturnListQuerySchema,
  DEFAULT_MEDICATION_RETURN_LIMIT,
  type MedicationReturnListQuery,
} from '../../validations/medicationReturnRead.validation';
import {
  medicationReturnCreateSchema,
  FORBIDDEN_RETURN_FIELDS,
  FORBIDDEN_RETURN_ITEM_FIELDS,
  MAX_RETURN_QUANTITY,
  roundReturnQuantity,
  type MedicationReturnCreateInput,
} from '../../validations/medicationReturn.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10D.4 — Medication returns read & audit API
 *
 * قراءة فقط بالكامل: لا معاملات، لا FOR UPDATE، لا SKIP LOCKED، ولا INSERT /
 * UPDATE / DELETE / RETURNING. لا يوجد في هذه المرحلة أي مسار كتابة — إنشاء
 * الإرجاع وإعادة المخزون هي Phase 10D.5.
 *
 * كل القيم التاريخية تُقرأ من سجلات الإرجاع المحفوظة
 * (medication_return_items.unit_cost_snapshot) لا من تكلفة الدفعة الحالية، ولا
 * من المخزون الحالي.
 *
 * حقول العرض للمستخدمين آمنة فقط: الاسم. لا اسم مستخدم ولا بريد ولا هوية.
 *
 * Phase 10D.5 — تنفيذ إرجاع دواء من مريض (mutation واحدة، tx واحدة).
 * ============================================================== */

/** خطأ نطاقي: يؤدي دائماً إلى ROLLBACK ثم استجابة واضحة. */
class MedicationReturnError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = { message, code, ...extra };
  }
}

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// موحّد: سجل غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده)
const returnNotFound = (res: Response) =>
  res.status(404).json({ message: 'سجل إرجاع الأدوية المطلوب غير موجود' });

/** حقول العرض الآمنة للمستخدم — الاسم فقط، بلا اسم مستخدم أو بريد. */
const SAFE_USER_NAME = 'u.full_name AS user_name';

const buildListFilters = (query: MedicationReturnListQuery): { clause: string; params: unknown[] } => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    conditions.push(fragment.replace('$?', `$${params.length}`));
  };

  if (query.patient_id !== undefined) add('r.dispensed_to_patient_id = $?', query.patient_id);
  if (query.original_dispensing_id !== undefined) add('r.original_dispensing_id = $?', query.original_dispensing_id);
  if (query.returned_by_user_id !== undefined) add('r.returned_by_user_id = $?', query.returned_by_user_id);
  if (query.status !== undefined) add('r.status = $?', query.status);

  return { clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
};

/** 1. قائمة سجلات الإرجاع — خفيفة: بلا بنود وبلا حالة الدفعات. */
export const listMedicationReturns = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = medicationReturnListQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تصفية سجلات الإرجاع غير صالحة');
  const query = parsed.data;

  const limit = query.limit ?? DEFAULT_MEDICATION_RETURN_LIMIT;
  const offset = query.offset ?? 0;
  const filters = buildListFilters(query);

  try {
    const scope = buildClinicScope(req, filters.params, 'r.clinic_id');
    const next = scope.params.length + 1;
    const result = await pool.query(
      `SELECT r.return_id, r.status, r.original_dispensing_id,
              r.dispensed_to_patient_id, r.returned_by_user_id, r.created_at,
              pt.full_name AS patient_name,
              ${SAFE_USER_NAME},
              (SELECT COUNT(*)::int FROM medication_return_items mri WHERE mri.return_id = r.return_id) AS item_count
       FROM medication_returns r
       JOIN patients pt ON pt.patient_id = r.dispensed_to_patient_id
       JOIN users u ON u.user_id = r.returned_by_user_id
       WHERE 1=1${filters.clause}${scope.clause}
       ORDER BY r.created_at DESC, r.return_id DESC
       LIMIT $${next} OFFSET $${next + 1}`,
      [...scope.params, limit, offset],
    );

    return res.status(200).json({
      returns: result.rows,
      pagination: { limit, offset, returned: result.rows.length },
    });
  } catch (error) {
    console.error('List Medication Returns Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب سجلات إرجاع الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/** يتحقق من وجود السجل ضمن النطاق — يُستخدم قبل كل مسار تفصيلي. */
const loadScopedReturn = async (req: AuthenticatedRequest, returnId: number): Promise<boolean> => {
  const scope = buildClinicScope(req, [returnId], 'r.clinic_id');
  const result = await pool.query(
    `SELECT r.return_id, r.clinic_id, r.status FROM medication_returns r
     WHERE r.return_id = $1${scope.clause}`,
    scope.params,
  );
  return result.rows.length > 0;
};

/** 2. تفاصيل سجل إرجاع كامل — التكلفة التاريخية من اللقطة المحفوظة فقط. */
export const getMedicationReturn = async (req: AuthenticatedRequest, res: Response) => {
  const returnId = parsePositiveId(req.params.id);
  if (returnId === null) return validationError(res, 'معرّف سجل الإرجاع غير صالح');

  try {
    const scope = buildClinicScope(req, [returnId], 'r.clinic_id');
    const header = await pool.query(
      `SELECT r.return_id, r.clinic_id, r.status, r.original_dispensing_id,
              r.dispensed_to_patient_id, r.returned_by_user_id,
              r.reason, r.notes, r.created_at,
              pt.full_name AS patient_name,
              pt.gender AS patient_gender,
              ru.full_name AS returned_by_name,
              c.clinic_name
       FROM medication_returns r
       JOIN patients pt ON pt.patient_id = r.dispensed_to_patient_id
       JOIN users ru ON ru.user_id = r.returned_by_user_id
       JOIN clinics c ON c.clinic_id = r.clinic_id
       WHERE r.return_id = $1${scope.clause}`,
      scope.params,
    );
    if (header.rows.length === 0) return returnNotFound(res);

    // بنود الإرجاع في استعلام واحد بلا N+1.
    // unit_cost_snapshot يأتي من medication_return_items حصراً — لا استعلام على
    // inventory_batches.unit_cost هنا ولا في أي مكان آخر في مسار القراءة.
    const items = await pool.query(
      `SELECT mri.return_item_id, mri.dispensing_item_batch_id, mri.batch_id, mri.medication_id,
              mri.quantity, mri.unit_cost_snapshot, mri.restock_decision, mri.created_at,
              m.trade_name, m.scientific_name, m.strength, m.dosage_form
       FROM medication_return_items mri
       JOIN medications m ON m.medication_id = mri.medication_id
       WHERE mri.return_id = $1
       ORDER BY mri.return_item_id ASC`,
      [returnId],
    );

    return res.status(200).json({
      return: {
        ...header.rows[0],
        items: items.rows.map((row) => ({
          return_item_id: row.return_item_id,
          dispensing_item_batch_id: row.dispensing_item_batch_id,
          batch_id: row.batch_id,
          medication_id: row.medication_id,
          medication: {
            trade_name: row.trade_name,
            scientific_name: row.scientific_name,
            strength: row.strength,
            dosage_form: row.dosage_form,
          },
          quantity: row.quantity,
          unit_cost_snapshot: row.unit_cost_snapshot,
          restock_decision: row.restock_decision,
          created_at: row.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('Get Medication Return Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب تفاصيل إرجاع الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/**
 * 3. حركات المخزون المرتبطة بسجل الإرجاع — قراءة فقط.
 * قد تكون النتيجة فارغة تماماً قبل Phase 10D.5: لا يوجد بعد أي مسار ينشئ حركة
 * من نوع MEDICATION_RETURN. هذا سلوك متوقّع لا خطأ.
 */
export const getMedicationReturnMovements = async (req: AuthenticatedRequest, res: Response) => {
  const returnId = parsePositiveId(req.params.id);
  if (returnId === null) return validationError(res, 'معرّف سجل الإرجاع غير صالح');

  try {
    if (!(await loadScopedReturn(req, returnId))) return returnNotFound(res);

    const scope = buildClinicScope(req, [String(returnId)], 'i.clinic_id');
    const result = await pool.query(
      `SELECT sm.movement_id, sm.batch_id, sm.movement_type, sm.quantity,
              sm.reference_type, sm.reference_id, sm.notes, sm.created_at,
              sm.performed_by_user_id, b.lot_number, b.expiry_date AS batch_expiry_date
       FROM stock_movements sm
       JOIN inventory_batches b ON b.batch_id = sm.batch_id
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE sm.reference_type = 'MEDICATION_RETURN'
         AND sm.reference_id = $1${scope.clause}
       ORDER BY sm.created_at ASC, sm.movement_id ASC`,
      scope.params,
    );

    return res.status(200).json({
      return_id: returnId,
      movements: result.rows,
      returned: result.rows.length,
    });
  } catch (error) {
    console.error('Get Medication Return Movements Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب حركات إرجاع الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/** 4. سجل التدقيق المرتبط — محصور بنفس قاعدة سجلات النظام الحالية. */
export const getMedicationReturnAudit = async (req: AuthenticatedRequest, res: Response) => {
  const returnId = parsePositiveId(req.params.id);
  if (returnId === null) return validationError(res, 'معرّف سجل الإرجاع غير صالح');

  // سجلات النظام مقصورة عمداً — القاعدة نفسها المستخدمة في وحدة التدقيق
  if (!canAccessLogs(req)) {
    return res.status(403).json({ message: 'غير مصرّح', code: ApiErrorCode.FORBIDDEN });
  }

  try {
    if (!(await loadScopedReturn(req, returnId))) return returnNotFound(res);

    const scope = buildClinicScope(req, [String(returnId)], 'r.clinic_id');
    const result = await pool.query(
      `SELECT a.audit_id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at,
              a.clinic_id, u.full_name AS user_name
       FROM audit_logs a
       JOIN medication_returns r ON r.return_id = a.resource_id::int
       LEFT JOIN users u ON u.user_id = a.user_id
       WHERE a.resource_type = 'MEDICATION_RETURN'
         AND a.resource_id = $1${scope.clause}
       ORDER BY a.created_at ASC, a.audit_id ASC`,
      scope.params,
    );

    return res.status(200).json({
      return_id: returnId,
      audit_logs: result.rows,
      returned: result.rows.length,
    });
  } catch (error) {
    console.error('Get Medication Return Audit Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب سجل تدقيق إرجاع الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/* ==========================================================================
 * Phase 10D.5 — تنفيذ إرجاع دواء من مريض
 *
 * عملية واحدة داخل معاملة واحدة على نفس PoolClient:
 *   BEGIN
 *   -> قفل سجل الصرف والتحقق أنه ليس VOIDED
 *   -> قفل التخصيصات المطلوبة والتحقق أنها تنتمي لهذا الصرف
 *   -> التحقق من الكميات وسجل الإرجاعات السابقة
 *   -> قفل الدفعات المتأثرة بترتيب batch_id تصاعدي حتمي
 *   -> اشتقاق كل القيم من الخادم
 *   -> إدراج رأس medication_returns
 *   -> إدراج بنود medication_return_items
 *   -> تطبيق تغييرات المخزون/العزل حسب القرار
 *   -> إدراج حركات المخزون
 *   -> إدراج سجل التدقيق
 *   COMMIT
 *
 * أي فشل يؤدي إلى ROLLBACK كامل. لا تُكتب أي قيمة قبل اكتمال التحقق.
 *
 * quantity_reserved لا يُمَس. dispensing_items.dispensed_quantity و
 * remaining_quantity لا يُمسان — الإرجاع يُسجَّل ولا يُعاد حساب الصرف.
 * ========================================================================== */

interface LockedAllocation {
  dispensing_item_batch_id: number;
  original_batch_id: number;
  allocated_quantity: number;
  unit_cost_snapshot: string | null;
  medication_id: number;
  inventory_item_id: number;
}

interface LockedBatch {
  batch_id: number;
  inventory_id: number;
  is_active: boolean;
  quantity_on_hand: number;
  quantity_reserved: number;
}

/** ينفّذ الإرجاع داخل معاملة قائمة — يرمي MedicationReturnError عند أي رفض. */
const runMedicationReturn = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  input: MedicationReturnCreateInput,
  returnedByUserId: number,
): Promise<{ message: string; return: Record<string, unknown>; movements: Record<string, unknown>[] }> => {
  // 1) قفل سجل الصرف — النطاق عبر عيادة الصرف نفسها، فلا يُكشف وجوده خارج النطاق
  const dispensingScope = buildClinicScope(req, [input.dispensing_id], 'd.clinic_id');
  const dispensingResult = await client.query(
    `SELECT d.dispensing_id, d.clinic_id, d.patient_id, d.status
     FROM dispensings d
     WHERE d.dispensing_id = $1${dispensingScope.clause}
     FOR UPDATE OF d`,
    dispensingScope.params,
  );
  // السجل الغائب والخارج عن النطاق يُعامَلان بنفس 404 تماماً
  if (dispensingResult.rows.length === 0) {
    throw new MedicationReturnError(404, ApiErrorCode.VALIDATION_ERROR, 'سجل الصرف المطلوب غير موجود');
  }

  const dispensing = dispensingResult.rows[0];
  // كل هوية مشتقّة: العيادة والمريض من سجل الصرف، لا من جسم الطلب
  const clinicId = Number(dispensing.clinic_id);
  const patientId = Number(dispensing.patient_id);
  if (String(dispensing.status) === 'VOIDED') {
    throw new MedicationReturnError(
      409,
      ApiErrorCode.FORBIDDEN,
      'لا يمكن إرجاع دواء من سجل صرف ملغى',
      { dispensing_id: input.dispensing_id },
    );
  }

  // 2) قفل التخصيصات المطلوبة — قفلها هو ما يمنع حسابين متزامنين لنفس الكمية.
  //    الترتيب تصاعدي صريحاً حتى لا يعتمد ترتيب القفل على ترتيب الطلب.
  const allocationIds = [...new Set(input.items.map((item) => item.dispensing_item_batch_id))].sort((a, b) => a - b);
  const allocationResult = await client.query(
    `SELECT dib.dispensing_item_batch_id, dib.batch_id, dib.quantity, dib.unit_cost_snapshot,
            di.medication_id, di.inventory_item_id
     FROM dispensing_item_batches dib
     JOIN dispensing_items di ON di.dispensing_item_id = dib.dispensing_item_id
     WHERE dib.dispensing_item_batch_id = ANY($1::bigint[])
       AND di.dispensing_id = $2
     ORDER BY dib.dispensing_item_batch_id ASC
     FOR UPDATE OF dib`,
    [allocationIds, input.dispensing_id],
  );
  if (allocationResult.rows.length !== allocationIds.length) {
    throw new MedicationReturnError(
      400,
      ApiErrorCode.VALIDATION_ERROR,
      'أحد التخصيصات المطلوبة غير موجود أو لا ينتمي لسجل الصرف هذا',
    );
  }

  const allocations = new Map<number, LockedAllocation>(
    allocationResult.rows.map((row) => [
      Number(row.dispensing_item_batch_id),
      {
        dispensing_item_batch_id: Number(row.dispensing_item_batch_id),
        original_batch_id: Number(row.batch_id),
        allocated_quantity: Number(row.quantity),
        // التكلفة التاريخية تُقرأ من سطر الصرف وتُجمَّد أدناه — لا من الدفعة
        unit_cost_snapshot: row.unit_cost_snapshot === null || row.unit_cost_snapshot === undefined
          ? null
          : String(row.unit_cost_snapshot),
        medication_id: Number(row.medication_id),
        inventory_item_id: Number(row.inventory_item_id),
      },
    ]),
  );

  // 3) سجل الإرجاعات السابقة — قفل التخصيصات يضمن أن كل قارئ رأى ما التزم به سابقه
  const priorResult = await client.query(
    `SELECT mri.dispensing_item_batch_id, COALESCE(SUM(mri.quantity), 0) AS returned_quantity
     FROM medication_return_items mri
     JOIN medication_returns mr ON mr.return_id = mri.return_id
     WHERE mri.dispensing_item_batch_id = ANY($1::bigint[])
       AND mr.status = 'COMPLETED'
     GROUP BY mri.dispensing_item_batch_id`,
    [allocationIds],
  );
  const alreadyReturned = new Map<number, number>(
    priorResult.rows.map((row) => [Number(row.dispensing_item_batch_id), Number(row.returned_quantity)]),
  );

  for (const item of input.items) {
    const allocation = allocations.get(item.dispensing_item_batch_id)!;
    const prior = roundReturnQuantity(alreadyReturned.get(item.dispensing_item_batch_id) ?? 0);
    const remaining = roundReturnQuantity(allocation.allocated_quantity - prior);
    if (item.quantity > remaining) {
      throw new MedicationReturnError(
        409,
        ApiErrorCode.FORBIDDEN,
        `الكمية المطلوبة تتجاوز المتبقي من التخصيص (المتاح ${remaining} والمطلوب ${item.quantity})`,
        {
          dispensing_item_batch_id: item.dispensing_item_batch_id,
          allocated_quantity: allocation.allocated_quantity,
          previously_returned_quantity: prior,
          returnable_quantity: remaining,
        },
      );
    }
    // تكلفة تاريخية مفقودة لا تُخترع ولا تُقرأ من الدفعة
    if (allocation.unit_cost_snapshot === null) {
      throw new MedicationReturnError(
        409,
        ApiErrorCode.FORBIDDEN,
        'سطر الصرف هذا لا يحمل تكلفة تاريخية مسجّلة — لا يمكن توثيق الإرجاع',
        { dispensing_item_batch_id: item.dispensing_item_batch_id },
      );
    }
  }

  // 4) قفل كل الدفعات المتأثرة بترتيب حتمي — يمنع الجمود بين عمليتين متقاطعتين
  const targetBatchIds = [
    ...new Set(
      input.items.flatMap((item) => {
        const allocation = allocations.get(item.dispensing_item_batch_id)!;
        return [allocation.original_batch_id, ...(item.batch_id === undefined ? [] : [item.batch_id])];
      }),
    ),
  ].sort((a, b) => a - b);

  const batchScope = buildClinicScope(req, [targetBatchIds], 'i.clinic_id');
  const batchResult = await client.query(
    `SELECT b.batch_id, b.inventory_id, b.is_active, b.quantity_on_hand, b.quantity_reserved
     FROM inventory_batches b
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     WHERE b.batch_id = ANY($1::int[]) AND i.deleted_at IS NULL${batchScope.clause}
     ORDER BY b.batch_id ASC
     FOR UPDATE OF b`,
    batchScope.params,
  );
  if (batchResult.rows.length !== targetBatchIds.length) {
    throw new MedicationReturnError(404, ApiErrorCode.VALIDATION_ERROR, 'إحدى الدفعات المطلوبة غير موجودة');
  }
  const batches = new Map<number, LockedBatch>(
    batchResult.rows.map((row) => [
      Number(row.batch_id),
      {
        batch_id: Number(row.batch_id),
        inventory_id: Number(row.inventory_id),
        is_active: row.is_active === true,
        quantity_on_hand: Number(row.quantity_on_hand),
        quantity_reserved: Number(row.quantity_reserved),
      },
    ]),
  );

  // 5) اشتقاق قرار كل بند والتحقق من قاعدة الدفعة البديلة
  interface PlannedItem {
    allocation: LockedAllocation;
    quantity: number;
    restock_decision: 'RESTOCK' | 'QUARANTINE' | 'WASTE';
    /** الدفعة التي يستقر فيها المخزون المُعاد (الأصلية أو البديلة) — null للـ WASTE */
    target_batch_id: number | null;
    movement_type: 'RETURN' | 'WASTE';
  }

  const planned: PlannedItem[] = input.items.map((item) => {
    const allocation = allocations.get(item.dispensing_item_batch_id)!;
    const originalBatch = batches.get(allocation.original_batch_id)!;

    if (item.restock_decision === 'WASTE') {
      // لا يُعاد مخزون: لا يوجد أين يستقر، فلا دفعة هدف
      return {
        allocation,
        quantity: item.quantity,
        restock_decision: item.restock_decision,
        target_batch_id: null,
        movement_type: 'WASTE',
      };
    }

    // RESTOCK و QUARANTINE يبقيان المخزون داخل الدفعة الأصلية ما لم تُطلب بديلة
    let targetBatchId = allocation.original_batch_id;
    if (item.batch_id !== undefined && item.batch_id !== allocation.original_batch_id) {
      // الدفعة البديلة مسموحة فقط لدفعة أصلية معطّلة، ومع سبب إلزامي
      if (originalBatch.is_active) {
        throw new MedicationReturnError(
          409,
          ApiErrorCode.FORBIDDEN,
          'لا يمكن الإرجاع إلى دفعة بديلة ما دامت الدفعة الأصلية نشطة',
          { original_batch_id: allocation.original_batch_id, requested_batch_id: item.batch_id },
        );
      }
      if (input.substitution_reason === null || input.substitution_reason === undefined) {
        throw new MedicationReturnError(
          400,
          ApiErrorCode.VALIDATION_ERROR,
          'استخدام دفعة بديلة يتطلب سبباً واضحاً',
        );
      }
      const substitute = batches.get(item.batch_id)!;
      if (substitute.inventory_id !== originalBatch.inventory_id) {
        throw new MedicationReturnError(
          400,
          ApiErrorCode.VALIDATION_ERROR,
          'الدفعة البديلة يجب أن تنتمي لنفس صنف المخزون',
          { requested_batch_id: item.batch_id },
        );
      }
      targetBatchId = item.batch_id;
    }

    return {
      allocation,
      quantity: item.quantity,
      restock_decision: item.restock_decision,
      target_batch_id: targetBatchId,
      // العزل مسار استلام أيضاً: الكمية تعود للدفعة لكن مع عزل يجعلها غير
      // مؤهلة للصرف أو FEFO حتى يُطلقها أحدهم صراحةً
      movement_type: 'RETURN',
    };
  });

  // 6) رأس الإرجاع — status يحدده الخادم دائماً: لا مسار إلغاء في هذه المرحلة
  const header = await client.query(
    `INSERT INTO medication_returns
       (clinic_id, returned_by_user_id, dispensed_to_patient_id, original_dispensing_id, status, reason, notes)
     VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6)
     RETURNING return_id, clinic_id, returned_by_user_id, dispensed_to_patient_id,
               original_dispensing_id, status, reason, notes, created_at`,
    [clinicId, returnedByUserId, patientId, input.dispensing_id, input.reason, input.notes ?? null],
  );
  const returnId = Number(header.rows[0].return_id);

  // 7) بنود الإرجاع — batch_id المُحفظ هو دفعة الصرف الأصلية (إثبات المصدر)،
  //    والتكلفة التاريخية ROUND(..., 3) من لقطة سطر الصرف لا من الدفعة
  const itemRows: Record<string, unknown>[] = [];
  for (const entry of planned) {
    const item = await client.query(
      `INSERT INTO medication_return_items
         (return_id, dispensing_item_batch_id, batch_id, medication_id, quantity, unit_cost_snapshot, restock_decision)
       VALUES ($1, $2, $3, $4, $5, ROUND($6::numeric, 3), $7)
       RETURNING return_item_id, dispensing_item_batch_id, batch_id, medication_id,
                 quantity, unit_cost_snapshot, restock_decision, created_at`,
      [
        returnId,
        entry.allocation.dispensing_item_batch_id,
        entry.allocation.original_batch_id,
        entry.allocation.medication_id,
        entry.quantity,
        entry.allocation.unit_cost_snapshot,
        entry.restock_decision,
      ],
    );
    itemRows.push(item.rows[0]!);
  }

  // 8) المخزون والعزل — quantity_reserved لا يُكتب، ولا يُكتب حقل التكلفة
  const movements: Record<string, unknown>[] = [];
  for (const entry of planned) {
    // WASTE لا يُعيد مخزوناً: لا تحديث دفعة، ولا عزل — لكنه يبقى سطر حركة يوثّق
    // أن الكمية أُتلفت ولم تعد إلى المخزون.
    if (entry.target_batch_id !== null) {
      const target = batches.get(entry.target_batch_id)!;
      const quantityAfter = roundReturnQuantity(target.quantity_on_hand + entry.quantity);
      if (quantityAfter > MAX_RETURN_QUANTITY) {
        throw new MedicationReturnError(
          400,
          ApiErrorCode.VALIDATION_ERROR,
          'الرصيد الناتج يتجاوز الحد الأقصى المسموح للمخزون',
        );
      }

      // تحديث محروس: نفس الدفعة، نفس الصنف، نفس الرصيد المقروء تحت القفل، وعدم
      // كسر quantity_reserved <= quantity_on_hand
      const updateScope = buildClinicScope(
        req,
        [quantityAfter, entry.target_batch_id, target.quantity_on_hand, target.inventory_id, clinicId],
        'i.clinic_id',
      );
      const updated = await client.query(
        `UPDATE inventory_batches b
         SET quantity_on_hand = $1, updated_at = NOW()
         FROM inventory_items i
         WHERE b.inventory_id = i.inventory_id
           AND b.batch_id = $2
           AND i.inventory_id = $4
           AND i.clinic_id = $5
           AND i.deleted_at IS NULL
           AND b.quantity_on_hand = $3
           AND $1 >= b.quantity_reserved
           AND $1 <= ${MAX_RETURN_QUANTITY}${updateScope.clause}
         RETURNING b.batch_id, b.quantity_on_hand, b.quantity_reserved`,
        updateScope.params,
      );
      if (updated.rowCount !== 1) {
        throw new MedicationReturnError(
          409,
          ApiErrorCode.FORBIDDEN,
          'تغيّر رصيد الدفعة أثناء الإرجاع — أعد المحاولة',
          { batch_id: entry.target_batch_id },
        );
      }
      target.quantity_on_hand = quantityAfter;

      // 8b) العزل — يُنشأ إن لم يكن هناك عزل نشط؛ ولا يُعدَّل أو يُطلق هنا إطلاقاً
      if (entry.restock_decision === 'QUARANTINE') {
        const existing = await client.query(
          `SELECT 1 FROM batch_quarantines bq
           WHERE bq.batch_id = $1 AND bq.released_at IS NULL`,
          [entry.target_batch_id],
        );
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO batch_quarantines (batch_id, clinic_id, reason, quarantined_by_user_id)
             VALUES ($1, $2, $3, $4)`,
            [
              entry.target_batch_id,
              clinicId,
              `عزل تلقائي بسبب إرجاع دواء من مريض — ${input.reason}`,
              returnedByUserId,
            ],
          );
        }
      }
    }

    // 9) حركة مخزون لكل بند — كمية موجبة، والمرجع هو سجل الإرجاع.
    //    WASTE تُوثَّق على دفعة الصرف الأصلية لأنها لم تستقر في أي دفعة.
    const movement = await client.query(
      `INSERT INTO stock_movements
         (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
       VALUES ($1, $2, $3, 'MEDICATION_RETURN', $4, $5, $6)
       RETURNING movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                 performed_by_user_id, notes, created_at`,
      [
        entry.target_batch_id ?? entry.allocation.original_batch_id,
        entry.movement_type,
        entry.quantity,
        String(returnId),
        returnedByUserId,
        input.notes ?? null,
      ],
    );
    movements.push(movement.rows[0]!);
  }

  // 10) سجل تدقيق واحد فقط — داخل نفس المعاملة، فشله يُسقط الإرجاع كاملاً
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'MEDICATION_RETURNED', 'MEDICATION_RETURN', $3, $4)`,
    [
      returnedByUserId,
      clinicId,
      String(returnId),
      JSON.stringify({
        return_id: returnId,
        clinic_id: clinicId,
        original_dispensing_id: input.dispensing_id,
        patient_id: patientId,
        returned_by_user_id: returnedByUserId,
        reason: input.reason,
        notes: input.notes ?? null,
        substitution_reason: input.substitution_reason ?? null,
        items: planned.map((entry) => ({
          return_item_id: itemRows[planned.indexOf(entry)]!.return_item_id,
          dispensing_item_batch_id: entry.allocation.dispensing_item_batch_id,
          medication_id: entry.allocation.medication_id,
          inventory_item_id: entry.allocation.inventory_item_id,
          original_batch_id: entry.allocation.original_batch_id,
          restock_target_batch_id: entry.target_batch_id,
          quantity: entry.quantity,
          restock_decision: entry.restock_decision,
          movement_type: entry.movement_type,
          previously_returned_quantity: alreadyReturned.get(entry.allocation.dispensing_item_batch_id) ?? 0,
        })),
      }),
    ],
  );

  return {
    message: 'تم تسجيل إرجاع الأدوية بنجاح',
    return: { ...header.rows[0], items: itemRows },
    movements,
  };
};

/** إرجاع دواء من مريض — عملية ذرّية واحدة على نفس PoolClient. */
export const createMedicationReturn = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // حارس صريح قبل أي وصول لقاعدة البيانات: الهوية والنطاق والأرقام المالية
  // ليست مُدخَلات — كلها تُشتق من الخادم
  const forbiddenField = FORBIDDEN_RETURN_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب الإرجاع — هذه القيم تُشتق من الخادم`);
  }
  if (Array.isArray(body.items)) {
    for (const raw of body.items) {
      if (raw === null || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      const forbiddenItemField = FORBIDDEN_RETURN_ITEM_FIELDS.find((field) => record[field] !== undefined);
      if (forbiddenItemField !== undefined) {
        return validationError(res, `الحقل ${forbiddenItemField} غير مقبول في بند الإرجاع — هذه القيم تُشتق من الخادم`);
      }
    }
  }

  const parsed = medicationReturnCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات إرجاع الأدوية غير صالحة');
  const input = parsed.data;

  // الدفعة البديلة تستحق مخزوناً، فلا معنى لطلبها مع قرار لا يُعيد مخزوناً
  for (const item of input.items) {
    if (item.batch_id !== undefined && item.restock_decision !== 'RESTOCK') {
      return validationError(res, 'الدفعة البديلة مسموحة فقط مع قرار RESTOCK');
    }
  }

  // من المستخدم الموثَّق دائماً — لا يُقرأ من جسم الطلب إطلاقاً
  const returnedByUserId = req.user?.userId ?? null;
  if (returnedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لتسجيل الإرجاع');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await runMedicationReturn(client, req, input, returnedByUserId);
    await client.query('COMMIT');
    return res.status(201).json(result);
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — يُتجاهل لأن العملية فشلت أصلاً
      }
    }
    if (error instanceof MedicationReturnError) {
      return res.status(error.status).json(error.payload);
    }
    if ((error as any)?.code === '23505') {
      return res.status(409).json({
        message: 'تعارض في سجل الإرجاع — أعد المحاولة',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    if ((error as any)?.code === '23503') {
      return validationError(res, 'أحد المراجع المرتبطة غير موجود');
    }
    if ((error as any)?.code === '23514') {
      return res.status(409).json({
        message: 'الإرجاع يخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Create Medication Return Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تنفيذ إرجاع الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};
