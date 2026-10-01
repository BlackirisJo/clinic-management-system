import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  writeOffCreateSchema,
  WRITE_OFF_MOVEMENT_TYPE,
  WRITE_OFF_AUDIT_ACTION,
  WRITE_OFF_REFERENCE_TYPE,
  FORBIDDEN_WRITE_OFF_FIELDS,
  MAX_WRITE_OFF_QUANTITY,
  roundWriteOffQuantity,
  type InventoryWriteOffType,
} from '../../validations/writeOff.validation';
import { buildClinicScope } from './clinicScope';

/* ==========================================================================
 * Phase 10D.3 — Damage/waste and expiry write-off (batch level)
 *
 * عملية واحدة داخل معاملة واحدة على نفس PoolClient:
 *   BEGIN
 *   -> قفل الدفعة + صنف المخزون FOR UPDATE
 *   -> اشتقاق العيادة/الصنف/الدواء من قاعدة البيانات
 *   -> تطبيق نطاق العيادة على العيادة المُشتقّة
 *   -> التحقق من الكمية والمحجوز وانتهاء الصلاحية مقابل الحالة الحيّة
 *   -> إدراج رأس inventory_write_offs
 *   -> تحديث كمية الدفعة (بحارس على مستوى قاعدة البيانات)
 *   -> إدراج حركة المخزون
 *   -> إدراج سجل التدقيق
 *   COMMIT
 *
 * أي فشل يؤدي إلى ROLLBACK كامل: لا تعديل جزئي للمخزون، ولا رأس بلا حركة،
 * ولا حركة بلا تدقيق. لا تُكتب أي قيمة قبل اكتمال التحقق.
 *
 * quantity_reserved لا يُمَس إطلاقاً: المتاح هو
 * (quantity_on_hand - quantity_reserved) والكتابة-off تُنقص من quantity_on_hand
 * فقط، فلا تكسر قيد quantity_reserved <= quantity_on_hand.
 *
 * EXPIRE عملية محاسبة يدوية: لا ماسح ولا cron ولا خصم تلقائي — المستخدم هو من
 * يستدعيها، ولا يُسمح بها إلا على دفعة منتهية فعلاً.
 *
 * لا اختيار FEFO هنا: الكتابة-off تستهدف دفعة واحدة صريحة من العميل.
 * ========================================================================== */

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// موحّد للدفعة غير الموجودة وللخارج عن نطاق عيادات المستخدم (لا يُكشف وجوده)
const batchNotFound = (res: Response) =>
  res.status(404).json({ message: 'الدفعة المطلوبة غير موجودة' });

const insufficientAvailable = (res: Response, available: number, requested: number) =>
  res.status(409).json({
    message: `الكمية المتاحة غير كافية بعد خصم المحجوز (المتاح ${available} والمطلوب ${requested})`,
    code: ApiErrorCode.FORBIDDEN,
  });

// EXPIRE على دفعة لم تنتهِ صلاحيتها — لا تُحوَّل صامتة إلى WASTE ولا تُقبل
const batchNotExpired = (res: Response, expiryDate: string) =>
  res.status(409).json({
    message: `لا يمكن تسجيل انتهاء صلاحية لدفعة لم ينتهِ موعدها (تاريخ الانتهاء ${expiryDate})`,
    code: ApiErrorCode.FORBIDDEN,
  });

// الرصيد تغيّر بين القراءة والقفل — لا نخمين، نطلب إعادة المحاولة
const quantityChanged = (res: Response) =>
  res.status(409).json({
    message: 'تغيّر رصيد الدفعة أثناء تنفيذ العملية — أعد المحاولة',
    code: ApiErrorCode.FORBIDDEN,
  });

const writeOffMessage = (type: InventoryWriteOffType, quantityAfter: number) =>
  type === 'WASTE'
    ? `تم تسجيل تلف/فقد — الرصيد الحالي ${quantityAfter}`
    : `تم تسجيل انتهاء صلاحية — الرصيد الحالي ${quantityAfter}`;

