import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDate, fmtDateTime } from '../lib/format'
import { Field, Loading, Empty, Notice } from './ui'

const RISK_LABELS = { NORMAL: 'حمل طبيعي', HIGH: 'حمل عالي الخطورة' }
const OUTCOME_LABELS = { ONGOING: 'مستمر', LIVE_BIRTH: 'ولادة حية', STILLBIRTH: 'ولادة ميتة', MISCARRIAGE: 'إجهاض' }
const DELIVERY_METHODS = { VAGINAL: 'ولادة طبيعية', VAGINAL_ASSISTED: 'طبيعية بمساعدة', CESAREAN: 'قيصرية' }

// لوحة متابعة الحمل الكاملة: سجل الحمل + الزيارات الدورية + السونار + الخط الزمني
export default function PregnancyPanel({ patientId, visitId }) {
  const [pregnancies, setPregnancies] = useState(null)
  const [active, setActive] = useState(null)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const loadList = useCallback(async () => {
    setError('')
    try {
      const result = await api.clinical.pregnancies(patientId)
      setPregnancies(result.pregnancies || [])
    } catch (err) { setError(err.message || 'تعذر تحميل سجلات الحمل'); setPregnancies([]) }
  }, [patientId])

  useEffect(() => { loadList() }, [loadList])

  const openDetails = async (pregnancyId) => {
    setActive(null)
    try {
      const result = await api.clinical.pregnancy(pregnancyId)
      setActive(result)
    } catch (err) { setError(err.message) }
  }

  if (pregnancies === null) return <Loading text="جارِ تحميل سجلات الحمل" />

  const activePregnancy = pregnancies.find((p) => p.status === 'ACTIVE')
  const linkedPv = visitId && active?.pregnancy_visits?.find((pv) => pv.visit_id === visitId)

  return (
    <div className="tab-inner pregnancy-panel">
      <Notice kind="error">{error}</Notice>

      <div className="pregnancy-header">
        <h4>سجلات الحمل ({pregnancies.length})</h4>
        {!activePregnancy && !showCreate && (
          <button className="primary-button compact" onClick={() => setShowCreate(true)}>+ بدء سجل حمل جديد</button>
        )}
      </div>

      {showCreate && (
        <CreatePregnancyForm
          patientId={patientId}
          onClose={() => setShowCreate(false)}
          onSaved={(created) => { setShowCreate(false); loadList(); if (created?.pregnancy?.pregnancy_id) openDetails(created.pregnancy.pregnancy_id) }}
          setError={setError}
        />
      )}

      {pregnancies.length === 0 && !showCreate ? <Empty text="لا توجد سجلات حمل لهذه المريضة" /> : (
        <div className="pregnancy-list">
          {pregnancies.map((p) => (
            <button key={p.pregnancy_id} className={`pregnancy-card ${active?.pregnancy?.pregnancy_id === p.pregnancy_id ? 'selected' : ''}`} onClick={() => openDetails(p.pregnancy_id)}>
              <div>
                <strong>حمل #{p.pregnancy_id}</strong>
                <span className={`chip small ${p.risk_level === 'HIGH' ? 'chip-warn' : ''}`}>{RISK_LABELS[p.risk_level] || p.risk_level}</span>
                <span className="chip small">{p.status === 'ACTIVE' ? 'نشط' : OUTCOME_LABELS[p.outcome] || 'منتهي'}</span>
              </div>
              <div className="muted-small">
                G{p.gravida ?? 1} P{p.para ?? 0} A{p.abortions ?? 0}
                {p.lmp_date ? ` • آخر دورة: ${fmtDate(p.lmp_date)}` : ''}
                {p.edd_date ? ` • الولادة المتوقعة: ${fmtDate(p.edd_date)}` : ''}
                {p.current_gestational_age ? ` • العمر الحملي: ${p.current_gestational_age.weeks}أ+${p.current_gestational_age.days}ي` : ''}
                {` • ${p.visits_count} زيارة • ${p.ultrasound_count} سونار`}
              </div>
            </button>
          ))}
        </div>
      )}

      {linkedPv && (
        <Notice kind="success">هذه الزيارة مرتبطة بزيارة متابعة حمل (الأسبوع {linkedPv.ga_weeks}{linkedPv.ga_days !== null ? `+${linkedPv.ga_days}` : ''})</Notice>
      )}

      {active && (
        <PregnancyDetails data={active} visitId={visitId} reload={() => { loadList(); openDetails(active.pregnancy.pregnancy_id) }} setError={setError} />
      )}
    </div>
  )
}

