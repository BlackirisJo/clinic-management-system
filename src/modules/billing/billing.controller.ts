import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds } from '../../middlewares/auth.middleware';

// المحاسب دور مالي مركزي: يتعامل مع كل العيادات النشطة دون تقييد بالإسناد.
// (المدير SUPER/SYSTEM_ADMIN يبقى شاملاً أيضاً)
const isFinanceUnrestricted = (req: AuthenticatedRequest): boolean => {
  if (req.user?.roleName === 'SUPER_ADMIN' || req.user?.roleName === 'SYSTEM_ADMIN') return true;
  if (req.user?.roleName === 'ACCOUNTANT') return true;
  const perms = req.user?.permissions ?? [];
  return perms.includes('MANAGE_SERVICES') || perms.includes('CREATE_EXPENSE');
};

// التحقق أن العيادة موجودة ونشطة قبل إنشاء خدمة/مصروف فيها
const ensureActiveClinic = async (clinicId: number): Promise<boolean> => {
  const r = await pool.query('SELECT 1 FROM clinics WHERE clinic_id = $1 AND is_active = TRUE', [clinicId]);
  return Boolean(r.rowCount);
};

// 1. إضافة خدمة عيادة جديدة وتحديد سعرها ونسبة الطبيب
export const createClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, service_name, price, doctor_percentage } = req.body;
  const targetClinicId = Number(clinic_id);

  if (!clinic_id || !service_name || price === undefined) {
    return res.status(400).json({ message: 'الرجاء توفير بيانات الخدمة كاملة (العيادة، الاسم، السعر)' });
  }
  // لغير المالية المركزية: يجب أن تكون العيادة مسندة للمستخدم
  if (!isFinanceUnrestricted(req)) {
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
  // المالية المركزية (محاسب/إدارة) ترى كل الخدمات؛ غيرهم مقيد بعياداته المسندة
  const allowedClinics = isFinanceUnrestricted(req) ? null : accessibleClinicIds(req); // null = يرى الجميع
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? `%${req.query.search.trim()}%` : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  try {
    // منع فلترة بعيادة غير مسندة لغير المدير
    if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
      return res.status(403).json({ message: 'لا يمكنك عرض خدمات عيادة غير مسندة لك' });
    }
    const params: unknown[] = [allowedClinics, filterClinic, search, limit, offset];
    const result = await pool.query(
      `SELECT cs.service_id, cs.clinic_id, c.clinic_name, cs.service_name,
              cs.price, cs.doctor_percentage, cs.is_active
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
};

// 2. إصدار فاتورة جديدة للمريض وحساب حصة الطبيب (Atomic Transaction)
export const createInvoice = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, visit_id, items, discount_amount, payment_type } = req.body;
  const receptionist_id = req.user?.userId;
  const allowedClinics = isFinanceUnrestricted(req) ? null : accessibleClinicIds(req); // null = مدير/مالية مركزية يرى الجميع
  const isAdmin = allowedClinics === null;

  if (!patient_id || !receptionist_id || (!isAdmin && !(allowedClinics ?? []).length) || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'بيانات الفاتورة غير مكتملة أو لا تحتوي على عناصر' });
  }

  const client = await pool.connect();
  let transactionActive = false;

  try {
    await client.query('BEGIN');
    transactionActive = true;

      // التحقق من ملكية المريض لأحد عيادات المستخدم المسندة (أو أي عيادة للمدير)
    const patientOwnership = await client.query(
      `SELECT 1 FROM patients WHERE patient_id = $1 AND ($2::int[] IS NULL OR clinic_id = ANY($2::int[]))`,
      [patient_id, allowedClinics]
    );
    if (patientOwnership.rows.length !== 1) {
      throw new Error('المريض لا ينتمي إلى أي من عياداتك المسندة');
    }

    // حساب المبالغ الكلية والإجمالية
    let totalAmount = 0;
    const processedItems: {
      clinic_id: number;
      doctor_id: number | null;
      service_id: number | null;
      price: number;
      doctor_share: number;
    }[] = [];

    for (const item of items) {
      const { clinic_id, doctor_id, service_id, price } = item;

      // عيادة العنصر يجب أن تكون من العيادات المسندة للمستخدم (أو أي عيادة للمدير)
      const itemClinicAllowed = isAdmin || (clinic_id && (allowedClinics ?? []).includes(Number(clinic_id)));
      if (!clinic_id || !itemClinicAllowed || price === undefined || !Number.isFinite(Number(price)) || Number(price) < 0) {
        throw new Error('بيانات عنصر الفاتورة غير مكتملة أو عيادة غير مسندة لك');
      }

      let doctorShare = 0;

      // حساب حصة الطبيب إذا تم اختيار خدمة محددة وطبيب
      if (service_id && doctor_id) {
        const serviceQuery = await client.query(
          'SELECT doctor_percentage FROM clinic_services WHERE service_id = $1 AND clinic_id = $2',
          [service_id, clinic_id]
        );

        if (serviceQuery.rows.length > 0) {
          const percentage = Number(serviceQuery.rows[0].doctor_percentage) || 0;
          doctorShare = (Number(price) * percentage) / 100;
        }
      }

      totalAmount += Number(price);
      processedItems.push({
        clinic_id,
        doctor_id: doctor_id || null,
        service_id: service_id || null,
        price: Number(price),
        doctor_share: doctorShare,
      });
    }

    const discount = Number(discount_amount) || 0;
      if (!Number.isFinite(discount) || discount < 0 || discount > totalAmount) {
        throw new Error('قيمة الخصم غير صالحة');
      }
    const netAmount = totalAmount - discount;

    if (!['CASH', 'CARD', 'INSURANCE', 'SPLIT'].includes(payment_type || 'CASH')) {
      throw new Error('طريقة الدفع غير صالحة');
    }

    // 1. إدراج الفاتورة الرئيسية
    const invoiceResult = await client.query(
      `INSERT INTO invoices (patient_id, visit_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        patient_id,
        visit_id || null,
        receptionist_id,
        totalAmount,
        discount,
        netAmount,
        netAmount, // تم التحصيل بالكامل
        payment_type || 'CASH',
      ]
    );

    const invoiceId = invoiceResult.rows[0].invoice_id;

    // 2. إدراج عناصر الفاتورة مع حصص الأطباء
    for (const pItem of processedItems) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, clinic_id, doctor_id, service_id, price, doctor_share)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, pItem.clinic_id, pItem.doctor_id, pItem.service_id, pItem.price, pItem.doctor_share]
      );
    }

    await client.query('COMMIT');
    transactionActive = false;
    try {
      await pool.query('REFRESH MATERIALIZED VIEW mv_clinic_monthly_kpis');
    } catch (refreshError) {
      console.error('KPI refresh failed after invoice commit:', refreshError);
    }
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'INVOICE_CREATED', 'INVOICE', $3, $4)`,
        [receptionist_id, processedItems[0]?.clinic_id ?? req.user?.clinicId, invoiceId, JSON.stringify({ total: totalAmount, net: netAmount })]
      );
    } catch (auditError) {
      console.error('Invoice audit failed after commit:', auditError);
    }

    return res.status(201).json({
      message: 'تم إصدار الفاتورة وتحصيل المبلغ بنجاح',
      invoice_id: invoiceId,
      net_amount: netAmount,
    });
  } catch (error: any) {
    if (transactionActive) await client.query('ROLLBACK');
    console.error('Create Invoice Error:', error);
    return res.status(500).json({ message: error.message || 'حدث خطأ عند إصدار الفاتورة' });
  } finally {
    client.release();
  }
};

// 3. تسجيل مصروف جديد للمجمع أو للعيادة
export const createExpense = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, category, amount, description } = req.body;
  const spent_by_user_id = req.user?.userId;
  const targetClinicId = Number(clinic_id);

  if (!isFinanceUnrestricted(req)) {
    const allowedList = accessibleClinicIds(req) ?? [];
    const primaryClinic = req.user?.clinicId !== null && req.user?.clinicId !== undefined ? Number(req.user.clinicId) : null;
    const okClinic = (primaryClinic !== null && primaryClinic === targetClinicId) || allowedList.map(Number).includes(targetClinicId);
    if (!okClinic) {
      return res.status(403).json({ message: 'لا يمكنك تسجيل مصروف في عيادة غير مسندة لك' });
    }
  }
  if (!category || amount === undefined || !spent_by_user_id || !Number.isFinite(targetClinicId)) {
    return res.status(400).json({ message: 'بيانات المصروف غير مكتملة' });
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({ message: 'قيمة المصروف غير صالحة' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (clinic_id, category, amount, description, spent_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [clinic_id || null, category, amount, description || null, spent_by_user_id]
    );
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'EXPENSE_CREATED', 'EXPENSE', $3)`,
        [spent_by_user_id, clinic_id ?? req.user?.clinicId, result.rows[0].expense_id]
      );
    } catch (auditError) {
      console.error('Expense audit failed after commit:', auditError);
    }

    return res.status(201).json({
      message: 'تم تسجيل المصروف بنجاح',
      expense: result.rows[0],
    });
  } catch (error) {
    console.error('Create Expense Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل المصروف' });
  }
};

