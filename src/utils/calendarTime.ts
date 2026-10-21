// أدوات التقويم والوقت لموديول الجدولة والعطل.
//
// قاعدة أساسية في هذا المشروع: التواريخ تُخزَّن كنص 'YYYY-MM-DD' والأوقات
// كأوقات جدارية (TIME) بلا منطقة زمنية. لذلك:
//   - حساب يوم الأسبوع لِتاريخ معطى لا يعتمد على المنطقة الزمنية إطلاقاً،
//     ويجب أن يتم إما في SQL عبر EXTRACT(DOW FROM date) أو هنا عبر getUTCDay
//     (وليس new Date(date).getDay() الذي يتأثر بتوقيت عملية Node).
//   - المنطقة الزمنية للعيادة (clinics.timezone) تُستخدم فقط لتفسير "الآن"
//     و"اليوم" ولعرض الوقت المحلي، لا لتخزين المواعيد.

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export const MS_PER_DAY = 86_400_000;

/**
 * يوم الأسبوع لتاريخ 'YYYY-MM-DD' بتوقيت UTC — 0 = الأحد .. 6 = السبت.
 * يطابق EXTRACT(DOW FROM date) في PostgreSQL وبديلاً مباشراً لـ
 * doctor_schedules.day_of_week (CHECK 0..6) وقيمة day_of_week في migrations.
 */
export const dayOfWeek = (date: string): number => {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return NaN;
  return new Date(parsed).getUTCDay();
};

/** رقم اليوم منذ حقبة يونكس — يُستخدم كمفتاح ثانٍ في أقفال الـadvisory. */
export const epochDay = (date: string): number =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);

/** هل التاريخ بنسيق ISO صحيح (YYYY-MM-DD) ويمثّل تاريخاً حقيقياً؟ */
export const isValidIsoDate = (date: unknown): date is string => {
  if (typeof date !== 'string' || !ISO_DATE_PATTERN.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === date;
};

/** هل الوقت بنسيق HH:MM أو HH:MM:SS صحيح؟ */
export const isValidTimeString = (time: unknown): time is string =>
  typeof time === 'string' && ISO_TIME_PATTERN.test(time);

/**
 * هل المنطقة الزمنية معروفة؟ (اسم IANA مثل 'Asia/Amman')
 * لا يمكن التحقق منها في قاعدة البيانات عبر CHECK لأن CHECK لا يقرأ جداول النظام.
 */
export const isValidTimeZone = (timezone: unknown): timezone is string => {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/**
 * تاريخ "اليوم" في العيادة للمنطقة الزمنية المعطاة (YYYY-MM-DD).
 * تُستخدم في التقارير وفي معاينة الأثر حتى لا يعتمد النظام على توقيت الخادم.
 */
export const clinicToday = (timezone: string, now: Date = new Date()): string => {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** قائمة الأيام (YYYY-MM-DD) بين تاريخين شاملة الطرفين. */
export const dateRange = (from: string, to: string): string[] => {
  const start = epochDay(from);
  const end = epochDay(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let d = start; d <= end; d += 1) {
    days.push(new Date(d * MS_PER_DAY).toISOString().slice(0, 10));
  }
  return days;
};
