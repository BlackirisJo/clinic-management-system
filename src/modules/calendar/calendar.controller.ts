import { Response } from 'express';
import { PoolClient } from 'pg';
import { ZodType } from 'zod';
import { pool } from '../../config/database';
import {
  AuthenticatedRequest,
  accessibleClinicIds,
  canManageAllClinics,
} from '../../middlewares/auth.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { dateRange, isValidIsoDate } from '../../utils/calendarTime';
import {
  ImpactReport,
  calendarGate,
  clinicsForHolidayScope,
  computeImpact,
  createNotificationTasks,
  lockCalendarDays,
  recordChange,
  skipPendingTasks,
} from './calendar.gate';
import {
  cancelHolidaySchema,
  createExceptionSchema,
  createHolidaySchema,
  createLeaveSchema,
  decideExceptionSchema,
  decideLeaveSchema,
  impactQuerySchema,
  holidayImpactQuerySchema,
  listExceptionsQuerySchema,
  listHolidaysQuerySchema,
  listLeaveQuerySchema,
  listNotificationsQuerySchema,
  updateHolidaySchema,
} from './calendar.validation';

// ============================================================================
// تقويم العطل الرسمية وإجازات الأطباء واستثناءات العمل.
//
// قواعد ثابتة في هذا الموديول:
//  1. لا حذف ولا إلغاء صامت لأي موعد قائم: تغيير التقويم يُعرض أثره ويطلب
//     تأكيداً صريحاً، والمواعيد تبقى كما هي.
//  2. لا ادعاء بإبلاغ المرضى: لا يوجد قناة إشعار في النظام، وكل ما يُسجَّل
//     هو "مهمة تواصل يدوي" بحالة صريحة.
//  3. من لا يستطيع الاعتماد لا يوثّق نفسه: الاعتماد الذاتي مرفوض.
//  4. كل تغيير يُسجَّل في calendar_changes وaudit_logs داخل نفس المعاملة
//     التي أحدثته، فلا يُفقد سجل ولا يخسر التغيير أثره.
// ============================================================================

const hasPermission = (req: AuthenticatedRequest, permission: string): boolean => {
  if (canManageAllClinics(req)) return true;
  return (req.user?.permissions ?? []).includes(permission);
};

const clinicInScope = (req: AuthenticatedRequest, clinicId: number): boolean => {
  const scope = accessibleClinicIds(req);
  return scope === null || scope.includes(clinicId);
};

const parse = <T>(schema: ZodType<T>, payload: unknown, res: Response): T | null => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    res.status(400).json({
      message: 'البيانات المُرسلة غير صالحة',
      code: ApiErrorCode.VALIDATION_ERROR,
      details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return null;
  }
  return result.data;
};

const actorId = (req: AuthenticatedRequest): number | null => req.user?.userId ?? null;

/** يسجّل أثر التدقيق داخل نفس معاملة التغيير (إما يُحفظ الاثنان أو لا يُحفظ أيٌّ منهما). */
const writeAudit = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  action: string,
  resourceType: string,
  resourceId: number | null,
  clinicId: number | null,
  metadata: Record<string, unknown>
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actorId(req), clinicId, action, resourceType, resourceId === null ? null : String(resourceId), JSON.stringify(metadata)]
  );
};

/** تحقّق من أن الطبيب نشط ويُسند إلى العيادة (أساسياً أو عبر clinic_staff). */
const doctorInClinic = async (
  client: PoolClient,
  doctorId: number,
  clinicId: number
): Promise<{ user_id: number; full_name: string } | null> => {
  const result = await client.query(
    `SELECT u.user_id, u.full_name
     FROM users u JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1
       AND u.status = 'ACTIVE'
       AND r.role_name = 'DOCTOR'
       AND (u.clinic_id = $2 OR EXISTS (
              SELECT 1 FROM clinic_staff cs WHERE cs.clinic_id = $2 AND cs.user_id = u.user_id))`,
    [doctorId, clinicId]
  );
  return result.rows[0] ?? null;
};

// ——————————————————————————————————————————————————————————————
// العطل الرسمية
// ——————————————————————————————————————————————————————————————

