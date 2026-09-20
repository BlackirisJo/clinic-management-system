import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtMoney, fmtNumber, fmtDateTime, fmtDate, fmtTime, APPOINTMENT_STATUS } from '../lib/format'
import { useT } from '../i18n'
import { Loading, Empty, Notice, downloadCSV } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { useBaseCurrency } from '../hooks/useBaseCurrency'

const REPORT_TABS = [
  { id: 'overview' },
  { id: 'financial' },
  { id: 'clinical' },
  { id: 'appointments' },
  { id: 'patients' },
]

export default function ReportsView() {
  const t = useT()
  const { user } = useAuth()
  const baseCurrency = useBaseCurrency() // populate currency cache for fmtMoney fallback
  const [tab, setTab] = useState('overview')
  const [filters, setFilters] = useState({ date_from: '', date_to: '', clinic_id: '' })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [clinics, setClinics] = useState([])
  const [clinicsError, setClinicsError] = useState('')

  // تحميل قائمة العيادات للفلتر (الدليل المالي للأدوار المركزية، وإلا العيادة المسندة)
  useEffect(() => {
    const loader = (user?.permissions?.includes('MANAGE_SERVICES') || user?.permissions?.includes('CREATE_EXPENSE'))
      ? api.clinics.financialDirectory()
      : api.clinics.directory()
    loader
      .then((r) => setClinics(r.clinics || []))
      .catch((err) => { setClinicsError(err.message); setClinics([]) })
  }, [user])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {
        date_from: filters.date_from || undefined,
        date_to: filters.date_to || undefined,
        clinic_id: filters.clinic_id ? Number(filters.clinic_id) : undefined,
      }
      if (tab === 'overview') setData(await api.reports.overview(params))
      else if (tab === 'financial') setData(await api.reports.financial(params))
      else if (tab === 'clinical') setData(await api.reports.clinical(params))
      else if (tab === 'appointments') setData(await api.reports.appointments(params))
      else if (tab === 'patients') setData(await api.reports.patients(params))
    } catch (err) {
      setError(err.message || t('reports.error'))
    } finally {
      setLoading(false)
    }
  }, [tab, filters, t])

  useEffect(() => { load() }, [load])

  return (
    <section className="reports-view">
      <div className="report-hero">
        <div><span className="badge">{t('reports.badge')}</span><h2>{t('reports.hero.title')}</h2><p>{t('reports.hero.subtitle')}</p></div>
        <div className="top-actions">
          <button className="secondary-button" onClick={load}>{t('reports.refresh')}</button>
          <button className="primary-button compact" onClick={() => exportCSV(tab, data, t)}>{t('reports.exportCSV')}</button>
        </div>
      </div>

      <div className="toolbar report-toolbar">
        <input type="date" className="input" value={filters.date_from} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
        <span className="muted-small">{t('reports.to')}</span>
        <input type="date" className="input" value={filters.date_to} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
        <select className="input" value={filters.clinic_id} onChange={(e) => setFilters({ ...filters, clinic_id: e.target.value })}>
          <option value="">{t('reports.allClinics')}</option>
          {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
        </select>
      </div>
      {clinicsError && <Notice kind="error">{clinicsError}</Notice>}

      <div className="tabs">
        {REPORT_TABS.map((rt) => (
          <button key={rt.id} className={tab === rt.id ? 'tab active' : 'tab'} onClick={() => setTab(rt.id)}>{t(`reports.tab.${rt.id}`)}</button>
        ))}
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text={t('reports.loading')} /> : !data ? <Empty text={t('reports.empty')} /> : (
        <div className="tab-content report-content">
          {tab === 'overview' && <OverviewTab data={data.overview || {}} baseCurrency={baseCurrency} />}
          {tab === 'financial' && <FinancialTab data={data} baseCurrency={baseCurrency} />}
          {tab === 'clinical' && <ClinicalTab data={data} />}
          {tab === 'appointments' && <AppointmentsTab statuses={data.statuses || []} rows={data.appointments || []} />}
          {tab === 'patients' && <PatientsTab rows={data.patients || []} />}
        </div>
      )}
    </section>
  )
}

