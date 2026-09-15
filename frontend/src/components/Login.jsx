import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Notice } from './ui'

export default function Login() {
  const { login, sessionEndedMessage } = useAuth()
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      await login(form.username.trim(), form.password)
    } catch (err) {
      setError(err.message || 'بيانات الدخول غير صحيحة أو الخادم غير متاح')
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
          <Notice kind="error">{sessionEndedMessage}</Notice>

          <label>
            اسم المستخدم
            <input
              required
              type="text"
              name="username"
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              value={form.username}
              onChange={(e) =>
                setForm({ ...form, username: e.target.value })
              }
            />
          </label>

          <label>
            كلمة المرور
            <input
              required
              type="password"
              name="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) =>
                setForm({ ...form, password: e.target.value })
              }
            />
          </label>

          <Notice kind="error">{error}</Notice>

          <button
            className="primary-button"
            type="submit"
            disabled={loading}
          >
            {loading ? 'جارِ الدخول...' : 'دخول إلى النظام'}
          </button>
        </form>
      </section>

      <aside className="login-aside">
        <span>2026</span>
        <strong>
          رعاية أهدأ.
          <br />
          قرارات أوضح.
        </strong>
        <p>مساحة تشغيل موحدة لفرق العيادة والمرضى والتقارير.</p>
      </aside>
    </main>
  )
}