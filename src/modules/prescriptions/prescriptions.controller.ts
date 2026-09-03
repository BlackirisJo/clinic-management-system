import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

// 1. إضافة دواء جديد إلى الدليل الشامل للأدوية
export const createMedication = async (req: AuthenticatedRequest, res: Response) => {
  const { trade_name, scientific_name, default_dosage, instructions } = req.body;

  if (!trade_name || !scientific_name) {
    return res.status(400).json({ message: 'الاسم التجاري والاسم العلمي مطلوبان لإضافة الدواء' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO medications (trade_name, scientific_name, default_dosage, instructions)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [trade_name, scientific_name, default_dosage || null, instructions || null]
    );

    return res.status(201).json({
      message: 'تم إضافة الدواء إلى القائمة بنجاح',
      medication: result.rows[0],
    });
  } catch (error) {
    console.error('Create Medication Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم أثناء إضافة الدواء' });
  }
};

// 2. البحث عن الأدوية في الدليل
export const getMedications = async (req: AuthenticatedRequest, res: Response) => {
  const { search } = req.query;

  try {
    let query = 'SELECT * FROM medications';
    const params: any[] = [];

    if (search) {
      query += ` WHERE trade_name ILIKE $1 OR scientific_name ILIKE $1`;
      params.push(`%${search}%`);
    }

    query += ' ORDER BY trade_name ASC LIMIT 50';

    const result = await pool.query(query, params);

    return res.status(200).json({
      medications: result.rows,
    });
  } catch (error) {
    console.error('Get Medications Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم أثناء البحث عن الأدوية' });
  }
};

// 3. إنشاء روشتة طبية مع عناصرها (Atomic Transaction)
export const createPrescription = async (req: AuthenticatedRequest, res: Response) => {
  const { visit_id, patient_id, notes, items } = req.body;
  const doctor_id = req.user?.userId;
  const clinic_id = req.user?.clinicId;

  if (!visit_id || !patient_id || !doctor_id || clinic_id === null || clinic_id === undefined || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'بيانات الروشتة غير مكتملة أو لا تحتوي على أدوبة' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const visitOwnership = await client.query(
      `SELECT 1 FROM visits WHERE visit_id = $1 AND patient_id = $2 AND clinic_id = $3 AND doctor_id = $4`,
      [visit_id, patient_id, clinic_id, doctor_id]
    );
    if (visitOwnership.rows.length !== 1) {
      throw new Error('الزيارة لا تنتمي إلى المريض أو العيادة أو الطبيب الحالي');
    }

    // إنشاء السجل الرئيسي للروشتة
    const prescriptionResult = await client.query(
      `INSERT INTO prescriptions (visit_id, patient_id, doctor_id, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [visit_id, patient_id, doctor_id, notes || null]
    );

    const prescriptionId = prescriptionResult.rows[0].prescription_id;

    // إضافة أدوية الروشتة
    for (const item of items) {
      const { medication_id, dosage, frequency, duration, timing_instructions, repeats_count } = item;

      if (!medication_id || !dosage || !frequency || !duration) {
        throw new Error('بيانات الدواء في الروشتة غير مكتملة');
      }

      await client.query(
        `INSERT INTO prescription_items 
         (prescription_id, medication_id, dosage, frequency, duration, timing_instructions, repeats_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          prescriptionId,
          medication_id,
          dosage,
          frequency,
          duration,
          timing_instructions || null,
          repeats_count || 1,
        ]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'تم إنشاء الروشتة بنجاح',
      prescription_id: prescriptionId,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create Prescription Error:', error);
    return res.status(500).json({ message: error.message || 'حدث خطأ أثناء إنتاج الروشتة' });
  } finally {
    client.release();
  }
};

// 4. جلب تفاصيل الروشتة للطباعة والمراجعة
export const getPrescriptionById = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const prescriptionQuery = await pool.query(
      `SELECT p.prescription_id, p.created_at, p.notes,
              pt.full_name AS patient_name, pt.gender, pt.date_of_birth,
              u.full_name AS doctor_name, u.sub_specialty, u.medical_license_no
       FROM prescriptions p
       JOIN patients pt ON p.patient_id = pt.patient_id
       JOIN users u ON p.doctor_id = u.user_id
      JOIN visits v ON p.visit_id = v.visit_id
      WHERE p.prescription_id = $1 AND v.clinic_id = $2`,
          [id, req.user?.clinicId]
    );

    if (prescriptionQuery.rows.length === 0) {
      return res.status(404).json({ message: 'الروشتة المطلوبة غير موجودة' });
    }

    const itemsQuery = await pool.query(
      `SELECT pi.item_id, pi.dosage, pi.frequency, pi.duration, pi.timing_instructions, pi.repeats_count,
              m.trade_name, m.scientific_name
       FROM prescription_items pi
       JOIN medications m ON pi.medication_id = m.medication_id
       WHERE pi.prescription_id = $1`,
      [id]
    );

    return res.status(200).json({
      prescription: prescriptionQuery.rows[0],
      items: itemsQuery.rows,
    });
  } catch (error) {
    console.error('Get Prescription Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند جلب بيانات الروشتة' });
  }
};