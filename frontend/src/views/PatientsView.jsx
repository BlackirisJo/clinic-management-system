import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { fmtDate, fmtDateTime, GENDER_LABELS, DOCUMENT_TYPE_LABELS, ALLERGEN_LABELS, ALLERGEN_KEYS, CHRONIC_CONDITION_LABELS, CHRONIC_CONDITION_KEYS, CONDITION_SEVERITY_LABELS } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'

const LIMIT = 10

export default function PatientsView() {
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
      setError(err.message || 'تعذر تحميل المرضى')
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>سجل المرضى</h2><p>البحث والإدارة والاطلاع على السجلات الطبية</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ إضافة مريض جديد</button>
      </div>

      <div className="toolbar">
        <input className="input" placeholder="ابحث بالاسم أو الهاتف أو رقم الوثيقة..." value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text="جارِ تحميل المرضى" /> : rows.length === 0 ? <Empty text="لا توجد سجلات مرضى مطابقة" /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>المريض</th><th>الرقم الوطني</th><th>الهاتف</th><th>النوع</th><th>تاريخ الميلاد</th><th>تاريخ التسجيل</th><th>إجراءات</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.patient_id}>
                    <td><span className="table-avatar">{p.full_name?.[0] || 'م'}</span>{p.full_name}{p.is_shared ? <span className="badge shared-chip">مشترك</span> : null}</td>
                    <td dir="ltr">{p.national_id || '—'}</td>
                    <td dir="ltr">{p.phone}</td>
                    <td>{GENDER_LABELS[p.gender] || p.gender}</td>
                    <td>{fmtDate(p.date_of_birth, true)}</td>
                    <td>{fmtDate(p.created_at, true)}</td>
                    <td><button className="text-button" onClick={() => setSelected(p)}>الملف الكامل ←</button></td>
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

function AddPatientModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ full_name: '', document_type: 'NATIONAL_ID', document_number: '', national_id: '', phone: '', gender: 'MALE', date_of_birth: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.patients.create({ ...form, national_id: form.national_id || undefined })
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر حفظ بيانات المريض')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="إضافة مريض جديد" subtitle="سجل المرضى" onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="الاسم الكامل" required>
          <input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <div className="form-row">
          <Field label="نوع الوثيقة" required>
            <select value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })}>
              <option value="NATIONAL_ID">بطاقة شخصية</option>
              <option value="PASSPORT">جواز سفر</option>
              <option value="OTHER">أخرى</option>
            </select>
          </Field>
          <Field label="رقم الوثيقة" required><input required maxLength={100} value={form.document_number} onChange={(e) => setForm({ ...form, document_number: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="الرقم الوطني"><input value={form.national_id} onChange={(e) => setForm({ ...form, national_id: e.target.value })} /></Field>
          <Field label="رقم الهاتف" required><input required minLength={7} dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="الجنس" required>
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="MALE">ذكر</option><option value="FEMALE">أنثى</option>
            </select>
          </Field>
          <Field label="تاريخ الميلاد" required><input required type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></Field>
        </div>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ المريض'}</button>
        </div>
      </form>
    </Modal>
  )
}
function PatientDetailModal({ patient, user, onClose }) {
  const [tab, setTab] = useState('visits')
  return (
    <Modal title={patient.full_name} subtitle={`رقم الملف #${patient.patient_id}`} onClose={onClose} wide>
      <div className="detail-summary">
        <span>{GENDER_LABELS[patient.gender] || patient.gender}</span>
        <span dir="ltr">{patient.phone}</span>
        {patient.document_type ? <span>{DOCUMENT_TYPE_LABELS[patient.document_type] || patient.document_type}: <span dir="ltr">{patient.document_number}</span></span> : null}
        {patient.national_id ? <span dir="ltr">{patient.national_id}</span> : null}
        <span>{fmtDate(patient.date_of_birth, true)}</span>
      </div>
      <div className="tabs">
        <button className={tab === 'visits' ? 'tab active' : 'tab'} onClick={() => setTab('visits')}>الزيارات</button>
        <button className={tab === 'medical' ? 'tab active' : 'tab'} onClick={() => setTab('medical')}>البيانات الطبية</button>
        <button className={tab === 'record' ? 'tab active' : 'tab'} onClick={() => setTab('record')}>السجل الطبي الموحد</button>
        <button className={tab === 'shares' ? 'tab active' : 'tab'} onClick={() => setTab('shares')}>المشاركات</button>
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
      setError(err.message || 'تعذر تحميل البيانات الطبية')
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
      setError(err.message || 'تعذر حفظ البيانات الطبية')
    } finally { setSaving(false) }
  }

  if (loading) return <Loading text="جارِ تحميل البيانات الطبية" />

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="فصيلة الدم">
            <select value={extras.blood_type} disabled={!canEdit} onChange={(e) => setExtras({ ...extras, blood_type: e.target.value })}>
              <option value="">غير محددة</option>
              {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bt) => <option key={bt} value={bt}>{bt}</option>)}
            </select>
          </Field>
          <Field label="الأدوية الحالية" hint="الأدوية التي يتناولها المريض حالياً">
            <textarea rows="2" disabled={!canEdit} value={extras.current_medications} onChange={(e) => setExtras({ ...extras, current_medications: e.target.value })} />
          </Field>
        </div>

        <div className="med-section">
          <h4>الحساسيات</h4>
          <div className="med-grid">
            {ALLERGEN_KEYS.map((key) => (
              <div className="med-item" key={key}>
                <label className="med-check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(allergySel[key]?.checked)} onChange={(e) => setAllergySel({ ...allergySel, [key]: { ...allergySel[key], checked: e.target.checked } })} />
                  <span>{ALLERGEN_LABELS[key]}</span>
                </label>
                <input className="med-note" placeholder="نوع/تفاصيل (اختياري)" disabled={!canEdit || !allergySel[key]?.checked} value={allergySel[key]?.notes || ''} onChange={(e) => setAllergySel({ ...allergySel, [key]: { ...allergySel[key], notes: e.target.value } })} />
              </div>
            ))}
          </div>
        </div>

        <div className="med-section">
          <h4>الأمراض المزمنة</h4>
          <div className="med-grid">
            {CHRONIC_CONDITION_KEYS.map((key) => (
              <div className="med-item" key={key}>
                <label className="med-check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(condSel[key]?.checked)} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], checked: e.target.checked } })} />
                  <span>{CHRONIC_CONDITION_LABELS[key]}</span>
                </label>
                <select className="med-sev" disabled={!canEdit || !condSel[key]?.checked} value={condSel[key]?.severity || 'UNSPECIFIED'} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], severity: e.target.value } })} aria-label="شدة المرض">
                  {Object.entries(CONDITION_SEVERITY_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
                <input className="med-note" placeholder="تفاصيل (اختياري)" disabled={!canEdit || !condSel[key]?.checked} value={condSel[key]?.notes || ''} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], notes: e.target.value } })} />
              </div>
            ))}
          </div>
        </div>

        <Field label="ملاحظات طبية عامة">
          <textarea rows="3" disabled={!canEdit} value={extras.medical_notes} onChange={(e) => setExtras({ ...extras, medical_notes: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        {done && <Notice kind="success">تم حفظ البيانات الطبية بنجاح</Notice>}
        {canEdit ? (
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ البيانات الطبية'}</button>
          </div>
        ) : (
          <p className="profile-meta">عرض فقط — تعديل البيانات الطبية متاح للطبيب المعالج</p>
        )}
        {profile?.updated_at ? <p className="profile-meta">آخر تحديث: {fmtDateTime(profile.updated_at)}{profile.updated_by_name ? ` — بواسطة ${profile.updated_by_name}` : ''}</p> : null}
      </form>
    </div>
  )
}

function VisitsTab({ patient, user }) {
  const [visits, setVisits] = useState(null)
  const [doctors, setDoctors] = useState(null) // null = غير متاح
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await api.patients.visits(patient.patient_id)
      setVisits(result.visits || [])
    } catch (err) { setError(err.message); setVisits([]) }
  }, [patient.patient_id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    api.users.list({ limit: 100 })
      .then((result) => setDoctors((result.users || []).filter((u) => u.role_name === 'DOCTOR')))
      .catch(() => setDoctors([]))
  }, [])

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ تسجيل زيارة جديدة</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {visits === null ? <Loading /> : visits.length === 0 ? <Empty text="لا توجد زيارات مسجلة" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>العيادة</th><th>الطبيب</th><th>الملاحظات</th></tr></thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.visit_id}>
                  <td>{fmtDateTime(v.visit_date)}</td><td>{v.clinic_name || '—'}</td><td>{v.doctor_name || '—'}</td><td>{v.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showAdd && <AddVisitModal patient={patient} user={user} doctors={doctors} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddVisitModal({ patient, user, doctors, onClose, onSaved }) {
  const [form, setForm] = useState({
    clinic_id: user?.clinicId || '',
    doctor_id: '',
    notes: '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.patients.createVisit({
        patient_id: patient.patient_id,
        clinic_id: Number(form.clinic_id) || user?.clinicId,
        doctor_id: Number(form.doctor_id),
        notes: form.notes || undefined,
      })
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر تسجيل الزيارة')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={`تسجيل زيارة لـ ${patient.full_name}`} subtitle="الزيارات الطبية" onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="العيادة" required>
          <input type="number" required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })} />
        </Field>
        <Field label="الطبيب" required hint={doctors === null ? 'لم نتمكن من جلب قائمة الأطباء، أدخل رقم الطبيب يدوياً' : undefined}>
          {doctors && doctors.length > 0 ? (
            <select required value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}>
              <option value="">اختر الطبيب...</option>
              {doctors.map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
            </select>
          ) : (
            <input type="number" required placeholder="رقم الطبيب" value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })} />
          )}
        </Field>
        <Field label="الملاحظات"><textarea rows="3" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ الزيارة'}</button>
        </div>
      </form>
    </Modal>
  )
}
function MedicalRecordTab({ patient }) {
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.patients.record(patient.patient_id)
      .then((data) => { if (!cancelled) setRecord(data) })
      .catch((err) => setError(err.message || 'لا تملك صلاحية الوصول لهذا السجل'))
    return () => { cancelled = true }
  }, [patient.patient_id])

  if (error) return <Notice kind="error">{error}</Notice>
  if (!record) return <Loading text="جارِ تحميل السجل الطبي الموحد..." />

  return (
    <div className="tab-inner record-grid">
      <div className="record-block">
        <h4>الزيارات</h4>
        {record.visits?.length === 0 ? <Empty text="لا توجد زيارات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>العيادة</th><th>الطبيب</th><th>التاريخ</th><th>الملاحظات</th></tr></thead>
              <tbody>
                {record.visits.map((v) => (
                  <tr key={v.visit_id}><td>{v.clinic_name || '—'}</td><td>{v.doctor_name || '—'}</td><td>{fmtDateTime(v.visit_date)}</td><td>{v.notes || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>الروشتات الطبية</h4>
        {record.prescriptions?.length === 0 ? <Empty text="لا توجد روشتات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الطبيب</th><th>الملاحظات</th><th>التاريخ</th></tr></thead>
              <tbody>
                {record.prescriptions.map((rx) => (
                  <tr key={rx.prescription_id}><td>{rx.doctor_name || '—'}</td><td>{rx.notes || '—'}</td><td>{fmtDateTime(rx.created_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function SharesTab({ patient }) {
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
    if (!window.confirm('هل تريد إلغاء مشاركة هذا السجل؟')) return
    setDoing(true)
    try {
      await api.patients.revokeShare(patient.patient_id, shareId)
      await load()
    } catch (err) { setError(err.message) } finally { setDoing(false) }
  }

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ مشاركة جديدة</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {shares === null ? <Loading /> : shares.length === 0 ? <Empty text="لا توجد مشاركات" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>العيادة المستهدفة</th><th>المستوى</th><th>الحالة</th><th>انتهاء</th><th>إجراءات</th></tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.share_id}>
                  <td>{s.clinic_name || '—'}</td>
                  <td>{s.access_level === 'WRITE' ? 'قراءة وكتابة' : 'قراءة فقط'}</td>
                  <td>{s.status === 'ACTIVE' ? 'نشطة' : 'ملغاة'}</td>
                  <td>{fmtDate(s.expires_at)}</td>
                  <td>
                    {s.status === 'ACTIVE' ? (
                      <button className="text-button" onClick={() => revoke(s.share_id)} disabled={doing}>إلغاء المشاركة</button>
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
    <Modal title="مشاركة سجل طبي" subtitle="المشاركات" onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="رقم العيادة المستهدفة" required><input type="number" required value={form.target_clinic_id} onChange={(e) => setForm({ ...form, target_clinic_id: e.target.value })} /></Field>
        <Field label="مستوى الوصول" required>
          <select value={form.access_level} onChange={(e) => setForm({ ...form, access_level: e.target.value })}>
            <option value="READ">قراءة فقط</option><option value="WRITE">قراءة وكتابة</option>
          </select>
        </Field>
        <Field label="تاريخ الانتهاء" required><input type="date" required value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ المشاركة'}</button>
        </div>
      </form>
    </Modal>
  )
}