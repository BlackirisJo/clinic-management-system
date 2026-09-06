import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fmtMoney, fmtNumber, fmtTime, fmtDate, GENDER_LABELS, APPOINTMENT_STATUS } from '../lib/format'
import { Loading, Empty } from '../components/ui'

export default function OverviewView({ onNavigate }) {
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
        if (!cancelled) setError(err.message || 'تعذر تحميل بيانات لوحة التحكم')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const cards = useMemo(() => [
    { label: 'إجمالي المرضى', value: fmtNumber(overview?.patients?.total ?? patients.length), note: 'سجلات مسجلة', color: 'teal' },
    { label: 'الزيارات الطبية', value: fmtNumber(overview?.visits?.total ?? 0), note: 'ضمن الفترة المحددة', color: 'blue' },
    { label: 'مواعيد مكتملة', value: fmtNumber(overview?.appointments?.completed ?? 0), note: `${fmtNumber(overview?.appointments?.total ?? appointments.length)} إجمالي المواعيد`, color: 'amber' },
    { label: 'صافي الإيرادات', value: fmtMoney(overview?.financial?.revenue ?? 0), note: 'قبل المصاريف', color: 'coral' },
  ], [overview, patients, appointments])

  if (loading) return <Loading text="جارِ تحميل بيانات العيادة" />

  return (
    <>
      {error && <div className="alert">{error}</div>}
      <section className="welcome-band">
        <div>
          <span className="badge">ملخص اليوم</span>
          <h2>أهلاً بك في لوحة التحكم</h2>
          <p>إليك ملخص أداء العيادة ونشاطها الحالي.</p>
        </div>
        <div className="top-actions">
          <button className="secondary-button" onClick={() => onNavigate('appointments')}>حجز موعد جديد</button>
          <button className="primary-button" onClick={() => onNavigate('patients')}>إضافة مريض</button>
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
            <div><h2>آخر المرضى</h2><p>السجلات المضافة حديثاً</p></div>
            <button className="text-button" onClick={() => onNavigate('patients')}>عرض الكل ←</button>
          </div>
          {patients.length === 0 ? <Empty text="لا توجد سجلات مرضى بعد" /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>المريض</th><th>الهاتف</th><th>النوع</th><th>التاريخ</th></tr></thead>
                <tbody>
                  {patients.slice(0, 5).map((p) => (
                    <tr key={p.patient_id}><td><span className="table-avatar">{p.full_name?.[0] || 'م'}</span>{p.full_name}</td><td dir="ltr">{p.phone}</td><td>{GENDER_LABELS[p.gender] || p.gender}</td><td>{fmtDate(p.created_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="data-panel">
          <div className="panel-heading">
            <div><h2>المواعيد القادمة</h2><p>نظرة سريعة على الجدول</p></div>
            <button className="text-button" onClick={() => onNavigate('appointments')}>الجدول ←</button>
          </div>
          {appointments.length === 0 ? <Empty text="لا توجد مواعيد قادمة" /> : (
            <div className="appointment-list">
              {appointments.slice(0, 5).map((row) => {
                const st = APPOINTMENT_STATUS[row.status] || APPOINTMENT_STATUS.SCHEDULED
                return (
                  <div className="appointment-row" key={row.appointment_id}>
                    <div className="time-box">{fmtTime(row.start_time)}<small>{fmtDate(row.appointment_date)}</small></div>
                    <div><strong>{row.patient_name || `مريض #${row.patient_id}`}</strong><span>{row.doctor_name || 'الطبيب المعالج'} · {row.clinic_name}</span></div>
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