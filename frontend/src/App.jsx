import { useState } from 'react'
import './App.css'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './components/Login'
import Layout, { navItemsForRole } from './components/Layout'
import OverviewView from './views/OverviewView'
import PatientsView from './views/PatientsView'
import AppointmentsView from './views/AppointmentsView'
import PrescriptionsView from './views/PrescriptionsView'
import BillingView from './views/BillingView'
import ReportsView from './views/ReportsView'
import UsersView from './views/UsersView'
import BackupsView from './views/BackupsView'
import ClinicsView from './views/ClinicsView'

const VIEWS = {
  overview: OverviewView,
  patients: PatientsView,
  appointments: AppointmentsView,
  prescriptions: PrescriptionsView,
  billing: BillingView,
  reports: ReportsView,
  clinics: ClinicsView,
  users: UsersView,
  backups: BackupsView,
}

function Shell() {
  const { user, initializing } = useAuth()
  const [active, setActive] = useState(null)

  if (initializing) {
    return (
      <div className="loading-state fullscreen">
        <span className="loader" />جارِ تجهيز الجلسة...
      </div>
    )
  }
  if (!user) return <Login />

  // الافتراضي أول قسم مسموح لدور المستخدم (الطبيب يبدأ بالمرضى، المحاسب بالنظرة العامة...)
  const allowed = navItemsForRole(user?.roleName)
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
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}