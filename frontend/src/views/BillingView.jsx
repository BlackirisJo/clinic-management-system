import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { fmtMoney, fmtDate, fmtNumber, PAYMENT_TYPES, INVOICE_STATUS, fmtInvoiceNumber } from '../lib/format'
import { Field, Loading, Empty, Notice, Modal } from '../components/ui'

export default function BillingView() {
  const [tab, setTab] = useState('invoices')
  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>الفواتير والمالية</h2><p>إصدار الفواتير والمصاريف والخدمات والمؤشرات الشهرية</p></div>
      </div>
      <div className="tabs">
        <button className={tab === 'invoices' ? 'tab active' : 'tab'} onClick={() => setTab('invoices')}>الفواتير والمؤشرات</button>
        <button className={tab === 'services' ? 'tab active' : 'tab'} onClick={() => setTab('services')}>خدمات العيادة</button>
        <button className={tab === 'expenses' ? 'tab active' : 'tab'} onClick={() => setTab('expenses')}>المصاريف</button>
      </div>
      <div className="tab-content">
        {tab === 'invoices' && <InvoicesTab />}
        {tab === 'services' && <ServicesTab />}
        {tab === 'expenses' && <ExpensesTab />}
      </div>
    </section>
  )
}

function InvoicesTab() {
  return (
    <div className="tab-inner">
      <div className="tab-grid two">
        <div className="record-block"><h4>إصدار فاتورة جديدة</h4><InvoiceForm /></div>
        <div className="record-block"><h4>المؤشرات المالية الشهرية</h4><KpisTable /></div>
      </div>
    </div>
  )
}

