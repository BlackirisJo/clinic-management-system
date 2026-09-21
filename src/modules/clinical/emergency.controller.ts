import { Response } from 'express'
import { pool } from '../../config/database'
import { AuthenticatedRequest, accessibleClinicIds, canManageAllClinics } from '../../middlewares/auth.middleware'
import { emergencyReportSchema } from './clinical.validation'

const audit = async (userId: number | undefined, clinicId: number | undefined, action: string, resource: string, resourceId: string | number, metadata?: unknown) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, clinicId ?? null, action, resource, String(resourceId), metadata ? JSON.stringify(metadata) : null]
    )
  } catch { /* audit non-critical */ }
}

const fetchByVisitIds = async (visitIds: number[], query: string): Promise<any[]> => {
  if (visitIds.length === 0) return []
  const result = await pool.query(query, [visitIds])
  return result.rows
}

export const generateEmergencyReport = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, clinic_ids } = emergencyReportSchema.parse(req.body)
  const userId = req.user?.userId
  const currentClinicId = req.user?.clinicId

  const allAuthorized = (canManageAllClinics(req) || req.user?.permissions?.includes('GENERATE_EMERGENCY_REPORT'))
    ? null
    : (accessibleClinicIds(req) ?? [])

  try {
    const patientAccess = await pool.query(
      `SELECT p.patient_id, p.full_name, p.national_id, p.date_of_birth, p.gender, p.phone, p.clinic_id AS owner_clinic_id
       FROM patients p
       WHERE p.patient_id = $1 AND ($2::int[] IS NULL OR p.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares s
         WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($2::int[])
           AND s.status = 'ACTIVE' AND s.expires_at > NOW()
       ))`,
      [patient_id, allAuthorized]
    )
    if (!patientAccess.rowCount) return res.status(404).json({ message: 'المريض غير موجود أو لا تملك صلاحية الوصول' })
    const patient = patientAccess.rows[0]

    const allPatientClinicIds = await pool.query(
      `SELECT DISTINCT v.clinic_id FROM visits v WHERE v.patient_id = $1 ORDER BY v.clinic_id`,
      [patient_id]
    )
    const discoveredClinicIds = allPatientClinicIds.rows
      .map((r) => r.clinic_id)
      .filter((id): id is number => id !== null)

    const pregnancyClinics = await pool.query(
      `SELECT DISTINCT clinic_id FROM pregnancies WHERE patient_id = $1`,
      [patient_id]
    )
    const pregnancyClinicIds = pregnancyClinics.rows
      .map((r) => r.clinic_id)
      .filter((id): id is number => id !== null)

    const currentClinic = await pool.query(
      `SELECT c.clinic_id, c.clinic_name, c.is_active, s.specialty_key, s.name_ar AS specialty_name_ar, s.name_en AS specialty_name_en
       FROM clinics c LEFT JOIN specialties s ON s.specialty_id = c.specialty_id WHERE c.clinic_id = $1`,
      [currentClinicId]
    )

    const requestedIds = Array.isArray(clinic_ids) ? [...new Set(clinic_ids.map(Number))] : []
    if (allAuthorized !== null) {
      for (const id of requestedIds) {
        if (id === currentClinicId) continue
        if (!allAuthorized.includes(id)) {
          return res.status(403).json({ message: 'غير مصرّح' })
        }
      }
    }

    const authorizedAdditional = requestedIds.filter((id) => id !== currentClinicId)
    const allClinicIds = [...new Set([currentClinicId, ...authorizedAdditional, ...discoveredClinicIds, ...pregnancyClinicIds])]

    const medicalProfile = await pool.query(
      `SELECT blood_type, rh_factor, current_medications, medical_notes FROM patient_medical_profiles WHERE patient_id = $1`,
      [patient_id]
    )
    const allergies = await pool.query(
      `SELECT allergen_key, notes FROM patient_allergies WHERE patient_id = $1 ORDER BY allergy_id`,
      [patient_id]
    )
    const chronicConditions = await pool.query(
      `SELECT condition_key, severity, notes FROM patient_chronic_conditions WHERE patient_id = $1 ORDER BY condition_id`,
      [patient_id]
    )

    const pregnancyQuery = allAuthorized === null
      ? `SELECT pregnancy_id, status, outcome, lmp_date, edd_date, gravida, para, risk_level, risk_factors, blood_group, rh_factor, notes FROM pregnancies WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`
      : `SELECT pregnancy_id, status, outcome, lmp_date, edd_date, gravida, para, risk_level, risk_factors, blood_group, rh_factor, notes FROM pregnancies WHERE patient_id = $1 AND clinic_id = ANY($2::int[]) ORDER BY created_at DESC LIMIT 1`
    const pregnancyParams = allAuthorized === null ? [patient_id] : [patient_id, allClinicIds.filter((c): c is number => c !== null)]
    const pregnancy = await pool.query(pregnancyQuery, pregnancyParams)

    let pregnancyData: any = null
    if ((pregnancy.rowCount ?? 0) > 0) {
      pregnancyData = pregnancy.rows[0]
      if (pregnancyData.pregnancy_id) {
        const pv = await pool.query(
          `SELECT pv_id, visit_date, ga_weeks, ga_days, weight_kg, systolic, diastolic, pulse, temperature, fundal_height_cm, fetal_heart_rate, fetal_presentation, symptoms, clinical_examination, diagnosis, treatment_plan, supplements, next_visit_date, risk_level, notes
           FROM pregnancy_visits WHERE pregnancy_id = $1 ORDER BY visit_date DESC`,
          [pregnancyData.pregnancy_id]
        )
        pregnancyData.visits = pv.rows
        const pLabs = await pool.query(
          `SELECT plo.pregnancy_lab_id, plo.test_name, plo.category, plo.status, pcr.analyte, pcr.result_value, pcr.unit, pcr.reference_range, pcr.is_abnormal, pcr.notes
           FROM pregnancy_lab_orders plo LEFT JOIN pregnancy_lab_results pcr ON pcr.pregnancy_lab_id = plo.pregnancy_lab_id
           WHERE plo.pregnancy_id = $1 ORDER BY plo.created_at`,
          [pregnancyData.pregnancy_id]
        )
        pregnancyData.lab_orders = pLabs.rows
        const us = await pool.query(
          `SELECT us_id, exam_date, ga_weeks, ga_days, fetus_count, fetal_presentation, bpd_cm, hc_cm, ac_cm, fl_cm, efw_g, amniotic_fluid_index, placenta_position, findings, impression, report_text
           FROM ultrasound_exams WHERE pregnancy_id = $1 ORDER BY exam_date DESC`,
          [pregnancyData.pregnancy_id]
        )
        pregnancyData.ultrasounds = us.rows
      }
    }

    const clinicsData: Array<{
      clinic: { clinic_id: number; clinic_name: string; is_active: boolean; specialty_key: string | null; specialty_name_ar: string | null; specialty_name_en: string | null }
      visits: any[]
    }> = []

    for (const cid of allClinicIds) {
      if (cid === null) continue
      const clinic = await pool.query(
        `SELECT c.clinic_id, c.clinic_name, c.is_active, s.specialty_key, s.name_ar AS specialty_name_ar, s.name_en AS specialty_name_en
         FROM clinics c LEFT JOIN specialties s ON s.specialty_id = c.specialty_id WHERE c.clinic_id = $1`,
        [cid]
      )
      if (!clinic.rowCount) continue

      const visits = await pool.query(
        `SELECT v.visit_id, v.visit_date, v.visit_status, v.chief_complaint, v.clinical_examination, v.assessment, v.treatment_plan, v.follow_up_plan, v.next_visit_date, v.disposition, v.triage_level,
                u.full_name AS doctor_name, u.clinic_id AS doctor_clinic_id, u.sub_specialty AS doctor_specialty
         FROM visits v
         JOIN users u ON u.user_id = v.doctor_id
          LEFT JOIN specialties sp ON sp.specialty_key = u.sub_specialty
         WHERE v.patient_id = $1 AND v.clinic_id = $2
         ORDER BY v.visit_date ASC, v.visit_id ASC`,
        [patient_id, cid]
      )

      const visitIds = visits.rows.map((v) => v.visit_id)

      const vitals = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT * FROM vital_signs WHERE visit_id = ANY($1) ORDER BY visit_id, recorded_at`)
        : []
      const diagnoses = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT * FROM visit_diagnoses WHERE visit_id = ANY($1) ORDER BY visit_id, diagnosis_id`)
        : []
      const labOrders = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT lo.order_id, lo.visit_id, lo.test_name, lo.category, lo.status, lo.notes, lr.result_id, lr.analyte, lr.result_value, lr.unit, lr.reference_range, lr.is_abnormal, lr.notes AS result_notes FROM lab_orders lo LEFT JOIN lab_results lr ON lr.order_id = lo.order_id WHERE lo.visit_id = ANY($1) ORDER BY lo.order_id, lr.result_id`)
        : []
      const imaging = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT * FROM imaging_orders WHERE visit_id = ANY($1) ORDER BY imaging_id`)
        : []
      const referrals = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT r.referral_id, r.from_clinic_id, r.to_clinic_id, r.to_specialty_id, r.reason, r.notes, r.status, s.name_ar AS to_specialty_ar, s.name_en AS to_specialty_en FROM referrals r LEFT JOIN specialties s ON s.specialty_id = r.to_specialty_id WHERE r.visit_id = ANY($1) ORDER BY r.referral_id`)
        : []
      const prescriptions = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT prescription_id, notes, created_at FROM prescriptions WHERE visit_id = ANY($1) ORDER BY prescription_id`)
        : []
      const attachments = visitIds.length > 0
        ? await fetchByVisitIds(visitIds, `SELECT attachment_id, file_name, kind, mime_type, size_bytes, created_at FROM attachments WHERE visit_id = ANY($1) ORDER BY attachment_id`)
        : []

      const visitsWithData = visits.rows.map((v) => ({
        ...v,
        vitals: vitals.filter((x: any) => x.visit_id === v.visit_id),
        diagnoses: diagnoses.filter((x: any) => x.visit_id === v.visit_id),
        lab_orders: labOrders.filter((x: any) => x.visit_id === v.visit_id),
        imaging: imaging.filter((x: any) => x.visit_id === v.visit_id),
        referrals: referrals.filter((x: any) => x.visit_id === v.visit_id),
        prescriptions: prescriptions.filter((x: any) => x.visit_id === v.visit_id),
        attachments: attachments.filter((x: any) => x.visit_id === v.visit_id),
      }))

      clinicsData.push({ clinic: clinic.rows[0], visits: visitsWithData })
    }

    const creatorUser = await pool.query(
      `SELECT u.full_name, r.role_name, u.sub_specialty FROM users u
       LEFT JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`,
      [userId]
    )

    const report = {
      patient: {
        patient_id: patient.patient_id,
        full_name: patient.full_name,
        national_id: patient.national_id,
        date_of_birth: patient.date_of_birth,
        gender: patient.gender,
        phone: patient.phone,
        owner_clinic_id: patient.owner_clinic_id,
      },
      report_metadata: {
        title: 'Emergency Medical Report',
        generated_by: userId,
        generated_at: new Date().toISOString(),
        generated_by_name: creatorUser.rows[0]?.full_name ?? null,
        generated_by_role: creatorUser.rows[0]?.role_name ?? null,
        generated_by_specialty: creatorUser.rows[0]?.sub_specialty ?? null,
        generated_by_clinic: currentClinic.rows[0]?.clinic_name ?? null,
      },
      patient_medical_profile: medicalProfile.rows[0] ?? null,
      allergies: allergies.rows,
      chronic_conditions: chronicConditions.rows,
      pregnancy: pregnancyData,
      current_clinic: currentClinic.rows[0] ?? null,
      included_clinics: clinicsData,
    }

    await audit(userId, currentClinicId ?? undefined, 'EMERGENCY_REPORT_GENERATED', 'EMERGENCY_REPORT', patient_id, {
      included_clinic_ids: allClinicIds,
    })

    return res.status(200).json(report)
  } catch (error) {
    console.error('Emergency Report Error:', error)
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء تقرير الطوارئ' })
  }
}
