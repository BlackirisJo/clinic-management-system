import { useState } from 'react'
import './App.css'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './components/Login'
import Layout from './components/Layout'
import OverviewView from './views/OverviewView'
import PatientsView from './views/PatientsView'
import AppointmentsView from './views/AppointmentsView'
import PrescriptionsView from './views/PrescriptionsView'
import BillingView from './views/BillingView'
import ReportsView from './views/ReportsView'
import UsersView from './views/UsersView'
import BackupsView from './views/BackupsView'

const VIEWS = {
  overview: OverviewView,
  patients: PatientsView,
  appointments: AppointmentsView,
  prescriptions: PrescriptionsView,
  billing: BillingView,
  reports: ReportsView,
  users: UsersView,
  backups: BackupsView,
}

function Shell() {
  const { user, initializing } = useAuth()
  const [active, setActive] = useState('overview')

  if (initializing) {
    return (
      <div className="loading-state fullscreen">
        <span className="loader" />جارِ تجهيز الجلسة...
      </div>
    )
  }
  if (!user) return <Login />

  const ActiveView = VIEWS[active] || OverviewView
  return (
    <Layout active={active} onNavigate={setActive}>
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