import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useT } from '../i18n'
import { fmtDate, fmtDateTime, fmtNumber } from '../lib/format'
import { dosageFormLabel } from '../lib/dosageForm'
import { uomLabel } from '../lib/uom'
import { Modal, Loading, Empty, Notice, Paginator, Field } from '../components/ui'
import { SearchSelect } from '../components/SearchSelect'
import BatchReceiptModal from './BatchReceiptModal'
import BatchDetailModal from './BatchDetailModal'

const LIMIT = 20
const BATCH_LIMIT = 20
const EXPIRY_LIMIT = 50
const MOVEMENT_LIMIT = 50

export default function InventoryView() {
  const t = useT()
  const { user } = useAuth()
  const hasViewPermission = user?.permissions?.includes('VIEW_INVENTORY') ||
    user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const hasManagePermission = user?.permissions?.includes('MANAGE_INVENTORY') ||
    user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'

  const [activeTab, setActiveTab] = useState('items')
  const [rows, setRows] = useState([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [detailItem, setDetailItem] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [batches, setBatches] = useState([])
  const [price, setPrice] = useState(null)
  const [detailRequestId, setDetailRequestId] = useState(0)
  const [showReceiptModal, setShowReceiptModal] = useState(false)
  const [selectedBatch, setSelectedBatch] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = { limit: LIMIT, offset: (page - 1) * LIMIT }
      if (search.trim()) params.q = search.trim()
      const result = await api.inventory.list(params)
      setRows(result.inventoryItems || [])
      if (result.pagination) {
        setTotal(result.pagination.total ?? 0)
      }
    } catch (err) {
      setError(err.message || t('inventory.error.load'))
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, search, t])

  useEffect(() => { load() }, [load])

  const handleSearchChange = (value) => {
    setSearch(value)
    setPage(1)
  }

  const loadDetail = useCallback(async (item) => {
    const requestId = Date.now()
    setDetailRequestId(requestId)
    setDetailItem(item)
    setDetailLoading(true)
    setDetailError('')
    setBatches([])
    setPrice(null)

    try {
      const [, batchesRes, priceRes] = await Promise.all([
        api.inventory.get(item.inventory_id),
        api.inventory.batches({ inventory_id: item.inventory_id, limit: BATCH_LIMIT, offset: 0 }),
        api.inventory.medicationPrices({ inventory_id: item.inventory_id, is_active: true, limit: 1 }),
      ])

      if (detailRequestId !== requestId) return

      setBatches(batchesRes.batches || [])
      const prices = priceRes.medicationPrices || []
      setPrice(prices.length > 0 ? prices[0] : null)
    } catch (err) {
      if (detailRequestId === requestId) {
        setDetailError(err.message || t('inventory.error.load'))
      }
    } finally {
      if (detailRequestId === requestId) {
        setDetailLoading(false)
      }
    }
  }, [detailRequestId, t])

  const closeDetail = () => {
    setDetailItem(null)
    setBatches([])
    setPrice(null)
    setDetailError('')
  }

  const handleBatchClick = useCallback((batch) => {
    setSelectedBatch(batch)
  }, [])

  const handleReceiptSuccess = useCallback(() => {
    setShowReceiptModal(false)
    if (detailItem && detailItem.inventory_id) {
      loadDetail(detailItem)
    }
  }, [detailItem, loadDetail])

  const handleBatchUpdate = useCallback(() => {
    if (detailItem) {
      loadDetail(detailItem)
    }
  }, [detailItem, loadDetail])

  const handleBatchDeactivate = useCallback(() => {
    if (detailItem) {
      loadDetail(detailItem)
    }
  }, [detailItem, loadDetail])

  function getExpiryStatus(expiryDate) {
    if (!expiryDate) return 'ok'
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const expiry = new Date(expiryDate)
    if (expiry < today) return 'expired'
    const diffDays = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24))
    if (diffDays <= 90) return 'expiringSoon'
    return 'ok'
  }

  const totalAvailable = useMemo(() => {
    if (!detailItem) return 0
    return batches
      .filter((b) => b.is_active)
      .reduce((sum, b) => sum + (Number(b.quantity_on_hand) - Number(b.quantity_reserved || 0)), 0)
  }, [detailItem, batches])

  if (!hasViewPermission) {
    return (
      <section className="full-panel">
        <div className="panel-heading">
          <div><h2>{t('inventory.title')}</h2><p>{t('inventory.subtitle')}</p></div>
        </div>
        <Notice kind="error">{t('api.forbidden')}</Notice>
      </section>
    )
  }

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('inventory.title')}</h2><p>{t('inventory.subtitle')}</p></div>
        {hasManagePermission && (
          <button className="primary-button" onClick={() => setShowReceiptModal(true)}>
            {t('batchReceipt.submit')}
          </button>
        )}
      </div>

      <div className="panel-toolbar" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tabs" style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e0e0e0', paddingBottom: 8 }}>
          <button
            type="button"
            className={`tab-button${activeTab === 'items' ? ' active' : ''}`}
            onClick={() => setActiveTab('items')}
            style={{ padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer', fontWeight: activeTab === 'items' ? '600' : '400', color: activeTab === 'items' ? '#1a1a1a' : '#666', borderBottom: activeTab === 'items' ? '2px solid #0066cc' : '2px solid transparent', marginBottom: '-2px' }}
          >
            {t('inventory.title')}
          </button>
          <button
            type="button"
            className={`tab-button${activeTab === 'expiry' ? ' active' : ''}`}
            onClick={() => setActiveTab('expiry')}
            style={{ padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer', fontWeight: activeTab === 'expiry' ? '600' : '400', color: activeTab === 'expiry' ? '#1a1a1a' : '#666', borderBottom: activeTab === 'expiry' ? '2px solid #0066cc' : '2px solid transparent', marginBottom: '-2px' }}
          >
            {t('inventory.expiryAudit.title')}
          </button>
          <button
            type="button"
            className={`tab-button${activeTab === 'movements' ? ' active' : ''}`}
            onClick={() => setActiveTab('movements')}
            style={{ padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer', fontWeight: activeTab === 'movements' ? '600' : '400', color: activeTab === 'movements' ? '#1a1a1a' : '#666', borderBottom: activeTab === 'movements' ? '2px solid #0066cc' : '2px solid transparent', marginBottom: '-2px' }}
          >
            {t('inventory.movementHistory.title')}
          </button>
        </div>
        {activeTab === 'items' && (
          <input
            className="input"
            type="search"
            placeholder={t('inventory.search.placeholder')}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            style={{ flex: 1, minWidth: 250 }}
          />
        )}
      </div>

      <Notice kind="error">{error}</Notice>

      {activeTab === 'items' ? (
        <>
          {loading ? <Loading text={t('inventory.loading')} /> : rows.length === 0 ? <Empty text={t('inventory.empty')} /> : (
            <>
              <div className="table-wrap table-cards">
                <table>
                  <thead>
                    <tr>
                      <th>{t('inventory.col.medication')}</th>
                      <th>{t('inventory.col.strength')}</th>
                      <th>{t('inventory.col.dosageForm')}</th>
                      <th>{t('inventory.col.uom')}</th>
                      <th>{t('inventory.col.clinic')}</th>
                      <th>{t('inventory.col.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => {
                      const statusLabel = item.deleted_at ? t('inventory.status.archived') : t('inventory.status.active')

                      return (
                        <tr key={item.inventory_id} onClick={() => loadDetail(item)} style={{ cursor: 'pointer' }}>
                          <td data-label={t('inventory.col.medication')}>
                            <strong>{item.trade_name}</strong>
                            {item.scientific_name && <span> ({item.scientific_name})</span>}
                          </td>
                          <td data-label={t('inventory.col.strength')}>{item.strength || '—'}</td>
                          <td data-label={t('inventory.col.dosageForm')}>{dosageFormLabel(item.dosage_form, t)}</td>
                          <td data-label={t('inventory.col.uom')}>{uomLabel(item.uom, t)}</td>
                          <td data-label={t('inventory.col.clinic')}>{item.clinic_name || t('layout.clinicById', { id: item.clinic_id })}</td>
                          <td data-label={t('inventory.col.status')}>
                            <span className={item.deleted_at ? 'status cancelled' : 'status completed'}>{statusLabel}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} total={total} />
            </>
          )}
        </>
      ) : activeTab === 'expiry' ? (
        <ExpiryAuditTab t={t} fmtDate={fmtDate} fmtNumber={fmtNumber} />
      ) : (
        <MovementHistoryTab t={t} fmtNumber={fmtNumber} />
      )}

      {detailItem && (
        <InventoryDetailModal
          item={detailItem}
          batches={batches}
          price={price}
          loading={detailLoading}
          error={detailError}
          onClose={closeDetail}
          t={t}
          getExpiryStatus={getExpiryStatus}
          totalAvailable={totalAvailable}
          fmtNumber={fmtNumber}
          onBatchClick={handleBatchClick}
          hasManagePermission={hasManagePermission}
        />
      )}

      {showReceiptModal && (
        <BatchReceiptModal
          isOpen={showReceiptModal}
          onClose={() => setShowReceiptModal(false)}
          inventoryItems={rows}
          onSuccess={handleReceiptSuccess}
        />
      )}

      {selectedBatch && (
        <BatchDetailModal
          batch={selectedBatch}
          isOpen={!!selectedBatch}
          onClose={() => setSelectedBatch(null)}
          onUpdate={handleBatchUpdate}
          onDeactivate={handleBatchDeactivate}
        />
      )}
    </section>
  )
}

function ExpiryAuditTab({ t, fmtDate, fmtNumber }) {
  const [batches, setBatches] = useState([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expiryStatus, setExpiryStatus] = useState('expired')
  const [days, setDays] = useState('90')
  const [requestId, setRequestId] = useState(0)

  const EXPIRY_STATUSES = [
    { value: 'expired', label: t('inventory.expiryAudit.status.expired') },
    { value: 'expiring', label: t('inventory.expiryAudit.status.expiring') },
  ]

  const loadExpiryBatches = useCallback(async (pageNum = 1, status = expiryStatus, daysValue = days) => {
    const currentRequestId = Date.now()
    setRequestId(currentRequestId)
    setLoading(true)
    setError('')

    try {
      const params = {
        status,
        limit: EXPIRY_LIMIT,
        offset: (pageNum - 1) * EXPIRY_LIMIT,
      }
      if (status === 'expiring') {
        params.days = parseInt(daysValue, 10)
      }

      const result = await api.inventory.expiry(params)

      if (currentRequestId !== requestId) return

      setBatches(result.batches || [])
      if (result.pagination) {
        setTotal(result.pagination.total ?? 0)
      }
    } catch (err) {
      if (currentRequestId === requestId) {
        setError(err.message || t('inventory.expiryAudit.error'))
      }
      setBatches([])
      setTotal(0)
    } finally {
      if (currentRequestId === requestId) {
        setLoading(false)
      }
    }
  }, [expiryStatus, days, requestId, t])

  // Load when page, status, or days change
  useEffect(() => {
    loadExpiryBatches(page, expiryStatus, days)
  }, [page, expiryStatus, days, loadExpiryBatches])

  const handleStatusChange = (newStatus) => {
    setExpiryStatus(newStatus)
    setPage(1)
  }

  const handleDaysChange = (value) => {
    setDays(value)
    if (expiryStatus === 'expiring') {
      setPage(1)
    }
  }

  const isDaysEnabled = expiryStatus === 'expiring'

  return (
    <div className="expiry-audit-tab">
      <div className="panel-toolbar" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontWeight: 500 }}>{t('inventory.expiryAudit.status')}</label>
            <select
              value={expiryStatus}
              onChange={(e) => handleStatusChange(e.target.value)}
              disabled={loading}
              className="input"
              style={{ minWidth: 200 }}
            >
              {EXPIRY_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontWeight: 500 }}>{t('inventory.expiryAudit.days')}</label>
            <input
              type="number"
              min="0"
              max="365"
              value={days}
              onChange={(e) => handleDaysChange(e.target.value)}
              disabled={loading || !isDaysEnabled}
              placeholder={t('inventory.expiryAudit.days.placeholder')}
              className="input"
              style={{ width: 100 }}
            />
          </div>
          <div style={{ color: '#666', fontSize: 13, marginLeft: 'auto' }}>
            {t('inventory.expiryAudit.filter')}: <strong>{t(`inventory.expiryAudit.status.${expiryStatus}`)}</strong>
            {isDaysEnabled && <span> — {t('inventory.expiryAudit.days')}: <strong>{days}</strong></span>}
          </div>
        </div>
      </div>

      <Notice kind="error">{error}</Notice>

      {loading ? (
        <Loading text={t('inventory.expiryAudit.loading')} />
      ) : batches.length === 0 ? (
        <Empty text={t('inventory.expiryAudit.empty')} />
      ) : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>{t('inventory.expiryAudit.col.lot')}</th>
                  <th>{t('inventory.expiryAudit.col.medication')}</th>
                  <th>{t('inventory.expiryAudit.col.expiry')}</th>
                  <th>{t('inventory.expiryAudit.col.onHand')}</th>
                  <th>{t('inventory.expiryAudit.col.reserved')}</th>
                  <th>{t('inventory.expiryAudit.col.available')}</th>
                  <th>{t('inventory.expiryAudit.col.active')}</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const onHand = Number(batch.quantity_on_hand)
                  const reserved = Number(batch.quantity_reserved || 0)
                  const available = onHand - reserved
                  const isExpired = batch.expiry_date && new Date(batch.expiry_date) < new Date()
                  return (
                    <tr key={batch.batch_id}>
                      <td data-label={t('inventory.expiryAudit.col.lot')}>{batch.lot_number || '—'}</td>
                      <td data-label={t('inventory.expiryAudit.col.medication')}>
                        {batch.trade_name || `Item #${batch.inventory_id}`}
                        {batch.scientific_name && <span> ({batch.scientific_name})</span>}
                      </td>
                      <td data-label={t('inventory.expiryAudit.col.expiry')}>
                        <span className={isExpired ? 'danger' : ''}>
                          {fmtDate(batch.expiry_date, true)}
                        </span>
                      </td>
                      <td data-label={t('inventory.expiryAudit.col.onHand')}>{fmtNumber(onHand)}</td>
                      <td data-label={t('inventory.expiryAudit.col.reserved')}>{fmtNumber(reserved)}</td>
                      <td data-label={t('inventory.expiryAudit.col.available')}>{fmtNumber(available)}</td>
                      <td data-label={t('inventory.expiryAudit.col.active')}>
                        <span className={batch.is_active ? 'status completed' : 'status cancelled'}>
                          {batch.is_active ? t('common.yes') : t('common.no')}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={batches} limit={EXPIRY_LIMIT} onPage={setPage} total={total} />
        </>
      )}
    </div>
  )
}

function MovementHistoryTab({ t, fmtNumber }) {
  const [movements, setMovements] = useState([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [movementType, setMovementType] = useState('')
  const [createdFrom, setCreatedFrom] = useState('')
  const [createdTo, setCreatedTo] = useState('')
  const [requestId, setRequestId] = useState(0)

  const MOVEMENT_TYPES = [
    { value: '', label: t('inventory.movementHistory.movementType.all') },
    { value: 'RECEIPT', label: t('inventory.movementHistory.movementType.RECEIPT') },
    { value: 'DISPENSE', label: t('inventory.movementHistory.movementType.DISPENSE') },
    { value: 'RETURN', label: t('inventory.movementHistory.movementType.RETURN') },
    { value: 'ADJUSTMENT', label: t('inventory.movementHistory.movementType.ADJUSTMENT') },
    { value: 'ADJUSTMENT_DECREASE', label: t('inventory.movementHistory.movementType.ADJUSTMENT_DECREASE') },
    { value: 'WASTE', label: t('inventory.movementHistory.movementType.WASTE') },
    { value: 'EXPIRE', label: t('inventory.movementHistory.movementType.EXPIRE') },
  ]

  const loadMovements = useCallback(async (pageNum = 1, type = movementType, from = createdFrom, to = createdTo) => {
    const currentRequestId = Date.now()
    setRequestId(currentRequestId)
    setLoading(true)
    setError('')

    try {
      const params = {
        limit: MOVEMENT_LIMIT,
        offset: (pageNum - 1) * MOVEMENT_LIMIT,
      }
      if (type) params.movement_type = type
      if (from) params.created_from = from
      if (to) params.created_to = to

      const result = await api.stockMovements.list(params)

      if (currentRequestId !== requestId) return

      setMovements(result.movements || [])
      if (result.pagination) {
        setTotal(result.pagination.total ?? 0)
      }
    } catch (err) {
      if (currentRequestId === requestId) {
        setError(err.message || t('inventory.movementHistory.error'))
      }
      setMovements([])
      setTotal(0)
    } finally {
      if (currentRequestId === requestId) {
        setLoading(false)
      }
    }
  }, [movementType, createdFrom, createdTo, requestId, t])

  // Load when page or filters change
  useEffect(() => {
    loadMovements(page, movementType, createdFrom, createdTo)
  }, [page, movementType, createdFrom, createdTo, loadMovements])

  const handleTypeChange = (newType) => {
    setMovementType(newType)
    setPage(1)
  }

  const handleFromChange = (value) => {
    setCreatedFrom(value)
    setPage(1)
  }

  const handleToChange = (value) => {
    setCreatedTo(value)
    setPage(1)
  }

  const handleClearFilters = () => {
    setMovementType('')
    setCreatedFrom('')
    setCreatedTo('')
    setPage(1)
  }

  const hasActiveFilters = movementType || createdFrom || createdTo

  return (
    <div className="movement-history-tab">
      <div className="panel-toolbar" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontWeight: 500 }}>{t('inventory.movementHistory.movementType')}</label>
            <select
              value={movementType}
              onChange={(e) => handleTypeChange(e.target.value)}
              disabled={loading}
              className="input"
              style={{ minWidth: 200 }}
            >
              {MOVEMENT_TYPES.map((mt) => (
                <option key={mt.value} value={mt.value}>{mt.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontWeight: 500 }}>{t('inventory.movementHistory.createdFrom')}</label>
            <input
              type="date"
              value={createdFrom}
              onChange={(e) => handleFromChange(e.target.value)}
              disabled={loading}
              className="input"
              style={{ width: 160 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontWeight: 500 }}>{t('inventory.movementHistory.createdTo')}</label>
            <input
              type="date"
              value={createdTo}
              onChange={(e) => handleToChange(e.target.value)}
              disabled={loading}
              className="input"
              style={{ width: 160 }}
            />
          </div>
          <div style={{ color: '#666', fontSize: 13, marginLeft: 'auto' }}>
            {t('inventory.movementHistory.filter')}: <strong>{t(`inventory.movementHistory.movementType.${movementType || 'all'}`)}</strong>
            {createdFrom && <span> — {t('inventory.movementHistory.createdFrom')}: <strong>{createdFrom}</strong></span>}
            {createdTo && <span> — {t('inventory.movementHistory.createdTo')}: <strong>{createdTo}</strong></span>}
          </div>
          {hasActiveFilters && (
            <button type="button" className="secondary-button compact" onClick={handleClearFilters} disabled={loading}>
              {t('inventory.detail.clearFilters')}
            </button>
          )}
        </div>
      </div>

      <Notice kind="error">{error}</Notice>

      {loading ? (
        <Loading text={t('inventory.movementHistory.loading')} />
      ) : movements.length === 0 ? (
        <Empty text={t('inventory.movementHistory.empty')} />
      ) : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>{t('inventory.movementHistory.col.date')}</th>
                  <th>{t('inventory.movementHistory.col.type')}</th>
                  <th>{t('inventory.movementHistory.col.medication')}</th>
                  <th>{t('inventory.movementHistory.col.lot')}</th>
                  <th>{t('inventory.movementHistory.col.quantity')}</th>
                  <th>{t('inventory.movementHistory.col.referenceType')}</th>
                  <th>{t('inventory.movementHistory.col.referenceId')}</th>
                  <th>{t('inventory.movementHistory.col.performedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.movement_id}>
                    <td data-label={t('inventory.movementHistory.col.date')}>{fmtDateTime(movement.created_at)}</td>
                    <td data-label={t('inventory.movementHistory.col.type')}>
                      <span className="status-badge">{t(`inventory.movementHistory.movementType.${movement.movement_type}`) || movement.movement_type}</span>
                    </td>
                    <td data-label={t('inventory.movementHistory.col.medication')}>
                      {movement.trade_name || `Item #${movement.inventory_id}`}
                      {movement.scientific_name && <span> ({movement.scientific_name})</span>}
                    </td>
                    <td data-label={t('inventory.movementHistory.col.lot')}>{movement.lot_number || '—'}</td>
                    <td data-label={t('inventory.movementHistory.col.quantity')}>
                      <span className={STOCK_INCREASING_TYPES.includes(movement.movement_type) ? 'stock-increase' : 'stock-decrease'}>
                        {fmtNumber(movement.quantity)}
                      </span>
                    </td>
                    <td data-label={t('inventory.movementHistory.col.referenceType')}>{movement.reference_type || '—'}</td>
                    <td data-label={t('inventory.movementHistory.col.referenceId')}>{movement.reference_id || '—'}</td>
                    <td data-label={t('inventory.movementHistory.col.performedBy')}>{movement.performed_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={movements} limit={MOVEMENT_LIMIT} onPage={setPage} total={total} />
        </>
      )}
    </div>
  )
}

// Constants for movement type display
const STOCK_INCREASING_TYPES = ['RECEIPT', 'RETURN', 'ADJUSTMENT']

function InventoryDetailModal({ item, batches: initialBatches, price, loading: initialLoading, error: initialError, onClose, t, getExpiryStatus, totalAvailable, fmtNumber, onBatchClick, hasManagePermission }) {
  const [batches, setBatches] = useState(initialBatches)
  const [loading, setLoading] = useState(initialLoading)
  const [error, setError] = useState(initialError)
  const [batchPage, setBatchPage] = useState(1)
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchFilters, setBatchFilters] = useState({
    supplier_id: '',
    lot_number: '',
    received_from: '',
    received_to: '',
  })
  const [suppliers, setSuppliers] = useState([])
  const [suppliersLoading, setSuppliersLoading] = useState(false)

  // Reset batches when item changes
  useEffect(() => {
    setBatches(initialBatches)
    setLoading(initialLoading)
    setError(initialError)
    setBatchPage(1)
    setBatchTotal(0)
    setBatchFilters({ supplier_id: '', lot_number: '', received_from: '', received_to: '' })
  }, [item?.inventory_id, initialBatches, initialLoading, initialError])

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

  useEffect(() => {
    loadSuppliers()
  }, [loadSuppliers])

  const loadBatches = useCallback(async (page = 1, filters = batchFilters) => {
    if (!item) return
    setLoading(true)
    setError('')
    try {
      const params = {
        inventory_id: item.inventory_id,
        limit: BATCH_LIMIT,
        offset: (page - 1) * BATCH_LIMIT,
      }
      if (filters.supplier_id) params.supplier_id = parseInt(filters.supplier_id, 10)
      if (filters.lot_number?.trim()) params.lot_number = filters.lot_number.trim()
      if (filters.received_from) params.received_from = filters.received_from
      if (filters.received_to) params.received_to = filters.received_to

      const result = await api.inventory.batches(params)
      if (item.inventory_id !== params.inventory_id) return // stale request
      setBatches(result.batches || [])
      if (result.pagination) {
        setBatchTotal(result.pagination.total ?? 0)
      }
    } catch (err) {
      setError(err.message || t('inventory.error.load'))
      setBatches([])
      setBatchTotal(0)
    } finally {
      setLoading(false)
    }
  }, [item, batchFilters, t])

  // Load batches when page or filters change
  useEffect(() => {
    loadBatches(batchPage, batchFilters)
  }, [batchPage, batchFilters, loadBatches])

  const handleFilterChange = (key, value) => {
    setBatchFilters(prev => ({ ...prev, [key]: value }))
    setBatchPage(1)
  }

  const handleClearFilters = () => {
    setBatchFilters({ supplier_id: '', lot_number: '', received_from: '', received_to: '' })
    setBatchPage(1)
  }

  const hasActiveFilters = batchFilters.supplier_id || batchFilters.lot_number?.trim() || batchFilters.received_from || batchFilters.received_to

  const activeBatches = batches.filter((b) => b.is_active)

  return (
    <Modal title={t('inventory.detail.title')} subtitle={t('inventory.detail.subtitle', { id: item.inventory_id })} onClose={onClose} wide>
      <Notice kind="error">{error}</Notice>
      {loading && <Loading text={t('inventory.loading')} />}

      <div className="detail-summary">
        <span><b>{t('inventory.detail.medication')}:</b> {item.trade_name} {item.scientific_name ? `(${item.scientific_name})` : ''}</span>
        <span><b>{t('inventory.detail.strength')}:</b> {item.strength || '—'}</span>
        <span><b>{t('inventory.detail.dosageForm')}:</b> {dosageFormLabel(item.dosage_form, t)}</span>
        <span><b>{t('inventory.detail.uom')}:</b> {uomLabel(item.uom, t)}</span>
        <span><b>{t('inventory.detail.minStock')}:</b> {fmtNumber(item.min_stock || 0)}</span>
        <span><b>{t('inventory.detail.reorderPoint')}:</b> {fmtNumber(item.reorder_point || 0)}</span>
        {item.max_stock && <span><b>{t('inventory.detail.maxStock')}:</b> {fmtNumber(item.max_stock)}</span>}
        <span><b>{t('inventory.detail.availableQty')}:</b> {fmtNumber(totalAvailable)}</span>
        <span><b>{t('inventory.detail.clinic')}:</b> {item.clinic_name || t('layout.clinicById', { id: item.clinic_id })}</span>
      </div>

      <div className="record-block" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h4>{t('inventory.detail.batches')} ({activeBatches.length}){batchTotal && <span style={{ fontWeight: 'normal', marginLeft: 8, color: '#666' }}>{t('inventory.detail.ofTotal', { total: batchTotal })}</span>}</h4>
          {hasActiveFilters && (
            <button type="button" className="secondary-button compact" onClick={handleClearFilters}>
              {t('inventory.detail.clearFilters')}
            </button>
          )}
        </div>

        <div className="batch-filters" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <Field label={t('batchDetail.supplier')} style={{ minWidth: 200 }}>
            <SearchSelect
              options={suppliers.map(s => ({ value: String(s.supplier_id), label: s.name, data: s }))}
              value={batchFilters.supplier_id}
              onChange={handleFilterChange.bind(null, 'supplier_id')}
              placeholder={t('batchDetail.supplier.placeholder')}
              disabled={loading || suppliersLoading}
              searchable
              clearable
            />
          </Field>
          <Field label={t('inventory.detail.batch.lot')} style={{ minWidth: 180 }}>
            <input
              type="text"
              maxLength={100}
              value={batchFilters.lot_number}
              onChange={e => handleFilterChange('lot_number', e.target.value)}
              placeholder={t('batchDetail.lotNumber.placeholder')}
              disabled={loading}
            />
          </Field>
          <Field label={t('inventory.detail.batch.receivedFrom')} style={{ minWidth: 160 }}>
            <input
              type="date"
              value={batchFilters.received_from}
              onChange={e => handleFilterChange('received_from', e.target.value)}
              disabled={loading}
            />
          </Field>
          <Field label={t('inventory.detail.batch.receivedTo')} style={{ minWidth: 160 }}>
            <input
              type="date"
              value={batchFilters.received_to}
              onChange={e => handleFilterChange('received_to', e.target.value)}
              disabled={loading}
            />
          </Field>
        </div>

        {activeBatches.length === 0 && !loading ? <Empty text={t('common.empty.default')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>{t('inventory.detail.batch.lot')}</th>
                  <th>{t('inventory.detail.batch.expiry')}</th>
                  <th>{t('inventory.detail.batch.onHand')}</th>
                  <th>{t('inventory.detail.batch.reserved')}</th>
                  <th>{t('inventory.detail.batch.available')}</th>
                  <th>{t('inventory.detail.batch.unitCost')}</th>
                  <th>{t('inventory.detail.batch.active')}</th>
                  {hasManagePermission && <th>{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {activeBatches.map((batch) => {
                  const onHand = Number(batch.quantity_on_hand)
                  const reserved = Number(batch.quantity_reserved || 0)
                  const available = onHand - reserved
                  const expiryStatus = getExpiryStatus(batch.expiry_date)
                  return (
                    <tr key={batch.batch_id}>
                      <td data-label={t('inventory.detail.batch.lot')}>{batch.lot_number || '—'}</td>
                      <td data-label={t('inventory.detail.batch.expiry')}>
                        <span className={expiryStatus === 'expired' ? 'danger' : expiryStatus === 'expiringSoon' ? 'expiring-soon' : ''}>
                          {fmtDate(batch.expiry_date, true)} <small>({t(`inventory.expiry.${expiryStatus}`)})</small>
                        </span>
                      </td>
                      <td data-label={t('inventory.detail.batch.onHand')}>{fmtNumber(onHand)}</td>
                      <td data-label={t('inventory.detail.batch.reserved')}>{fmtNumber(reserved)}</td>
                      <td data-label={t('inventory.detail.batch.available')}>{fmtNumber(available)}</td>
                      <td data-label={t('inventory.detail.batch.unitCost')}>{batch.unit_cost ? fmtNumber(batch.unit_cost) : '—'}</td>
                      <td data-label={t('inventory.detail.batch.active')}>
                        <span className={batch.is_active ? 'status completed' : 'status cancelled'}>
                          {batch.is_active ? t('common.yes') : t('common.no')}
                        </span>
                      </td>
                      {hasManagePermission && (
                        <td data-label={t('common.actions')}>
                          <button className="secondary-button compact" onClick={() => onBatchClick(batch)}>
                            {t('batchDetail.edit')}
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <Paginator page={batchPage} rows={activeBatches} limit={BATCH_LIMIT} onPage={setBatchPage} total={batchTotal} />
      </div>

      {price && (
        <div className="record-block" style={{ marginTop: 16 }}>
          <h4>{t('inventory.detail.sellingPrice')}</h4>
          <p><b>{t('inventory.detail.sellingPrice')}:</b> {fmtNumber(price.unit_price)} {item.uom}</p>
          <p className="muted-small">{t('inventory.detail.effectiveFrom')}: {fmtDateTime(price.effective_from)}</p>
        </div>
      )}

      {!price && (
        <div className="record-block" style={{ marginTop: 16 }}>
          <p className="muted-small">{t('inventory.detail.noPrice')}</p>
        </div>
      )}

      <div className="modal-actions">
        <button className="secondary-button compact" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  )
}