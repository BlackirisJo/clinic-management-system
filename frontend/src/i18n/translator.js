// مترجم نقي (بلا React وبلا أي اعتماديات خارجية)
// القواعد المتفق عليها:
// 1) لا يوجد أي fallback بين اللغات: العربية لا تعرض نصاً إنجليزياً، والإنجليزية لا تعرض نصاً عربياً.
// 2) عند فقدان المفتاح يُعاد المفتاح نفسه — ظاهر في الاختبار البصري ويكشفه npm run i18n:check.
// 3) القواميس مسطّحة (domain.name)، وقيم الجمع كائنات (zero/one/two/few/many/other)
//    تُختار عبر Intl.PluralRules ويسقط المترجم إلى other عند غياب الصيغة المطلوبة.
// 4) المتغيّرات بصيغة {{name}} تُستبدل من كائن القيم (والمتغيّر غير المُمرَّر يصبح نصاً فارغاً).

const pluralRulesCache = new Map()

// صيغ الجمع — Intl مدمج في المتصفح وNode فلا حاجة لأي مكتبة
const pluralRulesFor = (locale) => {
  const key = locale === 'en' ? 'en' : 'ar'
  let rules = pluralRulesCache.get(key)
  if (!rules) {
    rules = new Intl.PluralRules(key)
    pluralRulesCache.set(key, rules)
  }
  return rules
}

export const isPluralValue = (value) => Boolean(value) && typeof value === 'object'

// استبدال المتغيّرات {{name}} داخل نص
export const interpolate = (template, vars) => {
  if (!vars) return template
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    const value = vars[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

// ترجمة مفتاح واحد وفق قاموس ولغة محدّدين
export function translate(dictionary, locale, key, vars) {
  const value = dictionary ? dictionary[key] : undefined
  if (typeof value === 'string') return interpolate(value, vars)
  if (isPluralValue(value)) {
    const count = Number(vars?.count ?? vars?.n ?? 0)
    const category = pluralRulesFor(locale).select(count)
    const chosen = value[category] ?? value.other
    if (typeof chosen === 'string') return interpolate(chosen, vars)
  }
  // لا fallback بين اللغات: يُعاد المفتاح كما هو
  return key
}

// دالة ترجمة مربوطة بقاموس ولغة (يستخدمها I18nProvider)
export const createTranslator = (dictionary, locale) => (key, vars) => translate(dictionary, locale, key, vars)

// مفاتيح القاموس (القواميس مسطّحة: domain.name)
export const dictionaryKeys = (dictionary) => (dictionary && typeof dictionary === 'object' ? Object.keys(dictionary) : [])

// أسماء المتغيّرات {{name}} داخل قيمة (نص أو كائن صيغ جمع) — يستخدمها فحص i18n
// @returns {string[]}
export function collectPlaceholders(value, out = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      if (!out.includes(match[1])) out.push(match[1])
    }
    return out
  }
  if (isPluralValue(value)) {
    for (const item of Object.values(value)) collectPlaceholders(item, out)
  }
  return out
}
