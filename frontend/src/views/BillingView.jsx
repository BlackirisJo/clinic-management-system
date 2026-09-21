import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useT } from '../i18n'
import { fmtMoney, fmtDate, fmtNumber, PAYMENT_TYPES, INVOICE_STATUS, fmtInvoiceNumber } from '../lib/format'
import { Field, Loading, Empty, Notice, Modal } from '../components/ui'
import { PatientSearchSelect } from '../components/SearchSelect'
import { useBaseCurrency } from '../hooks/useBaseCurrency'

function hasPerm(perms, key) {
  return Array.isArray(perms) && perms.includes(key)
}

export default function BillingView() {
  const [tab, setTab] = useState('invoices')
  const t = useT()
  const { user } = useAuth()
  const baseCurrency = useBaseCurrency()
  const perms = user?.permissions ?? []
  const canCreateInvoice = hasPerm(perms, 'CREATE_INVOICE')
  const canViewInvoices = hasPerm(perms, 'VIEW_INVOICES') || hasPerm(perms, 'VIEW_FINANCIAL_REPORTS') || hasPerm(perms, 'CREATE_INVOICE')
  const canManageServices = hasPerm(perms, 'MANAGE_SERVICES') || hasPerm(perms, 'VIEW_INVOICES') || hasPerm(perms, 'VIEW_FINANCIAL_REPORTS') || hasPerm(perms, 'CREATE_INVOICE')
  const canViewExpenses = hasPerm(perms, 'VIEW_FINANCIAL_REPORTS') || hasPerm(perms, 'VIEW_INVOICES') || hasPerm(perms, 'CREATE_EXPENSE')
  const hasAnyBilling = canViewInvoices || canManageServices || canViewExpenses
  if (!hasAnyBilling) return null
  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('billing.title')}</h2><p>{t('billing.subtitle')}</p></div>
      </div>
      <div className="tabs">
        {canViewInvoices && (
          <button className={tab === 'invoices' ? 'tab active' : 'tab'} onClick={() => setTab('invoices')}>{t('billing.tab.invoices')}</button>
        )}
        {canManageServices && (
          <button className={tab === 'services' ? 'tab active' : 'tab'} onClick={() => setTab('services')}>{t('billing.tab.services')}</button>
        )}
        {canViewExpenses && (
          <button className={tab === 'expenses' ? 'tab active' : 'tab'} onClick={() => setTab('expenses')}>{t('billing.tab.expenses')}</button>
        )}
      </div>
      <div className="tab-content">
        {tab === 'invoices' && canViewInvoices && <InvoicesTab canCreateInvoice={canCreateInvoice} />}
        {tab === 'services' && canManageServices && <ServicesTab canManageServices={canManageServices} />}
        {tab === 'expenses' && canViewExpenses && <ExpensesTab canCreateExpense={hasPerm(perms, 'CREATE_EXPENSE')} />}
      </div>
    </section>
  )
}

function InvoicesTab({ canCreateInvoice }) {
  const t = useT()
  return (
    <div className="tab-inner">
      <div className="tab-grid two">
        {canCreateInvoice && (
          <div className="record-block"><h4>{t('billing.invoices.create')}</h4><InvoiceForm /></div>
        )}
        <div className="record-block"><h4>{t('billing.invoices.kpis')}</h4><KpisTable /></div>
      </div>
    </div>
  )
}

