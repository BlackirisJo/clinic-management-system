import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  stockMovementCreateSchema,
  stockMovementListQuerySchema,
  isStockIncreasing,
  FORBIDDEN_STOCK_MOVEMENT_FIELDS,
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

  if (query.created_from !== undefined) {
    params.push(query.created_from);
    conditions.push(`sm.created_at >= $${params.length}`);
  }

  if (query.created_to !== undefined) {
    // For inclusive end date, add 1 day to capture the full day
    const toDate = new Date(query.created_to);
    toDate.setDate(toDate.getDate() + 1);
    params.push(toDate);
    conditions.push(`sm.created_at < $${params.length}`);
  }

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

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total ${MOVEMENT_JOINS}
       WHERE i.deleted_at IS NULL${filters.clause}${scope.clause}`,
      scope.params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const result = await pool.query(
      `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_JOINS}
       WHERE i.deleted_at IS NULL${filters.clause}${scope.clause}
       ORDER BY sm.created_at DESC, sm.movement_id DESC
       LIMIT $${nextPlaceholder} OFFSET $${nextPlaceholder + 1}`,
      [...scope.params, limit, offset],
    );

    return res.status(200).json({
      movements: result.rows,
      pagination: { limit, offset, returned: result.rows.length, total },
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
  const rawBody = (req.body ?? {}) as Record<string, unknown>;

  // أي حقل يُشتق على الخادم في الجسم = تزوير، ويُرفض قبل أي وصول لقاعدة البيانات
  // (performed_by_user_id من المستخدم الموثَّق، والطوابع من قاعدة البيانات)
  const forbiddenField = FORBIDDEN_STOCK_MOVEMENT_FIELDS.find((field) => rawBody[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب حركة المخزون — هذه القيم تُشتق على الخادم`);
  }

  const parsed = stockMovementCreateSchema.safeParse(rawBody);
  if (!parsed.success) return validationError(res, 'بيانات حركة المخزون غير صالحة');
  const body = parsed.data;

  const isIncrease = isStockIncreasing(body.movement_type);
  // من المستخدم الموثَّق دائماً — لا يُقرأ من جسم الطلب إطلاقاً
  const performedByUserId = req.user?.userId ?? null;
  // مفتاح التكرار — يُستخدم فقط لعمليات RECEIPT
  const idempotencyKey = body.idempotency_key ?? null;

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

    // 0) Early replay check for keyed RECEIPT operations
    // Must be done AFTER acquiring the batch lock to serialize with concurrent requests
    // Unique index is on idempotency_key for RECEIPT, so query by key alone
    if (idempotencyKey !== null && body.movement_type === 'RECEIPT') {
      const existing = await client.query(
        `SELECT movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                performed_by_user_id, notes, created_at
         FROM stock_movements
         WHERE idempotency_key = $1 AND movement_type = 'RECEIPT'
         LIMIT 1`,
        [idempotencyKey],
      );
      if (existing.rows.length > 0) {
        const existingMovement = existing.rows[0];
        // Verify this is the same operation (same batch, quantity, reference)
        if (Number(existingMovement.batch_id) !== body.batch_id ||
            Number(existingMovement.quantity) !== body.quantity ||
            (existingMovement.reference_type ?? null) !== (body.reference_type ?? null) ||
            (existingMovement.reference_id ?? null) !== (body.reference_id ?? null)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            message: 'مفتاح التكرار مستخدم لعملية استلام مختلفة',
            code: ApiErrorCode.FORBIDDEN,
          });
        }
        await client.query('ROLLBACK');
        return res.status(200).json({
          message: 'سبق تسجيل هذه الحركة بنفس مفتاح التكرار',
          idempotent_replay: true,
          movement: existingMovement,
          quantityOnHand: Number(locked.rows[0].quantity_on_hand),
        });
      }
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

    // 1) Insert under a savepoint: a unique-index collision with a concurrent
    //    request carrying the same key is caught here instead of taking the whole
    //    transaction down, and is then read as a replay rather than a 500.
    let inserted: { rows: any[] };
    try {
      await client.query('SAVEPOINT insert_movement');
      inserted = await client.query(
        `INSERT INTO stock_movements
           (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                   performed_by_user_id, notes, created_at, idempotency_key`,
        [
          body.batch_id,
          body.movement_type,
          body.quantity,
          body.reference_type ?? null,
          body.reference_id ?? null,
          performedByUserId,
          body.notes ?? null,
          idempotencyKey,
        ],
      );
      await client.query('RELEASE SAVEPOINT insert_movement');
    } catch (insertError: any) {
      await client.query('ROLLBACK TO SAVEPOINT insert_movement');
      if (insertError?.code === '23505' && idempotencyKey !== null && body.movement_type === 'RECEIPT') {
        const existing = await client.query(
          `SELECT movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                  performed_by_user_id, notes, created_at, idempotency_key
           FROM stock_movements
           WHERE idempotency_key = $1 AND movement_type = 'RECEIPT'
           LIMIT 1`,
          [idempotencyKey],
        );
        // Re-lock the batch to get the current quantity after the other transaction committed
        const relocked = await client.query(
          `SELECT b.quantity_on_hand
           FROM inventory_batches b
           JOIN inventory_items i ON i.inventory_id = b.inventory_id
           WHERE b.batch_id = $1 AND i.deleted_at IS NULL${lockScope.clause}`,
          lockScope.params,
        );
        await client.query('ROLLBACK');
        if (existing.rows.length > 0) {
          const existingMovement = existing.rows[0];
          // Verify this is the same operation (same batch, quantity, reference)
          if (Number(existingMovement.batch_id) !== body.batch_id ||
              Number(existingMovement.quantity) !== body.quantity ||
              (existingMovement.reference_type ?? null) !== (body.reference_type ?? null) ||
              (existingMovement.reference_id ?? null) !== (body.reference_id ?? null)) {
            return res.status(409).json({
              message: 'مفتاح التكرار مستخدم لعملية استلام مختلفة',
              code: ApiErrorCode.FORBIDDEN,
            });
          }
          return res.status(200).json({
            message: 'سبق تسجيل هذه الحركة بنفس مفتاح التكرار',
            idempotent_replay: true,
            movement: existingMovement,
            quantityOnHand: relocked.rows.length > 0 ? Number(relocked.rows[0].quantity_on_hand) : nextQuantity,
          });
        }
      }
      throw insertError;
    }

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