function KpisTable() {
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
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty text="لا توجد مؤشرات بعد" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>الشهر</th><th>العيادة</th><th>مرضى</th><th>زيارات</th><th>الإيراد</th><th>حصص الأطباء</th><th>الصافي</th></tr></thead>
            <tbody>
              {rows.map((k, i) => (
                <tr key={i}>
                  <td>{fmtDate(k.stat_month)}</td>
                  <td>{k.clinic_name || '—'}</td>
                  <td>{fmtNumber(k.unique_patients)}</td>
                  <td>{fmtNumber(k.total_visits)}</td>
                  <td>{fmtMoney(k.total_revenue)}</td>
                  <td>{fmtMoney(k.total_doctor_payout)}</td>
                  <td>{fmtMoney(k.net_clinic_margin)}</td>
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
  const { user } = useAuth()
  const [patients, setPatients] = useState([])
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

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const [pRes, cRes, dRes, sRes] = await Promise.all([
          api.patients.list({ limit: 100 }).catch((err) => { console.error('patients load error:', err); return { patients: [] } }),
          api.clinics.financialDirectory().catch((err) => { console.error('clinics directory error:', err); return { clinics: [] } }),
          api.users.doctors({ limit: 100 }).catch((err) => { console.error('doctors load error:', err); return { doctors: [] } }),
          api.billing.listServices({ limit: 100 }).catch((err) => { console.error('services load error:', err); return { services: [] } }),
        ])
        if (cancelled) return
        setPatients(pRes.patients || [])
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
  }, [])

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
      setError(err.message || 'تعذر إصدار الفاتورة')
    } finally { setSaving(false) }
  }

  return (
    <div>
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label="المريض" required>
          <select required value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">اختر المريض بالاسم...</option>
            {patients.map((p) => <option key={p.patient_id} value={p.patient_id}>{p.full_name}{p.phone ? ` (${p.phone})` : ''}</option>)}
          </select>
        </Field>
        <Field label="طريقة الدفع" required>
          <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
            {Object.entries(PAYMENT_TYPES).map(([key, val]) => <option key={key} value={key}>{val.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="items-head">
        <h4>عناصر الفاتورة</h4>
        <button type="button" className="secondary-button compact" onClick={addItem}>+ إضافة بند</button>
      </div>
      {items.length === 0 ? <Empty text="أضف بنداً واحداً على الأقل" /> : (
        <div className="items-list">
          {items.map((it, i) => (
            <div className="item-card" key={i}>
              <div className="form-row">
                <Field label="العيادة" required hint="اختر العيادة بالاسم">
                  <select required value={it.clinic_id} onChange={(e) => updateItem(i, 'clinic_id', e.target.value)}>
                    <option value="">اختر العيادة...</option>
                    {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
                  </select>
                </Field>
                <Field label="الخدمة (بالاسم)">
                  <select value={it.service_id} onChange={(e) => updateItem(i, 'service_id', e.target.value)}>
                    <option value="">اختر الخدمة...</option>
                    {servicesForClinic(it.clinic_id).map((s) => <option key={s.service_id} value={s.service_id}>{s.service_name}</option>)}
                  </select>
                </Field>
              </div>
              <div className="form-row">
                <Field label="الطبيب (بالاسم)">
                  <select value={it.doctor_id} onChange={(e) => updateItem(i, 'doctor_id', e.target.value)}>
                    <option value="">اختر الطبيب...</option>
                    {doctorsForClinic(it.clinic_id).map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
                  </select>
                </Field>
                <Field label="السعر" required><input type="number" min="0" step="0.01" required value={it.price} onChange={(e) => updateItem(i, 'price', e.target.value)} /></Field>
                <Field label="الكمية" required><input type="number" min="1" step="1" required value={it.quantity ?? '1'} onChange={(e) => updateItem(i, 'quantity', e.target.value)} /></Field>
              </div>
              {items.length > 1 && <button type="button" className="text-button danger" onClick={() => removeItem(i)}>حذف البند</button>}
            </div>
          ))}
        </div>
      )}

      <div className="form-row">
        <Field label="الخصم"><input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
        <Field label="الإجمالي"><span className="calc-value">{fmtMoney(total)}</span></Field>
      </div>
      <div className="calc-total">الفاتورة النهائية: <strong>{fmtMoney(net)}</strong></div>

      <Notice kind="error">{error}</Notice>
      {done && <Notice kind="success">تم إصدار الفاتورة #{done.invoice_id} بقيمة {fmtMoney(done.net_amount)}</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving || items.length === 0 || !patientId}>{saving ? 'جارِ الإصدار...' : 'إصدار الفاتورة'}</button>
      </div>
    </form>
    <InvoicesList refreshKey={done} />
    </div>
  )
}

// قائمة الفواتير: صف واحد لكل فاتورة (البنود مجمّعة داخلها) + عرض/طباعة
function InvoicesList({ refreshKey }) {
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
    } catch (err) { setActionError(err.message || 'تعذر جلب الفاتورة') }
  }

  async function printInvoice(id) {
    setActionError('')
    try {
      const r = await api.billing.getInvoice(id)
      printInvoiceHtml(r.invoice)
    } catch (err) { setActionError(err.message || 'تعذر تجهيز الطباعة') }
  }

  return (
    <div className="record-block" style={{ marginTop: 16 }}>
      <h4>أحدث الفواتير</h4>
      <Notice kind="error">{error || actionError}</Notice>
      {rows.length === 0 ? <Empty text="لا توجد فواتير بعد" /> : (
        <div className="table-wrap"><table>
          <thead><tr>
            <th>رقم الفاتورة</th><th>المريض</th><th>العيادة</th><th>الطبيب</th><th>البنود</th>
            <th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th>التاريخ</th><th>الإجراءات</th>
          </tr></thead>
          <tbody>
            {rows.map((inv) => {
              const st = INVOICE_STATUS[inv.status] || { label: inv.status, cls: 'scheduled' }
              return (
                <tr key={inv.invoice_id}>
                  <td dir="ltr" className="strong-cell">{fmtInvoiceNumber(inv.invoice_id, inv.created_at)}</td>
                  <td>{inv.patient_name || `مريض #${inv.patient_id}`}</td>
                  <td>{inv.clinic_names?.join('، ') || '—'}</td>
                  <td>{inv.doctor_names?.join('، ') || '—'}</td>
                  <td>{fmtNumber(inv.items_count)}</td>
                  <td>{fmtMoney(inv.net_amount)}</td>
                  <td>{fmtMoney(inv.paid_amount)}</td>
                  <td>{fmtMoney(inv.remaining)}</td>
                  <td><span className={`status ${st.cls}`}>{st.label}</span></td>
                  <td>{fmtDate(inv.created_at, true)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="text-button" onClick={() => openInvoice(inv.invoice_id)}>عرض</button>
                      <button type="button" className="text-button" onClick={() => printInvoice(inv.invoice_id)}>طباعة</button>
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
function printInvoiceHtml(invoice) {
  const st = INVOICE_STATUS[invoice.status] || { label: invoice.status || '' }
  const esc = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const clinicNames = [...new Set((invoice.items || []).map((x) => x.clinic_name).filter(Boolean))].join('، ')
  const doctorNames = [...new Set((invoice.items || []).map((x) => x.doctor_name).filter(Boolean))].join('، ')
  const itemsRows = (invoice.items || []).map((it, i) => (
    `<tr><td>${i + 1}</td><td>${esc(it.service_name || 'خدمة يدوية')}</td><td>${esc(it.clinic_name || '—')}</td>`
    + `<td>${esc(it.doctor_name || '—')}</td><td>${esc(it.quantity ?? 1)}</td>`
    + `<td>${esc(fmtMoney(it.price))}</td><td>${esc(fmtMoney(it.line_total ?? Number(it.price) * Number(it.quantity ?? 1)))}</td></tr>`
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
      <div><h1>المركز الطبي — نظام إدارة العيادات</h1><div>${esc(clinicNames)}</div></div>
      <div class="inv-meta">
        <div><strong>رقم الفاتورة:</strong> ${esc(fmtInvoiceNumber(invoice.invoice_id, invoice.created_at))}</div>
        <div><strong>التاريخ:</strong> ${esc(fmtDate(invoice.created_at, true))}</div>
        <div><strong>حالة الدفع:</strong> <span class="inv-status">${esc(st.label)}</span></div>
      </div>
    </div>
    <div class="inv-section inv-info">
      <div><h3>بيانات المريض</h3>
        <div><strong>الاسم:</strong> ${esc(invoice.patient_name || `مريض #${invoice.patient_id}`)}</div>
        <div><strong>رقم الملف:</strong> ${esc(invoice.patient_id)}</div>
        ${invoice.phone ? `<div><strong>الهاتف:</strong> ${esc(invoice.phone)}</div>` : ''}
      </div>
      <div><h3>بيانات الفاتورة</h3>
        <div><strong>الطبيب:</strong> ${esc(doctorNames || '—')}</div>
        <div><strong>طريقة الدفع:</strong> ${esc(PAYMENT_TYPES[invoice.payment_type]?.label || invoice.payment_type)}</div>
      </div>
    </div>
    <div class="inv-section">
      <h3>الخدمات والبنود</h3>
      <table>
        <thead><tr><th>#</th><th>الخدمة</th><th>العيادة</th><th>الطبيب</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
        <tbody>${itemsRows || '<tr><td colspan="7">لا بنود</td></tr>'}</tbody>
      </table>
    </div>
    <div class="inv-summary">
      <div class="row"><span>الإجمالي قبل الخصم</span><span>${esc(fmtMoney(invoice.total_amount))}</span></div>
      <div class="row"><span>الخصم</span><span>${esc(fmtMoney(invoice.discount_amount))}</span></div>
      <div class="row total"><span>الإجمالي النهائي</span><span>${esc(fmtMoney(invoice.net_amount))}</span></div>
      <div class="row"><span>المدفوع</span><span>${esc(fmtMoney(invoice.paid_amount))}</span></div>
      <div class="row"><span>المتبقي</span><span>${esc(fmtMoney(invoice.remaining))}</span></div>
    </div>
    <div class="inv-footer">هذه فاتورة إلكترونية صادرة من نظام إدارة العيادات — شكراً لثقتكم</div>
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
  const st = INVOICE_STATUS[invoice.status] || { label: invoice.status, cls: 'scheduled' }
  const items = invoice.items || []
  return (
    <Modal wide title={`فاتورة ${fmtInvoiceNumber(invoice.invoice_id, invoice.created_at)}`} subtitle="عرض الفاتورة" onClose={onClose}>
      <div className="invoice-detail invoice-sheet">
        <div className="inv-meta-grid">
          <div className="record-block"><h4>بيانات المريض</h4>
            <p><strong>الاسم:</strong> {invoice.patient_name || `مريض #${invoice.patient_id}`}</p>
            <p><strong>رقم الملف:</strong> {invoice.patient_id}</p>
            {invoice.phone && <p><strong>الهاتف:</strong> <span dir="ltr">{invoice.phone}</span></p>}
          </div>
          <div className="record-block"><h4>بيانات الفاتورة</h4>
            <p><strong>العيادة:</strong> {[...new Set(items.map((x) => x.clinic_name).filter(Boolean))].join('، ') || '—'}</p>
            <p><strong>الطبيب:</strong> {[...new Set(items.map((x) => x.doctor_name).filter(Boolean))].join('، ') || '—'}</p>
            <p><strong>التاريخ:</strong> {fmtDate(invoice.created_at, true)}</p>
            <p><strong>طريقة الدفع:</strong> {PAYMENT_TYPES[invoice.payment_type]?.label || invoice.payment_type}</p>
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>الخدمة</th><th>العيادة</th><th>الطبيب</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.item_id}>
                <td>{it.service_name || 'خدمة يدوية'}</td>
                <td>{it.clinic_name || '—'}</td>
                <td>{it.doctor_name || '—'}</td>
                <td>{it.quantity ?? 1}</td>
                <td>{fmtMoney(it.price)}</td>
                <td>{fmtMoney(it.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="invoice-summary">
          <div className="sum-row"><span>الإجمالي قبل الخصم</span><span>{fmtMoney(invoice.total_amount)}</span></div>
          <div className="sum-row"><span>الخصم</span><span>{fmtMoney(invoice.discount_amount)}</span></div>
          <div className="sum-row total"><span>الإجمالي النهائي</span><span>{fmtMoney(invoice.net_amount)}</span></div>
          <div className="sum-row"><span>المدفوع</span><span>{fmtMoney(invoice.paid_amount)}</span></div>
          <div className="sum-row"><span>المتبقي</span><span>{fmtMoney(invoice.remaining)}</span></div>
          <div className="sum-row"><span>حالة الدفع</span><span className={`status ${st.cls}`}>{st.label}</span></div>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => printInvoiceHtml(invoice)}>طباعة</button>
          <button className="primary-button" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </Modal>
  )
}

function ServicesTab() {
  return (
    <div className="tab-inner">
      <div className="tab-grid two">
        <div className="record-block"><h4>إضافة خدمة عيادة</h4><ServiceForm /></div>
        <div className="record-block"><h4>قائمة الخدمات (بالأسماء)</h4><ServicesList /></div>
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
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [selected, setSelected] = useState(null) // { mode: 'view'|'edit', service }

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
    } catch (err) { setActionError(err.message || 'تعذر جلب الخدمة') }
  }

  async function removeService(s) {
    setActionError(''); setActionNotice('')
    if (!window.confirm(`هل تريد حذف الخدمة «${s.service_name}»؟ إذا كانت مستخدمة في فواتير سابقة سيتم تعطيلها فقط حفاظاً على السجل المالي.`)) return
    try {
      const r = await api.billing.deleteService(s.service_id)
      setActionNotice(r.soft_deleted ? 'الخدمة مستخدمة في فواتير سابقة، تم تعطيلها بدلاً من حذفها حفاظاً على السجل المالي' : 'تم حذف الخدمة بنجاح')
      window.dispatchEvent(new Event('billing:services-changed'))
    } catch (err) { setActionError(err.message || 'تعذر حذف الخدمة') }
  }

  return (
    <div>
      <Notice kind="error">{error || actionError}</Notice>
      <Notice kind="success">{actionNotice}</Notice>
      {rows.length === 0 ? <Empty text="لا توجد خدمات بعد" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>الخدمة</th><th>العيادة</th><th>السعر</th><th>نسبة الطبيب</th><th>الحالة</th><th>الإجراءات</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.service_id} className={s.is_active === false ? 'row-muted' : ''}>
                <td>{s.service_name}</td>
                <td>{s.clinic_name || `عيادة #${s.clinic_id}`}</td>
                <td>{fmtMoney(s.price)}</td>
                <td>{s.doctor_percentage}%</td>
                <td>{s.is_active === false ? 'معطّلة' : 'نشطة'}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="text-button" onClick={() => openService(s.service_id, 'view')}>عرض</button>
                    <button type="button" className="text-button" onClick={() => openService(s.service_id, 'edit')}>تعديل</button>
                    <button type="button" className="text-button danger" onClick={() => removeService(s)}>حذف</button>
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
  const isEdit = mode === 'edit'
  const [form, setForm] = useState({
    service_name: service.service_name || '',
    price: String(service.price ?? ''),
    doctor_percentage: String(service.doctor_percentage ?? 0),
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
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
    } catch (err) { setError(err.message || 'تعذر حفظ التعديلات') } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? `تعديل: ${service.service_name}` : `تفاصيل: ${service.service_name}`} subtitle={isEdit ? 'تعديل خدمة' : 'عرض خدمة'} onClose={onClose}>
      {isEdit ? (
        <form className="patient-form" onSubmit={submit}>
          <Field label="اسم الخدمة" required><input required value={form.service_name} onChange={(e) => setForm({ ...form, service_name: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="السعر" required><input type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
            <Field label="نسبة الطبيب %" required><input type="number" min="0" max="100" required value={form.doctor_percentage} onChange={(e) => setForm({ ...form, doctor_percentage: e.target.value })} /></Field>
          </div>
          <Notice kind="error">{error}</Notice>
          <div className="calc-total">حصة الطبيب المتوقعة: <strong>{fmtMoney(displayDoctorShare)}</strong> · حصة المركز: <strong>{fmtMoney(Math.max(0, price - displayDoctorShare))}</strong></div>
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ التعديلات'}</button>
            <button type="button" className="secondary-button" onClick={onClose}>إلغاء</button>
          </div>
        </form>
      ) : (
        <div className="service-detail">
          <p><strong>اسم الخدمة:</strong> {service.service_name}</p>
          <p><strong>العيادة:</strong> {service.clinic_name || `عيادة #${service.clinic_id}`}</p>
          <p><strong>السعر:</strong> {fmtMoney(service.price)}</p>
          <p><strong>نسبة الطبيب:</strong> {service.doctor_percentage}%</p>
          <p><strong>حصة الطبيب:</strong> {fmtMoney(service.doctor_share)}</p>
          <p><strong>حصة المركز:</strong> {fmtMoney(service.center_share)}</p>
          <p><strong>الحالة:</strong> {service.is_active === false ? 'معطّلة' : 'نشطة'}</p>
          {service.created_at && <p><strong>أُنشئت:</strong> {fmtDate(service.created_at, true)}</p>}
          {service.updated_at && <p><strong>آخر تعديل:</strong> {fmtDate(service.updated_at, true)}</p>}
          <div className="modal-actions"><button className="primary-button" onClick={onClose}>إغلاق</button></div>
        </div>
      )}
    </Modal>
  )
}

function ServiceForm() {
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
      setError(err.message || 'تعذر إضافة الخدمة')
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <Field label="العيادة" required hint="اختر العيادة بالاسم">
        <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
          <option value="">اختر العيادة بالاسم...</option>
          {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
        </select>
      </Field>
      <Field label="اسم الخدمة" required><input required value={form.service_name} onChange={(e) => setForm({ ...form, service_name: e.target.value })} /></Field>
      <div className="form-row">
        <Field label="السعر" required><input type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
        <Field label="نسبة الطبيب %"><input type="number" min="0" max="100" value={form.doctor_percentage} onChange={(e) => setForm({ ...form, doctor_percentage: e.target.value })} /></Field>
      </div>
      <Notice kind="error">{error || clinicsError}</Notice>
      {done && <Notice kind="success">تمت إضافة الخدمة بنجاح</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'إضافة الخدمة'}</button>
      </div>
    </form>
  )
}

function ExpensesTab() {
  return (
    <div className="tab-inner">
      <div className="tab-grid two">
        <div className="record-block"><h4>تسجيل مصروف جديد</h4><ExpenseForm /></div>
        <div className="record-block"><h4>قائمة المصاريف (بالأسماء)</h4><ExpensesList /></div>
      </div>
    </div>
  )
}

function ExpensesList() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [selected, setSelected] = useState(null) // { mode: 'view'|'edit', expense }

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
    } catch (err) { setActionError(err.message || 'تعذر جلب المصروف') }
  }

  async function removeExpense(e2) {
    setActionError(''); setActionNotice('')
    if (!window.confirm(`هل تريد حذف المصروف «${e2.category}» بمبلغ ${fmtMoney(e2.amount)}؟ سيتم أرشفته (حذف ناعم) حفاظاً على السجل المالي.`)) return
    try {
      const r = await api.billing.deleteExpense(e2.expense_id)
      setActionNotice(r.soft_deleted ? 'تم أرشفة المصروف (حذف ناعم) — يبقى السجل المالي محفوظاً' : 'تم حذف المصروف بنجاح')
      window.dispatchEvent(new Event('billing:expenses-changed'))
    } catch (err) { setActionError(err.message || 'تعذر حذف المصروف') }
  }

  return (
    <div>
      <Notice kind="error">{error || actionError}</Notice>
      <Notice kind="success">{actionNotice}</Notice>
      {rows.length === 0 ? <Empty text="لا توجد مصاريف بعد" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>التصنيف</th><th>العيادة</th><th>المبلغ</th><th>سجله</th><th>التاريخ</th><th>الإجراءات</th></tr></thead>
          <tbody>
            {rows.map((e2) => (
              <tr key={e2.expense_id}>
                <td>{e2.category}</td>
                <td>{e2.clinic_name || (e2.clinic_id ? `عيادة #${e2.clinic_id}` : '—')}</td>
                <td>{fmtMoney(e2.amount)}</td>
                <td>{e2.spent_by_name || '—'}</td>
                <td>{fmtDate(e2.created_at, true)}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="text-button" onClick={() => openExpense(e2.expense_id, 'view')}>عرض</button>
                    <button type="button" className="text-button" onClick={() => openExpense(e2.expense_id, 'edit')}>تعديل</button>
                    <button type="button" className="text-button danger" onClick={() => removeExpense(e2)}>حذف</button>
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
  const isEdit = mode === 'edit'
  const [form, setForm] = useState({
    category: expense.category || '',
    amount: String(expense.amount ?? ''),
    description: expense.description || '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

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
    } catch (err) { setError(err.message || 'تعذر حفظ التعديلات') } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? `تعديل مصروف: ${expense.category}` : `تفاصيل مصروف #${expense.expense_id}`} subtitle={isEdit ? 'تعديل مصروف' : 'عرض مصروف'} onClose={onClose}>
      {isEdit ? (
        <form className="patient-form" onSubmit={submit}>
          <Field label="التصنيف" required><input required value={form.category} onChange={(e2) => setForm({ ...form, category: e2.target.value })} /></Field>
          <Field label="المبلغ" required><input type="number" min="0" step="0.01" required value={form.amount} onChange={(e2) => setForm({ ...form, amount: e2.target.value })} /></Field>
          <Field label="الوصف"><textarea rows={3} value={form.description} onChange={(e2) => setForm({ ...form, description: e2.target.value })} /></Field>
          <Notice kind="error">{error}</Notice>
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'حفظ التعديلات'}</button>
            <button type="button" className="secondary-button" onClick={onClose}>إلغاء</button>
          </div>
        </form>
      ) : (
        <div className="expense-detail">
          <p><strong>رقم المصروف:</strong> #{expense.expense_id}</p>
          <p><strong>العيادة:</strong> {expense.clinic_name || (expense.clinic_id ? `عيادة #${expense.clinic_id}` : '—')}</p>
          <p><strong>التصنيف:</strong> {expense.category}</p>
          <p><strong>المبلغ:</strong> {fmtMoney(expense.amount)}</p>
          <p><strong>الوصف:</strong> {expense.description || '—'}</p>
          <p><strong>التاريخ:</strong> {fmtDate(expense.created_at, true)}</p>
          <p><strong>أنشئه:</strong> {expense.spent_by_name || '—'}</p>
          <div className="modal-actions"><button className="primary-button" onClick={onClose}>إغلاق</button></div>
        </div>
      )}
    </Modal>
  )
}

function ExpenseForm() {
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
      setError(err.message || 'تعذر تسجيل المصروف')
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label="العيادة" required hint="اختر العيادة بالاسم">
          <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
            <option value="">اختر العيادة بالاسم...</option>
            {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}</option>)}
          </select>
        </Field>
        <Field label="التصنيف" required><input required placeholder="مثال: إيجار، رواتب، مستلزمات" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
      </div>
      <Field label="المبلغ" required><input type="number" min="0" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
      <Field label="الوصف"><textarea rows="2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <Notice kind="error">{error || clinicsError}</Notice>
      {done && <Notice kind="success">تم تسجيل المصروف بنجاح</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'تسجيل المصروف'}</button>
      </div>
    </form>
  )
}