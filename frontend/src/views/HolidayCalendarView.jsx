import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { Field, Loading, Empty, Notice, Modal } from '../components/ui'
import { useT } from '../i18n'
import { useAuth } from '../auth/AuthContext'

// تقويم العطل الرسمية: عرض شهري، إدارة العطل، استثناءات العمل، ومهام التواصل.
//
// قاعدة العرض: العطل Nacional يظهر في كل عيادات الشبكة، والعطل العيادي في عيادته.
// أي تغيير على تاريخ عطلة يمر أولاً بمعاينة الأثر: إن كان التاريخ الجديد يصطدم
// بمواعيد قائمة يرفض الخادم التغيير (409) حتى يؤكد المستخدم الأثر صراحةً.

const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export default function HolidayCalendarView() {
  const t = useT()
  const { user } = useAuth()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const canManage = isGlobal || (user?.permissions || []).includes('MANAGE_HOLIDAYS')
  const canApprove = isGlobal || (user?.permissions || []).includes('APPROVE_HOLIDAYS')
  const canManageExceptions = isGlobal || (user?.permissions || []).includes('MANAGE_WORK_EXCEPTIONS')
  const canApproveExceptions = isGlobal || (user?.permissions || []).includes('APPROVE_WORK_EXCEPTIONS')

  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [clinics, setClinics] = useState([])
  const [clinicFilter, setClinicFilter] = useState('')
  const [holidays, setHolidays] = useState([])
  const [exceptions, setExceptions] = useState([])
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [pendingImpact, setPendingImpact] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [holidayResult, exceptionResult, taskResult] = await Promise.all([
        api.holidays.list({ from: `${month}-01`, to: `${month}-31`, clinic_id: clinicFilter || undefined }),
        api.workExceptions.list({ from: `${month}-01`, to: `${month}-31`, clinic_id: clinicFilter || undefined }),
        api.calendar.notifications({ status: 'PENDING_CONTACT' }),
      ])
      setHolidays(holidayResult.holidays || [])
      setExceptions(exceptionResult.exceptions || [])
      setTasks(taskResult.notifications || [])
    } catch (err) {
      setError(err.message || t('calendar.loading'))
    } finally {
      setLoading(false)
    }
  }, [month, clinicFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    async function loadClinics() {
      try {
        const result = await api.clinics.directory()
        const all = result.clinics || []
        if (isGlobal) setClinics(all)
        else {
          const myIds = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
          setClinics(all.filter(c => myIds.includes(Number(c.clinic_id))))
        }
      } catch {
        setClinics([])
      }
    }
    loadClinics()
  }, [isGlobal, user])

  const days = useMemo(() => buildMonthGrid(month), [month])
  const holidayByDate = useMemo(() => {
    const map = new Map()
    for (const holiday of holidays) {
      const key = String(holiday.holiday_date).slice(0, 10)
      map.set(key, [...(map.get(key) || []), holiday])
    }
    return map
  }, [holidays])

  const shiftMonth = (delta) => {
    const [year, monthNumber] = month.split('-').map(Number)
    const date = new Date(year, monthNumber - 1 + delta, 1)
    setMonth(monthKey(date))
  }

  async function saveHoliday(payload, id) {
    if (id) return api.holidays.update(id, payload)
    return api.holidays.create(payload)
  }

  // تغيير التاريخ قد يصطدم بمواعيد قائمة: الخادم يرفض (409) حتى يؤكد المستخدم.
  async function submitHoliday(payload, id) {
    setError('')
    setNotice('')
    try {
      await saveHoliday(payload, id)
      setEditing(null)
      setShowAdd(false)
      setPendingImpact(null)
      setNotice(t('calendar.impact.noChange') === '' ? '' : t('calendar.form.save'))
      await load()
    } catch (err) {
      if (err.code === 'IMPACT_CONFIRMATION_REQUIRED') {
        setPendingImpact({ payload, id, impact: err.impact || err.message })
        setEditing(null)
        setShowAdd(false)
        return
      }
      setError(err.message || t('calendar.form.error'))
    }
  }

  async function confirmImpact() {
    if (!pendingImpact) return
    const { payload, id, impact } = pendingImpact
    try {
      await saveHoliday({ ...payload, confirm_impact: true }, id)
      setPendingImpact(null)
      setNotice(
        impact?.to?.appointment_count
          ? `${t('calendar.impact.title')} — ${t('calendar.notifications.pending')}`
          : t('calendar.form.save')
      )
      await load()
    } catch (err) {
      setError(err.message || t('calendar.form.error'))
      setPendingImpact(null)
    }
  }

  async function cancelHoliday(holiday) {
    const reason = window.prompt(t('calendar.cancelReason'))
    if (!reason) return
    try {
      await api.holidays.cancel(holiday.holiday_id, { reason })
      await load()
    } catch (err) {
      setError(err.message || t('calendar.form.error'))
    }
  }

  async function decideException(exception, status) {
    try {
      await api.workExceptions.decide(exception.exception_id, { status })
      await load()
    } catch (err) {
      setError(err.message || t('calendar.exceptions.approveError'))
    }
  }

  const monthLabel = useMemo(() => {
    const [year, monthNumber] = month.split('-').map(Number)
    return new Date(year, monthNumber - 1, 1).toLocaleDateString('ar', { month: 'long', year: 'numeric' })
  }, [month])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div>
          <h2>{t('calendar.title')}</h2>
          <p>{t('calendar.subtitle')}</p>
        </div>
        {canManage && (
          <button className="primary-button compact" onClick={() => { setEditing(null); setShowAdd(true) }}>
            {t('calendar.add')}
          </button>
        )}
      </div>

      <div className="toolbar">
        <button className="secondary-button compact" onClick={() => shiftMonth(-1)}>{t('calendar.prev')}</button>
        <strong>{monthLabel}</strong>
        <button className="secondary-button compact" onClick={() => shiftMonth(1)}>{t('calendar.next')}</button>
        <button className="secondary-button compact" onClick={() => setMonth(monthKey(new Date()))}>{t('calendar.today')}</button>
        <select className="input" value={clinicFilter} onChange={e => setClinicFilter(e.target.value)}>
          <option value="">{t('calendar.scope.national')}</option>
          {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
        </select>
      </div>

      <Notice kind="error">{error}</Notice>
      <Notice kind="success">{notice}</Notice>

      {pendingImpact && (
        <div className="notice error">
          <strong>{t('calendar.impact.confirmRequired')}</strong>
          <ImpactSummary impact={pendingImpact.impact} />
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setPendingImpact(null)}>{t('calendar.impact.cancel')}</button>
            <button className="primary-button" onClick={confirmImpact}>{t('calendar.impact.confirm')}</button>
          </div>
        </div>
      )}

      {loading ? <Loading text={t('calendar.loading')} /> : (
        <>
          <div className="calendar-grid" dir="rtl">
            {WEEKDAYS_AR.map(day => <div key={day} className="calendar-grid-head">{day}</div>)}
            {days.map(cell => {
              const dayHolidays = holidayByDate.get(cell.iso) || []
              return (
                <div key={cell.iso} className={`calendar-cell ${cell.inMonth ? '' : 'muted'}`}>
                  <span className="calendar-day-number">{cell.date.getDate()}</span>
                  {dayHolidays.map(holiday => (
                    <span
                      key={holiday.holiday_id}
                      className={`chip small ${holiday.status === 'CANCELLED' ? 'chip-warn' : 'chip-holiday'}`}
                      title={holiday.name_ar}
                    >
                      {holiday.name_ar}
                    </span>
                  ))}
                </div>
              )
            })}
          </div>

          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>{t('calendar.table.date')}</th>
                  <th>{t('calendar.table.name')}</th>
                  <th>{t('calendar.table.scope')}</th>
                  <th>{t('calendar.table.type')}</th>
                  <th>{t('calendar.table.status')}</th>
                  <th>{t('calendar.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {holidays.length === 0 ? (
                  <tr><td colSpan={6}><Empty text={t('calendar.empty')} /></td></tr>
                ) : holidays.map(holiday => (
                  <tr key={holiday.holiday_id}>
                    <td dir="ltr">{String(holiday.holiday_date).slice(0, 10)}</td>
                    <td>{holiday.name_ar}</td>
                    <td>{holiday.clinic_id ? t('calendar.scope.clinic') : t('calendar.scope.national')}</td>
                    <td>{t(`calendar.type.${holiday.holiday_type}`)}</td>
                    <td>
                      <span className={`chip ${holiday.status === 'CANCELLED' ? 'chip-warn' : ''}`}>
                        {t(`calendar.status.${holiday.status}`)}
                      </span>
                    </td>
                    <td>
                      {canManage && holiday.status === 'ACTIVE' && (
                        <button className="secondary-button compact" onClick={() => { setEditing(holiday); setShowAdd(false) }}>
                          {t('calendar.move')}
                        </button>
                      )}
                      {canApprove && holiday.status === 'ACTIVE' && (
                        <button className="secondary-button compact" onClick={() => cancelHoliday(holiday)}>
                          {t('calendar.cancelHoliday')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-heading">
            <div><h3>{t('calendar.exceptions.title')}</h3></div>
            {canManageExceptions && <ExceptionForm clinics={clinics} onSubmit={async (payload) => {
              try {
                await api.workExceptions.create(payload)
                await load()
              } catch (err) {
                setError(err.message || t('calendar.exceptions.form.error'))
              }
            }} />}
          </div>

          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>{t('calendar.table.date')}</th>
                  <th>{t('calendar.exceptions.form.doctor')}</th>
                  <th>{t('calendar.exceptions.form.reason')}</th>
                  <th>{t('calendar.table.status')}</th>
                  <th>{t('calendar.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.length === 0 ? (
                  <tr><td colSpan={5}><Empty text={t('calendar.exceptions.empty')} /></td></tr>
                ) : exceptions.map(exception => (
                  <tr key={exception.exception_id}>
                    <td dir="ltr">{String(exception.exception_date).slice(0, 10)}</td>
                    <td>{exception.doctor_name}</td>
                    <td>{exception.reason}</td>
                    <td><span className="chip">{t(`calendar.status.${exception.status}`)}</span></td>
                    <td>
                      {canApproveExceptions && exception.status === 'PENDING' && (
                        <button className="secondary-button compact" onClick={() => decideException(exception, 'APPROVED')}>
                          {t('calendar.exceptions.approve')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-heading">
            <div><h3>{t('calendar.notifications.title')}</h3><p>{t('calendar.notifications.notice')}</p></div>
          </div>
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>{t('calendar.table.date')}</th>
                  <th>{t('calendar.table.name')}</th>
                  <th>{t('calendar.table.status')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 ? (
                  <tr><td colSpan={3}><Empty text={t('calendar.notifications.empty')} /></td></tr>
                ) : tasks.map(task => (
                  <tr key={task.notification_id}>
                    <td dir="ltr">{String(task.appointment_date || '').slice(0, 10)}</td>
                    <td>{task.note || task.patient_name || `#${task.appointment_id}`}</td>
                    <td><span className="chip chip-warn">{t('calendar.notifications.pending')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showAdd && (
        <HolidayForm
          title={t('calendar.form.title')}
          clinics={clinics}
          onClose={() => setShowAdd(false)}
          onSubmit={submitHoliday}
        />
      )}
      {editing && (
        <HolidayForm
          title={t('calendar.form.editTitle')}
          clinics={clinics}
          holiday={editing}
          onClose={() => setEditing(null)}
          onSubmit={submitHoliday}
        />
      )}
    </section>
  )
}

function ImpactSummary({ impact }) {
  const t = useT()
  if (!impact) return null
  const from = impact.from || {}
  const to = impact.to || {}
  return (
    <ul className="plain-list">
      <li>{t('calendar.impact.clinics')}: {from.clinic_count ?? to.clinic_count ?? 0}</li>
      <li>{t('calendar.impact.doctors')}: {from.doctor_count ?? to.doctor_count ?? 0}</li>
      <li>{t('calendar.impact.appointments')}: {to.appointment_count ?? 0}</li>
    </ul>
  )
}

function HolidayForm({ title, clinics, holiday, onClose, onSubmit }) {
  const t = useT()
  const [form, setForm] = useState({
    holiday_date: holiday ? String(holiday.holiday_date).slice(0, 10) : '',
    name_ar: holiday?.name_ar || '',
    name_en: holiday?.name_en || '',
    clinic_id: holiday ? (holiday.clinic_id || '') : '',
    holiday_type: holiday?.holiday_type || 'OFFICIAL',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onSubmit({
        holiday_date: form.holiday_date,
        name_ar: form.name_ar,
        name_en: form.name_en || null,
        clinic_id: form.clinic_id === '' ? null : Number(form.clinic_id),
        holiday_type: form.holiday_type,
      }, holiday?.holiday_id)
    } catch (err) {
      setError(err.message || t('calendar.form.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('calendar.form.date')} required>
          <input type="date" required value={form.holiday_date} onChange={e => setForm({ ...form, holiday_date: e.target.value })} />
        </Field>
        <Field label={t('calendar.form.name')} required>
          <input required value={form.name_ar} onChange={e => setForm({ ...form, name_ar: e.target.value })} />
        </Field>
        <Field label={t('calendar.form.nameEn')}>
          <input dir="ltr" value={form.name_en} onChange={e => setForm({ ...form, name_en: e.target.value })} />
        </Field>
        <Field label={t('calendar.form.clinic')} hint={t('calendar.form.national')}>
          <select value={form.clinic_id} onChange={e => setForm({ ...form, clinic_id: e.target.value })}>
            <option value="">{t('calendar.form.national')}</option>
            {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
          </select>
        </Field>
        <Field label={t('calendar.form.type')}>
          <select value={form.holiday_type} onChange={e => setForm({ ...form, holiday_type: e.target.value })}>
            <option value="OFFICIAL">{t('calendar.type.OFFICIAL')}</option>
            <option value="EMERGENCY">{t('calendar.type.EMERGENCY')}</option>
            <option value="MAINTENANCE">{t('calendar.type.MAINTENANCE')}</option>
          </select>
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('calendar.form.saving') : t('calendar.form.save')}</button>
        </div>
      </form>
    </Modal>
  )
}

function ExceptionForm({ clinics, onSubmit }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [doctors, setDoctors] = useState([])
  const [form, setForm] = useState({ doctor_id: '', clinic_id: '', exception_date: '', reason: '', start_time: '', end_time: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    api.users.doctors().then(result => setDoctors(result.doctors || [])).catch(() => setDoctors([]))
  }, [open])

  async function submit(e) {
    e.preventDefault()
    setError('')
    try {
      await onSubmit({
        doctor_id: Number(form.doctor_id),
        clinic_id: Number(form.clinic_id),
        exception_date: form.exception_date,
        reason: form.reason,
        start_time: form.start_time || null,
        end_time: form.end_time || null,
      })
      setForm({ doctor_id: '', clinic_id: '', exception_date: '', reason: '', start_time: '', end_time: '' })
      setOpen(false)
    } catch (err) {
      setError(err.message || t('calendar.exceptions.form.error'))
    }
  }

  if (!open) {
    return <button className="secondary-button compact" onClick={() => setOpen(true)}>{t('calendar.exceptions.add')}</button>
  }

  return (
    <Modal title={t('calendar.exceptions.form.title')} onClose={() => setOpen(false)}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('calendar.exceptions.form.clinic')} required>
          <select required value={form.clinic_id} onChange={e => setForm({ ...form, clinic_id: e.target.value })}>
            <option value="">{t('doctorSchedules.selectClinic')}</option>
            {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
          </select>
        </Field>
        <Field label={t('calendar.exceptions.form.doctor')} required>
          <select required value={form.doctor_id} onChange={e => setForm({ ...form, doctor_id: e.target.value })}>
            <option value="">{t('doctorSchedules.selectDoctor')}</option>
            {doctors.map(d => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
          </select>
        </Field>
        <Field label={t('calendar.exceptions.form.date')} required>
          <input type="date" required value={form.exception_date} onChange={e => setForm({ ...form, exception_date: e.target.value })} />
        </Field>
        <Field label={t('calendar.exceptions.form.reason')} required>
          <input required value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="primary-button">{t('calendar.exceptions.form.save')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** شبكة الشهر: 6 صفوف × 7 أعمدة، الأسبوع يبدأ بالأحد. */
function buildMonthGrid(month) {
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(year, monthNumber - 1, 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  const cells = []
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    cells.push({ date, iso: isoDate(date), inMonth: date.getMonth() === monthNumber - 1 })
  }
  return cells
}

export { WEEKDAYS_AR }
