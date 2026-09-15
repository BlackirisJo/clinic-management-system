import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtNumber, fmtDateTime } from '../lib/format'
import { Field, Modal, Loading, Empty, Notice, Paginator } from '../components/ui'

const LIMIT = 10

export default function BackupsView() {
  const [rows, setRows] = useState([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [showUpload, setShowUpload] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.backups.list({ page, limit: LIMIT })
      setRows(result.backups || [])
    } catch (err) {
      setError(err.message || 'تعذر تحميل سجلات النسخ الاحتياطي')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => { load() }, [load])

  async function createBackup() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api.backups.create()
      setNotice('تم إنشاء النسخة الاحتياطية المشفرة بنجاح')
      await load()
    } catch (err) {
      setError(err.message || 'تعذر إنشاء النسخة الاحتياطية')
    } finally { setBusy(false) }
  }

  async function download(id) {
    setBusy(true)
    setError('')
    try {
      await api.backups.download(id)
    } catch (err) {
      setError(err.message || 'تعذر تنزيل الملف')
    } finally { setBusy(false) }
  }

  async function restore(id) {
    if (!window.confirm('هل تريد استرجاع قاعدة البيانات من هذه النسخة؟ سيتم إنشاء نسخة أمان أولاً.')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api.backups.restore(id)
      setNotice('تم استرجاع قاعدة البيانات بنجاح')
    } catch (err) {
      setError(err.message || 'تعذر استرجاع النسخة')
    } finally { setBusy(false) }
  }

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>النسخ الاحتياطية</h2><p>إنشاء وتنزيل واسترجاع النسخ المشفرة AES-256-GCM</p></div>
        <div className="top-actions">
          <button className="secondary-button compact" onClick={() => setShowUpload(true)}>استرجاع ملف خارجي</button>
          <button className="primary-button compact" onClick={createBackup} disabled={busy}>{busy ? 'جارِ التنفيذ...' : '+ إنشاء نسخة جديدة'}</button>
        </div>
      </div>

      {notice && <div className="alert success">{notice}</div>}
      <Notice kind="error">{error}</Notice>

      {loading ? <Loading text="جارِ تحميل السجلات" /> : rows.length === 0 ? <Empty text="لا توجد نسخ احتياطية" /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>#</th><th>الحجم</th><th>الحالة</th><th>المنشئ</th><th>التاريخ</th><th>Checksum</th><th>إجراءات</th></tr></thead>
              <tbody>
               {rows.map((b) => (
                 <tr key={b.backup_id}>
                    <td className="hide-sm" data-label="#">{b.backup_id}</td>
                    <td dir="ltr" data-label="الحجم">{fmtNumber(b.file_size_bytes)} بايت</td>
                    <td data-label="الحالة"><span className="status">{b.status === 'SUCCESS' ? 'ناجحة' : b.status}</span></td>
                    <td data-label="المنشئ">{b.created_by_user || '—'}</td>
                    <td data-label="التاريخ">{fmtDateTime(b.created_at)}</td>
                    <td className="hide-sm" dir="ltr" style={{ fontSize: 10 }} data-label="Checksum">{b.checksum ? `${b.checksum.slice(0, 24)}…` : '—'}</td>
                    <td className="cell-actions">
                      <button className="text-button" onClick={() => download(b.backup_id)}>تنزيل</button>
                      <button className="text-button" onClick={() => restore(b.backup_id)}>استرجاع</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} />
        </>
      )}

      {showUpload && <UploadRestoreModal onClose={() => setShowUpload(false)} onSaved={() => { setShowUpload(false); load() }} />}
    </section>
  )
}
function UploadRestoreModal({ onClose, onSaved }) {
  const [file, setFile] = useState(null)
  const [iv, setIv] = useState('')
  const [authTag, setAuthTag] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (!file) throw new Error('يرجى اختيار ملف النسخة الاحتياطية')
      await api.backups.upload(file, iv.trim(), authTag.trim())
      onSaved()
    } catch (err) {
      setError(err.message || 'فشل استرجاع الملف المرفوع')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="استرجاع ملف نسخة احتياطية خارجي" subtitle="النسخ الاحتياطية" onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label="ملف النسخة (.enc)" required>
          <input type="file" required accept=".enc" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label="قيمة التشفير IV" required>
          <input required dir="ltr" value={iv} onChange={(e) => setIv(e.target.value)} placeholder="iv" />
        </Field>
        <Field label="رمز المصادقة Auth Tag" required>
          <input required dir="ltr" value={authTag} onChange={(e) => setAuthTag(e.target.value)} placeholder="auth_tag" />
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
          <button className="primary-button" disabled={saving}>{saving ? 'جارِ الاسترجاع...' : 'استرجاع الآن'}</button>
        </div>
      </form>
    </Modal>
  )
}