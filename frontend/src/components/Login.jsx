import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Notice } from './ui'
import LanguageSwitcher from './LanguageSwitcher'
import { useT } from '../i18n'

export default function Login() {
  const { login, sessionEndedMessage } = useAuth()
  const t = useT()
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
      setError(err.message || t('login.error.generic'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <LanguageSwitcher variant="login" />
        <div className="brand-mark">{t('brand.mark')}</div>
        <p className="eyebrow">{t('login.eyebrow')}</p>
        <h1>{t('login.title')}</h1>
        <p className="muted">{t('login.subtitle')}</p>

        <form onSubmit={submit} className="login-form">
          <Notice kind="error">{sessionEndedMessage}</Notice>

          <label>
            {t('login.username')}
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
            {t('login.password')}
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
            {loading ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
      </section>

      <aside className="login-aside">
        <span>2026</span>
        <strong>
          {t('login.aside.titleLine1')}
          <br />
          {t('login.aside.titleLine2')}
        </strong>
        <p>{t('login.aside.text')}</p>
      </aside>
    </main>
  )
}