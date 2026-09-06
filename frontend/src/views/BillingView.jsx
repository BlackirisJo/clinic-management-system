import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { fmtMoney, fmtDate, fmtNumber, PAYMENT_TYPES } from '../lib/format'
import { Field, Loading, Empty, Notice } from '../components/ui'

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
      .catch((err) => { setError(err.message); setRows([]) })
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
  const [patientId, setPatientId] = useState('')
  const [discount, setDiscount] = useState('')
  const [paymentType, setPaymentType] = useState('CASH')
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    api.patients.list({ limit: 100 })
      .then((r) => setPatients(r.patients || []))
      .catch(() => setPatients([]))
  }, [])

  function addItem() {
    setItems((prev) => [...prev, { price: '', doctor_id: '', service_id: '' }])
  }
  function updateItem(index, key, value) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, [key]: value } : it)))
  }
  function removeItem(index) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, it) => sum + (Number(it.price) || 0), 0)
  const net = Math.max(0, total - (Number(discount) || 0))

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
          clinic_id: user?.clinicId,
          price: Number(it.price),
          doctor_id: it.doctor_id ? Number(it.doctor_id) : undefined,
          service_id: it.service_id ? Number(it.service_id) : undefined,
        })),
      })
      setDone(result)
      setItems([]); setDiscount(''); setPatientId('')
    } catch (err) {
      setError(err.message || 'تعذر إصدار الفاتورة')
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label="المريض" required>
          <select required value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">اختر المريض...</option>
            {patients.map((p) => <option key={p.patient_id} value={p.patient_id}>{p.full_name}</option>)}
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
                <Field label="السعر" required><input type="number" min="0" step="0.01" required value={it.price} onChange={(e) => updateItem(i, 'price', e.target.value)} /></Field>
                <Field label="رقم الطبيب (اختياري)"><input type="number" value={it.doctor_id} onChange={(e) => updateItem(i, 'doctor_id', e.target.value)} /></Field>
                <Field label="رقم الخدمة (اختياري)"><input type="number" value={it.service_id} onChange={(e) => updateItem(i, 'service_id', e.target.value)} /></Field>
              </div>
              <button type="button" className="text-button danger" onClick={() => removeItem(i)}>حذف البند</button>
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
  )
}

function ServicesTab() {
  return (
    <div className="tab-inner">
      <div className="record-block"><h4>إضافة خدمة عيادة</h4><ServiceForm /></div>
    </div>
  )
}

function ServiceForm() {
  const { user } = useAuth()
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
      setForm({ clinic_id: user?.clinicId || '', service_name: '', price: '', doctor_percentage: '' })
    } catch (err) {
      setError(err.message || 'تعذر إضافة الخدمة')
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <Field label="العيادة" required><input type="number" required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })} /></Field>
      <Field label="اسم الخدمة" required><input required value={form.service_name} onChange={(e) => setForm({ ...form, service_name: e.target.value })} /></Field>
      <div className="form-row">
        <Field label="السعر" required><input type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
        <Field label="نسبة الطبيب %"><input type="number" min="0" max="100" value={form.doctor_percentage} onChange={(e) => setForm({ ...form, doctor_percentage: e.target.value })} /></Field>
      </div>
      <Notice kind="error">{error}</Notice>
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
      <div className="record-block"><h4>تسجيل مصروف جديد</h4><ExpenseForm /></div>
    </div>
  )
}

function ExpenseForm() {
  const { user } = useAuth()
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
      setForm({ clinic_id: user?.clinicId || '', category: '', amount: '', description: '' })
    } catch (err) {
      setError(err.message || 'تعذر تسجيل المصروف')
    } finally { setSaving(false) }
  }

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="form-row">
        <Field label="العيادة" required><input type="number" required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })} /></Field>
        <Field label="التصنيف" required><input required placeholder="مثال: إيجار، رواتب، مستلزمات" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
      </div>
      <Field label="المبلغ" required><input type="number" min="0" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
      <Field label="الوصف"><textarea rows="2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <Notice kind="error">{error}</Notice>
      {done && <Notice kind="success">تم تسجيل المصروف بنجاح</Notice>}
      <div className="modal-actions">
        <button className="primary-button" disabled={saving}>{saving ? 'جارِ الحفظ...' : 'تسجيل المصروف'}</button>
      </div>
    </form>
  )
}