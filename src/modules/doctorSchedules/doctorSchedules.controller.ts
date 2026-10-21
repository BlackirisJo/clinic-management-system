import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds, canManageAllClinics } from '../../middlewares/auth.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { calendarGate, clinicLocalToday, createNotificationTasks, recordChange } from '../calendar/calendar.gate';

// سجل التدقيق: لا يبتلع الخطأ صامتاً (كان catch {} يُسقط مسار التدقيق بلا أثر).
// هنا صارت كتابة السجل **جزءاً من معاملة التغيير نفسها** (create/update/delete)،
// فلا يحدث جدول بلا سجل، ولا سجل بلا جدول، ولا يبقى تغيير بلا أثر.

const verifyDoctorClinicAccess = async (doctorId: number, clinicId: number, req: AuthenticatedRequest): Promise<boolean> => {
  const userClinicIds = accessibleClinicIds(req);
  if (userClinicIds !== null && !userClinicIds.includes(clinicId)) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1 FROM users u
     JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1 AND u.status = 'ACTIVE' AND r.role_name = 'DOCTOR' AND (
       u.clinic_id = $2 OR EXISTS (SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $2)
     )`,
    [doctorId, clinicId]
  );
  return (result.rowCount ?? 0) > 0;
};

export const createDoctorSchedule = async (req: AuthenticatedRequest, res: Response) => {
  const { doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day } = req.body;

  if (!await verifyDoctorClinicAccess(doctor_id, clinic_id, req)) {
    return res.status(403).json({ message: 'الطبيب غير مسند لهذه العيادة أو لا تملك صلاحية الوصول إليها' });
  }

  const client = await pool.connect();
  try {
    // الكتابة وسجل التدقيق في معاملة واحدة: لا جدول بلا سجل، ولا سجل بلا جدول.
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day ?? true]
    );

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'DOCTOR_SCHEDULE_CREATED', 'DOCTOR_SCHEDULE', $3, $4::jsonb)`,
      [
        req.user?.userId ?? null,
        clinic_id,
        String(result.rows[0].schedule_id),
        JSON.stringify({ doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day }),
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'تم إنشاء جدول العمل بنجاح',
      schedule: result.rows[0],
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ message: 'يوجد فترة عمل متداخلة لهذا الطبيب في نفس اليوم' });
    }
    // 23P01 = exclusion_violation: تداخل فترات العمل (القيد doctor_schedules_no_overlap)
    if (error.code === '23P01') {
      return res.status(409).json({
        message: 'يوجد فترة عمل متداخلة لهذا الطبيب في نفس اليوم',
        code: ApiErrorCode.CALENDAR_CONFLICT,
      });
    }
    console.error('Create Doctor Schedule Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء جدول العمل' });
  } finally {
    client.release();
  }
};

export const getDoctorSchedules = async (req: AuthenticatedRequest, res: Response) => {
  const { doctor_id, clinic_id, day_of_week } = req.query;
  const userClinicIds = accessibleClinicIds(req);

  try {
    let queryText = `
      SELECT
        ds.*,
        u.full_name as doctor_name,
        c.clinic_name
      FROM doctor_schedules ds
      JOIN users u ON u.user_id = ds.doctor_id
      JOIN clinics c ON c.clinic_id = ds.clinic_id
      WHERE ($1::int[] IS NULL OR ds.clinic_id = ANY($1::int[]))
    `;

    const queryParams: any[] = [userClinicIds];
    let paramIndex = 2;

    if (doctor_id) {
      queryText += ` AND ds.doctor_id = $${paramIndex++}`;
      queryParams.push(doctor_id);
    }

    if (clinic_id && (userClinicIds === null || userClinicIds.includes(Number(clinic_id)))) {
      queryText += ` AND ds.clinic_id = $${paramIndex++}`;
      queryParams.push(clinic_id);
    } else if (clinic_id) {
      return res.status(403).json({ message: 'لا يمكنك الوصول لجداول هذه العيادة' });
    }

    if (day_of_week !== undefined) {
      queryText += ` AND ds.day_of_week = $${paramIndex++}`;
      queryParams.push(day_of_week);
    }

    queryText += ` ORDER BY ds.doctor_id, ds.day_of_week, ds.start_time`;

    const result = await pool.query(queryText, queryParams);

    return res.status(200).json({
      schedules: result.rows,
    });
  } catch (error) {
    console.error('Get Doctor Schedules Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب جداول العمل' });
  }
};

