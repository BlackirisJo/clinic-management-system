import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, setAuthToken, setUnauthorizedHandler } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('clinic_token') || null)
  const [user, setUser] = useState(null)
  const [initializing, setInitializing] = useState(Boolean(localStorage.getItem('clinic_token')))

  const clearSession = useCallback(() => {
    localStorage.removeItem('clinic_token')
    setAuthToken(null)
    setToken(null)
    setUser(null)
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

  // استقبال انتهاء صلاحية الجلسة من أي طلب
  const clearRef = useRef(clearSession)
  clearRef.current = clearSession
  useEffect(() => {
    setUnauthorizedHandler(() => clearRef.current())
    return () => setUnauthorizedHandler(null)
  }, [])

  const login = useCallback(async (username, password) => {
    const data = await api.auth.login({ username, password })
    localStorage.setItem('clinic_token', data.token)
    setAuthToken(data.token)
    setToken(data.token)
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
    <AuthContext.Provider value={{ token, user, initializing, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export default AuthProvider