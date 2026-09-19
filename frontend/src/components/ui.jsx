import { useEffect, useRef } from 'react'
import { useT } from '../i18n'

// قفل تمرير الصفحة أثناء فتح أي نافذة (مهم على الهاتف حتى لا تتحرك الخلفية)
let scrollLocks = 0
function lockBodyScroll() {
  scrollLocks += 1
  if (scrollLocks === 1) document.body.style.overflow = 'hidden'
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1)
    if (scrollLocks === 0) document.body.style.overflow = ''
  }
}

// نافذة منبثقة عامة — على الهاتف تظهر كـ Bottom-Sheet، وعلى الشاشات الأكبر نافذة مركزية
export function Modal({ title, subtitle, onClose, children, wide }) {
  const t = useT()
  const ref = useRef(null)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      window.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <section ref={ref} className={`modal-card${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-header">
          <div><span className="eyebrow">{subtitle || t('common.modal.subtitle')}</span><h2>{title}</h2></div>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        {children}
      </section>
    </div>
  )
}

// حقل نموذج موحّد
export function Field({ label, required, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required ? ' *' : ''}</span>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  )
}

export function Loading({ text }) {
  const t = useT()
  return <div className="loading-state"><span className="loader" />{text || t('common.loading.default')}</div>
}

export function Empty({ text, icon }) {
  const t = useT()
  return (
    <div className="empty-inline">
      <span>{icon || '◇'}</span>
      <p>{text || t('common.empty.default')}</p>
    </div>
  )
}

export function Notice({ kind = 'error', children }) {
  if (!children) return null
  return <div className={`notice ${kind}`}>{children}</div>
}

// ترقيم صفحات بسيط يعتمد على حجم الصفحة الحالية
export function Paginator({ page, rows, limit, onPage }) {
  const t = useT()
  if (!rows || rows.length === 0) return null
  const hasNext = rows.length >= (limit || 50)
  return (
    <div className="pagination">
      <button type="button" className="secondary-button compact" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t('common.pagination.prev')}</button>
      <span>{t('common.pagination.page', { page })}</span>
      <button type="button" className="secondary-button compact" disabled={!hasNext} onClick={() => onPage(page + 1)}>{t('common.pagination.next')}</button>
    </div>
  )
}

// تصدير CSV مع دعم العربية (BOM)
export function downloadCSV(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const lines = [
    headers.map(esc).join(','),
    ...rows.map((row) => row.map(esc).join(',')),
  ]
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// تاريخ اليوم بصيغة YYYY-MM-DD
export const todayString = () => {
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}