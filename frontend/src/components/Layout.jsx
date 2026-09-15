import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { todayLabel, ROLE_LABELS } from '../lib/format'
import { isStandalone, requestInstallUi } from '../lib/pwa'

// عناصر القائمة مع الأدوار المسموح لها بكل قسم — مدير النظام (SUPER_ADMIN/SYSTEM_ADMIN) يرى كل شيء
export const NAV_ITEMS = [
  { id: 'overview', label: 'نظرة عامة', icon: '⌂', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ACCOUNTANT'] },
  { id: 'patients', label: 'المرضى', icon: '◉', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'DOCTOR', 'NURSE', 'ACCOUNTANT', 'RECEPTIONIST'] },
  { id: 'appointments', label: 'المواعيد', icon: '◷', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'] },
  { id: 'prescriptions', label: 'الروشتات والأدوية', icon: '✎', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'DOCTOR'] },
  { id: 'billing', label: 'الفواتير والمالية', icon: '◈', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ACCOUNTANT'] },
  { id: 'reports', label: 'التقارير', icon: '▥', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ACCOUNTANT'] },
  { id: 'clinics', label: 'العيادات', icon: '⌗', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN'] },
  { id: 'users', label: 'المستخدمون', icon: '♙', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN'] },
  { id: 'backups', label: 'النسخ الاحتياطية', icon: '♺', roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN'] },
  { id: 'permissions', label: 'إدارة الصلاحيات', icon: '☰', permission: 'MANAGE_PERMISSIONS' },
]

// تصفية عناصر القائمة حسب دور المستخدم وصلاحياته (الأدوار الإدارية ترى كل شيء)
export const navItemsForRole = (roleName, permissions = []) =>
  NAV_ITEMS.filter(
    (item) =>
      (item.roles && item.roles.includes(roleName)) ||
      (item.permission &&
        (roleName === 'SUPER_ADMIN' || roleName === 'SYSTEM_ADMIN' || permissions.includes(item.permission)))
  )

export default function Layout({ active, onNavigate, children }) {
  const { user, logout } = useAuth()
  const [navOpen, setNavOpen] = useState(false)
  const [standalone, setStandalone] = useState(() => isStandalone())
  const roleLabel = user?.roleName ? ROLE_LABELS[user.roleName] || user.roleName : 'مستخدم'
  const visibleItems = navItemsForRole(user?.roleName, user?.permissions || [])
  const clinicLabel = user?.clinicId ? `العيادة #${user.clinicId}` : 'إدارة متعددة العيادات'
  const currentLabel = NAV_ITEMS.find((n) => n.id === active)?.label || 'لوحة التحكم'

  const closeNav = useCallback(() => setNavOpen(false), [])

  // إغلاق بزر Escape + منع تمرير الصفحة خلف القائمة المفتوحة
  useEffect(() => {
    if (!navOpen) return undefined
    const onKey = (event) => { if (event.key === 'Escape') setNavOpen(false) }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [navOpen])

  // عند الانتقال إلى مقاس الدسكتوب (شريط جانبي ثابت) نغلق القائمة لتفادي حالة عالقة
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = (event) => { if (event.matches) setNavOpen(false) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // معرفة حالة التثبيت حتى لا نعرض خيار التثبيت داخل تطبيق مثبّت
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    const onChange = () => setStandalone(isStandalone())
    mq.addEventListener?.('change', onChange)
    window.addEventListener('appinstalled', onChange)
    return () => {
      mq.removeEventListener?.('change', onChange)
      window.removeEventListener('appinstalled', onChange)
    }
  }, [])

  const goTo = (id) => { onNavigate(id); setNavOpen(false) }

  return (
    <div className="app-shell">
      <div className={navOpen ? 'nav-overlay show' : 'nav-overlay'} onClick={closeNav} aria-hidden="true" />
      <aside id="app-nav" className={navOpen ? 'sidebar open' : 'sidebar'} aria-label="قائمة التنقل">
        <div className="sidebar-head">
          <div className="sidebar-brand"><div className="brand-mark small">ن</div><div><strong>نبض</strong><span>إدارة العيادات</span></div></div>
          <button type="button" className="nav-close" onClick={closeNav} aria-label="إغلاق القائمة">×</button>
        </div>
        <div className="drawer-profile">
          <div className="avatar" aria-hidden="true">م</div>
          <div className="drawer-profile-meta"><strong>{roleLabel}</strong><span>{clinicLabel}</span></div>
        </div>
        <nav>
          {visibleItems.map((item) => (
            <button key={item.id} className={active === item.id ? 'nav-item active' : 'nav-item'}
              aria-current={active === item.id ? 'page' : undefined} onClick={() => goTo(item.id)}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {!standalone && (
            <button type="button" className="install-entry" onClick={() => { requestInstallUi(); setNavOpen(false) }}>
               تثبيت التطبيق
            </button>
          )}
          <div className="support-note"><span className="status-dot" />النظام يعمل بشكل طبيعي</div>
          <button className="logout-button" onClick={() => logout(false)}>↪ تسجيل الخروج</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button type="button" className="menu-button" onClick={() => setNavOpen(true)}
            aria-label="فتح قائمة التنقل" aria-expanded={navOpen} aria-controls="app-nav">☰</button>
          <div className="topbar-title">
            <p className="eyebrow">{todayLabel()}</p>
            <h1>{currentLabel}</h1>
          </div>
          <div className="top-actions">
            <button className="icon-button" title="إنهاء جميع الجلسات" aria-label="إنهاء جميع الجلسات" onClick={() => logout(true)}></button>
            <div className="profile">
              <div className="avatar" aria-hidden="true">م</div>
              <div><strong>{roleLabel}</strong><span>{clinicLabel}</span></div>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  )
}