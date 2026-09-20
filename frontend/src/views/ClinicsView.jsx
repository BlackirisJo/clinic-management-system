import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import { fmtDate } from "../lib/format"
import { useT } from "../i18n"
import { ROLE_LABELS, USER_STATUS } from "../lib/format"
import { Modal, Field, Loading, Empty, Notice } from "../components/ui"

// إدارة العيادات — متاحة لمدير النظام فقط
export default function ClinicsView() {
  const t = useT()
  const [clinics, setClinics] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [staffClinic, setStaffClinic] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const result = await api.clinics.list()
      setClinics(result.clinics || [])
    } catch (err) { setError(err.message || t('clinics.loadError')) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('clinics.title')}</h2><p>{t('clinics.subtitle')}</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('clinics.add')}</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text={t('clinics.loading')} /> : clinics.length === 0 ? <Empty text={t('clinics.empty')} /> : (
        <div className="table-wrap table-cards"><table><thead><tr><th>{t('clinics.col.num')}</th><th>{t('clinics.col.name')}</th><th>{t('clinics.col.specialty')}</th><th>{t('clinics.col.status')}</th><th>{t('clinics.col.staff')}</th><th>{t('clinics.col.patients')}</th><th>{t('clinics.col.created')}</th><th>{t('clinics.col.actions')}</th></tr></thead><tbody>
          {clinics.map((c) => (
            <tr key={c.clinic_id}>
              <td className="hide-sm" data-label={t('clinics.col.num')}>{c.clinic_id}</td>
              <td className="cell-title">{c.clinic_name}</td>
              <td data-label={t('clinics.col.specialty')}>{c.specialty_name ? <span className="badge">{c.specialty_name}</span> : <span className="muted-small">{t('clinics.unknownSpecialty')}</span>}</td>
              <td data-label={t('clinics.col.status')}>{c.is_active ? <span className="badge">{t('clinics.status.active')}</span> : <span className="muted-small">{t('clinics.status.suspended')}</span>}</td>
              <td data-label={t('clinics.col.staff')}>{c.staff_count}</td>
              <td data-label={t('clinics.col.patients')}>{c.patients_count}</td>
              <td data-label={t('clinics.col.created')}>{fmtDate(c.created_at, true)}</td>
              <td className="cell-actions">
                <button className="text-button" onClick={() => setStaffClinic(c)}>{t('clinics.viewStaff')}</button>
                <button className="text-button" onClick={() => setEditing(c)}>{t('clinics.edit')}</button>
              </td>
            </tr>
          ))}</tbody></table></div>
      )}
      {showAdd && <ClinicForm onClose={() => setShowAdd(false)} onSaved={(created) => { setShowAdd(false); load(); if (created) setStaffClinic(created) }} />}
      {editing && <ClinicForm clinic={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
      {staffClinic && <ClinicStaffModal clinic={staffClinic} onClose={() => { setStaffClinic(null); load() }} />}
    </section>
  )
}

