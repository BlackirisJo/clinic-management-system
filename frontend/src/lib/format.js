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

export const DOCUMENT_TYPE_LABELS = { NATIONAL_ID: 'بطاقة شخصية', PASSPORT: 'جواز سفر', OTHER: 'أخرى' }

export const ALLERGEN_LABELS = { PENICILLIN: 'البنسلين', ASPIRIN: 'الأسبرين', SULFA: 'السلفا', LATEX: 'اللاتكس', FOOD: 'الأطعمة', POLLEN: 'حبوب اللقاح', INSECT_STING: 'لسعات الحشرات', OTHER: 'أخرى' }
export const ALLERGEN_KEYS = Object.keys(ALLERGEN_LABELS)

export const CHRONIC_CONDITION_LABELS = { DIABETES: 'السكري', HYPERTENSION: 'ضغط الدم', ASTHMA: 'الربو', HEART_DISEASE: 'أمراض القلب', KIDNEY_DISEASE: 'أمراض الكلى', THYROID: 'الغدة الدرقية', ANEMIA: 'فقر الدم', OTHER: 'أخرى' }
export const CHRONIC_CONDITION_KEYS = Object.keys(CHRONIC_CONDITION_LABELS)

export const CONDITION_SEVERITY_LABELS = { MILD: 'خفيف', MODERATE: 'متوسط', SEVERE: 'شديد', GESTATIONAL: 'حملي', TRANSIENT: 'عرضي / مؤقت', UNSPECIFIED: 'غير محدد' }

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
  NURSE: 'ممرض/ة',
  ACCOUNTANT: 'محاسب',
  RECEPTIONIST: 'استقبال',
}

export const USER_STATUS = {
  ACTIVE: { label: 'نشط', cls: 'completed' },
  SUSPENDED: { label: 'موقوف', cls: 'cancelled' },
  PASSWORD_RESET_REQUIRED: { label: 'يتطلب تغيير كلمة المرور', cls: 'scheduled' },
}

// حالات الفاتورة (مشتقة في الخادم من المدفوع مقابل الصافي)
export const INVOICE_STATUS = {
  PAID: { label: 'مدفوعة', cls: 'completed' },
  PARTIAL: { label: 'مدفوعة جزئياً', cls: 'scheduled' },
  UNPAID: { label: 'غير مدفوعة', cls: 'cancelled' },
}

// رقم الفاتورة المعروض: INV-<السنة>-<المعرف بأربع خانات> (نفس منطق الخادم)
export const fmtInvoiceNumber = (invoiceId, createdAt) => {
  if (invoiceId === undefined || invoiceId === null) return '—'
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear()
  const safeYear = Number.isNaN(year) ? new Date().getFullYear() : year
  return `INV-${safeYear}-${String(Number(invoiceId)).padStart(4, '0')}`
}