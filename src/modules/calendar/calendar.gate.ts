import { PoolClient } from 'pg';
import { clinicToday, epochDay, isValidTimeZone } from '../../utils/calendarTime';

// ============================================================================
// البوابة، الأقفال، وقياس الأثر — منطق مشترك بين المتحكم والمواعيد والجدولة.
//
// مصدر الحقيقة الوحيد هو دالة PostgreSQL calendar_gate (ترحيل 059)، التي تستخدمها
// هذه الوحدة والـtrigger والواجهة معاً، حتى لا تختلفRule في أي مسار.
// ============================================================================

export type CalendarGate = {
  is_blocked: boolean;
  code: string | null;
  detail: string | null;
};

export type CalendarDayLock = {
  clinic_id: number;
  date: string;
};

export type ImpactAppointment = {
  appointment_id: number;
  clinic_id: number;
  patient_id: number;
  doctor_id: number;
  start_time: string | null;
  end_time: string | null;
  status: string;
};

export type ImpactReport = {
  date: string;
  clinics: { clinic_id: number; clinic_name: string }[];
  doctors: { doctor_id: number; full_name: string }[];
  appointments: ImpactAppointment[];
  appointment_count: number;
};

export type ChangeRecord = {
  change_type: string;
  entity_type: string;
  entity_id: number;
  clinic_id: number | null;
  from_date: string | null;
  to_date: string | null;
  decision: string | null;
  impact: unknown;
  performed_by_user_id: number | null;
  notification_status: 'NOT_REQUIRED' | 'PENDING_CONTACT' | 'ACKNOWLEDGED' | 'SKIPPED';
};

/** SQLSTATE الذي يرفعه مُشغّل البوابة على المواعيد (ترحيل 059). */
export const CALENDAR_GATE_SQLSTATE = 'CL001';

/** هل هذا الخطأ رفض بوابة تقويم (عطلة/إجازة)؟ */
export const isCalendarGateError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === CALENDAR_GATE_SQLSTATE;

/** رسالة عربية صريحة حسب سبب الرفض — لا ادعاء عاماً ولا رسالة خادم. */
export const calendarGateMessage = (code: string | null): string => {
  if (code === 'LEAVE') return 'لا يمكن الحجز: الطبيب في إجازة معتمدة في هذا التاريخ';
  if (code === 'HOLIDAY') return 'لا يمكن الحجز: التاريخ عطلة رسمية';
  return 'لا يمكن الحجز: التاريخ مغلق وفق تقويم العطل';
};

/** يستدعي دالة البوابة في قاعدة البيانات. */
export const calendarGate = async (
  client: PoolClient,
  clinicId: number,
  doctorId: number,
  date: string
): Promise<CalendarGate> => {
  const result = await client.query(
    'SELECT is_blocked, code, detail FROM calendar_gate($1::int, $2::int, $3::date)',
    [clinicId, doctorId, date]
  );
  const row = result.rows[0] as { is_blocked: boolean; code: string | null; detail: string | null } | undefined;
  return {
    is_blocked: Boolean(row?.is_blocked),
    code: row?.code ?? null,
    detail: row?.detail ?? null,
  };
};

/**
 * أقفال Advisory على (عيادة، يوم).
 *
 * لماذا: فحص البوابة ثم الإدراج يجب أن يكونا في معاملة واحدة، وإلا slipped
 * booking ممكن: تصحيح عطلة قد ينتهي بين الفحص والإدراج فيُحجز في تاريخ صار محجوباً.
 *
 * لماذا الترتيب: تُلتقط الأقفال دائماً بالترتيب التصاعدي لـ(clinic_id, يوم)،
 * فلا يمكن أن ي deadlock: عمليتان تأخذان نفس المجموعة بالترتيب نفسه لا تتعارضان.
 * تعديل عطلة من A إلى B يأخذ قفلين (A وB)؛ تعديل إجازة ممتدة يأخذ N أقفال.
 */
export const lockCalendarDays = async (client: PoolClient, days: CalendarDayLock[]): Promise<void> => {
  const unique = new Map<string, CalendarDayLock>();
  for (const day of days) {
    unique.set(`${day.clinic_id}|${day.date}`, day);
  }
  const ordered = [...unique.values()].sort((a, b) => {
    if (a.clinic_id !== b.clinic_id) return a.clinic_id - b.clinic_id;
    return epochDay(a.date) - epochDay(b.date);
  });
  for (const day of ordered) {
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      day.clinic_id,
      epochDay(day.date),
    ]);
  }
};

