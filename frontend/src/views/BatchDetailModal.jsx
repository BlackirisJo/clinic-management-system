import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useT } from '../i18n'
import { fmtDate, fmtDateTime, fmtNumber } from '../lib/format'
import { Modal, Field, Notice } from '../components/ui'
import { SearchSelect } from '../components/SearchSelect'

export default function BatchDetailModal({ batch, isOpen, onClose, onUpdate, onDeactivate }) {
  const t = useT()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false)

  const [form, setForm] = useState({
    supplier_id: '',
    lot_number: '',
    expiry_date: '',
    unit_cost: '',
    received_at: '',
    is_active: true,
  })

  const [suppliers, setSuppliers] = useState([])

  const loadSuppliers = useCallback(async () => {
    try {
      const res = await api.suppliers.list({ is_active: true, limit: 200 })
      setSuppliers(res.suppliers || [])
    } catch (e) {
      console.error('Failed to load suppliers:', e)
    }
  }, [])

  const populateForm = useCallback(() => {
    if (!batch) return
    setForm({
      supplier_id: batch.supplier_id ? String(batch.supplier_id) : '',
      lot_number: batch.lot_number || '',
      expiry_date: batch.expiry_date ? batch.expiry_date.slice(0, 10) : '',
      unit_cost: batch.unit_cost !== null && batch.unit_cost !== undefined ? String(batch.unit_cost) : '',
      received_at: batch.received_at ? batch.received_at.slice(0, 16).replace('T', 'T') : '',
      is_active: batch.is_active !== false,
    })
    setError('')
    setEditing(false)
  }, [batch])

  useEffect(() => {
    if (isOpen && batch) {
      loadSuppliers()
      populateForm()
    }
  }, [isOpen, batch, loadSuppliers, populateForm])

  const handleChange = (field, value) => {
    if (field === 'is_active') {
      setForm(prev => ({ ...prev, [field]: value === true || value === 'true' }))
    } else {
      setForm(prev => ({ ...prev, [field]: value }))
    }
    if (error) setError('')
  }

  const handleEdit = () => setEditing(true)

  const handleCancelEdit = () => {
    populateForm()
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!batch) return

    setLoading(true)
    setError('')

    const payload = {}
    if (form.supplier_id !== (batch.supplier_id ? String(batch.supplier_id) : '')) {
      payload.supplier_id = form.supplier_id ? parseInt(form.supplier_id, 10) : null
    }
    if (form.lot_number !== (batch.lot_number || '')) {
      payload.lot_number = form.lot_number.trim()
    }
    if (form.expiry_date !== (batch.expiry_date ? batch.expiry_date.slice(0, 10) : '')) {
      payload.expiry_date = form.expiry_date
    }
    if (form.unit_cost !== (batch.unit_cost !== null && batch.unit_cost !== undefined ? String(batch.unit_cost) : '')) {
      payload.unit_cost = form.unit_cost ? parseFloat(form.unit_cost) : null
    }
    if (form.received_at !== (batch.received_at ? batch.received_at.slice(0, 16).replace('T', 'T') : '')) {
      payload.received_at = form.received_at || null
    }
    if (form.is_active !== (batch.is_active !== false)) {
      payload.is_active = form.is_active
    }

    if (Object.keys(payload).length === 0) {
      setEditing(false)
      setLoading(false)
      return
    }

    try {
      const res = await api.inventory.batchUpdate(batch.batch_id, payload)
      setEditing(false)
      setError('')
      if (onUpdate) onUpdate(res.batch)
    } catch (err) {
      if (err.message?.includes('رقم تشغيلة مطابق') || err.message?.includes('matching lot number')) {
        setError(t('batchDetail.error.duplicateLot'))
      } else {
        setError(err.message || t('batchDetail.error.update'))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleDeactivateClick = () => {
    if (!batch) return
    if (!batch.is_active) return
    setShowDeactivateConfirm(true)
  }

  const handleActivateClick = async () => {
    if (!batch) return
    if (batch.is_active) return

    setLoading(true)
    setError('')
    try {
      const res = await api.inventory.batchUpdate(batch.batch_id, { is_active: true })
      setError('')
      if (onUpdate) onUpdate(res.batch)
    } catch (err) {
      setError(err.message || t('batchDetail.error.update'))
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmDeactivate = async () => {
    if (!batch) return

    setLoading(true)
    setError('')
    try {
      const res = await api.inventory.batchDeactivate(batch.batch_id)
      setShowDeactivateConfirm(false)
      setError('')
      if (onDeactivate) onDeactivate(res.batch)
    } catch (err) {
      setError(err.message || t('batchDeactivate.error'))
    } finally {
      setLoading(false)
    }
  }

  const available = batch
    ? Number(batch.quantity_on_hand || 0) - Number(batch.quantity_reserved || 0)
    : 0

  const supplierName = batch?.supplier_name || (batch?.supplier_id ? `Supplier #${batch.supplier_id}` : t('common.no'))

  return (
    <Modal
      title={t('batchDetail.title')}
      subtitle={t('batchDetail.subtitle', { id: batch?.batch_id })}
      onClose={onClose}
      wide
    >
      <Notice kind="error">{error}</Notice>

      {!editing && (
        <>
          <div className="detail-summary">
            <span><b>{t('batchDetail.lotNumber')}:</b> {batch?.lot_number || '—'}</span>
            <span><b>{t('batchDetail.expiryDate')}:</b> {batch?.expiry_date ? fmtDate(batch.expiry_date, true) : '—'}</span>
            <span><b>{t('batchDetail.onHand')}:</b> {fmtNumber(batch?.quantity_on_hand || 0)}</span>
            <span><b>{t('batchDetail.reserved')}:</b> {fmtNumber(batch?.quantity_reserved || 0)}</span>
            <span><b>{t('batchDetail.available')}:</b> <strong>{fmtNumber(available)}</strong></span>
            <span><b>{t('batchDetail.unitCost')}:</b> {batch?.unit_cost ? fmtNumber(batch.unit_cost) : '—'}</span>
            <span><b>{t('batchDetail.supplier')}:</b> {supplierName}</span>
            <span><b>{t('batchDetail.receivedAt')}:</b> {batch?.received_at ? fmtDateTime(batch.received_at) : '—'}</span>
            <span><b>{t('batchDetail.status')}:</b>
              <span className={batch?.is_active ? 'status completed' : 'status cancelled'}>
                {batch?.is_active ? t('common.yes') : t('common.no')}
              </span>
            </span>
          </div>

          <div className="modal-actions">
            {batch?.is_active && (
              <>
                <button className="secondary-button compact" onClick={handleEdit}>
                  {t('batchDetail.edit')}
                </button>
                <button className="secondary-button compact danger" onClick={handleDeactivateClick}>
                  {t('batchDetail.deactivate')}
                </button>
              </>
            )}
            {!batch?.is_active && (
              <button className="primary-button" onClick={handleActivateClick} disabled={loading}>
                {t('batchDetail.activate')}
              </button>
            )}
            <button className="secondary-button compact" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      )}

      {editing && (
        <form onSubmit={handleSave}>
          <Field label={t('batchDetail.lotNumber')} required>
            <input
              type="text"
              maxLength={100}
              value={form.lot_number}
              onChange={e => handleChange('lot_number', e.target.value)}
              disabled={loading}
              required
            />
          </Field>

          <Field label={t('batchDetail.expiryDate')} required>
            <input
              type="date"
              value={form.expiry_date}
              onChange={e => handleChange('expiry_date', e.target.value)}
              disabled={loading}
              required
            />
          </Field>

          <Field label={t('batchDetail.unitCost')}>
            <input
              type="number"
              step="0.0001"
              min="0"
              value={form.unit_cost}
              onChange={e => handleChange('unit_cost', e.target.value)}
              disabled={loading}
            />
          </Field>

          <Field label={t('batchDetail.supplier')}>
            <SearchSelect
              options={suppliers.map(s => ({ value: String(s.supplier_id), label: s.name, data: s }))}
              value={form.supplier_id}
              onChange={handleChange.bind(null, 'supplier_id')}
              placeholder={t('batchReceipt.supplier.placeholder')}
              disabled={loading}
              searchable
              clearable
            />
          </Field>

          <Field label={t('batchDetail.receivedAt')}>
            <input
              type="datetime-local"
              value={form.received_at}
              onChange={e => handleChange('received_at', e.target.value)}
              disabled={loading}
            />
          </Field>

          <Field label={t('batchDetail.status')}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={e => handleChange('is_active', e.target.checked)}
                disabled={loading}
              />
              <span>{t('common.yes')}</span>
            </label>
          </Field>

          <div className="modal-actions">
            <button type="button" className="secondary-button compact" onClick={handleCancelEdit} disabled={loading}>
              {t('batchDetail.cancel')}
            </button>
            <button type="submit" className="primary-button" disabled={loading}>
              {loading ? t('batchDetail.saving') : t('batchDetail.save')}
            </button>
          </div>
        </form>
      )}

      {showDeactivateConfirm && (
        <div className="deactivate-confirm-overlay" onClick={() => setShowDeactivateConfirm(false)}>
          <div className="deactivate-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>{t('batchDeactivate.title')}</h3>
            <p>{t('batchDeactivate.message', { lotNumber: batch?.lot_number })}</p>
            {available > 0 && (
              <p className="warning">{t('batchDeactivate.warning.stock', { available: fmtNumber(available) })}</p>
            )}
            <div className="modal-actions">
              <button className="secondary-button compact" onClick={() => setShowDeactivateConfirm(false)}>
                {t('common.cancel')}
              </button>
              <button className="secondary-button compact danger" onClick={handleConfirmDeactivate} disabled={loading}>
                {loading ? t('batchDeactivate.deactivating') : t('batchDeactivate.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}