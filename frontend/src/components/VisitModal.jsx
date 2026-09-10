import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice } from './ui'
import PregnancyPanel from './PregnancyPanel'

const TABS = [
  { id: 'clinical', label: 'البيانات السريرية' },
  { id: 'vitals', label: 'العلامات الحيوية' },
  { id: 'diagnoses', label: 'التشخيص' },
  { id: 'labs', label: 'المختبر' },
  { id: 'imaging', label: 'التصوير' },
  { id: 'attachments', label: 'المرفقات' },
  { id: 'referrals', label: 'الإحالات' },
]

const DISPOSITIONS = [
  { value: 'DISCHARGED', label: 'خروج' },
  { value: 'ADMITTED', label: 'إدخال للمستشفى' },
  { value: 'REFERRED', label: 'إحالة' },
  { value: 'OBSERVATION', label: 'ملاحظة/مراقبة' },
  { value: 'LAMA', label: 'خروج بمخالفة النصيحة' },
  { value: 'DECEASED', label: 'وفاة' },
]

const IMAGING_MODALITIES = [
  { value: 'XRAY', label: 'أشعة سينية' },
  { value: 'ULTRASOUND', label: 'سونار عام' },
  { value: 'CT', label: 'أشعة مقطعية CT' },
  { value: 'MRI', label: 'رنين مغناطيسي MRI' },
  { value: 'ECG', label: 'تخطيط قلب ECG' },
  { value: 'OTHER', label: 'أخرى' },
]

const LAB_CATEGORIES = ['CBC', 'URINALYSIS', 'BIOCHEMISTRY', 'HORMONES', 'MICROBIOLOGY', 'SEROLOGY', 'OTHER']

// مساحة عمل الزيارة: بيانات سريرية عامة + أقسام حسب تخصص العيادة
export default function VisitModal({ visitId, onClose }) {
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('clinical')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const result = await api.clinical.visit(visitId)
      setData(result)
    } catch (err) {
      setError(err.message || 'تعذر تحميل الزيارة')
    }
  }, [visitId])

  useEffect(() => { load() }, [load])

  const visit = data?.visit
  const specialtyKey = visit?.specialty_key
  const hasPregnancy = specialtyKey === 'OBSTETRICS_GYNECOLOGY'
  const isEmergency = specialtyKey === 'EMERGENCY'

  const visibleTabs = [...TABS]
  if (hasPregnancy) visibleTabs.push({ id: 'pregnancy', label: 'متابعة الحمل' })

  if (error && !data) {
    return (
      <Modal title="الزيارة" subtitle="سجل طبي" onClose={onClose}>
        <Notice kind="error">{error}</Notice>
      </Modal>
    )
  }
  if (!data) {
    return (
      <Modal title="الزيارة" subtitle="سجل طبي" onClose={onClose}>
        <Loading text="جارِ تحميل الزيارة" />
      </Modal>
    )
  }

  return (
    <Modal title={`زيارة #${visit.visit_id} — ${visit.patient_name}`} subtitle={`${visit.clinic_name}${visit.specialty_name ? ` • ${visit.specialty_name}` : ''} • ${fmtDateTime(visit.visit_date)}`} onClose={onClose} wide>
      <div className="visit-meta">
        <span className="badge">{visit.visit_status === 'OPEN' ? 'زيارة مفتوحة' : visit.visit_status === 'COMPLETED' ? 'مكتملة' : 'ملغاة'}</span>
        {visit.triage_level ? <span className="chip">فرز T{visit.triage_level}</span> : null}
        {visit.disposition ? <span className="chip">{DISPOSITIONS.find((d) => d.value === visit.disposition)?.label || visit.disposition}</span> : null}
        {data.pregnancy_visits?.length ? <span className="chip">مرتبطة بسجل حمل</span> : null}
      </div>

      <div className="tab-bar">
        {visibleTabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab-item active' : 'tab-item'} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <Notice kind="error">{error}</Notice>

      {tab === 'clinical' && <ClinicalTab data={data} reload={load} setError={setError} isEmergency={isEmergency} />}
      {tab === 'vitals' && <VitalsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'diagnoses' && <DiagnosesTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'labs' && <LabsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'imaging' && <ImagingTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'attachments' && <AttachmentsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'referrals' && <ReferralsTab visitId={visitId} data={data} reload={load} setError={setError} />}
      {tab === 'pregnancy' && hasPregnancy && <PregnancyPanel patientId={visit.patient_id} visitId={Number(visitId)} />}
    </Modal>
  )
}

