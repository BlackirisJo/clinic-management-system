import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { ROLE_LABELS, USER_STATUS, fmtDate, fmtRelative, fmtDateTime } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { useT } from '../i18n'

const LIMIT = 10
const ROLES = ['DOCTOR', 'NURSE', 'ACCOUNTANT', 'RECEPTIONIST', 'SYSTEM_ADMIN', 'SUPER_ADMIN']
// تحديث قائمة الاتصال (Online/Offline) أثناء فتح الشاشة — منفصل تماماً عن نبضة المستخدم الحالي
const PRESENCE_POLL_MS = 15000

export default function UsersView() {
  const { user } = useAuth()
  const t = useT()
  const [rows, setRows] = useState([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [sessionsOf, setSessionsOf] = useState(null)
  const [deleting, setDeleting] = useState(null)

  // حذف المستخدمين — حارس واجهة فقط؛ الحماية الحقيقية في الخادم (SUPER_ADMIN فقط، حسب الدور نفسه)
  const canDelete = user?.roleName === 'SUPER_ADMIN'

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const result = await api.users.list({ page, limit: LIMIT })
      setRows(result.users || [])
    } catch (err) {
      setError(err.message || t('users.loadError'))
      if (!silent) setRows([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page])

  useEffect(() => { load() }, [load])

  // تحديث دوري صامت للحضور (15 ثانية) — لا يُرسل heartbeat ولا يُعيد تحميل الصفحة
  useEffect(() => {
    const timer = setInterval(() => { load(true) }, PRESENCE_POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div>{t('users.title')}<p>{t('users.subtitle')}</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('users.create')}</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text={t('users.loading')} /> : rows.length === 0 ? <Empty text={t('users.empty')} /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('users.table.name')}</th><th>{t('users.table.username')}</th><th>{t('users.table.role')}</th><th>{t('users.table.clinic')}</th><th>{t('users.table.status')}</th><th>{t('users.table.license')}</th><th>{t('users.table.createdAt')}</th><th>{t('users.table.actions')}</th></tr></thead>
              <tbody>
                {rows.map((u) => {
                  const st = USER_STATUS[u.status] || { label: u.status, cls: '' }
                  return (
                    <tr key={u.user_id}>
                      <td>
                        <span className={`presence-dot ${u.is_online ? 'online' : 'offline'}`} aria-hidden="true" title={u.is_online ? t('users.online') : t('users.offline')} />
                        {u.full_name}
                      </td>
                      <td dir="ltr" data-label="اسم المستخدم">{u.username}</td>
                      <td data-label="الدور">{ROLE_LABELS[u.role_name] || u.role_name}</td>
                      <td data-label="العيادة">{u.clinic_name || '—'}</td>
                      <td data-label="الحالة"><span className={`status ${st.cls}`}>{st.label}</span></td>
                      <td data-label="الترخيص">{u.medical_license_no || '—'}</td>
                      <td data-label="تاريخ الإنشاء">{fmtDate(u.created_at)}</td>
                      <td className="cell-actions">
                        <button className="text-button" onClick={() => setSessionsOf(u)}>{t('users.action.sessions')}</button>
                        <button className="text-button" onClick={() => setEditing(u)}>{t('users.action.edit')}</button>
                        {canDelete && <button className="text-button danger" onClick={() => setDeleting(u)}>{t('users.action.delete')}</button>}
                      </td>
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
      {sessionsOf && <SessionsModal user={sessionsOf} onClose={() => setSessionsOf(null)} onChanged={() => load(true)} />}
      {deleting && <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} onSaved={() => { setDeleting(null); load() }} />}
    </section>
  )
}
function CreateUserModal({ onClose, onSaved }) {
  const t = useT()
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
      setError(err.message || t('users.create.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('users.create.title')} subtitle={t('users.create.subtitle')} onClose={onClose} wide>
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('users.create.fullName')} required><input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label={t('users.create.username')} required><input required dir="ltr" pattern="[A-Za-z0-9_.-]{3,}" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('users.create.password')} required hint={t('users.create.passwordHint')}><input required type="password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label={t('users.create.role')} required>
            <select required value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('users.create.clinic')} required hint={t('users.create.clinicHint')}>
            <select value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">{t('users.create.noClinic')}</option>
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          </Field>
          <Field label={t('users.create.phone')}><input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('users.create.medicalLicense')}><input value={form.medical_license_no} onChange={(e) => setForm({ ...form, medical_license_no: e.target.value })} /></Field>
          <Field label={t('users.create.specialty')}><input value={form.sub_specialty} onChange={(e) => setForm({ ...form, sub_specialty: e.target.value })} /></Field>
        </div>
        <Field label={t('users.create.directPhone')}><input dir="ltr" value={form.direct_phone} onChange={(e) => setForm({ ...form, direct_phone: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('users.create.saving') : t('users.create.submit')}</button>
        </div>
      </form>
    </Modal>
  )
}
function EditUserModal({ user, onClose, onSaved }) {
  const t = useT()
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
      setError(err.message || t('users.edit.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('users.edit.title', { name: form.full_name })} subtitle={t('users.edit.subtitle', { id: user.user_id })} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('users.edit.fullName')} required><input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
        <div className="form-row">
          <Field label={t('users.edit.phone')}><input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label={t('users.edit.clinic')} hint={t('users.edit.clinicHint')}>
            <select value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">{t('users.edit.noClinic')}</option>
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('users.edit.role')} required>
            <select required value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
            </select>
          </Field>
          <Field label={t('users.edit.status')} required>
            <select required value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="ACTIVE">{t('users.edit.statusActive')}</option>
              <option value="SUSPENDED">{t('users.edit.statusSuspended')}</option>
              <option value="PASSWORD_RESET_REQUIRED">{t('users.edit.statusReset')}</option>
            </select>
          </Field>
        </div>
        <Field label={t('users.edit.newPassword')} hint={t('users.edit.newPasswordHint')}><input type="password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('users.edit.saving') : t('users.edit.submit')}</button>
        </div>
      </form>
    </Modal>
  )
}

// نافذة إدارة جلسات مستخدم محدد — عرض كل جلسة ككيان مستقل وإنهاء ما يُختار منها فقط
function SessionsModal({ user: target, onClose, onChanged }) {
  const t = useT()
  const [sessions, setSessions] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const [confirmOne, setConfirmOne] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const result = await api.users.sessions(target.user_id)
      setSessions(result.sessions || [])
    } catch (err) {
      setError(err.message || t('users.sessions.loadError'))
      setSessions([])
    }
  }, [target.user_id])

  useEffect(() => { load() }, [load])

  async function revoke(sessionId) {
    setBusy(true)
    setError('')
    try {
      await api.users.revokeSession(target.user_id, sessionId)
      setConfirmOne(null)
      await load()
      onChanged()
    } catch (err) {
      setError(err.message || t('users.sessions.endError'))
    } finally {
      setBusy(false)
    }
  }

  async function revokeAll() {
    setBusy(true)
    setError('')
    try {
      await api.users.revokeAllSessions(target.user_id)
      setConfirmAll(false)
      await load()
      onChanged()
    } catch (err) {
      setError(err.message || t('users.sessions.endAllError'))
    } finally {
      setBusy(false)
    }
  }

  const activeSessions = (sessions || []).filter((s) => !s.revoked_at)

  return (
    <Modal title={t('users.sessions.title', { name: target.full_name })} subtitle={t('users.sessions.subtitle')} onClose={onClose}>
      {sessions === null ? <Loading text={t('users.sessions.loading')} /> : (
        <div className="sessions-list">
          {sessions.length === 0 ? <Empty text={t('users.sessions.empty')} /> : sessions.map((s) => (
            <div key={s.session_id} className={`session-item${s.revoked_at ? ' revoked' : ''}`}>
              <div className="session-head">
                <span className={`presence-dot ${s.revoked_at || !s.is_online ? 'offline' : 'online'}`} aria-hidden="true" />
                <strong>{s.device}</strong>
                <span className={`status ${s.revoked_at ? 'cancelled' : s.is_online ? 'completed' : 'scheduled'}`}>
                  {s.revoked_at ? t('users.sessions.ended') : s.is_online ? t('users.sessions.online') : t('users.sessions.offline')}
                </span>
              </div>
              <div className="session-meta">
                <span>آخر نشاط: {fmtRelative(s.last_seen_at)}</span>
                <span>بدأت: {fmtDateTime(s.created_at)}</span>
                <span>تنتهي: {fmtDateTime(s.expires_at)}</span>
                <span>IP: {s.ip_address || '—'}</span>
              </div>
              {confirmOne === s.session_id ? (
                <div className="session-confirm">
                  <p>{t('users.sessions.confirmEnd')}</p>
                  <div className="modal-actions">
                    <button type="button" className="secondary-button compact" onClick={() => setConfirmOne(null)}>{t('common.cancel')}</button>
                    <button className="primary-button compact" disabled={busy} onClick={() => revoke(s.session_id)}>{busy ? t('users.sessions.executing') : t('users.sessions.confirm')}</button>
                  </div>
                </div>
              ) : (
                !s.revoked_at && (
                  <div className="session-actions">
                    <button type="button" className="text-button danger" onClick={() => setConfirmOne(s.session_id)}>{t('users.sessions.end')}</button>
                  </div>
                )
              )}
            </div>
          ))}
          <Notice kind="error">{error}</Notice>
          {activeSessions.length > 0 && (
            confirmAll ? (
              <div className="session-confirm">
                <p>{t('users.sessions.endAllWarning', { count: activeSessions.length })}</p>
                <div className="modal-actions">
                  <button type="button" className="secondary-button compact" onClick={() => setConfirmAll(false)}>{t('common.cancel')}</button>
                  <button className="primary-button compact" disabled={busy} onClick={revokeAll}>{busy ? t('users.sessions.executing') : t('users.sessions.confirmEndAll')}</button>
                </div>
              </div>
            ) : (
              <div className="modal-actions">
                <button type="button" className="secondary-button compact" onClick={() => setConfirmAll(true)}>{t('users.sessions.endAll')}</button>
              </div>
            )
          )}
        </div>
      )}
    </Modal>
  )
}

// حذف المستخدم (Soft Delete في الخادم): تعطيل الحساب + إنهاء جميع جلساته + إخفاؤه من القائمة.
// تأكيد بكتابة اسم المستخدم — والسجلات الطبية والتاريخية تبقى محفوظة دون أي تغيير.
function DeleteUserModal({ user: target, onClose, onSaved }) {
  const t = useT()
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const matched = confirmText.trim() === target.username

  async function submit() {
    setBusy(true)
    setError('')
    try {
      await api.users.remove(target.user_id)
      onSaved()
    } catch (err) {
      setError(err.message || t('users.delete.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('users.delete.title', { name: target.full_name })} subtitle={t('users.delete.subtitle')} onClose={onClose}>
      <div className="danger-note">
        <p>{t('users.delete.warning')}</p>
        <p>{t('users.delete.historyWarning')}</p>
      </div>
      <form className="patient-form" onSubmit={(e) => { e.preventDefault(); if (matched && !busy) submit() }}>
        <Field label={t('users.delete.confirmLabel')} required hint={t('users.delete.confirmHint', { username: target.username })}>
          <input dir="ltr" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary-button danger" disabled={!matched || busy}>{busy ? t('users.delete.executing') : t('users.delete.submit')}</button>
        </div>
      </form>
    </Modal>
  )
}