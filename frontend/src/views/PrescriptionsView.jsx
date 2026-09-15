import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice } from '../components/ui'
import { PatientSearchSelect, MedicationSearchSelect } from '../components/SearchSelect'
import { useAuth } from '../auth/AuthContext'
import ImportMedicationsModal from '../components/ImportMedicationsModal'

export default function PrescriptionsView() {
  const [tab, setTab] = useState('medications')
  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>الروشتات والأدوية</h2><p>دليل الأدوية وإنشاء وطباعة الروشتات الطبي</p></div>
      </div>
      <div className="tabs">
        <button className={tab === 'medications' ? 'tab active' : 'tab'} onClick={() => setTab('medications')}>دليل الأدوية</button>
        <button className={tab === 'prescriptions' ? 'tab active' : 'tab'} onClick={() => setTab('prescriptions')}>إنشاء روشتة</button>
      </div>
      <div className="tab-content">
        {tab === 'medications' ? <MedicationsTab /> : <PrescriptionsTab />}
      </div>
    </section>
  )
}

function MedicationsTab() {
  const { user } = useAuth()
  const [rows, setRows] = useState(null)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await api.prescriptions.listMedications({ search: search || undefined })
      setRows(result.medications || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل الأدوية')
      setRows([])
    }
  }, [search])

  useEffect(() => { load() }, [load])

  const canImport = user?.permissions?.includes('MANAGE_MEDICATIONS') ||
    user?.permissions?.includes('CREATE_PRESCRIPTION') ||
    user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <input className="input" placeholder="ابحث باسم الدواء (التجاري أو العلمي)..." value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ إضافة دواء</button>
        {canImport && <button className="secondary-button compact" onClick={() => setShowImport(true)}>📥 استيراد دليل</button>}
      </div>
      <Notice kind="error">{error}</Notice>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty text="لا توجد أدوية مطابقة" /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>الاسم التجاري</th><th>الاسم العلمي</th><th>الجرعة الافتراضية</th><th>التعليمات</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.medication_id}>
                  <td data-label="الاسم التجاري">{m.trade_name}</td>
                  <td data-label="الاسم العلمي">{m.scientific_name}</td>
                  <td data-label="الجرعة الافتراضية">{m.default_dosage || '—'}</td>
                  <td data-label="التعليمات">{m.instructions || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showAdd && <AddMedicationModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {showImport && <ImportMedicationsModal onClose={() => setShowImport(false)} onImported={() => load()} />}
    </div>
  )
}

function AddMedicationModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ trade_name: '', scientific_name: '', default_dosage: '', instructions: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.prescriptions.createMedication({ ...form, default_dosage: form.default_dosage || undefined, instructions: form.instructions || undefined })
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر إضافة الدواء')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="إضافة دواء جديد" subtitle="دليل الأدوية" onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="الاسم التجاري" required><input required value={form.trade_name} onChange={(e) => setForm({ ...form, trade_name: e.target.value })} /></Field>
        <Field label="الاسم العلمي" required><input required value={form.scientific_name} onChange={(e) => setForm({ ...form, scientific_name: e.target.value })} /></Field>
        <Field label="الجرعة الافتراضية"><input value={form.default_dosage} onChange={(e) => setForm({ ...form, default_dosage: e.target.value })} /></Field>
        <Field label="التعليمات"><textarea rows="2" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'إضافة الدواء'}</button>
        </div>
      </form>
    </Modal>
  )
}
function PrescriptionsTab() {
  const [patientId, setPatientId] = useState('')
  const [visits, setVisits] = useState(null)
  const [visitId, setVisitId] = useState('')
  const [items, setItems] = useState([])
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState(null)

  // المرضى والأدوية يُجلَبان من جهة الخادم عند البحث (SearchSelect) بدل تحميل أول 100/50 فقط
  useEffect(() => {
    if (!patientId) { setVisits(null); setVisitId(''); return }
    api.patients.visits(patientId)
      .then((r) => setVisits(r.visits || []))
      .catch(() => { setVisits([]); setError('تعذر تحميل زيارات المريض') })
  }, [patientId])

  // تغيير المريض يُبطل الزيارة المختارة سابقًا (الزيارة تخص مريضًا واحدًا)
  function changePatient(id) {
    if (String(id) === String(patientId)) return
    setPatientId(id)
    setVisitId('')
  }

  function addItem() {
    setItems((prev) => [...prev, { medication_id: '', dosage: '', frequency: '', duration: '', timing_instructions: '', repeats_count: 1 }])
  }

  function updateItem(index, key, value) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, [key]: value } : it)))
  }

  function removeItem(index) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await api.prescriptions.create({
        visit_id: Number(visitId),
        patient_id: Number(patientId),
        notes: notes || undefined,
        items: items.map((it) => ({
          medication_id: Number(it.medication_id),
          dosage: it.dosage,
          frequency: it.frequency,
          duration: it.duration,
          timing_instructions: it.timing_instructions || undefined,
          repeats_count: Number(it.repeats_count) || 1,
        })),
      })
      const detail = await api.prescriptions.get(result.prescription_id)
      setCreated(detail)
      setItems([]); setNotes(''); setVisitId(''); setPatientId('')
    } catch (err) {
      setError(err.message || 'تعذر إنشاء الروشتة')
    } finally { setSaving(false) }
  }

  return (
    <div className="tab-inner">
      <form className="patient-form prescription-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="المريض" required>
            <PatientSearchSelect value={patientId} onChange={changePatient} required />
          </Field>
          <Field label="الزيارة" required hint={visits?.length === 0 ? 'لا توجد زيارات لهذا المريض' : undefined}>
            <select required value={visitId} onChange={(e) => setVisitId(e.target.value)} disabled={!patientId}>
              <option value="">اختر الزيارة...</option>
              {(visits || []).map((v) => <option key={v.visit_id} value={v.visit_id}>{fmtDateTime(v.visit_date)}</option>)}
            </select>
          </Field>
        </div>
        <Field label="ملاحظات الروشتة"><textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

        <div className="items-head">
          <h4>الأدوية</h4>
          <button type="button" className="secondary-button compact" onClick={addItem}>+ إضافة دواء</button>
        </div>
        {items.length === 0 ? <Empty text="أضف عنصراً واحداً على الأقل" /> : (
          <div className="items-list">
            {items.map((it, i) => (
              <div className="item-card" key={i}>
                <div className="form-row">
                  <Field label="الدواء" required>
                    <MedicationSearchSelect value={it.medication_id} onChange={(id) => updateItem(i, 'medication_id', id)} required />
                  </Field>
                  <Field label="الجرعة" required><input required placeholder="مثال: 500 ملغ" value={it.dosage} onChange={(e) => updateItem(i, 'dosage', e.target.value)} /></Field>
                </div>
                <div className="form-row">
                  <Field label="التردد" required><input required placeholder="مثال: كل 8 ساعات" value={it.frequency} onChange={(e) => updateItem(i, 'frequency', e.target.value)} /></Field>
                  <Field label="المدة" required><input required placeholder="مثال: 7 أيام" value={it.duration} onChange={(e) => updateItem(i, 'duration', e.target.value)} /></Field>
                </div>
                <div className="form-row">
                  <Field label="تعليمات التوقيت"><input placeholder="مثال: بعد الأكل" value={it.timing_instructions} onChange={(e) => updateItem(i, 'timing_instructions', e.target.value)} /></Field>
                  <Field label="عدد التكرارات"><input type="number" min="1" value={it.repeats_count} onChange={(e) => updateItem(i, 'repeats_count', e.target.value)} /></Field>
                </div>
                <button type="button" className="text-button danger" onClick={() => removeItem(i)}>حذف العنصر</button>
              </div>
            ))}
          </div>
        )}

        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving || items.length === 0}>{saving ? 'جارِ الإنشاء...' : 'إنشاء الروشتة'}</button>
        </div>
      </form>

      {created && <PrescriptionDetailModal prescription={created} onClose={() => setCreated(null)} />}
    </div>
  )
}
function PrescriptionDetailModal({ prescription, onClose }) {
  const data = prescription.prescription || prescription
  const items = prescription.items || []
  return (
    <Modal title="تفاصيل الروشتة" subtitle={`رقم ${data.prescription_id}`} onClose={onClose} wide>
      <div className="prescription-paper" dir="rtl">
        <div className="paper-head">
          <div><strong>روشتة طبية</strong><span>{data.doctor_name || 'طبيب'}</span></div>
          <div className="paper-date">{fmtDateTime(data.created_at)}</div>
        </div>
        <div className="paper-patient">
          <span><b>المريض:</b> {data.patient_name}</span>
          {data.gender ? <span><b>الجنس:</b> {data.gender === 'FEMALE' ? 'أنثى' : 'ذكر'}</span> : null}
          {data.date_of_birth ? <span><b>تاريخ الميلاد:</b> {new Date(data.date_of_birth).toLocaleDateString('ar-EG')}</span> : null}
        </div>
        {data.notes ? <div className="paper-notes"><b>ملاحظات:</b> {data.notes}</div> : null}
        <table>
          <thead><tr><th>#</th><th>الدواء</th><th>الجرعة</th><th>التردد</th><th>المدة</th><th>التكرار</th></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.item_id}>
                <td>{i + 1}</td><td>{it.trade_name} ({it.scientific_name})</td><td>{it.dosage}</td><td>{it.frequency}</td><td>{it.duration}</td><td>{it.repeats_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="paper-actions">
          <button className="primary-button compact" onClick={() => window.print()}>طباعة</button>
          <button className="secondary-button compact" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </Modal>
  )
}