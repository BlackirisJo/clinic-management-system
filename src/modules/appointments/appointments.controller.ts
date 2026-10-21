import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds } from '../../middlewares/auth.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { calendarGate, calendarGateMessage, isCalendarGateError } from '../calendar/calendar.gate';

// 1. حجز موعد جديد
export const createAppointment = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason, notes } = req.body;
  const userClinicIds = accessibleClinicIds(req);

    // التحقق المبدئي من حقول البيانات الأساسية
  if (!clinic_id || !patient_id || !doctor_id || !appointment_date) {
    return res.status(400).json({
      message: 'الرجاء توفير جميع البيانات الأساسية للحجز (العيادة، المريض، الطبيب، التاريخ)'
    });
  }

  // المستخدم المسند لعيادات متعددة يستطيع الحجز في أيٍّ منها (أو مديراً)
  if (userClinicIds !== null && !userClinicIds.includes(Number(clinic_id))) {
    return res.status(403).json({ message: 'لا يمكنك إنشاء موعد في عيادة غير مسندة لك' });
  }

  // فحص ترتيب الأوقات فقط إذا تم توفيرهما معاً
  if (start_time && end_time && end_time <= start_time) {
    return res.status(400).json({ message: 'وقت نهاية الموعد يجب أن يكون بعد وقت البداية' });
  }

  const client = await pool.connect();
  try {
    // المعاملة + قفل التقويم:
    // يُلتقط قفل (العيادة، اليوم) قبل فحص البوابة ولا يُفكّ قبل الإدراج، فلا يمكن
    // أن يمرّ حجز إلى تاريخ صار محجوباً في أثناء تصحيح عطلة (انزلاق الحجز).
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, (EXTRACT(EPOCH FROM $2::date) / 86400)::int)', [
      Number(clinic_id),
      appointment_date,
    ]);

    // أمن وسلامة البيانات: الطبيب المحدد يجب أن يكون حساباً نشطاً بدور DOCTOR ومسنداً لهذه العيادة
    // (أساسي أو إسناد إضافي) — لا يمكن حجز طبيب من عيادة أخرى.
    const doctorMembership = await client.query(
      `SELECT 1 FROM users u
       JOIN roles r ON r.role_id = u.role_id
       WHERE u.user_id = $1 AND u.status = 'ACTIVE' AND r.role_name = 'DOCTOR' AND (
         u.clinic_id = $2 OR EXISTS (SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $2)
       )`,
      [doctor_id, clinic_id]
    );
    if (!doctorMembership.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'الطبيب المحدد غير موجود أو غير مسند لهذه العيادة' });
    }

    // وصول المريض — إحدى الحالات الثلاث:
    // 1) المريض مملوك للعيادة نفسها (patients.clinic_id = العيادة الهدف).
    // 2) مشاركة WRITE نشطة إلى العيادة الهدف (patient_clinic_shares — كما هي دون تغيير).
    // 3) حالة المركز الطبي الداخلي: الموظف المسند لأكثر من عيادة داخل نفس المركز
    //    يعمل في العيادتين دون مشاركات — الحد الآمن (لا يوجد مفهوم "مركز" في المخطط):
    //    أن يكون عضواً في عيادة مالك المريض وفي العيادة الهدف معاً ضمن نطاقه
    //    (accessibleClinicIds = الأساسية + clinic_staff). المدراء (نطاق null) يبقى
    //    سلوكهم كما هو (ملكية أو مشاركة) دون توسيع.
    const ownership = await client.query(
      `SELECT p.clinic_id AS owner_clinic_id,
              EXISTS (SELECT 1 FROM patient_clinic_shares s
                      WHERE s.patient_id = p.patient_id AND s.target_clinic_id = $2
                        AND s.access_level = 'WRITE' AND s.status = 'ACTIVE' AND s.expires_at > NOW()) AS can_write
       FROM patients p
       WHERE p.patient_id = $1`,
      [patient_id, clinic_id]
    );
    const patientRow = ownership.rows[0];
    const targetClinicId = Number(clinic_id);
    const ownerClinicId = patientRow ? Number(patientRow.owner_clinic_id) : null;
    const sameOwnerClinic = Boolean(patientRow) && ownerClinicId === targetClinicId;
    const internalCenterCase = Boolean(patientRow) && !sameOwnerClinic
      && Array.isArray(userClinicIds)
      && userClinicIds.includes(ownerClinicId as number)
      && userClinicIds.includes(targetClinicId);
    if (!patientRow || (!sameOwnerClinic && !patientRow.can_write && !internalCenterCase)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'المريض غير مسجل في هذه العيادة أو غير مشارَك إليها' });
    }

    // بوابة التقويم: عطلة رسمية أو إجازة معتمدة تمنع الحجز.
    // الترتيب: الإجازة تتقدّم على العطل، ولا يتجاوز أيٌّ منهما جدول العمل الأسبوعي.
    // البوابة على مستوى التاريخ، فتسري حتى على الموعد بلا وقت.
    const gate = await calendarGate(client, targetClinicId, Number(doctor_id), appointment_date);
    if (gate.is_blocked) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: calendarGateMessage(gate.code),
        code: gate.code === 'LEAVE' ? ApiErrorCode.DOCTOR_LEAVE : ApiErrorCode.HOLIDAY_CLOSED,
        calendar_gate: gate,
      });
    }

    // التحقق من عدم وجود تعارض في مواعيد الطبيب لنفس اليوم والوقت (Overlapping Check)
    // يُنفَّذ فقط إذا تم توفير أوقات البداية والنهاية معاً
    if (start_time && end_time) {
      // Validate against doctor's working schedule
      // يوم الأسبوع يُحسب في قاعدة البيانات (EXTRACT DOW) لا في ذاكرة Node:
      // new Date('YYYY-MM-DD').getDay() كان ينزاح يوماً في المناطق الزمنية السالبة.
      const dayOfWeek = await client.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [appointment_date]);
      const workingSchedule = await client.query(
        `SELECT schedule_id, start_time, end_time FROM doctor_schedules
         WHERE doctor_id = $1 AND clinic_id = $2 AND day_of_week = $3 AND is_working_day = TRUE
         AND start_time <= $4::time AND end_time >= $5::time`,
        [doctor_id, clinic_id, dayOfWeek.rows[0]?.dow ?? 0, start_time, end_time]
      );

      if (!workingSchedule.rowCount || workingSchedule.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'الوقت المحدد خارج أوقات العمل الرسمية للطبيب' });
      }

      const conflictCheck = await client.query(
        `SELECT appointment_id FROM appointments
         WHERE doctor_id = $1
           AND clinic_id = $2
           AND appointment_date = $3
           AND status NOT IN ('CANCELLED')
           AND start_time IS NOT NULL AND end_time IS NOT NULL
           AND start_time < $5 AND end_time > $4`,
        [doctor_id, clinic_id, appointment_date, start_time, end_time]
      );

      if (conflictCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'الطبيب لديه موعد آخر محجوز يتداخل مع هذا الوقت' });
      }
    }

    // إدراج الحجز الجديد في قاعدة البيانات
    // (مُشغّل البوابة في قاعدة البيانات — ترحيل 059 — يطبّق القاعدة نفسها على أي كاتب)
    const result = await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SCHEDULED')
       RETURNING *`,
      [clinic_id, patient_id, doctor_id, appointment_date, start_time || null, end_time || null, reason || null, notes || null]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'تم حجز الموعد بنجاح',
      appointment: result.rows[0],
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    // رفض بوابة التقويم من مستوى قاعدة البيانات (يُعاد ترجمته إلى 409 لا 500)
    if (isCalendarGateError(error)) {
      const code = typeof error?.detail === 'string' && error.detail.startsWith('LEAVE')
        ? 'LEAVE'
        : 'HOLIDAY';
      return res.status(409).json({
        message: calendarGateMessage(code),
        code: code === 'LEAVE' ? ApiErrorCode.DOCTOR_LEAVE : ApiErrorCode.HOLIDAY_CLOSED,
      });
    }
    // تعارض زمني على مستوى القيد الحصري (23P01) — رفض تشغيلي لا عطل خادم
    if (error?.code === '23P01') {
      return res.status(409).json({
        message: 'الطبيب لديه موعد آخر محجوز يتداخل مع هذا الوقت',
        code: ApiErrorCode.CALENDAR_CONFLICT,
      });
    }
    console.error('خطأ أثناء إنشاء الموعد:', error);
    return res.status(500).json({ message: 'حدث خطأ داخلي أثناء حجز الموعد' });
  } finally {
    client.release();
  }
};

// 2. استرجاع المواعيد مع إمكانية الفلترة
export const getAppointments = async (req: AuthenticatedRequest, res: Response) => {
  const { clinic_id, doctor_id, patient_id, date, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const clinicIds = accessibleClinicIds(req);
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
      WHERE ($1::int[] IS NULL OR a.clinic_id = ANY($1::int[]))
    `;

    const queryParams: any[] = [clinicIds];
    let paramIndex = 2;

    if (clinic_id && (clinicIds === null || clinicIds.includes(Number(clinic_id)))) {
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
  const clinicIds = accessibleClinicIds(req);

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
      WHERE appointment_id = $3 AND ($4::int[] IS NULL OR clinic_id = ANY($4::int[]))
       RETURNING *`,
          [status, cancellation_reason || null, id, clinicIds]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'الموعد المطلوب غير موجود' });
    }
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'APPOINTMENT_STATUS_UPDATED', 'APPOINTMENT', $3, $4)`,
        [req.user?.userId, req.user?.clinicId, id, JSON.stringify({ status })]
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
