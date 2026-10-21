import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  batchCreateSchema,
  batchUpdateSchema,
  isReservedWithinOnHand,
  expiryListQuerySchema,
  DEFAULT_EXPIRY_LIMIT,
  batchListQuerySchema,
  DEFAULT_BATCH_LIMIT,
  MAX_BATCH_LIMIT,
  batchReceiveSchema,
  FORBIDDEN_RECEIVE_FIELDS,
  type BatchReceiveInput,
} from '../../validations/batch.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';
import { isStockIncreasing } from '../../validations/stockMovement.validation';

/* ==========================================================================
 * Phase 10B.2C — Inventory Batches backend
 *
 * الدفعة تنتمي للعيادة عبر صنف المخزون (inventory_items.clinic_id) — لا يوجد
 * clinic_id في الجدول، لذلك كل استعلام ينضم إلى inventory_items لفرض النطاق.
 * الاعتماد على batch_id وحده ممنوع.
 *
 * quantities لا تُعدَّل عبر هذا الملف إطلاقاً: الاستلام يضبط الكمية الابتدائية
 * فقط، وكل تغيير بعده يكون بحركة مخزون (Phase 10B.3).
 * ========================================================================== */

const BATCH_RETURNING = `b.batch_id, b.inventory_id, b.supplier_id, b.lot_number, b.expiry_date,
       b.quantity_on_hand, b.quantity_reserved, b.unit_cost, b.received_at, b.is_active,
       b.created_at, b.updated_at`;

// نفس الأعمدة بلا بادئة "b." — تلزم في INSERT لأن INSERT لا يعرّف جدولاً مستعاراً،
// فبادئة "b" تجعله يفشل بـ 42P01 (missing FROM-clause entry for table "b").
// UPDATE/SELECT تحتفظ بالبادئة لأن كليهما يعرّف "b" فعلاً.
const BATCH_RETURNING_UNQUALIFIED = BATCH_RETURNING.replace(/\bb\./g, '');

const BATCH_FROM = `FROM inventory_batches b
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     LEFT JOIN suppliers s ON s.supplier_id = b.supplier_id`;

const BATCH_COLUMNS = `${BATCH_RETURNING}, i.clinic_id, s.name AS supplier_name`;

// نفس حد inventory_batches.quantity_on_hand (NUMERIC 12,3)
const MAX_STOCK_QUANTITY = 999_999_999.999;

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// خطأ موحّد للسجل غير الموجود وللخارج عن نطاق عيادات المستخدم (لا يُكشف وجوده)
const batchNotFound = (res: Response) =>
  res.status(404).json({ message: 'الدفعة المطلوبة غير موجودة' });

const inventoryItemNotFound = (res: Response) =>
  res.status(404).json({ message: 'صنف المخزون المطلوب غير موجود' });

const duplicateLot = (res: Response) =>
  res.status(409).json({
    message: 'يوجد بالفعل رقم تشغيلة مطابق لهذا الصنف',
    code: ApiErrorCode.FORBIDDEN,
  });

// ترجمة أخطاء قيود قاعدة البيانات إلى استجابة واضحة — لا تُتجاوز القيود ولا تُكتم
const respondToWriteError = (
  res: Response,
  error: any,
  logLabel: string,
  onConflict: (target: Response) => unknown,
): unknown => {
  if (error?.code === '23505') return onConflict(res);
  if (error?.code === '23514') {
    return res.status(409).json({
      message: 'البيانات تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
      code: ApiErrorCode.FORBIDDEN,
    });
  }
  if (error?.code === '23503') {
    return validationError(res, 'أحد المراجع المرتبطة (صنف المخزون أو المورد) غير موجود');
  }
  if (error?.code === '23502') {
    return validationError(res, 'حقل مطلوب مفقود');
  }
  console.error(logLabel, error);
  return res.status(500).json({
    message: 'حدث خطأ في الخادم أثناء تنفيذ العملية',
    code: ApiErrorCode.INTERNAL_ERROR,
  });
};

