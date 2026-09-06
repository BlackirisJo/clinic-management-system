import { useAuth } from '../auth/AuthContext'
import { todayLabel, ROLE_LABELS } from '../lib/format'

export const NAV_ITEMS = [
  { id: 'overview', label: 'نظرة عامة', icon: '⌂' },
  { id: 'patients', label: 'المرضى', icon: '◉' },
  { id: 'appointments', label: 'المواعيد', icon: '◷' },
  { id: 'prescriptions', label: 'الروشتات والأدوية', icon: '✎' },
  { id: 'billing', label: 'الفواتير والمالية', icon: '◈' },
  { id: 'reports', label: 'التقارير', icon: '▥' },
  { id: 'users', label: 'المستخدمون', icon: '♙' },
  { id: 'backups', label: 'النسخ الاحتياطية', icon: '♺' },
]

export default function Layout({ active, onNavigate, children }) {
  const { user, logout } = useAuth()
  const roleLabel = user?.roleName ? ROLE_LABELS[user.roleName] || user.roleName : 'مستخدم'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark small">ن</div><div><strong>نبض</strong><span>إدارة العيادات</span></div></div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button key={item.id} className={active === item.id ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate(item.id)}>
              <span>{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="support-note"><span className="status-dot" />النظام يعمل بشكل طبيعي</div>
          <button className="logout-button" onClick={() => logout(false)}>↪ تسجيل الخروج</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">{todayLabel()}</p>
            <h1>{NAV_ITEMS.find((n) => n.id === active)?.label || 'لوحة التحكم'}</h1>
          </div>
          <div className="top-actions">
            <button className="icon-button" title="إنهاء جميع الجلسات" onClick={() => logout(true)}>⬒</button>
            <div className="profile">
              <div className="avatar">م</div>
              <div><strong>{roleLabel}</strong><span>{user?.clinicId ? `العيادة #${user.clinicId}` : 'إدارة متعددة العيادات'}</span></div>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  )
}