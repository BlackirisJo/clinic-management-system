import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { useT } from '../i18n'
import { Loading, Empty, Notice, Modal, Field } from '../components/ui'
import { dosageFormLabel } from '../lib/dosageForm'
import { PrescriptionDetailModal } from './PrescriptionsView'

export default function PharmacyView({ onNavigate }) {
  const t = useT()
  return <PharmacyQueueTab onNavigate={onNavigate} />
}

function FulfilmentDecisionDialog({ isOpen, onClose, onSave, initialStatus, initialNote, itemLabel, saving }) {
  const t = useT()
  const [status, setStatus] = useState(initialStatus || 'PENDING')
  const [note, setNote] = useState(initialNote || '')
  const [wasRecordedDecision, setWasRecordedDecision] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setStatus(initialStatus || 'PENDING')
      setNote(initialNote || '')
      const recorded = initialStatus === 'CLINIC_DISPENSING' || initialStatus === 'EXTERNAL_PHARMACY' || initialStatus === 'PATIENT_DECLINED' || initialStatus === 'CANCELLED'
      setWasRecordedDecision(recorded)
    }
  }, [isOpen, initialStatus, initialNote])

  const DECISION_OPTIONS = [
    { value: 'PENDING', label: t('prescriptions.fulfilment.status.PENDING') },
    { value: 'CLINIC_DISPENSING', label: t('prescriptions.fulfilment.status.CLINIC_DISPENSING') },
    { value: 'EXTERNAL_PHARMACY', label: t('prescriptions.fulfilment.status.EXTERNAL_PHARMACY') },
    { value: 'PATIENT_DECLINED', label: t('prescriptions.fulfilment.status.PATIENT_DECLINED') },
    { value: 'CANCELLED', label: t('prescriptions.fulfilment.status.CANCELLED') },
  ]

  function handleSave() {
    const resetToPending = status === 'PENDING' && wasRecordedDecision
    onSave({ fulfilment_status: status, decision_note: note || undefined, reset_to_pending: resetToPending })
  }

  return (
    <Modal title={t('prescriptions.fulfilment.decisionTitle')} subtitle={itemLabel} onClose={onClose}>
      <div className="patient-form">
        <Field label={t('prescriptions.fulfilment.statusLabel')} required>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {DECISION_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </Field>
        <Field label={t('prescriptions.fulfilment.noteLabel')}>
          <textarea
            rows="3"
            maxLength={500}
            placeholder={t('prescriptions.fulfilment.notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <small>{t('prescriptions.fulfilment.noteHint', { count: 500 - note.length })}</small>
        </Field>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving} onClick={handleSave}>{saving ? t('common.saving') : t('common.save')}</button>
        </div>
      </div>
    </Modal>
  )
}

function PharmacyQueueTab({ onNavigate }) {
  const t = useT()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [decisionDialogOpen, setDecisionDialogOpen] = useState(false)
  const [decisionItem, setDecisionItem] = useState(null)
  const [decisionSaving, setDecisionSaving] = useState(false)
  const [detailPrescription, setDetailPrescription] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api.prescriptions.getPharmacyQueue?.()
      setRows(result.prescriptions || [])
    } catch (err) {
      setError(err.message || t('pharmacy.error.load'))
      setRows([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openDecisionDialog(item, prescription) {
    setDecisionItem({ item, prescription })
    setDecisionDialogOpen(true)
  }

  async function handleDecisionSave(decisionData) {
    if (!decisionItem) return
    setDecisionSaving(true)
    try {
      await api.prescriptions.setItemFulfilment(decisionItem.item.item_id, decisionData)
      // Refresh the queue to get updated status
      load()
      setDecisionDialogOpen(false)
      setDecisionItem(null)
    } catch (err) {
      setError(err.message || t('prescriptions.fulfilment.error'))
    } finally {
      setDecisionSaving(false)
    }
  }

  async function openPrescriptionDetail(prescriptionId) {
    if (detailLoading) return
    setDetailLoading(true)
    setError('')
    try {
      const result = await api.prescriptions.get(prescriptionId)
      setDetailPrescription(result)
    } catch (err) {
      setError(err.message || t('prescriptions.detail.error'))
    } finally {
      setDetailLoading(false)
    }
  }

  function closePrescriptionDetail() {
    setDetailPrescription(null)
  }

  return (
    <div className="tab-inner">
      <div className="panel-heading">
        <div><h2>{t('pharmacy.title')}</h2><p>{t('pharmacy.subtitle')}</p></div>
      </div>
      <Notice kind="error">{error}</Notice>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty text={t('pharmacy.queue.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead>
              <tr>
                <th>{t('pharmacy.queue.col.date')}</th>
                <th>{t('pharmacy.queue.col.patient')}</th>
                <th>{t('pharmacy.queue.col.doctor')}</th>
                <th>{t('pharmacy.queue.col.clinic')}</th>
                <th>{t('pharmacy.queue.col.medications')}</th>
                <th>{t('pharmacy.queue.col.fulfilment')}</th>
                <th>{t('pharmacy.queue.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.prescription_id}>
                  <td data-label={t('pharmacy.queue.col.date')}>{fmtDateTime(p.created_at)}</td>
                  <td data-label={t('pharmacy.queue.col.patient')}>{p.patient_name}</td>
                  <td data-label={t('pharmacy.queue.col.doctor')}>{p.doctor_name}</td>
                  <td data-label={t('pharmacy.queue.col.clinic')}>{p.clinic_name || t('layout.clinicById', { id: p.clinic_id })}</td>
                  <td data-label={t('pharmacy.queue.col.medications')}>
                    {(p.items || []).map((it, i) => (
                      <div key={i} className="medication-item">
                        <div>
                          {it.trade_name} ({it.scientific_name}) — {it.dosage} × {it.repeats_count}
                          {it.strength && <span> · {it.strength}</span>}
                          {it.dosage_form && <span> · {dosageFormLabel(it.dosage_form, t)}</span>}
                        </div>
                        <button
                          type="button"
                          className="text-button compact"
                          onClick={() => openDecisionDialog(it, p)}
                          title={t('pharmacy.queue.decisionAction')}
                        >
                          {t('pharmacy.queue.decisionAction')}
                        </button>
                      </div>
                    ))}
                  </td>
                  {/* Phase 10F.1: عرض فقط. الطابور لا يكتب ولا يصرف ولا يقرر. */}
                  <td data-label={t('pharmacy.queue.col.fulfilment')}>
                    {(p.items || []).map((it, i) => (
                      <div key={i} className="medication-item">
                        {t(`prescriptions.fulfilment.status.${it.fulfilment_status || 'PENDING'}`)}
                      </div>
                    ))}
                  </td>
                  <td data-label={t('pharmacy.queue.col.actions')}>
                    <button className="text-button" onClick={() => openPrescriptionDetail(p.prescription_id)} disabled={detailLoading}>
                      {detailLoading ? t('common.loading') : t('pharmacy.queue.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {decisionDialogOpen && decisionItem && (
        <FulfilmentDecisionDialog
          isOpen={decisionDialogOpen}
          onClose={() => { setDecisionDialogOpen(false); setDecisionItem(null); }}
          onSave={handleDecisionSave}
          initialStatus={decisionItem.item.fulfilment_status || 'PENDING'}
          initialNote={decisionItem.item.decision_note || ''}
          itemLabel={t('pharmacy.queue.decisionItemLabel', { medication: decisionItem.item.trade_name, patient: decisionItem.prescription.patient_name })}
          saving={decisionSaving}
        />
      )}
      {detailPrescription && (
        <PrescriptionDetailModal
          prescription={detailPrescription}
          onClose={closePrescriptionDetail}
        />
      )}
    </div>
  )
}

export function getPharmacyQueue() {
  return api.prescriptions.getPharmacyQueue()
}