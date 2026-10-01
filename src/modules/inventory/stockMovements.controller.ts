import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  stockMovementCreateSchema,
  stockMovementListQuerySchema,
  isStockIncreasing,
  DEFAULT_STOCK_MOVEMENT_LIMIT,
  type StockMovementType,
  type StockMovementListQuery,
} from '../../validations/stockMovement.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10B.3A — Stock Movements backend foundation
 *
 * كل حركة تُنفَّذ داخل معاملة واحدة: قفل صف الدفعة، تحديث الكمية، ثم تسجيل
 * الحركة. أي فشل يؤدي إلى تراجع كامل — لا تعديل جزئي للمخزون.
 *
 * quantity_reserved لا يُمَس في هذه المرحلة.
 * ========================================================================== */

// نفس حد inventory_batches.quantity_on_hand (NUMERIC 12,3)
const MAX_STOCK_QUANTITY = 999_999_999.999;

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// موحّد للدفعة غير الموجودة وللخارج عن نطاق عيادات المستخدم (لا يُكشف وجوده)
const batchNotFound = (res: Response) =>
  res.status(404).json({ message: 'الدفعة المطلوبة غير موجودة' });

const insufficientStock = (res: Response, available: number, requested: number) =>
  res.status(409).json({
    message: `الكمية المتاحة غير كافية (المتاح ${available} والمطلوب ${requested})`,
    code: ApiErrorCode.FORBIDDEN,
  });

const movementMessage = (movementType: StockMovementType, quantityOnHand: number) => {
  const label: Record<StockMovementType, string> = {
    RECEIPT: 'استلام',
    DISPENSE: 'صرف',
    RETURN: 'إرجاع',
    ADJUSTMENT: 'تسوية',
    ADJUSTMENT_DECREASE: 'تسوية عجز',
    WASTE: 'هدر',
    EXPIRE: 'انتهاء صلاحية',
  };
  return `تم تسجيل حركة ${label[movementType]} — الرصيد الحالي ${quantityOnHand}`;
};

/* ==========================================================================
 * Phase 10B.3B — قراءة/تدقيق حركات المخزون (قراءة فقط)
 * النطاق عبر stock_movements -> inventory_batches -> inventory_items -> clinic_id.
 * لا تعديل لأي بيانات في هذا القسم.
 * ========================================================================== */

const MOVEMENT_JOINS = `FROM stock_movements sm
     JOIN inventory_batches b ON b.batch_id = sm.batch_id
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     LEFT JOIN medications m ON m.medication_id = i.medication_id
     LEFT JOIN users u ON u.user_id = sm.performed_by_user_id`;

// سياق التدقيق: هوية الدفعة والصنف والدواء ومن نفّذ الحركة — بلا أي بيانات مستخدم حساسة
const MOVEMENT_COLUMNS = `sm.movement_id, sm.batch_id, sm.movement_type, sm.quantity,
       sm.reference_type, sm.reference_id, sm.performed_by_user_id, sm.notes, sm.created_at,
       b.lot_number, b.inventory_id, i.medication_id, i.clinic_id,
       m.trade_name, m.scientific_name, m.strength, m.dosage_form,
       u.full_name AS performed_by_name`;

const movementNotFound = (res: Response) =>
  res.status(404).json({ message: 'حركة المخزون المطلوبة غير موجودة' });

const buildMovementFilters = (query: StockMovementListQuery): { clause: string; params: unknown[] } => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  };

  if (query.batch_id !== undefined) add('sm.batch_id', query.batch_id);
  if (query.movement_type !== undefined) add('sm.movement_type', query.movement_type);
  if (query.reference_type !== undefined) add('sm.reference_type', query.reference_type);
  if (query.reference_id !== undefined) add('sm.reference_id', query.reference_id);
  if (query.performed_by_user_id !== undefined) add('sm.performed_by_user_id', query.performed_by_user_id);

  return { clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
};

