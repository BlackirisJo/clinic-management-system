import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  stockAdjustmentCreateSchema,
  ADJUSTMENT_MOVEMENT_TYPE,
  FORBIDDEN_ADJUSTMENT_FIELDS,
  MAX_ADJUSTMENT_QUANTITY,
  roundAdjustmentQuantity,
  type StockAdjustmentDirection,
} from '../../validations/stockAdjustment.validation';
import { buildClinicScope } from './clinicScope';

/* ==========================================================================
 * Phase 10D.2 — Manual stock adjustments (batch level)
 *
 * عملية واحدة داخل معاملة واحدة على نفس PoolClient:
 *   BEGIN
 *   -> قفل الدفعة FOR UPDATE
 *   -> اشتقاق العيادة من الدفعة والتحقق من النطاق
 *   -> إعادة قراءة الكميات الحالية
 *   -> التحقق من التسوية مقابل الحالة الحيّة
 *   -> إدراج رأس stock_adjustments
 *   -> تحديث كمية الدفعة (بحارس على مستوى قاعدة البيانات)
 *   -> إدراج حركة المخزون
 *   -> إدراج سجل التدقيق
 *   COMMIT
 *
 * أي فشل يؤدي إلى ROLLBACK كامل: لا تعديل جزئي للمخزون، ولا رأس بلا حركة،
 * ولا حركة بلا تدقيق. لا تُكتب أي قيمة خارج المعاملة.
 *
 * quantity_reserved لا يُمَس إطلاقاً: التسوية تُحسب على المتاح
 * (quantity_on_hand - quantity_reserved) ولا تُعدّل المحجوز نفسه.
 *
 * لا اختيار FEFO هنا: التسوية تستهدف دفعة واحدة صريحة من العميل.
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

// الرصيد تغيّر بين القراءة والقفل — لا نخمين، نطلب إعادة المحاولة
const quantityChanged = (res: Response) =>
  res.status(409).json({
    message: 'تغيّر رصيد الدفعة أثناء التسوية — أعد المحاولة',
    code: ApiErrorCode.FORBIDDEN,
  });

const adjustmentMessage = (direction: StockAdjustmentDirection, quantityAfter: number) =>
  direction === 'INCREASE'
    ? `تم تسجيل تسوية زيادة — الرصيد الحالي ${quantityAfter}`
    : `تم تسجيل تسوية عجز — الرصيد الحالي ${quantityAfter}`;

/**
 * تسوية مخزون يدوية على دفعة واحدة.
 * كل الهويات مُشتقّة من الخادم: العيادة من batch -> inventory_items.clinic_id،
 * والمنفّذ من المستخدم الموثّق. جسم الطلب لا يقبل أياً منها.
 */
