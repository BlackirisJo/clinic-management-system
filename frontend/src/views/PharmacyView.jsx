import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { useT } from '../i18n'
import { Loading, Empty, Notice } from '../components/ui'
import { dosageFormLabel } from '../lib/dosageForm'

export default function PharmacyView() {
  const t = useT()
  return <PharmacyQueueTab />
}

function PharmacyQueueTab() {
  const t = useT()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')

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
                        {it.trade_name} ({it.scientific_name}) — {it.dosage} × {it.repeats_count}
                        {it.strength && <span> · {it.strength}</span>}
                        {it.dosage_form && <span> · {dosageFormLabel(it.dosage_form, t)}</span>}
                      </div>
                    ))}
                  </td>
                  <td data-label={t('pharmacy.queue.col.actions')}>
                    <button className="text-button" onClick={() => viewPrescription(p.prescription_id)}>
                      {t('pharmacy.queue.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function viewPrescription(id) {
  // Could open a modal or navigate to detail
  window.open(`/prescriptions/${id}`, '_blank')
}

export function getPharmacyQueue() {
  return api.prescriptions.getPharmacyQueue()
}