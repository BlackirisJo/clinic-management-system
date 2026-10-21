import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Field, Loading, Empty, Notice, Modal } from '../components/ui'
import { useT } from '../i18n'
import { useAuth } from '../auth/AuthContext'

const DAYS_OF_WEEK = [
  { index: 0, key: 'Sunday', labelKey: 'doctorSchedules.day.Sunday' },
  { index: 1, key: 'Monday', labelKey: 'doctorSchedules.day.Monday' },
  { index: 2, key: 'Tuesday', labelKey: 'doctorSchedules.day.Tuesday' },
  { index: 3, key: 'Wednesday', labelKey: 'doctorSchedules.day.Wednesday' },
  { index: 4, key: 'Thursday', labelKey: 'doctorSchedules.day.Thursday' },
  { index: 5, key: 'Friday', labelKey: 'doctorSchedules.day.Friday' },
  { index: 6, key: 'Saturday', labelKey: 'doctorSchedules.day.Saturday' },
]

// بداية الأسبوع (الأحد) من تاريخ معطى
const startOfWeek = (date) => {
  const result = new Date(date)
  result.setDate(result.getDate() - result.getDay())
  return result
}
const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export default function DoctorSchedulesView() {
  const t = useT()
  const { user } = useAuth()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const [schedules, setSchedules] = useState([])
  const [doctors, setDoctors] = useState([])
  const [clinics, setClinics] = useState([])
  const [filters, setFilters] = useState({ doctor_id: '', clinic_id: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [impactPrompt, setImpactPrompt] = useState(null)
  const [markers, setMarkers] = useState({ holidays: [], leave: [] })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {}
      if (filters.doctor_id) params.doctor_id = filters.doctor_id
      if (filters.clinic_id) params.clinic_id = filters.clinic_id
      const result = await api.doctorSchedules.list(params)
      setSchedules(result.schedules || [])
    } catch (err) {
      setError(err.message || t('doctorSchedules.error.load'))
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { load() }, [load])

  // عطل وإجازات الأسبوع الحالي للطبيب/العيادة المحددَين — علامات مباشرة
  // على ما الذي لا يمكن الحجز فيه.
  const loadMarkers = useCallback(async () => {
    const weekStart = startOfWeek(new Date())
    const from = isoDate(weekStart)
    const to = isoDate(new Date(weekStart.getTime() + 6 * 86400000))
    try {
      const params = { from, to }
      if (filters.clinic_id) params.clinic_id = filters.clinic_id
      if (filters.doctor_id) params.doctor_id = filters.doctor_id
      const [holidayResult, leaveResult] = await Promise.all([
        api.holidays.list(params),
        api.doctorLeave.list(params),
      ])
      setMarkers({
        holidays: holidayResult.holidays || [],
        leave: leaveResult.leave || leaveResult.leaves || [],
      })
    } catch {
      setMarkers({ holidays: [], leave: [] })
    }
  }, [filters])

  useEffect(() => { loadMarkers() }, [loadMarkers])

  useEffect(() => {
    async function loadInitial() {
      try {
        const clinicResult = await api.clinics.directory()
        const allClinics = clinicResult.clinics || []
        if (isGlobal) {
          setClinics(allClinics)
        } else {
          const myIds = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
          setClinics(allClinics.filter(c => myIds.includes(Number(c.clinic_id))))
        }
        const docResult = await api.users.doctors()
        setDoctors(docResult.doctors || [])
      } catch (err) {
        setError(err.message)
      }
    }
    loadInitial()
  }, [isGlobal, user])

  async function deleteSchedule(id) {
    if (!confirm(t('doctorSchedules.deleteConfirm'))) return
    try {
      await api.doctorSchedules.delete(id)
      await load()
    } catch (err) {
      setError(err.message || t('doctorSchedules.deleteError'))
    }
  }

  // تعديل نافذة العمل قد يخرج مواعيد قائمة منها: الخادم يرفض (409) ويعرض
  // الأثر، ولا يُطبَّق التعديل إلا بتأكيد صريح.
  async function saveSchedule(payload, id) {
    setError('')
    try {
      await api.doctorSchedules.update(id, payload)
      setEditing(null)
      setImpactPrompt(null)
      await load()
      return true
    } catch (err) {
      if (err.code === 'IMPACT_CONFIRMATION_REQUIRED') {
        setEditing(null)
        setImpactPrompt({ payload, id, impact: err.impact })
        return false
      }
      setError(err.message || t('doctorSchedules.form.error'))
      return false
    }
  }

  async function confirmImpact() {
    if (!impactPrompt) return
    const { payload, id } = impactPrompt
    try {
      await api.doctorSchedules.update(id, { ...payload, confirm_impact: true })
      setImpactPrompt(null)
      await load()
    } catch (err) {
      setError(err.message || t('doctorSchedules.form.error'))
      setImpactPrompt(null)
    }
  }

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('doctorSchedules.title')}</h2><p>{t('doctorSchedules.subtitle')}</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('doctorSchedules.add')}</button>
      </div>

      <div className="toolbar">
        <select className="input" value={filters.clinic_id} onChange={e => { setFilters({ ...filters, clinic_id: e.target.value }); }}>
          <option value="">{t('doctorSchedules.selectClinic')}</option>
          {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
        </select>
        <select className="input" value={filters.doctor_id} onChange={e => { setFilters({ ...filters, doctor_id: e.target.value }); }}>
          <option value="">{t('doctorSchedules.selectDoctor')}</option>
          {doctors.map(d => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
        </select>
      </div>

      <Notice kind="error">{error}</Notice>

      <div className="panel-heading">
        <div><h3>{t('doctorSchedules.calendarMarkers')}</h3></div>
      </div>
      {markers.holidays.length === 0 && markers.leave.length === 0 ? (
        <p className="muted-text">{t('doctorSchedules.noCalendarMarkers')}</p>
      ) : (
        <div className="toolbar">
          {markers.holidays.map(holiday => (
            <span key={`h-${holiday.holiday_id}`} className="chip chip-holiday" title={holiday.name_ar}>
              {String(holiday.holiday_date).slice(0, 10)} — {holiday.name_ar}
            </span>
          ))}
          {markers.leave.map(record => (
            <span key={`l-${record.leave_id}`} className="chip chip-warn" title={record.reason || ''}>
              {String(record.start_date).slice(0, 10)} → {String(record.end_date).slice(0, 10)}
            </span>
          ))}
        </div>
      )}

      {loading ? <Loading text={t('doctorSchedules.loading')} /> : schedules.length === 0 ? <Empty text={t('doctorSchedules.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead>
              <tr><th>{t('doctorSchedules.table.doctor')}</th><th>{t('doctorSchedules.table.clinic')}</th><th>{t('doctorSchedules.table.day')}</th><th>{t('doctorSchedules.table.startTime')}</th><th>{t('doctorSchedules.table.endTime')}</th><th>{t('doctorSchedules.table.status')}</th><th>{t('doctorSchedules.table.actions')}</th></tr>
            </thead>
            <tbody>
              {schedules.map(s => {
                const day = DAYS_OF_WEEK.find(d => d.index === s.day_of_week)
                return (
                  <tr key={s.schedule_id}>
                    <td>{s.doctor_name}</td>
                    <td>{s.clinic_name}</td>
                    <td>{day ? t(day.labelKey) : s.day_of_week}</td>
                    <td dir="ltr">{s.start_time?.slice(0,5)}</td>
                    <td dir="ltr">{s.end_time?.slice(0,5)}</td>
                    <td>{s.is_working_day ? t('doctorSchedules.working') : t('doctorSchedules.nonWorking')}</td>
                    <td>
                      <button className="secondary-button compact" onClick={() => setEditing(s)}>{t('doctorSchedules.edit')}</button>
                      <button className="secondary-button compact" onClick={() => deleteSchedule(s.schedule_id)}>{t('common.delete') || 'Delete'}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <ScheduleForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} doctors={doctors} clinics={clinics} />}
      {editing && (
        <ScheduleForm
          title={t('doctorSchedules.form.editTitle')}
          schedule={editing}
          onClose={() => setEditing(null)}
          onSubmit={(payload) => saveSchedule(payload, editing.schedule_id)}
          onSaved={() => { setEditing(null); load() }}
          doctors={doctors}
          clinics={clinics}
        />
      )}
      {impactPrompt && (
        <Modal title={t('doctorSchedules.impactTitle')} onClose={() => setImpactPrompt(null)}>
          <p>{t('doctorSchedules.impactBody')}</p>
          <p>
            {t('doctorSchedules.impactAppointments')}: {impactPrompt.impact?.appointments?.length ?? 0}
          </p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setImpactPrompt(null)}>{t('doctorSchedules.impactCancel')}</button>
            <button className="primary-button" onClick={confirmImpact}>{t('doctorSchedules.impactConfirm')}</button>
          </div>
        </Modal>
      )}
    </section>
  )
}

function ScheduleForm({ onClose, onSaved, onSubmit, doctors, clinics, schedule, title }) {
  const t = useT()
  const [form, setForm] = useState({
    doctor_id: schedule ? String(schedule.doctor_id) : '',
    clinic_id: schedule ? String(schedule.clinic_id) : '',
    day_of_week: schedule ? String(schedule.day_of_week) : '1',
    start_time: schedule ? String(schedule.start_time).slice(0, 5) : '09:00',
    end_time: schedule ? String(schedule.end_time).slice(0, 5) : '17:00',
    is_working_day: schedule ? !!schedule.is_working_day : true
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const payload = {
      doctor_id: Number(form.doctor_id),
      clinic_id: Number(form.clinic_id),
      day_of_week: Number(form.day_of_week),
      start_time: form.start_time,
      end_time: form.end_time,
      is_working_day: form.is_working_day
    }
    try {
      if (onSubmit) {
        // التعديل: عند رفض الخادم (409) لوجود أثر، يتولّى المكوّن الأعلى عرض الأثر
        const ok = await onSubmit(payload)
        if (!ok) return
      } else {
        await api.doctorSchedules.create(payload)
      }
      onSaved()
    } catch (err) {
      setError(err.message || t('doctorSchedules.form.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={title || t('doctorSchedules.form.title')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('doctorSchedules.form.clinic')}>
          <select required value={form.clinic_id} onChange={e => setForm({...form, clinic_id: e.target.value})}>
            <option value="">{t('doctorSchedules.selectClinic')}</option>
            {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
          </select>
        </Field>
        <Field label={t('doctorSchedules.form.doctor')}>
          <select required value={form.doctor_id} onChange={e => setForm({...form, doctor_id: e.target.value})}>
            <option value="">{t('doctorSchedules.selectDoctor')}</option>
            {doctors.map(d => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
          </select>
        </Field>
        <Field label={t('doctorSchedules.form.day')}>
          <select value={form.day_of_week} onChange={e => setForm({...form, day_of_week: e.target.value})}>
            {DAYS_OF_WEEK.map(d => <option key={d.index} value={d.index}>{t(d.labelKey)}</option>)}
          </select>
        </Field>
        <div className="form-row">
          <Field label={t('doctorSchedules.form.startTime')}><input type="time" value={form.start_time} onChange={e => setForm({...form, start_time: e.target.value})} /></Field>
          <Field label={t('doctorSchedules.form.endTime')}><input type="time" value={form.end_time} onChange={e => setForm({...form, end_time: e.target.value})} /></Field>
        </div>
        <label style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
          <input type="checkbox" checked={form.is_working_day} onChange={e => setForm({...form, is_working_day: e.target.checked})} />
          {t('doctorSchedules.form.isWorkingDay')}
        </label>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('doctorSchedules.form.saving') : t('doctorSchedules.form.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