/** تاريخ الانتهاء بصيغة YYYY-MM-DD (نوع DATE يعود نصاً خالصاً thanks لـ database.ts) */
const expiryDateOf = (value: unknown): string => String(value);

/**
 * كتابة-off للمخزون على دفعة واحدة: تلف/فقد (WASTE) أو انتهاء صلاحية (EXPIRE).
 * كل الهويات مُشتقّة من الخادم: العيادة من batch -> inventory_items.clinic_id،
 * والمنفّذ من المستخدم الموثّق. جسم الطلب لا يقبل أياً منها.
 */
export const createInventoryWriteOff = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // حارس صريح قبل أي وصول لقاعدة البيانات: هوية العيادة والمستخدم والدواء
  // والصنف والكمية الحالية ونوع الحركة ليست مُدخَلات — كلها تُشتق من الخادم.
  const forbiddenField = FORBIDDEN_WRITE_OFF_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب الكتابة-off — هذه القيم تُشتق من الخادم`);
  }

  const parsed = writeOffCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات الكتابة-off غير صالحة');
  const input = parsed.data;

  // من المستخدم الموثَّق دائماً — لا يُقرأ من جسم الطلب إطلاقاً
  const performedByUserId = req.user?.userId ?? null;
  if (performedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب للكتابة-off');
  }

  const movementType = WRITE_OFF_MOVEMENT_TYPE[input.type];
  const auditAction = WRITE_OFF_AUDIT_ACTION[input.type];

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) قفل صف الدفعة + صنف المخزون + اشتقاق العيادة منها + التحقق من النطاق.
    //    الاعتماد على batch_id وحده ممنوع: النطاق يمر عبر صنف المخزون.
    //    is_expired يُحسب في قاعدة البيانات (expiry_date < CURRENT_DATE) لا في
    //    JS، فلا يتأثر بقاعدة وقت مختلفة بين التطبيق والخادم.
    const lockScope = buildClinicScope(req, [input.batch_id], 'i.clinic_id');
    const locked = await client.query(
      `SELECT b.batch_id, b.inventory_id, b.expiry_date, b.quantity_on_hand, b.quantity_reserved,
              (b.expiry_date < CURRENT_DATE) AS is_expired,
              i.medication_id, i.clinic_id
       FROM inventory_batches b
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE b.batch_id = $1 AND i.deleted_at IS NULL${lockScope.clause}
       FOR UPDATE OF b`,
      lockScope.params,
    );

    // الدفعة الغائبة والخارجة عن النطاق تُعامَلان بنفس 404 تماماً
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      return batchNotFound(res);
    }

    // 2) كل القيم مُشتقّة: العيادة والدواء والصنف من الاستعلام المقفول
    const batch = locked.rows[0];
    const clinicId = Number(batch.clinic_id);
    const inventoryId = Number(batch.inventory_id);
    const medicationId = Number(batch.medication_id);
    const expiryDate = expiryDateOf(batch.expiry_date);
    const isExpired = batch.is_expired === true;

    // 3) إعادة قراءة الكميات الحالية (من الصف المقفول) والتحقق مقابلها
    const quantityOnHand = Number(batch.quantity_on_hand);
    const quantityReserved = Number(batch.quantity_reserved);
    const available = roundWriteOffQuantity(quantityOnHand - quantityReserved);

    // قاعدة خاصة بالنوع: EXPIRE مسموح فقط على دفعة منتهية فعلاً.
    // WASTE تلف/فقد صريح لا علاقة له بتاريخ الانتهاء.
    if (input.type === 'EXPIRE' && !isExpired) {
      await client.query('ROLLBACK');
      return batchNotExpired(res, expiryDate);
    }

    // المتاح = quantity_on_hand - quantity_reserved؛ quantity_reserved لا يُمس
    if (input.quantity > available) {
      await client.query('ROLLBACK');
      return insufficientAvailable(res, available, input.quantity);
    }

    // الكتابة-off تُنقص فقط — لا يوجد أي احتمال لرصيد سالب بعد التحقق أعلاه،
    // لكن الحارس يبقى صريحاً وواضحاً
    const quantityAfter = roundWriteOffQuantity(quantityOnHand - input.quantity);
    if (quantityAfter < 0) {
      await client.query('ROLLBACK');
      return insufficientAvailable(res, available, input.quantity);
    }
    if (quantityAfter > MAX_WRITE_OFF_QUANTITY) {
      await client.query('ROLLBACK');
      return validationError(res, 'الرصيد الناتج يتجاوز الحد الأقصى المسموح للمخزون');
    }

    // 4) رأس الكتابة-off — تاريخ غير قابل للتعديل، قبل أي تغيير على الرصيد
    const header = await client.query(
      `INSERT INTO inventory_write_offs
         (clinic_id, batch_id, inventory_id, medication_id, type, quantity,
          quantity_before, quantity_after, reason, notes, performed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING write_off_id, clinic_id, batch_id, inventory_id, medication_id, type, quantity,
                 quantity_before, quantity_after, reason, notes, performed_by_user_id, created_at`,
      [
        clinicId,
        input.batch_id,
        inventoryId,
        medicationId,
        input.type,
        input.quantity,
        quantityOnHand,
        quantityAfter,
        input.reason,
        input.notes ?? null,
        performedByUserId,
      ],
    );
    const writeOffId = Number(header.rows[0].write_off_id);

    // 5) تحديث كمية الدفعة بحارس على مستوى قاعدة البيانات.
    //    الحارس يتحقق من: نفس الدفعة، نفس الصنف، نفس العيادة المُشتقّة، نفس
    //    الرصيد المقروء تحت القفل، عدم تغيّر المحجوز، عدم سالب الرصيد، وعدم
    //    انتهاك quantity_reserved <= quantity_on_hand.
    //    quantity_reserved نفسه لا يُكتب.
    const updateParams = [quantityAfter, input.batch_id, quantityOnHand, inventoryId, clinicId, quantityReserved];
    const updateScope = buildClinicScope(req, updateParams, 'i.clinic_id');
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
         AND b.quantity_reserved = $6
         AND $1 >= 0
         AND b.quantity_reserved <= $1${updateScope.clause}
       RETURNING b.batch_id, b.quantity_on_hand, b.quantity_reserved`,
      updateScope.params,
    );

    // صفر صف = الرصيد تغيّر أو اختفت النطاق: تراجع كامل يشمل رأس الكتابة-off
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return quantityChanged(res);
    }

    // 6) حركة المخزون — كمية موجبة دائماً، والنوع يحدده movement_type
    const movement = await client.query(
      `INSERT INTO stock_movements
         (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                 performed_by_user_id, notes, created_at`,
      [
        input.batch_id,
        movementType,
        input.quantity,
        WRITE_OFF_REFERENCE_TYPE,
        String(writeOffId),
        performedByUserId,
        input.notes ?? null,
      ],
    );

    // 7) سجل تدقيق واحد فقط — داخل نفس المعاملة، فشله يُسقط العملية كاملة
    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, 'INVENTORY_WRITE_OFF', $4, $5)`,
      [
        performedByUserId,
        clinicId,
        auditAction,
        String(writeOffId),
        JSON.stringify({
          write_off_id: writeOffId,
          clinic_id: clinicId,
          batch_id: input.batch_id,
          inventory_id: inventoryId,
          medication_id: medicationId,
          type: input.type,
          movement_type: movementType,
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes ?? null,
          before_quantity: quantityOnHand,
          after_quantity: quantityAfter,
          available_before: available,
          expiry_date: expiryDate,
          performed_by_user_id: performedByUserId,
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(201).json({
      message: writeOffMessage(input.type, quantityAfter),
      write_off: header.rows[0],
      movement: movement.rows[0],
      batch_id: input.batch_id,
      quantityBefore: quantityOnHand,
      quantityAfter,
    });
  } catch (error: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — يُتجاهل لأن العملية فشلت أصلاً
      }
    }
    if (error?.code === '23503') return validationError(res, 'الدفعة أو المستخدم المحدد غير موجود');
    if (error?.code === '23514') {
      return res.status(409).json({
        message: 'العملية تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Create Inventory Write-off Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تنفيذ الكتابة-off',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};