export const getDoctorSchedule = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const userClinicIds = accessibleClinicIds(req);

  try {
    const result = await pool.query(
      `SELECT
         ds.*,
         u.full_name as doctor_name,
         c.clinic_name
       FROM doctor_schedules ds
       JOIN users u ON u.user_id = ds.doctor_id
       JOIN clinics c ON c.clinic_id = ds.clinic_id
       WHERE ds.schedule_id = $1 AND ($2::int[] IS NULL OR ds.clinic_id = ANY($2::int[]))`,
      [id, userClinicIds]
    );

    if (!result.rowCount || result.rowCount === 0) {
      return res.status(404).json({ message: 'جدول العمل غير موجود' });
    }

    return res.status(200).json({ schedule: result.rows[0] });
  } catch (error) {
    console.error('Get Doctor Schedule Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب جدول العمل' });
  }
};

export const updateDoctorSchedule = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { start_time, end_time, is_working_day, confirm_impact } = req.body;
  const userClinicIds = accessibleClinicIds(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT ds.*, u.full_name as doctor_name
       FROM doctor_schedules ds
       JOIN users u ON u.user_id = ds.doctor_id
       WHERE ds.schedule_id = $1 AND ($2::int[] IS NULL OR ds.clinic_id = ANY($2::int[]))`,
      [id, userClinicIds]
    );

    if (!current.rowCount || current.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'جدول العمل غير موجود' });
    }

    const schedule = current.rows[0];
    const newStartTime = start_time ?? schedule.start_time;
    const newEndTime = end_time ?? schedule.end_time;
    const newIsWorkingDay = is_working_day ?? schedule.is_working_day;

    if (newEndTime <= newStartTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'وقت النهاية يجب أن يكون بعد وقت البداية' });
    }

    // أثر تضييق نافذة العمل: المواعيد القائمة التي صارت خارج النافذة.
    // لا يُلغى أي موعد ولا يُحذف — يُعرض الأثر ويطلب تأكيداً صريحاً.
    const narrowsWindow =
      !newIsWorkingDay ||
      newStartTime > schedule.start_time ||
      newEndTime < schedule.end_time ||
      schedule.is_working_day !== newIsWorkingDay;

    let impact: { appointments: any[]; appointment_count: number } = { appointments: [], appointment_count: 0 };
    if (narrowsWindow) {
      // "اليوم" بتاريخ العيادة (منطقتها الزمنية) لا بتاريخ خادم قاعدة البيانات:
      // CURRENT_DATE ينزاح ساعةً عند منتصف الليل الزمني فيحسب مواعيد اليوم
      // بشكل مختلف حسب توقيت الخادم. التاريخ يُحسب مرة واحدة ويُمرَّر.
      const today = await clinicLocalToday(client, Number(schedule.clinic_id));
      const affected = await client.query(
        `SELECT a.appointment_id, a.appointment_date, a.start_time, a.end_time, a.status, a.patient_id
         FROM appointments a
         WHERE a.doctor_id = $1 AND a.clinic_id = $2
           AND a.status <> 'CANCELLED'
           AND EXTRACT(DOW FROM a.appointment_date)::int = $3
           AND a.appointment_date >= $7::date
           AND (
                $4::boolean = FALSE
                OR a.start_time IS NULL
                OR a.start_time < $5::time
                OR a.end_time > $6::time
           )
         ORDER BY a.appointment_date, a.start_time
         LIMIT 200`,
        [schedule.doctor_id, schedule.clinic_id, schedule.day_of_week, !newIsWorkingDay, newStartTime, newEndTime, today]
      );
      impact = { appointments: affected.rows, appointment_count: affected.rowCount ?? 0 };

      if (impact.appointment_count > 0 && confirm_impact !== true) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'تعديل جدول العمل يؤثر على مواعيد قائمة — يلزم تأكيد صريح',
          code: ApiErrorCode.IMPACT_CONFIRMATION_REQUIRED,
          impact,
        });
      }
    }

    const result = await client.query(
      `UPDATE doctor_schedules
       SET start_time = $1, end_time = $2, is_working_day = $3, updated_at = NOW()
       WHERE schedule_id = $4
       RETURNING *`,
      [newStartTime, newEndTime, newIsWorkingDay, id]
    );

    // السجلّ التقويمي: من نفّذ التغيير، وماذا تغيّر، وأثره على المواعيد القائمة.
    // يُكتب في نفس معاملة التغيير: تغيير بلا سجل لا يحدث.
    const changeId = await recordChange(client, {
      change_type: 'SCHEDULE_CHANGED',
      entity_type: 'DOCTOR_SCHEDULE',
      entity_id: Number(id),
      clinic_id: Number(schedule.clinic_id),
      from_date: null,
      to_date: null,
      decision: 'CONFIRMED',
      impact: {
        doctor_id: schedule.doctor_id,
        day_of_week: schedule.day_of_week,
        old: { start_time: schedule.start_time, end_time: schedule.end_time, is_working_day: schedule.is_working_day },
        new: { start_time: newStartTime, end_time: newEndTime, is_working_day: newIsWorkingDay },
        appointment_count: impact.appointment_count,
      },
      performed_by_user_id: req.user?.userId ?? null,
      notification_status: impact.appointment_count > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
    });

    if (impact.appointment_count > 0) {
      await createNotificationTasks(
        client,
        changeId,
        impact.appointments.map((appointment: any) => ({
          appointment_id: Number(appointment.appointment_id),
          clinic_id: Number(schedule.clinic_id),
          patient_id: Number(appointment.patient_id),
          doctor_id: Number(schedule.doctor_id),
          start_time: appointment.start_time ?? null,
          end_time: appointment.end_time ?? null,
          status: String(appointment.status),
        })),
        req.user?.userId ?? null,
        `تغيّرت نافذة عمل الطبيب في ${schedule.day_of_week}`
      );
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'DOCTOR_SCHEDULE_UPDATED', 'DOCTOR_SCHEDULE', $3, $4::jsonb)`,
      [
        req.user?.userId ?? null,
        Number(schedule.clinic_id),
        String(id),
        JSON.stringify({
          doctor_id: schedule.doctor_id,
          old_start_time: schedule.start_time,
          old_end_time: schedule.end_time,
          old_is_working_day: schedule.is_working_day,
          new_start_time: newStartTime,
          new_end_time: newEndTime,
          new_is_working_day: newIsWorkingDay,
          impact: { appointments: impact.appointment_count },
        }),
      ]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'تم تحديث جدول العمل بنجاح',
      schedule: result.rows[0],
      impact,
      notification_status: impact.appointment_count > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ message: 'يوجد فترة عمل متداخلة لهذا الطبيب في نفس اليوم' });
    }
    // 23P01 = exclusion_violation: تداخل فترات العمل (القيد doctor_schedules_no_overlap)
    if (error.code === '23P01') {
      return res.status(409).json({
        message: 'يوجد فترة عمل متداخلة لهذا الطبيب في نفس اليوم',
        code: ApiErrorCode.CALENDAR_CONFLICT,
      });
    }
    console.error('Update Doctor Schedule Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تحديث جدول العمل' });
  } finally {
    client.release();
  }
};

