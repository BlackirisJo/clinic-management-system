// ============================================================================
// فحص اكتمال الترجمة (i18n) — يُشغَّل عبر: npm run i18n:check
// ----------------------------------------------------------------------------
// يُفشل الفحص عند:
//   1) اختلاف مفاتيح القاموسين (ar/en) — لا مفتاح ناقص في أي جهة
//   2) اختلاف متغيّرات {{...}} بين اللغتين للمفتاح نفسه
//   3) وجود نص عربي داخل قيم القاموس الإنجليزي (منع التسريب الصامت للعربية)
//   4) غياب مفتاح في القاموسين وهو مستخدم في الكود عبر t(...)
//   5) تمرير جملة بدل مفتاح إلى t()
//   6) عدم تطابق مفتاح التخزين بين index.html و src/i18n/locale.js
// ويطبع كتنبيه فقط (مؤشر تقدّم الترحيل ولا يُفشل الفحص):
//   - مواضع النصوص العربية الخام المتبقية داخل ملفات JSX
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ar from '../src/i18n/locales/ar.js'
import en from '../src/i18n/locales/en.js'
import { collectPlaceholders, dictionaryKeys } from '../src/i18n/translator.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(ROOT, 'src')
const I18N_DIR = join(SRC_DIR, 'i18n')
const INDEX_HTML = join(ROOT, 'index.html')
const LOCALE_MODULE = join(I18N_DIR, 'locale.js')

const ARABIC_RE = /[\u0600-\u06FF]/
const ARABIC_RUNS_RE = /[\u0600-\u06FF]+/g
const KEY_SHAPE_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/
const T_CALL_RE = /\bt\(\s*'([^'\\]*)'/g
const STORAGE_KEY_RE = /LANGUAGE_STORAGE_KEY\s*=\s*'([^']+)'/

// مفاتيح يُسمح لها بحمل نص عربي في القاموس الإنجليزي (لا شيء حالياً)
const ALLOW_ARABIC_IN_EN = new Set([])

const failures = []
const warnings = []
const print = (line = '') => process.stdout.write(String(line) + '\n')
const toPosix = (file) => relative(ROOT, file).split(sep).join('/')
const isPluralValue = (value) => Boolean(value) && typeof value === 'object'

// ملفات المصدر (.js/.jsx) داخل src
function listSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full))
    else if (/\.(js|jsx)$/.test(entry)) files.push(full)
  }
  return files
}

// إزالة التعليقات مع تجاهل ما داخل النصوص (لمنع قراءة الأمثلة من التعليقات)
function stripComments(source) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; i += 1; continue }
      if (char === '/' && next === '*') { state = 'block'; i += 1; continue }
      if (char === String.fromCharCode(39) || char === String.fromCharCode(34) || char === '`') {
        state = char === '`' ? 'template' : 'quote'
        out += char
        continue
      }
      out += char
      continue
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char }
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; i += 1 }
      continue
    }
    if (state === 'template') {
      if (char === '\\') { out += char + (next ?? ''); i += 1; continue }
      out += char
      if (char === '`') state = 'code'
      continue
    }
    if (state === 'quote') {
      if (char === '\\') { out += char + (next ?? ''); i += 1; continue }
      out += char
      if (char === String.fromCharCode(39) || char === String.fromCharCode(34)) state = 'code'
      continue
    }
  }
  return out
}
// ===== 1) تطابق المفاتيح بين اللغتين =====
const arKeys = dictionaryKeys(ar)
const enKeys = dictionaryKeys(en)
const arSet = new Set(arKeys)
const enSet = new Set(enKeys)

const missingInEn = arKeys.filter((key) => !enSet.has(key))
const missingInAr = enKeys.filter((key) => !arSet.has(key))
if (missingInEn.length) failures.push(`مفاتيح موجودة في ar.js وغير موجودة في en.js: ${missingInEn.join(', ')}`)
if (missingInAr.length) failures.push(`مفاتيح موجودة في en.js وغير موجودة في ar.js: ${missingInAr.join(', ')}`)

// ===== 2) المتغيّرات وصيغ الجمع =====
for (const key of arKeys) {
  if (!enSet.has(key)) continue
  const arVars = collectPlaceholders(ar[key])
  const enVars = collectPlaceholders(en[key])
  const missingVars = arVars.filter((name) => !enVars.includes(name))
  const extraVars = enVars.filter((name) => !arVars.includes(name))
  if (missingVars.length) failures.push(`المفتاح "${key}": متغيّرات موجودة في ar ومفقودة في en (${missingVars.join(', ')})`)
  if (extraVars.length) failures.push(`المفتاح "${key}": متغيّرات زائدة في en (${extraVars.join(', ')})`)
  if (isPluralValue(ar[key]) && !ar[key].other) failures.push(`المفتاح "${key}": صيغة الجمع other مفقودة في ar.js`)
  if (isPluralValue(en[key]) && !en[key].other) failures.push(`المفتاح "${key}": صيغة الجمع other مفقودة في en.js`)
}