function exportCSV(tab, data, t) {
  if (!data) return
  const filename = `report_${tab}_${Date.now()}.csv`
  if (tab === 'overview') {
    const o = data.overview || {}
    downloadCSV(filename, [t('reports.csv.index'), t('reports.csv.value')], [
      [t('reports.overview.patients'), o.patients?.total ?? 0],
      [t('reports.overview.visits'), o.visits?.total ?? 0],
      [t('reports.overview.appointments'), o.appointments?.total ?? 0],
      [t('reports.overview.completed'), o.appointments?.completed ?? 0],
      [t('reports.overview.prescriptions'), o.prescriptions?.total ?? 0],
      [t('reports.overview.revenue'), o.financial?.revenue ?? 0],
      [t('reports.overview.doctorPayout'), o.financial?.doctor_payout ?? 0],
      [t('reports.overview.discounts'), o.financial?.discounts ?? 0],
    ])
  } else if (tab === 'financial') {
    const summary = data.summary || {}
    const rows = [[t('reports.financial.invoices'), summary.invoices ?? 0], [t('reports.financial.gross'), summary.gross ?? 0], [t('reports.financial.discounts'), summary.discounts ?? 0], [t('reports.financial.net'), summary.net ?? 0], [t('reports.financial.paid'), summary.paid ?? 0], [t('reports.financial.outstanding'), summary.outstanding ?? 0], [t('reports.financial.expenses'), data.expenses?.total ?? 0], [t('reports.financial.doctorPayout'), summary.doctor_payout ?? 0], [t('reports.financial.netAfterExpenses'), summary.net_after_expenses ?? 0]]
    downloadCSV(filename, [t('reports.csv.index'), t('reports.csv.value')], rows)
  } else if (tab === 'appointments') {
    downloadCSV(filename, [t('reports.csv.appointmentStatus'), t('reports.csv.appointmentCount')], data.statuses.map((s) => [s.status, s.total]))
  } else if (tab === 'patients') {
    downloadCSV(filename, [t('reports.csv.patientName'), t('reports.csv.patientPhone'), t('reports.csv.patientGender'), t('reports.csv.patientVisits'), t('reports.csv.patientLastVisit')], data.patients.map((p) => [p.full_name, p.phone, p.gender, p.visits, p.last_visit]))
  } else if (tab === 'clinical') {
    const rows = [[t('reports.clinical.visits'), data.summary?.visits ?? 0], [t('reports.clinical.uniquePatients'), data.summary?.unique_patients ?? 0], [t('reports.clinical.doctors'), data.summary?.doctors ?? 0]]
    downloadCSV(filename, [t('reports.csv.index'), t('reports.csv.value')], rows)
  }
}

