import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, setAuthToken, setUnauthorizedHandler } from '../lib/api'

// نبضة الحضور: كل 20 ثانية تقريباً — أقل بكثير من نافذة الـ 60 ثانية في الخادم
const HEARTBEAT_INTERVAL_MS = 20000

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('clinic_token') || null)
  const [user, setUser] = useState(null)
  const [initializing, setInitializing] = useState(Boolean(localStorage.getItem('clinic_token')))
  // رسالة نهاية الجلسة (تظهر في شاشة الدخول) — مثل: تم إنهاء جلستك من قبل مدير النظام
  const [sessionEndedMessage, setSessionEndedMessage] = useState('')

  const clearSession = useCallback((reason) => {
    localStorage.removeItem('clinic_token')
    setAuthToken(null)
    setToken(null)
    setUser(null)
    setSessionEndedMessage(typeof reason === 'string' ? reason : '')
  }, [])

  // تحديث بيانات المستخدم من الخادم (مثل مسح علامة is_force_password_change بعد تغيير كلمة المرور)
  const refresh = useCallback(async () => {
    const me = await api.auth.me()
    setUser(me.user)
    return me.user
  }, [])

  // مزامنة التوكن مع طبقة الـ API
  useEffect(() => {
    setAuthToken(token)
  }, [token])

  // تحميل بيانات المستخدم عند وجود توكن
  useEffect(() => {
    if (!token) {
      setInitializing(false)
      return
    }
    let cancelled = false
    api.auth
      .me()
      .then((data) => { if (!cancelled) { setUser(data.user); setInitializing(false) } })
      .catch(() => { if (!cancelled) { clearSession(); setInitializing(false) } })
    return () => { cancelled = true }
  }, [token, clearSession])

  // استقبال انتهاء صلاحية الجلسة من أي طلب (401 أو إنهاء من قبل مدير عبر SESSION_REVOKED)
  const clearRef = useRef(clearSession)
  clearRef.current = clearSession
  useEffect(() => {
    setUnauthorizedHandler((message) => clearRef.current(message || 'انتهت صلاحية جلستك، يرجى تسجيل الدخول من جديد'))
    return () => setUnauthorizedHandler(null)
  }, [])

  // نبضة الحضور (Heartbeat) — في طبقة المصادقة المركزية وليس داخل أي شاشة:
  // - كل 20 ثانية طالما توجد جلسة صالحة
  // - فوراً عند العودة من الخلفية (visibilitychange) وعند استعادة الاتصال (online)
  // - مؤقّت واحد فقط لكل جلسة، ويُنظّف تلقائياً عند تسجيل الخروج أو تغيّر الجلسة
  useEffect(() => {
    if (!token) return undefined
    const beat = () => { api.auth.heartbeat().catch(() => { /* انقطاع شبكة عابر — الـ 401/403 يُعالجان مركزياً */ }) }
    beat()
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') beat() }
    const onOnline = () => beat()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [token])

  const login = useCallback(async (username, password) => {
    const data = await api.auth.login({ username, password })
    localStorage.setItem('clinic_token', data.token)
    setAuthToken(data.token)
    setToken(data.token)
    setSessionEndedMessage('')
    const me = await api.auth.me()
    setUser(me.user)
    return me.user
  }, [])

  const logout = useCallback(async (revokeAll = false) => {
    try {
      if (revokeAll) await api.auth.logoutAll()
      else await api.auth.logout()
    } catch { /* الجلسة منتهية محلياً */ }
    clearSession()
  }, [clearSession])

  return (
    <AuthContext.Provider
      value={{ token, user, initializing, login, logout, refresh, sessionEndedMessage, hasPermission: (key) => hasPermission(user, key) }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// نظام صلاحيات مركزي للواجهة (مرحلة 18) — لتحسين UX فقط، الحماية الحقيقية في الخادم
export function hasPermission(user, permissionKey) {
  if (!user) return false
  if (user.roleName === 'SUPER_ADMIN' || user.roleName === 'SYSTEM_ADMIN') return true
  return (user.permissions || []).includes(permissionKey)
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export default AuthProvider