export const listStockMovements = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = stockMovementListQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تصفية حركات المخزون غير صالحة');
  const query = parsed.data;

  const limit = query.limit ?? DEFAULT_STOCK_MOVEMENT_LIMIT;
  const offset = query.offset ?? 0;
  const filters = buildMovementFilters(query);

  try {
    const scope = buildClinicScope(req, filters.params, 'i.clinic_id');
    const nextPlaceholder = scope.params.length + 1;
    const result = await pool.query(
      `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_JOINS}
       WHERE i.deleted_at IS NULL${filters.clause}${scope.clause}
       ORDER BY sm.created_at DESC, sm.movement_id DESC
       LIMIT $${nextPlaceholder} OFFSET $${nextPlaceholder + 1}`,
      [...scope.params, limit, offset],
    );

    return res.status(200).json({
      movements: result.rows,
      pagination: { limit, offset, returned: result.rows.length },
    });
  } catch (error) {
    console.error('List Stock Movements Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب حركات المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

export const getStockMovement = async (req: AuthenticatedRequest, res: Response) => {
  const movementId = parsePositiveId(req.params.id);
  if (movementId === null) return validationError(res, 'معرّف حركة المخزون غير صالح');

  try {
    const scope = buildClinicScope(req, [movementId], 'i.clinic_id');
    const result = await pool.query(
      `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_JOINS}
       WHERE sm.movement_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
      scope.params,
    );

    if (result.rows.length === 0) return movementNotFound(res);
    return res.status(200).json({ movement: result.rows[0] });
  } catch (error) {
    console.error('Get Stock Movement Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب حركة المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// تسجيل حركة مخزون وتحديث كمية الدفعة داخل معاملة واحدة
export const createStockMovement = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = stockMovementCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, 'بيانات حركة المخزون غير صالحة');
  const body = parsed.data;

  const isIncrease = isStockIncreasing(body.movement_type);
  // من المستخدم الموثَّق دائماً — لا يُقرأ من جسم الطلب إطلاقاً
  const performedByUserId = req.user?.userId ?? null;

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // قفل صف الدفعة + التحقق من النطاق عبر صنف المخزون (لا يُعتمد على batch_id وحده)
    const lockScope = buildClinicScope(req, [body.batch_id], 'i.clinic_id');
    const locked = await client.query(
      `SELECT b.batch_id, b.quantity_on_hand
       FROM inventory_batches b
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE b.batch_id = $1 AND i.deleted_at IS NULL${lockScope.clause}
       FOR UPDATE OF b`,
      lockScope.params,
    );

    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      return batchNotFound(res);
    }

    const available = Number(locked.rows[0].quantity_on_hand);
    const nextQuantity = isIncrease ? available + body.quantity : available - body.quantity;

    if (nextQuantity < 0) {
      await client.query('ROLLBACK');
      return insufficientStock(res, available, body.quantity);
    }
    if (nextQuantity > MAX_STOCK_QUANTITY) {
      await client.query('ROLLBACK');
      return validationError(res, 'الرصيد الناتج يتجاوز الحد الأقصى المسموح للمخزون');
    }

    // الكمية فقط — quantity_reserved لا تتغير في هذه المرحلة
    const updateScope = buildClinicScope(req, [nextQuantity, body.batch_id], 'i.clinic_id');
    const updated = await client.query(
      `UPDATE inventory_batches b SET quantity_on_hand = $1, updated_at = NOW()
       FROM inventory_items i
       WHERE b.inventory_id = i.inventory_id
         AND b.batch_id = $2
         AND i.deleted_at IS NULL${updateScope.clause}
       RETURNING b.batch_id, b.quantity_on_hand`,
      updateScope.params,
    );

    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return batchNotFound(res);
    }

    const inserted = await client.query(
      `INSERT INTO stock_movements
         (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                 performed_by_user_id, notes, created_at`,
      [
        body.batch_id,
        body.movement_type,
        body.quantity,
        body.reference_type ?? null,
        body.reference_id ?? null,
        performedByUserId,
        body.notes ?? null,
      ],
    );

    await client.query('COMMIT');
    return res.status(201).json({
      message: movementMessage(body.movement_type, nextQuantity),
      movement: inserted.rows[0],
      quantityOnHand: nextQuantity,
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
        message: 'الحركة تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Create Stock Movement Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تسجيل حركة المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};
