// منسّقات العرض حسب اللغة النشطة (أرقام/تواريخ/عملة/زمن نسبي)
// مهم: المخرجات العربية هنا مطابقة حرفياً لما كان في lib/format.js قبل هذه المرحلة (baseline)
// — لا تغيير في الأرقام العربية-الهندية للمبالغ، ولا في صيغ التواريخ، ولا في صياغة الزمن النسبي.
import { getLocale } from './locale'
import { t } from './dictionaries'
import { getBaseCurrency } from './currency';

// وسوم Intl لكل لغة (العربية تحتفظ بسلوكها الحالي حرفياً)
const TAGS = {
  ar: { number: 'ar-EG', date: 'ar-EG', dateTime: 'ar-EG-u-nu-latn' },
  en: { number: 'en-US', date: 'en-GB', dateTime: 'en-GB' },
}

const tagsFor = (locale) => TAGS[locale] || TAGS.ar

// تخزين مؤقت لمنسّقات Intl (تُبنى مرة واحدة لكل لغة/خيارات)
const numberCache = new Map()
const numberFormatter = (locale, options = {}) => {
  const key = `${locale}|${options.maximumFractionDigits ?? ''}`
  let formatter = numberCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    numberCache.set(key, formatter)
  }
  return formatter
}

export const fmtNumber = (value) => numberFormatter(tagsFor(getLocale()).number).format(Number(value) || 0)

// المبالغ: Intl.NumberFormat style:currency + الكود من البيانات أو العملة الأساسية
export const fmtMoney = (value, currencyCode) => {
  const n = Number(value) || 0
  const code = (currencyCode || getBaseCurrency())
  return new Intl.NumberFormat(tagsFor(getLocale()).number, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(n)
}

export const fmtDate = (value, compact = false) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  try {
    return date.toLocaleDateString(tagsFor(getLocale()).date, compact ? { day: 'numeric', month: 'short', year: 'numeric' } : undefined)
  } catch {
    return String(value)
  }
}

export const fmtDateTime = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  try {
    return date.toLocaleString(tagsFor(getLocale()).dateTime, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return String(value)
  }
}

// الوقت كما هو مخزّن (HH:MM) — لا يتبع اللغة (نفس السلوك الحالي)
export const fmtTime = (value) => {
  if (!value) return '—'
  return String(value).slice(0, 5)
}

// تاريخ اليوم للشريط العلوي
export const todayLabel = () => {
  try {
    return new Intl.DateTimeFormat(tagsFor(getLocale()).date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
  } catch {
    return new Date().toLocaleDateString()
  }
}

// "آخر نشاط" بنص نسبي (المفاتيح في القاموس، والعربية تحفظ صياغتها الحالية)
export const fmtRelative = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 15) return t('time.momentsAgo')
  if (seconds < 60) return t('time.secondsAgo', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.daysAgo', { count: days })
  return fmtDate(value)
}
