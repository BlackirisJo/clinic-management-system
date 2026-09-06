import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtMoney, fmtNumber, fmtDateTime, PAYMENT_TYPES } from '../lib/format'
import { Loading, Empty, Notice, downloadCSV } from '../components/ui'

const REPORT_TABS = [
  { id: 'overview', label: 'الشامل' },
  { id: 'financial', label: 'المالي' },
  { id: 'clinical', label: 'الطبي' },
  { id: 'appointments', label: 'المواعيد' },
  { id: 'patients', label: 'المرضى' },
]

export default function ReportsView() {
  const [tab, setTab] = useState('overview')
  const [filters, setFilters] = useState({ date_from: '', date_to: '', clinic_id: '' })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
      setError(err.message || 'تعذر إنشاء التقرير')
    } finally {
      setLoading(false)
    }
  }, [tab, filters])

  useEffect(() => { load() }, [load])

  return (
    <section className="reports-view">
      <div className="report-hero">
        <div><span className="badge">تقرير مباشر</span><h2>صورة واضحة لأداء العيادة</h2><p>فلترة حسب الفترة الزمنية والعيادة.</p></div>
        <div className="top-actions">
          <button className="secondary-button" onClick={load}>تحديث</button>
          <button className="primary-button compact" onClick={() => exportCSV(tab, data)}>تنزيل CSV ↓</button>
        </div>
      </div>

      <div className="toolbar report-toolbar">
        <input type="date" className="input" value={filters.date_from} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
        <span className="muted-small">إلى</span>
        <input type="date" className="input" value={filters.date_to} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
        <input type="number" className="input sm" placeholder="رقم العيادة" value={filters.clinic_id} onChange={(e) => setFilters({ ...filters, clinic_id: e.target.value })} />
      </div>

      <div className="tabs">
        {REPORT_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text="جارِ إنشاء التقرير..." /> : !data ? <Empty text="لا توجد بيانات للتقرير" /> : (
        <div className="tab-content report-content">
          {tab === 'overview' && <OverviewTab data={data.overview || {}} />}
          {tab === 'financial' && <FinancialTab data={data} />}
          {tab === 'clinical' && <ClinicalTab data={data} />}
          {tab === 'appointments' && <AppointmentsTab data={data.statuses || []} />}
          {tab === 'patients' && <PatientsTab rows={data.patients || []} />}
        </div>
      )}
    </section>
  )
}

function exportCSV(tab, data) {
  if (!data) return
  const filename = `report_${tab}_${Date.now()}.csv`
  if (tab === 'overview') {
    const o = data.overview || {}
    downloadCSV(filename, ['المؤشر', 'القيمة'], [
      ['المرضى', o.patients?.total ?? 0],
      ['الزيارات', o.visits?.total ?? 0],
      ['المواعيد الكلية', o.appointments?.total ?? 0],
      ['المواعيد المكتملة', o.appointments?.completed ?? 0],
      ['الروشتات', o.prescriptions?.total ?? 0],
      ['الإيراد', o.financial?.revenue ?? 0],
      ['حصص الأطباء', o.financial?.doctor_payout ?? 0],
      ['الخصومات', o.financial?.discounts ?? 0],
    ])
  } else if (tab === 'financial') {
    const summary = data.summary || {}
    const rows = [['الفواتير', summary.invoices ?? 0], ['الإجمالي', summary.gross ?? 0], ['الخصومات', summary.discounts ?? 0], ['الصافي', summary.net ?? 0], ['المحصّل', summary.paid ?? 0]]
    downloadCSV(filename, ['المؤشر', 'القيمة'], rows)
  } else if (tab === 'appointments') {
    downloadCSV(filename, ['الحالة', 'العدد'], data.statuses.map((s) => [s.status, s.total]))
  } else if (tab === 'patients') {
    downloadCSV(filename, ['الاسم', 'الهاتف', 'النوع', 'الزيارات', 'آخر زيارة'], data.patients.map((p) => [p.full_name, p.phone, p.gender, p.visits, p.last_visit]))
  } else if (tab === 'clinical') {
    const rows = [['الزيارات', data.summary?.visits ?? 0], ['مرضى فريدون', data.summary?.unique_patients ?? 0], ['الأطباء', data.summary?.doctors ?? 0]]
    downloadCSV(filename, ['المؤشر', 'القيمة'], rows)
  }
}