// ===== 3) نقاء القاموس الإنجليزي (لا نص عربي في القيم) =====
const arabicInEn = enKeys.filter((key) => !ALLOW_ARABIC_IN_EN.has(key) && ARABIC_RE.test(JSON.stringify(en[key] ?? '')))
if (arabicInEn.length) failures.push(`نص عربي داخل قيم en.js (ممنوع — لا fallback بين اللغات): ${arabicInEn.join(', ')}`)

// ===== 4 و 5) المفاتيح المستخدمة في الكود =====
const sourceFiles = listSourceFiles(SRC_DIR)
const usedKeys = new Map()
for (const file of sourceFiles) {
  if (file.startsWith(I18N_DIR)) continue
  const rawSource = readFileSync(file, 'utf8')
  // الاتحاد بين النص الأصلي والنص بلا تعليقات: احتياط ضد أي تحليل ناقص
  const searched = stripComments(rawSource) + '\n' + rawSource
  for (const match of searched.matchAll(T_CALL_RE)) {
    const key = match[1]
    if (!usedKeys.has(key)) usedKeys.set(key, new Set())
    usedKeys.get(key).add(toPosix(file))
  }
}
for (const [key, files] of usedKeys) {
  const where = [...files].join(', ')
  if (!KEY_SHAPE_RE.test(key)) {
    failures.push(`t() استُدعيت بنص جملة بدل مفتاح في ${where}: "${key}"`)
    continue
  }
  if (!arSet.has(key)) failures.push(`مفتاح مستخدم وغير موجود في ar.js: "${key}" (${where})`)
  if (!enSet.has(key)) failures.push(`مفتاح مستخدم وغير موجود في en.js: "${key}" (${where})`)
}

// ===== 6) مفتاح التخزين مشترك بين index.html و locale.js =====
const storageKey = readFileSync(LOCALE_MODULE, 'utf8').match(STORAGE_KEY_RE)
if (!storageKey) {
  failures.push('تعذّر قراءة LANGUAGE_STORAGE_KEY من src/i18n/locale.js')
} else if (!readFileSync(INDEX_HTML, 'utf8').includes(String.fromCharCode(39) + storageKey[1] + String.fromCharCode(39))) {
  failures.push(`مفتاح التخزين ${storageKey[1]} غير موجود في index.html (سكربت ما قبل الرسم)`)
}

// ===== تنبيهات: النصوص العربية الخام المتبقية في JSX (مؤشر تقدّم الترحيل) =====
const arabicFiles = []
for (const file of sourceFiles) {
  if (!file.endsWith('.jsx') || file.startsWith(I18N_DIR)) continue
  const code = stripComments(readFileSync(file, 'utf8'))
  const count = (code.match(ARABIC_RUNS_RE) || []).length
  if (count > 0) arabicFiles.push({ file: toPosix(file), count })
}
arabicFiles.sort((a, b) => b.count - a.count)
const arabicTotal = arabicFiles.reduce((sum, item) => sum + item.count, 0)
if (arabicTotal > 0) {
  warnings.push(`نصوص عربية خام متبقية في JSX: ${arabicTotal} كتلة نصية في ${arabicFiles.length} ملفاً (تُهاجر للقواميس في المراحل التالية)`)
  for (const item of arabicFiles.slice(0, 10)) warnings.push(`   - ${item.file}: ${item.count}`)
  if (arabicFiles.length > 10) warnings.push(`   ... و${arabicFiles.length - 10} ملفاً آخر`)
}

// ===== التقرير =====
print('=== i18n check ===')
print(`القاموس العربي: ${arKeys.length} مفتاح | القاموس الإنجليزي: ${enKeys.length} مفتاح`)
print(`مفاتيح مستخدمة في الكود: ${usedKeys.size}`)
print('')
if (warnings.length) {
  print('تنبيهات (لا تُفشل الفحص):')
  for (const warning of warnings) print(warning)
  print('')
}
if (failures.length) {
  print(`فشل الفحص: ${failures.length} مشكلة`)
  for (const failure of failures) print(`   x ${failure}`)
  process.exitCode = 1
} else {
  print('نجح الفحص: لا مفاتيح ناقصة ولا تسريب لغة بين القاموسين')
  process.exitCode = 0
}
