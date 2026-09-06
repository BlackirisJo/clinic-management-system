import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDate, ROLE_LABELS, USER_STATUS } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice } from '../components/ui'

// إدارة العيادات — متاحة لمدير النظام فقط (تُخفى القائمة لبقية الأدوار)
export default function ClinicsView() {
  const [clinics, setClinics] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [staffClinic, setStaffClinic] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.clinics.list()
      setClinics(result.clinics || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل العيادات')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>إدارة العيادات</h2><p>إضافة وتعديل عيادات المنشأة — كل عيادة تظهر لأطبائها فقط</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>+ إضافة عيادة</button>
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text="جارِ تحميل العيادات" /> : clinics.length === 0 ? <Empty text="لا توجد عيادات مسجلة" /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>اسم العيادة</th><th>الحالة</th><th>الموظفون</th><th>المرضى</th><th>تاريخ الإنشاء</th><th>إجراءات</th></tr>
            </thead>
            <tbody>
              {clinics.map((c) => (
                <tr key={c.clinic_id}>
                  <td>{c.clinic_id}</td>
                  <td>{c.clinic_name}</td>
                  <td>{c.is_active ? <span className="badge">نشطة</span> : <span className="muted-small">موقوفة</span>}</td>
                  <td>{c.staff_count}</td>
                  <td>{c.patients_count}</td>
                  <td>{fmtDate(c.created_at, true)}</td>
                  <td>
                    <button className="text-button" onClick={() => setStaffClinic(c)}>فريق العمل ←</button>
                    {' '}
                    <button className="text-button" onClick={() => setEditing(c)}>تعديل</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <ClinicForm
          onClose={() => setShowAdd(false)}
          onSaved={(created) => { setShowAdd(false); load(); if (created) setStaffClinic(created) }}
        />
      )}
      {editing && <ClinicForm clinic={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
      {staffClinic && <ClinicStaffModal clinic={staffClinic} onClose={() => { setStaffClinic(null); load() }} />}
    </section>
  )
}

function ClinicForm({ clinic, onClose, onSaved }) {
  const [form, setForm] = useState({ clinic_name: clinic?.clinic_name || '', is_active: clinic ? Boolean(clinic.is_active) : true })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (clinic) {
        await api.clinics.update(clinic.clinic_id, form)
        onSaved()
      } else {
        const result = await api.clinics.create({ clinic_name: form.clinic_name })
        onSaved(result.clinic)
      }
    } catch (err) {
      setError(err.message || 'تعذر حفظ العيادة')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={clinic ? 'تعديل العيادة' : 'إضافة عيادة جديدة'} subtitle="إدارة العيادات" onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="اسم العيادة" required>
          <input required minLength={2} maxLength={150} value={form.clinic_name} onChange={(e) => setForm({ ...form, clinic_name: e.target.value })} placeholder="مثال: عيادة النسائية والتوليد" />
        </Field>
        {clinic && (
          <Field label="حالة العيادة">
            <select value={form.is_active ? '1' : '0'} onChange={(e) => setForm({ ...form, is_active: e.target.value === '1' })}>
              <option value="1">نشطة</option>
              <option value="0">موقوفة</option>
            </select>
          </Field>
        )}
        {!clinic && <p className="profile-meta">بعد الحفظ يمكنك مباشرة إسناد الأطباء والممرضين لهذه العيادة حسب اختصاصهم.</p>}
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إلغاء</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ العيادة'}</button>
        </div>
      </form>
    </Modal>
  )
}

// نافذة فريق العمل: عرض وإسناد الأطباء والممرضين على العيادة — كل موظف يرى عيادته فقط
const STAFF_ROLES = ['DOCTOR', 'NURSE', 'RECEPTIONIST', 'ACCOUNTANT']

function ClinicStaffModal({ clinic, onClose }) {
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.clinics.staff(clinic.clinic_id)
      setStaff(result.staff || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل فريق العيادة')
    } finally { setLoading(false) }
  }, [clinic.clinic_id])

  useEffect(() => { load() }, [load])

  async function removeStaff(member) {
    if (!window.confirm(`هل تريد إزالة ${member.full_name} من هذه العيادة؟ سيفقد صلاحية الوصول إلى بياناتها.`)) return
    try {
      await api.clinics.removeStaff(clinic.clinic_id, member.user_id)
      load()
    } catch (err) {
      setError(err.message || 'تعذر إزالة الموظف')
    }
  }

  return (
    <Modal title={`فريق عمل: ${clinic.clinic_name}`} subtitle="إدارة العيادات" onClose={onClose} wide>
      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text="جارِ تحميل الفريق" /> : staff.length === 0 ? (
        <Empty text="لا يوجد موظفون مسندون لهذه العيادة بعد" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>التخصص</th><th>الحالة</th><th>إجراءات</th></tr></thead>
            <tbody>
              {staff.map((m) => {
                const st = USER_STATUS[m.status] || { label: m.status, cls: '' }
                return (
                  <tr key={m.user_id}>
                    <td>{m.full_name}</td>
                    <td dir="ltr">{m.username}</td>
                    <td>{ROLE_LABELS[m.role_name] || m.role_name}</td>
                    <td>{m.sub_specialty || '—'}</td>
                    <td><span className={`status ${st.cls}`}>{st.label}</span></td>
                    <td>
                      <button className="text-button" onClick={() => setEditing(m)}>تعديل</button>
                      {' '}
                      <button className="text-button danger" onClick={() => removeStaff(m)}>إزالة</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!showAdd && !editing && (
        <div className="modal-actions">
          <button className="primary-button" onClick={() => setShowAdd(true)}>+ إسناد موظف جديد للعيادة</button>
        </div>
      )}

      {showAdd && <StaffForm clinic={clinic} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {editing && <StaffForm clinic={clinic} member={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </Modal>
  )
}

function StaffForm({ clinic, member, onClose, onSaved }) {
  const isEdit = Boolean(member)
  const [form, setForm] = useState({
    full_name: member?.full_name || '',
    username: member?.username || '',
    password: '',
    role_name: member?.role_name || 'DOCTOR',
    sub_specialty: member?.sub_specialty || '',
    status: member?.status || 'ACTIVE',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (isEdit) {
        const payload = { full_name: form.full_name, sub_specialty: form.sub_specialty || undefined, status: form.status }
        if (form.password) payload.password = form.password
        await api.clinics.updateStaff(clinic.clinic_id, member.user_id, payload)
      } else {
        await api.clinics.addStaff(clinic.clinic_id, {
          full_name: form.full_name,
          username: form.username,
          password: form.password,
          role_name: form.role_name,
          sub_specialty: form.sub_specialty || undefined,
        })
      }
      onSaved()
    } catch (err) {
      setError(err.message || 'تعذر حفظ بيانات الموظف')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? `تعديل موظف: ${member.full_name}` : 'إسناد موظف جديد للعيادة'} subtitle={clinic.clinic_name} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label="الاسم الكامل" required>
            <input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </Field>
          <Field label="الدور" required>
            <select value={form.role_name} disabled={isEdit} onChange={(e) => setForm({ ...form, role_name: e.target.value })}>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="التخصص / الاختصاص" hint="مثال: نسائية وتوليد، باطنية، تمريض عام">
            <input maxLength={200} value={form.sub_specialty} onChange={(e) => setForm({ ...form, sub_specialty: e.target.value })} />
          </Field>
          {isEdit ? (
            <Field label="حالة الحساب">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE">نشط</option>
                <option value="SUSPENDED">موقوف</option>
                <option value="PASSWORD_RESET_REQUIRED">يتطلب تغيير كلمة المرور</option>
              </select>
            </Field>
          ) : (
            <Field label="اسم المستخدم للدخول" required>
              <input required dir="ltr" minLength={3} maxLength={100} pattern="[A-Za-z0-9_.\-]+" title="حروف إنجليزية وأرقام و . _ - فقط" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
          )}
        </div>
        <div className="form-row">
          <Field label={isEdit ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور'} required={!isEdit}>
            <input type="password" dir="ltr" minLength={12} maxLength={128} required={!isEdit} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إلغاء</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : isEdit ? 'حفظ التعديلات' : 'إسناد الموظف'}</button>
        </div>
      </form>
    </Modal>
  )
}