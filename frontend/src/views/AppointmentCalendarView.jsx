import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useT } from '../i18n'
import { fmtDate, fmtTime, APPOINTMENT_STATUS } from '../lib/format'

export default function AppointmentCalendarView() {
  const t = useT()
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.appointments.list({ date, limit: 200 })
      setAppointments(result.appointments || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('appointmentCalendar.title')}</h2><p>{t('appointmentCalendar.subtitle')}</p></div>
        <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
      </div>
      {loading ? <div>{t('appointmentCalendar.loading')}</div> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('appointments.table.time')}</th><th>{t('appointments.table.patient')}</th><th>{t('appointments.table.doctor')}</th><th>{t('appointments.table.clinic')}</th><th>{t('appointments.table.status')}</th></tr></thead>
            <tbody>
              {appointments.map(a => {
                const st = APPOINTMENT_STATUS[a.status] || APPOINTMENT_STATUS.SCHEDULED
                return (
                  <tr key={a.appointment_id}>
                    <td dir="ltr">{fmtTime(a.start_time)} - {fmtTime(a.end_time)}</td>
                    <td>{a.patient_name}</td>
                    <td>{a.doctor_name}</td>
                    <td>{a.clinic_name}</td>
                    <td><span className={`status ${st.cls}`}>{st.label}</span></td>
                  </tr>
                )
              })}
              {appointments.length === 0 && <tr><td colSpan="5">{t('appointmentCalendar.noAppointments')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
