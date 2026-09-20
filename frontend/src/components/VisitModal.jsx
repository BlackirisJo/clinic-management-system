import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fmtDateTime, fmtNumber } from '../lib/format'
import { useT } from '../i18n'
import { Modal, Field, Loading, Empty, Notice } from './ui'
import PregnancyPanel from './PregnancyPanel'

// Visit Modal — نافذة بيانات الزيارة
export default function VisitModal({ visitId, onClose }) {
  const t = useT()
  const TABS = useMemo(() => [
    { id: 'clinical', label: t('visit.tabClinical') },
    { id: 'vitals', label: t('visit.tabVitals') },
    { id: 'diagnoses', label: t('visit.tabDiagnoses') },
    { id: 'labs', label: t('visit.tabLabs') },
    { id: 'imaging', label: t('visit.tabImaging') },
    { id: 'attachments', label: t('visit.tabAttachments') },
    { id: 'referrals', label: t('visit.tabReferrals') },
  ], [t])

  const DISPOSITIONS = useMemo(() => [
    { value: 'DISCHARGED', label: t('visit.dispositionDischarged') },
    { value: 'ADMITTED', label: t('visit.dispositionAdmitted') },
    { value: 'REFERRED', label: t('visit.dispositionReferred') },
    { value: 'OBSERVATION', label: t('visit.dispositionObservation') },
    { value: 'LAMA', label: t('visit.dispositionLama') },
    { value: 'DECEASED', label: t('visit.dispositionDeceased') },
  ], [t])

  const IMAGING_MODALITIES = useMemo(() => [
    { value: 'XRAY', label: t('visit.imaging.modalityXray') },
    { value: 'ULTRASOUND', label: t('visit.imaging.modalityUltrasound') },
    { value: 'CT', label: t('visit.imaging.modalityCt') },
    { value: 'MRI', label: t('visit.imaging.modalityMri') },
    { value: 'ECG', label: t('visit.imaging.modalityEcg') },
    { value: 'OTHER', label: t('visit.imaging.modalityOther') },
  ], [t])

  const LAB_CATEGORIES = useMemo(() => [
    'CBC', 'URINALYSIS', 'BIOCHEMISTRY', 'HORMONES', 'MICROBIOLOGY', 'SEROLOGY', 'OTHER'
  ], [t])

  // مساحة عمل الزيارة: بيانات سريرية عامة + أقسام حسب تخصص العيادة
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('clinical')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const result = await api.clinical.visit(visitId)
      setData(result)
    } catch (err) {
      setError(err.message || t('visit.loadError'))
    }
  }, [visitId])

  useEffect(() => { load() }, [load])

  const visit = data?.visit
  const specialtyKey = visit?.specialty_key
  const hasPregnancy = specialtyKey === 'OBSTETRICS_GYNECOLOGY'
  const isEmergency = specialtyKey === 'EMERGENCY'

  const visibleTabs = [...TABS]
  if (hasPregnancy) visibleTabs.push({ id: 'pregnancy', label: t('visit.tabPregnancy') })

  if (error && !data) {
    return (
      <Modal title={t('visit.title')} subtitle={t('visit.subtitle')} onClose={onClose}>
        <Notice kind="error">{error}</Notice>
      </Modal>
    )
  }
  if (!data) {
    return (
      <Modal title={t('visit.title')} subtitle={t('visit.subtitle')} onClose={onClose}>
        <Loading text={t('visit.loading')} />
      </Modal>
    )
  }

  return (
    <Modal title={t('visit.titleDetail', { visitId: visit.visit_id, patientName: visit.patient_name })} subtitle={`${visit.clinic_name}${visit.specialty_name ? ` • ${visit.specialty_name}` : ''} • ${fmtDateTime(visit.visit_date)}`} onClose={onClose} wide>
      <div className="visit-meta">
        <span className="badge">{visit.visit_status === 'OPEN' ? t('visit.statusOpen') : visit.visit_status === 'COMPLETED' ? t('visit.statusCompleted') : t('visit.statusCancelled')}</span>
        {visit.triage_level ? <span className="chip">{t('visit.triageChip', { triage: visit.triage_level })}</span> : null}
        {visit.disposition ? <span className="chip">{DISPOSITIONS.find((d) => d.value === visit.disposition)?.label || visit.disposition}</span> : null}
        {data.pregnancy_visits?.length ? <span className="chip">{t('visit.chipPregnancy')}</span> : null}
      </div>

      <div className="tab-bar">
        {visibleTabs.map((vt) => (
          <button key={vt.id} className={tab === vt.id ? 'tab-item active' : 'tab-item'} onClick={() => setTab(vt.id)}>{vt.label}</button>
        ))}
      </div>

      <Notice kind="error">{error}</Notice>

      {tab === 'clinical' && <ClinicalTab data={data} reload={load} setError={setError} isEmergency={isEmergency} DISPOSITIONS={DISPOSITIONS} />}
      {tab === 'vitals' && <VitalsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'diagnoses' && <DiagnosesTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'labs' && <LabsTab visitId={visitId} data={data} reload={load} setError={setError} LAB_CATEGORIES={LAB_CATEGORIES} />}
      {tab === 'imaging' && <ImagingTab visitId={visitId} data={data} reload={load} setError={setError} IMAGING_MODALITIES={IMAGING_MODALITIES} />}
      {tab === 'attachments' && <AttachmentsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'referrals' && <ReferralsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'pregnancy' && hasPregnancy && <PregnancyPanel patientId={visit.patient_id} visitId={Number(visitId)} />}
    </Modal>
  )
}

