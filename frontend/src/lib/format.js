// أدوات تنسيق عامة

export const fmtMoney = (value) => {
  const n = Number(value) || 0
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(n) + ' د.أ'
}

export const fmtNumber = (value) => {
  const n = Number(value) || 0
  return new Intl.NumberFormat('ar-EG').format(n)
}

export const fmtDate = (value, compact = false) => {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  try {
    return d.toLocaleDateString('ar-EG', compact ? { day: 'numeric', month: 'short', year: 'numeric' } : undefined)
  } catch {
    return String(value)
  }
}

export const fmtDateTime = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  try {
    return d.toLocaleString('ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return String(value)
  }
}

export const fmtTime = (value) => {
  if (!value) return '—'
  return String(value).slice(0, 5)
}

// تاريخ اليوم بالعربية لعرضه في الشريط العلوي
export const todayLabel = () => {
  try {
    return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
  } catch {
    return new Date().toLocaleDateString()
  }
}

// خرائط الحالات إلى العبارات العربية
export const GENDER_LABELS = { MALE: 'ذكر', FEMALE: 'أنثى' }

export const APPOINTMENT_STATUS = {
  SCHEDULED: { label: 'مجدول', cls: 'scheduled' },
  CONFIRMED: { label: 'مؤكد', cls: 'confirmed' },
  COMPLETED: { label: 'مكتمل', cls: 'completed' },
  CANCELLED: { label: 'ملغي', cls: 'cancelled' },
  NO_SHOW: { label: 'لم يحضر', cls: 'no-show' },
}

export const PAYMENT_TYPES = {
  CASH: { label: 'نقدي', cls: 'cash' },
  CARD: { label: 'بطاقة', cls: 'card' },
  INSURANCE: { label: 'تأمين', cls: 'insurance' },
  SPLIT: { label: 'تجزئة', cls: 'split' },
}

export const ROLE_LABELS = {
  SUPER_ADMIN: 'مدير النظام',
  SYSTEM_ADMIN: 'مدير النظام',
  DOCTOR: 'طبيب',
  ACCOUNTANT: 'محاسب',
  RECEPTIONIST: 'استقبال',
}

export const USER_STATUS = {
  ACTIVE: { label: 'نشط', cls: 'completed' },
  SUSPENDED: { label: 'موقوف', cls: 'cancelled' },
  PASSWORD_RESET_REQUIRED: { label: 'يتطلب تغيير كلمة المرور', cls: 'scheduled' },
}