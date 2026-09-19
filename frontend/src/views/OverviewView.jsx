import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { api } from '../lib/api'
import { fmtMoney, fmtNumber, fmtTime, fmtDate, GENDER_LABELS, APPOINTMENT_STATUS } from '../lib/format'
import { Loading, Empty } from '../components/ui'

export default function OverviewView({ onNavigate }) {
  const t = useT()
  const [overview, setOverview] = useState(null)
  const [patients, setPatients] = useState([])
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const [patientsResult, appointmentsResult] = await Promise.all([
          api.patients.list({ page: 1, limit: 6 }),
          api.appointments.list({ page: 1, limit: 6 }),
        ])
        if (!cancelled) {
          setPatients(patientsResult.patients || [])
          setAppointments(appointmentsResult.appointments || [])
        }
        // التقارير قد تكون غير متاحة لبعض الأدوار، فلا نمنع بقية الصفحة عندها
        try {
          const overviewResult = await api.reports.overview({})
          if (!cancelled) setOverview(overviewResult.overview)
        } catch { /* لا صلاحية للتقارير */ }
      } catch (err) {
        if (!cancelled) setError(err.message || t('dashboard.error.load'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const fin = overview?.financial
  const cards = useMemo(() => [
    { label: t('dashboard.cards.patientsTotal'), value: fmtNumber(overview?.patients?.total ?? patients.length), note: t('dashboard.cards.patientsTotalNote'), color: 'teal' },
    { label: t('dashboard.cards.visits'), value: fmtNumber(overview?.visits?.total ?? 0), note: t('dashboard.cards.visitsNote'), color: 'blue' },
    { label: t('dashboard.cards.completedAppointments'), value: fmtNumber(overview?.appointments?.completed ?? 0), note: t('dashboard.cards.appointmentsTotalNote', { count: overview?.appointments?.total ?? appointments.length }), color: 'amber' },
    { label: t('dashboard.cards.revenue'), value: fmtMoney(fin?.revenue ?? 0), note: t('dashboard.cards.revenueNote'), color: 'blue' },
    { label: t('dashboard.cards.paid'), value: fmtMoney(fin?.paid ?? 0), note: t('dashboard.cards.paidNote'), color: 'teal' },
    { label: t('dashboard.cards.outstanding'), value: fmtMoney(fin?.outstanding ?? 0), note: t('dashboard.cards.outstandingNote'), color: 'amber' },
    { label: t('dashboard.cards.expenses'), value: fmtMoney(fin?.expenses ?? 0), note: t('dashboard.cards.expensesNote'), color: 'coral' },
    { label: t('dashboard.cards.doctorPayout'), value: fmtMoney(fin?.doctor_payout ?? 0), note: t('dashboard.cards.doctorPayoutNote'), color: 'amber' },
    { label: t('dashboard.cards.netRevenue'), value: fmtMoney(fin?.net_after_expenses ?? 0), note: t('dashboard.cards.netRevenueNote'), color: 'coral' },
  ], [overview, patients, appointments, fin])

  if (loading) return <Loading text={t('dashboard.loading')} />

  return (
    <>
      {error && <div className="alert">{error}</div>}
      <section className="welcome-band">
        <div>
          <span className="badge">{t('dashboard.badge.today')}</span>
          <h2>{t('dashboard.welcome.title')}</h2>
          <p>{t('dashboard.welcome.text')}</p>
        </div>
        <div className="top-actions">
          <button className="secondary-button" onClick={() => onNavigate('appointments')}>{t('dashboard.action.newAppointment')}</button>
          <button className="primary-button" onClick={() => onNavigate('patients')}>{t('dashboard.action.addPatient')}</button>
        </div>
      </section>

      <div className="metric-grid">
        {cards.map((card) => (
          <article className={`metric-card ${card.color}`} key={card.label}>
            <div className="metric-head"><span>{card.label}</span><i>↗</i></div>
            <strong>{card.value}</strong>
            <small>{card.note}</small>
          </article>
        ))}
      </div>

      <div className="content-grid">
        <section className="data-panel">
          <div className="panel-heading">
            <div><h2>{t('dashboard.recentPatients.title')}</h2><p>{t('dashboard.recentPatients.subtitle')}</p></div>
            <button className="text-button" onClick={() => onNavigate('patients')}>{t('dashboard.action.viewAll')}</button>
          </div>
          {patients.length === 0 ? <Empty text={t('dashboard.empty.patients')} /> : (
            <div className="table-wrap table-cards">
              <table>
                <thead><tr><th>{t('dashboard.table.patient')}</th><th>{t('dashboard.table.phone')}</th><th>{t('dashboard.table.gender')}</th><th>{t('dashboard.table.date')}</th></tr></thead>
                <tbody>
                  {patients.slice(0, 5).map((p) => (
                    <tr key={p.patient_id}>
                      <td><span className="table-avatar">{p.full_name?.[0] || t('dashboard.patientInitial')}</span>{p.full_name}</td>
                      <td dir="ltr" data-label={t('dashboard.table.phone')}>{p.phone}</td>
                      <td data-label={t('dashboard.table.gender')}>{GENDER_LABELS[p.gender] || p.gender}</td>
                      <td data-label={t('dashboard.table.date')}>{fmtDate(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="data-panel">
          <div className="panel-heading">
            <div><h2>{t('dashboard.upcoming.title')}</h2><p>{t('dashboard.upcoming.subtitle')}</p></div>
            <button className="text-button" onClick={() => onNavigate('appointments')}>{t('dashboard.action.schedule')}</button>
          </div>
          {appointments.length === 0 ? <Empty text={t('dashboard.empty.appointments')} /> : (
            <div className="appointment-list">
              {appointments.slice(0, 5).map((row) => {
                const st = APPOINTMENT_STATUS[row.status] || APPOINTMENT_STATUS.SCHEDULED
                return (
                  <div className="appointment-row" key={row.appointment_id}>
                    <div className="time-box">{fmtTime(row.start_time)}<small>{fmtDate(row.appointment_date)}</small></div>
                    <div><strong>{row.patient_name || t('dashboard.patientById', { id: row.patient_id })}</strong><span>{row.doctor_name || t('dashboard.attendingDoctor')} · {row.clinic_name}</span></div>
                    <span className={`status ${st.cls}`}>{st.label}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </>
  )
}