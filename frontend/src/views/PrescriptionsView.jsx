import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { useT } from '../i18n'
import { Modal, Field, Loading, Empty, Notice } from '../components/ui'
import { PatientSearchSelect, MedicationSearchSelect } from '../components/SearchSelect'
import { useAuth } from '../auth/AuthContext'
import ImportMedicationsModal from '../components/ImportMedicationsModal'
import { DOSAGE_FORM_CODES, dosageFormLabel } from '../lib/dosageForm'

export default function PrescriptionsView() {
  const [tab, setTab] = useState('medications')
  const t = useT()
  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('navigation.prescriptions')}</h2><p>{t('prescriptions.subtitle')}</p></div>
      </div>
      <div className="tabs">
        <button className={tab === 'medications' ? 'tab active' : 'tab'} onClick={() => setTab('medications')}>{t('prescriptions.tab.medications')}</button>
        <button className={tab === 'prescriptions' ? 'tab active' : 'tab'} onClick={() => setTab('prescriptions')}>{t('prescriptions.tab.create')}</button>
      </div>
      <div className="tab-content">
        {tab === 'medications' ? <MedicationsTab /> : <PrescriptionsTab />}
      </div>
    </section>
  )
}

function MedicationsTab() {
  const t = useT()
  const { user } = useAuth()
  const [rows, setRows] = useState(null)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editMed, setEditMed] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await api.prescriptions.listMedications({ search: search || undefined })
      setRows(result.medications || [])
    } catch (err) {
      setError(err.message || t('prescriptions.medications.error'))
      setRows([])
    }
  }, [search])

  useEffect(() => { load() }, [load])

  const canManageMedications = user?.permissions?.includes('MANAGE_MEDICATIONS') ||
    user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'

  const canImport = canManageMedications ||
    user?.permissions?.includes('CREATE_PRESCRIPTION')

  async function handleDelete(med) {
    if (!window.confirm(t('prescriptions.delete.confirm'))) return
    setError('')
    try {
      await api.prescriptions.deleteMedication(med.medication_id)
      load()
    } catch (err) {
      const msg = err.message || ''
      if (msg.includes('referenced') || msg.includes('prescriptions')) {
        setError(t('prescriptions.delete.referenced'))
      } else {
        setError(t('prescriptions.delete.error'))
      }
    }
  }

  function startEdit(med) {
    setEditMed(med)
    setShowAdd(true)
  }

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <input className="input" placeholder={t("search.medication.placeholder")} value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <button className="primary-button compact" onClick={() => { setEditMed(null); setShowAdd(true); }}>{t('prescriptions.add')}</button>
        {canImport && <button className="secondary-button compact" onClick={() => setShowImport(true)}>{t('prescriptions.import')}</button>}
      </div>
      <Notice kind="error">{error}</Notice>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty text={t('prescriptions.medications.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('prescriptions.brand')}</th><th>{t('prescriptions.scientific')}</th><th>{t('prescriptions.strength')}</th><th>{t('prescriptions.dosageForm')}</th><th>{t('prescriptions.dosage')}</th><th>{t('prescriptions.instructions')}</th><th>{t('prescriptions.actions')}</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.medication_id}>
                  <td data-label={t('prescriptions.brand')}>{m.trade_name}</td>
                  <td data-label={t('prescriptions.scientific')}>{m.scientific_name}</td>
                  <td data-label={t('prescriptions.strength')}>{m.strength || '—'}</td>
                  <td data-label={t('prescriptions.dosageForm')}>{dosageFormLabel(m.dosage_form, t)}</td>
                  <td data-label={t('prescriptions.dosage')}>{m.default_dosage || '—'}</td>
                  <td data-label={t('prescriptions.instructions')}>{m.instructions || '—'}</td>
                  <td data-label={t('prescriptions.actions')}>
                    {canManageMedications && (
                      <>
                        <button className="text-button" onClick={() => startEdit(m)}>{t('users.action.edit')}</button>
                        <button className="text-button danger" onClick={() => handleDelete(m)}>{t('users.action.delete')}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showAdd && <AddMedicationModal editMed={editMed} onClose={() => { setShowAdd(false); setEditMed(null); }} onSaved={() => { setShowAdd(false); setEditMed(null); load() }} />}
      {showImport && <ImportMedicationsModal onClose={() => setShowImport(false)} onImported={() => load()} />}
    </div>
  )
}

function AddMedicationModal({ onClose, onSaved, editMed }) {
  const t = useT()
  const isEdit = !!editMed
  const initialForm = isEdit ? {
    trade_name: editMed.trade_name || '',
    scientific_name: editMed.scientific_name || '',
    default_dosage: editMed.default_dosage || '',
    strength: editMed.strength || '',
    dosage_form: editMed.dosage_form || '',
    instructions: editMed.instructions || '',
  } : { trade_name: '', scientific_name: '', default_dosage: '', strength: '', dosage_form: '', instructions: '' }
  const [form, setForm] = useState(initialForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (editMed) {
      setForm({
        trade_name: editMed.trade_name || '',
        scientific_name: editMed.scientific_name || '',
        default_dosage: editMed.default_dosage || '',
        strength: editMed.strength || '',
        dosage_form: editMed.dosage_form || '',
        instructions: editMed.instructions || '',
      })
    }
  }, [editMed])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (isEdit) {
        await api.prescriptions.updateMedication(editMed.medication_id, {
          trade_name: form.trade_name,
          scientific_name: form.scientific_name,
          default_dosage: form.default_dosage || undefined,
          strength: form.strength || undefined,
          dosage_form: form.dosage_form || undefined,
          instructions: form.instructions || undefined,
        })
      } else {
        await api.prescriptions.createMedication({
          trade_name: form.trade_name,
          scientific_name: form.scientific_name,
          default_dosage: form.default_dosage || undefined,
          strength: form.strength || undefined,
          dosage_form: form.dosage_form || undefined,
          instructions: form.instructions || undefined,
        })
      }
      onSaved()
    } catch (err) {
      setError(err.message || (isEdit ? t('prescriptions.edit.error') : t('prescriptions.modal.error')))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? t('prescriptions.edit.title') : t('prescriptions.modal.title')} subtitle={t('prescriptions.modal.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('prescriptions.brand')} required><input required value={form.trade_name} onChange={(e) => setForm({ ...form, trade_name: e.target.value })} /></Field>
        <Field label={t('prescriptions.scientific')} required><input required value={form.scientific_name} onChange={(e) => setForm({ ...form, scientific_name: e.target.value })} /></Field>
        <Field label={t('prescriptions.strength')}><input value={form.strength} onChange={(e) => setForm({ ...form, strength: e.target.value })} /></Field>
        <Field label={t('prescriptions.dosageForm')}>
          <select value={form.dosage_form} onChange={(e) => setForm({ ...form, dosage_form: e.target.value })}>
            <option value="">{t('prescriptions.dosageForm.none')}</option>
            {DOSAGE_FORM_CODES.map((code) => <option key={code} value={code}>{t(`dosageForm.${code}`)}</option>)}
          </select>
        </Field>
        <Field label={t('prescriptions.dosage')}><input value={form.default_dosage} onChange={(e) => setForm({ ...form, default_dosage: e.target.value })} /></Field>
        <Field label={t('prescriptions.instructions')}><textarea rows="2" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : (isEdit ? t('prescriptions.edit.title') : t('prescriptions.modal.submit'))}</button>
        </div>
      </form>
    </Modal>
  )
}
function PrescriptionsTab() {
  const t = useT()
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
      .catch(() => { setVisits([]); setError(t('prescriptions.load.error')) })
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
      setError(err.message || t('prescriptions.create.error'))
    } finally { setSaving(false) }
  }

  return (
    <div className="tab-inner">
      <form className="patient-form prescription-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('prescriptions.patient')} required>
            <PatientSearchSelect value={patientId} onChange={changePatient} required />
          </Field>
          <Field label={t('prescriptions.visit')} required hint={visits?.length === 0 ? t('prescriptions.visit.empty') : undefined}>
            <select required value={visitId} onChange={(e) => setVisitId(e.target.value)} disabled={!patientId}>
              <option value="">{t('prescriptions.visit.placeholder')}</option>
              {(visits || []).map((v) => <option key={v.visit_id} value={v.visit_id}>{fmtDateTime(v.visit_date)}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('prescriptions.notes')}><textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

        <div className="items-head">
          <h4>{t('prescriptions.items')}</h4>
          <button type="button" className="secondary-button compact" onClick={addItem}>{t('prescriptions.add')}</button>
        </div>
        {items.length === 0 ? <Empty text={t('prescriptions.items.empty')} /> : (
          <div className="items-list">
            {items.map((it, i) => (
              <div className="item-card" key={i}>
                <div className="form-row">
                  <Field label={t('prescriptions.medication')} required>
                    <MedicationSearchSelect value={it.medication_id} onChange={(id) => updateItem(i, 'medication_id', id)} required />
                  </Field>
                  <Field label={t('prescriptions.dosage')} required><input required placeholder={t('prescriptions.dosage.placeholder')} value={it.dosage} onChange={(e) => updateItem(i, 'dosage', e.target.value)} /></Field>
                </div>
                <div className="form-row">
                  <Field label={t('prescriptions.frequency')} required><input required placeholder={t('prescriptions.frequency.placeholder')} value={it.frequency} onChange={(e) => updateItem(i, 'frequency', e.target.value)} /></Field>
                  <Field label={t('prescriptions.duration')} required><input required placeholder={t('prescriptions.duration.placeholder')} value={it.duration} onChange={(e) => updateItem(i, 'duration', e.target.value)} /></Field>
                </div>
                <div className="form-row">
                  <Field label={t('prescriptions.timing')}><input placeholder={t('prescriptions.timing.placeholder')} value={it.timing_instructions} onChange={(e) => updateItem(i, 'timing_instructions', e.target.value)} /></Field>
                  <Field label={t('prescriptions.repeats')}><input type="number" min="1" value={it.repeats_count} onChange={(e) => updateItem(i, 'repeats_count', e.target.value)} /></Field>
                </div>
                <button type="button" className="text-button danger" onClick={() => removeItem(i)}>{t('prescriptions.remove')}</button>
              </div>
            ))}
          </div>
        )}

        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button className="primary-button" disabled={saving || items.length === 0}>{saving ? t('prescriptions.creating') : t('prescriptions.create')}</button>
        </div>
      </form>

      {created && <PrescriptionDetailModal prescription={created} onClose={() => setCreated(null)} />}
    </div>
  )
}
function PrescriptionDetailModal({ prescription, onClose }) {
  const t = useT()
  const data = prescription.prescription || prescription
  const items = prescription.items || []
  return (
    <Modal title={t('prescriptions.detail.title')} subtitle={t('prescriptions.detail.subtitle', { id: data.prescription_id })} onClose={onClose} wide>
      <div className="prescription-paper" dir="rtl">
        <div className="paper-head">
          <div><strong>{t('patients.prescriptionItems.paperTitle')}</strong><span>{data.doctor_name || t('patients.prescriptionItems.doctorFallback')}</span></div>
          <div className="paper-date">{fmtDateTime(data.created_at)}</div>
        </div>
        <div className="paper-patient">
          <span><b>{t('patients.prescriptionItems.patientLabel')}</b> {data.patient_name}</span>
          {data.gender ? <span><b>{t('prescriptions.detail.gender')}</b> {data.gender === 'FEMALE' ? 'أنثى' : 'ذكر'}</span> : null}
          {data.date_of_birth ? <span><b>{t('prescriptions.detail.dob')}</b> {new Date(data.date_of_birth).toLocaleDateString('ar-EG')}</span> : null}
        </div>
        {data.notes ? <div className="paper-notes"><b>{t('patients.prescriptionItems.notesLabel')}</b> {data.notes}</div> : null}
        <table>
          <thead><tr><th>#</th><th>{t('prescriptions.detail.medication')}</th><th>{t('prescriptions.detail.dosage')}</th><th>{t('prescriptions.detail.strength')}</th><th>{t('prescriptions.detail.dosageForm')}</th><th>{t('prescriptions.detail.frequency')}</th><th>{t('prescriptions.detail.duration')}</th><th>{t('prescriptions.detail.repeat')}</th></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.item_id}>
                <td>{i + 1}</td><td>{it.trade_name} ({it.scientific_name})</td><td>{it.dosage}</td><td>{it.strength || '—'}</td><td>{dosageFormLabel(it.dosage_form, t)}</td><td>{it.frequency}</td><td>{it.duration}</td><td>{it.repeats_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="paper-actions">
          <button className="primary-button compact" onClick={() => window.print()}>{t('prescriptions.detail.print')}</button>
          <button className="secondary-button compact" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </Modal>
  )
}