import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useT } from '../i18n'
import { Modal, Field, Notice } from '../components/ui'
import { SearchSelect } from '../components/SearchSelect'

const generateIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const STORAGE_KEY = 'batch_receipt_idempotency'

const readStorage = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.key || !parsed.fingerprint || !parsed.formData) return null
    return { key: parsed.key, fingerprint: parsed.fingerprint, formData: parsed.formData }
  } catch {
    return null
  }
}

const writeStorage = (key, fingerprint, formData) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ key, fingerprint, formData }))
    return true
  } catch {
    // Storage unavailable (private mode, quota exceeded)
    return false
  }
}

const clearStorage = () => {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore
  }
}

const computeFingerprint = (form) => {
  const fields = [
    form.inventory_id,
    form.lot_number?.trim() || '',
    form.expiry_date || '',
    form.quantity_on_hand || '',
    form.unit_cost || '',
    form.supplier_id || '',
    form.received_at || '',
  ]
  return fields.join('|')
}

const initialFormState = {
  inventory_id: '',
  lot_number: '',
  production_date: '',
  expiry_date: '',
  quantity_on_hand: '',
  unit_cost: '',
  supplier_id: '',
  received_at: '',
}

const TODAY_ISO = new Date().toISOString().slice(0, 10)
const NOW_LOCAL_ISO = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)

