import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

// 1. حجز موعد جديد
export const createAppointment = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason, notes } = req.body;

  if (!clinic_id || !patient_id || !doctor_id || !appointment_date || !start_time || !end_time) {
    return res.status(400).json({ message: 'الرجاء توفير جميع البيانات الأساسية للحجز (العيادة، المريض، الطبيب، التاريخ، ووقت بداية ونهاية الموعد)' });
  }

  try {
    // التحقق من عدم وجود تعارض في مواعيد الطبيب لنفس اليوم والوقت
    const conflictCheck = await pool.query(
      `SELECT appointment_id FROM appointments 
       WHERE doctor_id = $1 
         AND appointment_date = $2 
         AND status NOT IN ('CANCELLED')
         AND (
           (start_time <= $3 AND end_time > $3) OR
           (start_time < $4 AND end_time >= $4) OR
           (start_time >= $3 AND end_time <= $4)
         )`,
      [doctor_id, appointment_date, start_time, end_time]
    );

    if (conflictCheck.rows.length > 0) {
      return res.status(409).json({ message: 'الطبيب لديه موعد آخر محجوز في هذا الوقت' });
    }

    const result = await pool.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SCHEDULED')
       RETURNING *`,
      [clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason || null, notes || null]
    );

    return res.status(201).json({
      message: 'تم حجز الموعد بنجاح',
      appointment: result.rows[0],
    });
  } catch (error) {
    console.error('Create Appointment Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء حجز الموعد' });
  }
};

// 2. استرجاع المواعيد مع إمكانية الفلترة
export const getAppointments = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, doctor_id, patient_id, date, status } = req.query;

  try {
    let queryText = `
      SELECT 
        a.*,
        p.full_name as patient_name,
        p.phone_number as patient_phone,
        u.full_name as doctor_name,
        c.clinic_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.patient_id
      JOIN users u ON a.doctor_id = u.user_id
      JOIN clinics c ON a.clinic_id = c.clinic_id
      WHERE 1=1
    `;

    const queryParams: any[] = [];
    let paramIndex = 1;

    if (clinic_id) {
      queryText += ` AND a.clinic_id = $${paramIndex++}`;
      queryParams.push(clinic_id);
    }

    if (doctor_id) {
      queryText += ` AND a.doctor_id = $${paramIndex++}`;
      queryParams.push(doctor_id);
    }

    if (patient_id) {
      queryText += ` AND a.patient_id = $${paramIndex++}`;
      queryParams.push(patient_id);
    }

    if (date) {
      queryText += ` AND a.appointment_date = $${paramIndex++}`;
      queryParams.push(date);
    }

    if (status) {
      queryText += ` AND a.status = $${paramIndex++}`;
      queryParams.push(status);
    }

    queryText += ` ORDER BY a.appointment_date DESC, a.start_time ASC`;

    const result = await pool.query(queryText, queryParams);

    return res.status(200).json({
      appointments: result.rows,
    });
  } catch (error) {
    console.error('Get Appointments Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب المواعيد' });
  }
};

// 3. تحديث حالة الموعد (CONFIRMED, COMPLETED, CANCELLED, NO_SHOW)
export const updateAppointmentStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, cancellation_reason } = req.body;

  const validStatuses = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ message: 'حالة الموعد غير صالحة' });
  }

  try {
    const result = await pool.query(
      `UPDATE appointments 
       SET status = $1, 
           cancellation_reason = COALESCE($2, cancellation_reason),
           updated_at = NOW()
       WHERE appointment_id = $3
       RETURNING *`,
      [status, cancellation_reason || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'الموعد غير موجود' });
    }

    return res.status(200).json({
      message: 'تم تحديث حالة الموعد بنجاح',
      appointment: result.rows[0],
    });
  } catch (error) {
    console.error('Update Appointment Status Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تحديث حالة الموعد' });
  }
};