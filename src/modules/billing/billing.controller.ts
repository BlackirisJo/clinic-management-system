import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds, financeClinicScope, isGlobalFinanceRole } from '../../middlewares/auth.middleware';
import { InvoiceCalcError, invoiceNumberFor, invoiceStatus, resolveItem, round2, servicesKey } from './billing.calculation';
import type { ServicePricing } from './billing.calculation';
import { getBaseCurrency } from '../currencies/currency.validation';

// المحاسب دور مالي مركزي: يتعامل مع كل العيادات النشطة دون تقييد بالإسناد.
// نطاق العمليات المالية موحّد عبر financeClinicScope من auth.middleware.ts

// التحقق أن العيادة موجودة ونشطة قبل إنشاء خدمة/مصروف فيها
const ensureActiveClinic = async (clinicId: number): Promise<boolean> => {
  const r = await pool.query('SELECT 1 FROM clinics WHERE clinic_id = $1 AND is_active = TRUE', [clinicId]);
  return Boolean(r.rowCount);
};

const logAudit = async (userId: number | undefined, clinicId: number | null | undefined, action: string, resourceType: string, resourceId: number, metadata?: string) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, clinicId ?? null, action, resourceType, resourceId, metadata ?? null]
    );
  } catch (auditError) {
    console.error('Audit log failed:', auditError);
  }
};