export default function BatchReceiptModal({ isOpen, onClose, inventoryItems, onSuccess }) {
  const t = useT()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [success, setSuccess] = useState(false)
  const [createdBatch, setCreatedBatch] = useState(null)
  const [suppliers, setSuppliers] = useState([])
  const [suppliersLoading, setSuppliersLoading] = useState(false)
  const [form, setForm] = useState(initialFormState)
  const [pendingOp, setPendingOp] = useState(null)
  const [showPendingDialog, setShowPendingDialog] = useState(false)

  const loadSuppliers = useCallback(async () => {
    setSuppliersLoading(true)
    try {
      const res = await api.suppliers.list({ is_active: true, limit: 200 })
      setSuppliers(res.suppliers || [])
    } catch (e) {
      console.error('Failed to load suppliers:', e)
    } finally {
      setSuppliersLoading(false)
    }
  }, [])

  const resetForm = useCallback(() => {
    setForm(initialFormState)
    setError('')
    setFieldErrors({})
    setSuccess(false)
    setCreatedBatch(null)
  }, [])

  useEffect(() => {
    if (isOpen) {
      loadSuppliers()
      resetForm()

      const stored = readStorage()
      if (stored) {
        setPendingOp(stored)
        setShowPendingDialog(true)
      }
    }
  }, [isOpen, loadSuppliers, resetForm])

  const handleChange = useCallback((field, value) => {
    setForm(prev => ({ ...prev, [field]: value }))
    if (fieldErrors[field]) {
      setFieldErrors(prev => ({ ...prev, [field]: '' }))
    }
    if (error) setError('')
  }, [fieldErrors, error])

  const retryPending = useCallback(() => {
    if (pendingOp) {
      setForm(pendingOp.formData)
      setShowPendingDialog(false)
    }
  }, [pendingOp])

  const validateField = (field, value) => {
    switch (field) {
      case 'inventory_id':
        return value ? '' : t('batchReceipt.warning.selectItem')
      case 'lot_number':
        return value.trim() ? '' : t('batchReceipt.lotNumber.placeholder')
      case 'expiry_date':
        return value ? '' : t('batchReceipt.expiryDate.placeholder')
      case 'quantity_on_hand': {
        const qty = parseFloat(value)
        if (isNaN(qty) || qty <= 0) return t('batchReceipt.warning.qtyPositive')
        if (qty > 999999999.999) return t('batchReceipt.warning.qtyMax', { max: '999,999,999.999' })
        return ''
      }
      case 'unit_cost':
        if (value) {
          const cost = parseFloat(value)
          if (isNaN(cost) || cost < 0) return t('batchReceipt.warning.costNonNegative')
          if (cost > 999999.9999) return t('batchReceipt.warning.costMax', { max: '999,999.9999' })
        }
        return ''
      case 'production_date':
        if (value && form.expiry_date && new Date(value) > new Date(form.expiry_date)) {
          return t('batchReceipt.warning.productionAfterExpiry')
        }
        return ''
      default:
        return ''
    }
  }

  const validateForm = () => {
    const errors = {}
    let firstError = null

    ;(Object.keys(initialFormState)).forEach(field => {
      const err = validateField(field, form[field])
      if (err) {
        errors[field] = err
        if (!firstError) firstError = err
      }
    })

    setFieldErrors(errors)
    return firstError
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    const fingerprint = computeFingerprint(form)
    const stored = readStorage()

    // If there's a pending operation with a different fingerprint, block submission
    if (stored && stored.fingerprint !== fingerprint) {
      setPendingOp(stored)
      setShowPendingDialog(true)
      setError(t('batchReceipt.error.pendingReceipt'))
      return
    }

    let currentKey
    if (stored && stored.fingerprint === fingerprint) {
      currentKey = stored.key
    } else {
      currentKey = generateIdempotencyKey()
    }

    // Persist the current form data with the key for potential retry
    const storageOk = writeStorage(currentKey, fingerprint, form)
    if (!storageOk) {
      setError(t('batchReceipt.error.storageUnavailable'))
      return
    }

    setSubmitting(true)
    setError('')

    const selectedItem = inventoryItems.find(item => String(item.inventory_id) === form.inventory_id)

    const payload = {
      inventory_id: parseInt(form.inventory_id, 10),
      lot_number: form.lot_number.trim(),
      expiry_date: form.expiry_date,
      quantity_on_hand: 0,
      quantity_reserved: 0,
      unit_cost: form.unit_cost ? parseFloat(form.unit_cost) : null,
      supplier_id: form.supplier_id ? parseInt(form.supplier_id, 10) : null,
      received_at: form.received_at || null,
      receipt_quantity: parseFloat(form.quantity_on_hand),
      reference_type: 'BATCH_RECEIPT',
      reference_id: '', // Will be set to batch_id by backend
      notes: t('batchDetail.movementType.receipt'),
      idempotency_key: currentKey,
    }

    try {
      const res = await api.inventory.batchReceive(payload)

      if (res.idempotent_replay) {
        setCreatedBatch({ ...res.batch, inventory_item: selectedItem })
        setSuccess(true)
        setError('')
        clearStorage()
        setPendingOp(null)
        if (onSuccess) onSuccess(res.batch?.batch_id, res)
        return
      }

      setCreatedBatch({ ...res.batch, inventory_item: selectedItem })
      setSuccess(true)
      setError('')
      clearStorage()
      setPendingOp(null)

      if (onSuccess) onSuccess(res.batch?.batch_id, res)
    } catch (err) {
      // Definitive errors: backend guarantees transaction did not commit
      // - VALIDATION_ERROR (400): validation runs before transaction
      // - Other 4xx (duplicate lot, FK violation, check constraint): transaction rolled back
      // Ambiguous errors (network, 5xx, INTERNAL_ERROR): outcome unknown, keep pending for retry
      // Different-payload idempotency conflict (FORBIDDEN with key-conflict message):
      //   backend rejects the new payload but does NOT prove original receipt's outcome.
      //   Preserve pending record so user can retry original operation.
      const isDifferentPayloadConflict =
        err.code === 'FORBIDDEN' && err.message?.includes('مفتاح التكرار') && err.message?.includes('مختلفة')

      const isDefinitiveError =
        err.code === 'VALIDATION_ERROR'

      if (isDefinitiveError) {
        clearStorage()
        setPendingOp(null)
      }

      if (isDifferentPayloadConflict) {
        // Do NOT clear storage — original receipt outcome unknown
        setError(err.message)
      } else if (err.code === 'VALIDATION_ERROR') {
        if (err.errors) {
          const mappedErrors = {}
          Object.entries(err.errors).forEach(([key, msg]) => {
            const fieldMap = {
              inventory_id: 'inventory_id',
              lot_number: 'lot_number',
              expiry_date: 'expiry_date',
              quantity_on_hand: 'quantity_on_hand',
              unit_cost: 'unit_cost',
              supplier_id: 'supplier_id',
              received_at: 'received_at',
              receipt_quantity: 'quantity_on_hand',
            }
            const field = fieldMap[key] || key
            mappedErrors[field] = msg
          })
          setFieldErrors(mappedErrors)
          setError(Object.values(mappedErrors)[0] || err.message)
        } else {
          setError(err.message)
        }
      } else if (err.code === 'FORBIDDEN' && err.message?.includes('مفتاح التكرار')) {
        setError(err.message)
      } else {
        setError(err.message || t('batchReceipt.error.createBatch'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleClose = () => {
    if (!submitting) {
      onClose()
      resetForm()
    }
  }

  const inventoryOptions = (inventoryItems || []).map(item => ({
    value: String(item.inventory_id),
    label: `${item.trade_name}${item.scientific_name ? ` (${item.scientific_name})` : ''}${item.strength ? ` — ${item.strength}` : ''}${item.dosage_form ? ` — ${item.dosage_form}` : ''}`,
    meta: `${item.clinic_name || `Clinic #${item.clinic_id}`} · ${item.uom}`,
    data: item,
  }))

  const supplierOptions = suppliers.map(s => ({
    value: String(s.supplier_id),
    label: s.name,
    data: s,
  }))

  const today = TODAY_ISO
  const nowLocal = NOW_LOCAL_ISO

  const isFormValid = form.inventory_id && form.lot_number.trim() && form.expiry_date &&
    parseFloat(form.quantity_on_hand) > 0

  return (
    <Modal
      title={t('batchReceipt.title')}
      subtitle={t('batchReceipt.subtitle')}
      onClose={handleClose}
      wide
    >
      <Notice kind="error">{error}</Notice>

      {showPendingDialog && pendingOp && (
        <Notice kind="warning" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {t('batchReceipt.pendingReceipt.title')}
          </div>
          <div style={{ fontSize: 13, marginBottom: 12, color: 'var(--ink)' }}>
            {t('batchReceipt.pendingReceipt.message')}
          </div>
          <div style={{ background: '#f5f5f5', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 12 }}>
            <div><strong>{t('batchReceipt.review.medication')}</strong> {pendingOp.formData.inventory_id ? inventoryItems.find(i => String(i.inventory_id) === pendingOp.formData.inventory_id)?.trade_name || '—' : '—'}</div>
            <div><strong>{t('batchReceipt.review.lot')}</strong> {pendingOp.formData.lot_number || '—'}</div>
            <div><strong>{t('batchReceipt.review.expiry')}</strong> {pendingOp.formData.expiry_date || '—'}</div>
            <div><strong>{t('batchReceipt.review.qty')}</strong> {pendingOp.formData.quantity_on_hand || '—'}</div>
            <div><strong>{t('batchReceipt.review.cost')}</strong> {pendingOp.formData.unit_cost || t('common.na')}</div>
            <div><strong>{t('batchReceipt.review.supplier')}</strong> {pendingOp.formData.supplier_id ? suppliers.find(s => String(s.supplier_id) === pendingOp.formData.supplier_id)?.name || '—' : t('common.na')}</div>
            <div><strong>{t('batchReceipt.review.receivedAt')}</strong> {pendingOp.formData.received_at || t('batchReceipt.review.autoNow')}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="primary-button"
              onClick={retryPending}
              disabled={submitting}
            >
              {t('batchReceipt.pendingReceipt.retry')}
            </button>
          </div>
        </Notice>
      )}

      {success && (
        <Notice kind="success">
          {t('batchReceipt.success')}
          <span> — {t('batchReceipt.movementSuccess')}</span>
          {createdBatch && (
            <div style={{ marginTop: 12, fontSize: 12, color: '#376864' }}>
              {t('batchReceipt.receiptSummary', {
                medication: createdBatch.inventory_item?.trade_name || '',
                lot: createdBatch.lot_number,
                qty: form.quantity_on_hand,
                uom: createdBatch.inventory_item?.uom || '',
              })}
            </div>
          )}
        </Notice>
      )}

      {!success && (
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gap: 16 }}>
            <section style={{ background: '#f8fbfa', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink)' }}>
                {t('batchReceipt.section.medication')}
              </h3>
              <Field label={t('batchReceipt.inventoryItem')} required>
                <SearchSelect
                  options={inventoryOptions}
                  value={form.inventory_id}
                  onChange={handleChange.bind(null, 'inventory_id')}
                  placeholder={t('batchReceipt.inventoryItem.placeholder')}
                  disabled={submitting}
                  searchable
                  clearable
                  required
                  error={fieldErrors.inventory_id}
                />
              </Field>
            </section>

            <section style={{ background: '#f8fbfa', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink)' }}>
                {t('batchReceipt.section.batchDetails')}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <Field label={t('batchReceipt.lotNumber')} required>
                  <input
                    type="text"
                    maxLength={100}
                    value={form.lot_number}
                    onChange={e => handleChange('lot_number', e.target.value)}
                    placeholder={t('batchReceipt.lotNumber.placeholder')}
                    disabled={submitting}
                    required
                    className={fieldErrors.lot_number ? 'input-error' : ''}
                  />
                  {fieldErrors.lot_number && <small className="field-error">{fieldErrors.lot_number}</small>}
                </Field>

                <Field label={t('batchReceipt.productionDate')}>
                  <input
                    type="date"
                    max={today}
                    value={form.production_date}
                    onChange={e => handleChange('production_date', e.target.value)}
                    placeholder={t('batchReceipt.productionDate.placeholder')}
                    disabled={submitting}
                    className={fieldErrors.production_date ? 'input-error' : ''}
                  />
                  {fieldErrors.production_date && <small className="field-error">{fieldErrors.production_date}</small>}
                </Field>

                <Field label={t('batchReceipt.expiryDate')} required>
                  <input
                    type="date"
                    min={today}
                    value={form.expiry_date}
                    onChange={e => handleChange('expiry_date', e.target.value)}
                    placeholder={t('batchReceipt.expiryDate.placeholder')}
                    disabled={submitting}
                    required
                    className={fieldErrors.expiry_date ? 'input-error' : ''}
                  />
                  {fieldErrors.expiry_date && <small className="field-error">{fieldErrors.expiry_date}</small>}
                </Field>
              </div>
            </section>

            <section style={{ background: '#f8fbfa', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink)' }}>
                {t('batchReceipt.section.quantityCost')}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <Field label={t('batchReceipt.receivedQty')} required>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    max="999999999.999"
                    value={form.quantity_on_hand}
                    onChange={e => handleChange('quantity_on_hand', e.target.value)}
                    placeholder={t('batchReceipt.receivedQty.placeholder')}
                    disabled={submitting}
                    required
                    className={fieldErrors.quantity_on_hand ? 'input-error' : ''}
                  />
                  {fieldErrors.quantity_on_hand && <small className="field-error">{fieldErrors.quantity_on_hand}</small>}
                </Field>

                <Field label={t('batchReceipt.unitCost')}>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    max="999999.9999"
                    value={form.unit_cost}
                    onChange={e => handleChange('unit_cost', e.target.value)}
                    placeholder={t('batchReceipt.unitCost.placeholder')}
                    disabled={submitting}
                    className={fieldErrors.unit_cost ? 'input-error' : ''}
                  />
                  {fieldErrors.unit_cost && <small className="field-error">{fieldErrors.unit_cost}</small>}
                </Field>
              </div>
            </section>

            <section style={{ background: '#f8fbfa', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink)' }}>
                {t('batchReceipt.section.supplierReceipt')}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <Field label={t('batchReceipt.supplier')}>
                  <SearchSelect
                    options={supplierOptions}
                    value={form.supplier_id}
                    onChange={handleChange.bind(null, 'supplier_id')}
                    placeholder={t('batchReceipt.supplier.placeholder')}
                    disabled={submitting || suppliersLoading}
                    searchable
                    clearable
                    loading={suppliersLoading}
                  />
                </Field>

                <Field label={t('batchReceipt.receivedAt')}>
                  <input
                    type="datetime-local"
                    value={form.received_at}
                    onChange={e => handleChange('received_at', e.target.value)}
                    placeholder={t('batchReceipt.receivedAt.placeholder')}
                    disabled={submitting}
                    max={nowLocal}
                  />
                </Field>
              </div>
            </section>

            <section style={{ background: '#eef5f3', border: '1px solid #d5e8e2', borderRadius: 12, padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, color: '#134e4a' }}>
                {t('batchReceipt.section.review')}
              </h3>
              <div style={{ display: 'grid', gap: 8, fontSize: 12, color: '#376864' }}>
                <div><strong>{t('batchReceipt.review.medication')}</strong> {form.inventory_id ? inventoryItems.find(i => String(i.inventory_id) === form.inventory_id)?.trade_name || '—' : '—'}</div>
                <div><strong>{t('batchReceipt.review.lot')}</strong> {form.lot_number || '—'}</div>
                <div><strong>{t('batchReceipt.review.expiry')}</strong> {form.expiry_date || '—'}</div>
                <div><strong>{t('batchReceipt.review.production')}</strong> {form.production_date || t('common.na')}</div>
                <div><strong>{t('batchReceipt.review.qty')}</strong> {form.quantity_on_hand ? `${form.quantity_on_hand} ${inventoryItems.find(i => String(i.inventory_id) === form.inventory_id)?.uom || ''}` : '—'}</div>
                <div><strong>{t('batchReceipt.review.cost')}</strong> {form.unit_cost ? form.unit_cost : t('common.na')}</div>
                <div><strong>{t('batchReceipt.review.supplier')}</strong> {form.supplier_id ? suppliers.find(s => String(s.supplier_id) === form.supplier_id)?.name || '—' : t('common.na')}</div>
                <div><strong>{t('batchReceipt.review.receivedAt')}</strong> {form.received_at || t('batchReceipt.review.autoNow')}</div>
              </div>
            </section>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary-button compact" onClick={handleClose} disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary-button" disabled={submitting || !isFormValid}>
              {submitting ? t('batchReceipt.submitting') : t('batchReceipt.submit')}
            </button>
          </div>
        </form>
      )}

      {success && (
        <div className="modal-actions">
          <button className="primary-button" onClick={handleClose}>
            {t('common.close')}
          </button>
        </div>
      )}
    </Modal>
  )
}