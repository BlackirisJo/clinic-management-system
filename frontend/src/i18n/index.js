// الواجهة الموحّدة لنظام الترجمة (عربي ↔ إنجليزي)
// الاستخدام داخل المكوّنات: import { useT } from '../i18n'
// الاستخدام خارج المكوّنات: import { t, fmtMoney } from '../i18n'
export { I18nProvider, useI18n, useT } from './I18nContext'
export {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  applyDocumentLocale,
  getDir,
  getLocale,
  isSupportedLocale,
  localeDir,
  readStoredLocale,
  setActiveLocale,
} from './locale'
export { DICTIONARIES, dictionaryFor, t } from './dictionaries'
export { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtRelative, fmtTime, todayLabel } from './formatters'
export { collectPlaceholders, createTranslator, dictionaryKeys, interpolate, translate } from './translator'