// نموذج إنشاء سجل حمل
function CreatePregnancyForm({ patientId, onClose, onSaved, setError }) {
  const [form, setForm] = useState({
    lmp_date: '', edd_date: '', gravida: 1, para: 0, abortions: 0, living_children: 0,
    previous_pregnancies: '', blood_group: '', rh_factor: '', risk_level: 'NORMAL', risk_factors: '', notes: '',
  })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      // تجريد الحقول الفارغة: '' غير مقبول في مخطط التحقق (تواريخ/أنواع) — تُرسل كحقول محذوفة
      const cleaned = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== null && v !== undefined))
      const result = await api.clinical.createPregnancy({ ...cleaned, patient_id: patientId })
      onSaved(result)
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form className="patient-form pregnancy-create" onSubmit={submit}>
      <div className="form-row">
        <Field label="تاريخ آخر دورة (LMP)" required hint="يُحسب موعد الولادة تلقائياً = LMP + 280 يوماً">
          <input type="date" required value={form.lmp_date} onChange={(e) => setForm({ ...form, lmp_date: e.target.value })} />
        </Field>
        <Field label="موعد الولادة المتوقع (EDD)" hint="اتركه فارغاً للحساب التلقائي">
          <input type="date" value={form.edd_date} onChange={(e) => setForm({ ...form, edd_date: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Gravida (عدد الحمول)"><input type="number" min="1" max="30" value={form.gravida} onChange={(e) => setForm({ ...form, gravida: e.target.value })} /></Field>
        <Field label="Para (الولادات)"><input type="number" min="0" max="30" value={form.para} onChange={(e) => setForm({ ...form, para: e.target.value })} /></Field>
        <Field label="Abortions (الإجهاضات)"><input type="number" min="0" max="30" value={form.abortions} onChange={(e) => setForm({ ...form, abortions: e.target.value })} /></Field>
        <Field label="الأطفال الأحياء"><input type="number" min="0" max="30" value={form.living_children} onChange={(e) => setForm({ ...form, living_children: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label="فصيلة الدم">
          <select value={form.blood_group} onChange={(e) => setForm({ ...form, blood_group: e.target.value })}>
            <option value="">غير محددة</option>
            {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bt) => <option key={bt} value={bt}>{bt}</option>)}
          </select>
        </Field>
        <Field label="عامل Rh">
          <select value={form.rh_factor} onChange={(e) => setForm({ ...form, rh_factor: e.target.value })}>
            <option value="">غير محدد</option>
            <option value="POSITIVE">+ موجب</option>
            <option value="NEGATIVE">- سالب</option>
          </select>
        </Field>
        <Field label="مستوى الخطورة">
          <select value={form.risk_level} onChange={(e) => setForm({ ...form, risk_level: e.target.value })}>
            <option value="NORMAL">طبيعي</option>
            <option value="HIGH">عالي الخطورة</option>
          </select>
        </Field>
      </div>
      <Field label="تاريخ الحمول السابقة والولادات والمضاعفات">
        <textarea rows="2" value={form.previous_pregnancies} onChange={(e) => setForm({ ...form, previous_pregnancies: e.target.value })} placeholder="مثال: 2021 قيصرية بسبب عدم تقدم المخاض..." />
      </Field>
      {form.risk_level === 'HIGH' && (
        <Field label="عوامل الخطورة">
          <textarea rows="2" value={form.risk_factors} onChange={(e) => setForm({ ...form, risk_factors: e.target.value })} placeholder="سكري حملي، ضغط، عمر متقدم..." />
        </Field>
      )}
      <Field label="ملاحظات"><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>إلغاء</button>
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الإنشاء...' : 'إنشاء سجل الحمل'}</button>
      </div>
    </form>
  )
}

// تفاصيل الحمل: معلومات + زيارات المتابعة (Timeline) + السونار
function PregnancyDetails({ data, visitId, reload, setError }) {
  const { pregnancy, pregnancy_visits, ultrasounds, attachments } = data
  const [section, setSection] = useState('timeline')

  return (
    <div className="pregnancy-details">
      <div className="pregnancy-summary">
        <div className="summary-grid">
          <div><span>العمر الحملي الحالي</span><strong>{pregnancy.current_gestational_age ? `${pregnancy.current_gestational_age.weeks} أسبوع + ${pregnancy.current_gestational_age.days} يوم` : '—'}</strong></div>
          <div><span>LMP</span><strong>{fmtDate(pregnancy.lmp_date)}</strong></div>
          <div><span>EDD</span><strong>{fmtDate(pregnancy.edd_date)}</strong></div>
          <div><span>G/P/A</span><strong>G{pregnancy.gravida ?? 1} P{pregnancy.para ?? 0} A{pregnancy.abortions ?? 0}</strong></div>
          <div><span>فصيلة الدم</span><strong>{pregnancy.blood_group || '—'}{pregnancy.rh_factor ? ` ${pregnancy.rh_factor === 'POSITIVE' ? '(+)' : '(-)'}` : ''}</strong></div>
          <div><span>الخطورة</span><strong className={pregnancy.risk_level === 'HIGH' ? 'risk-high' : ''}>{RISK_LABELS[pregnancy.risk_level]}</strong></div>
        </div>
        {pregnancy.risk_factors ? <p className="profile-meta"><strong>عوامل الخطورة:</strong> {pregnancy.risk_factors}</p> : null}
        {pregnancy.previous_pregnancies ? <p className="profile-meta"><strong>الحمول السابقة:</strong> {pregnancy.previous_pregnancies}</p> : null}
        {pregnancy.status === 'COMPLETED' && (
          <p className="profile-meta"><strong>النتيجة:</strong> {OUTCOME_LABELS[pregnancy.outcome]}{pregnancy.delivery_date ? ` — ${fmtDate(pregnancy.delivery_date)}` : ''}{pregnancy.delivery_method ? ` — ${DELIVERY_METHODS[pregnancy.delivery_method] || pregnancy.delivery_method}` : ''}</p>
        )}
        {pregnancy.status === 'ACTIVE' && (
          <ClosePregnancyControl pregnancy={pregnancy} reload={reload} setError={setError} />
        )}
      </div>

      <div className="tab-bar">
        <button className={section === 'timeline' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('timeline')}>الخط الزمني ({pregnancy_visits.length})</button>
        <button className={section === 'addvisit' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('addvisit')}>+ زيارة متابعة</button>
        <button className={section === 'ultrasound' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('ultrasound')}>السونار ({ultrasounds.length})</button>
        <button className={section === 'attachments' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('attachments')}>المرفقات ({attachments.length})</button>
      </div>

      {section === 'timeline' && <PregnancyTimeline visits={pregnancy_visits} pregnancyId={pregnancy.pregnancy_id} reload={reload} setError={setError} />}
      {section === 'addvisit' && <AddPregnancyVisit pregnancy={pregnancy} visitId={visitId} reload={reload} setError={setError} />}
      {section === 'ultrasound' && <UltrasoundSection pregnancy={pregnancy} ultrasounds={ultrasounds} visitId={visitId} reload={reload} setError={setError} />}
      {section === 'attachments' && <PregnancyAttachments attachments={attachments} setError={setError} />}
    </div>
  )
}

// التحكم بإغلاق الحمل عند الولادة
function ClosePregnancyControl({ pregnancy, reload, setError }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ outcome: 'LIVE_BIRTH', delivery_date: '', delivery_method: 'VAGINAL', delivery_notes: '' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.clinical.updatePregnancy(pregnancy.pregnancy_id, {
        status: 'COMPLETED',
        outcome: form.outcome,
        delivery_date: form.delivery_date || null,
        delivery_method: form.outcome === 'LIVE_BIRTH' ? form.delivery_method : null,
        delivery_notes: form.delivery_notes || null,
      })
      setOpen(false)
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  if (!open) return <button className="secondary-button compact" onClick={() => setOpen(true)}>إغلاق سجل الحمل (تسجيل الولادة/النتيجة)</button>

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label="النتيجة">
          <select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
            {Object.entries(OUTCOME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="تاريخ الولادة/النهاية"><input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} /></Field>
        {form.outcome === 'LIVE_BIRTH' && (
          <Field label="طريقة الولادة">
            <select value={form.delivery_method} onChange={(e) => setForm({ ...form, delivery_method: e.target.value })}>
              {Object.entries(DELIVERY_METHODS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label="ملاحظات الولادة"><textarea rows="2" value={form.delivery_notes} onChange={(e) => setForm({ ...form, delivery_notes: e.target.value })} /></Field>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={() => setOpen(false)}>إلغاء</button>
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'تأكيد الإغلاق'}</button>
      </div>
    </form>
  )
}

// الخط الزمني للحمل: كل زيارة ببياناتها من البداية حتى الولادة
function PregnancyTimeline({ visits, pregnancyId, reload, setError }) {
  if (visits.length === 0) return <Empty text="لا توجد زيارات متابعة بعد — أضف أول زيارة من تبويب (زيارة متابعة)" />

  return (
    <div className="pregnancy-timeline">
      {visits.map((pv, i) => (
        <div className="timeline-item" key={pv.pv_id}>
          <div className="timeline-dot" />
          <div className="timeline-content">
            <div className="timeline-head">
              <strong>زيارة متابعة #{i + 1}</strong>
              <span className="chip small">{pv.ga_weeks ?? '—'}أ{pv.ga_days !== null && pv.ga_days !== undefined ? `+${pv.ga_days}ي` : ''}</span>
              <span className="muted-small">{fmtDateTime(pv.visit_date)}</span>
              <span className={`chip small ${pv.risk_level === 'HIGH' ? 'chip-warn' : ''}`}>{RISK_LABELS[pv.risk_level]}</span>
              {pv.visit_id ? <span className="chip small">مرتبطة بزيارة #{pv.visit_id}</span> : null}
              <div className="spacer" />
              <button type="button" className="text-button danger" onClick={async () => { if (!window.confirm('حذف زيارة المتابعة؟')) return; try { await api.clinical.deletePregnancyVisit(pregnancyId, pv.pv_id); reload() } catch (err) { setError(err.message) } }}>حذف</button>
            </div>
            <div className="timeline-body">
              <div className="timeline-vitals">
                {pv.weight_kg ? <span>الوزن: {pv.weight_kg}كغ</span> : null}
                {pv.systolic ? <span>الضغط: {pv.systolic}/{pv.diastolic}</span> : null}
                {pv.pulse ? <span>النبض: {pv.pulse}</span> : null}
                {pv.temperature ? <span>الحرارة: {pv.temperature}°</span> : null}
                {pv.fundal_height_cm ? <span>ارتفاع الرحم: {pv.fundal_height_cm}سم</span> : null}
                {pv.fetal_heart_rate ? <span>نبض الجنين: {pv.fetal_heart_rate}ن/د</span> : null}
                {pv.fetal_presentation ? <span>وضع الجنين: {pv.fetal_presentation}</span> : null}
                {pv.next_visit_date ? <span>الموعد القادم: {fmtDate(pv.next_visit_date)}</span> : null}
              </div>
              {pv.symptoms ? <p className="profile-meta"><strong>الأعراض:</strong> {pv.symptoms}</p> : null}
              {pv.clinical_examination ? <p className="profile-meta"><strong>الفحص:</strong> {pv.clinical_examination}</p> : null}
              {pv.diagnosis ? <p className="profile-meta"><strong>التشخيص:</strong> {pv.diagnosis}</p> : null}
              {pv.treatment_plan ? <p className="profile-meta"><strong>خطة العلاج:</strong> {pv.treatment_plan}</p> : null}
              {pv.supplements ? <p className="profile-meta"><strong>المكملات/الأدوية:</strong> {pv.supplements}</p> : null}
              {pv.notes ? <p className="profile-meta"><strong>ملاحظات:</strong> {pv.notes}</p> : null}
              {pv.recorded_by_name ? <p className="muted-small">بواسطة: {pv.recorded_by_name}</p> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// نموذج إضافة زيارة متابعة (بيانات حيوية وفحص في كل زيارة)
function AddPregnancyVisit({ pregnancy, visitId, reload, setError }) {
  const [form, setForm] = useState({
    ga_weeks: pregnancy.current_gestational_age?.weeks ?? '', ga_days: pregnancy.current_gestational_age?.days ?? 0,
    weight_kg: '', systolic: '', diastolic: '', pulse: '', temperature: '', fundal_height_cm: '',
    fetal_heart_rate: '', fetal_presentation: '', symptoms: '', clinical_examination: '', diagnosis: '',
    treatment_plan: '', supplements: '', next_visit_date: '', risk_level: pregnancy.risk_level || 'NORMAL', notes: '',
  })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const payload = { risk_level: form.risk_level }
      if (visitId) payload.visit_id = visitId
      if (form.ga_weeks !== '') payload.ga_weeks = Number(form.ga_weeks)
      if (form.ga_days !== '') payload.ga_days = Number(form.ga_days)
      for (const key of ['weight_kg', 'systolic', 'diastolic', 'pulse', 'temperature', 'fundal_height_cm', 'fetal_heart_rate']) {
        if (form[key] !== '') payload[key] = Number(form[key])
      }
      for (const key of ['fetal_presentation', 'symptoms', 'clinical_examination', 'diagnosis', 'treatment_plan', 'supplements', 'notes']) {
        if (form[key]) payload[key] = form[key]
      }
      if (form.next_visit_date) payload.next_visit_date = form.next_visit_date
      await api.clinical.addPregnancyVisit(pregnancy.pregnancy_id, payload)
      setForm({ ...form, weight_kg: '', systolic: '', diastolic: '', pulse: '', temperature: '', fundal_height_cm: '', fetal_heart_rate: '', fetal_presentation: '', symptoms: '', clinical_examination: '', diagnosis: '', treatment_plan: '', supplements: '', notes: '' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const numInput = (key, label) => (
    <Field label={label}><input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></Field>
  )

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label="العمر الحملي (أسابيع)" required><input type="number" min="0" max="45" required value={form.ga_weeks} onChange={(e) => setForm({ ...form, ga_weeks: e.target.value })} /></Field>
        <Field label="أيام إضافية"><input type="number" min="0" max="6" value={form.ga_days} onChange={(e) => setForm({ ...form, ga_days: e.target.value })} /></Field>
        <Field label="مستوى الخطورة">
          <select value={form.risk_level} onChange={(e) => setForm({ ...form, risk_level: e.target.value })}>
            <option value="NORMAL">طبيعي</option>
            <option value="HIGH">عالي الخطورة</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        {numInput('weight_kg', 'الوزن (كغ)')}
        {numInput('systolic', 'الضغط الانقباضي')}
        {numInput('diastolic', 'الضغط الانبساطي')}
        {numInput('pulse', 'النبض')}
      </div>
      <div className="form-row">
        {numInput('temperature', 'الحرارة (°م)')}
        {numInput('fundal_height_cm', 'ارتفاع قاع الرحم (سم)')}
        {numInput('fetal_heart_rate', 'نبض الجنين (ن/د)')}
        <Field label="وضع الجنين"><input value={form.fetal_presentation} onChange={(e) => setForm({ ...form, fetal_presentation: e.target.value })} placeholder="رأسي، مقعدي..." /></Field>
      </div>
      <div className="form-row">
        <Field label="الأعراض"><textarea rows="2" value={form.symptoms} onChange={(e) => setForm({ ...form, symptoms: e.target.value })} /></Field>
        <Field label="الفحص السريري"><textarea rows="2" value={form.clinical_examination} onChange={(e) => setForm({ ...form, clinical_examination: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label="التشخيص"><textarea rows="2" value={form.diagnosis} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} /></Field>
        <Field label="خطة العلاج"><textarea rows="2" value={form.treatment_plan} onChange={(e) => setForm({ ...form, treatment_plan: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label="المكملات/الأدوية"><input value={form.supplements} onChange={(e) => setForm({ ...form, supplements: e.target.value })} placeholder="حمض الفوليك، حديد..." /></Field>
        <Field label="الموعد القادم"><input type="date" value={form.next_visit_date} onChange={(e) => setForm({ ...form, next_visit_date: e.target.value })} /></Field>
      </div>
      <Field label="ملاحظات"><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'إضافة زيارة المتابعة'}</button>
      </div>
    </form>
  )
}

// قسم السونار: تسجيل فحص + قياسات الجنين
function UltrasoundSection({ pregnancy, ultrasounds, visitId, reload, setError }) {
  const [form, setForm] = useState({ ga_weeks: pregnancy.current_gestational_age?.weeks ?? '', ga_days: pregnancy.current_gestational_age?.days ?? 0, fetus_count: 1, fetal_presentation: '', bpd_cm: '', hc_cm: '', ac_cm: '', fl_cm: '', efw_g: '', amniotic_fluid_index: '', placenta_position: '', findings: '', impression: '', report_text: '' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const payload = { fetus_count: Number(form.fetus_count) || 1 }
      if (visitId) payload.visit_id = visitId
      if (form.ga_weeks !== '') payload.ga_weeks = Number(form.ga_weeks)
      if (form.ga_days !== '') payload.ga_days = Number(form.ga_days)
      for (const key of ['bpd_cm', 'hc_cm', 'ac_cm', 'fl_cm', 'efw_g', 'amniotic_fluid_index']) {
        if (form[key] !== '') payload[key] = Number(form[key])
      }
      for (const key of ['fetal_presentation', 'placenta_position', 'findings', 'impression', 'report_text']) {
        if (form[key]) payload[key] = form[key]
      }
      await api.clinical.addUltrasound(pregnancy.pregnancy_id, payload)
      setForm({ ...form, bpd_cm: '', hc_cm: '', ac_cm: '', fl_cm: '', efw_g: '', amniotic_fluid_index: '', findings: '', impression: '', report_text: '' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const numInput = (key, label) => (
    <Field label={label}><input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></Field>
  )

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="العمر الحملي (أسابيع)" required><input type="number" min="0" max="45" required value={form.ga_weeks} onChange={(e) => setForm({ ...form, ga_weeks: e.target.value })} /></Field>
          <Field label="أيام إضافية"><input type="number" min="0" max="6" value={form.ga_days} onChange={(e) => setForm({ ...form, ga_days: e.target.value })} /></Field>
          <Field label="عدد الأجنة"><input type="number" min="1" max="10" value={form.fetus_count} onChange={(e) => setForm({ ...form, fetus_count: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          {numInput('bpd_cm', 'BPD (سم)')}
          {numInput('hc_cm', 'HC (سم)')}
          {numInput('ac_cm', 'AC (سم)')}
          {numInput('fl_cm', 'FL (سم)')}
        </div>
        <div className="form-row">
          {numInput('efw_g', 'الوزن التقديري (غ)')}
          {numInput('amniotic_fluid_index', 'مؤشر السائل الأمنيوسي')}
          <Field label="موضع المشيمة"><input value={form.placenta_position} onChange={(e) => setForm({ ...form, placenta_position: e.target.value })} /></Field>
          <Field label="وضع الجنين"><input value={form.fetal_presentation} onChange={(e) => setForm({ ...form, fetal_presentation: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="الموجودات"><textarea rows="2" value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} /></Field>
          <Field label="الانطباع"><textarea rows="2" value={form.impression} onChange={(e) => setForm({ ...form, impression: e.target.value })} /></Field>
        </div>
        <Field label="التقرير الكامل"><textarea rows="3" value={form.report_text} onChange={(e) => setForm({ ...form, report_text: e.target.value })} /></Field>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'تسجيل فحص السونار'}</button>
        </div>
      </form>

      {ultrasounds.length === 0 ? <Empty text="لا توجد فحوصات سونار" /> : (
        <div className="lab-orders">
          {ultrasounds.map((us) => (
            <div className="lab-order-card" key={us.us_id}>
              <div className="lab-order-head">
                <strong>سونار — {us.ga_weeks ?? '—'}أ{us.ga_days ? `+${us.ga_days}ي` : ''}</strong>
                <span className="chip small">{fmtDateTime(us.exam_date)}</span>
                <span className="chip small">{us.fetus_count} جنين</span>
                <div className="spacer" />
                <button type="button" className="text-button danger" onClick={async () => { if (!window.confirm('حذف فحص السونار؟')) return; try { await api.clinical.deleteUltrasound(pregnancy.pregnancy_id, us.us_id); reload() } catch (err) { setError(err.message) } }}>حذف</button>
              </div>
              <div className="timeline-vitals">
                {us.bpd_cm ? <span>BPD: {us.bpd_cm}سم</span> : null}
                {us.hc_cm ? <span>HC: {us.hc_cm}سم</span> : null}
                {us.ac_cm ? <span>AC: {us.ac_cm}سم</span> : null}
                {us.fl_cm ? <span>FL: {us.fl_cm}سم</span> : null}
                {us.efw_g ? <span>EFW: {us.efw_g}غ</span> : null}
                {us.amniotic_fluid_index ? <span>AFI: {us.amniotic_fluid_index}</span> : null}
                {us.placenta_position ? <span>المشيمة: {us.placenta_position}</span> : null}
                {us.fetal_presentation ? <span>الوضع: {us.fetal_presentation}</span> : null}
              </div>
              {us.impression ? <p className="profile-meta"><strong>الانطباع:</strong> {us.impression}</p> : null}
              {us.report_text ? <p className="profile-meta"><strong>التقرير:</strong> {us.report_text}</p> : null}
              {us.attachments?.length ? (
                <p className="profile-meta">
                  صور مرفقة: {us.attachments.map((a) => (
                    <button type="button" key={a.attachment_id} className="text-button" onClick={() => api.clinical.downloadAttachment(a.attachment_id).catch((err) => setError(err.message))}>{a.file_name}</button>
                  ))}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// مرفقات الحمل
function PregnancyAttachments({ attachments, setError }) {
  if (attachments.length === 0) return <Empty text="لا توجد مرفقات للحمل" />
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>الاسم</th><th>النوع</th><th>التاريخ</th><th></th></tr></thead>
        <tbody>
          {attachments.map((a) => (
            <tr key={a.attachment_id}>
              <td>{a.file_name}</td>
              <td>{a.kind}</td>
              <td>{fmtDateTime(a.created_at)}</td>
              <td><button type="button" className="text-button" onClick={() => api.clinical.downloadAttachment(a.attachment_id).catch((err) => setError(err.message))}>تنزيل</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}