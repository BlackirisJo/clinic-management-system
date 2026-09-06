import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { fmtTime, fmtDate, APPOINTMENT_STATUS } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'

const LIMIT = 10
const ALL_STATUS = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']

export default function AppointmentsView() {
  const { user } = useAuth()
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
      {loading ? <Loading text="جارِ تثميل المواعيد" /> : rows.length === 0 ? <Empty text="لا توجد مواعيد مطابقة" /> : (
        <>
          <div className="table-wrap">
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
                      <td dir="ltr">{fmtTime(a.start_time)} - {fmtTime(a.end_time)}</td>
                      <td>{a.patient_name || `مريض #${a.patient_id}`}</td>
                      <td>{a.doctor_name || '—'}</td>
                      <td>{a.clinic_name || '—'}</td>
                      <td>{a.reason || '—'}</td>
                      <td><span className={`status ${st.cls}`}>{st.label}</span></td>
                      <td className="nowrap">
                        <select value="" onChange={(e) => e.target.value && changeStatus(a.appointment_id, e.target.value)} className="mini-select">
                          <option value="">تغيير...</option>
                          {ALL_STATUS.filter((s) => s !== a.status).map((s) => (
                            <option key={s} value={s}>{APPOINTMENT_STATUS[s]?.label || s}</option>
                          ))}
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

      {showAdd && <CreateAppointmentModal user={user} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
    </section>
  )
}
function CreateAppointmentModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({
    clinic_id: user?.clinicId || '',
    patient_id: '',
    doctor_id: '',
    appointment_date: '',
    start_time: '',
    end_time: '',
    reason: '',
    notes: '',
  })
  const [patients, setPatients] = useState([])
  const [doctors, setDoctors] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const isGlobal = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user?.roleName)

  useEffect(() => {
    api.patients.list({ limit: 100 })
      .then((r) => setPatients(r.patients || []))
      .catch(() => setPatients([]))
    api.users.doctors()
      .then((r) => setDoctors(r.doctors || []))
      .catch(() => setDoctors([]))
  }, [])

  // عند اختيار الطبيب تُعتمد عيادته تلقائياً (مهم لمدير النظام متعدد العيادات)
  function selectDoctor(doctorId) {
    const doctor = (doctors || []).find((d) => d.user_id === Number(doctorId))
    setForm((prev) => ({ ...prev, doctor_id: doctorId, clinic_id: doctor?.clinic_id || prev.clinic_id }))
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.appointments.create({
        clinic_id: Number(form.clinic_id) || user?.clinicId,
        patient_id: Number(form.patient_id),
        doctor_id: Number(form.doctor_id),
        appointment_date: form.appointment_date,
        start_time: form.start_time,
        end_time: form.end_time,
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
          <Field label="العيادة" required hint="تُحدَّد تلقائياً حسب عيادة الطبيب المختار">
            <input required value={form.clinic_id} readOnly />
          </Field>
          <Field label="المريض" required>
            <select required value={form.patient_id} onChange={(e) => setForm({ ...form, patient_id: e.target.value })}>
              <option value="">اختر المريض...</option>
              {patients.map((p) => <option key={p.patient_id} value={p.patient_id}>{p.full_name} {p.phone ? `(${p.phone})` : ''}</option>)}
            </select>
          </Field>
        </div>
        <Field label="الطبيب" required hint={doctors !== null && doctors.length === 0 ? 'لا يوجد أطباء نشطون في العيادة بعد' : undefined}>
          {doctors === null ? (
            <select disabled><option>جارِ تحميل الأطباء...</option></select>
          ) : doctors.length > 0 ? (
            <select required value={form.doctor_id} onChange={(e) => selectDoctor(e.target.value)}>
              <option value="">اختر الطبيب...</option>
              {doctors.map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}{isGlobal && d.clinic_name ? ` — ${d.clinic_name}` : ''}</option>)}
            </select>
          ) : (
            <input type="number" required placeholder="رقم الطبيب" value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })} />
          )}
        </Field>
        <div className="form-row">
          <Field label="التاريخ" required><input type="date" required value={form.appointment_date} onChange={(e) => setForm({ ...form, appointment_date: e.target.value })} /></Field>
          <Field label="وقت البدء" required><input type="time" required value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} /></Field>
          <Field label="وقت النهاية" required><input type="time" required value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} /></Field>
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