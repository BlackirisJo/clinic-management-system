import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Field, Loading, Empty, Notice, Modal } from '../components/ui'
import { useT } from '../i18n'
import { useAuth } from '../auth/AuthContext'

// إجازات الأطباء: الطلب والاعتماد.
//
// قاعدة الفصل: من يطلب لا يوثّق (اعتماد ذاتي ممنوع 403)، والاعتماد يحتاج
// صلاحية APROVE_DOCTOR_LEAVE. الإجازة المعتمدة تُغلق أيامها في بوابة الحجز.

export default function DoctorLeaveView() {
  const t = useT()
  const { user } = useAuth()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const canRequest = isGlobal || (user?.permissions || []).includes('MANAGE_DOCTOR_LEAVE')
  const canDecide = isGlobal || (user?.permissions || []).includes('APPROVE_DOCTOR_LEAVE')

  const [records, setRecords] = useState([])
  const [clinics, setClinics] = useState([])
  const [doctors, setDoctors] = useState([])
  const [filters, setFilters] = useState({ clinic_id: '', doctor_id: '', status: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {}
      if (filters.clinic_id) params.clinic_id = filters.clinic_id
      if (filters.doctor_id) params.doctor_id = filters.doctor_id
      if (filters.status) params.status = filters.status
      const result = await api.doctorLeave.list(params)
      setRecords(result.leave || result.leaves || [])
    } catch (err) {
      setError(err.message || t('calendar.leave.loading'))
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    async function loadInitial() {
      try {
        const [clinicResult, doctorResult] = await Promise.all([
          api.clinics.directory(),
          api.users.doctors(),
        ])
        const all = clinicResult.clinics || []
        if (isGlobal) setClinics(all)
        else {
          const myIds = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
          setClinics(all.filter(c => myIds.includes(Number(c.clinic_id))))
        }
        setDoctors(doctorResult.doctors || [])
      } catch {
        setClinics([])
        setDoctors([])
      }
    }
    loadInitial()
  }, [isGlobal, user])

  async function decide(record, status) {
    setError('')
    setNotice('')
    try {
      await api.doctorLeave.decide(record.leave_id, { status })
      await load()
    } catch (err) {
      if (err.code === 'SELF_APPROVAL_FORBIDDEN') {
        setError(t('calendar.leave.selfApproval'))
        return
      }
      setError(err.message || t('calendar.leave.decideError'))
    }
  }

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div>
          <h2>{t('calendar.leave.title')}</h2>
          <p>{t('calendar.leave.subtitle')}</p>
        </div>
        {canRequest && (
          <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('calendar.leave.request')}</button>
        )}
      </div>

      <div className="toolbar">
        <select className="input" value={filters.clinic_id} onChange={e => setFilters({ ...filters, clinic_id: e.target.value })}>
          <option value="">{t('doctorSchedules.selectClinic')}</option>
          {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
        </select>
        <select className="input" value={filters.doctor_id} onChange={e => setFilters({ ...filters, doctor_id: e.target.value })}>
          <option value="">{t('doctorSchedules.selectDoctor')}</option>
          {doctors.map(d => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
        </select>
        <select className="input" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
          <option value="">{t('calendar.table.status')}</option>
          <option value="PENDING">{t('calendar.status.PENDING')}</option>
          <option value="APPROVED">{t('calendar.status.APPROVED')}</option>
          <option value="REJECTED">{t('calendar.status.REJECTED')}</option>
          <option value="CANCELLED">{t('calendar.status.CANCELLED')}</option>
        </select>
      </div>

      <Notice kind="error">{error}</Notice>
      <Notice kind="success">{notice}</Notice>

      {loading ? <Loading text={t('calendar.leave.loading')} /> : records.length === 0 ? (
        <Empty text={t('calendar.leave.empty')} />
      ) : (
        <div className="table-wrap table-cards">
          <table>
            <thead>
              <tr>
                <th>{t('calendar.leave.form.doctor')}</th>
                <th>{t('calendar.leave.form.clinic')}</th>
                <th>{t('calendar.leave.form.start')}</th>
                <th>{t('calendar.leave.form.end')}</th>
                <th>{t('calendar.leave.form.type')}</th>
                <th>{t('calendar.table.status')}</th>
                <th>{t('calendar.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map(record => (
                <tr key={record.leave_id}>
                  <td>{record.doctor_name}</td>
                  <td>{record.clinic_name}</td>
                  <td dir="ltr">{String(record.start_date).slice(0, 10)}</td>
                  <td dir="ltr">{String(record.end_date).slice(0, 10)}</td>
                  <td>{t(`calendar.leave.type.${record.leave_type}`)}</td>
                  <td><span className="chip">{t(`calendar.status.${record.status}`)}</span></td>
                  <td>
                    {canDecide && record.status === 'PENDING' && (
                      <>
                        <button className="secondary-button compact" onClick={() => decide(record, 'APPROVED')}>
                          {t('calendar.leave.approve')}
                        </button>
                        <button className="secondary-button compact" onClick={() => decide(record, 'REJECTED')}>
                          {t('calendar.leave.reject')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <LeaveForm
          clinics={clinics}
          doctors={doctors}
          user={user}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
    </section>
  )
}

function LeaveForm({ clinics, doctors, user, onClose, onSaved }) {
  const t = useT()
  const [form, setForm] = useState({
    doctor_id: user?.roleName === 'DOCTOR' ? String(user.userId) : '',
    clinic_id: user?.clinicId ? String(user.clinicId) : '',
    start_date: '',
    end_date: '',
    leave_type: 'ANNUAL',
    reason: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.doctorLeave.create({
        doctor_id: Number(form.doctor_id),
        clinic_id: Number(form.clinic_id),
        start_date: form.start_date,
        end_date: form.end_date,
        leave_type: form.leave_type,
        reason: form.reason || null,
      })
      onSaved()
    } catch (err) {
      setError(err.message || t('calendar.leave.form.error'))
    } finally { setSaving(false) }
  }

  const isDoctor = user?.roleName === 'DOCTOR'

  return (
    <Modal title={t('calendar.leave.form.title')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('calendar.leave.form.clinic')} required>
          <select required value={form.clinic_id} onChange={e => setForm({ ...form, clinic_id: e.target.value })}>
            <option value="">{t('doctorSchedules.selectClinic')}</option>
            {clinics.map(c => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
          </select>
        </Field>
        <Field label={t('calendar.leave.form.doctor')} required>
          <select
            required
            value={form.doctor_id}
            disabled={isDoctor}
            onChange={e => setForm({ ...form, doctor_id: e.target.value })}
          >
            <option value="">{t('doctorSchedules.selectDoctor')}</option>
            {doctors.map(d => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
          </select>
        </Field>
        <div className="form-row">
          <Field label={t('calendar.leave.form.start')} required>
            <input type="date" required value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
          </Field>
          <Field label={t('calendar.leave.form.end')} required>
            <input type="date" required value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
          </Field>
        </div>
        <Field label={t('calendar.leave.form.type')}>
          <select value={form.leave_type} onChange={e => setForm({ ...form, leave_type: e.target.value })}>
            <option value="ANNUAL">{t('calendar.leave.type.ANNUAL')}</option>
            <option value="SICK">{t('calendar.leave.type.SICK')}</option>
            <option value="UNPAID">{t('calendar.leave.type.UNPAID')}</option>
            <option value="OTHER">{t('calendar.leave.type.OTHER')}</option>
          </select>
        </Field>
        <Field label={t('calendar.leave.form.reason')}>
          <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('calendar.form.saving') : t('calendar.leave.form.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
