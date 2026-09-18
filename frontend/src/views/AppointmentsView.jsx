import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtTime, fmtDate, APPOINTMENT_STATUS } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'
import { PatientSearchSelect } from '../components/SearchSelect'
import { useT } from '../i18n'


const LIMIT = 10
const ALL_STATUS = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']

export default function AppointmentsView() {
  const [rows, setRows] = useState([])
  const [filters, setFilters] = useState({ date: '', status: '' })
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.appointments.list({ ...filters, page, limit: LIMIT })
      setRows(result.appointments || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل المواعيد')
    } finally {
      setLoading(false)
    }
  }, [filters, page])

  useEffect(() => { load() }, [load])

  async function changeStatus(appointmentId, status) {
    try {
      await api.appointments.updateStatus(appointmentId, { status })
      await load()
    } catch (err) {
      setError(err.message || 'تعذر تحديث حالة الموعد')
    }
  }

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>جدول المواعيد</h2><p>حجز وتصفية وتحديث حالات المواعيد</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ حجز موعد جديد</button>
      </div>

      <div className="toolbar">
        <input type="date" className="input" value={filters.date}
          onChange={(e) => { setFilters({ ...filters, date: e.target.value }); setPage(1) }} />
        <select className="input" value={filters.status}
          onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1) }}>
          <option value="">كل الحالات</option>
          {ALL_STATUS.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS[s]?.label || s}</option>)}
        </select>
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text="جارِ تحميل المواعيد" /> : rows.length === 0 ? <Empty text="لا توجد مواعيد مطابقة" /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr><th>التاريخ</th><th>الوقت</th><th>المريض</th><th>الطبيب</th><th>العيادة</th><th>السبب</th><th>الحالة</th><th>تحديث الحالة</th></tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const st = APPOINTMENT_STATUS[a.status] || APPOINTMENT_STATUS.SCHEDULED
                  return (
                    <tr key={a.appointment_id}>
                      <td>{fmtDate(a.appointment_date)}</td>
                      <td dir="ltr" data-label="الوقت">{fmtTime(a.start_time)} - {fmtTime(a.end_time)}</td>
                      <td data-label="المريض">{a.patient_name || `مريض #${a.patient_id}`}</td>
                      <td data-label="الطبيب">{a.doctor_name || '—'}</td>
                      <td data-label="العيادة">{a.clinic_name || '—'}</td>
                      <td data-label="السبب">{a.reason || '—'}</td>
                      <td data-label="الحالة"><span className={`status ${st.cls}`}>{st.label}</span></td>
                      <td className="cell-actions">
                        <select value="" onChange={(e) => e.target.value && changeStatus(a.appointment_id, e.target.value)} className="input" aria-label="تحديث حالة الموعد">
                          <option value="">تحديث...</option>
                          {ALL_STATUS.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS[s]?.label || s}</option>)}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} />
        </>
      )}

      {showAdd && <AppointmentForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
    </section>
  )
}

