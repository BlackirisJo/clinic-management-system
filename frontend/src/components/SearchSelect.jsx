import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { t, useT } from '../i18n'
import { api } from '../lib/api'

// ============================================================================
// اختيار بحثي (Combobox) — مربع بحث واحد يُصفّي النتائج أثناء الكتابة
// ----------------------------------------------------------------------------
// • مكوّن عام لا يعرف شيئًا عن المرضى أو الأدوية: يستقبل دالة الجلب ودوال العرض.
// • البحث من جهة الخادم (Server-side) لأن قوائم المرضى والأدوية في النظام لا
//   تُحمّل كاملة إلى المتصفح (محدودة بـ limit)، فتصفية العميل ستُخفي نتائج موجودة.
// • لا يُرسل طلبًا مع كل حرف: جلب كسول عند أول فتح + تأجيل (debounce).
// • يحافظ على العنصر المختار ظاهرًا حتى لو لم يعد ضمن نتائج التصفية الحالية.
// ============================================================================

const DEFAULT_LIMIT = 30
const DEFAULT_DEBOUNCE = 300

export function SearchSelect({
  value,
  onChange,
  fetchOptions,
  getOptionValue,
  getOptionLabel,
  getOptionMeta,
  placeholder,
  emptyText,
  loadingText,
  required,
  disabled,
  limit = DEFAULT_LIMIT,
  debounceMs = DEFAULT_DEBOUNCE,
}) {
  const t = useT()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const seqRef = useRef(0)                // رقم الطلب الأخير — لتجاهل الردود القديمة
  const emittedRef = useRef('')           // آخر قيمة أرسلناها للأب (لتمييز التغيير الخارجي)
  const immediateRef = useRef(false)      // أول جلب بعد الفتح فوري (بلا تأجيل)

  const idOf = (option) => (option ? String(getOptionValue(option)) : '')
  const labelOf = (option) => (option ? getOptionLabel(option) || '' : '')

  // مزامنة التغيير الخارجي (إعادة تعيين النموذج بعد الحفظ) مع حالة البحث المحلية
  useEffect(() => {
    const current = value === null || value === undefined ? '' : String(value)
    if (current === emittedRef.current) return
    emittedRef.current = current
    setSelected(null)
    setQuery('')
    setActiveIndex(-1)
  }, [value])

  // نص الجلب: إن كان النص هو نفسه اسم العنصر المختار (فتح القائمة بعد اختيار) نطلب القائمة الافتراضية
  const term = selected && query === labelOf(selected) ? '' : query.trim()

  const fetchNow = useCallback(async (searchTerm) => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    try {
      const rows = await fetchOptions(searchTerm)
      if (seq !== seqRef.current) return     // رد قديم: استُبدل بطلب أحدث
      setOptions(Array.isArray(rows) ? rows : [])
      setActiveIndex(-1)
    } catch (err) {
      if (seq !== seqRef.current) return
      setOptions([])
      setError(err?.message || t('common.loadFailed'))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [fetchOptions])

  // الجلب الكسول: لا طلب قبل فتح القائمة، ثم طلب واحد بعد انتهاء الكتابة (debounce)
  useEffect(() => {
    if (!open) return undefined
    const delay = immediateRef.current ? 0 : debounceMs
    immediateRef.current = false
    const timer = setTimeout(() => { fetchNow(term) }, delay)
    return () => clearTimeout(timer)
  }, [open, term, debounceMs, fetchNow])

  // إغلاق عند النقر خارج المكوّن
  useEffect(() => {
    if (!open) return undefined
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  // العنصر المختار يُعرض دائمًا في القائمة حتى لو خرج من نتائج التصفية
  const shown = selected && !options.some((o) => idOf(o) === idOf(selected)) ? [selected, ...options] : options
  const hitLimit = !loading && !error && shown.length >= limit
  const selectedId = value === null || value === undefined ? '' : String(value)

  function openList() {
    if (disabled || open) return
    immediateRef.current = true
    setOpen(true)
  }

  function closeList() {
    setOpen(false)
    setActiveIndex(-1)
  }

  function selectOption(option) {
    if (!option) return
    const id = idOf(option)
    emittedRef.current = id
    setSelected(option)
    setQuery(labelOf(option))
    setOpen(false)
    setActiveIndex(-1)
    onChange?.(id)
  }

  function clearAll() {
    seqRef.current += 1        // إبطال أي رد قيد الانتظار
    emittedRef.current = ''
    setSelected(null)
    setQuery('')
    setOptions([])
    setError('')
    setLoading(false)
    setActiveIndex(-1)
    setOpen(false)
    onChange?.('')
    inputRef.current?.focus()
  }

  function handleInput(e) {
    const text = e.target.value
    setQuery(text)
    setActiveIndex(-1)
    if (!open && !disabled) {
      immediateRef.current = true
      setOpen(true)
    }
    // تعديل النص يعني إلغاء الاختيار السابق (نفس سلوك القائمة المنسدلة الأصلية)
    if (selected) {
      setSelected(null)
      emittedRef.current = ''
      onChange?.('')
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { openList(); return }
      setActiveIndex((i) => (shown.length === 0 ? -1 : Math.min(i + 1, shown.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      if (!open || shown.length === 0) return
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      if (open && activeIndex >= 0 && shown[activeIndex]) {
        e.preventDefault()
        selectOption(shown[activeIndex])
        return
      }
      // بلا عنصر نشط: نغلق القائمة ونترك Enter يؤدي دوره الطبيعي في النموذج
      if (open) closeList()
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      closeList()
    }
  }

  return (
    <div className={`search-select${disabled ? ' disabled' : ''}`} ref={wrapRef}>
      <span className="ss-icon" aria-hidden="true">🔍</span>
      <input
        ref={inputRef}
        className="ss-input"
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-required={required ? 'true' : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
        onChange={handleInput}
        onFocus={openList}
        onClick={openList}
        onKeyDown={handleKeyDown}
        onBlur={closeList}
      />
      {/* حقل مرآة مخفي بصريًا (لكن قابل للتركيز) يُبقي تحقّق المتصفح required يعمل كما كان مع <select>
          ويأتي بعد حقل البحث حتى يبقى الحقل المرئي هو المرتبط بعنوان الحقل (Field) */}
      {required ? (
        <input className="ss-mirror" type="text" value={selectedId} onChange={() => {}} tabIndex={-1} aria-hidden="true" required />
      ) : null}
      {(query || selectedId) ? (
        <button type="button" className="ss-clear" onClick={clearAll} aria-label={t('common.search.clear')} tabIndex={-1}>×</button>
      ) : null}
      {open ? (
        <div className="ss-panel">
          {loading ? <div className="ss-state"><span className="loader" />{loadingText ?? t('common.search.loading')}</div> : null}
          {error ? <div className="ss-state error">{error}</div> : null}
          {!loading && !error && shown.length === 0 ? <div className="ss-state">{emptyText ?? t('common.search.noResults')}</div> : null}
          {!error && shown.length > 0 ? (
            <ul className="ss-list" id={listId} role="listbox" aria-label={placeholder}>
              {shown.map((option, index) => {
                const optionId = idOf(option)
                const meta = getOptionMeta ? getOptionMeta(option) : ''
                return (
                  <li
                    key={optionId}
                    id={`${listId}-opt-${index}`}
                    role="option"
                    aria-selected={optionId === selectedId}
                    tabIndex={-1}
                    className={`ss-option${index === activeIndex ? ' active' : ''}${optionId === selectedId ? ' selected' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(option)}
                  >
                    <span className="ss-option-label">{labelOf(option)}</span>
                    {meta ? <span className="ss-option-meta">{meta}</span> : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {hitLimit ? <div className="ss-more">{t('common.search.moreChars')}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

// ============================================================================
// أغلفة نطاقية رقيقة: تعرف الـ API والحقول الموجودة فعلًا في النظام
// (لا تُضاف أي حقول جديدة — نفس الحقول المعروضة اليوم فقط)
// ============================================================================

const PATIENT_LIMIT = 30
const MEDICATION_LIMIT = 50   // سقف خادم دليل الأدوية

const fetchPatientOptions = async (query) => {
  const result = await api.patients.list({ search: query || undefined, limit: PATIENT_LIMIT })
  return result.patients || []
}

const fetchMedicationOptions = async (query) => {
  const result = await api.prescriptions.listMedications(query ? { search: query } : {})
  return result.medications || []
}

const patientValue = (p) => p.patient_id
const patientLabel = (p) => p.full_name || t('search.patient.defaultLabel', { id: p.patient_id })
// بيانات تمييز المرضى المتشابهين: الهاتف ثم الرقم الوطني (حقول موجودة، وغير طبية)
const patientMeta = (p) => [p.phone, p.national_id].filter(Boolean).join(' · ')

const medicationValue = (m) => m.medication_id
const medicationLabel = (m) => (m.scientific_name ? `${m.trade_name} (${m.scientific_name})` : m.trade_name)
const medicationMeta = (m) => m.default_dosage || ''

export function PatientSearchSelect({ value, onChange, required, disabled }) {
  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      fetchOptions={fetchPatientOptions}
      getOptionValue={patientValue}
      getOptionLabel={patientLabel}
      getOptionMeta={patientMeta}
      placeholder={t('search.patient.placeholder')}
      emptyText={t('search.patient.noResults')}
      required={required}
      disabled={disabled}
      limit={PATIENT_LIMIT}
    />
  )
}

export function MedicationSearchSelect({ value, onChange, required, disabled }) {
  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      fetchOptions={fetchMedicationOptions}
      getOptionValue={medicationValue}
      getOptionLabel={medicationLabel}
      getOptionMeta={medicationMeta}
      placeholder={t('search.medication.placeholder')}
      emptyText={t('search.medication.noResults')}
      loadingText={t('search.medication.loading')}
      required={required}
      disabled={disabled}
      limit={MEDICATION_LIMIT}
    />
  )
}