// 3ب. قائمة المصاريف مع اسم العيادة واسم الموظف الذي سجلها
export const listExpenses = async (req: AuthenticatedRequest, res: Response) => {
  const allowedClinics = isFinanceUnrestricted(req) ? null : accessibleClinicIds(req); // null = مدير/مالية مركزية يرى الجميع
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  try {
    if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
      return res.status(403).json({ message: 'لا يمكنك عرض مصاريف عيادة غير مسندة لك' });
    }
    const result = await pool.query(
      `SELECT e.expense_id, e.clinic_id, c.clinic_name, e.category, e.amount,
              e.description, e.created_at,
              e.spent_by_user_id, u.full_name AS spent_by_name
       FROM expenses e
       LEFT JOIN clinics c ON c.clinic_id = e.clinic_id
       LEFT JOIN users u ON u.user_id = e.spent_by_user_id
       WHERE ($1::int[] IS NULL OR e.clinic_id = ANY($1::int[]))
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

// 3ج. قائمة الفواتير مع أسماء المريض والعيادة والطبيب والخدمة (بدل الأرقام فقط)
export const listInvoices = async (req: AuthenticatedRequest, res: Response) => {
  const allowedClinics = isFinanceUnrestricted(req) ? null : accessibleClinicIds(req); // null = مدير/مالية مركزية يرى الجميع
  const filterClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const patientId = req.query.patient_id ? Number(req.query.patient_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  try {
    if (filterClinic && allowedClinics !== null && !allowedClinics.includes(filterClinic)) {
      return res.status(403).json({ message: 'لا يمكنك عرض فواتير عيادة غير مسندة لك' });
    }
    const result = await pool.query(
      `SELECT i.invoice_id, i.patient_id, p.full_name AS patient_name,
              i.visit_id, i.total_amount, i.discount_amount, i.net_amount,
              i.paid_amount, i.payment_type, i.created_at,
              ii.item_id, ii.clinic_id, c.clinic_name,
              ii.doctor_id, d.full_name AS doctor_name,
              ii.service_id, cs.service_name,
              ii.price, ii.doctor_share
       FROM invoices i
       JOIN patients p ON p.patient_id = i.patient_id
       LEFT JOIN invoice_items ii ON ii.invoice_id = i.invoice_id
       LEFT JOIN clinics c ON c.clinic_id = ii.clinic_id
       LEFT JOIN users d ON d.user_id = ii.doctor_id
       LEFT JOIN clinic_services cs ON cs.service_id = ii.service_id
       WHERE ($1::int[] IS NULL OR EXISTS (
               SELECT 1 FROM invoice_items x
               WHERE x.invoice_id = i.invoice_id AND x.clinic_id = ANY($1::int[])
             ))
         AND ($2::int IS NULL OR EXISTS (
               SELECT 1 FROM invoice_items y
               WHERE y.invoice_id = i.invoice_id AND y.clinic_id = $2
             ))
         AND ($3::int IS NULL OR i.patient_id = $3)
       ORDER BY i.invoice_id DESC, ii.item_id ASC
       LIMIT $4 OFFSET $5`,
      [allowedClinics, filterClinic, patientId, limit * 20, offset * 20]
    );
    // تجميع البنود تحت كل فاتورة لسهولة العرض بالاسماء
    const grouped = new Map<number, any>();
    for (const row of result.rows) {
      if (!grouped.has(row.invoice_id)) {
        grouped.set(row.invoice_id, {
          invoice_id: row.invoice_id,
          patient_id: row.patient_id,
          patient_name: row.patient_name,
          visit_id: row.visit_id,
          total_amount: row.total_amount,
          discount_amount: row.discount_amount,
          net_amount: row.net_amount,
          paid_amount: row.paid_amount,
          payment_type: row.payment_type,
          created_at: row.created_at,
          items: [],
        });
      }
      if (row.item_id) {
        grouped.get(row.invoice_id).items.push({
          item_id: row.item_id,
          clinic_id: row.clinic_id,
          clinic_name: row.clinic_name,
          doctor_id: row.doctor_id,
          doctor_name: row.doctor_name,
          service_id: row.service_id,
          service_name: row.service_name,
          price: row.price,
          doctor_share: row.doctor_share,
        });
      }
    }
    const invoices = [...grouped.values()].slice(0, limit);
    return res.status(200).json({ invoices, pagination: { page, limit, returned: invoices.length } });
  } catch (error) {
    console.error('List Invoices Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة الفواتير' });
  }
};

// 4. استرجاع التقرير المالي الشهرى واستعلام KPIs
export const getMonthlyFinancialKPIs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM mv_clinic_monthly_kpis
       WHERE ($1::int IS NULL OR clinic_id = $1)
       ORDER BY stat_month DESC`,
      [req.user?.clinicId]
    );

    return res.status(200).json({
      kpis: result.rows,
    });
  } catch (error) {
    console.error('Get Financial KPIs Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب التقارير المالية' });
  }
};