// 1. إضافة خدمة عيادة جديدة وتحديد سعرها ونسبة الطبيب
export const createClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, service_name, price, doctor_percentage } = req.body;
  const targetClinicId = Number(clinic_id);

  if (!clinic_id || !service_name || price === undefined) {
    return res.status(400).json({ message: 'الرجاء توفير بيانات الخدمة كاملة (العيادة، الاسم، السعر)' });
  }
  // لغير المالية المركزية: يجب أن تكون العيادة مسندة للمستخدم
  if (!isGlobalFinanceRole(req)) {
    const userClinicId = req.user?.clinicId;
    const assigned: number[] = req.user?.clinicIds ?? [];
    const ok = (userClinicId !== null && userClinicId !== undefined && Number(userClinicId) === targetClinicId)
      || assigned.map(Number).includes(targetClinicId);
    if (!ok) {
      return res.status(403).json({ message: 'لا يمكنك إنشاء خدمة في عيادة غير مسندة لك' });
    }
  }
  if (!Number.isFinite(Number(price)) || Number(price) < 0 || Number(doctor_percentage ?? 0) < 0 || Number(doctor_percentage ?? 0) > 100) {
    return res.status(400).json({ message: 'السعر أو نسبة الطبيب غير صالحة' });
  }

  try {
    if (!Number.isFinite(targetClinicId) || targetClinicId <= 0 || !(await ensureActiveClinic(targetClinicId))) {
      return res.status(400).json({ message: 'العيادة غير موجودة أو غير فعالة' });
    }
    const result = await pool.query(
      `INSERT INTO clinic_services (clinic_id, service_name, price, doctor_percentage)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [targetClinicId, service_name, price, doctor_percentage || 0]
    );
    await logAudit(req.user?.userId, targetClinicId, 'SERVICE_CREATED', 'SERVICE', result.rows[0].service_id);

    return res.status(201).json({
      message: 'تم إضافة الخدمة للعيادة بنجاح',
      service: result.rows[0],
    });
  } catch (error) {
    console.error('Create Clinic Service Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إضافة الخدمة' });
  }
};

// 1ب. قائمة خدمات العيادات مع اسم العيادة (بدل رقمها فقط)
export const listClinicServices = async (req: AuthenticatedRequest, res: Response) => {
  const allowedClinics = financeClinicScope(req); // null = يرى الجميع
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? `%${req.query.search.trim()}%` : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  try {
    if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
      return res.status(403).json({ message: 'لا يمكنك عرض خدمات عيادة غير مسندة لك' });
    }
    const params: unknown[] = [allowedClinics, filterClinic, search, limit, offset];
    const result = await pool.query(
      `SELECT cs.service_id, cs.clinic_id, c.clinic_name, cs.service_name,
              cs.price, cs.doctor_percentage, cs.is_active,
              cs.created_at, cs.updated_at
       FROM clinic_services cs
       JOIN clinics c ON c.clinic_id = cs.clinic_id
       WHERE ($1::int[] IS NULL OR cs.clinic_id = ANY($1::int[]))
         AND ($2::int IS NULL OR cs.clinic_id = $2)
         AND ($3::text IS NULL OR cs.service_name ILIKE $3)
       ORDER BY cs.service_id DESC
       LIMIT $4 OFFSET $5`,
      params
    );
    return res.status(200).json({ services: result.rows, pagination: { page, limit, returned: result.rows.length } });
  } catch (error) {
    console.error('List Clinic Services Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة الخدمات' });
  }
};// 2. إصدار فاتورة جديدة: السعر المرجعي من قاعدة البيانات، احتساب الحصص في الخادم (Atomic Transaction)
export const createInvoice = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, visit_id, items, discount_amount, payment_type } = req.body;
  const receptionist_id = req.user?.userId;
  const allowedClinics = financeClinicScope(req); // null = مدير/مالية مركزية يرى الجميع
  const isAdmin = allowedClinics === null;

  if (!patient_id || !receptionist_id || (!isAdmin && !(allowedClinics ?? []).length) || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'بيانات الفاتورة غير مكتملة أو لا تحتوي على عناصر' });
  }

  const client = await pool.connect();
  let transactionActive = false;

  try {
    await client.query('BEGIN');
    transactionActive = true;

    // التحقق من ملكية المريض لأي عيادة من نطاق المستخدم (أو أي عيادة للمالي المركزي)
    const patientOwnership = await client.query(
      `SELECT 1 FROM patients WHERE patient_id = $1 AND ($2::int[] IS NULL OR clinic_id = ANY($2::int[]))`,
      [patient_id, allowedClinics]
    );
    if (patientOwnership.rows.length !== 1) {
      throw new InvoiceCalcError('المريض لا ينتمي إلى أي من عياداتك المسندة');
    }

    // أمن وسلامة البيانات: الزيارة المرتبطة (إن وُجدت) يجب أن تعود لنفس المريض
    // حتى لا تُربط فاتورة بزيارة مريض آخر.
    if (visit_id) {
      const visitCheck = await client.query(
        `SELECT 1 FROM visits WHERE visit_id = $1 AND patient_id = $2`,
        [visit_id, patient_id]
      );
      if (visitCheck.rows.length !== 1) {
        throw new InvoiceCalcError('الزيارة المحددة غير موجودة أو لا تنتمي لهذا المريض');
      }
    }

    // تجميع معرّفات الخدمات والأطباء للتحقق الجماعي (بدون استعلام لكل بند N+1)
    const requestedClinicIds: number[] = [];
    const serviceIds: number[] = [];
    const doctorIds: number[] = [];
    for (const it of items) {
      requestedClinicIds.push(Number(it.clinic_id));
      if (it.service_id) serviceIds.push(Number(it.service_id));
      if (it.doctor_id) doctorIds.push(Number(it.doctor_id));
    }
    const uniqueServiceIds = [...new Set(serviceIds)];
    const uniqueDoctorIds = [...new Set(doctorIds)];
    const uniqueClinicIds = [...new Set(requestedClinicIds)];

    // الخدمات المرجعية (السعر الحقيقي + نسبة الطبيب) داخل العيادات المطلوبة
    const servicesResult = uniqueServiceIds.length
      ? await client.query(
          `SELECT clinic_id, service_id, price, doctor_percentage, is_active
           FROM clinic_services
           WHERE service_id = ANY($1::int[]) AND clinic_id = ANY($2::int[])`,
          [uniqueServiceIds, uniqueClinicIds]
        )
      : { rows: [] };
    const servicesMap = new Map<string, ServicePricing>();
    for (const row of servicesResult.rows) {
      servicesMap.set(servicesKey(Number(row.clinic_id), Number(row.service_id)), {
        price: Number(row.price),
        doctor_percentage: Number(row.doctor_percentage) || 0,
        is_active: row.is_active === true || String(row.is_active) === 't' || String(row.is_active) === 'true',
      });
    }

    // التحقق من الأطباء (موجودون، نشطون، ودورهم DOCTOR)
    let doctorSet = new Set<number>();
    if (uniqueDoctorIds.length) {
      const doctorsResult = await client.query(
        `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
         WHERE u.user_id = ANY($1::int[]) AND r.role_name = 'DOCTOR' AND u.status = 'ACTIVE'`,
        [uniqueDoctorIds]
      );
      doctorSet = new Set(doctorsResult.rows.map((r: any) => Number(r.user_id)));
    }

    // احتساب كل البنود بالأسعار المرجعية (الخدمات) أو سعر العميل للبنود اليدوية
    let totalAmount = 0;
    const processedItems = items.map((item: any) => {
      const clinicId = Number(item.clinic_id);
      if (!Number.isFinite(clinicId) || clinicId <= 0 || (!isAdmin && !(allowedClinics ?? []).includes(clinicId))) {
        throw new InvoiceCalcError('بيانات عنصر الفاتورة غير مكتملة أو عيادة غير مسندة لك');
      }
      if (item.doctor_id && !doctorSet.has(Number(item.doctor_id))) {
        throw new InvoiceCalcError('الطبيب المحدد غير موجود أو ليس طبيباً نشطاً');
      }
      const resolved = resolveItem(item, servicesMap);
      totalAmount = round2(totalAmount + resolved.line_total);
      return resolved;
    });

    const discount = Math.max(0, Number(discount_amount) || 0);
    if (!Number.isFinite(discount) || discount < 0 || discount > totalAmount) {
      throw new InvoiceCalcError('قيمة الخصم غير صالحة');
    }
    const netAmount = round2(totalAmount - discount);

    if (!['CASH', 'CARD', 'INSURANCE', 'SPLIT'].includes(payment_type || 'CASH')) {
      throw new InvoiceCalcError('طريقة الدفع غير صالحة');
    }

    const baseCurrency = await getBaseCurrency();

    // إدراج الفاتورة الرئيسية (المدفوع = الصافي لأنها تُحصَّل فوراً حسب النموذج الحالي)
    const invoiceResult = await client.query(
      `INSERT INTO invoices (patient_id, visit_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [patient_id, visit_id || null, receptionist_id, totalAmount, discount, netAmount, netAmount, payment_type || 'CASH', baseCurrency]
    );
    const invoiceId = invoiceResult.rows[0].invoice_id;

    // إدراج البنود مع الكمية والسعر المرجعي (snapshot) وحصة الطبيب
    for (const pItem of processedItems) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, clinic_id, doctor_id, service_id, price, quantity, doctor_share)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, pItem.clinic_id, pItem.doctor_id, pItem.service_id, pItem.price, pItem.quantity, pItem.doctor_share]
      );
    }

    await client.query('COMMIT');
    transactionActive = false;
    await logAudit(receptionist_id, processedItems[0]?.clinic_id ?? req.user?.clinicId, 'INVOICE_CREATED', 'INVOICE', invoiceId, JSON.stringify({ total: totalAmount, net: netAmount }));

    return res.status(201).json({
      message: 'تم إصدار الفاتورة وتحصيل المبلغ بنجاح',
      invoice_id: invoiceId,
      total_amount: totalAmount,
      discount_amount: discount,
      net_amount: netAmount,
      paid_amount: netAmount,
    });
  } catch (error: any) {
    if (transactionActive) await client.query('ROLLBACK');
    console.error('Create Invoice Error:', error);
    if (error instanceof InvoiceCalcError) {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: 'حدث خطأ عند إصدار الفاتورة' });
  } finally {
    client.release();
  }
};
// 3. تسجيل مصروف جديد (للمالية المركزية: أي عيادة نشطة، لغيرهم: العيادات المسندة)
export const createExpense = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, category, amount, description } = req.body;
  const spent_by_user_id = req.user?.userId;
  const targetClinicId = Number(clinic_id);

  if (!category || amount === undefined || !spent_by_user_id || !Number.isFinite(targetClinicId) || targetClinicId <= 0) {
    return res.status(400).json({ message: 'بيانات المصروف غير مكتملة' });
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({ message: 'قيمة المصروف غير صالحة' });
  }

  try {
    if (!isGlobalFinanceRole(req)) {
      const assigned: number[] = accessibleClinicIds(req) ?? [];
      if (!assigned.map(Number).includes(targetClinicId)) {
        return res.status(403).json({ message: 'لا يمكنك تسجيل مصروف في عيادة غير مسندة لك' });
      }
    }
    if (!(await ensureActiveClinic(targetClinicId))) {
      return res.status(400).json({ message: 'العيادة غير موجودة أو غير فعالة' });
    }
    const baseCurrency = await getBaseCurrency();
    const result = await pool.query(
      `INSERT INTO expenses (clinic_id, category, amount, description, spent_by_user_id, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [targetClinicId, category, amount, description || null, spent_by_user_id, baseCurrency]
    );
    await logAudit(spent_by_user_id, targetClinicId, 'EXPENSE_CREATED', 'EXPENSE', result.rows[0].expense_id);

    return res.status(201).json({ message: 'تم تسجيل المصروف بنجاح', expense: result.rows[0] });
  } catch (error) {
    console.error('Create Expense Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل المصروف' });
  }
};

// 3ب. قائمة المصاريف (تستبعد المحذوف soft delete) مع أسماء العيادة والموظف
const EXPENSE_SELECT = `e.expense_id, e.clinic_id, c.clinic_name, e.category, e.amount,
        e.currency_code, e.description, e.created_at, e.updated_at,
        e.spent_by_user_id, u.full_name AS spent_by_name`;

export const listExpenses = async (req: AuthenticatedRequest, res: Response) => {
  const allowedClinics = financeClinicScope(req); // null = مدير/مالية مركزية يرى الجميع
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  try {
    if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
      return res.status(403).json({ message: 'لا يمكنك عرض مصاريف عيادة غير مسندة لك' });
    }
    const result = await pool.query(
      `SELECT ${EXPENSE_SELECT}
       FROM expenses e
       LEFT JOIN clinics c ON c.clinic_id = e.clinic_id
       LEFT JOIN users u ON u.user_id = e.spent_by_user_id
       WHERE e.deleted_at IS NULL
         AND ($1::int[] IS NULL OR e.clinic_id = ANY($1::int[]))
         AND ($2::int IS NULL OR e.clinic_id = $2)
       ORDER BY e.expense_id DESC
       LIMIT $3 OFFSET $4`,
      [allowedClinics, filterClinic, limit, offset]
    );
    return res.status(200).json({ expenses: result.rows, pagination: { page, limit, returned: result.rows.length } });
  } catch (error) {
    console.error('List Expenses Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة المصاريف' });
  }
};

// 3ج. تفاصيل مصروف واحد
export const getExpense = async (req: AuthenticatedRequest, res: Response) => {
  const expenseId = Number(req.params.id);
  const allowedClinics = financeClinicScope(req);
  try {
    const result = await pool.query(
      `SELECT ${EXPENSE_SELECT}
       FROM expenses e
       LEFT JOIN clinics c ON c.clinic_id = e.clinic_id
       LEFT JOIN users u ON u.user_id = e.spent_by_user_id
       WHERE e.expense_id = $1 AND e.deleted_at IS NULL
         AND ($2::int[] IS NULL OR e.clinic_id = ANY($2::int[]))`,
      [expenseId, allowedClinics]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'المصروف غير موجود أو لا تملك صلاحية الوصول إليه' });
    return res.status(200).json({ expense: result.rows[0] });
  } catch (error) {
    console.error('Get Expense Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب المصروف' });
  }
};

// 3د. تعديل مصروف (مع إعادة التحقق من النطاق والعيادة والمبلغ والتصنيف)
export const updateExpense = async (req: AuthenticatedRequest, res: Response) => {
  const expenseId = Number(req.params.id);
  const { clinic_id, category, amount, description } = req.body;
  const allowedClinics = financeClinicScope(req);
  try {
    const current = await pool.query(
      `SELECT e.expense_id, e.clinic_id FROM expenses e
       WHERE e.expense_id = $1 AND e.deleted_at IS NULL
         AND ($2::int[] IS NULL OR e.clinic_id = ANY($2::int[]))`,
      [expenseId, allowedClinics]
    );
    if (!current.rowCount) return res.status(404).json({ message: 'المصروف غير موجود أو لا تملك صلاحية الوصول إليه' });

    let targetClinic = Number(current.rows[0].clinic_id);
    if (clinic_id !== undefined) {
      targetClinic = Number(clinic_id);
      if (!Number.isFinite(targetClinic) || targetClinic <= 0) return res.status(400).json({ message: 'العيادة غير صالحة' });
      if (allowedClinics !== null && !allowedClinics.includes(targetClinic)) {
        return res.status(403).json({ message: 'لا يمكنك نقل المصروف لعيادة غير مسندة لك' });
      }
      if (!(await ensureActiveClinic(targetClinic))) return res.status(400).json({ message: 'العيادة غير موجودة أو غير فعالة' });
    }
    if (category !== undefined && !String(category).trim()) return res.status(400).json({ message: 'التصنيف غير صالح' });
    if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) {
      return res.status(400).json({ message: 'قيمة المصروف غير صالحة' });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (category !== undefined) add('category', String(category).trim());
    if (amount !== undefined) add('amount', Number(amount));
    if (description !== undefined) add('description', description === '' ? null : description);
    if (clinic_id !== undefined) add('clinic_id', targetClinic);
    add('updated_at', new Date());
    if (sets.length === 1) return res.status(400).json({ message: 'لا توجد بيانات للتعديل' });

    const result = await pool.query(
      `UPDATE expenses SET ${sets.join(', ')} WHERE expense_id = $${params.length + 1} RETURNING *`,
      [...params, expenseId]
    );
    await logAudit(req.user?.userId, targetClinic, 'EXPENSE_UPDATED', 'EXPENSE', expenseId);
    return res.status(200).json({ message: 'تم تحديث المصروف بنجاح', expense: result.rows[0] });
  } catch (error) {
    console.error('Update Expense Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تعديل المصروف' });
  }
};

// 3هـ. حذف مصروف (soft delete للحفاظ على السجل المالي والتقارير)
export const deleteExpense = async (req: AuthenticatedRequest, res: Response) => {
  const expenseId = Number(req.params.id);
  const allowedClinics = financeClinicScope(req);
  try {
    const current = await pool.query(
      `SELECT e.expense_id, e.clinic_id FROM expenses e
       WHERE e.expense_id = $1 AND e.deleted_at IS NULL
         AND ($2::int[] IS NULL OR e.clinic_id = ANY($2::int[]))`,
      [expenseId, allowedClinics]
    );
    if (!current.rowCount) return res.status(404).json({ message: 'المصروف غير موجود أو لا تملك صلاحية الوصول إليه' });
    await pool.query('UPDATE expenses SET deleted_at = NOW() WHERE expense_id = $1', [expenseId]);
    await logAudit(req.user?.userId, Number(current.rows[0].clinic_id), 'EXPENSE_DELETED', 'EXPENSE', expenseId);
    return res.status(200).json({ message: 'تم حذف المصروف (مع الحفاظ على السجل المالي)', deleted: true, soft_deleted: true });
  } catch (error) {
    console.error('Delete Expense Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء حذف المصروف' });
  }
};
// 4. تفاصيل خدمة واحدة مع حساب حصص الطبيب والمركز
export const getClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const serviceId = Number(req.params.id);
  const allowedClinics = financeClinicScope(req);
  try {
    const result = await pool.query(
      `SELECT cs.service_id, cs.clinic_id, c.clinic_name, cs.service_name, cs.price,
              cs.doctor_percentage, cs.is_active, cs.created_at, cs.updated_at
       FROM clinic_services cs
       JOIN clinics c ON c.clinic_id = cs.clinic_id
       WHERE cs.service_id = $1
         AND ($2::int[] IS NULL OR cs.clinic_id = ANY($2::int[]))`,
      [serviceId, allowedClinics]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'الخدمة غير موجودة أو لا تملك صلاحية الوصول إليها' });
    const svc = result.rows[0];
    const price = Number(svc.price);
    const pct = Number(svc.doctor_percentage) || 0;
    const doctorShare = round2((price * pct) / 100);
    return res.status(200).json({ service: { ...svc, doctor_share: doctorShare, center_share: round2(price - doctorShare) } });
  } catch (error) {
    console.error('Get Clinic Service Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب الخدمة' });
  }
};

// 4ب. تعديل خدمة (لا يؤثر على الفواتير التاريخية لأن السعر snapshot داخل invoice_items)
export const updateClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const serviceId = Number(req.params.id);
  const { clinic_id, service_name, price, doctor_percentage, is_active } = req.body;
  const allowedClinics = financeClinicScope(req);
  try {
    const current = await pool.query(
      `SELECT cs.clinic_id FROM clinic_services cs
       WHERE cs.service_id = $1 AND ($2::int[] IS NULL OR cs.clinic_id = ANY($2::int[]))`,
      [serviceId, allowedClinics]
    );
    if (!current.rowCount) return res.status(404).json({ message: 'الخدمة غير موجودة أو لا تملك صلاحية الوصول إليها' });

    let targetClinic = Number(current.rows[0].clinic_id);
    if (clinic_id !== undefined) {
      targetClinic = Number(clinic_id);
      if (!Number.isFinite(targetClinic) || targetClinic <= 0) return res.status(400).json({ message: 'العيادة غير صالحة' });
      if (allowedClinics !== null && !allowedClinics.includes(targetClinic)) {
        return res.status(403).json({ message: 'لا يمكنك نقل الخدمة لعيادة غير مسندة لك' });
      }
      if (!(await ensureActiveClinic(targetClinic))) return res.status(400).json({ message: 'العيادة غير موجودة أو غير فعالة' });
    }
    if (service_name !== undefined && !String(service_name).trim()) return res.status(400).json({ message: 'اسم الخدمة غير صالح' });
    if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
      return res.status(400).json({ message: 'السعر غير صالح' });
    }
    if (doctor_percentage !== undefined && (Number(doctor_percentage) < 0 || Number(doctor_percentage) > 100)) {
      return res.status(400).json({ message: 'نسبة الطبيب يجب أن تكون بين 0 و 100' });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (service_name !== undefined) add('service_name', String(service_name).trim());
    if (price !== undefined) add('price', Number(price));
    if (doctor_percentage !== undefined) add('doctor_percentage', Number(doctor_percentage));
    if (is_active !== undefined) add('is_active', Boolean(is_active));
    if (clinic_id !== undefined) add('clinic_id', targetClinic);
    add('updated_at', new Date());
    if (sets.length === 1) return res.status(400).json({ message: 'لا توجد بيانات للتعديل' });

    const result = await pool.query(
      `UPDATE clinic_services SET ${sets.join(', ')} WHERE service_id = $${params.length + 1} RETURNING *`,
      [...params, serviceId]
    );
    await logAudit(req.user?.userId, targetClinic, 'SERVICE_UPDATED', 'SERVICE', serviceId);
    return res.status(200).json({ message: 'تم تحديث الخدمة بنجاح', service: result.rows[0] });
  } catch (error) {
    console.error('Update Clinic Service Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تعديل الخدمة' });
  }
};

// 4ج. حذف خدمة: مستخدمة في فواتير سابقة = تعطيل (soft delete)، غير مستخدمة = حذف فعلي
export const deleteClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const serviceId = Number(req.params.id);
  const allowedClinics = financeClinicScope(req);
  try {
    const current = await pool.query(
      `SELECT cs.service_id, cs.clinic_id, cs.service_name FROM clinic_services cs
       WHERE cs.service_id = $1 AND ($2::int[] IS NULL OR cs.clinic_id = ANY($2::int[]))`,
      [serviceId, allowedClinics]
    );
    if (!current.rowCount) return res.status(404).json({ message: 'الخدمة غير موجودة أو لا تملك صلاحية الوصول إليها' });
    const used = await pool.query('SELECT 1 FROM invoice_items WHERE service_id = $1 LIMIT 1', [serviceId]);
    if (used.rowCount) {
      await pool.query('UPDATE clinic_services SET is_active = FALSE, updated_at = NOW() WHERE service_id = $1', [serviceId]);
      await logAudit(req.user?.userId, Number(current.rows[0].clinic_id), 'SERVICE_DEACTIVATED', 'SERVICE', serviceId);
      return res.status(200).json({
        message: 'لا يمكن حذف خدمة مستخدمة في فواتير سابقة؛ تم تعطيلها بدلاً من ذلك للحفاظ على الفواتير التاريخية',
        service: { service_id: serviceId, is_active: false },
        soft_deleted: true,
      });
    }
    await pool.query('DELETE FROM clinic_services WHERE service_id = $1', [serviceId]);
    await logAudit(req.user?.userId, Number(current.rows[0].clinic_id), 'SERVICE_DELETED', 'SERVICE', serviceId);
    return res.status(200).json({ message: 'تم حذف الخدمة بنجاح', deleted: true });
  } catch (error) {
    console.error('Delete Clinic Service Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء حذف الخدمة' });
  }
};
// 5. تفاصيل فاتورة واحدة مع البنود والحقول المشتقة (رقم الفاتورة، الحالة، المتبقي)
export const getInvoice = async (req: AuthenticatedRequest, res: Response) => {
  const invoiceId = Number(req.params.id);
  const allowedClinics = financeClinicScope(req);
  try {
    const invRes = await pool.query(
      `SELECT i.invoice_id, i.patient_id, p.full_name AS patient_name, p.phone,
              i.visit_id, i.receptionist_id, u.full_name AS receptionist_name,
              i.total_amount, i.discount_amount, i.net_amount, i.paid_amount,
              i.payment_type, i.currency_code, i.created_at
       FROM invoices i
       JOIN patients p ON p.patient_id = i.patient_id
       LEFT JOIN users u ON u.user_id = i.receptionist_id
       WHERE i.invoice_id = $1
         AND ($2::int[] IS NULL OR EXISTS (
               SELECT 1 FROM invoice_items x
               WHERE x.invoice_id = i.invoice_id AND x.clinic_id = ANY($2::int[])
             ))`,
      [invoiceId, allowedClinics]
    );
    if (!invRes.rowCount) return res.status(404).json({ message: 'الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها' });
    const invoice = invRes.rows[0];
    const itemsRes = await pool.query(
      `SELECT ii.item_id, ii.clinic_id, c.clinic_name,
              ii.doctor_id, d.full_name AS doctor_name,
              ii.service_id, cs.service_name,
              ii.price, ii.quantity, ii.doctor_share, ii.created_at
       FROM invoice_items ii
       LEFT JOIN clinics c ON c.clinic_id = ii.clinic_id
       LEFT JOIN users d ON d.user_id = ii.doctor_id
       LEFT JOIN clinic_services cs ON cs.service_id = ii.service_id
       WHERE ii.invoice_id = $1
       ORDER BY ii.item_id ASC`,
      [invoiceId]
    );
    const items = itemsRes.rows.map((r) => ({ ...r, line_total: round2(Number(r.price) * Number(r.quantity)) }));
    return res.status(200).json({
      invoice: {
        ...invoice,
        invoice_number: invoiceNumberFor(Number(invoice.invoice_id), invoice.created_at),
        status: invoiceStatus(Number(invoice.net_amount), Number(invoice.paid_amount)),
        remaining: round2(Number(invoice.net_amount) - Number(invoice.paid_amount)),
        items,
      },
    });
  } catch (error) {
    console.error('Get Invoice Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب الفاتورة' });
  }
};

// 5ب. قائمة الفواتير: صف لكل فاتورة مع البنود مجمّعة (ترقيم حقيقي بدل hack الـ limit*20)
export const listInvoices = async (req: AuthenticatedRequest, res: Response) => {
  const allowedClinics = financeClinicScope(req); // null = مدير/مالية مركزية يرى الجميع
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const patientId = req.query.patient_id ? Number(req.query.patient_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  try {
    if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
      return res.status(403).json({ message: 'لا يمكنك عرض فواتير عيادة غير مسندة لك' });
    }
    // المرحلة 1: معرّفات الفواتير في الصفحة المطلوبة فقط
    const idRes = await pool.query(
      `SELECT i.invoice_id
       FROM invoices i
       WHERE ($1::int[] IS NULL OR EXISTS (
               SELECT 1 FROM invoice_items x
               WHERE x.invoice_id = i.invoice_id AND x.clinic_id = ANY($1::int[])
             ))
         AND ($2::int IS NULL OR EXISTS (
               SELECT 1 FROM invoice_items y
               WHERE y.invoice_id = i.invoice_id AND y.clinic_id = $2
             ))
         AND ($3::int IS NULL OR i.patient_id = $3)
       ORDER BY i.invoice_id DESC
       LIMIT $4 OFFSET $5`,
      [allowedClinics, filterClinic, patientId, limit, offset]
    );
    const ids = idRes.rows.map((r) => Number(r.invoice_id));
    if (ids.length === 0) return res.status(200).json({ invoices: [], pagination: { page, limit, returned: 0 } });

    // المرحلة 2: بيانات الفواتير ثم بنودها (بدون N+1)
    const invRes = await pool.query(
      `SELECT i.invoice_id, i.patient_id, p.full_name AS patient_name,
              i.visit_id, i.total_amount, i.discount_amount, i.net_amount,
              i.paid_amount, i.payment_type, i.currency_code, i.created_at
       FROM invoices i
       JOIN patients p ON p.patient_id = i.patient_id
       WHERE i.invoice_id = ANY($1::int[])
       ORDER BY i.invoice_id DESC`,
      [ids]
    );
    const itemsRes = await pool.query(
      `SELECT ii.invoice_id, ii.item_id, ii.clinic_id, c.clinic_name,
              ii.doctor_id, d.full_name AS doctor_name,
              ii.service_id, cs.service_name,
              ii.price, ii.quantity, ii.doctor_share
       FROM invoice_items ii
       LEFT JOIN clinics c ON c.clinic_id = ii.clinic_id
       LEFT JOIN users d ON d.user_id = ii.doctor_id
       LEFT JOIN clinic_services cs ON cs.service_id = ii.service_id
       WHERE ii.invoice_id = ANY($1::int[])
       ORDER BY ii.invoice_id DESC, ii.item_id ASC`,
      [ids]
    );
    const itemsByInvoice = new Map<number, any[]>();
    for (const r of itemsRes.rows) {
      const key = Number(r.invoice_id);
      const list = itemsByInvoice.get(key) ?? [];
      list.push({ ...r, line_total: round2(Number(r.price) * Number(r.quantity)) });
      itemsByInvoice.set(key, list);
    }
    const invoices = invRes.rows.map((row) => {
      const items = itemsByInvoice.get(Number(row.invoice_id)) ?? [];
      const clinicNames = [...new Set(items.map((it) => it.clinic_name).filter(Boolean))];
      const doctorNames = [...new Set(items.map((it) => it.doctor_name).filter(Boolean))];
      return {
        ...row,
        invoice_number: invoiceNumberFor(Number(row.invoice_id), row.created_at),
        status: invoiceStatus(Number(row.net_amount), Number(row.paid_amount)),
        remaining: round2(Number(row.net_amount) - Number(row.paid_amount)),
        items_count: items.length,
        clinic_names: clinicNames,
        doctor_names: doctorNames,
        items,
      };
    });
    return res.status(200).json({ invoices, pagination: { page, limit, returned: invoices.length } });
  } catch (error) {
    console.error('List Invoices Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة الفواتير' });
  }
};
// 6. المؤشرات المالية الشهرية: استعلام حي (لا يعتمد على Buffer متأخر) ويشمل المصاريف والمتبقي
// المؤشر الشهري لكل عيادة يتبع نفس دلالة الـ MV السابقة (احتساب على مستوى بنود العيادة).
export const getMonthlyFinancialKPIs = async (req: AuthenticatedRequest, res: Response) => {
  const allowedClinics = financeClinicScope(req); // null = كل العيادات
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
    return res.status(403).json({ message: 'لا يمكنك عرض مؤشرات عيادة غير مسندة لك' });
  }
  try {
    const result = await pool.query(
      `WITH item_stats AS (
          SELECT ii.clinic_id,
                 DATE_TRUNC('month', ii.created_at) AS stat_month,
                 COUNT(DISTINCT i.patient_id)::int AS unique_patients,
                 COUNT(DISTINCT i.visit_id)::int AS total_visits,
                 SUM(ii.price * ii.quantity)::numeric AS total_revenue,
                 SUM(ii.doctor_share)::numeric AS total_doctor_payout
          FROM invoice_items ii
          JOIN invoices i ON i.invoice_id = ii.invoice_id
          WHERE ($1::int[] IS NULL OR ii.clinic_id = ANY($1::int[]))
            AND ($2::int IS NULL OR ii.clinic_id = $2)
          GROUP BY ii.clinic_id, DATE_TRUNC('month', ii.created_at)
        ),
        invoice_payments AS (
          SELECT DISTINCT ii.clinic_id,
                 DATE_TRUNC('month', ii.created_at) AS stat_month,
                 i.paid_amount, i.net_amount
          FROM invoice_items ii
          JOIN invoices i ON i.invoice_id = ii.invoice_id
          WHERE ($1::int[] IS NULL OR ii.clinic_id = ANY($1::int[]))
            AND ($2::int IS NULL OR ii.clinic_id = $2)
        ),
        invoice_totals AS (
          SELECT clinic_id, stat_month,
                 SUM(paid_amount)::numeric AS total_paid,
                 SUM(net_amount - paid_amount)::numeric AS total_outstanding
          FROM invoice_payments
          GROUP BY clinic_id, stat_month
        ),
        expense_stats AS (
          SELECT clinic_id, DATE_TRUNC('month', created_at) AS stat_month,
                 SUM(amount)::numeric AS total_expenses
          FROM expenses
          WHERE deleted_at IS NULL
            AND ($1::int[] IS NULL OR clinic_id = ANY($1::int[]))
            AND ($2::int IS NULL OR clinic_id = $2)
          GROUP BY clinic_id, DATE_TRUNC('month', created_at)
        )
       SELECT c.clinic_id, c.clinic_name, s.stat_month,
              s.unique_patients, s.total_visits, s.total_revenue, s.total_doctor_payout,
              COALESCE(p.total_paid, 0)::numeric AS total_paid,
              COALESCE(p.total_outstanding, 0)::numeric AS total_outstanding,
              COALESCE(e.total_expenses, 0)::numeric AS total_expenses
       FROM item_stats s
       JOIN clinics c ON c.clinic_id = s.clinic_id
       LEFT JOIN invoice_totals p ON p.clinic_id = s.clinic_id AND p.stat_month = s.stat_month
       LEFT JOIN expense_stats e ON e.clinic_id = s.clinic_id AND e.stat_month = s.stat_month
       ORDER BY s.stat_month DESC`,
      [allowedClinics, filterClinic]
    );
    const kpis = result.rows.map((r) => {
      const revenue = Number(r.total_revenue) || 0;
      const payout = Number(r.total_doctor_payout) || 0;
      const expenses = Number(r.total_expenses) || 0;
      return {
        ...r,
        total_expenses: expenses,
        // المحافظة على تسمية الـ MV السابقة: هامش العيادة = الإيراد - حصة الأطباء
        net_clinic_margin: round2(revenue - payout),
        // صافي شامل بعد المصاريف
        net_after_expenses: round2(revenue - payout - expenses),
      };
    });
    return res.status(200).json({ kpis });
  } catch (error) {
    console.error('Get Financial KPIs Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب التقارير المالية' });
  }
};