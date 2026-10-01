import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import {
  AuthenticatedRequest,
  accessibleClinicIds,
  canManageAllClinics,
} from '../../middlewares/auth.middleware';
import {
  inventoryItemCreateSchema,
  inventoryItemUpdateSchema,
  isMaxStockWithinReorderPoint,
} from '../../validations/inventory.validation';
import { buildClinicScope, isClinicAccessible, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10B.2A — Inventory Items backend
 * Clinic-scoped stock definitions. DELETE archives (deleted_at) only —
 * historical batches/movements are never physically removed.
 * ========================================================================== */

const ITEM_COLUMNS = `i.inventory_id, i.clinic_id, i.medication_id, i.uom, i.min_stock, i.reorder_point,
       i.max_stock, i.created_at, i.updated_at,
       m.trade_name, m.scientific_name, m.strength, m.dosage_form,
       c.clinic_name`;

const ITEM_FROM = `FROM inventory_items i
     JOIN medications m ON m.medication_id = i.medication_id
     JOIN clinics c ON c.clinic_id = i.clinic_id`;

const RETURNING_COLUMNS = `inventory_id, clinic_id, medication_id, uom, min_stock, reorder_point, max_stock, created_at, updated_at`;

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// خطأ موحّد للسجل غير الموجود وللسجل الخارج عن نطاق عيادات المستخدم (لا يُكشف وجوده)
const itemNotFound = (res: Response) =>
  res.status(404).json({ message: 'صنف المخزون المطلوب غير موجود' });

const duplicateItem = (res: Response) =>
  res.status(409).json({
    message: 'يوجد صنف مخزون نشط لهذا الدواء في نفس العيادة',
    code: ApiErrorCode.FORBIDDEN,
  });

const parseInventoryId = (raw: unknown): number | null => parsePositiveId(raw);

const medicationExists = async (medicationId: number): Promise<boolean> => {
  const result = await pool.query('SELECT medication_id FROM medications WHERE medication_id = $1', [medicationId]);
  return result.rows.length > 0;
};

const hasActiveItemForMedication = async (
  clinicId: number,
  medicationId: number,
  excludeInventoryId?: number,
): Promise<boolean> => {
  const result = await pool.query(
    `SELECT inventory_id FROM inventory_items
     WHERE clinic_id = $1 AND medication_id = $2 AND deleted_at IS NULL
       AND ($3::int IS NULL OR inventory_id <> $3::int)`,
    [clinicId, medicationId, excludeInventoryId ?? null],
  );
  return result.rows.length > 0;
};

// 1. قائمة أصناف المخزون النشطة ضمن عيادات المستخدم فقط
export const listInventoryItems = async (req: AuthenticatedRequest, res: Response) => {
  const requestedClinicId = req.query.clinic_id;
  let baseParams: unknown[] = [];
  let requestedClause = '';

  if (requestedClinicId !== undefined) {
    const clinicId = Number(requestedClinicId);
    if (!Number.isInteger(clinicId) || clinicId <= 0) {
      return validationError(res, 'معرّف العيادة غير صالح');
    }
    if (!isClinicAccessible(req, clinicId)) return itemNotFound(res);
    baseParams = [clinicId];
    requestedClause = ' AND i.clinic_id = $1';
  }

  try {
    const scope = buildClinicScope(req, baseParams);
    const result = await pool.query(
      `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
       WHERE i.deleted_at IS NULL${requestedClause}${scope.clause}
       ORDER BY m.trade_name ASC, i.inventory_id ASC`,
      scope.params,
    );

    return res.status(200).json({ inventoryItems: result.rows });
  } catch (error) {
    console.error('List Inventory Items Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب أصناف المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 2. تفاصيل صنف واحد — السجل المؤرشف أو خارج نطاق المستخدم = 404
export const getInventoryItem = async (req: AuthenticatedRequest, res: Response) => {
  const inventoryId = parseInventoryId(req.params.id);
  if (inventoryId === null) return validationError(res, 'معرّف صنف المخزون غير صالح');

  try {
    const scope = buildClinicScope(req, [inventoryId]);
    const result = await pool.query(
      `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
       WHERE i.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
      scope.params,
    );

    if (result.rows.length === 0) return itemNotFound(res);
    return res.status(200).json({ inventoryItem: result.rows[0] });
  } catch (error) {
    console.error('Get Inventory Item Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب صنف المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 3. إنشاء صنف مخزون لعيادة ضمن نطاق المستخدم
export const createInventoryItem = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = inventoryItemCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, 'بيانات صنف المخزون غير صالحة');
  const body = parsed.data;

  // clinic_id من الـ body لا يتجاوز نطاق عيادات المستخدم أبداً
  if (!isClinicAccessible(req, body.clinic_id)) {
    return res.status(403).json({
      message: 'لا تملك صلاحية إدارة مخزون هذه العيادة',
      code: ApiErrorCode.FORBIDDEN,
    });
  }

  if (!isMaxStockWithinReorderPoint(body.max_stock, body.reorder_point)) {
    return validationError(res, 'الحد الأقصى للمخزون يجب أن يكون فارغاً أو أكبر من أو يساوي نقطة إعادة الطلب');
  }

  try {
    if (!(await medicationExists(body.medication_id))) {
      return validationError(res, 'الدواء المحدد غير موجود في دليل الأدوية');
    }

    if (await hasActiveItemForMedication(body.clinic_id, body.medication_id)) {
      return duplicateItem(res);
    }

    const result = await pool.query(
      `INSERT INTO inventory_items (clinic_id, medication_id, uom, min_stock, reorder_point, max_stock)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${RETURNING_COLUMNS}`,
      [body.clinic_id, body.medication_id, body.uom, body.min_stock, body.reorder_point, body.max_stock],
    );

    return res.status(201).json({
      message: 'تم إضافة صنف المخزون بنجاح',
      inventoryItem: result.rows[0],
    });
  } catch (error: any) {
    // uq_inventory_items_clinic_medication (جزئي على deleted_at IS NULL)
    if (error?.code === '23505') return duplicateItem(res);
    if (error?.code === '23503') return validationError(res, 'العيادة أو الدواء المحدد غير موجود');
    console.error('Create Inventory Item Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إضافة صنف المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 4. تحديث صنف مخزون (clinic_id غير قابل للتغيير — نقله بين العيادات يفكّ ارتباطه بالدفعات)
export const updateInventoryItem = async (req: AuthenticatedRequest, res: Response) => {
  const inventoryId = parseInventoryId(req.params.id);
  if (inventoryId === null) return validationError(res, 'معرّف صنف المخزون غير صالح');

  const parsed = inventoryItemUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, 'بيانات تحديث صنف المخزون غير صالحة');
  const body = parsed.data;

  try {
    const scope = buildClinicScope(req, [inventoryId]);
    const existing = await pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM inventory_items i
       WHERE i.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
      scope.params,
    );
    if (existing.rows.length === 0) return itemNotFound(res);

    const current = existing.rows[0];
    const clinicId = Number(current.clinic_id);

    if (body.clinic_id !== undefined && body.clinic_id !== clinicId) {
      return validationError(res, 'لا يمكن نقل صنف المخزون من عيادة إلى أخرى');
    }

    if (body.medication_id !== undefined && body.medication_id !== Number(current.medication_id)) {
      if (!(await medicationExists(body.medication_id))) {
        return validationError(res, 'الدواء المحدد غير موجود في دليل الأدوية');
      }
      if (await hasActiveItemForMedication(clinicId, body.medication_id, inventoryId)) {
        return duplicateItem(res);
      }
    }

    // العتبات تُدمج مع المخزَّن قبل الفحص: max_stock >= reorder_point على القيم النهائية
    const reorderPoint = body.reorder_point !== undefined ? body.reorder_point : Number(current.reorder_point);
    const maxStock =
      body.max_stock !== undefined
        ? body.max_stock
        : current.max_stock === null || current.max_stock === undefined
          ? null
          : Number(current.max_stock);
    if (!isMaxStockWithinReorderPoint(maxStock, reorderPoint)) {
      return validationError(res, 'الحد الأقصى للمخزون يجب أن يكون فارغاً أو أكبر من أو يساوي نقطة إعادة الطلب');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (body.medication_id !== undefined) assign('medication_id', body.medication_id);
    if (body.uom !== undefined) assign('uom', body.uom);
    if (body.min_stock !== undefined) assign('min_stock', body.min_stock);
    if (body.reorder_point !== undefined) assign('reorder_point', body.reorder_point);
    if (body.max_stock !== undefined) assign('max_stock', body.max_stock);

    if (sets.length === 0) {
      return validationError(res, 'لا توجد حقول قابلة للتحديث');
    }

    values.push(inventoryId);
    const updateScope = buildClinicScope(req, values, 'inventory_items.clinic_id');
    const result = await pool.query(
      `UPDATE inventory_items SET ${sets.join(', ')}, updated_at = NOW()
       WHERE inventory_id = $${values.length} AND deleted_at IS NULL${updateScope.clause}
       RETURNING ${RETURNING_COLUMNS}`,
      updateScope.params,
    );

    if (result.rows.length === 0) return itemNotFound(res);
    return res.status(200).json({
      message: 'تم تحديث صنف المخزون بنجاح',
      inventoryItem: result.rows[0],
    });
  } catch (error: any) {
    if (error?.code === '23505') return duplicateItem(res);
    if (error?.code === '23503') return validationError(res, 'العيادة أو الدواء المحدد غير موجود');
    console.error('Update Inventory Item Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تحديث صنف المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 5. أرشفة صنف المخزون — deleted_at فقط، لا حذف فعلي (السجلات التاريخية تبقى)
export const archiveInventoryItem = async (req: AuthenticatedRequest, res: Response) => {
  const inventoryId = parseInventoryId(req.params.id);
  if (inventoryId === null) return validationError(res, 'معرّف صنف المخزون غير صالح');

  try {
    const scope = buildClinicScope(req, [inventoryId], 'inventory_items.clinic_id');
    const result = await pool.query(
      `UPDATE inventory_items SET deleted_at = NOW(), updated_at = NOW()
       WHERE inventory_id = $1 AND deleted_at IS NULL${scope.clause}
       RETURNING inventory_id, clinic_id, medication_id, deleted_at`,
      scope.params,
    );

    if (result.rows.length === 0) return itemNotFound(res);
    return res.status(200).json({
      message: 'تم أرشفة صنف المخزون',
      inventoryItem: result.rows[0],
    });
  } catch (error) {
    console.error('Archive Inventory Item Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء أرشفة صنف المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};
