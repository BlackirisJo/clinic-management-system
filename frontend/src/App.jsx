import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const result = await apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify(form) })
      localStorage.setItem('clinic_token', result.token)
      onLogin(result.token)
    } catch {
      setError('بيانات الدخول غير صحيحة أو الخادم غير متاح')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">ن</div>
        <p className="eyebrow">نظام إدارة العيادات</p>
        <h1>مرحبًا بعودتك</h1>
        <p className="muted">سجّل الدخول لمتابعة عمل العيادة اليوم.</p>
        <form onSubmit={submit} className="login-form">
          <label>اسم المستخدم<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>كلمة المرور<input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          {error && <p className="error-text">{error}</p>}
          <button className="primary-button" disabled={loading}>{loading ? 'جارِ الدخول...' : 'دخول إلى النظام'}</button>
        </form>
      </section>
      <aside className="login-aside"><span>2026</span><strong>رعاية أهدأ.<br />قرارات أوضح.</strong><p>مساحة تشغيل موحدة لفرق العيادة والمرضى والتقارير.</p></aside>
    </main>
  )
}

function Dashboard({ token, onLogout }) {
  const [activeView, setActiveView] = useState('overview')
  const [data, setData] = useState(null)
  const [patients, setPatients] = useState([])
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showPatientForm, setShowPatientForm] = useState(false)
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError('')
      try {
        const [overview, patientResult, appointmentResult] = await Promise.all([
          apiRequest('/api/reports/overview', { headers }),
          apiRequest('/api/patients?page=1&limit=6', { headers }),
          apiRequest('/api/appointments?page=1&limit=6', { headers }),
        ])
        setData(overview.overview)
        setPatients(patientResult.patients || [])
        setAppointments(appointmentResult.appointments || [])
      } catch {
        setError('تعذر تحميل بيانات لوحة التحكم')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [token, headers])

  async function logout() {
    try { await apiRequest('/api/auth/logout', { method: 'POST', headers }) } catch { /* انتهت الجلسة محليًا */ }
    localStorage.removeItem('clinic_token')
    onLogout()
  }

  async function createPatient(form) {
    await apiRequest('/api/patients', { method: 'POST', headers, body: JSON.stringify(form) })
    const patientResult = await apiRequest('/api/patients?page=1&limit=6', { headers })
    setPatients(patientResult.patients || [])
    setShowPatientForm(false)
  }

  const navItems = [['overview', 'نظرة عامة', '⌂'], ['patients', 'المرضى', '◉'], ['appointments', 'المواعيد', '◷'], ['reports', 'التقارير', '▥'], ['users', 'المستخدمون', '♙']]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark small">ن</div><div><strong>نبض</strong><span>إدارة العيادات</span></div></div>
        <nav>{navItems.map(([id, label, icon]) => <button key={id} className={activeView === id ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView(id)}><span>{icon}</span>{label}</button>)}</nav>
        <div className="sidebar-bottom"><div className="support-note"><span className="status-dot" />النظام يعمل بشكل طبيعي</div><button className="logout-button" onClick={logout}>↪ تسجيل الخروج</button></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div><p className="eyebrow">الخميس، ٣ سبتمبر ٢٠٢٦</p><h1>{navItems.find(([id]) => id === activeView)?.[1]}</h1></div><div className="top-actions"><button className="icon-button" title="الإشعارات">♧</button><div className="profile"><div className="avatar">م</div><div><strong>مدير النظام</strong><span>العيادة الرئيسية</span></div></div></div></header>
        {error && <div className="alert">{error}</div>}
        {loading ? <div className="loading-state"><span className="loader" />جارِ تحميل بيانات العيادة</div> : <>
          {activeView === 'overview' && <Overview data={data} patients={patients} appointments={appointments} />}
          {activeView === 'patients' && <ListView title="سجل المرضى" subtitle="آخر المرضى المسجلين في العيادة" rows={patients} type="patients" onAdd={() => setShowPatientForm(true)} />}
          {activeView === 'appointments' && <ListView title="جدول المواعيد" subtitle="المواعيد القادمة والمجدولة" rows={appointments} type="appointments" />}
          {activeView === 'reports' && <Reports data={data} />}
          {activeView === 'users' && <div className="empty-view"><div className="empty-icon">♙</div><h2>إدارة فريق العمل</h2><p>يمكن إدارة الأطباء والمحاسبين وموظفي الاستقبال من واجهة إدارة المستخدمين.</p></div>}
        </>}
      </main>
      {showPatientForm && <PatientForm onClose={() => setShowPatientForm(false)} onSubmit={createPatient} />}
    </div>
  )
}

