import { useEffect, useRef } from 'react'

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
          <div><span className="eyebrow">{subtitle || 'نظام إدارة العيادات'}</span><h2>{title}</h2></div>
          <button className="modal-close" onClick={onClose} aria-label="إغلاق">×</button>
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
  return <div className="loading-state"><span className="loader" />{text || 'جارِ التحميل...'}</div>
}

export function Empty({ text, icon }) {
  return (
    <div className="empty-inline">
      <span>{icon || '◇'}</span>
      <p>{text || 'لا توجد بيانات لعرضها'}</p>
    </div>
  )
}

export function Notice({ kind = 'error', children }) {
  if (!children) return null
  return <div className={`notice ${kind}`}>{children}</div>
}

// ترقيم صفحات بسيط يعتمد على حجم الصفحة الحالية
export function Paginator({ page, rows, limit, onPage }) {
  if (!rows || rows.length === 0) return null
  const hasNext = rows.length >= (limit || 50)
  return (
    <div className="pagination">
      <button type="button" className="secondary-button compact" disabled={page <= 1} onClick={() => onPage(page - 1)}>→ السابق</button>
      <span>الصفحة {page}</span>
      <button type="button" className="secondary-button compact" disabled={!hasNext} onClick={() => onPage(page + 1)}>التالي ←</button>
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