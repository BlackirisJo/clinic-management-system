// حالة اللغة على مستوى الوحدة (بلا React) — مصدر واحد يقرأه:
// - I18nProvider (الحالة التفاعلية في الواجهة)
// - المنسّقات src/i18n/formatters.js و lib/format.js
// قاعدة: الافتراضي عربي دائماً ما لم يوجد اختيار محفوظ (لا تغيير في السلوك الحالي).
// ملاحظة: لا يُستخدم navigator.language إطلاقاً لتفادي تحويل أي مستخدم حالي إلى الإنجليزية صامتاً.

export const LANGUAGE_STORAGE_KEY = 'clinic_lang'
export const DEFAULT_LOCALE = 'ar'
export const SUPPORTED_LOCALES = ['ar', 'en']

const DIRECTIONS = { ar: 'rtl', en: 'ltr' }

export const isSupportedLocale = (value) => SUPPORTED_LOCALES.includes(value)

export const localeDir = (locale) => DIRECTIONS[locale] || DIRECTIONS[DEFAULT_LOCALE]

// قراءة الاختيار المحفوظ محلياً — والافتراضي عربي
export function readStoredLocale() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isSupportedLocale(stored)) return stored
  } catch {
    // التخزين غير متاح (وضع خاص أو معطّل) — نكمل بالافتراضي
  }
  return DEFAULT_LOCALE
}

let activeLocale = readStoredLocale()

export const getLocale = () => activeLocale
export const getDir = () => localeDir(activeLocale)

// ضبط خصائص الصفحة (lang/dir) — يُستدعى قبل أول رسم لمنع وميض الاتجاه (FOUC)
export function applyDocumentLocale(locale) {
  const next = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  if (typeof document === 'undefined' || !document.documentElement) return next
  document.documentElement.lang = next
  document.documentElement.dir = localeDir(next)
  return next
}

// تغيير اللغة: يحفظ الاختيار + يضبط خصائص الصفحة + يحدّث حالة الوحدة
// (إعادة الرسم تكفلها I18nProvider — بلا إعادة تحميل الصفحة)
export function setActiveLocale(locale, { persist = true } = {}) {
  const next = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  activeLocale = next
  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next)
    } catch {
      // التخزين غير متاح
    }
  }
  applyDocumentLocale(next)
  return next
}
