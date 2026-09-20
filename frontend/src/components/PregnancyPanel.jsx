import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDate, fmtDateTime } from '../lib/format'
import { useT } from '../i18n'
import { Field, Loading, Empty, Notice } from './ui'


// لوحة متابعة الحمل الكاملة: سجل الحمل + الزيارات الدورية + السونار + الخط الزمني
export default function PregnancyPanel({ patientId, visitId }) {
  const [pregnancies, setPregnancies] = useState(null)
  const [active, setActive] = useState(null)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const t = useT()

  const loadList = useCallback(async () => {
    setError('')
    try {
      const result = await api.clinical.pregnancies(patientId)
      setPregnancies(result.pregnancies || [])
    } catch (err) { setError(err.message || t('pregnancy.loadError')); setPregnancies([]) }
  }, [patientId])

  useEffect(() => { loadList() }, [loadList])

  const openDetails = async (pregnancyId) => {
    setActive(null)
    try {
      const result = await api.clinical.pregnancy(pregnancyId)
      setActive(result)
    } catch (err) { setError(err.message) }
  }

  if (pregnancies === null) return <Loading text={t('pregnancy.loading')} />

  const activePregnancy = pregnancies.find((p) => p.status === 'ACTIVE')
  const linkedPv = visitId && active?.pregnancy_visits?.find((pv) => pv.visit_id === visitId)

  return (
    <div className="tab-inner pregnancy-panel">
      <Notice kind="error">{error}</Notice>

      <div className="pregnancy-header">
        <h4>{t('pregnancy.heading', { count: pregnancies.length })}</h4>
        {!activePregnancy && !showCreate && (
          <button className="primary-button compact" onClick={() => setShowCreate(true)}>{t('pregnancy.newButton')}</button>
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

      {pregnancies.length === 0 && !showCreate ? <Empty text={t('pregnancy.empty')} /> : (
        <div className="pregnancy-list">
          {pregnancies.map((p) => (
            <button key={p.pregnancy_id} className={`pregnancy-card ${active?.pregnancy?.pregnancy_id === p.pregnancy_id ? 'selected' : ''}`} onClick={() => openDetails(p.pregnancy_id)}>
              <div>
                <strong>{t('pregnancy.card.pregnancyId', { id: p.pregnancy_id })}</strong>
                <span className={`chip small ${p.risk_level === 'HIGH' ? 'chip-warn' : ''}`}>{p.risk_level === 'HIGH' ? t('pregnancy.create.riskHigh') : t('pregnancy.create.riskNormal')}</span>
                <span className="chip small">{p.status === 'ACTIVE' ? t('pregnancy.statusActive') : t('pregnancy.statusEnded')}</span>
              </div>
              <div className="muted-small">
                G{p.gravida ?? 1} P{p.para ?? 0} A{p.abortions ?? 0}
                {p.lmp_date ? ` • ${t('pregnancy.lmp')}: ${fmtDate(p.lmp_date)}` : ''}
                {p.edd_date ? ` • ${t('pregnancy.edd')}: ${fmtDate(p.edd_date)}` : ''}
                {p.current_gestational_age ? ` • ${t('pregnancy.ga')}: ${t('pregnancy.gaDisplay', { weeks: p.current_gestational_age.weeks, days: p.current_gestational_age.days })}` : ''}
                {` • ${p.visits_count} ${t('pregnancy.visitCount')} • ${p.ultrasound_count} ${t('pregnancy.ultrasoundCount')}`}
              </div>
            </button>
          ))}
        </div>
      )}

      {linkedPv && (
        <Notice kind="success">{t('pregnancy.linkedNotice', { weeks: linkedPv.ga_weeks, days: linkedPv.ga_days !== null ? `+${linkedPv.ga_days}` : '' })}</Notice>
      )}

      {active && (
        <PregnancyDetails data={active} visitId={visitId} reload={() => { loadList(); openDetails(active.pregnancy.pregnancy_id) }} setError={setError} />
      )}
    </div>
  )
}

// نموذج إنشاء سجل حمل
function CreatePregnancyForm({ patientId, onClose, onSaved, setError }) {
  const t = useT()
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
        <Field label={t('pregnancy.create.lmpLabel')} required hint={t('pregnancy.create.lmpHint')}>
          <input type="date" required value={form.lmp_date} onChange={(e) => setForm({ ...form, lmp_date: e.target.value })} />
        </Field>
        <Field label={t('pregnancy.create.eddLabel')} hint={t('pregnancy.create.eddHint')}>
          <input type="date" value={form.edd_date} onChange={(e) => setForm({ ...form, edd_date: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('pregnancy.create.gravidaLabel')}><input type="number" min="1" max="30" value={form.gravida} onChange={(e) => setForm({ ...form, gravida: e.target.value })} /></Field>
        <Field label={t('pregnancy.create.paraLabel')}><input type="number" min="0" max="30" value={form.para} onChange={(e) => setForm({ ...form, para: e.target.value })} /></Field>
        <Field label={t('pregnancy.create.abortionsLabel')}><input type="number" min="0" max="30" value={form.abortions} onChange={(e) => setForm({ ...form, abortions: e.target.value })} /></Field>
        <Field label={t('pregnancy.create.livingChildrenLabel')}><input type="number" min="0" max="30" value={form.living_children} onChange={(e) => setForm({ ...form, living_children: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('pregnancy.create.bloodGroupLabel')}>
          <select value={form.blood_group} onChange={(e) => setForm({ ...form, blood_group: e.target.value })}>
            <option value="">{t('pregnancy.create.bloodGroupUnspecified')}</option>
            {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bt) => <option key={bt} value={bt}>{bt}</option>)}
          </select>
        </Field>
        <Field label={t('pregnancy.create.rhFactorLabel')}>
          <select value={form.rh_factor} onChange={(e) => setForm({ ...form, rh_factor: e.target.value })}>
            <option value="">{t('pregnancy.create.bloodGroupUnspecified')}</option>
            <option value="POSITIVE">{t('pregnancy.create.rhPositive')}</option>
            <option value="NEGATIVE">{t('pregnancy.create.rhNegative')}</option>
          </select>
        </Field>
        <Field label={t('pregnancy.create.riskLabel')}>
          <select value={form.risk_level} onChange={(e) => setForm({ ...form, risk_level: e.target.value })}>
            <option value="NORMAL">{t('pregnancy.create.riskNormal')}</option>
            <option value="HIGH">{t('pregnancy.create.riskHigh')}</option>
          </select>
        </Field>
      </div>
      <Field label={t('pregnancy.create.previousPregnanciesLabel')}>
        <textarea rows="2" value={form.previous_pregnancies} onChange={(e) => setForm({ ...form, previous_pregnancies: e.target.value })} placeholder={t('pregnancy.create.previousPregnanciesPlaceholder')} />
      </Field>
      {form.risk_level === 'HIGH' && (
        <Field label={t('pregnancy.create.riskFactorsLabel')}>
          <textarea rows="2" value={form.risk_factors} onChange={(e) => setForm({ ...form, risk_factors: e.target.value })} placeholder={t('pregnancy.create.riskFactorsPlaceholder')} />
        </Field>
      )}
      <Field label={t('pregnancy.create.notesLabel')}><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>{t('pregnancy.create.cancel')}</button>
        <button className="primary-button" disabled={saving}>{saving ? t('pregnancy.create.saving') : t('pregnancy.create.submit')}</button>
      </div>
    </form>
  )
}

// تفاصيل الحمل: معلومات + زيارات المتابعة (Timeline) + السونار
function PregnancyDetails({ data, visitId, reload, setError }) {
  const t = useT()
  const { pregnancy, pregnancy_visits, ultrasounds, attachments } = data
  const [section, setSection] = useState('timeline')

  const RISK_LABELS = {
    NORMAL: t('pregnancy.create.riskNormal'),
    HIGH: t('pregnancy.create.riskHigh'),
  }
  const OUTCOME_LABELS = {
    ONGOING: t('pregnancy.outcome.ongoing'),
    LIVE_BIRTH: t('pregnancy.outcome.liveBirth'),
    STILLBIRTH: t('pregnancy.outcome.stillbirth'),
    MISCARRIAGE: t('pregnancy.outcome.miscarriage'),
  }
  const DELIVERY_METHODS = {
    VAGINAL: t('pregnancy.delivery.vaginal'),
    VAGINAL_ASSISTED: t('pregnancy.delivery.vaginalAssisted'),
    CESAREAN: t('pregnancy.delivery.cesarean'),
  }

  return (
    <div className="pregnancy-details">
      <div className="pregnancy-summary">
        <div className="summary-grid">
          <div><span>{t('pregnancy.details.currentGa')}</span><strong>{pregnancy.current_gestational_age ? `${pregnancy.current_gestational_age.weeks} أسبوع + ${pregnancy.current_gestational_age.days} يوم` : '—'}</strong></div>
          <div><span>{t('pregnancy.details.lmp')}</span><strong>{fmtDate(pregnancy.lmp_date)}</strong></div>
          <div><span>{t('pregnancy.details.edd')}</span><strong>{fmtDate(pregnancy.edd_date)}</strong></div>
          <div><span>{t('pregnancy.details.gpa')}</span><strong>G{pregnancy.gravida ?? 1} P{pregnancy.para ?? 0} A{pregnancy.abortions ?? 0}</strong></div>
          <div><span>{t('pregnancy.details.bloodGroup')}</span><strong>{pregnancy.blood_group || '—'}{pregnancy.rh_factor ? ` ${pregnancy.rh_factor === 'POSITIVE' ? '(+)' : '(-)'}` : ''}</strong></div>
          <div><span>{t('pregnancy.details.risk')}</span><strong className={pregnancy.risk_level === 'HIGH' ? 'risk-high' : ''}>{RISK_LABELS[pregnancy.risk_level]}</strong></div>
        </div>
        {pregnancy.risk_factors ? <p className="profile-meta"><strong>{t('pregnancy.details.riskFactors')}</strong> {pregnancy.risk_factors}</p> : null}
        {pregnancy.previous_pregnancies ? <p className="profile-meta"><strong>{t('pregnancy.details.previousPregnancies')}</strong> {pregnancy.previous_pregnancies}</p> : null}
        {pregnancy.status === 'COMPLETED' && (
          <p className="profile-meta"><strong>{t('pregnancy.details.outcome')}</strong> {OUTCOME_LABELS[pregnancy.outcome]}{pregnancy.delivery_date ? ` — ${fmtDate(pregnancy.delivery_date)}` : ''}{pregnancy.delivery_method ? ` — ${DELIVERY_METHODS[pregnancy.delivery_method] || pregnancy.delivery_method}` : ''}</p>
        )}
        {pregnancy.status === 'ACTIVE' && (
          <ClosePregnancyControl pregnancy={pregnancy} reload={reload} setError={setError} OUTCOME_LABELS={OUTCOME_LABELS} />
        )}
      </div>

      <div className="tab-bar">
        <button className={section === 'timeline' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('timeline')}>{t('pregnancy.timelineTab', { count: pregnancy_visits.length })}</button>
        <button className={section === 'addvisit' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('addvisit')}>{t('pregnancy.addVisitTab')}</button>
        <button className={section === 'ultrasound' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('ultrasound')}>{t('pregnancy.ultrasoundTab', { count: ultrasounds.length })}</button>
        <button className={section === 'attachments' ? 'tab-item active' : 'tab-item'} onClick={() => setSection('attachments')}>{t('pregnancy.attachmentsTab', { count: attachments.length })}</button>
      </div>

      {section === 'timeline' && <PregnancyTimeline visits={pregnancy_visits} pregnancyId={pregnancy.pregnancy_id} reload={reload} setError={setError} RISK_LABELS={RISK_LABELS} />}
      {section === 'addvisit' && <AddPregnancyVisit pregnancy={pregnancy} visitId={visitId} reload={reload} setError={setError} />}
      {section === 'ultrasound' && <UltrasoundSection pregnancy={pregnancy} ultrasounds={ultrasounds} visitId={visitId} reload={reload} setError={setError} />}
      {section === 'attachments' && <PregnancyAttachments attachments={attachments} setError={setError} />}
    </div>
  )
}

// التحكم بإغلاق الحمل عند الولادة
function ClosePregnancyControl({ pregnancy, reload, setError, OUTCOME_LABELS }) {
  const t = useT()
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

  if (!open) return <button className="secondary-button compact" onClick={() => setOpen(true)}>{t('pregnancy.close.title')}</button>

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label={t('pregnancy.close.outcome')}>
          <select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
            {Object.entries(OUTCOME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label={t('pregnancy.close.deliveryDate')}><input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} /></Field>
        {form.outcome === 'LIVE_BIRTH' && (
          <Field label={t('pregnancy.close.deliveryMethod')}>
            <select value={form.delivery_method} onChange={(e) => setForm({ ...form, delivery_method: e.target.value })}>
              {Object.entries({ VAGINAL: t('pregnancy.deliveryVaginal'), VAGINAL_ASSISTED: t('pregnancy.deliveryAssisted'), CESAREAN: t('pregnancy.deliveryCesarean') }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label={t('pregnancy.close.deliveryNotes')}><textarea rows="2" value={form.delivery_notes} onChange={(e) => setForm({ ...form, delivery_notes: e.target.value })} /></Field>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={() => setOpen(false)}>{t('pregnancy.close.cancel')}</button>
        <button className="primary-button" disabled={saving}>{saving ? t('pregnancy.close.saving') : t('pregnancy.close.submit')}</button>
      </div>
    </form>
  )
}

// الخط الزمني للحمل: كل زيارة ببياناتها من البداية حتى الولادة
function PregnancyTimeline({ visits, pregnancyId, reload, setError, RISK_LABELS }) {
  const t = useT()
  if (visits.length === 0) return <Empty text={t('pregnancy.timeline.empty')} />

  return (
    <div className="pregnancy-timeline">
      {visits.map((pv, i) => (
        <div className="timeline-item" key={pv.pv_id}>
          <div className="timeline-dot" />
          <div className="timeline-content">
            <div className="timeline-head">
              <strong>{t('pregnancy.timeline.visitTitle', { index: i + 1 })}</strong>
              <span className="chip small">{pv.ga_weeks ?? '—'}أ{pv.ga_days !== null && pv.ga_days !== undefined ? `+${pv.ga_days}ي` : ''}</span>
              <span className="muted-small">{fmtDateTime(pv.visit_date)}</span>
              <span className={`chip small ${pv.risk_level === 'HIGH' ? 'chip-warn' : ''}`}>{RISK_LABELS[pv.risk_level]}</span>
              {pv.visit_id ? <span className="chip small">{t('pregnancy.linkedVisit', { id: pv.visit_id })}</span> : null}
              <div className="spacer" />
              <button type="button" className="text-button danger" onClick={async () => { if (!window.confirm(t('pregnancy.timeline.confirmDelete'))) return; try { await api.clinical.deletePregnancyVisit(pregnancyId, pv.pv_id); reload() } catch (err) { setError(err.message) } }}>{t('pregnancy.timeline.delete')}</button>
            </div>
            <div className="timeline-body">
              <div className="timeline-vitals">
                {pv.weight_kg ? <span>{t('pregnancy.timeline.weight')}: {pv.weight_kg}كغ</span> : null}
                {pv.systolic ? <span>{t('pregnancy.timeline.bp')}: {pv.systolic}/{pv.diastolic}</span> : null}
                {pv.pulse ? <span>{t('pregnancy.timeline.pulse')}: {pv.pulse}</span> : null}
                {pv.temperature ? <span>{t('pregnancy.timeline.temperature')}: {pv.temperature}°</span> : null}
                {pv.fundal_height_cm ? <span>{t('pregnancy.timeline.fundalHeight')}: {pv.fundal_height_cm}سم</span> : null}
                {pv.fetal_heart_rate ? <span>{t('pregnancy.timeline.fetalHeartRate')}: {pv.fetal_heart_rate}ن/د</span> : null}
                {pv.fetal_presentation ? <span>{t('pregnancy.timeline.fetalPresentation')}: {pv.fetal_presentation}</span> : null}
                {pv.next_visit_date ? <span>{t('pregnancy.timeline.nextVisit')}: {fmtDate(pv.next_visit_date)}</span> : null}
              </div>
              {pv.symptoms ? <p className="profile-meta"><strong>{t('pregnancy.timeline.symptoms')}</strong> {pv.symptoms}</p> : null}
              {pv.clinical_examination ? <p className="profile-meta"><strong>{t('pregnancy.timeline.examination')}</strong> {pv.clinical_examination}</p> : null}
              {pv.diagnosis ? <p className="profile-meta"><strong>{t('pregnancy.timeline.diagnosis')}</strong> {pv.diagnosis}</p> : null}
              {pv.treatment_plan ? <p className="profile-meta"><strong>{t('pregnancy.timeline.treatment')}</strong> {pv.treatment_plan}</p> : null}
              {pv.supplements ? <p className="profile-meta"><strong>{t('pregnancy.timeline.supplements')}</strong> {pv.supplements}</p> : null}
              {pv.notes ? <p className="profile-meta"><strong>{t('pregnancy.timeline.notes')}</strong> {pv.notes}</p> : null}
              {pv.recorded_by_name ? <p className="muted-small">{t('pregnancy.timeline.by')}: {pv.recorded_by_name}</p> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// نموذج إضافة زيارة متابعة (بيانات حيوية وفحص في كل زيارة)
function AddPregnancyVisit({ pregnancy, visitId, reload, setError }) {
  const t = useT()
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
        <Field label={t('pregnancy.addVisit.gaWeeks')} required><input type="number" min="0" max="45" required value={form.ga_weeks} onChange={(e) => setForm({ ...form, ga_weeks: e.target.value })} /></Field>
        <Field label={t('pregnancy.addVisit.gaDays')}><input type="number" min="0" max="6" value={form.ga_days} onChange={(e) => setForm({ ...form, ga_days: e.target.value })} /></Field>
        <Field label={t('pregnancy.addVisit.riskLevel')}>
          <select value={form.risk_level} onChange={(e) => setForm({ ...form, risk_level: e.target.value })}>
            <option value="NORMAL">{t('pregnancy.addVisit.riskNormal')}</option>
            <option value="HIGH">{t('pregnancy.addVisit.riskHigh')}</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        {numInput('weight_kg', t('pregnancy.addVisit.weight'))}
        {numInput('systolic', t('pregnancy.addVisit.systolic'))}
        {numInput('diastolic', t('pregnancy.addVisit.diastolic'))}
        {numInput('pulse', t('pregnancy.addVisit.pulse'))}
      </div>
      <div className="form-row">
        {numInput('temperature', t('pregnancy.addVisit.temperature'))}
        {numInput('fundal_height_cm', t('pregnancy.addVisit.fundalHeight'))}
        {numInput('fetal_heart_rate', t('pregnancy.addVisit.fetalHeartRate'))}
        <Field label={t('pregnancy.addVisit.fetalPresentation')}><input value={form.fetal_presentation} onChange={(e) => setForm({ ...form, fetal_presentation: e.target.value })} placeholder={t('pregnancy.addVisit.fetalPresentationPlaceholder')} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('pregnancy.addVisit.symptoms')}><textarea rows="2" value={form.symptoms} onChange={(e) => setForm({ ...form, symptoms: e.target.value })} /></Field>
        <Field label={t('pregnancy.addVisit.examination')}><textarea rows="2" value={form.clinical_examination} onChange={(e) => setForm({ ...form, clinical_examination: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('pregnancy.addVisit.diagnosis')}><textarea rows="2" value={form.diagnosis} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} /></Field>
        <Field label={t('pregnancy.addVisit.treatment')}><textarea rows="2" value={form.treatment_plan} onChange={(e) => setForm({ ...form, treatment_plan: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('pregnancy.addVisit.supplements')}><input value={form.supplements} onChange={(e) => setForm({ ...form, supplements: e.target.value })} placeholder={t('pregnancy.addVisit.supplementsPlaceholder')} /></Field>
        <Field label={t('pregnancy.addVisit.nextVisit')}><input type="date" value={form.next_visit_date} onChange={(e) => setForm({ ...form, next_visit_date: e.target.value })} /></Field>
      </div>
      <Field label={t('pregnancy.addVisit.notes')}><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? t('pregnancy.addVisit.saving') : t('pregnancy.addVisit.submit')}</button>
      </div>
    </form>
  )
}

// قسم السونار: تسجيل فحص + قياسات الجنين
function UltrasoundSection({ pregnancy, ultrasounds, visitId, reload, setError }) {
  const t = useT()
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
          <Field label={t('pregnancy.addVisit.gaWeeks')} required><input type="number" min="0" max="45" required value={form.ga_weeks} onChange={(e) => setForm({ ...form, ga_weeks: e.target.value })} /></Field>
          <Field label={t('pregnancy.addVisit.gaDays')}><input type="number" min="0" max="6" value={form.ga_days} onChange={(e) => setForm({ ...form, ga_days: e.target.value })} /></Field>
          <Field label={t('pregnancy.ultrasound.fetusCount')}><input type="number" min="1" max="10" value={form.fetus_count} onChange={(e) => setForm({ ...form, fetus_count: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          {numInput('bpd_cm', t('pregnancy.ultrasound.bpd'))}
          {numInput('hc_cm', t('pregnancy.ultrasound.hc'))}
          {numInput('ac_cm', t('pregnancy.ultrasound.ac'))}
          {numInput('fl_cm', t('pregnancy.ultrasound.fl'))}
        </div>
        <div className="form-row">
          {numInput('efw_g', t('pregnancy.ultrasound.efw'))}
          {numInput('amniotic_fluid_index', t('pregnancy.ultrasound.afi'))}
          <Field label={t('pregnancy.ultrasound.placentaPosition')}><input value={form.placenta_position} onChange={(e) => setForm({ ...form, placenta_position: e.target.value })} /></Field>
          <Field label={t('pregnancy.addVisit.fetalPresentation')}><input value={form.fetal_presentation} onChange={(e) => setForm({ ...form, fetal_presentation: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('pregnancy.ultrasound.findings')}><textarea rows="2" value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} /></Field>
          <Field label={t('pregnancy.ultrasound.impression')}><textarea rows="2" value={form.impression} onChange={(e) => setForm({ ...form, impression: e.target.value })} /></Field>
        </div>
        <Field label={t('pregnancy.ultrasound.report')}><textarea rows="3" value={form.report_text} onChange={(e) => setForm({ ...form, report_text: e.target.value })} /></Field>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('pregnancy.ultrasound.saving') : t('pregnancy.ultrasound.submit')}</button>
        </div>
      </form>

      {ultrasounds.length === 0 ? <Empty text={t('pregnancy.ultrasound.empty')} /> : (
        <div className="lab-orders">
          {ultrasounds.map((us) => (
            <div className="lab-order-card" key={us.us_id}>
              <div className="lab-order-head">
                <strong>{t('pregnancy.ultrasound.title', { weeks: us.ga_weeks ?? '—', days: us.ga_days ? `+${us.ga_days}ي` : '' })}</strong>
                <span className="chip small">{fmtDateTime(us.exam_date)}</span>
                <span className="chip small">{us.fetus_count} {t('pregnancy.ultrasound.countLabel')}</span>
                <div className="spacer" />
                <button type="button" className="text-button danger" onClick={async () => { if (!window.confirm(t('pregnancy.ultrasound.confirmDelete'))) return; try { await api.clinical.deleteUltrasound(pregnancy.pregnancy_id, us.us_id); reload() } catch (err) { setError(err.message) } }}>{t('pregnancy.ultrasound.delete')}</button>
              </div>
              <div className="timeline-vitals">
                {us.bpd_cm ? <span>{t('pregnancy.ultrasound.bpd')}: {us.bpd_cm}سم</span> : null}
                {us.hc_cm ? <span>{t('pregnancy.ultrasound.hc')}: {us.hc_cm}سم</span> : null}
                {us.ac_cm ? <span>{t('pregnancy.ultrasound.ac')}: {us.ac_cm}سم</span> : null}
                {us.fl_cm ? <span>{t('pregnancy.ultrasound.fl')}: {us.fl_cm}سم</span> : null}
                {us.efw_g ? <span>{t('pregnancy.ultrasound.efw')}: {us.efw_g}غ</span> : null}
                {us.amniotic_fluid_index ? <span>{t('pregnancy.ultrasound.afi')}: {us.amniotic_fluid_index}</span> : null}
                {us.placenta_position ? <span>{t('pregnancy.ultrasound.placentaPosition')}: {us.placenta_position}</span> : null}
                {us.fetal_presentation ? <span>{t('pregnancy.ultrasound.findings')}: {us.fetal_presentation}</span> : null}
              </div>
              {us.impression ? <p className="profile-meta"><strong>{t('pregnancy.ultrasound.impressionLabel')}</strong> {us.impression}</p> : null}
              {us.report_text ? <p className="profile-meta"><strong>{t('pregnancy.ultrasound.reportLabel')}</strong> {us.report_text}</p> : null}
              {us.attachments?.length ? (
                <p className="profile-meta">
                  {t('pregnancy.ultrasound.attachmentsLabel')}: {us.attachments.map((a) => (
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
  const t = useT()
  if (attachments.length === 0) return <Empty text={t('pregnancy.attachments.empty')} />
  return (
    <div className="table-wrap table-cards">
      <table>
        <thead><tr><th>{t('pregnancy.attachments.name')}</th><th>{t('pregnancy.attachments.type')}</th><th>{t('pregnancy.attachments.date')}</th><th></th></tr></thead>
        <tbody>
          {attachments.map((a) => (
            <tr key={a.attachment_id}>
              <td>{a.file_name}</td>
              <td data-label={t('pregnancy.attachments.type')}>{a.kind}</td>
              <td data-label={t('pregnancy.attachments.date')}>{fmtDateTime(a.created_at)}</td>
              <td className="cell-actions" data-label={t('pregnancy.attachments.actions')}><button type="button" className="text-button" onClick={() => api.clinical.downloadAttachment(a.attachment_id).catch((err) => setError(err.message))}>{t('pregnancy.attachments.download')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}