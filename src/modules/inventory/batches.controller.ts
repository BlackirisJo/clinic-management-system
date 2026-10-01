import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { batchCreateSchema, batchUpdateSchema, isReservedWithinOnHand, expiryListQuerySchema, DEFAULT_EXPIRY_LIMIT } from '../../validations/batch.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';

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
  const rawInventoryId = req.query.inventory_id;
  if (rawInventoryId === undefined) {
    return validationError(res, 'inventory_id مطلوب لعرض دفعات صنف المخزون');
  }
  const inventoryId = parsePositiveId(rawInventoryId);
  if (inventoryId === null) return validationError(res, 'معرّف صنف المخزون غير صالح');

  try {
    const scope = buildClinicScope(req, [inventoryId], 'i.clinic_id');
    const result = await pool.query(
      `SELECT ${BATCH_COLUMNS} ${BATCH_FROM}
       WHERE b.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}
       ORDER BY b.is_active ASC, b.expiry_date ASC, b.batch_id ASC`,
      scope.params,
    );

    return res.status(200).json({ batches: result.rows });
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
      pagination: { limit, offset, returned: result.rows.length },
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
  const parsed = batchCreateSchema.safeParse(req.body ?? {});
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
         (inventory_id, supplier_id, lot_number, expiry_date, quantity_on_hand, quantity_reserved, unit_cost, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
       RETURNING ${BATCH_RETURNING_UNQUALIFIED}`,
      [
        body.inventory_id,
        body.supplier_id,
        body.lot_number,
        body.expiry_date,
        body.quantity_on_hand,
        body.quantity_reserved,
        body.unit_cost,
        body.received_at ?? null,
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
    if (update.received_at !== undefined) assign('received_at', update.received_at);
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