function Overview({ data, patients, appointments }) {
  const cards = [['إجمالي المرضى', data?.patients?.total ?? 0, 'هذا العام', 'teal'], ['الزيارات الطبية', data?.visits?.total ?? 0, 'ضمن الفترة المحددة', 'blue'], ['مواعيد مكتملة', data?.appointments?.completed ?? 0, `${data?.appointments?.total ?? 0} إجمالي المواعيد`, 'amber'], ['صافي الإيرادات', `${Number(data?.financial?.revenue || 0).toLocaleString()} ر.س`, 'قبل المصاريف', 'coral']]
  return <>
    <section className="welcome-band"><div><span className="badge">ملخص اليوم</span><h2>صباح الخير، مدير النظام</h2><p>إليك ملخص أداء العيادة ونشاطها الحالي.</p></div><div className="date-chip">٣ سبتمبر<br /><strong>الخميس</strong></div></section>
    <div className="metric-grid">{cards.map(([label, value, note, color]) => <article className={`metric-card ${color}`} key={label}><div className="metric-head"><span>{label}</span><i>↗</i></div><strong>{value}</strong><small>{note}</small></article>)}</div>
    <div className="content-grid"><section className="data-panel"><div className="panel-heading"><div><h2>آخر المرضى</h2><p>السجلات المضافة حديثًا</p></div><button className="text-button">عرض الكل ←</button></div><PatientTable rows={patients} /></section><section className="data-panel"><div className="panel-heading"><div><h2>المواعيد القادمة</h2><p>نظرة سريعة على الجدول</p></div><button className="text-button">الجدول ←</button></div><AppointmentList rows={appointments} /></section></div>
  </>
}

function PatientTable({ rows }) { return <div className="table-wrap"><table><thead><tr><th>المريض</th><th>الهاتف</th><th>النوع</th><th>تاريخ التسجيل</th></tr></thead><tbody>{rows.slice(0, 5).map((row) => <tr key={row.patient_id}><td><span className="table-avatar">{row.full_name?.[0] || 'م'}</span>{row.full_name}</td><td dir="ltr">{row.phone}</td><td>{row.gender === 'FEMALE' ? 'أنثى' : 'ذكر'}</td><td>{new Date(row.created_at).toLocaleDateString('ar-SA')}</td></tr>)}</tbody></table>{!rows.length && <p className="no-data">لا توجد سجلات بعد</p>}</div> }
function AppointmentList({ rows }) { return <div className="appointment-list">{rows.slice(0, 5).map((row) => <div className="appointment-row" key={row.appointment_id}><div className="time-box">{String(row.start_time).slice(0, 5)}<small>{row.appointment_date?.slice(0, 10)}</small></div><div><strong>{row.patient_name || `مريض #${row.patient_id}`}</strong><span>{row.doctor_name || 'الطبيب المعالج'}</span></div><span className={`status ${String(row.status).toLowerCase()}`}>{row.status === 'CONFIRMED' ? 'مؤكد' : row.status === 'COMPLETED' ? 'مكتمل' : 'مجدول'}</span></div>)}{!rows.length && <p className="no-data">لا توجد مواعيد قادمة</p>}</div> }
function ListView({ title, subtitle, rows, type, onAdd }) { return <section className="full-panel"><div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="primary-button compact" onClick={onAdd}>+ إضافة جديد</button></div>{type === 'patients' ? <PatientTable rows={rows} /> : <AppointmentList rows={rows} />}</section> }
function Reports({ data }) { return <section className="reports-view"><div className="report-hero"><div><span className="badge">تقرير مباشر</span><h2>صورة واضحة لأداء العيادة</h2><p>المؤشرات الأساسية للفترة الحالية.</p></div><button className="secondary-button">تنزيل التقرير ↓</button></div><div className="report-bars"><div><span>مواعيد مكتملة</span><strong>{data?.appointments?.completed ?? 0}</strong><div className="bar"><i style={{ width: `${Math.min(100, ((data?.appointments?.completed || 0) / Math.max(1, data?.appointments?.total || 1)) * 100)}%` }} /></div></div><div><span>الزيارات الطبية</span><strong>{data?.visits?.total ?? 0}</strong><div className="bar"><i className="blue-fill" style={{ width: '68%' }} /></div></div><div><span>الوصفات الطبية</span><strong>{data?.prescriptions?.total ?? 0}</strong><div className="bar"><i className="coral-fill" style={{ width: '42%' }} /></div></div></div></section> }

function PatientForm({ onClose, onSubmit }) {
  const [form, setForm] = useState({ full_name: '', national_id: '', phone: '', gender: 'MALE', date_of_birth: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try { await onSubmit(form) } catch { setError('تعذر حفظ بيانات المريض، تحقق من البيانات وحاول مرة أخرى') } finally { setSaving(false) }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="patient-modal"><div className="modal-header"><div><span className="eyebrow">سجل المرضى</span><h2>إضافة مريض جديد</h2></div><button className="modal-close" onClick={onClose} aria-label="إغلاق">×</button></div><form className="patient-form" onSubmit={submit}><label>الاسم الكامل<input required minLength="3" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label><div className="form-row"><label>الرقم الوطني<input value={form.national_id} onChange={(e) => setForm({ ...form, national_id: e.target.value })} /></label><label>رقم الهاتف<input required minLength="7" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label></div><div className="form-row"><label>الجنس<select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}><option value="MALE">ذكر</option><option value="FEMALE">أنثى</option></select></label><label>تاريخ الميلاد<input required type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></label></div>{error && <p className="error-text">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>إلغاء</button><button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ المريض'}</button></div></form></section></div>
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('clinic_token'))
  return token ? <Dashboard token={token} onLogout={() => setToken(null)} /> : <Login onLogin={setToken} />
}