/** صنف مخزون نشط ضمن نطاق عيادات المستخدم — null إذا لم يوجد أو خارج النطاق. */
const loadAccessibleInventoryItem = async (
  req: AuthenticatedRequest,
  inventoryId: number,
): Promise<{ inventoryId: number; clinicId: number } | null> => {
  const scope = buildClinicScope(req, [inventoryId], 'i.clinic_id');
  const result = await pool.query(
    `SELECT i.inventory_id, i.clinic_id FROM inventory_items i
     WHERE i.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
    scope.params,
  );
  if (result.rows.length === 0) return null;
  return { inventoryId: Number(result.rows[0].inventory_id), clinicId: Number(result.rows[0].clinic_id) };
};

/** المورد يجب أن ينتمي لنفس عيادة صنف المخزون — غير النشط مسموح (مرجع تاريخي). */
const isSupplierInClinic = async (supplierId: number, clinicId: number): Promise<boolean> => {
  const result = await pool.query('SELECT clinic_id FROM suppliers WHERE supplier_id = $1', [supplierId]);
  return result.rows.length > 0 && Number(result.rows[0].clinic_id) === clinicId;
};

// uq_inventory_batches_inventory_lot فهرس فريد على كل الصفوف — الدفعة غير النشطة تحجز رقمها أيضاً
const hasBatchWithLot = async (
  inventoryId: number,
  lotNumber: string,
  excludeBatchId?: number,
): Promise<boolean> => {
  const result = await pool.query(
    `SELECT batch_id FROM inventory_batches
     WHERE inventory_id = $1 AND lot_number = $2
       AND ($3::int IS NULL OR batch_id <> $3::int)`,
    [inventoryId, lotNumber, excludeBatchId ?? null],
  );
  return result.rows.length > 0;
};

// 1. دفعات صنف مخزون واحد — inventory_id إلزامي (يمنع مسح كل عيادات المستخدم)
export const listBatches = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = batchListQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تصفية الدفعات غير صالحة');
  const query = parsed.data;

  const inventoryId = query.inventory_id;
  const supplierId = query.supplier_id;
  const lotNumber = query.lot_number;
  const receivedFrom = query.received_from;
  const receivedTo = query.received_to;

  const limit = query.limit ?? DEFAULT_BATCH_LIMIT;
  const offset = query.offset ?? 0;

  try {
    const scope = buildClinicScope(req, [inventoryId], 'i.clinic_id');

    // Build filter clauses
    let filterClause = '';
    const scopeParamCount = scope.params.length;
    const params: unknown[] = [...scope.params];

    if (supplierId !== undefined) {
      params.push(supplierId);
      filterClause += ` AND b.supplier_id = $${params.length}`;
    }

    if (lotNumber !== undefined && lotNumber.trim() !== '') {
      params.push(`%${lotNumber.trim()}%`);
      filterClause += ` AND b.lot_number ILIKE $${params.length}`;
    }

    if (receivedFrom !== undefined) {
      params.push(receivedFrom);
      filterClause += ` AND b.received_at >= $${params.length}`;
    }

    if (receivedTo !== undefined) {
      // For inclusive end date, add 1 day to capture the full day
      const toDate = new Date(receivedTo);
      toDate.setDate(toDate.getDate() + 1);
      params.push(toDate);
      filterClause += ` AND b.received_at < $${params.length}`;
    }

    // Count total matching rows
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total ${BATCH_FROM}
       WHERE b.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}${filterClause}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Fetch paginated page
    const nextPlaceholder = params.length + 1;
    const result = await pool.query(
      `SELECT ${BATCH_COLUMNS} ${BATCH_FROM}
       WHERE b.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}${filterClause}
       ORDER BY b.is_active ASC, b.expiry_date ASC, b.batch_id ASC
       LIMIT $${nextPlaceholder} OFFSET $${nextPlaceholder + 1}`,
      [...params, limit, offset],
    );

    return res.status(200).json({
      batches: result.rows,
      pagination: { limit, offset, returned: result.rows.length, total },
    });
  } catch (error) {
    console.error('List Batches Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب دفعات المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 2. تفاصيل دفعة — النطاق مطبَّق عبر صنف المخزون لا عبر batch_id وحده
export const getBatch = async (req: AuthenticatedRequest, res: Response) => {
  const batchId = parsePositiveId(req.params.id);
  if (batchId === null) return validationError(res, 'معرّف الدفعة غير صالح');

  try {
    const scope = buildClinicScope(req, [batchId], 'i.clinic_id');
    const result = await pool.query(
      `SELECT ${BATCH_COLUMNS} ${BATCH_FROM}
       WHERE b.batch_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
      scope.params,
    );

    if (result.rows.length === 0) return batchNotFound(res);
    return res.status(200).json({ batch: result.rows[0] });
  } catch (error) {
    console.error('Get Batch Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب الدفعة',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 2b. حالة توفّر دفعة (Phase 10B.4A) — قراءة فقط، لا تلمس أي كمية
// ملاحظة: صنف المخزون المؤرشف لا يُستبعد هنا — يُعاد كدفعة غير مؤهلة مع
// available_for_fefo = FALSE، ليعرف العميل سبب عدم الأهلية.
export const getBatchAvailability = async (req: AuthenticatedRequest, res: Response) => {
  const batchId = parsePositiveId(req.params.id);
  if (batchId === null) return validationError(res, 'معرّف الدفعة غير صالح');

  try {
    const scope = buildClinicScope(req, [batchId], 'i.clinic_id');
    const result = await pool.query(
      `SELECT b.batch_id, b.inventory_id, b.lot_number, b.expiry_date, b.quantity_on_hand, b.is_active,
              (b.expiry_date < CURRENT_DATE) AS expired,
              (b.is_active AND i.deleted_at IS NULL AND b.quantity_on_hand > 0 AND b.expiry_date >= CURRENT_DATE
               AND NOT EXISTS (SELECT 1 FROM batch_quarantines bq
                               WHERE bq.batch_id = b.batch_id AND bq.released_at IS NULL)) AS available_for_fefo
       FROM inventory_batches b
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE b.batch_id = $1${scope.clause}`,
      scope.params,
    );

    if (result.rows.length === 0) return batchNotFound(res);

    // الحد الأدنى المطلوب فقط — لا تُعاد حقول إضافية
    const row = result.rows[0];
    return res.status(200).json({
      availability: {
        batch_id: row.batch_id,
        inventory_id: row.inventory_id,
        lot_number: row.lot_number,
        expiry_date: row.expiry_date,
        quantity_on_hand: row.quantity_on_hand,
        is_active: row.is_active,
        expired: row.expired,
        available_for_fefo: row.available_for_fefo,
      },
    });
  } catch (error) {
    console.error('Get Batch Availability Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب حالة توفّر الدفعة',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 1b. قراءة الدفعات حسب حالة الانتهاء (Phase 10B.4B-1) — قراءة فقط
// عرض تدقيق: لا يُشترط أن تكون الدفعة نشطة أو ذات رصيد، ولا يُنشأ أي منحنى تلقائي.
// المقصود رؤية ما ينتهي ومتى، لا تطبيق أي معالجة.
export const listBatchesByExpiry = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = expiryListQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تصفية انتهاء صلاحية الدفعات غير صالحة');
  const query = parsed.data;

  const limit = query.limit ?? DEFAULT_EXPIRY_LIMIT;
  const offset = query.offset ?? 0;

  const params: unknown[] = [];
  let statusClause: string;
  if (query.status === 'expired') {
    statusClause = 'b.expiry_date < CURRENT_DATE';
  } else {
    params.push(query.days);
    statusClause = `b.expiry_date >= CURRENT_DATE AND b.expiry_date <= CURRENT_DATE + $${params.length}::int`;
  }

  try {
    const scope = buildClinicScope(req, params, 'i.clinic_id');
    const nextPlaceholder = scope.params.length + 1;

    // Count total matching rows
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM inventory_batches b
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE i.deleted_at IS NULL
         AND ${statusClause}${scope.clause}`,
      scope.params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Fetch paginated page
    const result = await pool.query(
      `SELECT b.batch_id, b.inventory_id, b.lot_number, b.expiry_date,
              b.quantity_on_hand, b.quantity_reserved, b.is_active
       FROM inventory_batches b
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE i.deleted_at IS NULL
         AND ${statusClause}${scope.clause}
       ORDER BY b.expiry_date ASC, b.batch_id ASC
       LIMIT $${nextPlaceholder} OFFSET $${nextPlaceholder + 1}`,
      [...scope.params, limit, offset],
    );

    return res.status(200).json({
      batches: result.rows,
      pagination: { limit, offset, returned: result.rows.length, total },
    });
  } catch (error) {
    console.error('List Batches By Expiry Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب دفعات الانتهاء',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 3. استلام دفعة جديدة — يضبط الكمية الابتدائية فقط
export const createBatch = async (req: AuthenticatedRequest, res: Response) => {
  const rawBody = (req.body ?? {}) as Record<string, unknown>;

  // أي حقل يُشتق على الخادم في الجسم = تزوير، ويُرفض قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_RECEIVE_FIELDS.find((field) => rawBody[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب الدفعة — هذه القيم تُشتق على الخادم`);
  }

  const parsed = batchCreateSchema.safeParse(rawBody);
  if (!parsed.success) return validationError(res, 'بيانات الدفعة غير صالحة');
  const body = parsed.data;

  if (!isReservedWithinOnHand(body.quantity_reserved, body.quantity_on_hand)) {
    return validationError(res, 'الكمية المحجوزة لا يمكن أن تتجاوز الكمية المتاحة');
  }

  try {
    const item = await loadAccessibleInventoryItem(req, body.inventory_id);
    if (item === null) return inventoryItemNotFound(res);

    if (body.supplier_id !== null && !(await isSupplierInClinic(body.supplier_id, item.clinicId))) {
      return validationError(res, 'المورد المحدد غير صالح لهذه العيادة');
    }

    if (await hasBatchWithLot(body.inventory_id, body.lot_number)) return duplicateLot(res);

    const result = await pool.query(
      `INSERT INTO inventory_batches
         (inventory_id, supplier_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${BATCH_RETURNING_UNQUALIFIED}`,
      [
        body.inventory_id,
        body.supplier_id,
        body.lot_number,
        body.expiry_date,
        body.quantity_on_hand,
        body.quantity_reserved,
        body.unit_cost,
      ],
    );

    return res.status(201).json({
      message: 'تم استلام الدفعة بنجاح',
      batch: result.rows[0],
    });
  } catch (error) {
    return respondToWriteError(res, error, 'Create Batch Error:', duplicateLot);
  }
};

/* ==========================================================================
 * Phase 4B.3 — مساعدات تكرار الاستلام الذري
 *
 * مفتاح التكرار فريد عالمياً لعمليات RECEIPT (migration 051)، فالمقارنة
 * تقتصر على الحقول الثابتة التي تُعرّف عملية الاستلام. received_at ليس
 * منها: يولّده الخادم (migration 029) ولا يُقارن ولا يُخزَّن كنية
 * عميل — عمود original_received_at (migration 052) أثر قديم لم يعد
 * يُكتب، وقيمته NULL تعني مصدراً غير معروف.
 * ========================================================================== */

// الحركة المسجلة بنفس المفتاح مع كل بيانات دفعتها — تُستخدم للرد بالتكرار
const RECEIPT_BY_KEY_SQL = `SELECT sm.movement_id, sm.batch_id, sm.movement_type, sm.quantity,
       sm.reference_type, sm.reference_id, sm.performed_by_user_id, sm.notes,
       sm.created_at AS movement_created_at, sm.idempotency_key,
       b.inventory_id, b.supplier_id, b.lot_number, b.expiry_date, b.quantity_on_hand,
       b.quantity_reserved, b.unit_cost, b.received_at, b.is_active,
       b.created_at AS batch_created_at, b.updated_at
FROM stock_movements sm
JOIN inventory_batches b ON b.batch_id = sm.batch_id
WHERE sm.idempotency_key = $1 AND sm.movement_type = 'RECEIPT'
LIMIT 1`;

/**
 * الحقول الثابتة التي تُعرّف عملية الاستلام. quantity_on_hand قيمة ابتدائية
 * تتغير بعد الاستلام فلا تُقارن، ولا تُقارن أي نية زمنية — received_at
 * يولّده الخادم دائماً.
 */
const isSameReceiptOperation = (
  existing: Record<string, unknown>,
  body: BatchReceiveInput,
  receiptQuantity: number,
): boolean => {
  if (Number(existing.inventory_id) !== body.inventory_id) return false;
  if (String(existing.lot_number) !== body.lot_number.trim()) return false;
  if (String(existing.expiry_date) !== body.expiry_date) return false;
  if (Number(existing.quantity_reserved) !== body.quantity_reserved) return false;
  const existingUnitCost = existing.unit_cost === null ? null : Number(existing.unit_cost);
  const incomingUnitCost = body.unit_cost === null || body.unit_cost === undefined ? null : Number(body.unit_cost);
  if (existingUnitCost !== incomingUnitCost) return false;
  const existingSupplierId = existing.supplier_id === null ? null : Number(existing.supplier_id);
  if (existingSupplierId !== (body.supplier_id ?? null)) return false;
  if (Number(existing.batch_id) !== Number(existing.reference_id)) return false; // reference_id = batch_id
  if (Number(existing.quantity) !== receiptQuantity) return false;
  if ((existing.reference_type ?? null) !== (body.reference_type ?? null)) return false;
  if ((existing.reference_id ?? null) !== (body.reference_id ?? String(existing.batch_id))) return false;
  return true;
};

/** استجابة التكرار الموحّدة — نفس العملية تُعيد النتيجة المسجلة سلفاً. */
const receiptReplayPayload = (existing: Record<string, unknown>) => ({
  message: 'سبق تسجيل هذه العملية بنفس مفتاح التكرار',
  idempotent_replay: true,
  batch: {
    batch_id: existing.batch_id,
    inventory_id: existing.inventory_id,
    supplier_id: existing.supplier_id,
    lot_number: existing.lot_number,
    expiry_date: existing.expiry_date,
    quantity_on_hand: existing.quantity_on_hand,
    quantity_reserved: existing.quantity_reserved,
    unit_cost: existing.unit_cost,
    received_at: existing.received_at,
    is_active: existing.is_active,
    created_at: existing.batch_created_at,
    updated_at: existing.updated_at,
  },
  movement: {
    movement_id: existing.movement_id,
    batch_id: existing.batch_id,
    movement_type: existing.movement_type,
    quantity: existing.quantity,
    reference_type: existing.reference_type,
    reference_id: existing.reference_id,
    performed_by_user_id: existing.performed_by_user_id,
    notes: existing.notes,
    created_at: existing.movement_created_at,
    idempotency_key: existing.idempotency_key,
  },
  quantityOnHand: Number(existing.quantity_on_hand),
});

/**
 * يبحث عن حركة استلام بنفس المفتاح ويرد بها: نفس العملية → 200 تكرار،
 * عملية مختلفة → 409. يُرجع null عندما لا يوجد سجل ليكمل المسار العادي.
 * يُنهي المعاملة عند الرد. يُستدعى داخل معاملة سليمة.
 */
const respondIdempotentReceipt = async (
  client: PoolClient,
  res: Response,
  idempotencyKey: string,
  body: BatchReceiveInput,
  receiptQuantity: number,
): Promise<unknown> => {
  const existing = await client.query(RECEIPT_BY_KEY_SQL, [idempotencyKey]);
  if (existing.rows.length === 0) return null;
  const existingMovement = existing.rows[0];
  await client.query('ROLLBACK');
  if (!isSameReceiptOperation(existingMovement, body, receiptQuantity)) {
    return res.status(409).json({
      message: 'مفتاح التكرار مستخدم لعملية استلام مختلفة',
      code: ApiErrorCode.FORBIDDEN,
    });
  }
  return res.status(200).json(receiptReplayPayload(existingMovement));
};

// 3b. استلام ذري: إنشاء دفعة + حركة استلام في معاملة واحدة (Phase 4B.3)
// تضمن عدم بقاء دفعات برصيد صفري إذا فشلت حركة الاستلام.
// تدعم مفتاح التكرار (idempotency_key) لضمان عدم تكرار الاستلام:
// الفهرس الفريد الجزئي (migration 051) هو الضمان الحقيقي تحت التزامن،
// وتصادمه — في إنشاء الدفعة أو الحركة — يُلتقط بنقطة حفظ ويُقرأ
// كتكرار لا كخطأ خادم. received_at للدفعة يولّده الخادم
// (DEFAULT CURRENT_TIMESTAMP في migration 029) ولا يُقبل من العميل.
export const createBatchWithReceipt = async (req: AuthenticatedRequest, res: Response) => {
  const rawBody = (req.body ?? {}) as Record<string, unknown>;

  // أي حقل يُشتق على الخادم في الجسم = تزوير، ويُرفض قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_RECEIVE_FIELDS.find((field) => rawBody[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب الاستلام — هذه القيم تُشتق على الخادم`);
  }

  const parsed = batchReceiveSchema.safeParse(rawBody);
  if (!parsed.success) return validationError(res, 'بيانات الاستلام غير صالحة');
  const body = parsed.data as BatchReceiveInput;

  if (!isReservedWithinOnHand(body.quantity_reserved, body.quantity_on_hand)) {
    return validationError(res, 'الكمية المحجوزة لا يمكن أن تتجاوز الكمية المتاحة');
  }

  const performedByUserId = req.user?.userId ?? null;
  const idempotencyKey = body.idempotency_key ?? null;
  const receiptQuantity = body.receipt_quantity;

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) تحقق من صنف المخزون والنطاق
    const item = await loadAccessibleInventoryItem(req, body.inventory_id);
    if (item === null) {
      await client.query('ROLLBACK');
      return inventoryItemNotFound(res);
    }

    if (body.supplier_id !== null && !(await isSupplierInClinic(body.supplier_id, item.clinicId))) {
      await client.query('ROLLBACK');
      return validationError(res, 'المورد المحدد غير صالح لهذه العيادة');
    }

    // 2) فحص مفتاح التكرار المبكر — قبل أي فحص عمل أو إنشاء
    // الفهرس الفريد على stock_movements(idempotency_key) WHERE movement_type='RECEIPT'
    // يضمن عدم تكرار المفتاح عبر جميع الدفعات.
    if (idempotencyKey !== null) {
      const replay = await respondIdempotentReceipt(client, res, idempotencyKey, body, receiptQuantity);
      if (replay !== null) return replay;
    }

    // 3) فحص تكرار رقم التشغيلة
    if (await hasBatchWithLot(body.inventory_id, body.lot_number)) {
      // الدفعة موجودة سلفاً: إن كانت العملية بنفس مفتاح التكرار
      // (طلب متزامن التزم أولاً) فهي إعادة طلب لا تضارب.
      if (idempotencyKey !== null) {
        const replay = await respondIdempotentReceipt(client, res, idempotencyKey, body, receiptQuantity);
        if (replay !== null) return replay;
      }
      await client.query('ROLLBACK');
      return duplicateLot(res);
    }

    // 4) إنشاء الدفعة برصيد صفري تحت نقطة حفظ.
    // received_at لا يُرسَل أصلاً — يولّده الخادم عبر DEFAULT CURRENT_TIMESTAMP.
    // تصادم رقم التشغيلة مع طلب متزامن بنفس المفتاح (23505) يُقرأ كتكرار.
    let batch: Record<string, unknown>;
    try {
      await client.query('SAVEPOINT insert_batch');
      const batchResult = await client.query(
        `INSERT INTO inventory_batches
           (inventory_id, supplier_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${BATCH_RETURNING_UNQUALIFIED}`,
        [
          body.inventory_id,
          body.supplier_id,
          body.lot_number,
          body.expiry_date,
          body.quantity_on_hand, // 0
          body.quantity_reserved, // 0
          body.unit_cost,
        ],
      );
      await client.query('RELEASE SAVEPOINT insert_batch');
      batch = batchResult.rows[0];
    } catch (batchError: any) {
      await client.query('ROLLBACK TO SAVEPOINT insert_batch');
      if (batchError?.code === '23505' && idempotencyKey !== null) {
        // طلب متزامن أنشأ الدفعة بنفس رقم التشغيلة — يُقرأ كتكرار إن تطابقت العملية
        const replay = await respondIdempotentReceipt(client, res, idempotencyKey, body, receiptQuantity);
        if (replay !== null) return replay;
      }
      throw batchError;
    }

    const batchId = Number(batch.batch_id);

    // 5) تحديث كمية الدفعة بالكمية المستلمة
    const nextQuantity = body.quantity_on_hand + receiptQuantity; // 0 + receiptQuantity
    if (nextQuantity > MAX_STOCK_QUANTITY) {
      await client.query('ROLLBACK');
      return validationError(res, 'الرصيد الناتج يتجاوز الحد الأقصى المسموح للمخزون');
    }

    const updateScope = buildClinicScope(req, [nextQuantity, batchId], 'i.clinic_id');
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

    // 6) إدراج حركة الاستلام تحت نقطة حفظ (savepoint)
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
          batchId,
          'RECEIPT',
          receiptQuantity,
          body.reference_type ?? null,
          body.reference_id ?? String(batchId),
          performedByUserId,
          body.notes ?? null,
          idempotencyKey,
        ],
      );
      await client.query('RELEASE SAVEPOINT insert_movement');
    } catch (insertError: any) {
      await client.query('ROLLBACK TO SAVEPOINT insert_movement');
      if (insertError?.code === '23505' && idempotencyKey !== null) {
        // تضارب الفهرس الفريد — معاملة متزامنة أنشأت الحركة بنفس المفتاح
        const replay = await respondIdempotentReceipt(client, res, idempotencyKey, body, receiptQuantity);
        if (replay !== null) return replay;
      }
      throw insertError;
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'تم استلام الدفعة بنجاح',
      batch: batch,
      movement: inserted.rows[0],
      quantityOnHand: nextQuantity,
    });
  } catch (error: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // تجاهل خطأ التراجع
      }
    }
    if (error?.code === '23503') return validationError(res, 'صنف المخزون أو المورد المحدد غير موجود');
    if (error?.code === '23505') return duplicateLot(res);
    if (error?.code === '23514') {
      return res.status(409).json({
        message: 'البيانات تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Create Batch With Receipt Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء استلام الدفعة',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};

// 4. تحديث البيانات الوصفية فقط — الكميات ممنوعة صراحةً في هذا المسار
export const updateBatch = async (req: AuthenticatedRequest, res: Response) => {
  const batchId = parsePositiveId(req.params.id);
  if (batchId === null) return validationError(res, 'معرّف الدفعة غير صالح');

  // حارس صريح قبل أي وصول لقاعدة البيانات: تعديل الكميات عبر هذا المسار مرفوض
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.quantity_on_hand !== undefined || body.quantity_reserved !== undefined) {
    return validationError(
      res,
      'لا يمكن تعديل كميات المخزون عبر هذا المسار — تعديل الكميات يتم عبر حركات المخزون',
    );
  }

  // أي حقل يُشتق على الخادم في الجسم = تزوير، ويُرفض قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_RECEIVE_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب تحديث الدفعة — هذه القيم تُشتق على الخادم`);
  }

  const parsed = batchUpdateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات تحديث الدفعة غير صالحة');
  const update = parsed.data;

  try {
    const scope = buildClinicScope(req, [batchId], 'i.clinic_id');
    const existing = await pool.query(
      `SELECT ${BATCH_RETURNING}, i.clinic_id AS item_clinic_id
       ${BATCH_FROM}
       WHERE b.batch_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
      scope.params,
    );
    if (existing.rows.length === 0) return batchNotFound(res);

    const current = existing.rows[0];
    const inventoryId = Number(current.inventory_id);
    const itemClinicId = Number(current.item_clinic_id);
    const currentSupplierId = current.supplier_id === null ? null : Number(current.supplier_id);

    if (update.inventory_id !== undefined && update.inventory_id !== inventoryId) {
      return validationError(res, 'لا يمكن نقل الدفعة إلى صنف مخزون آخر');
    }

    if (update.supplier_id !== undefined && update.supplier_id !== currentSupplierId) {
      if (update.supplier_id !== null && !(await isSupplierInClinic(update.supplier_id, itemClinicId))) {
        return validationError(res, 'المورد المحدد غير صالح لهذه العيادة');
      }
    }

    // فحص التكرار فقط عند تغيّر رقم التشغيلة فعلاً — وإلا طالَبت الدفعة نفسها
    if (update.lot_number !== undefined && update.lot_number !== current.lot_number) {
      if (await hasBatchWithLot(inventoryId, update.lot_number, batchId)) return duplicateLot(res);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (update.supplier_id !== undefined) assign('supplier_id', update.supplier_id);
    if (update.lot_number !== undefined) assign('lot_number', update.lot_number);
    if (update.expiry_date !== undefined) assign('expiry_date', update.expiry_date);
    if (update.unit_cost !== undefined) assign('unit_cost', update.unit_cost);
    if (update.is_active !== undefined) assign('is_active', update.is_active);

    if (sets.length === 0) {
      return validationError(res, 'لا توجد حقول قابلة للتحديث');
    }

    values.push(batchId);
    const updateScope = buildClinicScope(req, values, 'i.clinic_id');
    const result = await pool.query(
      `UPDATE inventory_batches b SET ${sets.join(', ')}, updated_at = NOW()
       FROM inventory_items i
       WHERE b.inventory_id = i.inventory_id
         AND b.batch_id = $${values.length}
         AND i.deleted_at IS NULL${updateScope.clause}
       RETURNING ${BATCH_RETURNING}`,
      updateScope.params,
    );

    if (result.rows.length === 0) return batchNotFound(res);
    return res.status(200).json({
      message: 'تم تحديث بيانات الدفعة بنجاح',
      batch: result.rows[0],
    });
  } catch (error) {
    return respondToWriteError(res, error, 'Update Batch Error:', duplicateLot);
  }
};

// 5. إلغاء تنشيط الدفعة — is_active = FALSE فقط، لا حذف (الحركات والسجل يبقان)
export const deactivateBatch = async (req: AuthenticatedRequest, res: Response) => {
  const batchId = parsePositiveId(req.params.id);
  if (batchId === null) return validationError(res, 'معرّف الدفعة غير صالح');

  try {
    const scope = buildClinicScope(req, [batchId], 'i.clinic_id');
    const result = await pool.query(
      `UPDATE inventory_batches b SET is_active = FALSE, updated_at = NOW()
       FROM inventory_items i
       WHERE b.inventory_id = i.inventory_id
         AND b.batch_id = $1
         AND i.deleted_at IS NULL${scope.clause}
       RETURNING ${BATCH_RETURNING}`,
      scope.params,
    );

    if (result.rows.length === 0) return batchNotFound(res);
    return res.status(200).json({
      message: 'تم إلغاء تنشيط الدفعة',
      batch: result.rows[0],
    });
  } catch (error) {
    return respondToWriteError(res, error, 'Deactivate Batch Error:', duplicateLot);
  }
};