function OverviewTab({ data }) {
  return (
    <div className="report-grid">
      {[
        { label: 'إجمالي المرضى', value: data.patients?.total ?? 0 },
        { label: 'الزيارات الطبية', value: data.visits?.total ?? 0 },
        { label: 'المواعيد', value: data.appointments?.total ?? 0 },
        { label: 'مواعيد مكتملة', value: data.appointments?.completed ?? 0 },
        { label: 'مواعيد ملغاة', value: data.appointments?.cancelled ?? 0 },
        { label: 'الروشتات', value: data.prescriptions?.total ?? 0 },
        { label: 'الإيرادات', value: fmtMoney(data.financial?.revenue ?? 0) },
        { label: 'حصص الأطباء', value: fmtMoney(data.financial?.doctor_payout ?? 0) },
        { label: 'الخصومات', value: fmtMoney(data.financial?.discounts ?? 0) },
      ].map((item) => (
        <div className="report-cell" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
      ))}
    </div>
  )
}
function FinancialTab({ data }) {
  const s = data.summary || {}
  const paymentMethods = data.payment_methods || []
  const expenses = data.expenses || {}
  const services = data.services || []
  const cells = [
    { label: 'عدد الفواتير', value: fmtNumber(s.invoices) },
    { label: 'الإجمالي', value: fmtMoney(s.gross) },
    { label: 'الخصومات', value: fmtMoney(s.discounts) },
    { label: 'الصافي', value: fmtMoney(s.net) },
    { label: 'المحصّل', value: fmtMoney(s.paid) },
    { label: 'المصاريف', value: fmtMoney(expenses.total) },
  ]
  return (
    <div className="tab-stack">
      <div className="report-grid">
        {cells.map((item) => (
          <div className="report-cell" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
        ))}
      </div>
      <div className="record-block">
        <h4>طرق الدفع</h4>
        {paymentMethods.length === 0 ? <Empty text="لا بيانات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الطريقة</th><th>العدد</th><th>المبلغ</th></tr></thead>
              <tbody>
                {paymentMethods.map((p, i) => (
                  <tr key={i}><td>{PAYMENT_TYPES[p.payment_type]?.label || p.payment_type}</td><td>{fmtNumber(p.invoices)}</td><td>{fmtMoney(p.paid)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>الإيراد حسب الخدمة</h4>
        {services.length === 0 ? <Empty text="لا بيانات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الخدمة</th><th>المرات</th><th>الإيراد</th><th>حصة الأطباء</th></tr></thead>
              <tbody>
                {services.map((sv, i) => (
                  <tr key={i}><td>{sv.service_name}</td><td>{fmtNumber(sv.items)}</td><td>{fmtMoney(sv.revenue)}</td><td>{fmtMoney(sv.doctor_payout)}</td></tr>
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
  const s = data.summary || {}
  const doctors = data.doctors || []
  const medications = data.medications || []
  const cells = [
    { label: 'الزيارات', value: fmtNumber(s.visits) },
    { label: 'مرضى فريدون', value: fmtNumber(s.unique_patients) },
    { label: 'الأطباء', value: fmtNumber(s.doctors) },
  ]
  return (
    <div className="tab-stack">
      <div className="report-grid">
        {cells.map((item) => (
          <div className="report-cell" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
        ))}
      </div>
      <div className="record-block">
        <h4>أداء الأطباء</h4>
        {doctors.length === 0 ? <Empty text="لا بيانات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الطبيب</th><th>الزيارات</th><th>المرضى</th></tr></thead>
              <tbody>
                {doctors.map((d, i) => (
                  <tr key={i}><td>{d.doctor_name}</td><td>{fmtNumber(d.visits)}</td><td>{fmtNumber(d.patients)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>الأدوية الأكثر وصفاً</h4>
        {medications.length === 0 ? <Empty text="لا بيانات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الدواء</th><th>الوصفات</th></tr></thead>
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
function AppointmentsTab({ rows }) {
  return (
    <div className="tab-stack">
      <div className="record-block">
        <h4>توزيع حالات المواعيد</h4>
        {rows.length === 0 ? <Empty text="لا بيانات" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الحالة</th><th>العدد</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}><td>{r.status}</td><td>{fmtNumber(r.total)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function PatientsTab({ rows }) {
  return (
    <div className="tab-stack">
      <div className="table-wrap">
        <table>
          <thead><tr><th>الاسم</th><th>الهاتف</th><th>النوع</th><th>الزيارات</th><th>آخر زيارة</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.patient_id}><td>{p.full_name}</td><td dir="ltr">{p.phone}</td><td>{p.gender === 'FEMALE' ? 'أنثى' : 'ذكر'}</td><td>{fmtNumber(p.visits)}</td><td>{fmtDateTime(p.last_visit)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
     {rows.length === 0 && <Empty text="لا بيانات للمرضى" />}
    </div>
  )
}