function KpisTable() {
  const t = useT()
  const baseCurrency = useBaseCurrency()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.billing.monthlyKpis({})
      .then((r) => setRows(r.kpis || []))
      .catch((err) => { console.error('KPIs load error:', err); setError(err.message); setRows([]) })
  }, [])

  return (
    <div>
      <Notice kind="error">{error}</Notice>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty text={t('billing.kpi.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('billing.kpi.month')}</th><th>{t('billing.kpi.clinic')}</th><th>{t('billing.kpi.patients')}</th><th>{t('billing.kpi.visits')}</th><th>{t('billing.kpi.revenue')}</th><th>{t('billing.kpi.doctorPayout')}</th><th>{t('billing.kpi.net')}</th></tr></thead>
            <tbody>
              {rows.map((k, i) => (
                <tr key={i}>
                  <td>{fmtDate(k.stat_month)}</td>
                  <td data-label={t('billing.kpi.clinic')}>{k.clinic_name || '—'}</td>
                  <td data-label={t('billing.kpi.patients')}>{fmtNumber(k.unique_patients)}</td>
                  <td data-label={t('billing.kpi.visits')}>{fmtNumber(k.total_visits)}</td>
                  <td data-label={t('billing.kpi.revenue')}>{fmtMoney(k.total_revenue, baseCurrency)}</td>
                  <td data-label={t('billing.kpi.doctorPayout')}>{fmtMoney(k.total_doctor_payout, baseCurrency)}</td>
                  <td data-label={t('billing.kpi.net')}>{fmtMoney(k.net_clinic_margin, baseCurrency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
      )
    }

function InvoiceForm() {
  const t = useT()
  const { user } = useAuth()
  const [clinics, setClinics] = useState([])
  const [doctors, setDoctors] = useState([])
  const [services, setServices] = useState([])
  const [patientId, setPatientId] = useState('')
  const [discount, setDiscount] = useState('')
  const [paymentType, setPaymentType] = useState('CASH')
  const [items, setItems] = useState([{ clinic_id: '', price: '', doctor_id: '', service_id: '' }])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(null)
  const baseCurrency = useBaseCurrency()

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const [cRes, dRes, sRes] = await Promise.all([
          api.clinics.financialDirectory().catch((err) => { console.error('clinics directory error:', err); return { clinics: [] } }),
          api.users.doctors({ limit: 100 }).catch((err) => { console.error('doctors load error:', err); return { doctors: [] } }),
          api.billing.listServices({ limit: 100 }).catch((err) => { console.error('services load error:', err); return { services: [] } }),
        ])
        if (cancelled) return
        const dirClinics = cRes.clinics || []
        setClinics(dirClinics)
        setDoctors(dRes.doctors || [])
        setServices(sRes.services || [])
        const defClinic = user?.clinicId || dirClinics[0]?.clinic_id || ''
        setItems([{ clinic_id: defClinic ? String(defClinic) : '', price: '', quantity: '1', doctor_id: '', service_id: '' }])
      } catch { /* تجاهل */ }
    }
    boot()
    return () => { cancelled = true }
  }, [user?.clinicId])

  function addItem() {
    const defClinic = user?.clinicId || clinics[0]?.clinic_id || ''
    setItems((prev) => [...prev, { clinic_id: defClinic ? String(defClinic) : '', price: '', quantity: '1', doctor_id: '', service_id: '' }])
  }
  function updateItem(index, key, value) {
    setItems((prev) => prev.map((it, i) => {
      if (i !== index) return it
      const next = { ...it, [key]: value }
      if (key === 'service_id' && value) {
        const svc = services.find((s) => String(s.service_id) === String(value))
        if (svc) {
          next.price = String(svc.price ?? '')
          if (svc.clinic_id) next.clinic_id = String(svc.clinic_id)
        }
      }
      return next
    }))
  }
  function removeItem(index) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0)
  const net = Math.max(0, total - (Number(discount) || 0))
  const doctorsForClinic = (cid) => (!cid ? doctors : doctors.filter((d) => !d.clinic_id || String(d.clinic_id) === String(cid)))
  const servicesForClinic = (cid) => (!cid ? services : services.filter((s) => String(s.clinic_id) === String(cid)))

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await api.billing.createInvoice({
        patient_id: Number(patientId),
        discount_amount: discount ? Number(discount) : undefined,
        payment_type: paymentType,
        items: items.map((it) => ({
          clinic_id: Number(it.clinic_id) || user?.clinicId,
          price: Number(it.price),
          quantity: it.quantity ? Number(it.quantity) : undefined,
          doctor_id: it.doctor_id ? Number(it.doctor_id) : undefined,
          service_id: it.service_id ? Number(it.service_id) : undefined,
        })),
      })
      setDone(result)
      const defClinic = user?.clinicId || clinics[0]?.clinic_id || ''
      setItems([{ clinic_id: defClinic ? String(defClinic) : '', price: '', quantity: '1', doctor_id: '', service_id: '' }])
      setDiscount(''); setPatientId('')
    } catch (err) {
      setError(err.message || t('billing.invoice.error'))
    } finally { setSaving(false) }
  }

  return (
    <div>
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label={t('billing.invoice.patient')} required>
          <PatientSearchSelect value={patientId} onChange={setPatientId} required />
        </Field>
        <Field label={t('billing.invoice.paymentMethod')} required>
          <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
            {Object.entries(PAYMENT_TYPES).map(([key, val]) => <option key={key} value={key}>{t('paymentType.' + key)}</option>)}
          </select>
        </Field>
      </div>

      <div className="items-head">
        <h4>{t('billing.invoice.items')}</h4>
        <button type="button" className="secondary-button compact" onClick={addItem}>{t('billing.invoice.addItem')}</button>
      </div>
      {items.length === 0 ? <Empty text={t('billing.invoice.empty')} /> : (
        <div className="items-list">
          {items.map((it, i) => (
            <div className="item-card" key={i}>
              <div className="form-row">
                <Field label={t('billing.invoice.clinic')} required hint={t('billing.invoice.clinicHint')}>
                  <select required value={it.clinic_id} onChange={(e) => updateItem(i, 'clinic_id', e.target.value)}>
                    <option value="">{t('billing.invoice.clinicPlaceholder')}</option>
                    {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
                  </select>
                </Field>
                <Field label={t('billing.invoice.service')}>
                  <select value={it.service_id} onChange={(e) => updateItem(i, 'service_id', e.target.value)}>
                    <option value="">{t('billing.invoice.servicePlaceholder')}</option>
                    {servicesForClinic(it.clinic_id).map((s) => <option key={s.service_id} value={s.service_id}>{s.service_name}</option>)}
                  </select>
                </Field>
              </div>
              <div className="form-row">
                <Field label={t('billing.invoice.doctor')}>
                  <select value={it.doctor_id} onChange={(e) => updateItem(i, 'doctor_id', e.target.value)}>
                    <option value="">{t('billing.invoice.doctorPlaceholder')}</option>
                    {doctorsForClinic(it.clinic_id).map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
                  </select>
                </Field>
                <Field label={t('billing.invoice.price')} required><input type="number" min="0" step="0.01" required value={it.price} onChange={(e) => updateItem(i, 'price', e.target.value)} /></Field>
                <Field label={t('billing.invoice.quantity')} required><input type="number" min="1" step="1" required value={it.quantity ?? '1'} onChange={(e) => updateItem(i, 'quantity', e.target.value)} /></Field>
              </div>
              {items.length > 1 && <button type="button" className="text-button danger" onClick={() => removeItem(i)}>{t('billing.invoice.deleteItem')}</button>}
            </div>
          ))}
        </div>
      )}

      <div className="form-row">
        <Field label={t('billing.invoice.discount')}><input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
        <Field label={t('billing.invoice.total')}><span className="calc-value">{fmtMoney(total, baseCurrency)}</span></Field>
      </div>
      <div className="calc-total">{t('billing.invoice.finalInvoice')}: <strong>{fmtMoney(net, baseCurrency)}</strong></div>

      <Notice kind="error">{error}</Notice>
      {done && <Notice kind="success">{t('billing.invoice.success', { id: done.invoice_id, amount: fmtMoney(done.net_amount, baseCurrency) })}</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving || items.length === 0 || !patientId}>{saving ? t('billing.invoice.submitting') : t('billing.invoice.submit')}</button>
      </div>
    </form>
    <InvoicesList refreshKey={done} />
    </div>
  )
}

// قائمة الفواتير: صف واحد لكل فاتورة (البنود مجمّعة داخلها) + عرض/طباعة
function InvoicesList({ refreshKey }) {
  const t = useT()
  const baseCurrency = useBaseCurrency()
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [viewing, setViewing] = useState(null)

  const load = () => {
    api.billing.listInvoices({ limit: 20 })
      .then((r) => setRows(r.invoices || []))
      .catch((err) => { console.error('invoices load error:', err); setError(err.message); setRows([]) })
  }
  useEffect(() => { load() }, [])
  useEffect(() => { if (refreshKey) load() }, [refreshKey])

  async function openInvoice(id) {
    setActionError('')
    try {
      const r = await api.billing.getInvoice(id)
      setViewing(r.invoice)
    } catch (err) { setActionError(err.message || t('billing.invoices.errorLoad')) }
  }

  async function printInvoice(id) {
    setActionError('')
    try {
      const r = await api.billing.getInvoice(id)
      printInvoiceHtml(r.invoice, t, baseCurrency)
    } catch (err) { setActionError(err.message || t('billing.invoices.errorPrint')) }
  }

  return (
    <div className="record-block" style={{ marginTop: 16 }}>
      <h4>{t('billing.invoices.list.title')}</h4>
      <Notice kind="error">{error || actionError}</Notice>
      {rows.length === 0 ? <Empty text={t('billing.invoices.list.empty')} /> : (
        <div className="table-wrap table-cards"><table>
          <thead><tr>
            <th>{t('billing.invoices.list.number')}</th><th>{t('billing.invoices.list.patient')}</th><th>{t('billing.invoices.list.clinic')}</th><th>{t('billing.invoices.list.doctor')}</th><th>{t('billing.invoices.list.items')}</th>
            <th>{t('billing.invoices.list.total')}</th><th>{t('billing.invoices.list.paid')}</th><th>{t('billing.invoices.list.remaining')}</th><th>{t('billing.invoices.list.status')}</th><th>{t('billing.invoices.list.date')}</th><th>{t('billing.invoices.list.actions')}</th>
          </tr></thead>
          <tbody>
            {rows.map((inv) => {
              const st = INVOICE_STATUS[inv.status] || { cls: 'scheduled' }
              return (
                <tr key={inv.invoice_id}>
                  <td dir="ltr" className="strong-cell">{fmtInvoiceNumber(inv.invoice_id, inv.created_at)}</td>
                  <td data-label={t('billing.invoices.list.patient')}>{inv.patient_name || t('billing.invoices.list.unknownPatient', { id: inv.patient_id })}</td>
                  <td data-label={t('billing.invoices.list.clinic')}>{inv.clinic_names?.join('، ') || '—'}</td>
                  <td data-label={t('billing.invoices.list.doctor')}>{inv.doctor_names?.join('، ') || '—'}</td>
                  <td data-label={t('billing.invoices.list.items')}>{fmtNumber(inv.items_count)}</td>
                  <td data-label={t('billing.invoices.list.total')}>{fmtMoney(inv.net_amount, baseCurrency)}</td>
                  <td data-label={t('billing.invoices.list.paid')}>{fmtMoney(inv.paid_amount, baseCurrency)}</td>
                  <td data-label={t('billing.invoices.list.remaining')}>{fmtMoney(inv.remaining, baseCurrency)}</td>
                  <td data-label={t('billing.invoices.list.status')}><span className={`status ${st.cls}`}>{t('invoiceStatus.' + inv.status)}</span></td>
                  <td data-label={t('billing.invoices.list.date')}>{fmtDate(inv.created_at, true)}</td>
                  <td className="cell-actions" data-label={t('billing.invoices.list.actions')}>
                    <div className="row-actions">
                      <button type="button" className="text-button" onClick={() => openInvoice(inv.invoice_id)}>{t('billing.invoices.list.view')}</button>
                      <button type="button" className="text-button" onClick={() => printInvoice(inv.invoice_id)}>{t('billing.invoices.list.print')}</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
      {viewing && <InvoiceViewModal invoice={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

// طباعة الفاتورة فقط عبر نافذة معزولة بأنماط A4 (لا تطبع واجهة النظام)
function printInvoiceHtml(invoice, t, baseCurrency) {
  const st = INVOICE_STATUS[invoice.status] || { label: invoice.status || '' }
  const esc = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const clinicNames = [...new Set((invoice.items || []).map((x) => x.clinic_name).filter(Boolean))].join('، ')
  const doctorNames = [...new Set((invoice.items || []).map((x) => x.doctor_name).filter(Boolean))].join('، ')
  const itemsRows = (invoice.items || []).map((it, i) => (
    `<tr><td>${i + 1}</td><td>${esc(it.service_name || t('billing.print.noService'))}</td><td>${esc(it.clinic_name || '—')}</td>`
    + `<td>${esc(it.doctor_name || '—')}</td><td>${esc(it.quantity ?? 1)}</td>`
    + `<td>${esc(fmtMoney(it.price, baseCurrency))}</td><td>${esc(fmtMoney(it.line_total ?? Number(it.price) * Number(it.quantity ?? 1), baseCurrency))}</td></tr>`
  )).join('')
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
    <title>${esc(fmtInvoiceNumber(invoice.invoice_id, invoice.created_at))}</title>
    <style>
      @page { size: A4; margin: 14mm; }
      * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
      body { margin: 0; color: #1c2b2b; font-size: 13px; }
      .inv-header { display: flex; justify-content: space-between; border-bottom: 2px solid #1c7c74; padding-bottom: 10px; }
      .inv-header h1 { font-size: 20px; margin: 0 0 4px; color: #1c7c74; }
      .inv-header .inv-meta { text-align: left; font-size: 12px; color: #4a5b5b; }
      .inv-section { margin-top: 14px; }
      .inv-section h3 { font-size: 13px; margin: 0 0 6px; color: #1c7c74; border-bottom: 1px solid #d7e5e3; padding-bottom: 3px; }
      .inv-info { display: flex; gap: 24px; flex-wrap: wrap; }
      .inv-info > div { min-width: 220px; }
      table { width: 100%; border-collapse: collapse; margin-top: 4px; }
      th, td { border: 1px solid #d7e5e3; padding: 6px 8px; text-align: right; font-size: 12px; }
      th { background: #eef5f3; }
      .inv-summary { margin-top: 14px; margin-inline-start: auto; width: 320px; }
      .inv-summary .row { display: flex; justify-content: space-between; padding: 4px 8px; border-bottom: 1px dashed #d7e5e3; }
      .inv-summary .row.total { font-weight: 700; color: #1c7c74; font-size: 14px; }
      .inv-status { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eef5f3; font-size: 12px; }
      .inv-footer { margin-top: 22px; text-align: center; color: #7a8c8c; font-size: 11px; border-top: 1px solid #d7e5e3; padding-top: 8px; }
    </style></head><body>
    <div class="inv-header">
      <div><h1>${t('billing.print.hospitalName')}</h1><div>${esc(clinicNames)}</div></div>
      <div class="inv-meta">
        <div><strong>${t('billing.print.invoiceNumber')}:</strong> ${esc(fmtInvoiceNumber(invoice.invoice_id, invoice.created_at))}</div>
        <div><strong>${t('billing.print.date')}:</strong> ${esc(fmtDate(invoice.created_at, true))}</div>
        <div><strong>${t('billing.print.paymentStatus')}:</strong> <span class="inv-status">${esc(t('invoiceStatus.' + (invoice.status || '')))}</span></div>
      </div>
    </div>
    <div class="inv-section inv-info">
      <div><h3>${t('billing.print.patientData')}</h3>
        <div><strong>${t('billing.print.name')}:</strong> ${esc(invoice.patient_name || t('billing.print.unknownPatient', { id: invoice.patient_id }))}</div>
        <div><strong>${t('billing.print.fileNumber')}:</strong> ${esc(invoice.patient_id)}</div>
        ${invoice.phone ? `<div><strong>${t('billing.print.phone')}:</strong> ${esc(invoice.phone)}</div>` : ''}
      </div>
      <div><h3>${t('billing.print.invoiceData')}</h3>
        <div><strong>${t('billing.print.doctor')}:</strong> ${esc(doctorNames || '—')}</div>
        <div><strong>${t('billing.print.paymentMethod')}:</strong> ${esc(PAYMENT_TYPES[invoice.payment_type]?.label ? t('paymentType.' + invoice.payment_type) : invoice.payment_type || '—')}</div>
      </div>
    </div>
    <div class="inv-section">
      <h3>${t('billing.print.servicesItems')}</h3>
      <table>
        <thead><tr><th>#</th><th>${t('billing.print.service')}</th><th>${t('billing.print.clinic')}</th><th>${t('billing.print.doctor')}</th><th>${t('billing.print.qty')}</th><th>${t('billing.print.unitPrice')}</th><th>${t('billing.print.total')}</th></tr></thead>
        <tbody>${itemsRows || `<tr><td colspan="7">${t('billing.print.noItems')}</td></tr>`}</tbody>
      </table>
    </div>
    <div class="inv-summary">
      <div class="row"><span>${t('billing.print.subtotal')}</span><span>${esc(fmtMoney(invoice.total_amount, baseCurrency))}</span></div>
      <div class="row"><span>${t('billing.print.discount')}</span><span>${esc(fmtMoney(invoice.discount_amount, baseCurrency))}</span></div>
      <div class="row total"><span>${t('billing.print.netTotal')}</span><span>${esc(fmtMoney(invoice.net_amount, baseCurrency))}</span></div>
      <div class="row"><span>${t('billing.print.paid')}</span><span>${esc(fmtMoney(invoice.paid_amount, baseCurrency))}</span></div>
      <div class="row"><span>${t('billing.print.remaining')}</span><span>${esc(fmtMoney(invoice.remaining, baseCurrency))}</span></div>
    </div>
    <div class="inv-footer">${t('billing.print.footer')}</div>
    <script>window.onload = function () { window.focus(); window.print(); }</script>
    </body></html>`
  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) return
  win.document.open()
  win.document.write(html)
  win.document.close()
}

// نافذة عرض الفاتورة كاملة مع بنودها وملخصها المالي (تنطبق عليها أنماط الفاتورة invoice-sheet عند الطباعة)
function InvoiceViewModal({ invoice, onClose }) {
  const t = useT()
  const baseCurrency = useBaseCurrency()
  const st = INVOICE_STATUS[invoice.status] || { label: invoice.status, cls: 'scheduled' }
  const items = invoice.items || []
  return (
    <Modal wide title={t('billing.invoice.view.title', { number: fmtInvoiceNumber(invoice.invoice_id, invoice.created_at) })} subtitle={t('billing.invoice.view.subtitle')} onClose={onClose}>
      <div className="invoice-detail invoice-sheet">
        <div className="inv-meta-grid">
          <div className="record-block"><h4>{t('billing.invoice.view.patientData')}</h4>
            <p><strong>{t('billing.invoice.view.name')}:</strong> {invoice.patient_name || t('billing.invoice.view.unknownPatient', { id: invoice.patient_id })}</p>
            <p><strong>{t('billing.invoice.view.fileNumber')}:</strong> {invoice.patient_id}</p>
            {invoice.phone && <p><strong>{t('billing.invoice.view.phone')}:</strong> <span dir="ltr">{invoice.phone}</span></p>}
          </div>
          <div className="record-block"><h4>{t('billing.invoice.view.invoiceData')}</h4>
            <p><strong>{t('billing.invoice.view.clinic')}:</strong> {[...new Set(items.map((x) => x.clinic_name).filter(Boolean))].join('، ') || '—'}</p>
            <p><strong>{t('billing.invoice.view.doctor')}:</strong> {[...new Set(items.map((x) => x.doctor_name).filter(Boolean))].join('، ') || '—'}</p>
            <p><strong>{t('billing.invoice.view.date')}:</strong> {fmtDate(invoice.created_at, true)}</p>
            <p><strong>{t('billing.invoice.view.paymentMethod')}:</strong> {PAYMENT_TYPES[invoice.payment_type]?.label ? t('paymentType.' + invoice.payment_type) : invoice.payment_type || '—'}</p>
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>{t('billing.invoice.view.service')}</th><th>{t('billing.invoice.view.clinic')}</th><th>{t('billing.invoice.view.doctor')}</th><th>{t('billing.invoice.view.qty')}</th><th>{t('billing.invoice.view.unitPrice')}</th><th>{t('billing.invoice.view.total')}</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.item_id}>
                <td>{it.service_name || t('billing.invoice.view.noService')}</td>
                <td>{it.clinic_name || '—'}</td>
                <td>{it.doctor_name || '—'}</td>
                <td>{it.quantity ?? 1}</td>
                <td>{fmtMoney(it.price, baseCurrency)}</td>
                <td>{fmtMoney(it.line_total, baseCurrency)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="invoice-summary">
          <div className="sum-row"><span>{t('billing.invoice.view.subtotal')}</span><span>{fmtMoney(invoice.total_amount, baseCurrency)}</span></div>
          <div className="sum-row"><span>{t('billing.invoice.view.discount')}</span><span>{fmtMoney(invoice.discount_amount, baseCurrency)}</span></div>
          <div className="sum-row total"><span>{t('billing.invoice.view.netTotal')}</span><span>{fmtMoney(invoice.net_amount, baseCurrency)}</span></div>
          <div className="sum-row"><span>{t('billing.invoice.view.paid')}</span><span>{fmtMoney(invoice.paid_amount, baseCurrency)}</span></div>
          <div className="sum-row"><span>{t('billing.invoice.view.remaining')}</span><span>{fmtMoney(invoice.remaining, baseCurrency)}</span></div>
          <div className="sum-row"><span>{t('billing.invoice.view.status')}</span><span className={`status ${st.cls}`}>{t('invoiceStatus.' + invoice.status)}</span></div>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => printInvoiceHtml(invoice, t, baseCurrency)}>{t('billing.invoice.view.print')}</button>
          <button className="primary-button" onClick={onClose}>{t('billing.invoice.view.close')}</button>
        </div>
      </div>
    </Modal>
  )
}

function ServicesTab({ canManageServices }) {
  const t = useT()
  return (
    <div className="tab-inner">
      <div className="tab-grid two">
        {canManageServices && (
          <div className="record-block"><h4>{t('billing.services.create')}</h4><ServiceForm /></div>
        )}
        <div className="record-block"><h4>{t('billing.services.list')}</h4><ServicesList /></div>
      </div>
    </div>
  )
}

function useClinicsDirectory() {
  const [clinics, setClinics] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    // استخدام الدليل المالي للمحاسب والأدوار المالية المركزية
    api.clinics.financialDirectory()
      .then((r) => setClinics(r.clinics || []))
      .catch((err) => { setError(err.message); setClinics([]) })
  }, [])
  return { clinics, error }
}

function ServicesList() {
  const t = useT()
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [selected, setSelected] = useState(null) // { mode: 'view'|'edit', service }
  const baseCurrency = useBaseCurrency()

  const load = () => {
    api.billing.listServices({ limit: 100 })
      .then((r) => setRows(r.services || []))
      .catch((err) => { console.error('services load error:', err); setError(err.message); setRows([]) })
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const h = () => load()
    window.addEventListener('billing:services-changed', h)
    return () => window.removeEventListener('billing:services-changed', h)
  }, [])

  async function openService(id, mode) {
    setActionError(''); setActionNotice('')
    try {
      const r = await api.billing.getService(id)
      setSelected({ mode, service: r.service })
    } catch (err) { setActionError(err.message || t('billing.services.loadError')) }
  }

  async function removeService(s) {
    setActionError(''); setActionNotice('')
    if (!window.confirm(t('billing.services.confirmDelete', { name: s.service_name }))) return
    try {
      const r = await api.billing.deleteService(s.service_id)
      setActionNotice(r.soft_deleted ? t('billing.services.softDeletedNotice') : t('billing.services.deletedSuccess'))
      window.dispatchEvent(new Event('billing:services-changed'))
    } catch (err) { setActionError(err.message || t('billing.services.deleteError')) }
  }

  return (
    <div>
      <Notice kind="error">{error || actionError}</Notice>
      <Notice kind="success">{actionNotice}</Notice>
      {rows.length === 0 ? <Empty text={t('billing.services.empty')} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t('billing.services.col.name')}</th><th>{t('billing.services.col.clinic')}</th><th>{t('billing.services.col.price')}</th><th>{t('billing.services.col.doctorPct')}</th><th>{t('billing.services.col.status')}</th><th>{t('billing.services.col.actions')}</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.service_id} className={s.is_active === false ? 'row-muted' : ''}>
                <td>{s.service_name}</td>
                <td>{s.clinic_name || t('billing.services.unknownClinic', { id: s.clinic_id })}</td>
                <td>{fmtMoney(s.price, baseCurrency)}</td>
                <td>{fmtNumber(s.doctor_percentage)}%</td>
                <td>{s.is_active === false ? t('billing.services.status.inactive') : t('billing.services.status.active')}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="text-button" onClick={() => openService(s.service_id, 'view')}>{t('billing.services.action.view')}</button>
                    <button type="button" className="text-button" onClick={() => openService(s.service_id, 'edit')}>{t('billing.services.action.edit')}</button>
                    <button type="button" className="text-button danger" onClick={() => removeService(s)}>{t('billing.services.action.delete')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {selected && <ServiceModal mode={selected.mode} service={selected.service} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); load() }} />}
    </div>
  )
}

// نافذة عرض/تعديل خدمة (حصص الطبيب والمركز محسوبة في الخادم)
function ServiceModal({ mode, service, onClose, onSaved }) {
  const t = useT()
  const isEdit = mode === 'edit'
  const [form, setForm] = useState({
    service_name: service.service_name || '',
    price: String(service.price ?? ''),
    doctor_percentage: String(service.doctor_percentage ?? 0),
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const baseCurrency = useBaseCurrency()
  const price = Number(form.price) || 0
  const pct = Number(form.doctor_percentage) || 0
  const displayDoctorShare = Math.round((price * pct / 100) * 100) / 100

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.billing.updateService(service.service_id, {
        service_name: form.service_name,
        price: Number(form.price),
        doctor_percentage: Number(form.doctor_percentage),
      })
      window.dispatchEvent(new Event('billing:services-changed'))
      onSaved?.()
    } catch (err) { setError(err.message || t('billing.services.saveError')) } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? t('billing.services.modal.editTitle', { name: service.service_name }) : t('billing.services.modal.viewTitle', { name: service.service_name })} subtitle={isEdit ? t('billing.services.modal.editSubtitle') : t('billing.services.modal.viewSubtitle')} onClose={onClose}>
      {isEdit ? (
        <form className="patient-form" onSubmit={submit}>
          <Field label={t('billing.services.form.name')} required><input required value={form.service_name} onChange={(e) => setForm({ ...form, service_name: e.target.value })} /></Field>
          <div className="form-row">
            <Field label={t('billing.services.form.price')} required><input type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
            <Field label={t('billing.services.form.doctorPct')} required><input type="number" min="0" max="100" required value={form.doctor_percentage} onChange={(e) => setForm({ ...form, doctor_percentage: e.target.value })} /></Field>
          </div>
          <Notice kind="error">{error}</Notice>
          <div className="calc-total">{t('billing.services.calc.doctorShare')}: <strong>{fmtMoney(displayDoctorShare, baseCurrency)}</strong> · {t('billing.services.calc.centerShare')}: <strong>{fmtMoney(Math.max(0, price - displayDoctorShare), baseCurrency)}</strong></div>
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? t('billing.services.saving') : t('billing.services.save')}</button>
            <button type="button" className="secondary-button" onClick={onClose}>{t('billing.services.cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="service-detail">
          <p><strong>{t('billing.services.detail.name')}:</strong> {service.service_name}</p>
          <p><strong>{t('billing.services.detail.clinic')}:</strong> {service.clinic_name || t('billing.services.unknownClinic', { id: service.clinic_id })}</p>
          <p><strong>{t('billing.services.detail.price')}:</strong> {fmtMoney(service.price, baseCurrency)}</p>
          <p><strong>{t('billing.services.detail.doctorPct')}:</strong> {fmtNumber(service.doctor_percentage)}%</p>
          <p><strong>{t('billing.services.detail.doctorShare')}:</strong> {fmtMoney(service.doctor_share, baseCurrency)}</p>
          <p><strong>{t('billing.services.detail.centerShare')}:</strong> {fmtMoney(service.center_share, baseCurrency)}</p>
          <p><strong>{t('billing.services.detail.status')}:</strong> {service.is_active === false ? t('billing.services.status.inactive') : t('billing.services.status.active')}</p>
          {service.created_at && <p><strong>{t('billing.services.detail.createdAt')}:</strong> {fmtDate(service.created_at, true)}</p>}
          {service.updated_at && <p><strong>{t('billing.services.detail.updatedAt')}:</strong> {fmtDate(service.updated_at, true)}</p>}
          <div className="modal-actions"><button className="primary-button" onClick={onClose}>{t('billing.services.close')}</button></div>
        </div>
      )}
    </Modal>
  )
}

function ServiceForm() {
  const t = useT()
  const { user } = useAuth()
  const { clinics, error: clinicsError } = useClinicsDirectory()
  const [form, setForm] = useState({ clinic_id: user?.clinicId || '', service_name: '', price: '', doctor_percentage: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.billing.createService({
        clinic_id: Number(form.clinic_id) || user?.clinicId,
        service_name: form.service_name,
        price: Number(form.price),
        doctor_percentage: form.doctor_percentage ? Number(form.doctor_percentage) : undefined,
      })
      setDone(true)
      window.dispatchEvent(new Event('billing:services-changed'))
      setForm({ clinic_id: user?.clinicId || '', service_name: '', price: '', doctor_percentage: '' })
    } catch (err) {
      setError(err.message || t('billing.services.addError'))
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <Field label={t('billing.services.form.clinic')} required hint={t('billing.services.form.clinicHint')}>
        <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
          <option value="">{t('billing.services.form.clinicPlaceholder')}</option>
          {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
        </select>
      </Field>
      <Field label={t('billing.services.form.name')} required><input required value={form.service_name} onChange={(e) => setForm({ ...form, service_name: e.target.value })} /></Field>
      <div className="form-row">
        <Field label={t('billing.services.form.price')} required><input type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
        <Field label={t('billing.services.form.doctorPct')}><input type="number" min="0" max="100" value={form.doctor_percentage} onChange={(e) => setForm({ ...form, doctor_percentage: e.target.value })} /></Field>
      </div>
      <Notice kind="error">{error || clinicsError}</Notice>
      {done && <Notice kind="success">{t('billing.services.addSuccess')}</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? t('billing.services.saving') : t('billing.services.add')}</button>
      </div>
    </form>
  )
}

function ExpensesTab({ canCreateExpense }) {
  const t = useT()
  return (
    <div className="tab-inner">
      <div className="tab-grid two">
        {canCreateExpense && (
          <div className="record-block"><h4>{t('billing.expenses.create')}</h4><ExpenseForm /></div>
        )}
        <div className="record-block"><h4>{t('billing.expenses.list')}</h4><ExpensesList /></div>
      </div>
    </div>
  )
}

function ExpensesList() {
  const t = useT()
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [selected, setSelected] = useState(null) // { mode: 'view'|'edit', expense }
  const baseCurrency = useBaseCurrency()

  const load = () => {
    api.billing.listExpenses({ limit: 100 })
      .then((r) => setRows(r.expenses || []))
      .catch((err) => { console.error('expenses load error:', err); setError(err.message); setRows([]) })
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const h = () => load()
    window.addEventListener('billing:expenses-changed', h)
    return () => window.removeEventListener('billing:expenses-changed', h)
  }, [])

  async function openExpense(id, mode) {
    setActionError(''); setActionNotice('')
    try {
      const r = await api.billing.getExpense(id)
      setSelected({ mode, expense: r.expense })
    } catch (err) { setActionError(err.message || t('billing.expenses.loadError')) }
  }

  async function removeExpense(e2) {
    setActionError(''); setActionNotice('')
    if (!window.confirm(t('billing.expenses.confirmDelete', { category: e2.category, amount: fmtMoney(e2.amount, baseCurrency) }))) return
    try {
      const r = await api.billing.deleteExpense(e2.expense_id)
      setActionNotice(r.soft_deleted ? t('billing.expenses.softDeletedNotice') : t('billing.expenses.deletedSuccess'))
      window.dispatchEvent(new Event('billing:expenses-changed'))
    } catch (err) { setActionError(err.message || t('billing.expenses.deleteError')) }
  }

  return (
    <div>
      <Notice kind="error">{error || actionError}</Notice>
      <Notice kind="success">{actionNotice}</Notice>
      {rows.length === 0 ? <Empty text={t('billing.expenses.empty')} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t('billing.expenses.col.category')}</th><th>{t('billing.expenses.col.clinic')}</th><th>{t('billing.expenses.col.amount')}</th><th>{t('billing.expenses.col.recordedBy')}</th><th>{t('billing.expenses.col.date')}</th><th>{t('billing.expenses.col.actions')}</th></tr></thead>
          <tbody>
            {rows.map((e2) => (
              <tr key={e2.expense_id}>
                <td>{e2.category}</td>
                <td>{e2.clinic_name || (e2.clinic_id ? t('billing.expenses.unknownClinic', { id: e2.clinic_id }) : t('billing.expenses.none'))}</td>
                <td>{fmtMoney(e2.amount, baseCurrency)}</td>
                <td>{e2.spent_by_name || t('billing.expenses.none')}</td>
                <td>{fmtDate(e2.created_at, true)}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="text-button" onClick={() => openExpense(e2.expense_id, 'view')}>{t('billing.expenses.action.view')}</button>
                    <button type="button" className="text-button" onClick={() => openExpense(e2.expense_id, 'edit')}>{t('billing.expenses.action.edit')}</button>
                    <button type="button" className="text-button danger" onClick={() => removeExpense(e2)}>{t('billing.expenses.action.delete')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {selected && <ExpenseModal mode={selected.mode} expense={selected.expense} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); load() }} />}
    </div>
  )
}

// نافذة عرض/تعديل مصروف
function ExpenseModal({ mode, expense, onClose, onSaved }) {
  const t = useT()
  const isEdit = mode === 'edit'
  const [form, setForm] = useState({
    category: expense.category || '',
    amount: String(expense.amount ?? ''),
    description: expense.description || '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const baseCurrency = useBaseCurrency()

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.billing.updateExpense(expense.expense_id, {
        category: form.category,
        amount: Number(form.amount),
        description: form.description,
      })
      window.dispatchEvent(new Event('billing:expenses-changed'))
      onSaved?.()
    } catch (err) { setError(err.message || t('billing.expenses.saveError')) } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? t('billing.expenses.modal.editTitle', { category: expense.category }) : t('billing.expenses.modal.viewTitle', { id: expense.expense_id })} subtitle={isEdit ? t('billing.expenses.modal.editSubtitle') : t('billing.expenses.modal.viewSubtitle')} onClose={onClose}>
      {isEdit ? (
        <form className="patient-form" onSubmit={submit}>
          <Field label={t('billing.expenses.form.category')} required><input required value={form.category} onChange={(e2) => setForm({ ...form, category: e2.target.value })} /></Field>
          <Field label={t('billing.expenses.form.amount')} required><input type="number" min="0" step="0.01" required value={form.amount} onChange={(e2) => setForm({ ...form, amount: e2.target.value })} /></Field>
          <Field label={t('billing.expenses.form.description')}><textarea rows={3} value={form.description} onChange={(e2) => setForm({ ...form, description: e2.target.value })} /></Field>
          <Notice kind="error">{error}</Notice>
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? t('billing.expenses.saving') : t('billing.expenses.save')}</button>
            <button type="button" className="secondary-button" onClick={onClose}>{t('billing.expenses.cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="expense-detail">
          <p><strong>{t('billing.expenses.detail.id')}:</strong> #{expense.expense_id}</p>
          <p><strong>{t('billing.expenses.detail.clinic')}:</strong> {expense.clinic_name || (expense.clinic_id ? t('billing.expenses.unknownClinic', { id: expense.clinic_id }) : t('billing.expenses.none'))}</p>
          <p><strong>{t('billing.expenses.detail.category')}:</strong> {expense.category}</p>
          <p><strong>{t('billing.expenses.detail.amount')}:</strong> {fmtMoney(expense.amount, baseCurrency)}</p>
          <p><strong>{t('billing.expenses.detail.description')}:</strong> {expense.description || t('billing.expenses.none')}</p>
          <p><strong>{t('billing.expenses.detail.date')}:</strong> {fmtDate(expense.created_at, true)}</p>
          <p><strong>{t('billing.expenses.detail.createdBy')}:</strong> {expense.spent_by_name || t('billing.expenses.none')}</p>
          <div className="modal-actions"><button className="primary-button" onClick={onClose}>{t('billing.expenses.close')}</button></div>
        </div>
      )}
    </Modal>
  )
}

function ExpenseForm() {
  const t = useT()
  const { user } = useAuth()
  const { clinics, error: clinicsError } = useClinicsDirectory()
  const [form, setForm] = useState({ clinic_id: user?.clinicId || '', category: '', amount: '', description: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.billing.createExpense({
        clinic_id: Number(form.clinic_id) || user?.clinicId,
        category: form.category,
        amount: Number(form.amount),
        description: form.description || undefined,
      })
      setDone(true)
      window.dispatchEvent(new Event('billing:expenses-changed'))
      setForm({ clinic_id: user?.clinicId || '', category: '', amount: '', description: '' })
    } catch (err) {
      setError(err.message || t('billing.expenses.saveError'))
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label={t('billing.expenses.form.clinic')} required hint={t('billing.expenses.form.clinicHint')}>
          <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
            <option value="">{t('billing.expenses.form.clinicPlaceholder')}</option>
            {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
          </select>
        </Field>
        <Field label={t('billing.expenses.form.category')} required><input required placeholder={t('billing.expenses.form.categoryPlaceholder')} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
      </div>
      <Field label={t('billing.expenses.form.amount')} required><input type="number" min="0" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
      <Field label={t('billing.expenses.form.description')}><textarea rows="2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <Notice kind="error">{error || clinicsError}</Notice>
      {done && <Notice kind="success">{t('billing.expenses.saveSuccess')}</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? t('billing.expenses.saving') : t('billing.expenses.save')}</button>
      </div>
    </form>
  )
}