function OverviewTab({ data, baseCurrency }) {
  const t = useT()
  return (
    <div className="report-grid">
      {[
        { label: t('reports.overview.patients'), value: data.patients?.total ?? 0 },
        { label: t('reports.overview.visits'), value: data.visits?.total ?? 0 },
        { label: t('reports.overview.appointments'), value: data.appointments?.total ?? 0 },
        { label: t('reports.overview.completed'), value: data.appointments?.completed ?? 0 },
        { label: t('reports.overview.cancelled'), value: data.appointments?.cancelled ?? 0 },
        { label: t('reports.overview.prescriptions'), value: data.prescriptions?.total ?? 0 },
        { label: t('reports.overview.revenue'), value: fmtMoney(data.financial?.revenue ?? 0, baseCurrency) },
        { label: t('reports.overview.paid'), value: fmtMoney(data.financial?.paid ?? 0, baseCurrency) },
        { label: t('reports.overview.outstanding'), value: fmtMoney(data.financial?.outstanding ?? 0, baseCurrency) },
        { label: t('reports.overview.expenses'), value: fmtMoney(data.financial?.expenses ?? 0, baseCurrency) },
        { label: t('reports.overview.doctorPayout'), value: fmtMoney(data.financial?.doctor_payout ?? 0, baseCurrency) },
        { label: t('reports.overview.discounts'), value: fmtMoney(data.financial?.discounts ?? 0, baseCurrency) },
        { label: t('reports.overview.netAfterExpenses'), value: fmtMoney(data.financial?.net_after_expenses ?? 0, baseCurrency) },
      ].map((item) => (
        <div className="report-cell" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
      ))}
    </div>
  )
}
function FinancialTab({ data, baseCurrency }) {
  const t = useT()
  const s = data.summary || {}
  const paymentMethods = data.payment_methods || []
  const expenses = data.expenses || {}
  const services = data.services || []
  const cells = [
    { label: t('reports.financial.invoices'), value: fmtNumber(s.invoices) },
    { label: t('reports.financial.gross'), value: fmtMoney(s.gross, baseCurrency) },
    { label: t('reports.financial.discounts'), value: fmtMoney(s.discounts, baseCurrency) },
    { label: t('reports.financial.net'), value: fmtMoney(s.net, baseCurrency) },
    { label: t('reports.financial.paid'), value: fmtMoney(s.paid, baseCurrency) },
    { label: t('reports.financial.outstanding'), value: fmtMoney(s.outstanding, baseCurrency) },
    { label: t('reports.financial.expenses'), value: fmtMoney(expenses.total, baseCurrency) },
    { label: t('reports.financial.doctorPayout'), value: fmtMoney(s.doctor_payout, baseCurrency) },
    { label: t('reports.financial.netAfterExpenses'), value: fmtMoney(s.net_after_expenses, baseCurrency) },
  ]
  return (
    <div className="tab-stack">
      <div className="report-grid">
        {cells.map((item) => (
          <div className="report-cell" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
        ))}
      </div>
      <div className="record-block">
        <h4>{t('reports.financial.paymentMethods')}</h4>
        {paymentMethods.length === 0 ? <Empty text={t('reports.tab.empty')} /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ textAlign: 'start' }}>{t('reports.financial.method')}</th><th style={{ textAlign: 'start' }}>{t('reports.financial.count')}</th><th style={{ textAlign: 'start' }}>{t('reports.financial.amount')}</th></tr></thead>
              <tbody>
                {paymentMethods.map((p, i) => (
                  <tr key={i}><td>{t(`paymentType.${p.payment_type}`) || p.payment_type}</td><td>{fmtNumber(p.invoices)}</td><td>{fmtMoney(p.paid, baseCurrency)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>{t('reports.financial.revenueByService')}</h4>
        {services.length === 0 ? <Empty text={t('reports.tab.empty')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th style={{ textAlign: 'start' }}>{t('reports.financial.service')}</th><th style={{ textAlign: 'start' }}>{t('reports.financial.times')}</th><th style={{ textAlign: 'start' }}>{t('reports.financial.revenue')}</th><th style={{ textAlign: 'start' }}>{t('reports.financial.doctorShare')}</th></tr></thead>
              <tbody>
                {services.map((sv, i) => (
                  <tr key={i}>
                    <td>{sv.service_name}</td>
                    <td data-label={t('reports.financial.times')}>{fmtNumber(sv.items)}</td>
                    <td data-label={t('reports.financial.revenue')}>{fmtMoney(sv.revenue, baseCurrency)}</td>
                    <td data-label={t('reports.financial.doctorShare')}>{fmtMoney(sv.doctor_payout, baseCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function ClinicalTab({ data }) {
  const t = useT()
  const s = data.summary || {}
  const doctors = data.doctors || []
  const medications = data.medications || []
  const cells = [
    { label: t('reports.clinical.visits'), value: fmtNumber(s.visits) },
    { label: t('reports.clinical.uniquePatients'), value: fmtNumber(s.unique_patients) },
    { label: t('reports.clinical.doctors'), value: fmtNumber(s.doctors) },
  ]
  return (
    <div className="tab-stack">
      <div className="report-grid">
        {cells.map((item) => (
          <div className="report-cell" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
        ))}
      </div>
      <div className="record-block">
        <h4>{t('reports.clinical.doctorPerformance')}</h4>
        {doctors.length === 0 ? <Empty text={t('reports.tab.empty')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th style={{ textAlign: 'start' }}>{t('reports.clinical.doctor')}</th><th style={{ textAlign: 'start' }}>{t('reports.clinical.visits')}</th><th style={{ textAlign: 'start' }}>{t('reports.clinical.patients')}</th></tr></thead>
              <tbody>
                {doctors.map((d, i) => (
                  <tr key={i}>
                    <td>{d.doctor_name}</td>
                    <td data-label={t('reports.clinical.visits')}>{fmtNumber(d.visits)}</td>
                    <td data-label={t('reports.clinical.patients')}>{fmtNumber(d.patients)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>{t('reports.clinical.mostPrescribed')}</h4>
        {medications.length === 0 ? <Empty text={t('reports.tab.empty')} /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ textAlign: 'start' }}>{t('reports.clinical.medication')}</th><th style={{ textAlign: 'start' }}>{t('reports.clinical.prescriptionCount')}</th></tr></thead>
              <tbody>
                {medications.map((m, i) => (
                  <tr key={i}><td>{m.trade_name} ({m.scientific_name})</td><td>{fmtNumber(m.prescribed_count)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
function AppointmentsTab({ statuses, rows }) {
  const t = useT()
  return (
    <div className="tab-stack">
      <div className="record-block">
        <h4>{t('reports.appointments.summary')}</h4>
        {statuses.length === 0 ? <Empty text={t('reports.tab.empty')} /> : (
          <div className="report-grid">
            {statuses.map((s, i) => {
              const st = APPOINTMENT_STATUS[s.status] || { label: s.status, cls: '' }
              const label = t(`appointmentStatus.${s.status}`) || st.label
              return (
                <div className="report-cell" key={i}><span>{label}</span><strong>{fmtNumber(s.total)}</strong></div>
              )
            })}
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>{t('reports.appointments.record')} ({fmtNumber(rows.length)})</h4>
        {rows.length === 0 ? <Empty text={t('reports.appointments.noInPeriod')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th style={{ textAlign: 'start' }}>{t('reports.appointments.date')}</th><th style={{ textAlign: 'start' }}>{t('reports.appointments.time')}</th><th style={{ textAlign: 'start' }}>{t('reports.appointments.patient')}</th><th style={{ textAlign: 'start' }}>{t('reports.appointments.clinic')}</th><th style={{ textAlign: 'start' }}>{t('reports.appointments.doctor')}</th><th style={{ textAlign: 'start' }}>{t('reports.appointments.status')}</th></tr></thead>
              <tbody>
                {rows.map((a) => {
                  const appointmentStatus = APPOINTMENT_STATUS[a.status] || { label: a.status, cls: '' }
                  const statusLabel = t(`appointmentStatus.${a.status}`) || appointmentStatus.label
                  return (
                    <tr key={a.appointment_id}>
                      <td>{fmtDate(a.appointment_date)}</td>
                      <td data-label={t('reports.appointments.time')}>{fmtTime(a.start_time)}</td>
                      <td data-label={t('reports.appointments.patient')}>{a.patient_name}</td>
                      <td data-label={t('reports.appointments.clinic')}>{a.clinic_name}</td>
                      <td data-label={t('reports.appointments.doctor')}>{a.doctor_name || '—'}</td>
                      <td data-label={t('reports.appointments.status')}>
                        <span className={`status ${appointmentStatus.cls}`}>{statusLabel}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function PatientsTab({ rows }) {
  const t = useT()
  return (
    <div className="tab-stack">
      <div className="table-wrap table-cards">
        <table style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '32%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '29%' }} />
          </colgroup>
          <thead><tr><th style={{ textAlign: 'start' }}>{t('reports.csv.patientName')}</th><th style={{ textAlign: 'start' }}>{t('reports.csv.patientPhone')}</th><th style={{ textAlign: 'start' }}>{t('reports.csv.patientGender')}</th><th style={{ textAlign: 'start' }}>{t('reports.csv.patientVisits')}</th><th style={{ textAlign: 'start' }}>{t('reports.csv.patientLastVisit')}</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.patient_id}>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.full_name}</td>
                <td dir="ltr" style={{ textAlign: 'center' }} data-label={t('reports.patients.phone')}>{p.phone}</td>
                <td style={{ textAlign: 'center' }} data-label={t('reports.patients.gender')}>{p.gender === 'FEMALE' ? t('gender.FEMALE') : t('gender.MALE')}</td>
                <td style={{ textAlign: 'center' }} data-label={t('reports.patients.visits')}>{fmtNumber(p.visits)}</td>
                <td style={{ textAlign: 'center' }} data-label={t('reports.patients.lastVisit')}>{fmtDateTime(p.last_visit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <Empty text={t('reports.tab.patientsEmpty')} />}
    </div>
  )
}