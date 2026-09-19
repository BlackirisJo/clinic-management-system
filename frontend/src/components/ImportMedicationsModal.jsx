import { useState, useRef } from 'react'
import { api } from '../lib/api'
import { Modal, Notice } from './ui'
import { useT } from '../i18n'

export default function ImportMedicationsModal({ onClose, onImported }) {
  const t = useT()
  const [step, setStep] = useState('ask')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  function downloadTemplate() {
    api.prescriptions.importTemplate().catch((err) => setError(err.message || t('import.loadError')))
  }

  function onFileChange(e) {
    const f = e.target.files?.[0]
    setError(''); setPreview(null)
    if (!f) { setFile(null); return }
    if (!f.name.toLowerCase().endsWith('.csv')) { setError(t('import.fileInvalid')); setFile(null); return }
    if (f.size > 5 * 1024 * 1024) { setError(t('import.fileTooLarge')); setFile(null); return }
    setFile(f)
  }

  async function handleValidate() {
    if (!file) { setError(t('import.chooseFirst')); return }
    setBusy(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.prescriptions.validateImport(fd)
      setPreview(res.preview)
      setStep('preview')
    } catch (err) {
      setError(err.message || t('import.validateFailed'))
    } finally { setBusy(false) }
  }

  async function handleImport() {
    if (!file) return
    setBusy(true); setError(''); setStep('importing')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.prescriptions.executeImport(fd)
      setResult(res.result)
      setStep('done')
      onImported?.()
    } catch (err) {
      setError(err.message || t('import.importFailed'))
      setStep('upload')
    } finally { setBusy(false) }
  }

  const p = preview || {}
  const r = result || {}
  const canImport = (p.validNew ?? 0) > 0
  return (
    <Modal wide title={t('import.title')} subtitle={t('import.subtitle')} onClose={onClose}>
      <div className="import-flow">
        <Notice kind="error">{error}</Notice>

        {step === 'ask' && (
          <div className="import-step">
            <h3>{t('import.askTitle')}</h3>
            <p className="muted">{t('import.askText')}</p>
            <div className="import-choices">
              <button className="secondary-button" onClick={() => { downloadTemplate(); setStep('upload') }}>
                {t('import.downloadTemplate')}
              </button>
              <button className="primary-button" onClick={() => setStep('upload')}>
                {t('import.haveFile')}
              </button>
            </div>
          </div>
        )}

        {(step === 'upload' || step === 'preview' || step === 'importing' || step === 'done') && (
          <div className="import-step">
            <h3>{t('import.selectFileTitle')}</h3>
            <div className="file-zone">
              <input ref={inputRef} type="file" accept=".csv" onChange={onFileChange} style={{ display: 'none' }} />
              <button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}>
                {file ? t('import.changeFile') : t('import.chooseFile')}
              </button>
              {file && (
                <div className="file-info">
                  <span>{file.name}</span>
                  <span className="muted">({(file.size / 1024).toFixed(1)} KB)</span>
                </div>
              )}
            </div>
            {step === 'upload' && (
              <div className="modal-actions">
                <button className="primary-button" disabled={!file || busy} onClick={handleValidate}>
                  {busy ? t('import.validating') : t('import.validateBtn')}
                </button>
              </div>
            )}
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="import-step">
            <h3>{t('import.previewTitle')}</h3>
            <div className="import-stats">
              <div className="stat"><span>{t('import.totalRows')}</span><strong>{p.totalRows}</strong></div>
              <div className="stat ok"><span>{t('import.newDrugs')}</span><strong>{p.validNew}</strong></div>
              <div className="stat warn"><span>{t('import.existing')}</span><strong>{p.existing}</strong></div>
              <div className="stat warn"><span>{t('import.duplicateInFile')}</span><strong>{p.duplicateInFile}</strong></div>
              <div className="stat err"><span>{t('import.errors')}</span><strong>{p.invalid}</strong></div>
            </div>
            {p.invalidRows?.length > 0 && (
              <div className="import-errors">
                <h4>{t('import.invalidRows')} ({p.invalidRows.length})</h4>
                <div className="table-wrap" style={{ maxHeight: 160 }}>
                  <table>
                    <thead><tr><th>{t('import.row')}</th><th>{t('import.data')}</th><th>{t('import.reason')}</th></tr></thead>
                    <tbody>
                      {p.invalidRows.slice(0, 50).map((row, i) => (
                        <tr key={i}>
                          <td>{row.rowNumber}</td>
                          <td>{row.raw?.trade_name || '—'}</td>
                          <td>{row.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button className="primary-button" disabled={!canImport || busy} onClick={handleImport}>
                {busy ? t('import.importing') : t('import.importBtn', { count: p.validNew })}
              </button>
              <button className="secondary-button" disabled={busy} onClick={() => setStep('upload')}>{t('import.uploadOther')}</button>
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div className="import-step">
            <h3>{t('import.doneTitle')}</h3>
            <div className="import-stats">
              <div className="stat"><span>{t('import.totalRows')}</span><strong>{r.totalRows}</strong></div>
              <div className="stat ok"><span>{t('import.added')}</span><strong>{r.added}</strong></div>
              <div className="stat warn"><span>{t('import.existing')}</span><strong>{r.skippedExisting}</strong></div>
              <div className="stat warn"><span>{t('import.duplicate')}</span><strong>{r.skippedDuplicate}</strong></div>
              <div className="stat err"><span>{t('import.failed')}</span><strong>{r.failed}</strong></div>
            </div>
            <div className="modal-actions">
              <button className="primary-button" onClick={onClose}>{t('common.close')}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}