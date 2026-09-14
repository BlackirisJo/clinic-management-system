import { useState } from 'react'
import { api } from '../lib/api'
import { Modal, Field, Notice } from './ui'

// نافذة تغيير كلمة المرور — تُعرض إجبارياً عند تسجيل الدخول بحساب يملك
// is_force_password_change = TRUE (كالحسابات المؤقتة المنشأة من قبل الإدارة).
export default function ChangePasswordModal({ onDone }) {
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    const { current_password, new_password, confirm } = form
    if (new_password.length < 12) { setError('كلمة المرور الجديدة يجب أن تكون 12 حرفاً على الأقل'); return }
    if (new_password !== confirm) { setError('كلمتا المرور الجديدتان غير متطابقتين'); return }
    setSaving(true)
    try {
      await api.auth.changePassword({ current_password, new_password })
      setNotice('تم تغيير كلمة المرور بنجاح')
      setTimeout(() => onDone?.(), 900)
    } catch (err) {
      setError(err.message || 'تعذّر تغيير كلمة المرور')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="تغيير كلمة المرور" subtitle="يُطلب منك تحديث كلمة مرورك قبل المتابعة" onClose={null}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="كلمة المرور الحالية" required>
          <input required type="password" autoFocus value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />
        </Field>
        <Field label="كلمة المرور الجديدة" required hint="12 حرفاً على الأقل">
          <input required type="password" minLength={12} value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />
        </Field>
        <Field label="تأكيد كلمة المرور الجديدة" required>
          <input required type="password" minLength={12} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        {notice && <Notice kind="success">{notice}</Notice>}
        <div className="modal-actions">
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ كلمة المرور الجديدة'}</button>
        </div>
      </form>
    </Modal>
  )
}