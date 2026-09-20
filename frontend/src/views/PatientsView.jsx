import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useT } from '../i18n'
import { fmtDate, fmtDateTime, GENDER_LABELS, DOCUMENT_TYPE_LABELS, ALLERGEN_KEYS, CHRONIC_CONDITION_KEYS, CONDITION_SEVERITY_KEYS } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'
import VisitModal from '../components/VisitModal'

const LIMIT = 10

// دليل العيادات بالاسم — يُستخدم في كل نماذج الاختيار بالاسم بدل إدخال رقم العيادة
function useClinicDirectory(enabled = true) {
  const [clinics, setClinics] = useState([])
  const [loading, setLoading] = useState(enabled)
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.clinics.directory()
      .then((result) => { if (!cancelled) setClinics(result.clinics || []) })
      .catch(() => { if (!cancelled) setClinics([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [enabled])
  return { clinics, loading }
}

const clinicNameById = (clinics, clinicId) => {
  const id = Number(clinicId)
  if (!id) return ''
  return clinics.find((c) => Number(c.clinic_id) === id)?.clinic_name || ''
}

// مودال موحد لعرض محتوى أدوية الروشتة (يُستخدم في ملف المريض)
export function PrescriptionItemsModal({ prescriptionId, onClose }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setError('')
    api.prescriptions.get(prescriptionId)
      .then((result) => { if (!cancelled) setData(result) })
      .catch((err) => { if (!cancelled) setError(err.message || t('patients.prescriptionItems.error')) })
    return () => { cancelled = true }
  }, [prescriptionId])
  const rx = data?.prescription || {}
  const items = data?.items || []
  return (
    <Modal title={t('patients.prescriptionItems.title')} subtitle={rx.clinic_name ? t('patients.prescriptionItems.subtitleDirect', { clinic: rx.clinic_name }) : t('patients.prescriptionItems.subtitleNumber', { number: rx.prescription_id || prescriptionId })} onClose={onClose} wide>
      <Notice kind="error">{error}</Notice>
      {!data && !error ? <Loading text={t('patients.prescriptionItems.loading')} /> : data ? (
        <div className="prescription-paper" dir="rtl">
          <div className="paper-head">
            <div><strong>{t('patients.prescriptionItems.paperTitle')}</strong><span>{rx.doctor_name || t('patients.prescriptionItems.doctor')}</span></div>
            <div className="paper-date">{fmtDateTime(rx.created_at)}</div>
          </div>
          <div className="paper-patient">
            <span><b>{t('patients.prescriptionItems.patientLabel')}</b> {rx.patient_name || '—'}</span>
            {rx.clinic_name ? <span><b>{t('patients.prescriptionItems.clinicLabel')}</b> {rx.clinic_name}</span> : null}
          </div>
          {rx.notes ? <div className="paper-notes"><b>{t('patients.prescriptionItems.notesLabel')}</b> {rx.notes}</div> : null}
          {items.length === 0 ? <Empty text={t('patients.prescriptionItems.empty')} /> : (
            <div className="table-wrap table-cards">
              <table>
                <thead><tr><th>{t('patients.prescriptionItems.tableNumber')}</th><th>{t('patients.prescriptionItems.tableMedication')}</th><th>{t('patients.prescriptionItems.tableDosage')}</th><th>{t('patients.prescriptionItems.tableFrequency')}</th><th>{t('patients.prescriptionItems.tableDuration')}</th><th>{t('patients.prescriptionItems.tableTimingInstructions')}</th><th>{t('patients.prescriptionItems.tableRepeat')}</th></tr></thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={it.item_id ?? i}>
                      <td className="hide-sm" data-label={t('patients.prescriptionItems.tableNumber')}>{i + 1}</td>
                      <td className="cell-title">{it.trade_name}{it.scientific_name ? ` (${it.scientific_name})` : ''}</td>
                      <td data-label={t('patients.prescriptionItems.tableDosage')}>{it.dosage}</td>
                      <td data-label={t('patients.prescriptionItems.tableFrequency')}>{it.frequency}</td>
                      <td data-label={t('patients.prescriptionItems.tableDuration')}>{it.duration}</td>
                      <td data-label={t('patients.prescriptionItems.tableTimingInstructions')}>{it.timing_instructions || '—'}</td>
                      <td data-label={t('patients.prescriptionItems.tableRepeat')}>{it.repeats_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="paper-actions">
            <button className="primary-button compact" onClick={() => window.print()}>{t('patients.prescriptionItems.print')}</button>
            <button className="secondary-button compact" onClick={onClose}>{t('common.close')}</button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

export default function PatientsView() {
  const t = useT()
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.patients.list({ search: search || undefined, page, limit: LIMIT })
      setRows(result.patients || [])
    } catch (err) {
      setError(err.message || t('patients.error.load'))
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('patients.title')}</h2><p>{t('patients.subtitle')}</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('patients.create')}</button>
      </div>

      <div className="toolbar">
        <input className="input" placeholder={t('patients.searchPlaceholder')} value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text={t('patients.loading')} /> : rows.length === 0 ? <Empty text={t('patients.empty')} /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr><th>{t('patients.table.patient')}</th><th>{t('patients.table.nationalId')}</th><th>{t('patients.table.phone')}</th><th>{t('patients.table.genderType')}</th><th>{t('patients.table.birthDate')}</th><th>{t('patients.table.registeredAt')}</th><th>{t('patients.table.actions')}</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.patient_id}>
                    <td><span className="table-avatar">{p.full_name?.[0] || t('patients.avatarInitial')}</span>{p.full_name}{p.is_shared ? <span className="badge shared-chip">{t('patients.sharedBadge')}</span> : null}</td>
                    <td dir="ltr" data-label={t('patients.table.nationalId')}>{p.national_id || '—'}</td>
                    <td dir="ltr" data-label={t('patients.table.phone')}>{p.phone}</td>
                    <td data-label={t('patients.table.genderType')}>{GENDER_LABELS[p.gender] || p.gender}</td>
                    <td data-label={t('patients.table.birthDate')}>{fmtDate(p.date_of_birth, true)}</td>
                    <td data-label={t('patients.table.registeredAt')}>{fmtDate(p.created_at, true)}</td>
                    <td className="cell-actions"><button className="text-button" onClick={() => setSelected(p)}>{t('patients.openFile')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} />
        </>
      )}

      {showAdd && <AddPatientModal user={user} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {selected && <PatientDetailModal patient={selected} user={user} onClose={() => setSelected(null)} />}
    </section>
  )
}

function AddPatientModal({ user, onClose, onSaved }) {
  const t = useT()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const { clinics, loading: clinicsLoading } = useClinicDirectory(true)
  const defaultClinic = useMemo(() => {
    const mine = Number(user?.clinicId)
    if (mine) return String(mine)
    if (!isGlobal && user?.clinicIds?.length) return String(user.clinicIds[0])
    return ''
  }, [user, isGlobal])
  const [form, setForm] = useState({ full_name: '', document_type: 'NATIONAL_ID', document_number: '', national_id: '', phone: '', gender: 'MALE', date_of_birth: '', clinic_id: defaultClinic })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // عند اكتمال تحميل الدليل، تأكد أن النموذج يحتوي على قيمة عيادة صالحة
  useEffect(() => {
    if (!defaultClinic) return
    setForm((prev) => ({ ...prev, clinic_id: defaultClinic }))
  }, [defaultClinic])

  // إذا كان المستخدم غير مدير ودليل العيادات جاهز، تأكد أن العيادة الافتراضية مختارة بالاسم
  useEffect(() => {
    if (isGlobal || clinicsLoading || !user?.clinicId) return
    const mine = clinics.find((c) => Number(c.clinic_id) === Number(user.clinicId))
    if (mine && (!form.clinic_id || form.clinic_id === '')) {
      setForm((prev) => ({ ...prev, clinic_id: String(mine.clinic_id) }))
    }
  }, [clinics, clinicsLoading, user?.clinicId, form.clinic_id, isGlobal])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.patients.create({ ...form, national_id: form.national_id || undefined, clinic_id: form.clinic_id ? Number(form.clinic_id) : undefined })
      onSaved()
    } catch (err) {
      setError(err.message || t('patients.add.saveError'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('patients.create.title')} subtitle={t('patients.modal.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('patients.fullName')} required>
          <input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label={t('patients.clinicField')} required
          hint={clinicsLoading ? t('patients.loadingClinics') : (isGlobal ? t('patients.clinicHintGlobal') : t('patients.clinicHintAssigned'))}>
          {clinicsLoading ? (
            <select disabled><option>{t('patients.loadingClinics')}</option></select>
          ) : isGlobal ? (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">{t('patients.add.selectClinic')}</option>
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          ) : (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">{t('patients.myClinicsOption')}</option>
              {clinics
                .filter((c) => (user?.clinicIds || (user?.clinicId ? [user.clinicId] : [])).map(Number).includes(Number(c.clinic_id)))
                .map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          )}
        </Field>
        <div className="form-row"><Field label={t('patients.documentType')} required>
          <select value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })}>
            <option value="NATIONAL_ID">{t('documentType.NATIONAL_ID')}</option>
            <option value="PASSPORT">{t('documentType.PASSPORT')}</option>
            <option value="OTHER">{t('documentType.OTHER')}</option>
          </select>
        </Field>
        <Field label={t('patients.documentNumber')} required><input required maxLength={100} value={form.document_number} onChange={(e) => setForm({ ...form, document_number: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('patients.nationalId')}><input value={form.national_id} onChange={(e) => setForm({ ...form, national_id: e.target.value })} /></Field>
          <Field label={t('patients.phone')} required><input required minLength={7} dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('patients.gender')} required>
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="MALE">{t('patients.genderMale')}</option><option value="FEMALE">{t('patients.genderFemale')}</option>
            </select>
          </Field>
          <Field label={t('patients.birthDate')} required><input required type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></Field>
        </div>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('patients.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
function PatientDetailModal({ patient, user, onClose }) {
  const t = useT()
  const [tab, setTab] = useState('visits')
  return (
    <Modal title={patient.full_name} subtitle={t('patients.detail.fileNumber', { id: patient.patient_id })} onClose={onClose} wide>
      <div className="detail-summary">
        <span>{GENDER_LABELS[patient.gender] || patient.gender}</span>
        <span dir="ltr">{patient.phone}</span>
        {patient.document_type ? <span>{DOCUMENT_TYPE_LABELS[patient.document_type] || patient.document_type}: <span dir="ltr">{patient.document_number}</span></span> : null}
        {patient.national_id ? <span dir="ltr">{patient.national_id}</span> : null}
        <span>{fmtDate(patient.date_of_birth, true)}</span>
      </div>
      <div className="tabs">
        <button className={tab === 'visits' ? 'tab active' : 'tab'} onClick={() => setTab('visits')}>{t('patients.tabVisits')}</button>
        <button className={tab === 'medical' ? 'tab active' : 'tab'} onClick={() => setTab('medical')}>{t('patients.tabMedical')}</button>
        <button className={tab === 'record' ? 'tab active' : 'tab'} onClick={() => setTab('record')}>{t('patients.tabUnifiedRecord')}</button>
        <button className={tab === 'shares' ? 'tab active' : 'tab'} onClick={() => setTab('shares')}>{t('patients.tabs.shares')}</button>
      </div>
      <div className="tab-content">
        {tab === 'visits' && <VisitsTab patient={patient} user={user} />}
        {tab === 'medical' && <MedicalProfileTab patient={patient} user={user} />}
        {tab === 'record' && <MedicalRecordTab patient={patient} />}
        {tab === 'shares' && <SharesTab patient={patient} />}
      </div>
    </Modal>
  )
}

// تبويب البيانات الطبية التكميلية — الطبيب يكمل ويحدّث، والبقية عرض فقط
function MedicalProfileTab({ patient, user }) {
  const t = useT()
  const canEdit = ['DOCTOR', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user?.roleName) || (user?.permissions || []).includes('EDIT_PATIENT_MEDICAL')
  const [profile, setProfile] = useState(null)
  const [allergySel, setAllergySel] = useState({})
  const [condSel, setCondSel] = useState({})
  const [extras, setExtras] = useState({ blood_type: '', current_medications: '', medical_notes: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const applyResult = useCallback((result) => {
    const p = result.profile
    setProfile(p)
    setExtras({
      blood_type: p?.blood_type || '',
      current_medications: p?.current_medications || '',
      medical_notes: p?.medical_notes || '',
    })
    setAllergySel(Object.fromEntries(ALLERGEN_KEYS.map((k) => {
      const row = (result.allergies || []).find((a) => a.allergen_key === k)
      return [k, { checked: Boolean(row), notes: row?.notes || '' }]
    })))
    setCondSel(Object.fromEntries(CHRONIC_CONDITION_KEYS.map((k) => {
      const row = (result.chronic_conditions || []).find((c) => c.condition_key === k)
      return [k, { checked: Boolean(row), severity: row?.severity || 'UNSPECIFIED', notes: row?.notes || '' }]
    })))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.patients.medicalProfile(patient.patient_id)
      applyResult(result)
    } catch (err) {
      setError(err.message || t('patients.medical.loadError'))
    } finally { setLoading(false) }
  }, [patient.patient_id, applyResult])

  useEffect(() => { load() }, [load])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    setDone(false)
    try {
      const result = await api.patients.saveMedicalProfile(patient.patient_id, {
        blood_type: extras.blood_type || undefined,
        current_medications: extras.current_medications.trim() || undefined,
        medical_notes: extras.medical_notes.trim() || undefined,
        allergies: ALLERGEN_KEYS.filter((k) => allergySel[k]?.checked).map((k) => ({ allergen_key: k, notes: allergySel[k].notes.trim() || undefined })),
        chronic_conditions: CHRONIC_CONDITION_KEYS.filter((k) => condSel[k]?.checked).map((k) => ({ condition_key: k, severity: condSel[k].severity || undefined, notes: condSel[k].notes.trim() || undefined })),
      })
      applyResult(result)
      setDone(true)
    } catch (err) {
      setError(err.message || t('patients.medical.saveError'))
    } finally { setSaving(false) }
  }

  if (loading) return <Loading text={t('patients.medical.loading')} />

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('patients.medical.bloodType')}>
            <select value={extras.blood_type} disabled={!canEdit} onChange={(e) => setExtras({ ...extras, blood_type: e.target.value })}>
              <option value="">{t('patients.medical.unspecified')}</option>
              {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bt) => <option key={bt} value={bt}>{bt}</option>)}
            </select>
          </Field>
          <Field label={t('patients.medical.currentMedications')} hint={t('patients.medical.currentMedicationsHint')}>
            <textarea rows="2" disabled={!canEdit} value={extras.current_medications} onChange={(e) => setExtras({ ...extras, current_medications: e.target.value })} />
          </Field>
        </div>

        <div className="med-section">
          <h4>{t('patients.allergy')}</h4>
          <div className="med-grid">
            {ALLERGEN_KEYS.map((key) => (
              <div className="med-item" key={key}>
                <label className="med-check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(allergySel[key]?.checked)} onChange={(e) => setAllergySel({ ...allergySel, [key]: { ...allergySel[key], checked: e.target.checked } })} />
                  <span>{t('allergen.' + key)}</span>
                </label>
                <input className="med-note" placeholder={t('patients.medical.allergyNotePlaceholder')} disabled={!canEdit || !allergySel[key]?.checked} value={allergySel[key]?.notes || ''} onChange={(e) => setAllergySel({ ...allergySel, [key]: { ...allergySel[key], notes: e.target.value } })} />
              </div>
            ))}
          </div>
        </div>

        <div className="med-section">
          <h4>{t('patients.chronicConditions')}</h4>
          <div className="med-grid">
            {CHRONIC_CONDITION_KEYS.map((key) => (
              <div className="med-item" key={key}>
                <label className="med-check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(condSel[key]?.checked)} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], checked: e.target.checked } })} />
                  <span>{t('chronicCondition.' + key)}</span>
                </label>
                <select className="med-sev" disabled={!canEdit || !condSel[key]?.checked} value={condSel[key]?.severity || 'UNSPECIFIED'} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], severity: e.target.value } })} aria-label={t('patients.medical.severityAria')}>
                  {CONDITION_SEVERITY_KEYS.map((code) => <option key={code} value={code}>{t('conditionSeverity.' + code)}</option>)}
                </select>
                <input className="med-note" placeholder={t('patients.medical.notePlaceholder')} disabled={!canEdit || !condSel[key]?.checked} value={condSel[key]?.notes || ''} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], notes: e.target.value } })} />
              </div>
            ))}
          </div>
        </div>

        <Field label={t('patients.medical.notes')}>
          <textarea rows="3" disabled={!canEdit} value={extras.medical_notes} onChange={(e) => setExtras({ ...extras, medical_notes: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        {done && <Notice kind="success">{t('patients.medical.savedSuccess')}</Notice>}
        {canEdit ? (
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('patients.medical.save')}</button>
          </div>
        ) : (
          <p className="profile-meta">{t('patients.medical.readOnly')}</p>
        )}
        {profile?.updated_at ? <p className="profile-meta">{t('patients.lastUpdated')}: {fmtDateTime(profile.updated_at)}{profile.updated_by_name ? ` — بواسطة ${profile.updated_by_name}` : ''}</p> : null}
      </form>
    </div>
  )
}

