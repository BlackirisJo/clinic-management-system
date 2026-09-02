import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

// 1. إضافة مريض جديد
export const createPatient = async (req: AuthenticatedRequest, res: Response) => {
  const { full_name, national_id, phone, gender, date_of_birth } = req.body;

  if (!full_name || !phone || !gender || !date_of_birth) {
    return res.status(400).json({ message: 'الرجاء تقديم كافة البيانات المطلوبة للمريض' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO patients (full_name, national_id, phone, gender, date_of_birth)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [full_name, national_id || null, phone, gender, date_of_birth]
    );

    return res.status(201).json({
      message: 'تم إضافة المريض بنجاح',
      patient: result.rows[0],
    });
  } catch (error: any) {
    if (error.code === '23505') { // Unique constraint error (e.g., national_id)
      return res.status(409).json({ message: 'الرقم الوطني مسجل لمريض آخر بالفعل' });
    }
    console.error('Create Patient Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إضافة المريض' });
  }
};

// 2. البحث واسترجاع قائمة المرضى
export const getPatients = async (req: AuthenticatedRequest, res: Response) => {
  const { search } = req.query;

  try {
    let query = 'SELECT * FROM patients';
    const params: any[] = [];

    if (search) {
      query += ` WHERE full_name ILIKE $1 OR phone ILIKE $1 OR national_id ILIKE $1`;
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await pool.query(query, params);

    return res.status(200).json({
      patients: result.rows,
    });
  } catch (error) {
    console.error('Get Patients Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع قائمة المرضى' });
  }
};

// 3. تسجيل زيارة جديدة للمريض
export const createVisit = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, clinic_id, doctor_id, notes } = req.body;

  if (!patient_id || !clinic_id || !doctor_id) {
    return res.status(400).json({ message: 'بيانات الزيارة غير مكتملة (المريض، العيادة، الطبيب)' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO visits (patient_id, clinic_id, doctor_id, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [patient_id, clinic_id, doctor_id, notes || null]
    );

    return res.status(201).json({
      message: 'تم تسجيل الزيارة بنجاح',
      visit: result.rows[0],
    });
  } catch (error) {
    console.error('Create Visit Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الزيارة' });
  }
};

// 4. استرجاع السجل الطبي لزيارات مريض معين
export const getPatientVisits = async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;

  try {
    const result = await pool.query(
      `SELECT v.visit_id, v.visit_date, v.notes, c.clinic_name, u.full_name AS doctor_name
       FROM visits v
       JOIN clinics c ON v.clinic_id = c.clinic_id
       JOIN users u ON v.doctor_id = u.user_id
       WHERE v.patient_id = $1
       ORDER BY v.visit_date DESC`,
      [patientId]
    );

    return res.status(200).json({
      visits: result.rows,
    });
  } catch (error) {
    console.error('Get Patient Visits Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند استرجاع زيارات المريض' });
  }
};