/**
 * المنطقة الزمنية التي تُستخدم حين لا تكون العيادة قد حدّدتها.
 * نفس القيمة التي يضعها الترحيل 057 افتراضياً — لا تغيّرها هنا.
 */
export const DEFAULT_CLINIC_TIMEZONE = 'Asia/Amman';

/**
 * تاريخ "اليوم" في العيادة (YYYY-MM-DD) بتوقيت تلك العيادة.
 *
 * لماذا: المواعيد والتاريخ تُخزَّن وقتاً جدارياً، فـ"اليوم" هو تاريخ تقويم
 * العيادة لا تاريخ خادم قاعدة البيانات ولا تاريخ tz الخاص بعملية Node. من
 * يستخدم CURRENT_DATE في استعلامات تاريخية يقارن بتاريخ الخادم، فيتغيّر
 * الفحص عند منتصف الليل الزمني.
 *
 * كيف تُقرأ المنطقة: من العمود clinics.timezone (الترحيل 057) إن كان
 * موجوداً. إن لم يكن العمود موجوداً بعد (قاعدة لم تُطبَّق عليها 057) أو كانت
 * القيمة غير صالحة، تُستعمل القيمة الافتراضية أعلاه — فتبقى النتيجة
 * صحيحة بدل أن ينهار الاستعلام.
 *
 * الساعة: ساعة قاعدة البيانات (لا ساعة العملية) حتى لا يفترق الفحص عن
 * بقية المقارنات الزمنية في القاعدة.
 */
export const clinicLocalToday = async (
  client: PoolClient,
  clinicId: number,
  now: Date = new Date()
): Promise<string> => {
  const state = await client.query(
    `SELECT CURRENT_TIMESTAMP AS now,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'clinics' AND column_name = 'timezone'
            ) AS timezone_column_exists`
  );
  const row = state.rows[0] ?? {};
  const dbNow = row.now ? new Date(row.now) : now;

  if (!row.timezone_column_exists) {
    return clinicToday(DEFAULT_CLINIC_TIMEZONE, dbNow);
  }

  const clinic = await client.query('SELECT timezone FROM clinics WHERE clinic_id = $1', [clinicId]);
  const stored = clinic.rows[0]?.timezone;
  const timezone = isValidTimeZone(stored) ? (stored as string) : DEFAULT_CLINIC_TIMEZONE;
  return clinicToday(timezone, dbNow);
};

/** العيادات المتأثرة بعطلة: عيادة واحدة، أو كل العيادات النشطة للعطلة الوطنية. */
export const clinicsForHolidayScope = async (
  client: PoolClient,
  clinicId: number | null
): Promise<number[]> => {
  if (clinicId !== null) return [clinicId];
  const result = await client.query('SELECT clinic_id FROM clinics WHERE is_active IS NOT FALSE ORDER BY clinic_id');
  return result.rows.map((row) => Number(row.clinic_id));
};

/**
 * أثر تغيير تقويمي على تاريخ واحد:
 * العيادات المتأثرة + الأطباء المتأثرون + المواعيد القائمة (بمعرّفاتها).
 * لا يُلغي ولا يحذف أي موعد — الأثر للمعاينة والتسجيل فقط.
 */
export const computeImpact = async (
  client: PoolClient,
  clinicIds: number[],
  date: string
): Promise<ImpactReport> => {
  if (clinicIds.length === 0) {
    return { date, clinics: [], doctors: [], appointments: [], appointment_count: 0 };
  }

  const clinicsResult = await client.query(
    'SELECT clinic_id, clinic_name FROM clinics WHERE clinic_id = ANY($1::int[]) ORDER BY clinic_id',
    [clinicIds]
  );

  const dayOfWeek = await client.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [date]);

  const doctorsResult = await client.query(
    `SELECT DISTINCT u.user_id, u.full_name
     FROM users u
     WHERE u.user_id IN (
         SELECT ds.doctor_id FROM doctor_schedules ds
          WHERE ds.clinic_id = ANY($1::int[])
            AND ds.day_of_week = $2::int
            AND ds.is_working_day = TRUE
         UNION
         SELECT a.doctor_id FROM appointments a
          WHERE a.clinic_id = ANY($1::int[])
            AND a.appointment_date = $3::date
            AND a.status <> 'CANCELLED'
     )
     ORDER BY u.user_id`,
    [clinicIds, dayOfWeek.rows[0]?.dow ?? 0, date]
  );

  const appointmentsResult = await client.query(
    `SELECT a.appointment_id, a.clinic_id, a.patient_id, a.doctor_id, a.start_time, a.end_time, a.status
     FROM appointments a
     WHERE a.clinic_id = ANY($1::int[])
       AND a.appointment_date = $2::date
       AND a.status <> 'CANCELLED'
     ORDER BY a.appointment_id`,
    [clinicIds, date]
  );

  const appointments: ImpactAppointment[] = appointmentsResult.rows.map((row) => ({
    appointment_id: Number(row.appointment_id),
    clinic_id: Number(row.clinic_id),
    patient_id: Number(row.patient_id),
    doctor_id: Number(row.doctor_id),
    start_time: row.start_time ?? null,
    end_time: row.end_time ?? null,
    status: String(row.status),
  }));

  return {
    date,
    clinics: clinicsResult.rows.map((row) => ({
      clinic_id: Number(row.clinic_id),
      clinic_name: String(row.clinic_name),
    })),
    doctors: doctorsResult.rows.map((row) => ({
      doctor_id: Number(row.user_id),
      full_name: String(row.full_name),
    })),
    appointments,
    appointment_count: appointments.length,
  };
};