function VisitsTab({ patient, user }) {
  const t = useT()
  const [visits, setVisits] = useState(null)
  const [prescriptions, setPrescriptions] = useState([]) // فارغة افتراضياً
  const [doctors, setDoctors] = useState(null) // null = غير متاح
  const [showAdd, setShowAdd] = useState(false)
  const [openVisitId, setOpenVisitId] = useState(null)
  const [openPrescriptionId, setOpenPrescriptionId] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await api.patients.visits(patient.patient_id)
      setVisits(result.visits || [])
    } catch (err) { setError(err.message); setVisits([]) }
    // الروشتات تأتي من السجل الموحد (لا تعتمد على صلاحيات إضافية عند فشلها)
    try {
      const rec = await api.patients.record(patient.patient_id)
      setPrescriptions(rec.prescriptions || [])
    } catch { /* لا صلاحية للسجل الموحد — نكتفي بالزيارات */ }
  }, [patient.patient_id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    api.users.doctors()
      .then((result) => setDoctors(result.doctors || []))
      .catch(() => setDoctors([]))
  }, [])

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('patients.visits.add')}</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {visits === null ? <Loading /> : visits.length === 0 ? <Empty text={t('patients.visits.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('patients.table.date')}</th><th>{t('patients.table.clinic')}</th><th>{t('patients.table.specialty')}</th><th>{t('patients.table.doctor')}</th><th>{t('patients.table.status')}</th><th>{t('patients.table.notes')}</th><th></th></tr></thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.visit_id}>
                  <td>{fmtDateTime(v.visit_date)}</td>
                  <td>{fmtDateTime(v.visit_date)}</td>
                  <td data-label={t('patients.table.clinic')}>{v.clinic_name || '—'}</td>
                  <td data-label={t('patients.table.specialty')}>{v.specialty_name || '—'}</td>
                  <td data-label={t('patients.table.doctor')}>{v.doctor_name || '—'}</td>
                  <td data-label={t('patients.table.status')}>{v.visit_status === 'OPEN' ? <span className="badge">{t('visit.statusOpen')}</span> : v.visit_status === 'COMPLETED' ? <span className="muted-small">{t('visit.statusCompleted')}</span> : <span className="muted-small">{t('visit.statusCancelled')}</span>}</td>
                  <td data-label={t('patients.table.notes')}>{v.notes || '—'}</td>
                  <td className="cell-actions"><button className="text-button" onClick={() => setOpenVisitId(v.visit_id)}>{t('patients.visit.record')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="record-block" style={{ marginTop: 16 }}>
        <h4>{t('patients.record.prescriptionsTitle')}</h4>
        {prescriptions.length === 0 ? <Empty text={t('patients.record.prescriptionsEmpty')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('patients.table.doctor')}</th><th>{t('patients.table.notes')}</th><th>{t('patients.table.date')}</th><th></th></tr></thead>
              <tbody>
                {prescriptions.map((rx) => (
                  <tr key={rx.prescription_id}>
                    <td>{rx.doctor_name || '—'}</td>
                    <td data-label={t('patients.table.notes')}>{rx.notes || '—'}</td>
                    <td data-label={t('patients.table.date')}>{fmtDateTime(rx.created_at)}</td>
                    <td className="cell-actions"><button className="text-button" onClick={() => setOpenPrescriptionId(rx.prescription_id)}>{t('patients.record.viewPrescription')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && <AddVisitModal patient={patient} user={user} doctors={doctors} onClose={() => setShowAdd(false)} onSaved={(newVisitId) => { setShowAdd(false); load(); if (newVisitId) setOpenVisitId(newVisitId) }} />}
      {openVisitId && <VisitModal visitId={openVisitId} onClose={() => { setOpenVisitId(null); load() }} />}
      {openPrescriptionId && <PrescriptionItemsModal prescriptionId={openPrescriptionId} onClose={() => setOpenPrescriptionId(null)} />}
    </div>
  )
}

function AddVisitModal({ patient, user, doctors: initialDoctors, onClose, onSaved }) {
  const t = useT()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const { clinics, loading: clinicsLoading } = useClinicDirectory(true)
  const userClinicLabel = clinicNameById(clinics, user?.clinicId) || (user?.clinicId ? t('layout.clinicById', { id: user.clinicId }) : '')
  // العيادات المسندة للمستخدم فقط (الأساسية + الإسنادات الإضافية clinic_staff)
  const myClinicIds = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
  const myClinics = clinics.filter((c) => myClinicIds.includes(Number(c.clinic_id)))
  const [form, setForm] = useState({
    clinic_id: isGlobal ? '' : (user?.clinicId || ''),
    doctor_id: '',
    notes: '',
  })
  const [doctors, setDoctors] = useState(initialDoctors || [])
  const [loadingDoctors, setLoadingDoctors] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // قيمة افتراضية: العيادة الأساسية إن كانت ضمن المسندة، وإلا أول عيادة مسندة
  useEffect(() => {
    if (isGlobal || form.clinic_id) return
    const ids = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
    const mine = clinics.filter((c) => ids.includes(Number(c.clinic_id)))
    const preferred = mine.find((c) => Number(c.clinic_id) === Number(user?.clinicId)) || mine[0]
    if (preferred) setForm((prev) => ({ ...prev, clinic_id: String(preferred.clinic_id) }))
  }, [isGlobal, form.clinic_id, clinics, user])

  // تحميل الأطباء المسندين للعيادة المختارة فقط (وليس كل الأطباء)
  useEffect(() => {
    const clinicId = form.clinic_id
    if (!clinicId) {
      setDoctors([])
      setLoadingDoctors(false)
      return
    }
    setLoadingDoctors(true)
    api.users.doctors({ clinic_id: Number(clinicId) })
      .then((result) => setDoctors(result.doctors || []))
      .catch(() => setDoctors([]))
      .finally(() => setLoadingDoctors(false))
  }, [form.clinic_id])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await api.patients.createVisit({
        patient_id: patient.patient_id,
        clinic_id: Number(form.clinic_id) || user?.clinicId,
        doctor_id: Number(form.doctor_id),
        notes: form.notes || undefined,
      })
      onSaved(result?.visit?.visit_id || null)
    } catch (err) {
      setError(err.message || t('patients.addVisit.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('patients.addVisit.title', { name: patient.full_name })} subtitle={t('patients.addVisit.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('patients.addVisit.clinicLabel')} required hint={isGlobal ? t('patients.addVisit.globalHint') : myClinics.length > 1 ? t('patients.addVisit.assignedHint') : t('patients.addVisit.currentClinic', { clinic: userClinicLabel || '—' })}>
          {isGlobal ? (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value, doctor_id: '' })}>
              <option value="">{t('patients.addVisit.clinicOption')}</option>
              {clinicsLoading ? <option disabled>{t('patients.loadingClinics')}</option> : null}
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          ) : myClinics.length > 1 ? (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value, doctor_id: '' })}>
              {myClinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          ) : (
            <input required value={userClinicLabel} readOnly />
          )}
        </Field>
        <Field label={t('patients.addVisit.doctorField')} required hint={loadingDoctors ? t('patients.loadingDoctors') : (doctors.length === 0 ? t('patients.addVisit.noDoctors') : undefined)}>
          {loadingDoctors ? (
            <select disabled><option>{t('patients.loadingDoctors')}</option></select>
          ) : doctors.length > 0 ? (
            <select required value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}>
              <option value="">{t('patients.addVisit.doctorOption')}</option>
              {doctors.map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}{d.sub_specialty ? ` — ${d.sub_specialty}` : ''}</option>)}
            </select>
          ) : (
            <input type="number" required placeholder={t('patients.addVisit.doctorIdPlaceholder')} value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })} />
          )}
        </Field>
        <Field label={t('patients.addVisit.notesField')}><textarea rows="3" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('patients.addVisit.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
function MedicalRecordTab({ patient }) {
  const t = useT()
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  const [openPrescriptionId, setOpenPrescriptionId] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.patients.record(patient.patient_id)
      .then((data) => { if (!cancelled) setRecord(data) })
      .catch((err) => setError(err.message || t('patients.record.noPermission')))
    return () => { cancelled = true }
  }, [patient.patient_id])

  if (error) return <Notice kind="error">{error}</Notice>
  if (!record) return <Loading text={t('patients.record.loading')} />

  return (
    <div className="tab-inner record-grid">
      <div className="record-block">
        <h4>{t('patients.record.visitsTitle')}</h4>
        {record.visits?.length === 0 ? <Empty text={t('patients.record.noVisits')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('patients.table.clinic')}</th><th>{t('patients.table.doctor')}</th><th>{t('patients.table.date')}</th><th>{t('patients.table.notes')}</th></tr></thead>
              <tbody>
                {record.visits.map((v) => (
                  <tr key={v.visit_id}>
                    <td>{v.clinic_name || '—'}</td>
                    <td data-label={t('patients.table.doctor')}>{v.doctor_name || '—'}</td>
                    <td data-label={t('patients.table.date')}>{fmtDateTime(v.visit_date)}</td>
                    <td data-label={t('patients.table.notes')}>{v.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>{t('patients.record.prescriptionsTitle')}</h4>
        {record.prescriptions?.length === 0 ? <Empty text={t('patients.record.prescriptionsEmpty')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('patients.table.doctor')}</th><th>{t('patients.table.notes')}</th><th>{t('patients.table.date')}</th><th></th></tr></thead>
              <tbody>
                {record.prescriptions.map((rx) => (
                  <tr key={rx.prescription_id}>
                    <td>{rx.doctor_name || '—'}</td>
                    <td data-label={t('patients.table.notes')}>{rx.notes || '—'}</td>
                    <td data-label={t('patients.table.date')}>{fmtDateTime(rx.created_at)}</td>
                    <td className="cell-actions"><button className="text-button" onClick={() => setOpenPrescriptionId(rx.prescription_id)}>{t('patients.record.viewPrescription')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {openPrescriptionId && <PrescriptionItemsModal prescriptionId={openPrescriptionId} onClose={() => setOpenPrescriptionId(null)} />}
    </div>
  )
}

function SharesTab({ patient }) {
  const t = useT()
  const [shares, setShares] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')
  const [doing, setDoing] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api.patients.listShares(patient.patient_id)
      setShares(result.shares || [])
    } catch (err) { setError(err.message); setShares([]) }
  }, [patient.patient_id])

  useEffect(() => { load() }, [load])

  async function revoke(shareId) {
    if (!window.confirm(t('patients.share.confirmRevoke'))) return
    setDoing(true)
    try {
      await api.patients.revokeShare(patient.patient_id, shareId)
      await load()
    } catch (err) { setError(err.message) } finally { setDoing(false) }
  }

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('patients.shareAddButton')}</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {shares === null ? <Loading /> : shares.length === 0 ? <Empty text={t('patients.share.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('patients.share.tableTargetClinic')}</th><th>{t('patients.share.tableAccessLevel')}</th><th>{t('patients.share.tableStatus')}</th><th>{t('patients.share.tableExpiry')}</th><th>{t('patients.share.tableActions')}</th></tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.share_id}>
                  <td data-label={t('patients.share.tableTargetClinic')}>{s.clinic_name || '—'}</td>
                  <td data-label={t('patients.share.tableAccessLevel')}>{s.access_level === 'WRITE' ? t('patients.share.accessWrite') : t('patients.share.accessRead')}</td>
                  <td data-label={t('patients.share.tableStatus')}>{s.status === 'ACTIVE' ? t('patients.share.statusActive') : t('patients.share.statusRevoked')}</td>
                  <td data-label={t('patients.share.tableExpiry')}>{fmtDate(s.expires_at)}</td>
                  <td className="cell-actions">
                    {s.status === 'ACTIVE' ? (
                      <button className="text-button" onClick={() => revoke(s.share_id)} disabled={doing}>{t('patients.share.revokeButton')}</button>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showAdd && <AddShareModal patient={patient} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddShareModal({ patient, onClose, onSaved }) {
  const t = useT()
  const { clinics } = useClinicDirectory(true)
  const [form, setForm] = useState({ target_clinic_id: '', access_level: 'READ', expires_at: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.patients.share(patient.patient_id, {
        target_clinic_id: Number(form.target_clinic_id),
        access_level: form.access_level,
        expires_at: new Date(form.expires_at).toISOString(),
      })
      onSaved()
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <Modal title={t('patients.shareAdd.title')} subtitle={t('patients.shareAdd.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('patients.shareAdd.targetClinic')} required hint={t('patients.shareAdd.targetClinicHint')}>
          <select required value={form.target_clinic_id} onChange={(e) => setForm({ ...form, target_clinic_id: e.target.value })}>
            <option value="">{t('patients.shareAdd.selectClinic')}</option>
            {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
          </select>
        </Field>
        <Field label={t('patients.shareAdd.accessLevel')} required>
          <select value={form.access_level} onChange={(e) => setForm({ ...form, access_level: e.target.value })}>
            <option value="READ">{t('patients.share.accessRead')}</option><option value="WRITE">{t('patients.share.accessWrite')}</option>
          </select>
        </Field>
        <Field label={t('patients.shareAdd.expiryDate')} required><input type="date" required value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('patients.shareAdd.saving') : t('patients.shareAdd.save')}</button>
        </div>
      </form>
    </Modal>
  )
}