// ===== البيانات السريرية العامة للزيارة =====
function ClinicalTab({ data, reload, setError, isEmergency }) {
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
          <Field label="مستوى الفرز (Triage)" hint="1 = حرج جداً، 5 = غير عاجل">
            <select value={form.triage_level} onChange={(e) => setForm({ ...form, triage_level: e.target.value })}>
              <option value="">غير محدد</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>T{n}</option>)}
            </select>
          </Field>
          <Field label="تقرير المصير (Disposition)">
            <select value={form.disposition} onChange={(e) => setForm({ ...form, disposition: e.target.value })}>
              <option value="">غير محدد</option>
              {DISPOSITIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
        </div>
      )}
      <Field label="الشكوى الرئيسية / تاريخ الحالة الحالي">
        <textarea rows="3" value={form.chief_complaint} onChange={(e) => setForm({ ...form, chief_complaint: e.target.value })} />
      </Field>
      <Field label="الفحص السريري">
        <textarea rows="3" value={form.clinical_examination} onChange={(e) => setForm({ ...form, clinical_examination: e.target.value })} />
      </Field>
      <div className="form-row">
        <Field label="التقييم">
          <textarea rows="2" value={form.assessment} onChange={(e) => setForm({ ...form, assessment: e.target.value })} />
        </Field>
        <Field label="خطة العلاج">
          <textarea rows="2" value={form.treatment_plan} onChange={(e) => setForm({ ...form, treatment_plan: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="خطة المتابعة">
          <textarea rows="2" value={form.follow_up_plan} onChange={(e) => setForm({ ...form, follow_up_plan: e.target.value })} />
        </Field>
        <div>
          <Field label="الموعد القادم">
            <input type="date" value={form.next_visit_date} onChange={(e) => setForm({ ...form, next_visit_date: e.target.value })} />
          </Field>
          <Field label="حالة الزيارة">
            <select value={form.visit_status} onChange={(e) => setForm({ ...form, visit_status: e.target.value })}>
              <option value="OPEN">مفتوحة</option>
              <option value="COMPLETED">مكتملة</option>
            </select>
          </Field>
        </div>
      </div>
      {done && <Notice kind="success">تم حفظ البيانات السريرية</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ البيانات السريرية'}</button>
      </div>
    </form>
  )
}

// ===== العلامات الحيوية (يمكن تسجيل أكثر من قياس في نفس الزيارة) =====
function VitalsTab({ visitId, data, reload, setError }) {
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
          {numInput('weight_kg', 'الوزن (كغ)')}
          {numInput('height_cm', 'الطول (سم)')}
          {numInput('systolic', 'الضغط الانقباضي')}
          {numInput('diastolic', 'الضغط الانبساطي')}
        </div>
        <div className="form-row">
          {numInput('pulse', 'النبض')}
          {numInput('temperature', 'الحرارة (°م)')}
          {numInput('respiratory_rate', 'التنفس')}
          {numInput('spo2', 'SpO2 %')}
        </div>
        <div className="form-row">
          {numInput('pain_score', 'مقياس الألم (0-10)')}
          <Field label="ملاحظات"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'تسجيل القياسات'}</button>
        </div>
      </form>

      <h4>القياسات المسجلة في هذه الزيارة</h4>
      {data.vitals.length === 0 ? <Empty text="لا توجد قياسات بعد" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>الوقت</th><th>الوزن</th><th>الطول</th><th>الضغط</th><th>النبض</th><th>الحرارة</th><th>SpO2</th><th>الألم</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {data.vitals.map((vt) => (
                <tr key={vt.vital_id}>
                  <td>{fmtDateTime(vt.recorded_at)}</td>
                  <td>{vt.weight_kg ?? '—'}</td><td>{vt.height_cm ?? '—'}</td>
                  <td>{vt.systolic ? `${vt.systolic}/${vt.diastolic}` : '—'}</td>
                  <td>{vt.pulse ?? '—'}</td><td>{vt.temperature ?? '—'}</td>
                  <td>{vt.spo2 ?? '—'}</td><td>{vt.pain_score ?? '—'}</td>
                  <td>{vt.recorded_by_name || '—'}</td>
                  <td><button type="button" className="text-button danger" onClick={async () => { try { await api.clinical.deleteVitals(visitId, vt.vital_id); reload() } catch (err) { setError(err.message) } }}>حذف</button></td>
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

  const TYPE_LABELS = { PRIMARY: 'أولي', SECONDARY: 'ثانوي', DIFFERENTIAL: 'تفريقي' }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="وصف التشخيص" required>
            <input required minLength={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="كود ICD (اختياري)">
            <input dir="ltr" value={form.icd_code} onChange={(e) => setForm({ ...form, icd_code: e.target.value })} />
          </Field>
          <Field label="النوع">
            <select value={form.diagnosis_type} onChange={(e) => setForm({ ...form, diagnosis_type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'إضافة تشخيص'}</button>
        </div>
      </form>

      {data.diagnoses.length === 0 ? <Empty text="لا توجد تشخيصات بعد" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>النوع</th><th>التشخيص</th><th>ICD</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {data.diagnoses.map((d) => (
                <tr key={d.diagnosis_id}>
                  <td><span className="chip small">{TYPE_LABELS[d.diagnosis_type] || d.diagnosis_type}</span></td>
                  <td>{d.description}</td>
                  <td dir="ltr">{d.icd_code || '—'}</td>
                  <td>{d.created_by_name || '—'}</td>
                  <td><button type="button" className="text-button danger" onClick={async () => { try { await api.clinical.deleteDiagnosis(visitId, d.diagnosis_id); reload() } catch (err) { setError(err.message) } }}>حذف</button></td>
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
function LabsTab({ visitId, data, reload, setError }) {
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
      if (!rows.length) { setError('أدخل تحليلاً واحداً على الأقل'); return }
      await api.clinical.saveLabResults(visitId, resultEditor.orderId, { results: rows })
      setResultEditor(null)
      reload()
    } catch (err) { setError(err.message) }
  }

  const STATUS_LABELS = { ORDERED: 'مطلوب', COLLECTED: 'تم السحب', IN_PROGRESS: 'قيد التنفيذ', COMPLETED: 'مكتمل', CANCELLED: 'ملغي' }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="اسم الفحص" required><input required minLength={2} value={form.test_name} onChange={(e) => setForm({ ...form, test_name: e.target.value })} placeholder="CBC، Urinalysis، HbA1c..." /></Field>
          <Field label="التصنيف"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{LAB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="الأولوية"><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="ROUTINE">عادية</option><option value="URGENT">عاجلة</option><option value="STAT">فورية</option></select></Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'طلب فحص مخبري'}</button>
        </div>
      </form>

      {data.lab_orders.length === 0 ? <Empty text="لا توجد طلبات مخبرية" /> : (
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
                <button type="button" className="text-button" onClick={() => openResults(o)}>{o.status === 'COMPLETED' ? 'تعديل النتائج' : 'إدخال النتائج'}</button>
                {o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && (
                  <button type="button" className="text-button danger" onClick={async () => { try { await api.clinical.updateLabOrder(visitId, o.order_id, { status: 'CANCELLED' }); reload() } catch (err) { setError(err.message) } }}>إلغاء</button>
                )}
              </div>
              {o.results?.length > 0 && (
                <table><thead><tr><th>المؤشر</th><th>النتيجة</th><th>الوحدة</th><th>المعدل الطبيعي</th><th>حالة</th></tr></thead><tbody>
                  {o.results.map((r) => (
                    <tr key={r.result_id}>
                      <td>{r.analyte}</td><td><strong>{r.result_value || '—'}</strong></td><td>{r.unit || '—'}</td><td>{r.reference_range || '—'}</td>
                      <td>{r.is_abnormal ? <span className="chip small chip-warn">شاذ</span> : <span className="chip small">طبيعي</span>}</td>
                    </tr>
                  ))}
                </tbody></table>
              )}
              {resultEditor?.orderId === o.order_id && (
                <div className="results-editor">
                  {resultEditor.rows.map((row, i) => (
                    <div className="form-row" key={i}>
                      <Field label="المؤشر"><input value={row.analyte} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, analyte: e.target.value } : r) })} /></Field>
                      <Field label="النتيجة"><input value={row.result_value} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, result_value: e.target.value } : r) })} /></Field>
                      <Field label="الوحدة"><input value={row.unit} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, unit: e.target.value } : r) })} /></Field>
                      <Field label="المعدل"><input value={row.reference_range} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, reference_range: e.target.value } : r) })} /></Field>
                      <label className="med-check"><input type="checkbox" checked={Boolean(row.is_abnormal)} onChange={(e) => setResultEditor({ ...resultEditor, rows: resultEditor.rows.map((r, j) => j === i ? { ...r, is_abnormal: e.target.checked } : r) })} /><span>شاذ</span></label>
                    </div>
                  ))}
                  <div className="modal-actions">
                    <button type="button" className="secondary-button" onClick={() => setResultEditor({ ...resultEditor, rows: [...resultEditor.rows, { analyte: '', result_value: '', unit: '', reference_range: '', is_abnormal: false, notes: '' }] })}>+ مؤشر آخر</button>
                    <button type="button" className="primary-button" onClick={saveResults}>حفظ النتائج</button>
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
function ImagingTab({ visitId, data, reload, setError }) {
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
          <Field label="نوع الفحص" required>
            <select value={form.modality} onChange={(e) => setForm({ ...form, modality: e.target.value })}>
              {IMAGING_MODALITIES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="المنطقة / العضو"><input value={form.body_part} onChange={(e) => setForm({ ...form, body_part: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="الموجودات (Findings)"><textarea rows="2" value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} /></Field>
          <Field label="الانطباع (Impression)"><textarea rows="2" value={form.impression} onChange={(e) => setForm({ ...form, impression: e.target.value })} /></Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'تسجيل فحص تصوير'}</button>
        </div>
      </form>

      {data.imaging.length === 0 ? <Empty text="لا توجد فحوصات تصوير" /> : (
        <div className="lab-orders">
          {data.imaging.map((im) => (
            <div className="lab-order-card" key={im.imaging_id}>
              <div className="lab-order-head">
                <strong>{IMAGING_MODALITIES.find((m) => m.value === im.modality)?.label || im.modality}</strong>
                {im.body_part ? <span className="chip small">{im.body_part}</span> : null}
                <span className="chip small">{im.status === 'COMPLETED' ? 'مكتمل' : im.status === 'ORDERED' ? 'مطلوب' : 'ملغي'}</span>
                <span className="muted-small">{fmtDateTime(im.created_at)}</span>
                {im.performed_by_name ? <span className="muted-small">بواسطة: {im.performed_by_name}</span> : null}
              </div>
              {im.findings ? <p className="profile-meta"><strong>الموجودات:</strong> {im.findings}</p> : null}
              {im.impression ? <p className="profile-meta"><strong>الانطباع:</strong> {im.impression}</p> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== المرفقات (صور/تقارير) =====
function AttachmentsTab({ visitId, data, reload, setError }) {
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState(null)
  const [kind, setKind] = useState('DOCUMENT')

  async function upload(e) {
    e.preventDefault()
    if (!file) { setError('اختر ملفاً أولاً'); return }
    setUploading(true); setError('')
    try {
      await api.clinical.uploadAttachment(visitId, file, kind)
      setFile(null)
      reload()
    } catch (err) { setError(err.message) }
    finally { setUploading(false) }
  }

  const KIND_LABELS = { DOCUMENT: 'مستند', IMAGE: 'صورة', LAB_REPORT: 'تقرير مختبر', IMAGING_REPORT: 'تقرير تصوير', ULTRASOUND: 'صورة سونار' }

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={upload}>
        <div className="form-row">
          <Field label="نوع المرفق">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="الملف" required>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} accept="image/*,.pdf,.doc,.docx" />
          </Field>
        </div>
        <div className="modal-actions">
          <button className="primary-button" disabled={uploading || !file}>{uploading ? 'جارِ الرفع...' : 'رفع المرفق'}</button>
        </div>
      </form>

      {data.attachments.length === 0 ? <Empty text="لا توجد مرفقات" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>الاسم</th><th>النوع</th><th>الحجم</th><th>بواسطة</th><th>التاريخ</th><th></th></tr></thead>
            <tbody>
              {data.attachments.map((a) => (
                <tr key={a.attachment_id}>
                  <td>{a.file_name}</td>
                  <td>{KIND_LABELS[a.kind] || a.kind}</td>
                  <td>{a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '—'}</td>
                  <td>{a.uploaded_by_name || '—'}</td>
                  <td>{fmtDateTime(a.created_at)}</td>
                  <td>
                    <button type="button" className="text-button" onClick={() => api.clinical.downloadAttachment(a.attachment_id).catch((err) => setError(err.message))}>تنزيل</button> {' '}
                    <button type="button" className="text-button danger" onClick={async () => { if (!window.confirm('حذف المرفق؟')) return; try { await api.clinical.deleteAttachment(a.attachment_id); reload() } catch (err) { setError(err.message) } }}>حذف</button>
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
          <Field label="السبب" required><input required minLength={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <Field label="العيادة المستهدفة" hint="اختر العيادة بالاسم — تُحال إليها مباشرة">
            <select value={form.to_clinic_id} onChange={(e) => setForm({ ...form, to_clinic_id: e.target.value })}>
              <option value="">— لا شيء —</option>
              {clinicsList.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          </Field>
          <Field label="التخصص المستهدف">
            <select value={form.to_specialty_id} onChange={(e) => setForm({ ...form, to_specialty_id: e.target.value })}>
              <option value="">— لا شيء —</option>
              {specialties.map((s) => <option key={s.specialty_id} value={s.specialty_id}>{s.name_ar}</option>)}
            </select>
          </Field>
        </div>
        <Field label="ملاحظات"><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'إنشاء إحالة'}</button>
        </div>
      </form>

      {data.referrals.length === 0 ? <Empty text="لا توجد إحالات" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>السبب</th><th>العيادة</th><th>التخصص</th><th>الحالة</th><th>التاريخ</th></tr></thead>
            <tbody>
              {data.referrals.map((r) => (
                <tr key={r.referral_id}>
                  <td>{r.reason}</td>
                  <td>{r.to_clinic_name || '—'}</td>
                  <td>{r.to_specialty_name || '—'}</td>
                  <td><span className="chip small">{r.status}</span></td>
                  <td>{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}