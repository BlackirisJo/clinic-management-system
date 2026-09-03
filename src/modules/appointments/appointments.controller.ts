import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

// 1. حجز موعد جديد
export const createAppointment = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason, notes } = req.body;
  const userClinicId = req.user?.clinicId;

  // التحقق المبدئي من حقول البيانات الأساسية
  if (!clinic_id || !patient_id || !doctor_id || !appointment_date || !start_time || !end_time) {
    return res.status(400).json({ 
      message: 'الرجاء توفير جميع البيانات الأساسية للحجز (العيادة، المريض، الطبيب، التاريخ، ووقت بداية ونهاية الموعد)' 
    });
  }

  if (userClinicId !== null && userClinicId !== clinic_id) {
    return res.status(403).json({ message: 'لا يمكنك إنشاء موعد في عيادة أخرى' });
  }

  if (end_time <= start_time) {
    return res.status(400).json({ message: 'وقت نهاية الموعد يجب أن يكون بعد وقت البداية' });
  }

  try {
    // التحقق من عدم وجود تعارض في مواعيد الطبيب لنفس اليوم والوقت (Overlapping Check)
    const conflictCheck = await pool.query(
      `SELECT appointment_id FROM appointments 
       WHERE doctor_id = $1 
        AND clinic_id = $2
        AND appointment_date = $3
         AND status NOT IN ('CANCELLED')
        AND start_time < $5 AND end_time > $4`,
      [doctor_id, clinic_id, appointment_date, start_time, end_time]
    );

    if (conflictCheck.rows.length > 0) {
      return res.status(409).json({ message: 'الطبيب لديه موعد آخر محجوز يتداخل مع هذا الوقت' });
    }

    // إدراج الحجز الجديد في قاعدة البيانات
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
    console.error('خطأ أثناء إنشاء الموعد:', error);
    return res.status(500).json({ message: 'حدث خطأ داخلي أثناء حجز الموعد' });
  }
};

// 2. استرجاع المواعيد مع إمكانية الفلترة
export const getAppointments = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, doctor_id, patient_id, date, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    let queryText = `
      SELECT 
        a.*,
        p.full_name as patient_name,
        p.phone as patient_phone,
        u.full_name as doctor_name,
        c.clinic_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.patient_id
      JOIN users u ON a.doctor_id = u.user_id
      JOIN clinics c ON a.clinic_id = c.clinic_id
      WHERE ($1::int IS NULL OR a.clinic_id = $1)
    `;

    const queryParams: any[] = [req.user?.clinicId];
    let paramIndex = 2;

    if (clinic_id && (req.user?.clinicId === null || Number(clinic_id) === req.user?.clinicId)) {
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

    queryText += ` ORDER BY a.appointment_date DESC, a.start_time ASC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    queryParams.push(limit, offset);

    const result = await pool.query(queryText, queryParams);

    return res.status(200).json({
      appointments: result.rows,
      pagination: { page, limit, returned: result.rows.length },
    });
  } catch (error) {
    console.error('خطأ أثناء جلب المواعيد:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة المواعيد' });
  }
};

// 3. تحديث حالة الموعد (SCHEDULED, CONFIRMED, COMPLETED, CANCELLED, NO_SHOW)
export const updateAppointmentStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, cancellation_reason } = req.body;
  const userClinicId = req.user?.clinicId;

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
      WHERE appointment_id = $3 AND ($4::int IS NULL OR clinic_id = $4)
       RETURNING *`,
          [status, cancellation_reason || null, id, userClinicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'الموعد المطلوب غير موجود' });
    }
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'APPOINTMENT_STATUS_UPDATED', 'APPOINTMENT', $3, $4)`,
        [req.user?.userId, userClinicId, id, JSON.stringify({ status })]
      );
    } catch (auditError) {
      console.error('Appointment audit failed after commit:', auditError);
    }

    return res.status(200).json({
      message: 'تم تحديث حالة الموعد بنجاح',
      appointment: result.rows[0],
    });
  } catch (error) {
    console.error('خطأ أثناء تحديث حالة الموعد:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تحديث حالة الموعد' });
  }
};