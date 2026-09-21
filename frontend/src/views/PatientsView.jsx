import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useT } from '../i18n'
import { fmtDate, fmtDateTime, GENDER_LABELS, DOCUMENT_TYPE_LABELS, ALLERGEN_KEYS, CHRONIC_CONDITION_KEYS, CONDITION_SEVERITY_KEYS } from '../lib/format'
import { Modal, Field, Loading, Empty, Notice, Paginator } from '../components/ui'
import VisitModal from '../components/VisitModal'

const LIMIT = 10

// دليل العيادات بالاسم — يُستخدم في كل نماذج الاختيار بالاسم بدل إدخال رقم العيادة
function useClinicDirectory(enabled = true) {
  const [clinics, setClinics] = useState([])
  const [loading, setLoading] = useState(enabled)
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.clinics.directory()
      .then((result) => { if (!cancelled) setClinics(result.clinics || []) })
      .catch(() => { if (!cancelled) setClinics([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [enabled])
  return { clinics, loading }
}

const clinicNameById = (clinics, clinicId) => {
  const id = Number(clinicId)
  if (!id) return ''
  return clinics.find((c) => Number(c.clinic_id) === id)?.clinic_name || ''
}

// مودال موحد لعرض محتوى أدوية الروشتة (يُستخدم في ملف المريض)
export function PrescriptionItemsModal({ prescriptionId, onClose }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setError('')
    api.prescriptions.get(prescriptionId)
      .then((result) => { if (!cancelled) setData(result) })
      .catch((err) => { if (!cancelled) setError(err.message || t('patients.prescriptionItems.error')) })
    return () => { cancelled = true }
  }, [prescriptionId])
  const rx = data?.prescription || {}
  const items = data?.items || []
  return (
    <Modal title={t('patients.prescriptionItems.title')} subtitle={rx.clinic_name ? t('patients.prescriptionItems.subtitleDirect', { clinic: rx.clinic_name }) : t('patients.prescriptionItems.subtitleNumber', { number: rx.prescription_id || prescriptionId })} onClose={onClose} wide>
      <Notice kind="error">{error}</Notice>
      {!data && !error ? <Loading text={t('patients.prescriptionItems.loading')} /> : data ? (
        <div className="prescription-paper" dir="rtl">
          <div className="paper-head">
            <div><strong>{t('patients.prescriptionItems.paperTitle')}</strong><span>{rx.doctor_name || t('patients.prescriptionItems.doctor')}</span></div>
            <div className="paper-date">{fmtDateTime(rx.created_at)}</div>
          </div>
          <div className="paper-patient">
            <span><b>{t('patients.prescriptionItems.patientLabel')}</b> {rx.patient_name || '—'}</span>
            {rx.clinic_name ? <span><b>{t('patients.prescriptionItems.clinicLabel')}</b> {rx.clinic_name}</span> : null}
          </div>
          {rx.notes ? <div className="paper-notes"><b>{t('patients.prescriptionItems.notesLabel')}</b> {rx.notes}</div> : null}
          {items.length === 0 ? <Empty text={t('patients.prescriptionItems.empty')} /> : (
            <div className="table-wrap table-cards">
              <table>
                <thead><tr><th>{t('patients.prescriptionItems.tableNumber')}</th><th>{t('patients.prescriptionItems.tableMedication')}</th><th>{t('patients.prescriptionItems.tableDosage')}</th><th>{t('patients.prescriptionItems.tableFrequency')}</th><th>{t('patients.prescriptionItems.tableDuration')}</th><th>{t('patients.prescriptionItems.tableTimingInstructions')}</th><th>{t('patients.prescriptionItems.tableRepeat')}</th></tr></thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={it.item_id ?? i}>
                      <td className="hide-sm" data-label={t('patients.prescriptionItems.tableNumber')}>{i + 1}</td>
                      <td className="cell-title">{it.trade_name}{it.scientific_name ? ` (${it.scientific_name})` : ''}</td>
                      <td data-label={t('patients.prescriptionItems.tableDosage')}>{it.dosage}</td>
                      <td data-label={t('patients.prescriptionItems.tableFrequency')}>{it.frequency}</td>
                      <td data-label={t('patients.prescriptionItems.tableDuration')}>{it.duration}</td>
                      <td data-label={t('patients.prescriptionItems.tableTimingInstructions')}>{it.timing_instructions || '—'}</td>
                      <td data-label={t('patients.prescriptionItems.tableRepeat')}>{it.repeats_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="paper-actions">
            <button className="primary-button compact" onClick={() => window.print()}>{t('patients.prescriptionItems.print')}</button>
            <button className="secondary-button compact" onClick={onClose}>{t('common.close')}</button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

// ===== تقرير الطوارئ الطبي — شامل وجاهز للطباعة =====
const esc = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function buildEmergencyReportHtml(report, t) {
  const { patient, report_metadata, patient_medical_profile: profile, allergies, chronic_conditions, pregnancy, current_clinic: currentClinic, included_clinics: clinics, generated_at } = report
  const clinicName = (c) => c?.clinic_name || c?.clinic_id || '—'
  const doctorName = (v) => v?.doctor_name || '—'
  const fmtVal = (d) => d ? new Date(d).toLocaleString() : '—'
  let html = `<!DOCTYPE html><html dir="ltr"><head><meta charset="UTF-8"><title>${esc(t('emergencyReport.reportTitle'))}</title><style>@page{size:A4;margin:15mm}*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;font-size:11px}body{padding:0;color:#222}h1{font-size:18px;text-align:center;margin:0 0 6px;padding-bottom:6px;border-bottom:2px solid #333}h2{font-size:14px;margin:12px 0 6px;padding:4px 8px;background:#f0f0f0;border-left:3px solid #333}h3{font-size:12px;margin:8px 0 4px;color:#444}table{width:100%;border-collapse:collapse;margin:4px 0 8px}th,td{border:1px solid #ccc;padding:3px 5px;text-align:left;vertical-align:top}th{background:#e8e8e8;font-weight:bold;font-size:10px}.section{margin-bottom:12px}.row{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0}.row>span{flex:1 1 30%;min-width:100px}.label{font-weight:bold;color:#555}.sub{margin-top:6px;padding:4px 6px;background:#fafafa;border:1px dashed #ddd}.visit-block{margin:6px 0;padding:6px;border:1px solid #ddd;border-radius:4px}.visit-header{font-weight:bold;background:#f5f5f5;padding:4px 6px;margin-bottom:4px}.visit-detail{margin:2px 0;padding:1px 4px;font-size:10px}.two-col{display:flex;gap:12px}.two-col>div{flex:1}@media print{body{padding:0}@page{size:A4;margin:15mm}}</style></head><body><h1>${esc(t('emergencyReport.reportTitle'))}</h1><div class="row"><span class="label">${esc(t('emergencyReport.generatedBy'))}:</span><span>${esc(report_metadata?.generated_by_name || '—')}</span><span class="label">${esc(t('emergencyReport.generatedAt'))}:</span><span>${esc(fmtVal(generated_at))}</span></div><div class="section"><h2>${esc(t('emergencyReport.patientInfo'))}</h2><div class="row"><span><span class="label">${esc(t('emergencyReport.patientId'))}:</span> ${esc(patient?.national_id || '—')}</span><span><span class="label">${esc(t('emergencyReport.patientId'))}:</span> ${esc(patient?.patient_id ?? '—')}</span><span><span class="label">${esc(t('emergencyReport.clinic'))}:</span> ${esc(patient?.owner_clinic_id ?? '—')}</span></div><div class="row"><span>${esc(patient?.full_name || '—')}</span><span>${esc(patient?.gender === 'MALE' ? 'M' : patient?.gender === 'FEMALE' ? 'F' : patient?.gender || '—')}</span><span>${esc(fmtVal(patient?.date_of_birth))}</span><span>${esc(patient?.phone || '—')}</span></div></div>${profile ? `<div class="section"><h2>${esc(t('emergencyReport.medicalProfile'))}</h2><div class="row"><span><span class="label">${esc(t('emergencyReport.bloodType'))}:</span> ${esc(profile?.blood_type || '—')}</span><span><span class="label">Rh:</span> ${esc(profile?.rh_factor || '—')}</span><span><span class="label">${esc(t('emergencyReport.currentMedications'))}:</span> ${esc(profile?.current_medications || '—')}</span></div></div>` : ''}${allergies?.length > 0 ? `<div class="section"><h2>${esc(t('emergencyReport.allergies'))}</h2>${allergies.map((a) => `<div class="sub">${esc(a?.allergen_key || '—')}: ${esc(a?.notes || '—')}</div>`).join('')}</div>` : ''}${chronic_conditions?.length > 0 ? `<div class="section"><h2>${esc(t('emergencyReport.chronicConditions'))}</h2>${chronic_conditions.map((c) => `<div class="sub">${esc(c?.condition_key || '—')}: ${esc(c?.severity || '—')} — ${esc(c?.notes || '—')}</div>`).join('')}</div>` : ''}${pregnancy ? `<div class="section"><h2>${esc(t('emergencyReport.pregnancy'))}</h2><div class="row"><span><span class="label">${esc(t('emergencyReport.pregnancyStatus'))}:</span> ${esc(pregnancy.status || '—')}</span><span><span class="label">${esc(t('emergencyReport.pregnancyLMP'))}:</span> ${esc(pregnancy.lmp_date || '—')}</span><span><span class="label">${esc(t('emergencyReport.pregnancyEDD'))}:</span> ${esc(pregnancy.edd_date || '—')}</span></div><div class="row"><span><span class="label">${esc(t('emergencyReport.pregnancyGA'))}:</span> ${pregnancy.gravida ?? '—'} G / ${pregnancy.para ?? '—'} P</span><span><span class="label">${esc(t('emergencyReport.pregnancyRisk'))}:</span> ${esc(pregnancy.risk_level || '—')}</span><span><span class="label">${esc(t('emergencyReport.pregnancyOutcome'))}:</span> ${esc(pregnancy.outcome || '—')}</span></div>${pregnancy.visits?.length > 0 ? `<h3>${esc(t('emergencyReport.visit'))}</h3>${pregnancy.visits.map((v) => `<div class="sub visit-block"><div class="visit-header">${esc(fmtVal(v.visit_date))} — ${esc(v.fetal_presentation || '—')}</div><div class="visit-detail">GA: ${v.ga_weeks ?? '—'}w ${v.ga_days ?? '—'}d | FHR: ${v.fetal_heart_rate ?? '—'} | BPD: ${v.bpd_cm ?? '—'} | AFI: ${v.amniotic_fluid_index ?? '—'}</div></div>`).join('')}` : ''}${pregnancy.lab_orders?.length > 0 ? `<h3>${esc(t('emergencyReport.labOrders'))}</h3>${pregnancy.lab_orders.map((l) => `<div class="sub">${esc(l.test_name || '—')}: ${esc(l.result_value || '—')} ${esc(l.unit || '')} [${esc(l.reference_range || '—')}] ${l.is_abnormal ? '(' + esc(t('emergencyReport.abnormal')) + ')' : ''}</div>`).join('')}` : ''}${pregnancy.ultrasounds?.length > 0 ? `<h3>${esc(t('emergencyReport.imaging'))}</h3>${pregnancy.ultrasounds.map((u) => `<div class="sub">${esc(fmtVal(u.exam_date))} — ${esc(u.findings || u.impression || '—')}</div>`).join('')}` : ''}</div>` : ''}${currentClinic ? `<div class="section"><h2>${esc(t('emergencyReport.currentClinic'))}</h2><div>${esc(currentClinic.clinic_name || currentClinic.clinic_id)}</div></div>` : ''}${clinics?.map((cc) => {
  const visitsHtml = cc.visits?.length > 0 ? cc.visits.map((v) => {
    const vitalsHtml = v.vitals?.length > 0 ? v.vitals.map((vt) => `<div class="visit-detail">${esc(fmtVal(vt.recorded_at))}: BP ${vt.systolic ?? '—'}/${vt.diastolic ?? '—'} P ${vt.pulse ?? '—'} T ${vt.temperature ?? '—'} SpO2 ${vt.spo2 ?? '—'} W ${vt.weight_kg ?? '—'} H ${vt.height_cm ?? '—'} Pain ${vt.pain_score ?? '—'}</div>`).join('') : ''
    const dxHtml = v.diagnoses?.length > 0 ? v.diagnoses.map((d) => `<div class="visit-detail">${esc(d.icd_code || '')} ${esc(d.description || '')} (${esc(d.diagnosis_type || '—')})</div>`).join('') : ''
    const labHtml = v.lab_orders?.length > 0 ? v.lab_orders.map((l) => `<div class="visit-detail">${esc(l.test_name || '')} (${esc(l.category || '')}) ${esc(l.status || '')}: ${esc(l.result_value || l.notes || '—')} ${l.is_abnormal ? '(' + esc(t('emergencyReport.abnormal')) + ')' : ''}</div>`).join('') : ''
    const imgHtml = v.imaging?.length > 0 ? v.imaging.map((im) => `<div class="visit-detail">${esc(fmtVal(im.created_at))} ${esc(im.modality || '')} ${esc(im.body_part || '')}: ${esc(im.findings || im.impression || '—')}</div>`).join('') : ''
    const refHtml = v.referrals?.length > 0 ? v.referrals.map((r) => `<div class="visit-detail">${esc(r.reason || '')} → ${esc(r.to_specialty_ar || r.to_specialty_en || r.to_clinic_id || '')} (${esc(r.status || '—')})</div>`).join('') : ''
    const rxHtml = v.prescriptions?.length > 0 ? v.prescriptions.map((rx) => `<div class="visit-detail">${esc(rx.notes || '—')}</div>`).join('') : ''
    const attHtml = v.attachments?.length > 0 ? v.attachments.map((a) => `<div class="visit-detail">${esc(a.file_name || '')} (${esc(a.kind || '')}) ${esc(fmtVal(a.created_at))}</div>`).join('') : ''
    return `<div class="visit-block"><div class="visit-header">${esc(t('emergencyReport.visit'))} #${esc(v.visit_id)} — ${esc(fmtVal(v.visit_date))} — ${esc(v.visit_status || '—')}</div><div class="two-col"><div><div class="visit-detail"><span class="label">${esc(t('emergencyReport.doctor'))}:</span> ${esc(doctorName(v))}</div><div class="visit-detail"><span class="label">${esc(t('emergencyReport.chiefComplaint'))}:</span> ${esc(v.chief_complaint || '—')}</div>${v.clinical_examination ? `<div class="visit-detail"><span class="label">${esc(t('emergencyReport.clinicalExamination'))}:</span> ${esc(v.clinical_examination)}</div>` : ''}${v.assessment ? `<div class="visit-detail"><span class="label">${esc(t('emergencyReport.assessment'))}:</span> ${esc(v.assessment)}</div>` : ''}${v.treatment_plan ? `<div class="visit-detail"><span class="label">${esc(t('emergencyReport.treatmentPlan'))}:</span> ${esc(v.treatment_plan)}</div>` : ''}${v.follow_up_plan ? `<div class="visit-detail"><span class="label">${esc(t('emergencyReport.followUp'))}:</span> ${esc(v.follow_up_plan)}</div>` : ''}${v.next_visit_date ? `<div class="visit-detail"><span class="label">${esc(t('emergencyReport.nextVisit'))}:</span> ${esc(fmtVal(v.next_visit_date))}</div>` : ''}${v.disposition ? `<div class="visit-detail"><span class="label">${esc(t('emergencyReport.disposition'))}:</span> ${esc(v.disposition)}</div>` : ''}${v.triage_level ? `<div class="visit-detail"><span class="label">Triage:</span> ${esc(v.triage_level)}</div>` : ''}</div><div>${vitalsHtml}${dxHtml}${labHtml}${imgHtml}${refHtml}${rxHtml}${attHtml}</div></div></div>`
  }).join('') : `<div class="sub">${esc(t('emergencyReport.noData'))}</div>`
    return `<div class="section"><h2>${esc(clinicName(cc.clinic))} (${esc(t('emergencyReport.sourceClinic'))})</h2>${visitsHtml}</div>`
  }).join('') || ''}<div class="row" style="margin-top:12px;padding-top:6px;border-top:1px solid #ccc"><span class="label">${esc(t('emergencyReport.generatedAt'))}:</span><span>${esc(fmtVal(generated_at))}</span></div></body></html>`
  return html
}

function printEmergencyReport(report, t) {
  const html = buildEmergencyReportHtml(report, t)
  const win = window.open('', '_blank', 'width=1200,height=900')
  if (!win) return
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.onload = () => { setTimeout(() => win.print(), 500) }
}

function EmergencyReportDisplay({ report, t }) {
  if (!report) return null
  const { patient, current_clinic: currentClinic, pregnancy, included_clinics: includedClinics, generated_at: generatedAt } = report
  const profile = report.patient_medical_profile
  const clinicName = (c) => c?.clinic_name || c?.clinic_id || '—'
  return (
    <div className="emergency-report" dir="ltr" style={{ marginTop: 12 }}>
      <div className="record-block">
        <h4>{t('emergencyReport.reportTitle')}</h4>
        <div className="timeline-vitals">
          <span><span className="label">{t('emergencyReport.generatedBy')}:</span> {report.report_metadata?.generated_by_name || '—'}</span>
          <span><span className="label">{t('emergencyReport.generatedAt')}:</span> {fmtDateTime(generatedAt)}</span>
        </div>
      </div>
      <div className="record-block">
        <h4>{t('emergencyReport.patientInfo')}</h4>
        <div className="timeline-vitals">
          <span><strong>{patient.full_name}</strong></span>
          <span dir="ltr">{patient.national_id || '—'}</span>
          <span>{patient.gender === 'MALE' ? 'M' : patient.gender === 'FEMALE' ? 'F' : patient.gender || '—'}</span>
          <span>{fmtDate(patient.date_of_birth)}</span>
          <span>{t('emergencyReport.bloodType')}: {patient.blood_type || t('emergencyReport.none')}</span>
        </div>
      </div>
      {profile && (
        <div className="record-block">
          <h4>{t('emergencyReport.medicalProfile')}</h4>
          <div className="timeline-vitals">
            <span>{t('emergencyReport.bloodType')}: {profile.blood_type || '—'}</span>
            <span>Rh: {profile.rh_factor || '—'}</span>
            <span>{t('emergencyReport.currentMedications')}: {(profile.current_medications || '').substring(0, 100) || '—'}</span>
          </div>
        </div>
      )}
      {report.allergies?.length > 0 ? (
        <div className="record-block">
          <h4>{t('emergencyReport.allergies')}</h4>
          {report.allergies.map((a, i) => (
            <div key={i} className="sub" style={{ marginBottom: 4 }}><strong>{a?.allergen_key || '—'}</strong> — {a?.notes || '—'}</div>
          ))}
        </div>
      ) : null}
      {report.chronic_conditions?.length > 0 ? (
        <div className="record-block">
          <h4>{t('emergencyReport.chronicConditions')}</h4>
          {report.chronic_conditions.map((c, i) => (
            <div key={i} className="sub" style={{ marginBottom: 4 }}><strong>{c?.condition_key || '—'}</strong> — {c?.severity || '—'} — {c?.notes || '—'}</div>
          ))}
        </div>
      ) : null}
      {pregnancy && (
        <div className="record-block">
          <h4>{t('emergencyReport.pregnancy')}</h4>
          <div className="timeline-vitals">
            <span>{t('emergencyReport.pregnancyStatus')}: {pregnancy.status}</span>
            <span>{t('emergencyReport.pregnancyLMP')}: {pregnancy.lmp_date || '—'}</span>
            <span>{t('emergencyReport.pregnancyEDD')}: {pregnancy.edd_date || '—'}</span>
            <span>{t('emergencyReport.pregnancyRisk')}: {pregnancy.risk_level || '—'}</span>
            <span>{t('emergencyReport.pregnancyOutcome')}: {pregnancy.outcome || '—'}</span>
          </div>
        </div>
      )}
      {currentClinic && (
        <div className="record-block">
          <h4>{t('emergencyReport.currentClinic')}</h4>
          <span>{currentClinic.clinic_name || currentClinic.clinic_id}</span>
        </div>
      )}
      {includedClinics?.map((c) => (
        <div className="record-block" key={c.clinic.clinic_id}>
          <h4>{c.clinic.clinic_name || c.clinic.clinic_id} ({t('emergencyReport.sourceClinic')})</h4>
          {c.visits.length === 0 ? <Empty text={t('emergencyReport.noData')} /> : (
            <div>
              {c.visits.map((v) => (
                <div key={v.visit_id} style={{ marginBottom: 8, padding: 6, border: '1px solid #ddd', borderRadius: 4 }}>
                  <strong>{t('emergencyReport.visit')} #{v.visit_id} — {fmtDateTime(v.visit_date)} — {v.visit_status || '—'}</strong>
                  <div style={{ fontSize: 12, color: '#444', marginTop: 2 }}>
                    <span>{t('emergencyReport.doctor')}: {v.doctor_name || '—'}</span>
                    <span dir="ltr">{' '}{t('emergencyReport.chiefComplaint')}: {v.chief_complaint || '—'}</span>
                    {v.clinical_examination && <span>{t('emergencyReport.clinicalExamination')}: {v.clinical_examination}</span>}
                    {v.assessment && <span>{t('emergencyReport.assessment')}: {v.assessment}</span>}
                    {v.treatment_plan && <span>{t('emergencyReport.treatmentPlan')}: {v.treatment_plan}</span>}
                    {v.next_visit_date && <span>{t('emergencyReport.nextVisit')}: {fmtDateTime(v.next_visit_date)}</span>}
                    {v.disposition && <span>{t('emergencyReport.disposition')}: {v.disposition}</span>}
                  </div>
                  {v.vitals?.length > 0 && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      {t('emergencyReport.vitals')}: {v.vitals.map((vt) => `BP ${vt.systolic}/${vt.diastolic} P${vt.pulse} T${vt.temperature}`).join(' | ')}
                    </div>
                  )}
                  {v.diagnoses?.length > 0 && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      {t('emergencyReport.diagnoses')}: {v.diagnoses.map((d) => `${d.icd_code || ''} ${d.description || ''}`).join('; ')}
                    </div>
                  )}
                  {v.lab_orders?.length > 0 && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      {t('emergencyReport.labOrders')}: {v.lab_orders.map((l) => `${l.test_name}: ${l.result_value || l.status}`).join('; ')}
                    </div>
                  )}
                  {v.imaging?.length > 0 && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      {t('emergencyReport.imaging')}: {v.imaging.map((im) => `${im.modality || ''} ${im.body_part || ''}: ${im.findings || im.impression || ''}`).join('; ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}


export default function PatientsView() {
  const t = useT()
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.patients.list({ search: search || undefined, page, limit: LIMIT })
      setRows(result.patients || [])
    } catch (err) {
      setError(err.message || t('patients.error.load'))
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { load() }, [load])

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('patients.title')}</h2><p>{t('patients.subtitle')}</p></div>
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('patients.create')}</button>
      </div>

      <div className="toolbar">
        <input className="input" placeholder={t('patients.searchPlaceholder')} value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
      </div>

      <Notice kind="error">{error}</Notice>
      {loading ? <Loading text={t('patients.loading')} /> : rows.length === 0 ? <Empty text={t('patients.empty')} /> : (
        <>
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr><th>{t('patients.table.patient')}</th><th>{t('patients.table.nationalId')}</th><th>{t('patients.table.phone')}</th><th>{t('patients.table.genderType')}</th><th>{t('patients.table.birthDate')}</th><th>{t('patients.table.registeredAt')}</th><th>{t('patients.table.actions')}</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.patient_id}>
                    <td><span className="table-avatar">{p.full_name?.[0] || t('patients.avatarInitial')}</span>{p.full_name}{p.is_shared ? <span className="badge shared-chip">{t('patients.sharedBadge')}</span> : null}</td>
                    <td dir="ltr" data-label={t('patients.table.nationalId')}>{p.national_id || '—'}</td>
                    <td dir="ltr" data-label={t('patients.table.phone')}>{p.phone}</td>
                    <td data-label={t('patients.table.genderType')}>{GENDER_LABELS[p.gender] || p.gender}</td>
                    <td data-label={t('patients.table.birthDate')}>{fmtDate(p.date_of_birth, true)}</td>
                    <td data-label={t('patients.table.registeredAt')}>{fmtDate(p.created_at, true)}</td>
                    <td className="cell-actions"><button className="text-button" onClick={() => setSelected(p)}>{t('patients.openFile')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} />
        </>
      )}

      {showAdd && <AddPatientModal user={user} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
      {selected && <PatientDetailModal patient={selected} user={user} onClose={() => setSelected(null)} />}
    </section>
  )
}

function AddPatientModal({ user, onClose, onSaved }) {
  const t = useT()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const { clinics, loading: clinicsLoading } = useClinicDirectory(true)
  const defaultClinic = useMemo(() => {
    const mine = Number(user?.clinicId)
    if (mine) return String(mine)
    if (!isGlobal && user?.clinicIds?.length) return String(user.clinicIds[0])
    return ''
  }, [user, isGlobal])
  const [form, setForm] = useState({ full_name: '', document_type: 'NATIONAL_ID', document_number: '', national_id: '', phone: '', gender: 'MALE', date_of_birth: '', clinic_id: defaultClinic })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // عند اكتمال تحميل الدليل، تأكد أن النموذج يحتوي على قيمة عيادة صالحة
  useEffect(() => {
    if (!defaultClinic) return
    setForm((prev) => ({ ...prev, clinic_id: defaultClinic }))
  }, [defaultClinic])

  // إذا كان المستخدم غير مدير ودليل العيادات جاهز، تأكد أن العيادة الافتراضية مختارة بالاسم
  useEffect(() => {
    if (isGlobal || clinicsLoading || !user?.clinicId) return
    const mine = clinics.find((c) => Number(c.clinic_id) === Number(user.clinicId))
    if (mine && (!form.clinic_id || form.clinic_id === '')) {
      setForm((prev) => ({ ...prev, clinic_id: String(mine.clinic_id) }))
    }
  }, [clinics, clinicsLoading, user?.clinicId, form.clinic_id, isGlobal])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.patients.create({ ...form, national_id: form.national_id || undefined, clinic_id: form.clinic_id ? Number(form.clinic_id) : undefined })
      onSaved()
    } catch (err) {
      setError(err.message || t('patients.add.saveError'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('patients.create.title')} subtitle={t('patients.modal.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('patients.fullName')} required>
          <input required minLength={3} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label={t('patients.clinicField')} required
          hint={clinicsLoading ? t('patients.loadingClinics') : (isGlobal ? t('patients.clinicHintGlobal') : t('patients.clinicHintAssigned'))}>
          {clinicsLoading ? (
            <select disabled><option>{t('patients.loadingClinics')}</option></select>
          ) : isGlobal ? (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">{t('patients.add.selectClinic')}</option>
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          ) : (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">{t('patients.myClinicsOption')}</option>
              {clinics
                .filter((c) => (user?.clinicIds || (user?.clinicId ? [user.clinicId] : [])).map(Number).includes(Number(c.clinic_id)))
                .map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          )}
        </Field>
        <div className="form-row"><Field label={t('patients.documentType')} required>
          <select value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })}>
            <option value="NATIONAL_ID">{t('documentType.NATIONAL_ID')}</option>
            <option value="PASSPORT">{t('documentType.PASSPORT')}</option>
            <option value="OTHER">{t('documentType.OTHER')}</option>
          </select>
        </Field>
        <Field label={t('patients.documentNumber')} required><input required maxLength={100} value={form.document_number} onChange={(e) => setForm({ ...form, document_number: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('patients.nationalId')}><input value={form.national_id} onChange={(e) => setForm({ ...form, national_id: e.target.value })} /></Field>
          <Field label={t('patients.phone')} required><input required minLength={7} dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('patients.gender')} required>
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="MALE">{t('patients.genderMale')}</option><option value="FEMALE">{t('patients.genderFemale')}</option>
            </select>
          </Field>
          <Field label={t('patients.birthDate')} required><input required type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></Field>
        </div>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('patients.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
function PatientDetailModal({ patient, user, onClose }) {
  const t = useT()
  const { user: authUser } = useAuth()
  const [tab, setTab] = useState('visits')
  const [showEmergency, setShowEmergency] = useState(false)
  const [emergencyReport, setEmergencyReport] = useState(null)
  const [emergencyLoading, setEmergencyLoading] = useState(false)
  const [emergencyError, setEmergencyError] = useState('')
  const [selectedClinics, setSelectedClinics] = useState([])
  const { clinics } = useClinicDirectory(true)

  const currentClinicId = authUser?.clinicId
  const authorizedClinics = authUser?.clinicIds ?? []

  const clinicName = (id) => clinicNameById(clinics, id)

  async function handleGenerateReport() {
    setEmergencyLoading(true); setEmergencyError(''); setEmergencyReport(null)
    try {
      const result = await api.clinical.emergencyReport({ patient_id: patient.patient_id, clinic_ids: selectedClinics })
      setEmergencyReport(result)
    } catch (err) {
      setEmergencyError(err.message || t('emergencyReport.error'))
    } finally { setEmergencyLoading(false) }
  }

  return (
    <Modal title={patient.full_name} subtitle={t('patients.detail.fileNumber', { id: patient.patient_id })} onClose={onClose} wide>
      <div className="detail-summary">
        <span>{GENDER_LABELS[patient.gender] || patient.gender}</span>
        <span dir="ltr">{patient.phone}</span>
        {patient.document_type ? <span>{DOCUMENT_TYPE_LABELS[patient.document_type] || patient.document_type}: <span dir="ltr">{patient.document_number}</span></span> : null}
        {patient.national_id ? <span dir="ltr">{patient.national_id}</span> : null}
        <span>{fmtDate(patient.date_of_birth, true)}</span>
      </div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button type="button" className="secondary-button compact" onClick={() => setShowEmergency(true)}>{t('emergencyReport.button')}</button>
      </div>
      <div className="tabs">
        <button className={tab === 'visits' ? 'tab active' : 'tab'} onClick={() => setTab('visits')}>{t('patients.tabVisits')}</button>
        <button className={tab === 'medical' ? 'tab active' : 'tab'} onClick={() => setTab('medical')}>{t('patients.tabMedical')}</button>
        <button className={tab === 'record' ? 'tab active' : 'tab'} onClick={() => setTab('record')}>{t('patients.tabUnifiedRecord')}</button>
        <button className={tab === 'shares' ? 'tab active' : 'tab'} onClick={() => setTab('shares')}>{t('patients.tabs.shares')}</button>
      </div>
      <div className="tab-content">
        {tab === 'visits' && <VisitsTab patient={patient} user={user} />}
        {tab === 'medical' && <MedicalProfileTab patient={patient} user={user} />}
        {tab === 'record' && <MedicalRecordTab patient={patient} />}
        {tab === 'shares' && <SharesTab patient={patient} />}
      </div>

      {showEmergency && (
        <Modal title={t('emergencyReport.title')} subtitle={t('patients.detail.fileNumber', { id: patient.patient_id })} onClose={() => { setShowEmergency(false); setEmergencyReport(null); setEmergencyError(''); setSelectedClinics([]) }} wide>
          {!emergencyReport && !emergencyLoading && (
            <div>
              <div className="form-row">
                <Field label={t('emergencyReport.currentClinic')}>
                  <strong>{currentClinicId ? clinicName(currentClinicId) : '—'}</strong>
                </Field>
                <Field label={t('emergencyReport.required')}><span className="muted-small">{t('emergencyReport.required')}</span></Field>
              </div>
              <div className="form-row">
                <Field label={t('emergencyReport.selectClinics')}>
                  <div>
                    {authorizedClinics.filter((c) => c !== currentClinicId).map((cid) => (
                      <label key={cid} style={{ display: 'block', margin: '4px 0' }}>
                        <input type="checkbox" checked={selectedClinics.includes(cid)} onChange={(e) => {
                          if (e.target.checked) setSelectedClinics([...selectedClinics, cid])
                          else setSelectedClinics(selectedClinics.filter((c) => c !== cid))
                        }} /> {clinicName(cid)}
                      </label>
                    ))}
                    {authorizedClinics.filter((c) => c !== currentClinicId).length === 0 ? <span className="muted-small">{t('emergencyReport.noAdditional')}</span> : null}
                  </div>
                </Field>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => { setShowEmergency(false); setSelectedClinics([]) }}>{t('common.close')}</button>
                <button type="button" className="primary-button" disabled={emergencyLoading} onClick={handleGenerateReport}>{t('emergencyReport.generate')}</button>
              </div>
            </div>
          )}
          {emergencyLoading && <Loading text={t('emergencyReport.generating')} />}
          {emergencyError && <Notice kind="error">{emergencyError}</Notice>}
          {emergencyReport && (
            <div>
              <EmergencyReportDisplay report={emergencyReport} t={t} />
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => printEmergencyReport(emergencyReport, t)}>{t('emergencyReport.print')}</button>
                <button type="button" className="secondary-button" onClick={() => { setShowEmergency(false); setEmergencyReport(null); setSelectedClinics([]) }}>{t('common.close')}</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </Modal>
  )
}

// تبويب البيانات الطبية التكميلية — الطبيب يكمل ويحدّث، والبقية عرض فقط
function MedicalProfileTab({ patient, user }) {
  const t = useT()
  const canEdit = ['DOCTOR', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user?.roleName) || (user?.permissions || []).includes('EDIT_PATIENT_MEDICAL')
  const [profile, setProfile] = useState(null)
  const [allergySel, setAllergySel] = useState({})
  const [condSel, setCondSel] = useState({})
  const [extras, setExtras] = useState({ blood_type: '', current_medications: '', medical_notes: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const applyResult = useCallback((result) => {
    const p = result.profile
    setProfile(p)
    setExtras({
      blood_type: p?.blood_type || '',
      current_medications: p?.current_medications || '',
      medical_notes: p?.medical_notes || '',
    })
    setAllergySel(Object.fromEntries(ALLERGEN_KEYS.map((k) => {
      const row = (result.allergies || []).find((a) => a.allergen_key === k)
      return [k, { checked: Boolean(row), notes: row?.notes || '' }]
    })))
    setCondSel(Object.fromEntries(CHRONIC_CONDITION_KEYS.map((k) => {
      const row = (result.chronic_conditions || []).find((c) => c.condition_key === k)
      return [k, { checked: Boolean(row), severity: row?.severity || 'UNSPECIFIED', notes: row?.notes || '' }]
    })))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.patients.medicalProfile(patient.patient_id)
      applyResult(result)
    } catch (err) {
      setError(err.message || t('patients.medical.loadError'))
    } finally { setLoading(false) }
  }, [patient.patient_id, applyResult])

  useEffect(() => { load() }, [load])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    setDone(false)
    try {
      const result = await api.patients.saveMedicalProfile(patient.patient_id, {
        blood_type: extras.blood_type || undefined,
        current_medications: extras.current_medications.trim() || undefined,
        medical_notes: extras.medical_notes.trim() || undefined,
        allergies: ALLERGEN_KEYS.filter((k) => allergySel[k]?.checked).map((k) => ({ allergen_key: k, notes: allergySel[k].notes.trim() || undefined })),
        chronic_conditions: CHRONIC_CONDITION_KEYS.filter((k) => condSel[k]?.checked).map((k) => ({ condition_key: k, severity: condSel[k].severity || undefined, notes: condSel[k].notes.trim() || undefined })),
      })
      applyResult(result)
      setDone(true)
    } catch (err) {
      setError(err.message || t('patients.medical.saveError'))
    } finally { setSaving(false) }
  }

  if (loading) return <Loading text={t('patients.medical.loading')} />

  return (
    <div className="tab-inner">
      <form className="patient-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('patients.medical.bloodType')}>
            <select value={extras.blood_type} disabled={!canEdit} onChange={(e) => setExtras({ ...extras, blood_type: e.target.value })}>
              <option value="">{t('patients.medical.unspecified')}</option>
              {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bt) => <option key={bt} value={bt}>{bt}</option>)}
            </select>
          </Field>
          <Field label={t('patients.medical.currentMedications')} hint={t('patients.medical.currentMedicationsHint')}>
            <textarea rows="2" disabled={!canEdit} value={extras.current_medications} onChange={(e) => setExtras({ ...extras, current_medications: e.target.value })} />
          </Field>
        </div>

        <div className="med-section">
          <h4>{t('patients.allergy')}</h4>
          <div className="med-grid">
            {ALLERGEN_KEYS.map((key) => (
              <div className="med-item" key={key}>
                <label className="med-check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(allergySel[key]?.checked)} onChange={(e) => setAllergySel({ ...allergySel, [key]: { ...allergySel[key], checked: e.target.checked } })} />
                  <span>{t('allergen.' + key)}</span>
                </label>
                <input className="med-note" placeholder={t('patients.medical.allergyNotePlaceholder')} disabled={!canEdit || !allergySel[key]?.checked} value={allergySel[key]?.notes || ''} onChange={(e) => setAllergySel({ ...allergySel, [key]: { ...allergySel[key], notes: e.target.value } })} />
              </div>
            ))}
          </div>
        </div>

        <div className="med-section">
          <h4>{t('patients.chronicConditions')}</h4>
          <div className="med-grid">
            {CHRONIC_CONDITION_KEYS.map((key) => (
              <div className="med-item" key={key}>
                <label className="med-check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(condSel[key]?.checked)} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], checked: e.target.checked } })} />
                  <span>{t('chronicCondition.' + key)}</span>
                </label>
                <select className="med-sev" disabled={!canEdit || !condSel[key]?.checked} value={condSel[key]?.severity || 'UNSPECIFIED'} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], severity: e.target.value } })} aria-label={t('patients.medical.severityAria')}>
                  {CONDITION_SEVERITY_KEYS.map((code) => <option key={code} value={code}>{t('conditionSeverity.' + code)}</option>)}
                </select>
                <input className="med-note" placeholder={t('patients.medical.notePlaceholder')} disabled={!canEdit || !condSel[key]?.checked} value={condSel[key]?.notes || ''} onChange={(e) => setCondSel({ ...condSel, [key]: { ...condSel[key], notes: e.target.value } })} />
              </div>
            ))}
          </div>
        </div>

        <Field label={t('patients.medical.notes')}>
          <textarea rows="3" disabled={!canEdit} value={extras.medical_notes} onChange={(e) => setExtras({ ...extras, medical_notes: e.target.value })} />
        </Field>
        <Notice kind="error">{error}</Notice>
        {done && <Notice kind="success">{t('patients.medical.savedSuccess')}</Notice>}
        {canEdit ? (
          <div className="modal-actions">
            <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('patients.medical.save')}</button>
          </div>
        ) : (
          <p className="profile-meta">{t('patients.medical.readOnly')}</p>
        )}
        {profile?.updated_at ? <p className="profile-meta">{t('patients.lastUpdated')}: {fmtDateTime(profile.updated_at)}{profile.updated_by_name ? ` — بواسطة ${profile.updated_by_name}` : ''}</p> : null}
      </form>
    </div>
  )
}

function VisitsTab({ patient, user }) {
  const t = useT()
  const [visits, setVisits] = useState(null)
  const [prescriptions, setPrescriptions] = useState([]) // فارغة افتراضياً
  const [doctors, setDoctors] = useState(null) // null = غير متاح
  const [showAdd, setShowAdd] = useState(false)
  const [openVisitId, setOpenVisitId] = useState(null)
  const [openPrescriptionId, setOpenPrescriptionId] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await api.patients.visits(patient.patient_id)
      setVisits(result.visits || [])
    } catch (err) { setError(err.message); setVisits([]) }
    // الروشتات تأتي من السجل الموحد (لا تعتمد على صلاحيات إضافية عند فشلها)
    try {
      const rec = await api.patients.record(patient.patient_id)
      setPrescriptions(rec.prescriptions || [])
    } catch { /* لا صلاحية للسجل الموحد — نكتفي بالزيارات */ }
  }, [patient.patient_id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    api.users.doctors()
      .then((result) => setDoctors(result.doctors || []))
      .catch(() => setDoctors([]))
  }, [])

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('patients.visits.add')}</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {visits === null ? <Loading /> : visits.length === 0 ? <Empty text={t('patients.visits.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('patients.table.date')}</th><th>{t('patients.table.clinic')}</th><th>{t('patients.table.specialty')}</th><th>{t('patients.table.doctor')}</th><th>{t('patients.table.status')}</th><th>{t('patients.table.notes')}</th><th></th></tr></thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.visit_id}>
                  <td>{fmtDateTime(v.visit_date)}</td>
                  <td>{fmtDateTime(v.visit_date)}</td>
                  <td data-label={t('patients.table.clinic')}>{v.clinic_name || '—'}</td>
                  <td data-label={t('patients.table.specialty')}>{v.specialty_name || '—'}</td>
                  <td data-label={t('patients.table.doctor')}>{v.doctor_name || '—'}</td>
                  <td data-label={t('patients.table.status')}>{v.visit_status === 'OPEN' ? <span className="badge">{t('visit.statusOpen')}</span> : v.visit_status === 'COMPLETED' ? <span className="muted-small">{t('visit.statusCompleted')}</span> : <span className="muted-small">{t('visit.statusCancelled')}</span>}</td>
                  <td data-label={t('patients.table.notes')}>{v.notes || '—'}</td>
                  <td className="cell-actions"><button className="text-button" onClick={() => setOpenVisitId(v.visit_id)}>{t('patients.visit.record')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="record-block" style={{ marginTop: 16 }}>
        <h4>{t('patients.record.prescriptionsTitle')}</h4>
        {prescriptions.length === 0 ? <Empty text={t('patients.record.prescriptionsEmpty')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('patients.table.doctor')}</th><th>{t('patients.table.notes')}</th><th>{t('patients.table.date')}</th><th></th></tr></thead>
              <tbody>
                {prescriptions.map((rx) => (
                  <tr key={rx.prescription_id}>
                    <td>{rx.doctor_name || '—'}</td>
                    <td data-label={t('patients.table.notes')}>{rx.notes || '—'}</td>
                    <td data-label={t('patients.table.date')}>{fmtDateTime(rx.created_at)}</td>
                    <td className="cell-actions"><button className="text-button" onClick={() => setOpenPrescriptionId(rx.prescription_id)}>{t('patients.record.viewPrescription')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && <AddVisitModal patient={patient} user={user} doctors={doctors} onClose={() => setShowAdd(false)} onSaved={(newVisitId) => { setShowAdd(false); load(); if (newVisitId) setOpenVisitId(newVisitId) }} />}
      {openVisitId && <VisitModal visitId={openVisitId} onClose={() => { setOpenVisitId(null); load() }} />}
      {openPrescriptionId && <PrescriptionItemsModal prescriptionId={openPrescriptionId} onClose={() => setOpenPrescriptionId(null)} />}
    </div>
  )
}

function AddVisitModal({ patient, user, doctors: initialDoctors, onClose, onSaved }) {
  const t = useT()
  const isGlobal = user?.roleName === 'SUPER_ADMIN' || user?.roleName === 'SYSTEM_ADMIN'
  const { clinics, loading: clinicsLoading } = useClinicDirectory(true)
  const userClinicLabel = clinicNameById(clinics, user?.clinicId) || (user?.clinicId ? t('layout.clinicById', { id: user.clinicId }) : '')
  // العيادات المسندة للمستخدم فقط (الأساسية + الإسنادات الإضافية clinic_staff)
  const myClinicIds = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
  const myClinics = clinics.filter((c) => myClinicIds.includes(Number(c.clinic_id)))
  const [form, setForm] = useState({
    clinic_id: isGlobal ? '' : (user?.clinicId || ''),
    doctor_id: '',
    notes: '',
  })
  const [doctors, setDoctors] = useState(initialDoctors || [])
  const [loadingDoctors, setLoadingDoctors] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // قيمة افتراضية: العيادة الأساسية إن كانت ضمن المسندة، وإلا أول عيادة مسندة
  useEffect(() => {
    if (isGlobal || form.clinic_id) return
    const ids = (user?.clinicIds?.length ? user.clinicIds : (user?.clinicId ? [user.clinicId] : [])).map(Number)
    const mine = clinics.filter((c) => ids.includes(Number(c.clinic_id)))
    const preferred = mine.find((c) => Number(c.clinic_id) === Number(user?.clinicId)) || mine[0]
    if (preferred) setForm((prev) => ({ ...prev, clinic_id: String(preferred.clinic_id) }))
  }, [isGlobal, form.clinic_id, clinics, user])

  // تحميل الأطباء المسندين للعيادة المختارة فقط (وليس كل الأطباء)
  useEffect(() => {
    const clinicId = form.clinic_id
    if (!clinicId) {
      setDoctors([])
      setLoadingDoctors(false)
      return
    }
    setLoadingDoctors(true)
    api.users.doctors({ clinic_id: Number(clinicId) })
      .then((result) => setDoctors(result.doctors || []))
      .catch(() => setDoctors([]))
      .finally(() => setLoadingDoctors(false))
  }, [form.clinic_id])

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await api.patients.createVisit({
        patient_id: patient.patient_id,
        clinic_id: Number(form.clinic_id) || user?.clinicId,
        doctor_id: Number(form.doctor_id),
        notes: form.notes || undefined,
      })
      onSaved(result?.visit?.visit_id || null)
    } catch (err) {
      setError(err.message || t('patients.addVisit.error'))
    } finally { setSaving(false) }
  }

  return (
    <Modal title={t('patients.addVisit.title', { name: patient.full_name })} subtitle={t('patients.addVisit.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('patients.addVisit.clinicLabel')} required hint={isGlobal ? t('patients.addVisit.globalHint') : myClinics.length > 1 ? t('patients.addVisit.assignedHint') : t('patients.addVisit.currentClinic', { clinic: userClinicLabel || '—' })}>
          {isGlobal ? (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value, doctor_id: '' })}>
              <option value="">{t('patients.addVisit.clinicOption')}</option>
              {clinicsLoading ? <option disabled>{t('patients.loadingClinics')}</option> : null}
              {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          ) : myClinics.length > 1 ? (
            <select required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value, doctor_id: '' })}>
              {myClinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
            </select>
          ) : (
            <input required value={userClinicLabel} readOnly />
          )}
        </Field>
        <Field label={t('patients.addVisit.doctorField')} required hint={loadingDoctors ? t('patients.loadingDoctors') : (doctors.length === 0 ? t('patients.addVisit.noDoctors') : undefined)}>
          {loadingDoctors ? (
            <select disabled><option>{t('patients.loadingDoctors')}</option></select>
          ) : doctors.length > 0 ? (
            <select required value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}>
              <option value="">{t('patients.addVisit.doctorOption')}</option>
              {doctors.map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}{d.sub_specialty ? ` — ${d.sub_specialty}` : ''}</option>)}
            </select>
          ) : (
            <input type="number" required placeholder={t('patients.addVisit.doctorIdPlaceholder')} value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })} />
          )}
        </Field>
        <Field label={t('patients.addVisit.notesField')}><textarea rows="3" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('common.saving') : t('patients.addVisit.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
function MedicalRecordTab({ patient }) {
  const t = useT()
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  const [openPrescriptionId, setOpenPrescriptionId] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.patients.record(patient.patient_id)
      .then((data) => { if (!cancelled) setRecord(data) })
      .catch((err) => setError(err.message || t('patients.record.noPermission')))
    return () => { cancelled = true }
  }, [patient.patient_id])

  if (error) return <Notice kind="error">{error}</Notice>
  if (!record) return <Loading text={t('patients.record.loading')} />

  return (
    <div className="tab-inner record-grid">
      <div className="record-block">
        <h4>{t('patients.record.visitsTitle')}</h4>
        {record.visits?.length === 0 ? <Empty text={t('patients.record.noVisits')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('patients.table.clinic')}</th><th>{t('patients.table.doctor')}</th><th>{t('patients.table.date')}</th><th>{t('patients.table.notes')}</th></tr></thead>
              <tbody>
                {record.visits.map((v) => (
                  <tr key={v.visit_id}>
                    <td>{v.clinic_name || '—'}</td>
                    <td data-label={t('patients.table.doctor')}>{v.doctor_name || '—'}</td>
                    <td data-label={t('patients.table.date')}>{fmtDateTime(v.visit_date)}</td>
                    <td data-label={t('patients.table.notes')}>{v.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="record-block">
        <h4>{t('patients.record.prescriptionsTitle')}</h4>
        {record.prescriptions?.length === 0 ? <Empty text={t('patients.record.prescriptionsEmpty')} /> : (
          <div className="table-wrap table-cards">
            <table>
              <thead><tr><th>{t('patients.table.doctor')}</th><th>{t('patients.table.notes')}</th><th>{t('patients.table.date')}</th><th></th></tr></thead>
              <tbody>
                {record.prescriptions.map((rx) => (
                  <tr key={rx.prescription_id}>
                    <td>{rx.doctor_name || '—'}</td>
                    <td data-label={t('patients.table.notes')}>{rx.notes || '—'}</td>
                    <td data-label={t('patients.table.date')}>{fmtDateTime(rx.created_at)}</td>
                    <td className="cell-actions"><button className="text-button" onClick={() => setOpenPrescriptionId(rx.prescription_id)}>{t('patients.record.viewPrescription')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {openPrescriptionId && <PrescriptionItemsModal prescriptionId={openPrescriptionId} onClose={() => setOpenPrescriptionId(null)} />}
    </div>
  )
}

function SharesTab({ patient }) {
  const t = useT()
  const [shares, setShares] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')
  const [doing, setDoing] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api.patients.listShares(patient.patient_id)
      setShares(result.shares || [])
    } catch (err) { setError(err.message); setShares([]) }
  }, [patient.patient_id])

  useEffect(() => { load() }, [load])

  async function revoke(shareId) {
    if (!window.confirm(t('patients.share.confirmRevoke'))) return
    setDoing(true)
    try {
      await api.patients.revokeShare(patient.patient_id, shareId)
      await load()
    } catch (err) { setError(err.message) } finally { setDoing(false) }
  }

  return (
    <div className="tab-inner">
      <div className="toolbar">
        <button className="primary-button compact" onClick={() => setShowAdd(true)}>{t('patients.shareAddButton')}</button>
      </div>
      <Notice kind="error">{error}</Notice>
      {shares === null ? <Loading /> : shares.length === 0 ? <Empty text={t('patients.share.empty')} /> : (
        <div className="table-wrap table-cards">
          <table>
            <thead><tr><th>{t('patients.share.tableTargetClinic')}</th><th>{t('patients.share.tableAccessLevel')}</th><th>{t('patients.share.tableStatus')}</th><th>{t('patients.share.tableExpiry')}</th><th>{t('patients.share.tableActions')}</th></tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.share_id}>
                  <td data-label={t('patients.share.tableTargetClinic')}>{s.clinic_name || '—'}</td>
                  <td data-label={t('patients.share.tableAccessLevel')}>{s.access_level === 'WRITE' ? t('patients.share.accessWrite') : t('patients.share.accessRead')}</td>
                  <td data-label={t('patients.share.tableStatus')}>{s.status === 'ACTIVE' ? t('patients.share.statusActive') : t('patients.share.statusRevoked')}</td>
                  <td data-label={t('patients.share.tableExpiry')}>{fmtDate(s.expires_at)}</td>
                  <td className="cell-actions">
                    {s.status === 'ACTIVE' ? (
                      <button className="text-button" onClick={() => revoke(s.share_id)} disabled={doing}>{t('patients.share.revokeButton')}</button>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showAdd && <AddShareModal patient={patient} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddShareModal({ patient, onClose, onSaved }) {
  const t = useT()
  const { clinics } = useClinicDirectory(true)
  const [form, setForm] = useState({ target_clinic_id: '', access_level: 'READ', expires_at: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.patients.share(patient.patient_id, {
        target_clinic_id: Number(form.target_clinic_id),
        access_level: form.access_level,
        expires_at: new Date(form.expires_at).toISOString(),
      })
      onSaved()
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <Modal title={t('patients.shareAdd.title')} subtitle={t('patients.shareAdd.subtitle')} onClose={onClose}>
      <form className="patient-form" onSubmit={submit}>
        <Field label={t('patients.shareAdd.targetClinic')} required hint={t('patients.shareAdd.targetClinicHint')}>
          <select required value={form.target_clinic_id} onChange={(e) => setForm({ ...form, target_clinic_id: e.target.value })}>
            <option value="">{t('patients.shareAdd.selectClinic')}</option>
            {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.clinic_name}{c.specialty_name ? ` — ${c.specialty_name}` : ''}</option>)}
          </select>
        </Field>
        <Field label={t('patients.shareAdd.accessLevel')} required>
          <select value={form.access_level} onChange={(e) => setForm({ ...form, access_level: e.target.value })}>
            <option value="READ">{t('patients.share.accessRead')}</option><option value="WRITE">{t('patients.share.accessWrite')}</option>
          </select>
        </Field>
        <Field label={t('patients.shareAdd.expiryDate')} required><input type="date" required value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('common.close')}</button>
          <button className="primary-button" disabled={saving}>{saving ? t('patients.shareAdd.saving') : t('patients.shareAdd.save')}</button>
        </div>
      </form>
    </Modal>
  )
}