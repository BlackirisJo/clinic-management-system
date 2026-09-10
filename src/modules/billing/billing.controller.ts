import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds } from '../../middlewares/auth.middleware';

// 1. إضافة خدمة عيادة جديدة وتحديد سعرها ونسبة الطبيب
export const createClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, service_name, price, doctor_percentage } = req.body;
  const userClinicId = req.user?.clinicId;

  if (!clinic_id || !service_name || price === undefined) {
    return res.status(400).json({ message: 'الرجاء توفير بيانات الخدمة كاملة (العيادة، الاسم، السعر)' });
  }
  const canManage = req.user?.roleName === 'SUPER_ADMIN' || req.user?.roleName === 'SYSTEM_ADMIN';
  if (!canManage && userClinicId !== clinic_id && !(req.user?.clinicIds ?? []).includes(Number(clinic_id))) {
    return res.status(403).json({ message: 'لا يمكنك إنشاء خدمة في عيادة غير مسندة لك' });
  }
  if (!Number.isFinite(Number(price)) || Number(price) < 0 || Number(doctor_percentage ?? 0) < 0 || Number(doctor_percentage ?? 0) > 100) {
    return res.status(400).json({ message: 'السعر أو نسبة الطبيب غير صالحة' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO clinic_services (clinic_id, service_name, price, doctor_percentage)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [clinic_id, service_name, price, doctor_percentage || 0]
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

// 2. إصدار فاتورة جديدة للمريض وحساب حصة الطبيب (Atomic Transaction)
export const createInvoice = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, visit_id, items, discount_amount, payment_type } = req.body;
  const receptionist_id = req.user?.userId;
  const allowedClinics = accessibleClinicIds(req); // null = مدير يرى الجميع
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
  const allowedClinics = accessibleClinicIds(req);
  const isAdmin = allowedClinics === null;

  const clinicAllowed = isAdmin || (clinic_id && (allowedClinics ?? []).includes(Number(clinic_id)));
  if (!category || amount === undefined || !spent_by_user_id || !clinicAllowed) {
    return res.status(400).json({ message: 'بيانات المصروف غير مكتملة أو العيادة غير مسندة لك' });
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