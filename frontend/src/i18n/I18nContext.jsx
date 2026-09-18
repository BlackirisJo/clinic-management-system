import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { LANGUAGE_STORAGE_KEY, applyDocumentLocale, getLocale, localeDir, readStoredLocale, setActiveLocale } from './locale'
import { dictionaryFor } from './dictionaries'
import { createTranslator } from './translator'

// مزوّد اللغة: مصدر الحقيقة للغة الحالية في الواجهة
// - يقرأ الاختيار المحفوظ (localStorage) قبل أول رسم
// - يضبط document.documentElement.lang/dir عند كل تغيير
// - يبدّل اللغة فورياً بلا إعادة تحميل الصفحة
const I18nContext = createContext(null)

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(() => getLocale())

  const setLocale = useCallback((next) => {
    setLocaleState(setActiveLocale(next))
  }, [])

  // مزامنة اللغة بين التبويبات المفتوحة (نفس مفتاح التخزين)
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key && event.key !== LANGUAGE_STORAGE_KEY) return
      setLocaleState(setActiveLocale(readStoredLocale(), { persist: false }))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // ضمان تطابق lang/dir مع الحالة الحالية (يشمل أي تغيير خارجي)
  useEffect(() => {
    applyDocumentLocale(locale)
  }, [locale])

  const value = useMemo(() => {
    const dir = localeDir(locale)
    return {
      locale,
      dir,
      isRtl: dir === 'rtl',
      t: createTranslator(dictionaryFor(locale), locale),
      setLocale,
    }
  }, [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// الوصول الكامل للسياق (locale/dir/isRtl/t/setLocale)
export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used within I18nProvider')
  return context
}

// الاختصار الأكثر استخداماً داخل الشاشات: دالة الترجمة فقط
export function useT() {
  return useI18n().t
}

export default I18nProvider
