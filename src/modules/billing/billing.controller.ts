import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

// 1. إضافة خدمة عيادة جديدة وتحديد سعرها ونسبة الطبيب
export const createClinicService = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, service_name, price, doctor_percentage } = req.body;

  if (!clinic_id || !service_name || price === undefined) {
    return res.status(400).json({ message: 'الرجاء توفير بيانات الخدمة كاملة (العيادة، الاسم، السعر)' });
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

  if (!patient_id || !receptionist_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'بيانات الفاتورة غير مكتملة أو لا تحتوي على عناصر' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

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

      if (!clinic_id || price === undefined) {
        throw new Error('بيانات عنصر الفاتورة غير مكتملة');
      }

      let doctorShare = 0;

      // حساب حصة الطبيب إذا تم اختيار خدمة محددة وطبيب
      if (service_id && doctor_id) {
        const serviceQuery = await client.query(
          'SELECT doctor_percentage FROM clinic_services WHERE service_id = $1',
          [service_id]
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
    const netAmount = totalAmount - discount;

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

    return res.status(201).json({
      message: 'تم إصدار الفاتورة وتحصيل المبلغ بنجاح',
      invoice_id: invoiceId,
      net_amount: netAmount,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
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

  if (!category || amount === undefined || !spent_by_user_id) {
    return res.status(400).json({ message: 'بيانات المصروف غير مكتملة' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (clinic_id, category, amount, description, spent_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [clinic_id || null, category, amount, description || null, spent_by_user_id]
    );

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
      `SELECT * FROM mv_clinic_monthly_kpis ORDER BY stat_month DESC`
    );

    return res.status(200).json({
      kpis: result.rows,
    });
  } catch (error) {
    console.error('Get Financial KPIs Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب التقارير المالية' });
  }
};