import { useState, useRef } from 'react'
import { api } from '../lib/api'
import { Modal, Notice } from './ui'

export default function ImportMedicationsModal({ onClose, onImported }) {
  const [step, setStep] = useState('ask')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  function downloadTemplate() {
    api.prescriptions.importTemplate().catch((err) => setError(err.message || 'تعذر تحميل النموذج'))
  }

  function onFileChange(e) {
    const f = e.target.files?.[0]
    setError(''); setPreview(null)
    if (!f) { setFile(null); return }
    if (!f.name.toLowerCase().endsWith('.csv')) { setError('الملف يجب أن يكون بصيغة .csv'); setFile(null); return }
    if (f.size > 5 * 1024 * 1024) { setError('حجم الملف يتجاوز 5MB'); setFile(null); return }
    setFile(f)
  }

  async function handleValidate() {
    if (!file) { setError('اختر ملفاً أولاً'); return }
    setBusy(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.prescriptions.validateImport(fd)
      setPreview(res.preview)
      setStep('preview')
    } catch (err) {
      setError(err.message || 'فشل فحص الملف')
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
      setError(err.message || 'فشل الاستيراد')
      setStep('upload')
    } finally { setBusy(false) }
  }

  const p = preview || {}
  const r = result || {}
  const canImport = (p.validNew ?? 0) > 0
  return (
    <Modal wide title="استيراد دليل الأدوية" subtitle="استيراد قائمة الأدوية من ملف CSV" onClose={onClose}>
      <div className="import-flow">
        <Notice kind="error">{error}</Notice>

        {step === 'ask' && (
          <div className="import-step">
            <h3>هل لديك ملف CSV جاهز؟</h3>
            <p className="muted">يمكنك تحميل نموذج فارغ أولاً لمعرفة الترتيب الصحيح للأعمدة، أو رفع ملفك مباشرة.</p>
            <div className="import-choices">
              <button className="secondary-button" onClick={() => { downloadTemplate(); setStep('upload') }}>
                📄 تحميل نموذج فارغ
              </button>
              <button className="primary-button" onClick={() => setStep('upload')}>
                ✅ لدي ملف جاهز
              </button>
            </div>
          </div>
        )}

        {(step === 'upload' || step === 'preview' || step === 'importing' || step === 'done') && (
          <div className="import-step">
            <h3>اختيار ملف CSV</h3>
            <div className="file-zone">
              <input ref={inputRef} type="file" accept=".csv" onChange={onFileChange} style={{ display: 'none' }} />
              <button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}>
                {file ? '📎 تغيير الملف' : '📎 اختر ملف CSV'}
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
                  {busy ? 'جارِ الفحص...' : '🔍 فحص الملف'}
                </button>
              </div>
            )}
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="import-step">
            <h3>نتيجة الفحص</h3>
            <div className="import-stats">
              <div className="stat"><span>إجمالي السجلات</span><strong>{p.totalRows}</strong></div>
              <div className="stat ok"><span>أدوية جديدة</span><strong>{p.validNew}</strong></div>
              <div className="stat warn"><span>موجودة مسبقاً</span><strong>{p.existing}</strong></div>
              <div className="stat warn"><span>مكررة داخل الملف</span><strong>{p.duplicateInFile}</strong></div>
              <div className="stat err"><span>أخطاء</span><strong>{p.invalid}</strong></div>
            </div>
            {p.invalidRows?.length > 0 && (
              <div className="import-errors">
                <h4>السجلات المرفوضة ({p.invalidRows.length})</h4>
                <div className="table-wrap" style={{ maxHeight: 160 }}>
                  <table>
                    <thead><tr><th>الصف</th><th>البيانات</th><th>السبب</th></tr></thead>
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
                {busy ? 'جارِ الاستيراد...' : `💊 استيراد الأدوية (${p.validNew})`}
              </button>
              <button className="secondary-button" disabled={busy} onClick={() => setStep('upload')}>رفع ملف آخر</button>
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div className="import-step">
            <h3>✅ تم الاستيراد بنجاح</h3>
            <div className="import-stats">
              <div className="stat"><span>إجمالي السجلات</span><strong>{r.totalRows}</strong></div>
              <div className="stat ok"><span>تمت الإضافة</span><strong>{r.added}</strong></div>
              <div className="stat warn"><span>موجودة مسبقاً</span><strong>{r.skippedExisting}</strong></div>
              <div className="stat warn"><span>مكررة</span><strong>{r.skippedDuplicate}</strong></div>
              <div className="stat err"><span>فشل</span><strong>{r.failed}</strong></div>
            </div>
            <div className="modal-actions">
              <button className="primary-button" onClick={onClose}>إغلاق</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}