/** يسجّل تغييراً تقويمياً: المنفّذ + القرار + الوقت + حالة الإشعار + لقطة الأثر. */
export const recordChange = async (
  client: PoolClient,
  change: ChangeRecord
): Promise<number> => {
  const result = await client.query(
    `INSERT INTO calendar_changes
       (change_type, entity_type, entity_id, clinic_id, from_date, to_date,
        decision, impact_snapshot, performed_by_user_id, notification_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     RETURNING change_id`,
    [
      change.change_type,
      change.entity_type,
      change.entity_id,
      change.clinic_id,
      change.from_date,
      change.to_date,
      change.decision,
      JSON.stringify(change.impact ?? {}),
      change.performed_by_user_id,
      change.notification_status,
    ]
  );
  return Number(result.rows[0]?.change_id ?? 0);
};

/**
 * ينشئ مهام تواصل يدوية للمواعيد التي صارت متعارضة.
 *
 * لا يوجد نظام إشعارات في المشروع (لا SMS ولا بريد ولا دفع)، لذلك المهام
 * تُسجَّل كـ'PENDING_CONTACT' أي "مهمة تواصل يدوي لم تُنفَّذ" — لا يُدّعى أبداً
 * أن المريض أُبلغ. قناة الإشعار مقصورة على MANUAL في قيد قاعدة البيانات.
 */
export const createNotificationTasks = async (
  client: PoolClient,
  changeId: number,
  appointments: ImpactAppointment[],
  createdByUserId: number | null,
  note: string
): Promise<number> => {
  if (appointments.length === 0) return 0;
  // كل صف له باراميتراته الخاصة: clinic_id يختلف بين المواعيد (الأثر قد يمتد
  // على أكثر من عيادة)، فلا يجوز مشاركة معرّف العيادة بين الصفوف.
  const values: unknown[] = [];
  const rows = appointments.map((appointment) => {
    const base = values.length;
    values.push(
      changeId,
      appointment.clinic_id,
      appointment.appointment_id,
      appointment.patient_id,
      appointment.doctor_id,
      'MANUAL',
      'PENDING_CONTACT',
      note,
      createdByUserId
    );
    const placeholders = Array.from({ length: 9 }, (_, offset) => `$${base + offset + 1}`).join(', ');
    return `(${placeholders})`;
  });
  await client.query(
    `INSERT INTO calendar_change_notifications
       (change_id, clinic_id, appointment_id, patient_id, doctor_id, channel, status, note, created_by_user_id)
     VALUES ${rows.join(', ')}`,
    values
  );
  return appointments.length;
};

/**
 * عند زوال التعارض (إلغاء عطلة) تُغلق مهام التواصل المعلّقة لهذا الكيان:
 * لم يعد هناك ما يحتاج تواصلاً. الحالة تُسجَّل صراحةً كـ'SKIPPED'.
 */
export const skipPendingTasks = async (
  client: PoolClient,
  entityType: string,
  entityId: number,
  note: string
): Promise<number> => {
  const result = await client.query(
    `UPDATE calendar_change_notifications n
     SET status = 'SKIPPED', note = COALESCE(n.note, '') || $3
     FROM calendar_changes c
     WHERE n.change_id = c.change_id
       AND c.entity_type = $1
       AND c.entity_id = $2
       AND n.status = 'PENDING_CONTACT'`,
    [entityType, entityId, note]
  );
  return result.rowCount ?? 0;
};
