import { useState } from 'react'
import { useT } from '../i18n'
import { api } from '../lib/api'
import { Modal, Field, Notice } from './ui'

// نافذة تغيير كلمة المرور — تُعرض إجبارياً عند تسجيل الدخول بحساب يملك
// is_force_password_change = TRUE (كالحسابات المؤقتة المنشأة من قبل الإدارة).
export default function ChangePasswordModal({ onDone }) {
  const t = useT()
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    const { current_password, new_password, confirm } = form
    if (new_password.length < 12) { setError(t('changePassword.tooShort')); return }
    if (new_password !== confirm) { setError(t('changePassword.mismatch')); return }
    setSaving(true)
    try {
      await api.auth.changePassword({ current_password, new_password })
      setNotice(t('changePassword.success'))
      setTimeout(() => onDone?.(), 900)
    } catch (err) {
      setError(err.message || t('changePassword.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('changePassword.title')} subtitle={t('changePassword.subtitle')} onClose={null}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('changePassword.current')} required>
          <input required type="password" autoFocus value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />
        </Field>
        <Field label={t('changePassword.new')} required hint={t('changePassword.hint')}>
          <input required type="password" minLength={12} value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />
        </Field>
        <Field label={t('changePassword.confirm')} required>
          <input required type="password" minLength={12} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        {notice && <Notice kind="success">{notice}</Notice>}
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('changePassword.submit')}</button>
        </div>
      </form>
    </Modal>
  )
}