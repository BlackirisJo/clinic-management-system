import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { supplierCreateSchema, supplierUpdateSchema } from '../../validations/supplier.validation';
import { buildClinicScope, isClinicAccessible, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10B.2B — Suppliers backend
 * Clinic-scoped supplier directory. Suppliers are never physically deleted:
 * inventory_batches.supplier_id points at them, so deactivation is the only
 * removal path and the row (plus its batch history) is always preserved.
 * ========================================================================== */

const SUPPLIER_COLUMNS = `s.supplier_id, s.clinic_id, s.name, s.contact_info, s.is_active, s.created_at, s.updated_at,
       c.clinic_name`;

const SUPPLIER_FROM = `FROM suppliers s
     JOIN clinics c ON c.clinic_id = s.clinic_id`;

const RETURNING_COLUMNS = `supplier_id, clinic_id, name, contact_info, is_active, created_at, updated_at`;

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// خطأ موحّد للسجل غير الموجود وللسجل الخارج عن نطاق عيادات المستخدم (لا يُكشف وجوده)
const supplierNotFound = (res: Response) =>
  res.status(404).json({ message: 'المورد المطلوب غير موجود' });

const duplicateSupplier = (res: Response) =>
  res.status(409).json({
    message: 'يوجد مورد مسجّل بنفس الاسم في هذه العيادة',
    code: ApiErrorCode.FORBIDDEN,
  });

// uq_suppliers_clinic_name فهرس فريد على كل الصفوف — المورد غير النشط يحجز اسمه أيضاً
const hasSupplierWithName = async (
  clinicId: number,
  name: string,
  excludeSupplierId?: number,
): Promise<boolean> => {
  const result = await pool.query(
    `SELECT supplier_id FROM suppliers
     WHERE clinic_id = $1 AND lower(name) = lower($2)
       AND ($3::int IS NULL OR supplier_id <> $3::int)`,
    [clinicId, name, excludeSupplierId ?? null],
  );
  return result.rows.length > 0;
};

// 1. قائمة موردي العيادات المسموح بها للمستخدم
export const listSuppliers = async (req: AuthenticatedRequest, res: Response) => {
  const requestedClinicId = req.query.clinic_id;
  let baseParams: unknown[] = [];
  let requestedClause = '';

  if (requestedClinicId !== undefined) {
    const clinicId = Number(requestedClinicId);
    if (!Number.isInteger(clinicId) || clinicId <= 0) {
      return validationError(res, 'معرّف العيادة غير صالح');
    }
    if (!isClinicAccessible(req, clinicId)) return supplierNotFound(res);
    baseParams = [clinicId];
    requestedClause = ' AND s.clinic_id = $1';
  }

  try {
    const scope = buildClinicScope(req, baseParams, 's.clinic_id');
    const result = await pool.query(
      `SELECT ${SUPPLIER_COLUMNS} ${SUPPLIER_FROM}
       WHERE 1=1${requestedClause}${scope.clause}
       ORDER BY s.is_active ASC, s.name ASC, s.supplier_id ASC`,
      scope.params,
    );

    return res.status(200).json({ suppliers: result.rows });
  } catch (error) {
    console.error('List Suppliers Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب الموردين',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 2. تفاصيل مورد واحد — المورد خارج نطاق المستخدم = 404
export const getSupplier = async (req: AuthenticatedRequest, res: Response) => {
  const supplierId = parsePositiveId(req.params.id);
  if (supplierId === null) return validationError(res, 'معرّف المورد غير صالح');

  try {
    const scope = buildClinicScope(req, [supplierId], 's.clinic_id');
    const result = await pool.query(
      `SELECT ${SUPPLIER_COLUMNS} ${SUPPLIER_FROM} WHERE s.supplier_id = $1${scope.clause}`,
      scope.params,
    );

    if (result.rows.length === 0) return supplierNotFound(res);
    return res.status(200).json({ supplier: result.rows[0] });
  } catch (error) {
    console.error('Get Supplier Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب المورد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 3. إنشاء مورد في عيادة ضمن نطاق المستخدم
export const createSupplier = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = supplierCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, 'بيانات المورد غير صالحة');
  const body = parsed.data;

  // clinic_id من الـ body لا يتجاوز نطاق عيادات المستخدم أبداً
  if (!isClinicAccessible(req, body.clinic_id)) {
    return res.status(403).json({
      message: 'لا تملك صلاحية إدارة موردي هذه العيادة',
      code: ApiErrorCode.FORBIDDEN,
    });
  }

  try {
    if (await hasSupplierWithName(body.clinic_id, body.name)) return duplicateSupplier(res);

    const result = await pool.query(
      `INSERT INTO suppliers (clinic_id, name, contact_info, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING ${RETURNING_COLUMNS}`,
      [body.clinic_id, body.name, body.contact_info, body.is_active],
    );

    return res.status(201).json({
      message: 'تمت إضافة المورد بنجاح',
      supplier: result.rows[0],
    });
  } catch (error: any) {
    if (error?.code === '23505') return duplicateSupplier(res);
    if (error?.code === '23503') return validationError(res, 'العيادة المحددة غير موجودة');
    console.error('Create Supplier Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إضافة المورد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 4. تحديث مورد (clinic_id غير قابل للتغيير — المورد يبقى مرتبطاً بدفعات عيادته)
export const updateSupplier = async (req: AuthenticatedRequest, res: Response) => {
  const supplierId = parsePositiveId(req.params.id);
  if (supplierId === null) return validationError(res, 'معرّف المورد غير صالح');

  const parsed = supplierUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, 'بيانات تحديث المورد غير صالحة');
  const body = parsed.data;

  try {
    const scope = buildClinicScope(req, [supplierId], 's.clinic_id');
    const existing = await pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM suppliers s WHERE s.supplier_id = $1${scope.clause}`,
      scope.params,
    );
    if (existing.rows.length === 0) return supplierNotFound(res);
    const clinicId = Number(existing.rows[0].clinic_id);

    if (body.clinic_id !== undefined && body.clinic_id !== clinicId) {
      return validationError(res, 'لا يمكن نقل المورد من عيادة إلى أخرى');
    }

    // فحص التكرار فقط عند تغيّر الاسم فعلاً — وإلاطالَب المورد بنفسه
    if (body.name !== undefined && body.name.toLowerCase() !== String(existing.rows[0].name).toLowerCase()) {
      if (await hasSupplierWithName(clinicId, body.name, supplierId)) return duplicateSupplier(res);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (body.name !== undefined) assign('name', body.name);
    if (body.contact_info !== undefined) assign('contact_info', body.contact_info);
    if (body.is_active !== undefined) assign('is_active', body.is_active);

    if (sets.length === 0) {
      return validationError(res, 'لا توجد حقول قابلة للتحديث');
    }

    values.push(supplierId);
    const updateScope = buildClinicScope(req, values, 'suppliers.clinic_id');
    const result = await pool.query(
      `UPDATE suppliers SET ${sets.join(', ')}, updated_at = NOW()
       WHERE supplier_id = $${values.length}${updateScope.clause}
       RETURNING ${RETURNING_COLUMNS}`,
      updateScope.params,
    );

    if (result.rows.length === 0) return supplierNotFound(res);
    return res.status(200).json({
      message: 'تم تحديث المورد بنجاح',
      supplier: result.rows[0],
    });
  } catch (error: any) {
    if (error?.code === '23505') return duplicateSupplier(res);
    console.error('Update Supplier Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تحديث المورد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

// 5. إلغاء تنشيط المورد — is_active = FALSE فقط، لا حذف (تبقى الدفعات وسجلها محفوظاً)
export const deactivateSupplier = async (req: AuthenticatedRequest, res: Response) => {
  const supplierId = parsePositiveId(req.params.id);
  if (supplierId === null) return validationError(res, 'معرّف المورد غير صالح');

  try {
    const scope = buildClinicScope(req, [supplierId], 'suppliers.clinic_id');
    const result = await pool.query(
      `UPDATE suppliers SET is_active = FALSE, updated_at = NOW()
       WHERE supplier_id = $1${scope.clause}
       RETURNING ${RETURNING_COLUMNS}`,
      scope.params,
    );

    if (result.rows.length === 0) return supplierNotFound(res);
    return res.status(200).json({
      message: 'تم إلغاء تنشيط المورد',
      supplier: result.rows[0],
    });
  } catch (error) {
    console.error('Deactivate Supplier Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إلغاء تنشيط المورد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};
