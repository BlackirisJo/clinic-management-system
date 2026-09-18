import { useI18n } from '../i18n'

// أسماء اللغات تُعرض دائماً بلغتها الأصلية (لا تُترجم) — كما تفعل الأنظمة الاحترافية
const LANGUAGES = [
  { code: 'ar', label: 'العربية' },
  { code: 'en', label: 'English' },
]

// مبدّل اللغة: تبديل فوري بلا إعادة تحميل، والاختيار يُحفظ محلياً داخل I18nProvider
// variant: login (صفحة الدخول) أو sidebar (داخل النظام)
export default function LanguageSwitcher({ variant = 'login' }) {
  const { locale, setLocale, t } = useI18n()

  return (
    <div className={`lang-switch ${variant}`} role="group" aria-label={t('lang.switchLabel')}>
      {LANGUAGES.map((language) => (
        <button
          key={language.code}
          type="button"
          lang={language.code}
          className={locale === language.code ? 'lang-option active' : 'lang-option'}
          aria-pressed={locale === language.code}
          onClick={() => setLocale(language.code)}
        >
          {language.label}
        </button>
      ))}
    </div>
  )
}