// ===== البيانات السريرية العامة للزيارة =====
function ClinicalTab({ data, reload, setError, isEmergency, DISPOSITIONS }) {
  const t = useT()
  const v = data.visit
  const [form, setForm] = useState({
    chief_complaint: v.chief_complaint || '',
    clinical_examination: v.clinical_examination || '',
    assessment: v.assessment || '',
    treatment_plan: v.treatment_plan || '',
    follow_up_plan: v.follow_up_plan || '',
    next_visit_date: v.next_visit_date ? v.next_visit_date.slice(0, 10) : '',
    disposition: v.disposition || '',
    triage_level: v.triage_level || '',
    visit_status: v.visit_status || 'OPEN',
  })
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError(''); setDone(false)
    try {
      await api.clinical.updateVisit(v.visit_id, {
        ...form,
        next_visit_date: form.next_visit_date ? new Date(form.next_visit_date).toISOString() : null,
        triage_level: form.triage_level ? Number(form.triage_level) : null,
        disposition: form.disposition || null,
      })
      setDone(true)
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      {isEmergency && (
        <div className="form-row">
          <Field label={t('visit.clinical.triageLevel')} hint={t('visit.clinical.triageHint')}>
            <select value={form.triage_level} onChange={(e) => setForm({ ...form, triage_level: e.target.value })}>
              <option value="">{t('visit.clinical.unspecified')}</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>T{n}</option>)}
            </select>
          </Field>
          <Field label={t('visit.clinical.disposition')}>
            <select value={form.disposition} onChange={(e) => setForm({ ...form, disposition: e.target.value })}>
              <option value="">{t('visit.clinical.unspecified')}</option>
              {DISPOSITIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
        </div>
      )}
      <Field label={t('visit.clinical.chiefComplaint')}>
        <textarea rows="3" value={form.chief_complaint} onChange={(e) => setForm({ ...form, chief_complaint: e.target.value })} />
      </Field>
      <Field label={t('visit.clinical.examination')}>
        <textarea rows="3" value={form.clinical_examination} onChange={(e) => setForm({ ...form, clinical_examination: e.target.value })} />
      </Field>
      <div className="form-row">
        <Field label={t('visit.clinical.assessment')}>
          <textarea rows="2" value={form.assessment} onChange={(e) => setForm({ ...form, assessment: e.target.value })} />
        </Field>
        <Field label={t('visit.clinical.treatmentPlan')}>
          <textarea rows="2" value={form.treatment_plan} onChange={(e) => setForm({ ...form, treatment_plan: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('visit.clinical.followUpPlan')}>
          <textarea rows="2" value={form.follow_up_plan} onChange={(e) => setForm({ ...form, follow_up_plan: e.target.value })} />
        </Field>
        <div>
          <Field label={t('visit.clinical.nextVisit')}>
            <input type="date" value={form.next_visit_date} onChange={(e) => setForm({ ...form, next_visit_date: e.target.value })} />
          </Field>
          <Field label={t('visit.clinical.status')}>
            <select value={form.visit_status} onChange={(e) => setForm({ ...form, visit_status: e.target.value })}>
              <option value="OPEN">{t('visit.statusOpen')}</option>
              <option value="COMPLETED">{t('visit.statusCompleted')}</option>
            </select>
          </Field>
        </div>
      </div>
      {done && <Notice kind="success">{t('visit.clinical.saved')}</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? t('visit.saving') : t('visit.clinical.save')}</button>
      </div>
    </form>
  )
}

// ===== العلامات الحيوية (يمكن تسجيل أكثر من قياس في نفس الزيارة) =====
function VitalsTab({ visitId, data, reload, setError }) {
  const t = useT()
  const [form, setForm] = useState({ weight_kg: '', height_cm: '', systolic: '', diastolic: '', pulse: '', temperature: '', respiratory_rate: '', spo2: '', pain_score: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const payload = {}
      for (const key of ['weight_kg', 'height_cm', 'systolic', 'diastolic', 'pulse', 'temperature', 'respiratory_rate', 'spo2', 'pain_score']) {
        if (form[key] !== '' && form[key] !== null) payload[key] = Number(form[key])
      }
      if (form.notes) payload.notes = form.notes
      await api.clinical.addVitals(visitId, payload)
      setForm({ weight_kg: '', height_cm: '', systolic: '', diastolic: '', pulse: '', temperature: '', respiratory_rate: '', spo2: '', pain_score: '', notes: '' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const numInput = (key, label) => (
    <Field label={label}>
      <input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </Field>
  )

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          {numInput('weight_kg', t('visit.vitals.weightKg'))}
          {numInput('height_cm', t('visit.vitals.heightCm'))}
          {numInput('systolic', t('visit.vitals.systolic'))}
          {numInput('diastolic', t('visit.vitals.diastolic'))}
        </div>
        <div className="form-row">
          {numInput('pulse', t('visit.vitals.pulse'))}
          {numInput('temperature', t('visit.vitals.temperatureC'))}
          {numInput('respiratory_rate', t('visit.vitals.respiratoryRate'))}
          {numInput('spo2', t('visit.vitals.spo2Percent'))}
        </div>
        <div className="form-row">
          {numInput('pain_score', t('visit.vitals.painScore'))}
          <Field label={t('visit.notes')}><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('visit.vitals.save')}</button>
        </div>
      </form>

      <h4>{t('visit.vitals.heading')}</h4>
      {data.vitals.length === 0 ? <Empty text={t('visit.vitals.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('visit.vitals.time')}</th><th>{t('visit.vitals.weight')}</th><th>{t('visit.vitals.height')}</th><th>{t('visit.vitals.pressure')}</th><th>{t('visit.vitals.pulse')}</th><th>{t('visit.vitals.temperature')}</th><th>{t('visit.vitals.spo2')}</th><th>{t('visit.vitals.pain')}</th><th>{t('visit.by')}</th><th></th></tr></thead>
            <tbody>
              {data.vitals.map((vt) => (
                <tr key={vt.vital_id}>
                  <td>{fmtDateTime(vt.recorded_at)}</td>
                  <td data-label={t('visit.vitals.weight')}>{vt.weight_kg ?? '—'}</td><td data-label={t('visit.vitals.height')}>{vt.height_cm ?? '—'}</td>
                  <td data-label={t('visit.vitals.pressure')}>{vt.systolic ? `${vt.systolic}/${vt.diastolic}` : '—'}</td>
                  <td data-label={t('visit.vitals.pulse')}>{vt.pulse ?? '—'}</td><td data-label={t('visit.vitals.temperature')}>{vt.temperature ?? '—'}</td>
                  <td data-label={t('visit.vitals.spo2')}>{vt.spo2 ?? '—'}</td><td data-label={t('visit.vitals.pain')}>{vt.pain_score ?? '—'}</td>
                  <td data-label={t('visit.by')}>{vt.recorded_by_name || '—'}</td>
                  <td className="cell-actions" data-label={t('visit.actions')}><button type="button" className="text-button danger" onClick={async () => { try { await api.clinical.deleteVitals(visitId, vt.vital_id); reload() } catch (err) { setError(err.message) } }}>{t('visit.delete')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ===== التشخيصات =====
function DiagnosesTab({ visitId, data, reload, setError }) {
  const t = useT()
  const [form, setForm] = useState({ description: '', icd_code: '', diagnosis_type: 'PRIMARY' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.clinical.addDiagnosis(visitId, { description: form.description, icd_code: form.icd_code || undefined, diagnosis_type: form.diagnosis_type })
      setForm({ description: '', icd_code: '', diagnosis_type: 'PRIMARY' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const TYPE_LABELS = { PRIMARY: t('visit.diagnoses.primary'), SECONDARY: t('visit.diagnoses.secondary'), DIFFERENTIAL: t('visit.diagnoses.differential') }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('visit.diagnoses.description')} required>
            <input required minLength={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label={t('visit.diagnoses.icdOptional')}>
            <input dir="ltr" value={form.icd_code} onChange={(e) => setForm({ ...form, icd_code: e.target.value })} />
          </Field>
          <Field label={t('visit.diagnoses.type')}>
            <select value={form.diagnosis_type} onChange={(e) => setForm({ ...form, diagnosis_type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('visit.diagnoses.add')}</button>
        </div>
      </form>

      {data.diagnoses.length === 0 ? <Empty text={t('visit.diagnoses.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('visit.diagnoses.type')}</th><th>{t('visit.diagnoses.diagnosis')}</th><th>{t('visit.diagnoses.icd')}</th><th>{t('visit.by')}</th><th></th></tr></thead>
            <tbody>
              {data.diagnoses.map((d) => (
                <tr key={d.diagnosis_id}>
                  <td><span className="chip small">{TYPE_LABELS[d.diagnosis_type] || d.diagnosis_type}</span></td>
                  <td data-label={t('visit.diagnoses.diagnosis')}>{d.description}</td>
                  <td dir="ltr" data-label={t('visit.diagnoses.icd')}>{d.icd_code || '—'}</td>
                  <td data-label={t('visit.by')}>{d.created_by_name || '—'}</td>
                  <td className="cell-actions" data-label={t('visit.actions')}><button type="button" className="text-button danger" onClick={async () => { try { await api.clinical.deleteDiagnosis(visitId, d.diagnosis_id); reload() } catch (err) { setError(err.message) } }}>{t('visit.delete')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ===== المختبر: الطلبات والنتائج =====
function LabsTab({ visitId, data, reload, setError, LAB_CATEGORIES }) {
  const t = useT()
  const [form, setForm] = useState({ test_name: '', category: 'CBC', priority: 'ROUTINE', notes: '' })
  const [saving, setSaving] = useState(false)
  const [resultEditor, setResultEditor] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.clinical.addLabOrder(visitId, { test_name: form.test_name, category: form.category, priority: form.priority, notes: form.notes || undefined })
      setForm({ test_name: '', category: 'CBC', priority: 'ROUTINE', notes: '' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  function openResults(order) {
    setResultEditor({ orderId: order.order_id, rows: order.results?.length ? order.results.map((r) => ({ ...r })) : [{ analyte: '', result_value: '', unit: '', reference_range: '', is_abnormal: false, notes: '' }] })
  }

  async function saveResults() {
    setError('')
    try {
      const rows = resultEditor.rows.filter((r) => r.analyte?.trim())
      if (!rows.length) { setError(t('visit.labs.requireAnalyte')); return }
      await api.clinical.saveLabResults(visitId, resultEditor.orderId, { results: rows })
      setResultEditor(null)
      reload()
    } catch (err) { setError(err.message) }
  }

  const STATUS_LABELS = { ORDERED: t('visit.labs.statusOrdered'), COLLECTED: t('visit.labs.statusCollected'), IN_PROGRESS: t('visit.labs.statusInProgress'), COMPLETED: t('visit.labs.statusCompleted'), CANCELLED: t('visit.labs.statusCancelled') }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('visit.labs.testName')} required><input required minLength={2} value={form.test_name} onChange={(e) => setForm({ ...form, test_name: e.target.value })} placeholder={t('visit.labs.testNamePlaceholder')} /></Field>
          <Field label={t('visit.labs.category')}><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{LAB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label={t('visit.labs.priority')}><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="ROUTINE">{t('visit.labs.priorityRoutine')}</option><option value="URGENT">{t('visit.labs.priorityUrgent')}</option><option value="STAT">{t('visit.labs.priorityStat')}</option></select></Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('visit.labs.order')}</button>
        </div>
      </form>

      {data.lab_orders.length === 0 ? <Empty text={t('visit.labs.empty')} /> : (
        <div className="lab-orders">
          {data.lab_orders.map((o) => (
            <div className="lab-order-card" key={o.order_id}>
              <div className="lab-order-head">
                <strong>{o.test_name}</strong>
                <span className="chip small">{o.category || '—'}</span>
                <span className={`chip small ${o.priority !== 'ROUTINE' ? 'chip-warn' : ''}`}>{o.priority}</span>
                <span className="chip small">{STATUS_LABELS[o.status] || o.status}</span>
                <span className="muted-small">{fmtDateTime(o.created_at)}</span>
                <div className="spacer" />
                <button type="button" className="text-button" onClick={() => openResults(o)}>{o.status === 'COMPLETED' ? t('visit.labs.editResults') : t('visit.labs.enterResults')}</button>
                {o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && (
                  <button type="button" className="text-button danger" onClick={async () => { try { await api.clinical.updateLabOrder(visitId, o.order_id, { status: 'CANCELLED' }); reload() } catch (err) { setError(err.message) } }}>{t('common.cancel')}</button>
                )}
              </div>
              {o.results?.length > 0 && (
                <div className="table-wrap table-cards">
                <table><thead><tr><th>{t('visit.labs.analyte')}</th><th>{t('visit.labs.result')}</th><th>{t('visit.labs.unit')}</th><th>{t('visit.labs.referenceRange')}</th><th>{t('visit.labs.state')}</th></tr></thead><tbody>
                  {o.results.map((r) => (
                    <tr key={r.result_id}>
                      <td>{r.analyte}</td>
                      <td data-label={t('visit.labs.result')}><strong>{r.result_value || '—'}</strong></td>
                      <td data-label={t('visit.labs.unit')}>{r.unit || '—'}</td>
                      <td data-label={t('visit.labs.referenceRange')}>{r.reference_range || '—'}</td>
                      <td data-label={t('visit.labs.status')}>{r.is_abnormal ? <span className="chip small chip-warn">{t('visit.labs.abnormal')}</span> : <span className="chip small">{t('visit.labs.normal')}</span>}</td>
                    </tr>
                  ))}
                </tbody></table>
                </div>
              )}
              {resultEditor?.orderId === o.order_id && (
                <div className="results-editor">
                  {resultEditor.rows.map((row, i) => (
                    <div className="form-row" key={i}>
                      <Field label={t('visit.labs.analyte')}><input value={row.analyte} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, analyte: e.target.value } : r) })} /></Field>
                      <Field label={t('visit.labs.result')}><input value={row.result_value} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, result_value: e.target.value } : r) })} /></Field>
                      <Field label={t('visit.labs.unit')}><input value={row.unit} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, unit: e.target.value } : r) })} /></Field>
                      <Field label={t('visit.labs.range')}><input value={row.reference_range} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, reference_range: e.target.value } : r) })} /></Field>
                      <label className="med-check"><input type="checkbox" checked={Boolean(row.is_abnormal)} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, is_abnormal: e.target.checked } : r) })} /><span>{t('visit.labs.abnormal')}</span></label>
                    </div>
                  ))}
                  <div className="modal-actions">
                    <button type="button" className="secondary-button" onClick={() => setResultEditor({ ...resultEditor, rows: [...resultEditor.rows, { analyte: '', result_value: '', unit: '', reference_range: '', is_abnormal: false, notes: '' }] })}>{t('visit.labs.addAnalyte')}</button>
                    <button type="button" className="primary-button" onClick={saveResults}>{t('visit.labs.saveResults')}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== التصوير والفحوصات (أشعة/سونار/ECG) =====
function ImagingTab({ visitId, data, reload, setError, IMAGING_MODALITIES }) {
  const t = useT()
  const [form, setForm] = useState({ modality: 'XRAY', body_part: '', findings: '', impression: '' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.clinical.addImaging(visitId, { modality: form.modality, body_part: form.body_part || undefined, findings: form.findings || undefined, impression: form.impression || undefined, status: 'COMPLETED' })
      setForm({ modality: 'XRAY', body_part: '', findings: '', impression: '' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('visit.imaging.modality')} required>
            <select value={form.modality} onChange={(e) => setForm({ ...form, modality: e.target.value })}>
              {IMAGING_MODALITIES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label={t('visit.imaging.bodyPart')}><input value={form.body_part} onChange={(e) => setForm({ ...form, body_part: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('visit.imaging.findings')}><textarea rows="2" value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} /></Field>
          <Field label={t('visit.imaging.impression')}><textarea rows="2" value={form.impression} onChange={(e) => setForm({ ...form, impression: e.target.value })} /></Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('visit.imaging.save')}</button>
        </div>
      </form>

      {data.imaging.length === 0 ? <Empty text={t('visit.imaging.empty')} /> : (
        <div className="lab-orders">
          {data.imaging.map((im) => (
            <div className="lab-order-card" key={im.imaging_id}>
              <div className="lab-order-head">
                <strong>{IMAGING_MODALITIES.find((m) => m.value === im.modality)?.label || im.modality}</strong>
                {im.body_part ? <span className="chip small">{im.body_part}</span> : null}
                <span className="chip small">{im.status === 'COMPLETED' ? t('visit.imaging.statusCompleted') : im.status === 'ORDERED' ? t('visit.imaging.statusOrdered') : t('visit.imaging.statusCancelled')}</span>
                <span className="muted-small">{fmtDateTime(im.created_at)}</span>
                {im.performed_by_name ? <span className="muted-small">{t('visit.imaging.byLabel')} {im.performed_by_name}</span> : null}
              </div>
              {im.findings ? <p className="profile-meta"><strong>{t('visit.imaging.findingsLabel')}</strong> {im.findings}</p> : null}
              {im.impression ? <p className="profile-meta"><strong>{t('visit.imaging.impressionLabel')}</strong> {im.impression}</p> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== المرفقات (صور/تقارير) =====
function AttachmentsTab({ visitId, data, reload, setError }) {
  const t = useT()
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState(null)
  const [kind, setKind] = useState('DOCUMENT')

  async function upload(e) {
    e.preventDefault()
    if (!file) { setError(t('visit.attachments.chooseFile')); return }
    setUploading(true); setError('')
    try {
      await api.clinical.uploadAttachment(visitId, file, kind)
      setFile(null)
      reload()
    } catch (err) { setError(err.message) }
    finally { setUploading(false) }
  }

  const KIND_LABELS = { DOCUMENT: t('visit.attachments.kindDocument'), IMAGE: t('visit.attachments.kindImage'), LAB_REPORT: t('visit.attachments.kindLabReport'), IMAGING_REPORT: t('visit.attachments.kindImagingReport'), ULTRASOUND: t('visit.attachments.kindUltrasound') }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={upload}>
        <div className="form-row">
          <Field label={t('visit.attachments.kind')}>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label={t('visit.attachments.file')} required>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} accept="image/*,.pdf,.doc,.docx" />
          </Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={uploading || !file}>{uploading ? t('visit.attachments.uploading') : t('visit.attachments.upload')}</button>
        </div>
      </form>

      {data.attachments.length === 0 ? <Empty text={t('visit.attachments.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('visit.attachments.name')}</th><th>{t('visit.attachments.type')}</th><th>{t('visit.attachments.size')}</th><th>{t('visit.by')}</th><th>{t('visit.attachments.date')}</th><th></th></tr></thead>
            <tbody>
              {data.attachments.map((a) => (
                <tr key={a.attachment_id}>
                  <td>{a.file_name}</td>
                  <td data-label={t('visit.attachments.type')}>{KIND_LABELS[a.kind] || a.kind}</td>
                  <td data-label={t('visit.attachments.size')}>{a.size_bytes ? t('visit.attachments.sizeKb', { size: fmtNumber(Math.round(a.size_bytes / 1024)) }) : '—'}</td>
                  <td data-label={t('visit.by')}>{a.uploaded_by_name || '—'}</td>
                  <td data-label={t('visit.attachments.date')}>{fmtDateTime(a.created_at)}</td>
                  <td className="cell-actions" data-label={t('visit.actions')}>
                    <button type="button" className="text-button" onClick={() => api.clinical.downloadAttachment(a.attachment_id).catch((err) => setError(err.message))}>{t('visit.attachments.download')}</button> {' '}
                    <button type="button" className="text-button danger" onClick={async () => { if (!window.confirm(t('visit.attachments.confirmDelete'))) return; try { await api.clinical.deleteAttachment(a.attachment_id); reload() } catch (err) { setError(err.message) } }}>{t('visit.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ===== الإحالات =====
function ReferralsTab({ visitId, data, reload, setError }) {
  const t = useT()
  const [clinicsList, setClinicsList] = useState([])
  const [specialties, setSpecialties] = useState([])
  const [form, setForm] = useState({ reason: '', to_clinic_id: '', to_specialty_id: '', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.clinics.directory().then((r) => setClinicsList(r.clinics || [])).catch(() => {})
    api.clinical.specialties().then((r) => setSpecialties(r.specialties || [])).catch(() => {})
  }, [])

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.clinical.addReferral(visitId, {
        reason: form.reason,
        to_clinic_id: form.to_clinic_id ? Number(form.to_clinic_id) : undefined,
        to_specialty_id: form.to_specialty_id ? Number(form.to_specialty_id) : undefined,
        notes: form.notes || undefined,
      })
      setForm({ reason: '', to_clinic_id: '', to_specialty_id: '', notes: '' })
      reload()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('visit.referral.reason')} required><input required minLength={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <Field label={t('visit.referral.targetClinic')} hint={t('visit.referral.targetClinicHint')}>
            <select value={form.to_clinic_id} onChange={(e) => setForm({ ...form, to_clinic_id: e.target.value })}>
              <option value="">{t('visit.referral.noSelection')}</option>
              {clinicsList.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          </Field>
          <Field label={t('visit.referral.targetSpecialty')}>
            <select value={form.to_specialty_id} onChange={(e) => setForm({ ...form, to_specialty_id: e.target.value })}>
              <option value="">{t('visit.referral.noSelection')}</option>
              {specialties.map((s) => <option key={s.specialty_id} value={s.specialty_id}>{s.name_ar}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('visit.referral.notes')}><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('visit.referral.saving') : t('visit.referral.create')}</button>
        </div>
      </form>

      {data.referrals.length === 0 ? <Empty text={t('visit.referral.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('visit.referral.tableReason')}</th><th>{t('visit.referral.tableClinic')}</th><th>{t('visit.referral.tableSpecialty')}</th><th>{t('visit.referral.tableStatus')}</th><th>{t('visit.referral.tableDate')}</th></tr></thead>
            <tbody>
              {data.referrals.map((r) => (
                <tr key={r.referral_id}>
                  <td>{r.reason}</td>
                  <td data-label={t('visit.referral.tableClinic')}>{r.to_clinic_name || '—'}</td>
                  <td data-label={t('visit.referral.tableSpecialty')}>{r.to_specialty_name || '—'}</td>
                  <td data-label={t('visit.referral.tableStatus')}><span className="chip small">{r.status}</span></td>
                  <td data-label={t('visit.referral.tableDate')}>{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}