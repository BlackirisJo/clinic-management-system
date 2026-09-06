import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDate } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice } from '../components/ui'

// إدارة العيادات — متاحة لمدير النظام فقط (تُخفى القائمة لبقية الأدوار)
export default function ClinicsView() {
  const [clinics, setClinics] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)

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
                  <td><button className="text-button" onClick={() => setEditing(c)}>تعديل ←</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <ClinicForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {editing && <ClinicForm clinic={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
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
      if (clinic) await api.clinics.update(clinic.clinic_id, form)
      else await api.clinics.create({ clinic_name: form.clinic_name })
      onSaved()
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
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إلغاء</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ العيادة'}</button>
        </div>
      </form>
    </Modal>
  )
}