export const createStockAdjustment = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // حارس صريح قبل أي وصول لقاعدة البيانات: هوية العيادة والمستخدم والدواء
  // والصنف والكمية الحالية ونوع الحركة ليست مُدخَلات — كلها تُشتق من الخادم.
  const forbiddenField = FORBIDDEN_ADJUSTMENT_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب التسوية — هذه القيم تُشتق من الخادم`);
  }

  const parsed = stockAdjustmentCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات تسوية المخزون غير صالحة');
  const input = parsed.data;

  // من المستخدم الموثَّق دائماً — لا يُقرأ من جسم الطلب إطلاقاً
  const performedByUserId = req.user?.userId ?? null;
  if (performedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لتسوية المخزون');
  }

  const movementType = ADJUSTMENT_MOVEMENT_TYPE[input.direction];

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) قفل صف الدفعة + اشتقاق العيادة منها + التحقق من النطاق.
    //    الاعتماد على batch_id وحده ممنوع: النطاق يمر عبر صنف المخزون.
    const lockScope = buildClinicScope(req, [input.batch_id], 'i.clinic_id');
    const locked = await client.query(
      `SELECT b.batch_id, b.inventory_id, b.quantity_on_hand, b.quantity_reserved,
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

    // 3) إعادة قراءة الكميات الحالية (من الصف المقفول) والتحقق مقابلها
    const quantityOnHand = Number(batch.quantity_on_hand);
    const quantityReserved = Number(batch.quantity_reserved);
    const available = roundAdjustmentQuantity(quantityOnHand - quantityReserved);

    //Decrease لا يجوز أن يتجاوز المتاح (بعد المحجوز) — quantity_reserved لا يُمس
    if (input.direction === 'DECREASE' && input.quantity > available) {
      await client.query('ROLLBACK');
      return insufficientAvailable(res, available, input.quantity);
    }

    const quantityAfter = roundAdjustmentQuantity(
      input.direction === 'INCREASE' ? quantityOnHand + input.quantity : quantityOnHand - input.quantity,
    );

    // حارسان ثانويان: لا رصيد سالب، ولا تجاوز لحد NUMERIC(12,3)
    if (quantityAfter < 0) {
      await client.query('ROLLBACK');
      return insufficientAvailable(res, available, input.quantity);
    }
    if (quantityAfter > MAX_ADJUSTMENT_QUANTITY) {
      await client.query('ROLLBACK');
      return validationError(res, 'الرصيد الناتج يتجاوز الحد الأقصى المسموح للمخزون');
    }

    // 4) رأس التسوية — تاريخ غير قابل للتعديل، قبل أي تغيير على الرصيد
    const header = await client.query(
      `INSERT INTO stock_adjustments
         (clinic_id, batch_id, inventory_id, medication_id, direction, quantity,
          quantity_before, quantity_after, reason, notes, performed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING adjustment_id, clinic_id, batch_id, inventory_id, medication_id, direction, quantity,
                 quantity_before, quantity_after, reason, notes, performed_by_user_id, created_at`,
      [
        clinicId,
        input.batch_id,
        inventoryId,
        medicationId,
        input.direction,
        input.quantity,
        quantityOnHand,
        quantityAfter,
        input.reason,
        input.notes ?? null,
        performedByUserId,
      ],
    );
    const adjustmentId = Number(header.rows[0].adjustment_id);

    // 5) تحديث كمية الدفعة بحارس على مستوى قاعدة البيانات.
    //    الحارس يتحقق من: نفس الدفعة، نفس الصنف، نفس العيادة المُشتقّة، نفس
    //    الرصيد المقروء تحت القفل، عدم سالب الرصيد، وعدم انتهاك
    //    quantity_reserved <= quantity_on_hand. quantity_reserved نفسه لا يُكتب.
    const updateParams = [quantityAfter, input.batch_id, quantityOnHand, inventoryId, clinicId];
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
         AND b.quantity_on_hand >= 0
         AND b.quantity_reserved <= $1${updateScope.clause}
       RETURNING b.batch_id, b.quantity_on_hand, b.quantity_reserved`,
      updateScope.params,
    );

    // صفر صف = الرصيد تغيّر أو اختفت النطاق: تراجع كامل يشمل رأس التسوية
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return quantityChanged(res);
    }

    // 6) حركة المخزون — كمية موجبة دائماً، والاتجاه يحدده نوع الحركة
    const movement = await client.query(
      `INSERT INTO stock_movements
         (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
       VALUES ($1, $2, $3, 'STOCK_ADJUSTMENT', $4, $5, $6)
       RETURNING movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                 performed_by_user_id, notes, created_at`,
      [input.batch_id, movementType, input.quantity, String(adjustmentId), performedByUserId, input.notes ?? null],
    );

    // 7) سجل تدقيق واحد فقط — داخل نفس المعاملة، فشله يُسقط التسوية كاملة
    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'STOCK_ADJUSTED', 'STOCK_ADJUSTMENT', $3, $4)`,
      [
        performedByUserId,
        clinicId,
        String(adjustmentId),
        JSON.stringify({
          adjustment_id: adjustmentId,
          clinic_id: clinicId,
          batch_id: input.batch_id,
          inventory_id: inventoryId,
          medication_id: medicationId,
          direction: input.direction,
          movement_type: movementType,
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes ?? null,
          before_quantity: quantityOnHand,
          after_quantity: quantityAfter,
          available_before: available,
          performed_by_user_id: performedByUserId,
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(201).json({
      message: adjustmentMessage(input.direction, quantityAfter),
      adjustment: header.rows[0],
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
        message: 'التسوية تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Create Stock Adjustment Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تنفيذ تسوية المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};