// نموذج إنشاء/تعديل العيادة: الاسم + التخصص + الأطباء + الممرضون
function ClinicForm({ clinic, onClose, onSaved }) {
  const t = useT()
  const isEdit = Boolean(clinic)
  const [form, setForm] = useState({ clinic_name: '', specialty_id: '', is_active: true })
  const [specialties, setSpecialties] = useState([])
  const [doctors, setDoctors] = useState([])
  const [nurses, setNurses] = useState([])
  const [assigned, setAssigned] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingData, setLoadingData] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const specResult = await api.clinical.specialties()
        if (!cancelled) setSpecialties(specResult.specialties || [])
        if (isEdit) {
          const detail = await api.clinics.get(clinic.clinic_id)
          if (cancelled) return
          setAssigned(detail.staff || [])
          setDoctors((detail.doctors || []).map((m) => m.user_id))
          setNurses((detail.nurses || []).map((m) => m.user_id))
          setForm({
            clinic_name: detail.clinic.clinic_name || '',
            specialty_id: detail.clinic.specialty_id ? String(detail.clinic.specialty_id) : '',
            is_active: Boolean(detail.clinic.is_active),
          })
        }
      } catch (err) { setError(err.message || t('clinics.form.loadError')) }
      finally { if (!cancelled) setLoadingData(false) }
    }
    boot()
    return () => { cancelled = true }
  }, [isEdit, clinic?.clinic_id])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (isEdit) {
        await api.clinics.update(clinic.clinic_id, {
          clinic_name: form.clinic_name,
          specialty_id: form.specialty_id ? Number(form.specialty_id) : null,
          is_active: form.is_active,
          doctor_ids: doctors,
          nurse_ids: nurses,
        })
        onSaved()
      } else {
        const result = await api.clinics.create({
          clinic_name: form.clinic_name,
          specialty_id: Number(form.specialty_id),
          doctor_ids: doctors,
          nurse_ids: nurses,
        })
        onSaved(result.clinic)
      }
    } catch (err) {
      setError(err.message || t('clinics.form.saveError'))
    } finally { setSaving(false) }
  }

  const selectedSpecialty = specialties.find((s) => String(s.specialty_id) === String(form.specialty_id))

  return (
    <Modal title={isEdit ? t('clinics.modal.editTitle') : t('clinics.modal.createTitle')} subtitle={t('clinics.subtitle')} onClose={onClose} wide>
      {loadingData ? <Loading text={t('clinics.form.loadingSpecialties')} /> : (
        <form className="patient-form" onSubmit={submit}>
          <div className="form-row">
            <Field label={t('clinics.form.name')} required>
              <input required minLength={2} maxLength={150} value={form.clinic_name} onChange={(e) => setForm({ ...form, clinic_name: e.target.value })} placeholder={t('clinics.form.namePlaceholder')} />
            </Field>
            <Field label={t('clinics.form.specialty')} required hint={t('clinics.form.specialtyHint')}>
              <select required value={form.specialty_id} onChange={(e) => setForm({ ...form, specialty_id: e.target.value })}>
                <option value={''}>{t('clinics.form.specialtyPlaceholder')}</option>
                {specialties.map((s) => <option key={s.specialty_id} value={s.specialty_id}>{s.name_ar}</option>)}
              </select>
            </Field>
          </div>

          {selectedSpecialty?.module?.workflow?.length ? (
            <div className="specialty-workflow">
              <strong>{t('clinics.workflow.title', { name: selectedSpecialty.name_ar })}:</strong>
              <div className="workflow-chips">
                {selectedSpecialty.module.workflow.map((step, i) => <span className="chip" key={i}>{step}</span>)}
              </div>
            </div>
          ) : null}

          <StaffPicker title={t('clinics.staff.doctors')} role="DOCTOR" selected={doctors}
            onToggle={(id) => setDoctors((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])}
            assigned={assigned.filter((m) => m.role_name === 'DOCTOR')} />
          <StaffPicker title={t('clinics.staff.nurses')} role="NURSE" selected={nurses}
            onToggle={(id) => setNurses((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])}
            assigned={assigned.filter((m) => m.role_name === 'NURSE')} />

          {isEdit && (
            <Field label={t('clinics.form.status')}>
              <select value={form.is_active ? '1' : '0'} onChange={(e) => setForm({ ...form, is_active: e.target.value === '1' })}>
                <option value="1">{t('clinics.status.active')}</option>
                <option value="0">{t('clinics.status.suspended')}</option>
              </select>
            </Field>
          )}
          <Notice kind="error">{error}</Notice>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>{t('clinics.close')}</button>
            <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('clinics.save')}</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

// منتقي طاقم (أطباء/ممرضون) داخل نموذج العيادة: تحميل المستخدمين من الدور المطلوب مع بحث وتبديل
function StaffPicker({ title, role, selected = [], onToggle, assigned = [] }) {
  const t = useT()
  const [users, setUsers] = useState([])
  const [search, setSearch] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    api.users.list({ limit: 200 })
      .then((r) => { if (!cancelled) setUsers(r.users || []) })
      .catch((err) => { if (!cancelled) setError(err.message || t('clinics.staff.loadError')) })
    return () => { cancelled = true }
  }, [])

  // دمج موظفي العيادة الحاليين مع قائمة المستخدمين المتاحة في النظام (نفس الدور فقط)
  const roleUsers = users.filter((u) => u.role_name === role)
  const merged = [
    ...roleUsers,
    ...assigned.filter((m) => !roleUsers.some((u) => u.user_id === m.user_id)),
  ]
  const q = search.trim().toLowerCase()
  const rows = merged
    .filter((u) => !q || (u.full_name || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q))
    .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""), "ar"))

  return (
    <div className="staff-picker">
      <h4>{title}</h4>
      {error && <Notice kind="error">{error}</Notice>}
      <input className="input" type="search" placeholder={t('clinics.staff.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="staff-picker-list">
        {rows.length === 0 ? <Empty text={t('clinics.staff.noRoleUsers')} /> : rows.map((u) => {
          const isSelected = selected.includes(u.user_id)
          return (
            <label className={`staff-option${isSelected ? " selected" : ""}`} key={u.user_id}>
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(u.user_id)} />
              <span>{u.full_name || u.username}</span>
              <small>{u.username}</small>
              {isSelected ? <span className="badge">{t('clinics.staff.selected')}</span> : null}
            </label>
          )
        })}
        {users.length === 0 && !error && <Empty text={t('clinics.staff.loading')} />}
      </div>
    </div>
  )
}
function ClinicStaffModal({ clinic, onClose }) {
  const t = useT()
  const [staff, setStaff] = useState([])
  const [clinicDetail, setClinicDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [showAssign, setShowAssign] = useState(false)
  const [roleFilter, setRoleFilter] = useState("DOCTOR")
  const [assignSearch, setAssignSearch] = useState("")
  const [candidates, setCandidates] = useState(null)
  const [selectedId, setSelectedId] = useState("")
  const [assigning, setAssigning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const result = await api.clinics.get(clinic.clinic_id)
      setClinicDetail(result.clinic || null)
      setStaff(result.staff || [])
    }
    catch (err) { setError(err.message || t('clinics.staffModal.loadError')) }
    finally { setLoading(false) }
  }, [clinic.clinic_id])

  useEffect(() => { load() }, [load])

  async function removeStaff(member) {
    if (!window.confirm(t('clinics.staffModal.confirmRemove', { name: member.full_name }))) return
    try { await api.clinics.removeStaff(clinic.clinic_id, member.user_id); load() }
    catch (err) { setError(err.message || t('clinics.staffModal.removeError')) }
  }

  // تحميل قائمة المستخدمين المرشحين حسب الدور المختار
  async function loadCandidates(role) {
    setCandidates(null); setSelectedId("")
    try {
      const result = await api.users.list({ role, status: "ACTIVE", limit: 200 })
      const list = (result.users || []).filter((u) => !staff.some((s) => s.user_id === u.user_id))
      setCandidates(list)
    } catch (err) { setError(err.message || t('clinics.staffModal.loadCandidatesError')) }
  }

  function openAssign() {
    setShowAssign(true)
    loadCandidates(roleFilter)
  }

  function changeRoleFilter(role) {
    setRoleFilter(role)
    loadCandidates(role)
  }

  const filteredCandidates = (candidates || []).filter((u) => !assignSearch || u.full_name?.includes(assignSearch) || u.username?.toLowerCase().includes(assignSearch.toLowerCase()))

  async function assignUser() {
    if (!selectedId) return
    setAssigning(true); setError("")
    try {
      await api.clinics.addStaff(clinic.clinic_id, { user_id: Number(selectedId) })
      setSelectedId(""); setShowAssign(false); load()
    } catch (err) { setError(err.message || t('clinics.staffModal.assignError')) }
    finally { setAssigning(false) }
  }

  return (
    <Modal title={t('clinics.staffModal.title', { name: clinic.clinic_name })} subtitle={clinicDetail?.specialty_name ? t('clinics.staffModal.specialty', { name: clinicDetail.specialty_name }) : t('clinics.subtitle')} onClose={onClose} wide>
      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text={t('clinics.staffModal.loading')} /> : staff.length === 0 ? (<Empty text={t('clinics.staffModal.empty')} />) : (
        <div className="table-wrap table-cards"><table><thead><tr><th>{t('clinics.staffModal.col.name')}</th><th>{t('clinics.staffModal.col.username')}</th><th>{t('clinics.staffModal.col.role')}</th><th>{t('clinics.staffModal.col.subSpecialty')}</th><th>{t('clinics.staffModal.col.status')}</th><th>{t('clinics.staffModal.col.assignment')}</th><th>{t('clinics.col.actions')}</th></tr></thead><tbody>
          {staff.map((m) => {
            const st = USER_STATUS[m.status] || { label: m.status, cls: "" }
            return (
              <tr key={m.user_id}>
                <td>{m.full_name}</td>
                <td dir="ltr" data-label={t('clinics.staffModal.col.username')}>{m.username}</td>
                <td data-label={t('clinics.staffModal.col.role')}>{ROLE_LABELS[m.role_name] || m.role_name}</td>
                <td data-label={t('clinics.staffModal.col.subSpecialty')}>{m.sub_specialty || "—"}</td>
                <td data-label={t('clinics.staffModal.col.status')}><span className={`status ${st.cls}`}>{st.label}</span></td>
                <td data-label={t('clinics.staffModal.col.assignment')}>{m.is_primary ? t('clinics.staffModal.primary') : t('clinics.staffModal.secondary')}</td>
                <td className="cell-actions">
                  <button className="text-button" onClick={() => setEditing(m)}>{t('clinics.edit')}</button>
                  <button className="text-button danger" onClick={() => removeStaff(m)}>{t('clinics.staffModal.remove')}</button>
                </td>
              </tr>
            )
          })}</tbody></table></div>
      )}
      {!showAdd && !editing && !showAssign && (
        <div className="modal-actions">
          <button className="secondary-button" onClick={openAssign}>{t('clinics.staffModal.assignExisting')}</button> {' '}
          <button className="primary-button" onClick={() => setShowAdd(true)}>{t('clinics.staffModal.assignNew')}</button>
        </div>
      )}
      {showAssign && (
        <div className="assign-box">
          <div className="form-row">
            <Field label={t('clinics.staffModal.roleLabel')} hint={t('clinics.staffModal.roleHint')}>
              <select value={roleFilter} onChange={(e) => changeRoleFilter(e.target.value)}>
                <option value="DOCTOR">{t('clinics.staffModal.roleDoctor')}</option>
                <option value="NURSE">{t('clinics.staffModal.roleNurse')}</option>
                <option value="RECEPTIONIST">{t('clinics.staffModal.roleReceptionist')}</option>
                <option value="ACCOUNTANT">{t('clinics.staffModal.roleAccountant')}</option>
              </select>
            </Field>
            <Field label={t('clinics.staffModal.searchLabel')}><input className="input" placeholder={t('clinics.staffModal.search')} value={assignSearch} onChange={(e) => setAssignSearch(e.target.value)} /></Field>
          </div>
          {candidates === null ? <Loading text={t('clinics.staffModal.loading')} /> : filteredCandidates.length === 0 ? <Empty text={t('clinics.staffModal.noCandidates')} /> : (
            <Field label={t('clinics.staffModal.selectUser')}>
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                <option value={''}>{t('clinics.staffModal.selectPlaceholder')}</option>
                {filteredCandidates.map((u) => (
                  <option key={u.user_id} value={u.user_id}>{u.full_name} — {u.username}{u.clinic_name ? ` (${t('clinics.staffModal.primary')}: ${u.clinic_name})` : ` (${t('clinics.staffModal.noPrimary')})`}</option>
                ))}
              </select>
            </Field>
          )}
          <p className="profile-meta">{t('clinics.staffModal.assignmentNote')}</p>
          <div className="modal-actions" style={{ marginTop: "12px" }}>
            <button type="button" className="secondary-button" onClick={() => setShowAssign(false)}>{t('clinics.close')}</button> {' '}
            <button className="primary-button" disabled={!selectedId || assigning} onClick={assignUser}>{assigning ? t('clinics.staffModal.assigning') : t('clinics.staffModal.assign')}</button>
          </div>
        </div>
      )}
      {showAdd && <StaffForm clinic={clinic} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {editing && <StaffForm clinic={clinic} member={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </Modal>
  )
}

const STAFF_ROLES = ["DOCTOR", "NURSE", "RECEPTIONIST", "ACCOUNTANT"]

function StaffForm({ clinic, member, onClose, onSaved }) {
  const t = useT()
  const isEdit = Boolean(member)
  const [form, setForm] = useState({ full_name: member?.full_name || "", username: member?.username || "", password: "", role_name: member?.role_name || "DOCTOR", sub_specialty: member?.sub_specialty || "", status: member?.status || "ACTIVE" })
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault(); setSaving(true); setError("")
    try {
      if (isEdit) {
        const payload = { full_name: form.full_name, sub_specialty: form.sub_specialty || undefined, status: form.status }
        if (form.password) payload.password = form.password
        await api.clinics.updateStaff(clinic.clinic_id, member.user_id, payload)
      } else {
        await api.clinics.addStaff(clinic.clinic_id, { full_name: form.full_name, username: form.username, password: form.password, role_name: form.role_name, sub_specialty: form.sub_specialty || undefined })
      }
      onSaved()
    } catch (err) { setError(err.message || t('clinics.staffForm.saveError')) }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? t('clinics.staffForm.editTitle', { name: member.full_name }) : t('clinics.staffForm.createTitle')} subtitle={clinic.clinic_name} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('clinics.staffForm.fullName')} required><input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label={t('clinics.staffForm.role')} required><select value={form.role_name} disabled={isEdit} onChange={(e) => setForm({ ...form, role_name: e.target.value })}>{STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}</select></Field>
        </div>
        <div className="form-row">
          <Field label={t('clinics.staffForm.specialty')}><input maxLength={200} value={form.sub_specialty} onChange={(e) => setForm({ ...form, sub_specialty: e.target.value })} /></Field>
          {isEdit ? (<Field label={t('clinics.staffForm.status')}><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="ACTIVE">{t('clinics.status.active')}</option><option value="SUSPENDED">{t('clinics.status.suspended')}</option></select></Field>) : (<Field label={t('clinics.staffForm.username')} required><input required dir="ltr" minLength={3} maxLength={100} pattern="[A-Za-z0-9_.\-]+" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>)}
        </div>
        <div className="form-row">
          <Field label={isEdit ? t('clinics.staffForm.newPassword') : t('clinics.staffForm.password')} required={!isEdit}><input type="password" dir="ltr" minLength={12} maxLength={128} required={!isEdit} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        </div>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('clinics.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : isEdit ? t('clinics.staffForm.save') : t('clinics.staffForm.assign')}</button>
        </div>
      </form>
    </Modal>
  )
}
