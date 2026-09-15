import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { ROLE_LABELS, USER_STATUS, fmtDate } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'

const LIMIT = 10
const ROLES = ['DOCTOR', 'NURSE', 'ACCOUNTANT', 'RECEPTIONIST', 'SYSTEM_ADMIN', 'SUPER_ADMIN']

export default function UsersView() {
  const [rows, setRows] = useState([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.users.list({ page, limit: LIMIT })
      setRows(result.users || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل المستخدمين — قد لا تملك صلاحية إدارة المستخدمين')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>إدارة المستخدمين</h2><p>الحسابات والأدوار والصلاحيات</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ إنشاء مستخدم</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text="جارِ تحميل المستخدمين" /> : rows.length === 0 ? <Empty text="لا يوجد مستخدمون" /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>العيادة</th><th>الحالة</th><th>الترخيص</th><th>تاريخ الإنشاء</th><th>إجراءات</th></tr></thead>
              <tbody>
                {rows.map((u) => {
                  const st = USER_STATUS[u.status] || { label: u.status, cls: '' }
                  return (
                    <tr key={u.user_id}>
                      <td>{u.full_name}</td>
                      <td dir="ltr" data-label="اسم المستخدم">{u.username}</td>
                      <td data-label="الدور">{ROLE_LABELS[u.role_name] || u.role_name}</td>
                      <td data-label="العيادة">{u.clinic_name || '—'}</td>
                      <td data-label="الحالة"><span className={`status ${st.cls}`}>{st.label}</span></td>
                      <td data-label="الترخيص">{u.medical_license_no || '—'}</td>
                      <td data-label="تاريخ الإنشاء">{fmtDate(u.created_at)}</td>
                      <td className="cell-actions"><button className="text-button" onClick={() => setEditing(u)}>تعديل</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} />
        </>
      )}

      {showAdd && <CreateUserModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </section>
  )
}
function CreateUserModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    full_name: '', username: '', password: '', role_name: 'DOCTOR', clinic_id: '',
    phone: '', medical_license_no: '', sub_specialty: '', direct_phone: '',
  })
  const [clinics, setClinics] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.clinics.directory()
      .then((r) => setClinics(r.clinics || []))
      .catch(() => setClinics([]))
  }, [])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.users.create({
        full_name: form.full_name,
        username: form.username,
        password: form.password,
        role_name: form.role_name,
        clinic_id: form.clinic_id ? Number(form.clinic_id) : null,
        phone: form.phone || undefined,
        medical_license_no: form.medical_license_no || undefined,
        sub_specialty: form.sub_specialty || undefined,
        direct_phone: form.direct_phone || undefined,
      })
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر إنشاء المستخدم')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="إنشاء مستخدم جديد" subtitle="إدارة المستخدمين" onClose={onClose} wide>
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="الاسم الكامل" required><input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="اسم المستخدم" required><input required dir="ltr" pattern="[A-Za-z0-9_.-]{3,}" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="كلمة المرور" required hint="12 حرفاً على الأقل"><input required type="password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="الدور" required>
            <select required value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="العيادة الأساسية" hint="اختر العيادة بالاسم — اختياري للمدير العام">
            <select value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">بدون عيادة (تُسند لاحقاً)</option>
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          </Field>
          <Field label="الهاتف"><input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="رقم الترخيص الطبي"><input value={form.medical_license_no} onChange={(e) => setForm({ ...form, medical_license_no: e.target.value })} /></Field>
          <Field label="التخصص الدقيق"><input value={form.sub_specialty} onChange={(e) => setForm({ ...form, sub_specialty: e.target.value })} /></Field>
        </div>
        <Field label="هاتف مباشر"><input dir="ltr" value={form.direct_phone} onChange={(e) => setForm({ ...form, direct_phone: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الإنشاء...' : 'إنشاء المستخدم'}</button>
        </div>
      </form>
    </Modal>
  )
}
function EditUserModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({
    full_name: user.full_name || '',
    phone: user.phone || '',
    status: user.status || 'ACTIVE',
    role_name: user.role_name || 'DOCTOR',
    clinic_id: user.clinic_id != null ? String(user.clinic_id) : '',
    password: '',
  })
  const [clinics, setClinics] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.clinics.directory()
      .then((r) => setClinics(r.clinics || []))
      .catch(() => setClinics([]))
  }, [])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const body = {
        full_name: form.full_name,
        phone: form.phone || undefined,
        status: form.status,
        role_name: form.role_name,
        clinic_id: form.clinic_id ? Number(form.clinic_id) : null,
      }
      if (form.password) body.password = form.password
      await api.users.update(user.user_id, body)
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر تعديل المستخدم')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={`تعديل ${form.full_name}`} subtitle={`حساب #${user.user_id}`} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="الاسم الكامل" required><input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
        <div className="form-row">
          <Field label="الهاتف"><input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="العيادة الأساسية" hint="اختر العيادة بالاسم">
            <select value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">بدون عيادة</option>
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="الدور" required>
            <select required value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
            </select>
          </Field>
          <Field label="الحالة" required>
            <select required value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="ACTIVE">نشط</option>
              <option value="SUSPENDED">موقوف</option>
              <option value="PASSWORD_RESET_REQUIRED">يتطلب تغيير كلمة المرور</option>
            </select>
          </Field>
        </div>
        <Field label="كلمة مرور جديدة" hint="إعادة تعيين كلمة المرور (12 حرفاً على الأقل)"><input type="password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ التعديلات'}</button>
        </div>
      </form>
    </Modal>
  )
}