export const listHolidays = async (req: AuthenticatedRequest, res: Response) => {
  const query = parse(listHolidaysQuerySchema, req.query, res);
  if (!query) return;

  try {
    const scope = accessibleClinicIds(req);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (query.include_cancelled !== true) conditions.push(`h.status = 'ACTIVE'`);

    if (scope !== null) {
      params.push(scope);
      conditions.push(`(h.clinic_id IS NULL OR h.clinic_id = ANY($${params.length}::int[]))`);
    }
    if (query.clinic_id !== undefined) {
      params.push(query.clinic_id);
      conditions.push(`h.clinic_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`h.holiday_date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`h.holiday_date <= $${params.length}::date`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT h.*, c.clinic_name
       FROM clinic_holidays h
       LEFT JOIN clinics c ON c.clinic_id = h.clinic_id
       ${where}
       ORDER BY h.holiday_date ASC, h.clinic_id NULLS FIRST`,
      params
    );
    return res.status(200).json({ holidays: result.rows });
  } catch (error) {
    console.error('List Holidays Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب العطل' });
  }
};

export const createHoliday = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(createHolidaySchema, req.body, res);
  if (!dto) return;

  const isNational = dto.clinic_id === null || dto.clinic_id === undefined;
  if (isNational && !hasPermission(req, 'APPROVE_HOLIDAYS')) {
    return res.status(403).json({
      message: 'إعلان عطلة وطنية (لكل العيادات) يتطلب صلاحية اعتماد العطل',
      code: ApiErrorCode.FORBIDDEN,
    });
  }
  if (!isNational && !clinicInScope(req, dto.clinic_id as number)) {
    return res.status(403).json({ message: 'لا يمكنك إدارة عطلة لعيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scopeClinicId = isNational ? null : (dto.clinic_id as number);

    // العيادة المُشار إليها يجب أن موجودة فعلاً: بدل هذا الفحص كان خطأ
    // المفتاح الأجنبي (23503) يمرّ إلى catch العام فيصير 500. الترتيب يتبع
    // اصطلاح المشروع: النطاق أولاً (403 في createHoliday أعلاه)، ثم صحة
    // الإشارة (400 هنا).
    if (!isNational) {
      const clinic = await client.query('SELECT clinic_id FROM clinics WHERE clinic_id = $1', [scopeClinicId]);
      if (!clinic.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: 'العيادة غير موجودة',
          code: ApiErrorCode.VALIDATION_ERROR,
        });
      }
    }

    const clinicIds = await clinicsForHolidayScope(client, scopeClinicId);
    await lockCalendarDays(client, clinicIds.map((clinicId) => ({ clinic_id: clinicId, date: dto.holiday_date })));

    const inserted = await client.query(
      `INSERT INTO clinic_holidays
         (holiday_date, clinic_id, name_ar, name_en, holiday_type, created_by_user_id, updated_by_user_id)
       VALUES ($1::date, $2, $3, $4, $5, $6, $6)
       RETURNING *`,
      [
        dto.holiday_date,
        scopeClinicId,
        dto.name_ar,
        dto.name_en ?? null,
        dto.holiday_type ?? 'OFFICIAL',
        actorId(req),
      ]
    );
    const holiday = inserted.rows[0];

    const impact = await computeImpact(client, clinicIds, dto.holiday_date);
    const change = await recordChange(client, {
      change_type: 'HOLIDAY_CREATED',
      entity_type: 'HOLIDAY',
      entity_id: Number(holiday.holiday_id),
      clinic_id: scopeClinicId,
      from_date: null,
      to_date: dto.holiday_date,
      decision: 'CONFIRMED',
      impact,
      performed_by_user_id: actorId(req),
      notification_status: impact.appointment_count > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
    });
    const tasks = await createNotificationTasks(
      client,
      change,
      impact.appointments,
      actorId(req),
      `أُعلنت عطلة رسمية ${holiday.name_ar} بتاريخ ${dto.holiday_date}`
    );
    await writeAudit(client, req, 'CALENDAR_HOLIDAY_CREATED', 'HOLIDAY', Number(holiday.holiday_id), scopeClinicId, {
      holiday_date: dto.holiday_date,
      scope: isNational ? 'NATIONAL' : 'CLINIC',
      impact: { clinics: impact.clinics.length, doctors: impact.doctors.length, appointments: impact.appointment_count },
      notification_tasks: tasks,
    });

    await client.query('COMMIT');
    return res.status(201).json({
      holiday,
      impact,
      notification_tasks: tasks,
      notification_status: tasks > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return res.status(409).json({
        message: 'يوجد عطلة مسجَّلة بالفعل في هذا التاريخ لنفس النطاق',
        code: ApiErrorCode.HOLIDAY_CLOSED,
      });
    }
    console.error('Create Holiday Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إنشاء العطلة' });
  } finally {
    client.release();
  }
};

export const updateHoliday = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(updateHolidaySchema, req.body, res);
  if (!dto) return;
  const holidayId = Number(req.params.id);
  if (!Number.isInteger(holidayId)) {
    return res.status(400).json({ message: 'معرّف العطلة غير صالح', code: ApiErrorCode.VALIDATION_ERROR });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM clinic_holidays WHERE holiday_id = $1', [holidayId]);
    const holiday = existing.rows[0];
    if (!holiday) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'العطلة غير موجودة' });
    }
    if (holiday.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'العطلة ملغاة — لا يمكن تعديلها' });
    }

    const isNational = holiday.clinic_id === null;
    if (isNational && !hasPermission(req, 'APPROVE_HOLIDAYS')) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'تعديل عطلة وطنية يتطلب صلاحية اعتماد العطل',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    if (!isNational && !clinicInScope(req, Number(holiday.clinic_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'لا يمكنك تعديل عطلة لعيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
    }

    const oldDate = String(holiday.holiday_date);
    const newDate = dto.holiday_date ?? oldDate;
    const dateChanged = newDate !== oldDate;
    const scopeClinicId = isNational ? null : Number(holiday.clinic_id);
    const clinicIds = await clinicsForHolidayScope(client, scopeClinicId);

    if (dateChanged) {
      await lockCalendarDays(client, [
        ...clinicIds.map((clinicId) => ({ clinic_id: clinicId, date: oldDate })),
        ...clinicIds.map((clinicId) => ({ clinic_id: clinicId, date: newDate })),
      ]);

      const impactFrom = await computeImpact(client, clinicIds, oldDate);
      const impactTo = await computeImpact(client, clinicIds, newDate);

      if (dto.confirm_impact !== true) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'تغيير تاريخ العطلة يؤثر على مواعيد قائمة — يلزم تأكيد صريح',
          code: ApiErrorCode.IMPACT_CONFIRMATION_REQUIRED,
          impact: { from: impactFrom, to: impactTo },
        });
      }

      const updated = await client.query(
        `UPDATE clinic_holidays
         SET holiday_date = $1::date, updated_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE holiday_id = $3
         RETURNING *`,
        [newDate, actorId(req), holidayId]
      );

      const change = await recordChange(client, {
        change_type: 'HOLIDAY_MOVED',
        entity_type: 'HOLIDAY',
        entity_id: holidayId,
        clinic_id: scopeClinicId,
        from_date: oldDate,
        to_date: newDate,
        decision: 'CONFIRMED',
        impact: { from: impactFrom, to: impactTo },
        performed_by_user_id: actorId(req),
        notification_status: impactTo.appointment_count > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
      });
      // المواعيد على التاريخ القديم لم تعد متعارضة، والمهام المعلّقة السابقة لم تعد ذات معنى.
      await skipPendingTasks(client, 'HOLIDAY', holidayId, ' — أُلغي أثر التغيير (نقل العطلة)');
      const tasks = await createNotificationTasks(
        client,
        change,
        impactTo.appointments,
        actorId(req),
        `نُقلت العطلة الرسمية ${holiday.name_ar} إلى ${newDate}`
      );
      await writeAudit(client, req, 'CALENDAR_HOLIDAY_MOVED', 'HOLIDAY', holidayId, scopeClinicId, {
        from_date: oldDate,
        to_date: newDate,
        impact: {
          from: { clinics: impactFrom.clinics.length, doctors: impactFrom.doctors.length, appointments: impactFrom.appointment_count },
          to: { clinics: impactTo.clinics.length, doctors: impactTo.doctors.length, appointments: impactTo.appointment_count },
        },
        notification_tasks: tasks,
      });

      await client.query('COMMIT');
      return res.status(200).json({
        holiday: updated.rows[0],
        impact: { from: impactFrom, to: impactTo },
        notification_tasks: tasks,
        notification_status: tasks > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
      });
    }

    const updated = await client.query(
      `UPDATE clinic_holidays
       SET name_ar = COALESCE($1, name_ar),
           name_en = COALESCE($2, name_en),
           holiday_type = COALESCE($3, holiday_type),
           updated_by_user_id = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE holiday_id = $5
       RETURNING *`,
      [dto.name_ar ?? null, dto.name_en ?? null, dto.holiday_type ?? null, actorId(req), holidayId]
    );

    await writeAudit(client, req, 'CALENDAR_HOLIDAY_UPDATED', 'HOLIDAY', holidayId, scopeClinicId, {
      holiday_date: oldDate,
      changed: Object.keys(dto).filter((key) => key !== 'confirm_impact'),
    });
    await client.query('COMMIT');
    return res.status(200).json({ holiday: updated.rows[0] });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return res.status(409).json({
        message: 'يوجد عطلة مسجَّلة بالفعل في هذا التاريخ لنفس النطاق',
        code: ApiErrorCode.HOLIDAY_CLOSED,
      });
    }
    console.error('Update Holiday Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند تعديل العطلة' });
  } finally {
    client.release();
  }
};

export const cancelHoliday = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(cancelHolidaySchema, req.body, res);
  if (!dto) return;
  const holidayId = Number(req.params.id);
  if (!Number.isInteger(holidayId)) {
    return res.status(400).json({ message: 'معرّف العطلة غير صالح', code: ApiErrorCode.VALIDATION_ERROR });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM clinic_holidays WHERE holiday_id = $1', [holidayId]);
    const holiday = existing.rows[0];
    if (!holiday) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'العطلة غير موجودة' });
    }
    if (holiday.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'العطلة ملغاة مسبقاً' });
    }

    const scopeClinicId = holiday.clinic_id === null ? null : Number(holiday.clinic_id);
    if (scopeClinicId !== null && !clinicInScope(req, scopeClinicId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'لا يمكنك إلغاء عطلة لعيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
    }

    const clinicIds = await clinicsForHolidayScope(client, scopeClinicId);
    const holidayDate = String(holiday.holiday_date);
    await lockCalendarDays(client, clinicIds.map((clinicId) => ({ clinic_id: clinicId, date: holidayDate })));

    const updated = await client.query(
      `UPDATE clinic_holidays
       SET status = 'CANCELLED',
           cancelled_by_user_id = $1,
           cancelled_at = CURRENT_TIMESTAMP,
           cancellation_reason = $2,
           updated_by_user_id = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE holiday_id = $3
       RETURNING *`,
      [actorId(req), dto.reason, holidayId]
    );

    const impact = await computeImpact(client, clinicIds, holidayDate);
    const skipped = await skipPendingTasks(client, 'HOLIDAY', holidayId, ' — أُلغيت العطلة');
    await recordChange(client, {
      change_type: 'HOLIDAY_CANCELLED',
      entity_type: 'HOLIDAY',
      entity_id: holidayId,
      clinic_id: scopeClinicId,
      from_date: holidayDate,
      to_date: null,
      decision: 'CANCELLED',
      impact: { impact, skipped_notification_tasks: skipped },
      performed_by_user_id: actorId(req),
      notification_status: 'SKIPPED',
    });
    await writeAudit(client, req, 'CALENDAR_HOLIDAY_CANCELLED', 'HOLIDAY', holidayId, scopeClinicId, {
      holiday_date: holidayDate,
      reason: dto.reason,
      skipped_notification_tasks: skipped,
    });

    await client.query('COMMIT');
    return res.status(200).json({
      holiday: updated.rows[0],
      skipped_notification_tasks: skipped,
      notification_status: 'SKIPPED',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancel Holiday Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إلغاء العطلة' });
  } finally {
    client.release();
  }
};

export const holidayImpact = async (req: AuthenticatedRequest, res: Response) => {
  // مساران بعقدين مختلفين:
  //  - /api/calendar/holidays/:id/impact ⇒ المرجع هو تاريخ العطلة نفسها
  //    (يُقرأ من القاعدة)، ف absence تاريخ من الطلب ليس خطأ.
  //  - /api/calendar/impact ⇒ لا مرجع إلا التاريخ المطلوب: غيابه أو
  //    صحته خطأ تحقق 400. (كان يُستعمل تاريخ افتراضي 1970-01-01 فيتحوّل
  //    إلى نتيجة فارغة بلا معنى بدل رفض واضح.)
  const rawHolidayId = req.params.id;
  const query = parse(
    rawHolidayId !== undefined ? holidayImpactQuerySchema : impactQuerySchema,
    req.query,
    res
  );
  if (!query) return;

  try {
    const client = await pool.connect();
    try {
      const holidayId = rawHolidayId !== undefined ? Number(rawHolidayId) : null;
      let scopeClinicId: number | null = null;
      let date: string;

      if (holidayId !== null) {
        const existing = await client.query('SELECT * FROM clinic_holidays WHERE holiday_id = $1', [holidayId]);
        const holiday = existing.rows[0];
        if (!holiday) {
          return res.status(404).json({ message: 'العطلة غير موجودة' });
        }
        scopeClinicId = holiday.clinic_id === null ? null : Number(holiday.clinic_id);
        date = String(holiday.holiday_date);
      } else {
        // المخطط يفرض وجود التاريخ في هذا المسار (وإلا ورد 400 أعلاه).
        date = query.date as string;
        if (query.clinic_id !== undefined) {
          scopeClinicId = query.clinic_id;
        }
      }

      const scope = accessibleClinicIds(req);
      const clinicIds =
        scopeClinicId !== null
          ? [scopeClinicId]
          : scope === null
            ? await clinicsForHolidayScope(client, null)
            : scope;

      const impact = await computeImpact(client, clinicIds, date);
      let impactTo: ImpactReport | null = null;
      const toDate = query.to_date;
      if (toDate && toDate !== date) {
        impactTo = await computeImpact(client, clinicIds, toDate);
      }
      return res.status(200).json({ impact, impact_to: impactTo });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Holiday Impact Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند حساب أثر التغيير' });
  }
};

// ——————————————————————————————————————————————————————————————
// إجازات الأطباء
// ——————————————————————————————————————————————————————————————

export const listLeave = async (req: AuthenticatedRequest, res: Response) => {
  const query = parse(listLeaveQuerySchema, req.query, res);
  if (!query) return;

  try {
    const scope = accessibleClinicIds(req);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== null) {
      params.push(scope);
      conditions.push(`l.clinic_id = ANY($${params.length}::int[])`);
    }
    if (query.doctor_id !== undefined) {
      params.push(query.doctor_id);
      conditions.push(`l.doctor_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`l.end_date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`l.start_date <= $${params.length}::date`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`l.status = $${params.length}`);
    }
    // الطبيب يرى إجازاته هو فقط
    if (req.user?.roleName === 'DOCTOR') {
      params.push(req.user.userId);
      conditions.push(`l.doctor_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT l.*, u.full_name AS doctor_name, c.clinic_name
       FROM doctor_leave l
       JOIN users u ON u.user_id = l.doctor_id
       JOIN clinics c ON c.clinic_id = l.clinic_id
       ${where}
       ORDER BY l.start_date DESC, l.leave_id DESC`,
      params
    );
    return res.status(200).json({ leave: result.rows });
  } catch (error) {
    console.error('List Leave Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب الإجازات' });
  }
};

export const createLeave = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(createLeaveSchema, req.body, res);
  if (!dto) return;

  if (req.user?.roleName === 'DOCTOR' && dto.doctor_id !== req.user.userId) {
    return res.status(403).json({
      message: 'الطبيب لا يمكنه إنشاء إجازة لغيره',
      code: ApiErrorCode.FORBIDDEN,
    });
  }
  if (!clinicInScope(req, dto.clinic_id)) {
    return res.status(403).json({ message: 'لا يمكنك إنشاء إجازة لعيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const doctor = await doctorInClinic(client, dto.doctor_id, dto.clinic_id);
    if (!doctor) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'الطبيب المحدد غير مسجّل كطبيب في هذه العيادة',
        code: ApiErrorCode.VALIDATION_ERROR,
      });
    }

    const days = dateRange(dto.start_date, dto.end_date);
    await lockCalendarDays(client, days.map((date) => ({ clinic_id: dto.clinic_id, date })));

    const inserted = await client.query(
      `INSERT INTO doctor_leave
         (doctor_id, clinic_id, start_date, end_date, leave_type, status, reason, requested_by_user_id)
       VALUES ($1, $2, $3::date, $4::date, $5, 'PENDING', $6, $7)
       RETURNING *`,
      [dto.doctor_id, dto.clinic_id, dto.start_date, dto.end_date, dto.leave_type ?? 'ANNUAL', dto.reason ?? null, actorId(req)]
    );
    const leave = inserted.rows[0];

    const change = await recordChange(client, {
      change_type: 'LEAVE_REQUESTED',
      entity_type: 'DOCTOR_LEAVE',
      entity_id: Number(leave.leave_id),
      clinic_id: dto.clinic_id,
      from_date: dto.start_date,
      to_date: dto.end_date,
      decision: 'PROPOSED',
      impact: { doctor_id: dto.doctor_id, days: days.length },
      performed_by_user_id: actorId(req),
      notification_status: 'NOT_REQUIRED',
    });
    await writeAudit(client, req, 'CALENDAR_LEAVE_REQUESTED', 'DOCTOR_LEAVE', Number(leave.leave_id), dto.clinic_id, {
      doctor_id: dto.doctor_id,
      start_date: dto.start_date,
      end_date: dto.end_date,
      leave_type: leave.leave_type,
    });

    await client.query('COMMIT');
    return res.status(201).json({ leave, change_id: change });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create Leave Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إنشاء الإجازة' });
  } finally {
    client.release();
  }
};

export const decideLeave = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(decideLeaveSchema, req.body, res);
  if (!dto) return;
  const leaveId = Number(req.params.id);
  if (!Number.isInteger(leaveId)) {
    return res.status(400).json({ message: 'معرّف الإجازة غير صالح', code: ApiErrorCode.VALIDATION_ERROR });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM doctor_leave WHERE leave_id = $1', [leaveId]);
    const leave = existing.rows[0];
    if (!leave) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'الإجازة غير موجودة' });
    }
    if (!clinicInScope(req, Number(leave.clinic_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'لا يمكنك اتخاذ قرار على إجازة في عيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
    }
    if (leave.requested_by_user_id !== null && Number(leave.requested_by_user_id) === (req.user?.userId ?? -1)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'لا يمكن اعتماد إجازة طلبها المستخدم نفسه',
        code: ApiErrorCode.SELF_APPROVAL_FORBIDDEN,
      });
    }
    if (leave.status !== 'PENDING' && dto.status !== 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'تمت معالجة هذه الإجازة مسبقاً' });
    }

    const clinicId = Number(leave.clinic_id);
    const doctorId = Number(leave.doctor_id);
    const startDate = String(leave.start_date);
    const endDate = String(leave.end_date);
    const days = dateRange(startDate, endDate);
    await lockCalendarDays(client, days.map((date) => ({ clinic_id: clinicId, date })));

    if (dto.status === 'APPROVED') {
      // اعتماد الإجازة يجب ألا يترك استثناء عمل معتمد يتناقض معها.
      const conflicting = await client.query(
        `SELECT exception_id, exception_date FROM work_exceptions
         WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'APPROVED'
           AND exception_date BETWEEN $3::date AND $4::date`,
        [doctorId, clinicId, startDate, endDate]
      );
      if (conflicting.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'يوجد استثناء عمل معتمد يتعارض مع هذه الإجازة — ألغِ الاستثناء أولاً',
          code: ApiErrorCode.LEAVE_CONFLICT,
          conflicts: conflicting.rows.map((row) => ({
            exception_id: Number(row.exception_id),
            exception_date: String(row.exception_date),
          })),
        });
      }
    }

    const updated = await client.query(
      `UPDATE doctor_leave
       SET status = $1::varchar(20),
           approved_by_user_id = CASE WHEN $1::varchar(20) = 'APPROVED' THEN $2 ELSE approved_by_user_id END,
           approved_at = CASE WHEN $1::varchar(20) = 'APPROVED' THEN CURRENT_TIMESTAMP ELSE approved_at END,
           decision_reason = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE leave_id = $4
       RETURNING *`,
      [dto.status, actorId(req), dto.reason ?? null, leaveId]
    );

    // أثر اعتماد الإجازة: المواعيد القائمة في تلك الأيام تصبح متعارضة.
    let impact: ImpactReport | null = null;
    let tasks = 0;
    if (dto.status === 'APPROVED') {
      const clinicIds = [clinicId];
      let aggregate: ImpactReport | null = null;
      for (const date of days) {
        const dayImpact = await computeImpact(client, clinicIds, date);
        aggregate = aggregate
          ? {
              date: `${aggregate.date},${date}`,
              clinics: aggregate.clinics,
              doctors: aggregate.doctors,
              appointments: [...aggregate.appointments, ...dayImpact.appointments],
              appointment_count: aggregate.appointment_count + dayImpact.appointment_count,
            }
          : dayImpact;
      }
      impact = aggregate;
    }

    const change = await recordChange(client, {
      change_type:
        dto.status === 'APPROVED'
          ? 'LEAVE_APPROVED'
          : dto.status === 'REJECTED'
            ? 'LEAVE_REJECTED'
            : 'LEAVE_CANCELLED',
      entity_type: 'DOCTOR_LEAVE',
      entity_id: leaveId,
      clinic_id: clinicId,
      from_date: startDate,
      to_date: endDate,
      decision: dto.status === 'APPROVED' ? 'CONFIRMED' : dto.status === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
      impact: impact ?? { doctor_id: doctorId, days: days.length },
      performed_by_user_id: actorId(req),
      // حالة مؤقتة: تُصحَّح بعد إنشاء مهام التواصل أدناه
      notification_status: impact ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
    });

    if (impact) {
      tasks = await createNotificationTasks(
        client,
        change,
        impact.appointments.filter((appointment) => appointment.doctor_id === doctorId),
        actorId(req),
        `اعتُمدت إجازة الطبيب في ${startDate}..${endDate}`
      );
      await client.query('UPDATE calendar_changes SET notification_status = $2 WHERE change_id = $1', [
        change,
        tasks > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
      ]);
    }

    await writeAudit(client, req, `CALENDAR_LEAVE_${dto.status}`, 'DOCTOR_LEAVE', leaveId, clinicId, {
      doctor_id: doctorId,
      start_date: startDate,
      end_date: endDate,
      reason: dto.reason ?? null,
      notification_tasks: tasks,
    });

    await client.query('COMMIT');
    return res.status(200).json({
      leave: updated.rows[0],
      impact,
      notification_tasks: tasks,
      notification_status: tasks > 0 ? 'PENDING_CONTACT' : 'NOT_REQUIRED',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Decide Leave Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند معالجة الإجازة' });
  } finally {
    client.release();
  }
};

// ——————————————————————————————————————————————————————————————
// استثناءات العمل
// ——————————————————————————————————————————————————————————————

export const listExceptions = async (req: AuthenticatedRequest, res: Response) => {
  const query = parse(listExceptionsQuerySchema, req.query, res);
  if (!query) return;

  try {
    const scope = accessibleClinicIds(req);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== null) {
      params.push(scope);
      conditions.push(`e.clinic_id = ANY($${params.length}::int[])`);
    }
    if (query.doctor_id !== undefined) {
      params.push(query.doctor_id);
      conditions.push(`e.doctor_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`e.exception_date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`e.exception_date <= $${params.length}::date`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`e.status = $${params.length}`);
    }
    if (req.user?.roleName === 'DOCTOR') {
      params.push(req.user.userId);
      conditions.push(`e.doctor_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT e.*, u.full_name AS doctor_name, c.clinic_name, h.name_ar AS holiday_name, h.holiday_date
       FROM work_exceptions e
       JOIN users u ON u.user_id = e.doctor_id
       JOIN clinics c ON c.clinic_id = e.clinic_id
       LEFT JOIN clinic_holidays h ON h.holiday_id = e.holiday_id
       ${where}
       ORDER BY e.exception_date DESC, e.exception_id DESC`,
      params
    );
    return res.status(200).json({ exceptions: result.rows });
  } catch (error) {
    console.error('List Exceptions Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب استثناءات العمل' });
  }
};

export const createException = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(createExceptionSchema, req.body, res);
  if (!dto) return;

  if (req.user?.roleName === 'DOCTOR' && dto.doctor_id !== req.user.userId) {
    return res.status(403).json({ message: 'الطبيب لا يمكنه إنشاء استثناء لغيره', code: ApiErrorCode.FORBIDDEN });
  }
  if (!clinicInScope(req, dto.clinic_id)) {
    return res.status(403).json({ message: 'لا يمكنك إنشاء استثناء لعيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const doctor = await doctorInClinic(client, dto.doctor_id, dto.clinic_id);
    if (!doctor) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'الطبيب المحدد غير مسجّل كطبيب في هذه العيادة',
        code: ApiErrorCode.VALIDATION_ERROR,
      });
    }

    await lockCalendarDays(client, [{ clinic_id: dto.clinic_id, date: dto.exception_date }]);

    // الإجازة المعتمدة تتقدّم على استثناء العمل: يُرفض الاستثناء صراحةً.
    const leaveConflict = await client.query(
      `SELECT leave_id, start_date, end_date FROM doctor_leave
       WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'APPROVED'
         AND start_date <= $3::date AND end_date >= $3::date`,
      [dto.doctor_id, dto.clinic_id, dto.exception_date]
    );
    if (leaveConflict.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'لا يمكن إنشاء استثناء عمل في تاريخ مشمول بإجازة معتمدة',
        code: ApiErrorCode.LEAVE_CONFLICT,
        conflicts: leaveConflict.rows.map((row) => ({
          leave_id: Number(row.leave_id),
          start_date: String(row.start_date),
          end_date: String(row.end_date),
        })),
      });
    }

    const inserted = await client.query(
      `INSERT INTO work_exceptions
         (clinic_id, doctor_id, holiday_id, exception_date, start_time, end_time, status, reason, requested_by_user_id)
       VALUES ($1, $2, $3, $4::date, $5, $6, 'PENDING', $7, $8)
       RETURNING *`,
      [
        dto.clinic_id,
        dto.doctor_id,
        dto.holiday_id ?? null,
        dto.exception_date,
        dto.start_time ?? null,
        dto.end_time ?? null,
        dto.reason,
        actorId(req),
      ]
    );
    const exception = inserted.rows[0];

    await recordChange(client, {
      change_type: 'EXCEPTION_REQUESTED',
      entity_type: 'WORK_EXCEPTION',
      entity_id: Number(exception.exception_id),
      clinic_id: dto.clinic_id,
      from_date: dto.exception_date,
      to_date: dto.exception_date,
      decision: 'PROPOSED',
      impact: { doctor_id: dto.doctor_id },
      performed_by_user_id: actorId(req),
      notification_status: 'NOT_REQUIRED',
    });
    await writeAudit(client, req, 'CALENDAR_EXCEPTION_REQUESTED', 'WORK_EXCEPTION', Number(exception.exception_id), dto.clinic_id, {
      doctor_id: dto.doctor_id,
      exception_date: dto.exception_date,
      reason: dto.reason,
    });

    await client.query('COMMIT');
    return res.status(201).json({ exception });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return res.status(409).json({
        message: 'يوجد استثناء عمل معتمد لهذا الطبيب في نفس التاريخ',
        code: ApiErrorCode.CALENDAR_CONFLICT,
      });
    }
    if (error?.code === 'CL002') {
      return res.status(409).json({
        message: 'لا يمكن اعتماد استثناء عمل يتعارض مع إجازة معتمدة',
        code: ApiErrorCode.LEAVE_CONFLICT,
      });
    }
    console.error('Create Exception Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إنشاء استثناء العمل' });
  } finally {
    client.release();
  }
};

export const decideException = async (req: AuthenticatedRequest, res: Response) => {
  const dto = parse(decideExceptionSchema, req.body, res);
  if (!dto) return;
  const exceptionId = Number(req.params.id);
  if (!Number.isInteger(exceptionId)) {
    return res.status(400).json({ message: 'معرّف الاستثناء غير صالح', code: ApiErrorCode.VALIDATION_ERROR });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM work_exceptions WHERE exception_id = $1', [exceptionId]);
    const exception = existing.rows[0];
    if (!exception) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'استثناء العمل غير موجود' });
    }
    if (!clinicInScope(req, Number(exception.clinic_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'لا يمكنك اتخاذ قرار على استثناء في عيادة غير مسندة لك', code: ApiErrorCode.FORBIDDEN });
    }
    if (exception.requested_by_user_id !== null && Number(exception.requested_by_user_id) === (req.user?.userId ?? -1)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'لا يمكن اعتماد استثناء طلبه المستخدم نفسه',
        code: ApiErrorCode.SELF_APPROVAL_FORBIDDEN,
      });
    }
    if (exception.status === 'APPROVED' && dto.status !== 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'استثناء العمل معتمد مسبقاً' });
    }

    const clinicId = Number(exception.clinic_id);
    const exceptionDate = String(exception.exception_date);
    await lockCalendarDays(client, [{ clinic_id: clinicId, date: exceptionDate }]);

    const updated = await client.query(
      `UPDATE work_exceptions
       SET status = $1::varchar(20),
           approved_by_user_id = CASE WHEN $1::varchar(20) = 'APPROVED' THEN $2 ELSE approved_by_user_id END,
           approved_at = CASE WHEN $1::varchar(20) = 'APPROVED' THEN CURRENT_TIMESTAMP ELSE approved_at END,
           cancelled_by_user_id = CASE WHEN $1::varchar(20) = 'CANCELLED' THEN $2 ELSE cancelled_by_user_id END,
           cancelled_at = CASE WHEN $1::varchar(20) = 'CANCELLED' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
           decision_reason = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE exception_id = $4
       RETURNING *`,
      [dto.status, actorId(req), dto.reason ?? null, exceptionId]
    );

    await recordChange(client, {
      change_type:
        dto.status === 'APPROVED'
          ? 'EXCEPTION_APPROVED'
          : dto.status === 'REJECTED'
            ? 'EXCEPTION_REJECTED'
            : 'EXCEPTION_CANCELLED',
      entity_type: 'WORK_EXCEPTION',
      entity_id: exceptionId,
      clinic_id: clinicId,
      from_date: exceptionDate,
      to_date: exceptionDate,
      decision: dto.status === 'APPROVED' ? 'CONFIRMED' : dto.status === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
      impact: { doctor_id: Number(exception.doctor_id) },
      performed_by_user_id: actorId(req),
      notification_status: 'NOT_REQUIRED',
    });
    await writeAudit(client, req, `CALENDAR_EXCEPTION_${dto.status}`, 'WORK_EXCEPTION', exceptionId, clinicId, {
      doctor_id: Number(exception.doctor_id),
      exception_date: exceptionDate,
      reason: dto.reason ?? null,
    });

    await client.query('COMMIT');
    return res.status(200).json({ exception: updated.rows[0] });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === 'CL002') {
      return res.status(409).json({
        message: 'لا يمكن اعتماد استثناء عمل يتعارض مع إجازة معتمدة',
        code: ApiErrorCode.LEAVE_CONFLICT,
      });
    }
    if (error?.code === '23505') {
      return res.status(409).json({
        message: 'يوجد استثناء عمل معتمد لهذا الطبيب في نفس التاريخ',
        code: ApiErrorCode.CALENDAR_CONFLICT,
      });
    }
    console.error('Decide Exception Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند معالجة استثناء العمل' });
  } finally {
    client.release();
  }
};

// ——————————————————————————————————————————————————————————————
// مهام الإشعار اليدوية وسجل التغييرات
// ——————————————————————————————————————————————————————————————

export const listNotifications = async (req: AuthenticatedRequest, res: Response) => {
  const query = parse(listNotificationsQuerySchema, req.query, res);
  if (!query) return;

  try {
    const scope = accessibleClinicIds(req);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== null) {
      params.push(scope);
      conditions.push(`n.clinic_id = ANY($${params.length}::int[])`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`n.status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT n.*, c.change_type, c.entity_type, c.entity_id, c.decision, c.performed_at, c.performed_by_user_id,
              a.appointment_date, a.start_time, a.end_time, a.status AS appointment_status,
              p.full_name AS patient_name, u.full_name AS doctor_name
       FROM calendar_change_notifications n
       JOIN calendar_changes c ON c.change_id = n.change_id
       LEFT JOIN appointments a ON a.appointment_id = n.appointment_id
       LEFT JOIN patients p ON p.patient_id = n.patient_id
       LEFT JOIN users u ON u.user_id = n.doctor_id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT 500`,
      params
    );
    return res.status(200).json({
      notifications: result.rows,
      delivery_channel: 'MANUAL',
      notice: 'لا يوجد نظام إشعارات في النظام — هذه مهام تواصل يدوي لم تُنفَّذ بعد',
    });
  } catch (error) {
    console.error('List Notifications Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب مهام الإشعار' });
  }
};

export const listChanges = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const scope = accessibleClinicIds(req);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (scope !== null) {
      params.push(scope);
      conditions.push(`(cc.clinic_id IS NULL OR cc.clinic_id = ANY($${params.length}::int[]))`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT cc.*, u.full_name AS performed_by_name
       FROM calendar_changes cc
       LEFT JOIN users u ON u.user_id = cc.performed_by_user_id
       ${where}
       ORDER BY cc.performed_at DESC
       LIMIT 200`,
      params
    );
    return res.status(200).json({ changes: result.rows });
  } catch (error) {
    console.error('List Changes Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب سجل التغييرات' });
  }
};

/** معاينة بوابة تقويم لعيادة/طبيب/تاريخ — تُستخدم من الواجهة ومن الاختبارات. */
export const previewGate = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = Number(req.query.clinic_id);
  const doctorId = Number(req.query.doctor_id);
  const date = String(req.query.date ?? '');
  if (!Number.isInteger(clinicId) || !Number.isInteger(doctorId) || !isValidIsoDate(date)) {
    return res.status(400).json({ message: 'معطيات البوابة غير صالحة', code: ApiErrorCode.VALIDATION_ERROR });
  }
  if (!clinicInScope(req, clinicId)) {
    return res.status(403).json({ message: 'العيادة خارج نطاقك', code: ApiErrorCode.FORBIDDEN });
  }
  try {
    const client = await pool.connect();
    try {
      const gate = await calendarGate(client, clinicId, doctorId, date);
      return res.status(200).json({ gate });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Preview Gate Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند معاينة البوابة' });
  }
};
