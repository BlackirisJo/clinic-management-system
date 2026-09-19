import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtNumber, fmtDateTime } from '../lib/format'
import { useT } from '../i18n'
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
  const t = useT()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.backups.list({ page, limit: LIMIT })
      setRows(result.backups || [])
    } catch (err) {
      setError(err.message || t('backup.loadError'))
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
      setNotice(t('backup.created'))
      await load()
    } catch (err) {
      setError(err.message || t('backup.createError'))
    } finally { setBusy(false) }
  }

  async function download(id) {
    setBusy(true)
    setError('')
    try {
      await api.backups.download(id)
    } catch (err) {
      setError(err.message || t('backup.downloadError'))
    } finally { setBusy(false) }
  }

  async function restore(id) {
    if (!window.confirm(t('backup.restoreConfirm'))) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api.backups.restore(id)
      setNotice(t('backup.restored'))
    } catch (err) {
      setError(err.message || t('backup.restoreError'))
    } finally { setBusy(false) }
  }

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('backup.title')}</h2><p>{t('backup.subtitle')}</p></div>
        <div className="top-actions">
          <button className="secondary-button compact" onClick={() => setShowUpload(true)}>{t('backup.uploadFile')}</button>
          <button className="primary-button compact" onClick={createBackup} disabled={busy}>{busy ? t('backup.creating') : '+ ' + t('backup.createNew')}</button>
        </div>
      </div>

      {notice && <div className="alert success">{notice}</div>}
      <Notice kind="error">{error}</Notice>

      {loading ? <Loading text={t('backup.loading')} /> : rows.length === 0 ? <Empty text={t('backup.empty')} /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>#</th><th>{t('backup.table.size')}</th><th>{t('backup.table.status')}</th><th>{t('backup.table.createdBy')}</th><th>{t('backup.table.date')}</th><th>Checksum</th><th>{t('backup.table.actions')}</th></tr></thead>
              <tbody>
               {rows.map((b) => (
                 <tr key={b.backup_id}>
                    <td className="hide-sm" data-label="#">{b.backup_id}</td>
                    <td dir="ltr" data-label={t('backup.table.size')}>{fmtNumber(b.file_size_bytes)} {t('backup.sizeUnit')}</td>
                    <td data-label={t('backup.table.status')}><span className="status">{b.status === 'SUCCESS' ? t('backup.status.success') : t('backup.status.failed')}</span></td>
                    <td data-label={t('backup.table.createdBy')}>{b.created_by_user || '—'}</td>
                    <td data-label={t('backup.table.date')}>{fmtDateTime(b.created_at)}</td>
                    <td className="hide-sm" dir="ltr" style={{ fontSize: 10 }} data-label="Checksum">{b.checksum ? `${b.checksum.slice(0, 24)}…` : '—'}</td>
                    <td className="cell-actions">
                      <button className="text-button" onClick={() => download(b.backup_id)}>{t('backup.download')}</button>
                      <button className="text-button" onClick={() => restore(b.backup_id)}>{t('backup.restore')}</button>
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
  const t = useT()
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
      if (!file) throw new Error(t('backup.selectFile'))
      await api.backups.upload(file, iv.trim(), authTag.trim())
      onSaved()
    } catch (err) {
      setError(err.message || t('backup.restoreError'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('backup.upload.title')} subtitle={t('backup.title')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('backup.upload.fileLabel')} required>
          <input type="file" required accept=".enc" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label={t('backup.upload.ivLabel')} required>
          <input required dir="ltr" value={iv} onChange={(e) => setIv(e.target.value)} placeholder="iv" />
        </Field>
        <Field label={t('backup.upload.authTagLabel')} required>
          <input required dir="ltr" value={authTag} onChange={(e) => setAuthTag(e.target.value)} placeholder="auth_tag" />
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('backup.upload.restoring') : t('backup.upload.restoreNow')}</button>
        </div>
      </form>
    </Modal>
  )
}