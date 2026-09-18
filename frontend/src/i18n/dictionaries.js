// سجل القواميس + دوال الترجمة المرتبطة باللغة النشطة
// تُستخدم خارج مكوّنات React (مثل lib/format.js و lib/api.js ورسائل الخادم)
import ar from './locales/ar'
import en from './locales/en'
import { DEFAULT_LOCALE, getLocale, isSupportedLocale } from './locale'
import { translate } from './translator'

export const DICTIONARIES = { ar, en }

export const dictionaryFor = (locale) => (isSupportedLocale(locale) ? DICTIONARIES[locale] : DICTIONARIES[DEFAULT_LOCALE])

// ترجمة فورية باللغة النشطة حالياً
export const t = (key, vars) => translate(dictionaryFor(getLocale()), getLocale(), key, vars)