export const deleteDoctorSchedule = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const userClinicIds = accessibleClinicIds(req);

  try {
    const current = await pool.query(
      `SELECT ds.*, u.full_name as doctor_name
       FROM doctor_schedules ds
       JOIN users u ON u.user_id = ds.doctor_id
       WHERE ds.schedule_id = $1 AND ($2::int[] IS NULL OR ds.clinic_id = ANY($2::int[]))`,
      [id, userClinicIds]
    );

    if (!current.rowCount || current.rowCount === 0) {
      return res.status(404).json({ message: 'جدول العمل غير موجود' });
    }

    const schedule = current.rows[0];

    // الحذف وسجل التدقيق في معاملة واحدة.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM doctor_schedules WHERE schedule_id = $1', [id]);
      await client.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'DOCTOR_SCHEDULE_DELETED', 'DOCTOR_SCHEDULE', $3, $4::jsonb)`,
        [
          req.user?.userId ?? null,
          schedule.clinic_id,
          String(id),
          JSON.stringify({
            doctor_id: schedule.doctor_id,
            day_of_week: schedule.day_of_week,
            start_time: schedule.start_time,
            end_time: schedule.end_time,
          }),
        ]
      );
      await client.query('COMMIT');
    } catch (auditError) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('Delete Doctor Schedule (audit) Error:', auditError);
      return res.status(500).json({ message: 'حدث خطأ أثناء حذف جدول العمل' });
    } finally {
      client.release();
    }

    return res.status(200).json({ message: 'تم حذف جدول العمل بنجاح' });
  } catch (error) {
    console.error('Delete Doctor Schedule Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء حذف جدول العمل' });
  }
};

export const getDoctorAvailability = async (req: AuthenticatedRequest, res: Response) => {
  const { doctor_id, clinic_id, date } = req.query;
  const userClinicIds = accessibleClinicIds(req);

  if (!doctor_id || !clinic_id || !date) {
    return res.status(400).json({ message: 'يرجى توفير معرف الطبيب، العيادة، والتاريخ' });
  }

  if (userClinicIds !== null && !userClinicIds.includes(Number(clinic_id))) {
    return res.status(403).json({ message: 'لا يمكنك الوصول لجداول هذه العيادة' });
  }

  const doctorAccess = await pool.query(
    `SELECT 1 FROM users u
     JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1 AND u.status = 'ACTIVE' AND r.role_name = 'DOCTOR' AND (
       u.clinic_id = $2 OR EXISTS (SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $2)
     )`,
    [Number(doctor_id), Number(clinic_id)]
  );

    if (!doctorAccess.rowCount || doctorAccess.rowCount === 0) {
    return res.status(400).json({ message: 'الطبيب غير مسند لهذه العيادة' });
  }

  // يوم الأسبوع يُحسب في قاعدة البيانات (EXTRACT DOW) لا في ذاكرة Node:
  // new Date('YYYY-MM-DD').getDay() كان ينزاح يوماً كاملاً في المناطق الزمنية السالبة.
  const dayOfWeekResult = await pool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [date]);
  const dayOfWeek = dayOfWeekResult.rows[0]?.dow ?? 0;

  try {
    const schedules = await pool.query(
      `SELECT schedule_id, start_time, end_time, is_working_day
       FROM doctor_schedules
       WHERE doctor_id = $1 AND clinic_id = $2 AND day_of_week = $3 AND is_working_day = TRUE
       ORDER BY start_time`,
      [doctor_id, clinic_id, dayOfWeek]
    );

    const existingAppointments = await pool.query(
      `SELECT appointment_id, start_time, end_time, status, patient_id
       FROM appointments
       WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3 AND status NOT IN ('CANCELLED')
       ORDER BY start_time`,
      [doctor_id, clinic_id, date]
    );

    // حالة التقويم لهذا اليوم: عطلة / إجازة / استثناء عمل.
    // مصدر الحقيقة دالة calendar_gate في قاعدة البيانات (نفس التي تستخدمها الحجز).
    const client = await pool.connect();
    let gate: { is_blocked: boolean; code: string | null; detail: string | null };
    let holidayInfo: { holiday_id: number; name_ar: string; scope: string } | null = null;
    let leaveInfo: { leave_id: number; start_date: string; end_date: string } | null = null;
    let exceptionInfo: { exception_id: number; reason: string } | null = null;
    try {
      gate = await calendarGate(client, Number(clinic_id), Number(doctor_id), date as string);
      const holiday = await client.query(
        `SELECT holiday_id, name_ar, clinic_id FROM clinic_holidays
         WHERE status = 'ACTIVE' AND holiday_date = $1::date AND (clinic_id IS NULL OR clinic_id = $2)
         ORDER BY clinic_id NULLS LAST LIMIT 1`,
        [date, Number(clinic_id)]
      );
      if (holiday.rows[0]) {
        holidayInfo = {
          holiday_id: Number(holiday.rows[0].holiday_id),
          name_ar: String(holiday.rows[0].name_ar),
          scope: holiday.rows[0].clinic_id === null ? 'NATIONAL' : 'CLINIC',
        };
      }
      const leave = await client.query(
        `SELECT leave_id, start_date, end_date FROM doctor_leave
         WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'APPROVED'
           AND start_date <= $3::date AND end_date >= $3::date
         LIMIT 1`,
        [Number(doctor_id), Number(clinic_id), date]
      );
      if (leave.rows[0]) {
        leaveInfo = {
          leave_id: Number(leave.rows[0].leave_id),
          start_date: String(leave.rows[0].start_date),
          end_date: String(leave.rows[0].end_date),
        };
      }
      const exception = await client.query(
        `SELECT exception_id, reason FROM work_exceptions
         WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'APPROVED' AND exception_date = $3::date
         LIMIT 1`,
        [Number(doctor_id), Number(clinic_id), date]
      );
      if (exception.rows[0]) {
        exceptionInfo = {
          exception_id: Number(exception.rows[0].exception_id),
          reason: String(exception.rows[0].reason),
        };
      }
    } finally {
      client.release();
    }

    const workingPeriods = schedules.rows.map(row => ({
      schedule_id: row.schedule_id,
      start_time: row.start_time,
      end_time: row.end_time,
    }));

    const bookedSlots = existingAppointments.rows
      .filter(a => a.start_time && a.end_time)
      .map(row => ({
        appointment_id: row.appointment_id,
        start_time: row.start_time,
        end_time: row.end_time,
        status: row.status,
        patient_id: row.patient_id,
      }));

    const availableSlots: Array<{ start_time: string; end_time: string; is_booked: boolean; appointment_id?: number }> = [];

    for (const period of workingPeriods) {
      const periodStart = period.start_time;
      const periodEnd = period.end_time;

      const slotDuration = 30; // 30-minute slots (could be configurable)
      const [startHour, startMin] = periodStart.split(':').map(Number);
      const [endHour, endMin] = periodEnd.split(':').map(Number);
      const startMinutes = startHour * 60 + startMin;
      const endMinutes = endHour * 60 + endMin;

      for (let m = startMinutes; m + slotDuration <= endMinutes; m += slotDuration) {
        const slotStart = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const slotEnd = `${String(Math.floor((m + slotDuration) / 60)).padStart(2, '0')}:${String((m + slotDuration) % 60).padStart(2, '0')}`;

        const conflictingAppointment = bookedSlots.find(b =>
          b.start_time < slotEnd && b.end_time > slotStart
        );

        availableSlots.push({
          start_time: slotStart,
          end_time: slotEnd,
          is_booked: !!conflictingAppointment,
          appointment_id: conflictingAppointment?.appointment_id,
        });
      }
    }

    return res.status(200).json({
      doctor_id: Number(doctor_id),
      clinic_id: Number(clinic_id),
      date,
      day_of_week: dayOfWeek,
      working_periods: workingPeriods,
      // في يوم مغلق لا تُعرض خانات قابلة للحجز إطلاقاً.
      available_slots: gate.is_blocked ? [] : availableSlots,
      booked_appointments: bookedSlots,
      calendar_state: {
        holiday: holidayInfo,
        leave: leaveInfo,
        exception: exceptionInfo,
        blocked: gate.is_blocked,
        block_code: gate.code,
        block_detail: gate.detail,
      },
    });
  } catch (error) {
    console.error('Get Doctor Availability Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب المواعيد المتاحة' });
  }
};

export const getDoctorWeeklySchedule = async (req: AuthenticatedRequest, res: Response) => {
  const { doctor_id, clinic_id } = req.query;
  const userClinicIds = accessibleClinicIds(req);

  if (!doctor_id || !clinic_id) {
    return res.status(400).json({ message: 'يرجى توفير معرف الطبيب والعيادة' });
  }

  if (userClinicIds !== null && !userClinicIds.includes(Number(clinic_id))) {
    return res.status(403).json({ message: 'لا يمكنك الوصول لجداول هذه العيادة' });
  }

  try {
    const schedules = await pool.query(
      `SELECT schedule_id, day_of_week, start_time, end_time, is_working_day
       FROM doctor_schedules
       WHERE doctor_id = $1 AND clinic_id = $2
       ORDER BY day_of_week, start_time`,
      [doctor_id, clinic_id]
    );

    const daysOfWeek = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const weeklySchedule = daysOfWeek.map((dayName, index) => {
      const daySchedules = schedules.rows.filter(s => s.day_of_week === index);
      return {
        day_of_week: index,
        day_name_ar: dayName,
        day_name_en: dayNamesEn[index],
        is_working_day: daySchedules.some(s => s.is_working_day),
        periods: daySchedules.filter(s => s.is_working_day).map(s => ({
          schedule_id: s.schedule_id,
          start_time: s.start_time,
          end_time: s.end_time,
        })),
      };
    });

    return res.status(200).json({
      doctor_id: Number(doctor_id),
      clinic_id: Number(clinic_id),
      weekly_schedule: weeklySchedule,
    });
  } catch (error) {
    console.error('Get Doctor Weekly Schedule Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب الجدول الأسبوعي' });
  }
};