function AppointmentForm({ onClose, onSaved }) {
  const { user } = useAuth()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const [form, setForm] = useState({
    clinic_id: '',
    patient_id: '',
    doctor_id: '',
    appointment_date: '',
    start_time: '',
    end_time: '',
    reason: '',
    notes: '',
  })
  const [doctors, setDoctors] = useState([])
  const [clinics, setClinics] = useState([])
  const [loadingDoctors, setLoadingDoctors] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // دالة تحميل الأطباء لعيادة محددة
  async function loadDoctorsForClinic(clinicId) {
    if (!clinicId) {
      setDoctors([])
      return
    }
    setLoadingDoctors(true)
    try {
      const result = await api.users.doctors({ clinic_id: Number(clinicId) })
      setDoctors(result.doctors || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل الأطباء')
      setDoctors([])
    } finally {
      setLoadingDoctors(false)
    }
  }

  // تحميل العيادات والمرضى عند فتح النموذج
  useEffect(() => {
    async function loadInitialData() {
      setClinics([])
      setDoctors([])
      try {
        // كل العيادات بالاسم من الدليل العام — المدير يختار أي عيادة، والموظف تُعرض له عيادته بالاسم
        const clinicResult = await api.clinics.directory()
        const allClinics = clinicResult.clinics || []
        if (isGlobal) {
          setClinics(allClinics)
          setForm(prev => ({ ...prev, clinic_id: '' }))
          loadDoctorsForClinic('')
        } else {
          // الموظف: قيّد الخيارات على العيادات المسندة إليه فقط (الأساسية + الإسنادات الإضافية clinic_staff)
          // عيادة واحدة → حقل ثابت؛ أكثر من عيادة → قائمة اختيار من عياداته فقط
          const myIds = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
          const mine = allClinics.filter((c) => myIds.includes(Number(c.clinic_id)))
          if (mine.length > 0) {
            setClinics(mine)
            const preferred = mine.find((c) => Number(c.clinic_id) === Number(user?.clinicId)) || mine[0]
            setForm(prev => ({ ...prev, clinic_id: String(preferred.clinic_id) }))
            loadDoctorsForClinic(String(preferred.clinic_id))
          } else if (user?.clinicId) {
            // لا عيادة مُطابقة في الدليل — اعرض العيادة الأساسية باسم افتراضي
            setClinics([{ clinic_id: user.clinicId, clinic_name: `العيادة #${user.clinicId}`, specialty_name: undefined }])
            setForm(prev => ({ ...prev, clinic_id: String(user.clinicId) }))
            loadDoctorsForClinic(String(user.clinicId))
          } else {
            setClinics(allClinics)
            setForm(prev => ({ ...prev, clinic_id: '' }))
            loadDoctorsForClinic('')
          }
        }
        // المرضى يُبحثون من جهة الخادم داخل PatientSearchSelect (لا تحميل مسبق لأول 100 فقط)
      } catch (err) {
        setError(err.message || 'تعذر تحميل البيانات')
        setClinics([])
      }
    }
    loadInitialData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // عند تغيير العيادة
  function handleClinicChange(clinicId) {
    setForm(prev => ({ ...prev, clinic_id: clinicId, doctor_id: '' }))
    loadDoctorsForClinic(clinicId)
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.appointments.create({
        clinic_id: Number(form.clinic_id),
        patient_id: Number(form.patient_id),
        doctor_id: Number(form.doctor_id),
        appointment_date: form.appointment_date,
        start_time: form.start_time || undefined,
        end_time: form.end_time || undefined,
        reason: form.reason || undefined,
        notes: form.notes || undefined,
      })
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر حجز الموعد')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="حجز موعد جديد" subtitle="المواعيد" onClose={onClose} wide>
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="العيادة" required hint={isGlobal ? 'اختر العيادة بالاسم لتصفية الأطباء' : clinics.length > 1 ? 'عياداتك المسندة — اختر عيادة المواجهة' : 'عيادتك الحالية'}>
            {isGlobal ? (
              <select required value={form.clinic_id} onChange={(e) => handleClinicChange(e.target.value)}>
                <option value="">اختر العيادة بالاسم...</option>
                {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
              </select>
            ) : clinics.length > 1 ? (
              <select required value={form.clinic_id} onChange={(e) => handleClinicChange(e.target.value)}>
                {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
              </select>
            ) : clinics.length === 0 ? (
              <input type="text" readOnly value="" />
            ) : (
              <input type="text" readOnly value={clinics[0].clinic_name} />
            )}
          </Field>
          <Field label="المريض" required>
            <PatientSearchSelect value={form.patient_id} onChange={(id) => setForm(prev => ({ ...prev, patient_id: id }))} required />
          </Field>
        </div>
        <Field label="الطبيب" required hint={loadingDoctors ? 'جارِ تحميل الأطباء...' : doctors.length === 0 ? 'لا يوجد أطباء في هذه العيادة' : undefined}>
          <select required value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })} disabled={loadingDoctors || doctors.length === 0}>
            <option value="">{loadingDoctors ? 'جارِ التحميل...' : doctors.length === 0 ? 'لا يوجد أطباء' : 'اختر الطبيب...'}</option>
            {doctors.map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}{d.sub_specialty ? ` (${d.sub_specialty})` : ''}</option>)}
          </select>
        </Field>
        <div className="form-row">
          <Field label="التاريخ" required><input type="date" required value={form.appointment_date} onChange={(e) => setForm({ ...form, appointment_date: e.target.value })} /></Field>
          <Field label="وقت البدء (اختياري)"><input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} /></Field>
          <Field label="وقت النهاية (اختياري)"><input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} /></Field>
        </div>
        <Field label="السبب"><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        <Field label="ملاحظات"><textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحجز...' : 'حجز الموعد'}</button>
        </div>
      </form>
    </Modal>
  )
}
