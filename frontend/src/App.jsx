import { useState } from 'react'
import './App.css'
import './styles/responsive.css'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { I18nProvider } from './i18n'
import Login from './components/Login'
import Layout, { navItemsForRole } from './components/Layout'
import ChangePasswordModal from './components/ChangePasswordModal'
import InstallPrompt from './components/InstallPrompt'
import UpdateNotice from './components/UpdateNotice'
import OverviewView from './views/OverviewView'
import PatientsView from './views/PatientsView'
import AppointmentsView from './views/AppointmentsView'
import PrescriptionsView from './views/PrescriptionsView'
import BillingView from './views/BillingView'
import ReportsView from './views/ReportsView'
import SystemLogsView from './views/SystemLogsView'
import UsersView from './views/UsersView'
import BackupsView from './views/BackupsView'
import ClinicsView from './views/ClinicsView'
import PermissionsView from './views/PermissionsView'

const VIEWS = {
  overview: OverviewView,
  patients: PatientsView,
  appointments: AppointmentsView,
  prescriptions: PrescriptionsView,
  billing: BillingView,
  reports: ReportsView,
  logs: SystemLogsView,
  clinics: ClinicsView,
  users: UsersView,
  backups: BackupsView,
  permissions: PermissionsView,
}

function Shell() {
  const { user, initializing, refresh } = useAuth()
  const [active, setActive] = useState(null)

  if (initializing) {
    return (
      <div className="loading-state fullscreen">
        <span className="loader" />جارِ تجهيز الجلسة...
      </div>
    )
  }
  if (!user) return <Login />

  // الحسابات المؤقتة يُجبر مستخدمها على تغيير كلمة المرور قبل أي عمل آخر
  if (user.is_force_password_change) {
    return <ChangePasswordModal onDone={() => refresh()} />
  }

  // الافتراضي أول قسم مسموح لدور المستخدم (الطبيب يبدأ بالمرضى، المحاسب بالنظرة العامة...)
  const allowed = navItemsForRole(user?.roleName, user?.permissions || [])
  const current = allowed.some((item) => item.id === active) ? active : (allowed[0]?.id || 'patients')
  const ActiveView = VIEWS[current] || PatientsView
  return (
    <Layout active={current} onNavigate={setActive}>
      <ActiveView onNavigate={setActive} />
    </Layout>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <Shell />
        {/* واجهات PWA: دعوة التثبيت وإشعار التحديث (لا تظهر في الوضع المثبّت/التطوير) */}
        <InstallPrompt />
        <UpdateNotice />
      </AuthProvider>
    </I18nProvider>
  )
}