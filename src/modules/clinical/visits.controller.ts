import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds, canManageAllClinics } from '../../middlewares/auth.middleware';

// ===== أدوات مساعدة مشتركة =====

// التحقق من وصول المستخدم للزيارة عبر عياداته المسندة (أو صلاحية الإدارة)
const getVisitContext = async (req: AuthenticatedRequest, visitId: string) => {
  const result = await pool.query(
    `SELECT v.*, p.full_name AS patient_name, p.patient_id AS ctx_patient_id,
            c.clinic_name, c.clinic_id AS ctx_clinic_id, s.specialty_key, s.name_ar AS specialty_name,
            d.full_name AS doctor_name
     FROM visits v
     JOIN patients p ON p.patient_id = v.patient_id
     JOIN clinics c ON c.clinic_id = v.clinic_id
     LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
     JOIN users d ON d.user_id = v.doctor_id
     WHERE v.visit_id = $1`,
    [visitId]
  );
  if (!result.rowCount) return null;
  const visit = result.rows[0];
  const allowed = canManageAllClinics(req) || (accessibleClinicIds(req) ?? []).includes(Number(visit.clinic_id));
  return allowed ? visit : null;
};

const audit = async (userId: number | undefined, clinicId: number | undefined, action: string, resource: string, resourceId: string | number, metadata?: unknown) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, clinicId ?? null, action, resource, String(resourceId), metadata ? JSON.stringify(metadata) : null]
    );
  } catch { /* تدقيق غير حرج */ }
};

export const requireVisitAccess = async (req: AuthenticatedRequest, res: Response, visitId: string | string[] | undefined) => {
  const id = Array.isArray(visitId) ? visitId[0] : visitId;
  const visit = await getVisitContext(req, id ?? '');
  if (!visit) {
    res.status(404).json({ message: 'الزيارة غير موجودة أو لا تملك صلاحية الوصول إليها' });
    return null;
  }
  return visit;
};

// ===== 1) تفاصيل الزيارة الكاملة (جميع البيانات السريرية) =====
export const getVisitDetails = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const visitId = req.params.visitId;
  try {
    const [vitals, diagnoses, labOrders, imaging, referrals, attachments, pregnancyVisits] = await Promise.all([
      pool.query(
        `SELECT vs.*, u.full_name AS recorded_by_name FROM vital_signs vs
         LEFT JOIN users u ON u.user_id = vs.recorded_by
         WHERE vs.visit_id = $1 ORDER BY vs.recorded_at DESC`,
        [visitId]
      ),
      pool.query(
        `SELECT vd.*, u.full_name AS created_by_name FROM visit_diagnoses vd
         LEFT JOIN users u ON u.user_id = vd.created_by
         WHERE vd.visit_id = $1 ORDER BY CASE vd.diagnosis_type WHEN 'PRIMARY' THEN 1 ELSE 2 END, vd.diagnosis_id`,
        [visitId]
      ),
      pool.query(
        `SELECT lo.*, u.full_name AS ordered_by_name,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                     'result_id', lr.result_id, 'analyte', lr.analyte, 'result_value', lr.result_value,
                     'unit', lr.unit, 'reference_range', lr.reference_range, 'is_abnormal', lr.is_abnormal,
                     'notes', lr.notes, 'resulted_at', lr.resulted_at
                   ) ORDER BY lr.result_id)
                   FROM lab_results lr WHERE lr.order_id = lo.order_id), '[]'::json
                ) AS results
         FROM lab_orders lo LEFT JOIN users u ON u.user_id = lo.ordered_by
         WHERE lo.visit_id = $1 ORDER BY lo.created_at DESC`,
        [visitId]
      ),
      pool.query(
        `SELECT io.*, ou.full_name AS ordered_by_name, pu.full_name AS performed_by_name
         FROM imaging_orders io
         LEFT JOIN users ou ON ou.user_id = io.ordered_by
         LEFT JOIN users pu ON pu.user_id = io.performed_by
         WHERE io.visit_id = $1 ORDER BY io.created_at DESC`,
        [visitId]
      ),
      pool.query(
        `SELECT rf.*, tc.clinic_name AS to_clinic_name, sp.name_ar AS to_specialty_name
         FROM referrals rf
         LEFT JOIN clinics tc ON tc.clinic_id = rf.to_clinic_id
         LEFT JOIN specialties sp ON sp.specialty_id = rf.to_specialty_id
         WHERE rf.visit_id = $1 ORDER BY rf.created_at DESC`,
        [visitId]
      ),
      pool.query(
        `SELECT a.attachment_id, a.patient_id, a.visit_id, a.kind, a.file_name, a.mime_type, a.size_bytes, a.created_at,
                u.full_name AS uploaded_by_name
         FROM attachments a LEFT JOIN users u ON u.user_id = a.uploaded_by
         WHERE a.visit_id = $1 ORDER BY a.created_at DESC`,
        [visitId]
      ),
      pool.query(
        `SELECT pv.pv_id, pv.pregnancy_id, pv.visit_date, pv.ga_weeks, pv.ga_days
         FROM pregnancy_visits pv WHERE pv.visit_id = $1`,
        [visitId]
      ),
    ]);

    return res.status(200).json({
      visit,
      vitals: vitals.rows,
      diagnoses: diagnoses.rows,
      lab_orders: labOrders.rows,
      imaging: imaging.rows,
      referrals: referrals.rows,
      attachments: attachments.rows,
      pregnancy_visits: pregnancyVisits.rows,
    });
  } catch (error) {
    console.error('Get Visit Details Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع بيانات الزيارة' });
  }
};

// ===== 2) تحديث البيانات السريرية للزيارة (الشكوى، الفحص، التقييم، الخطة...) =====
export const updateVisitClinical = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { chief_complaint, clinical_examination, assessment, treatment_plan, follow_up_plan, next_visit_date, disposition, triage_level, visit_status } = req.body;
  try {
    const params: unknown[] = [];
    const sets: string[] = [];
    const push = (value: unknown, column: string) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (chief_complaint !== undefined) push(chief_complaint, 'chief_complaint');
    if (clinical_examination !== undefined) push(clinical_examination, 'clinical_examination');
    if (assessment !== undefined) push(assessment, 'assessment');
    if (treatment_plan !== undefined) push(treatment_plan, 'treatment_plan');
    if (follow_up_plan !== undefined) push(follow_up_plan, 'follow_up_plan');
    if (next_visit_date !== undefined) push(next_visit_date ? new Date(next_visit_date).toISOString() : null, 'next_visit_date');
    if (disposition !== undefined) push(disposition, 'disposition');
    if (triage_level !== undefined) push(triage_level, 'triage_level');
    if (visit_status !== undefined) push(visit_status, 'visit_status');
    if (!sets.length) return res.status(400).json({ message: 'لا توجد بيانات للتحديث' });
    params.push(visit.visit_id);
    const result = await pool.query(
      `UPDATE visits SET ${sets.join(', ')} WHERE visit_id = $${params.length} RETURNING *`,
      params
    );
    await audit(req.user?.userId, visit.clinic_id, 'VISIT_CLINICAL_UPDATED', 'VISIT', visit.visit_id);
    return res.status(200).json({ message: 'تم حفظ البيانات السريرية', visit: result.rows[0] });
  } catch (error) {
    console.error('Update Visit Clinical Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند حفظ البيانات السريرية' });
  }
};

// ===== 3) العلامات الحيوية =====
export const addVitalSign = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { weight_kg, height_cm, systolic, diastolic, pulse, temperature, respiratory_rate, spo2, pain_score, notes } = req.body;
  // تحقق منطقي قبل الوصول لقاعدة البيانات: ضغط منعكس (انقباضي < انبساطي) خطأ من العميل وليس خطأ خادم
  if (systolic !== undefined && systolic !== null && diastolic !== undefined && diastolic !== null && Number(systolic) < Number(diastolic)) {
    return res.status(400).json({ message: 'الضغط الانقباضي يجب أن يكون أكبر من أو يساوي الانبساطي' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO vital_signs (visit_id, weight_kg, height_cm, systolic, diastolic, pulse, temperature, respiratory_rate, spo2, pain_score, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [visit.visit_id, weight_kg ?? null, height_cm ?? null, systolic ?? null, diastolic ?? null, pulse ?? null, temperature ?? null, respiratory_rate ?? null, spo2 ?? null, pain_score ?? null, notes ?? null, req.user?.userId]
    );
    await audit(req.user?.userId, visit.clinic_id, 'VITAL_SIGNS_RECORDED', 'VISIT', visit.visit_id);
    return res.status(201).json({ message: 'تم تسجيل العلامات الحيوية', vital: result.rows[0] });
  } catch (error) {
    console.error('Add Vital Sign Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تسجيل العلامات الحيوية' });
  }
};

export const deleteVitalSign = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  try {
    const result = await pool.query(
      'DELETE FROM vital_signs WHERE vital_id = $1 AND visit_id = $2 RETURNING vital_id',
      [req.params.vitalId, visit.visit_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'القياس غير موجود' });
    return res.status(200).json({ message: 'تم حذف القياس' });
  } catch (error) {
    console.error('Delete Vital Sign Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند حذف القياس' });
  }
};

// ===== 4) التشخيصات =====
export const addDiagnosis = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { description, icd_code, diagnosis_type } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO visit_diagnoses (visit_id, icd_code, description, diagnosis_type, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [visit.visit_id, icd_code ?? null, description, diagnosis_type, req.user?.userId]
    );
    await audit(req.user?.userId, visit.clinic_id, 'DIAGNOSIS_ADDED', 'VISIT', visit.visit_id);
    return res.status(201).json({ message: 'تمت إضافة التشخيص', diagnosis: result.rows[0] });
  } catch (error) {
    console.error('Add Diagnosis Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إضافة التشخيص' });
  }
};

export const deleteDiagnosis = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  try {
    const result = await pool.query(
      'DELETE FROM visit_diagnoses WHERE diagnosis_id = $1 AND visit_id = $2 RETURNING diagnosis_id',
      [req.params.diagnosisId, visit.visit_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'التشخيص غير موجود' });
    return res.status(200).json({ message: 'تم حذف التشخيص' });
  } catch (error) {
    console.error('Delete Diagnosis Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند حذف التشخيص' });
  }
};

// ===== 5) طلبات المختبر ونتائجها =====
export const createLabOrder = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { test_name, category, priority, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO lab_orders (visit_id, test_name, category, priority, notes, ordered_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [visit.visit_id, test_name, category ?? null, priority, notes ?? null, req.user?.userId]
    );
    await audit(req.user?.userId, visit.clinic_id, 'LAB_ORDER_CREATED', 'VISIT', visit.visit_id);
    return res.status(201).json({ message: 'تم إنشاء طلب الفحص المخبري', order: result.rows[0] });
  } catch (error) {
    console.error('Create Lab Order Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إنشاء طلب الفحص' });
  }
};

export const updateLabOrder = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { status, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE lab_orders SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
       WHERE order_id = $3 AND visit_id = $4 RETURNING *`,
      [status, notes ?? null, req.params.orderId, visit.visit_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'طلب الفحص غير موجود' });
    return res.status(200).json({ message: 'تم تحديث طلب الفحص', order: result.rows[0] });
  } catch (error) {
    console.error('Update Lab Order Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تحديث طلب الفحص' });
  }
};

// حفظ النتائج: تستبدل نتائج الطلب بالكامل في معاملة واحدة
export const saveLabResults = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { results } = req.body;
  const client = await pool.connect();
  try {
    const order = await client.query(
      'SELECT order_id FROM lab_orders WHERE order_id = $1 AND visit_id = $2',
      [req.params.orderId, visit.visit_id]
    );
    if (!order.rowCount) {
      client.release();
      return res.status(404).json({ message: 'طلب الفحص غير موجود' });
    }
    await client.query('BEGIN');
    await client.query('DELETE FROM lab_results WHERE order_id = $1', [order.rows[0].order_id]);
    for (const r of results) {
      await client.query(
        `INSERT INTO lab_results (order_id, analyte, result_value, unit, reference_range, is_abnormal, notes, resulted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [order.rows[0].order_id, r.analyte, r.result_value ?? null, r.unit ?? null, r.reference_range ?? null, r.is_abnormal ?? false, r.notes ?? null, req.user?.userId]
      );
    }
    await client.query(`UPDATE lab_orders SET status = 'COMPLETED', updated_at = NOW() WHERE order_id = $1`, [order.rows[0].order_id]);
    await client.query('COMMIT');
    await audit(req.user?.userId, visit.clinic_id, 'LAB_RESULTS_SAVED', 'LAB_ORDER', order.rows[0].order_id);
    const saved = await pool.query('SELECT * FROM lab_results WHERE order_id = $1 ORDER BY result_id', [order.rows[0].order_id]);
    return res.status(200).json({ message: 'تم حفظ النتائج', results: saved.rows });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* الجلسة مغلقة */ }
    console.error('Save Lab Results Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند حفظ النتائج' });
  } finally {
    client.release();
  }
};

// ===== 6) التصوير والفحوصات التشخيصية =====
export const createImaging = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { modality, body_part, findings, impression, status } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO imaging_orders (visit_id, modality, body_part, findings, impression, status, ordered_by, performed_by, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [visit.visit_id, modality, body_part ?? null, findings ?? null, impression ?? null, status ?? 'ORDERED',
       req.user?.userId, status === 'COMPLETED' ? req.user?.userId : null,
       status === 'COMPLETED' ? new Date().toISOString() : null]
    );
    await audit(req.user?.userId, visit.clinic_id, 'IMAGING_ORDER_CREATED', 'VISIT', visit.visit_id, { modality });
    return res.status(201).json({ message: 'تم إنشاء طلب التصوير', imaging: result.rows[0] });
  } catch (error) {
    console.error('Create Imaging Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إنشاء طلب التصوير' });
  }
};

export const updateImaging = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { modality, body_part, findings, impression, status } = req.body;
  try {
    const params: unknown[] = [];
    const sets: string[] = [];
    const push = (value: unknown, column: string) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (modality !== undefined) push(modality, 'modality');
    if (body_part !== undefined) push(body_part, 'body_part');
    if (findings !== undefined) push(findings, 'findings');
    if (impression !== undefined) push(impression, 'impression');
    if (status !== undefined) {
      push(status, 'status');
      if (status === 'COMPLETED') {
        params.push(req.user?.userId ?? null);
        sets.push(`performed_by = $${params.length}`);
        params.push(new Date().toISOString());
        sets.push(`completed_at = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ message: 'لا توجد بيانات للتحديث' });
    params.push(req.params.imagingId);
    params.push(visit.visit_id);
    const result = await pool.query(
      `UPDATE imaging_orders SET ${sets.join(', ')} WHERE imaging_id = $${params.length - 1} AND visit_id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rowCount) return res.status(404).json({ message: 'طلب التصوير غير موجود' });
    return res.status(200).json({ message: 'تم تحديث طلب التصوير', imaging: result.rows[0] });
  } catch (error) {
    console.error('Update Imaging Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تحديث طلب التصوير' });
  }
};

// ===== 7) الإحالات =====
export const createReferral = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const { reason, to_clinic_id, to_specialty_id, notes } = req.body;
  try {
    if (to_clinic_id) {
      const target = await pool.query('SELECT 1 FROM clinics WHERE clinic_id = $1', [to_clinic_id]);
      if (!target.rowCount) return res.status(400).json({ message: 'العيادة المستهدفة غير موجودة' });
    }
    if (to_specialty_id) {
      const target = await pool.query('SELECT 1 FROM specialties WHERE specialty_id = $1', [to_specialty_id]);
      if (!target.rowCount) return res.status(400).json({ message: 'التخصص المستهدف غير موجود' });
    }
    const result = await pool.query(
      `INSERT INTO referrals (visit_id, patient_id, from_clinic_id, to_clinic_id, to_specialty_id, reason, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [visit.visit_id, visit.patient_id, visit.clinic_id, to_clinic_id ?? null, to_specialty_id ?? null, reason, notes ?? null, req.user?.userId]
    );
    await audit(req.user?.userId, visit.clinic_id, 'REFERRAL_CREATED', 'VISIT', visit.visit_id);
    return res.status(201).json({ message: 'تم إنشاء الإحالة', referral: result.rows[0] });
  } catch (error) {
    console.error('Create Referral Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إنشاء الإحالة' });
  }
};

// ===== 8) المرفقات (صور/تقارير/ملفات) =====
export const uploadAttachment = async (req: AuthenticatedRequest, res: Response) => {
  const visit = await requireVisitAccess(req, res, req.params.visitId);
  if (!visit) return;
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'لم يتم رفع أي ملف' });
  // أنواع المرفقات المسموحة حصراً — تُرفض القيم العشوائية
  const ALLOWED_KINDS = new Set(['DOCUMENT', 'IMAGE', 'ULTRASOUND', 'LAB_REPORT', 'PRESCRIPTION', 'REFERRAL', 'OTHER']);
  const rawKind = typeof req.body?.kind === 'string' ? req.body.kind.trim().toUpperCase() : 'DOCUMENT';
  const kind = ALLOWED_KINDS.has(rawKind) ? rawKind : 'DOCUMENT';
  const pregnancyId = req.body?.pregnancy_id ? Number(req.body.pregnancy_id) : null;
  const ultrasoundId = req.body?.ultrasound_id ? Number(req.body.ultrasound_id) : null;
  // تعقيم اسم العرض المخزّن (منع تكوين مسار خبيث عند العرض/التنزيل)
  const safeFileName = (file.originalname || 'attachment').replace(/[\\/]/g, '_').replace(/["\u0000\r\n]/g, '').slice(0, 200);
  try {
    // أمن وسلامة البيانات: سجل الحمل (إن حُدّد) يجب أن يعود لنفس مريضة هذه الزيارة تماماً،
    // وفحص السونار (إن حُدّد) يجب أن يعود لنفس سجل الحمل — حتى لا يُربط مرفق بسجلات عيادة/مريض آخر.
    if (pregnancyId) {
      const pregnancyCheck = await pool.query(
        'SELECT 1 FROM pregnancies WHERE pregnancy_id = $1 AND patient_id = $2',
        [pregnancyId, visit.patient_id]
      );
      if (!pregnancyCheck.rowCount) {
        return res.status(400).json({ message: 'سجل الحمل المحدد غير موجود لهذه المريضة' });
      }
      if (ultrasoundId) {
        const ultrasoundCheck = await pool.query(
          `SELECT 1 FROM ultrasound_exams us
           JOIN pregnancies pr ON pr.pregnancy_id = us.pregnancy_id
           WHERE us.us_id = $1 AND pr.patient_id = $2`,
          [ultrasoundId, visit.patient_id]
        );
        if (!ultrasoundCheck.rowCount) {
          return res.status(400).json({ message: 'فحص السونار المحدد غير موجود لهذه المريضة' });
        }
      }
    } else if (ultrasoundId) {
      const ultrasoundCheck = await pool.query(
        `SELECT 1 FROM ultrasound_exams us
         JOIN pregnancies pr ON pr.pregnancy_id = us.pregnancy_id
         WHERE us.us_id = $1 AND pr.patient_id = $2`,
        [ultrasoundId, visit.patient_id]
      );
      if (!ultrasoundCheck.rowCount) {
        return res.status(400).json({ message: 'فحص السونار المحدد غير موجود لهذه المريضة' });
      }
    }
    const result = await pool.query(
      `INSERT INTO attachments (patient_id, visit_id, pregnancy_id, ultrasound_id, kind, file_name, file_path, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING attachment_id, patient_id, visit_id, pregnancy_id, ultrasound_id, kind, file_name, mime_type, size_bytes, created_at`,
      [visit.patient_id, visit.visit_id, pregnancyId, ultrasoundId, kind, safeFileName, file.path, file.mimetype, file.size, req.user?.userId]
    );
    await audit(req.user?.userId, visit.clinic_id, 'ATTACHMENT_UPLOADED', 'VISIT', visit.visit_id, { kind });
    return res.status(201).json({ message: 'تم رفع المرفق', attachment: result.rows[0] });
  } catch (error) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error('Upload Attachment Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند رفع المرفق' });
  }
};

export const downloadAttachment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT a.file_path, a.file_name, a.mime_type, v.clinic_id
       FROM attachments a
       LEFT JOIN visits v ON v.visit_id = a.visit_id
       WHERE a.attachment_id = $1`,
      [req.params.attachmentId]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'المرفق غير موجود' });
    const row = result.rows[0];
    // التحقق من الوصول: عبر عيادة الزيارة، أو عبر كون المستخدم مسنداً لعيادة المريض
    let allowed = canManageAllClinics(req);
    if (!allowed) {
      if (row.clinic_id && (accessibleClinicIds(req) ?? []).includes(Number(row.clinic_id))) {
        allowed = true;
      } else if (!row.clinic_id) {
        const patientClinic = await pool.query('SELECT clinic_id FROM patients WHERE patient_id = (SELECT patient_id FROM attachments WHERE attachment_id = $1)', [req.params.attachmentId]);
        allowed = Boolean(patientClinic.rowCount) && (accessibleClinicIds(req) ?? []).includes(Number(patientClinic.rows[0]?.clinic_id));
      }
    }
    if (!allowed) return res.status(404).json({ message: 'المرفق غير موجود أو لا تملك صلاحية الوصول إليه' });
    if (!fs.existsSync(row.file_path)) return res.status(404).json({ message: 'ملف المرفق غير موجود على الخادم' });
    // ملاحظة: res.sendFile حُذفت من Express 5، لذا نستخدم res.download الآمنة رسمياً.
    const safeFileName = (row.file_name || 'attachment').replace(/[\\/]/g, '_').replace(/["\r\n]/g, '');
    return res.download(path.resolve(row.file_path), encodeURIComponent(safeFileName));
  } catch (error) {
    console.error('Download Attachment Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تنزيل المرفق' });
  }
};

export const deleteAttachment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT a.attachment_id, a.file_path, v.clinic_id
       FROM attachments a
       LEFT JOIN visits v ON v.visit_id = a.visit_id
       WHERE a.attachment_id = $1`,
      [req.params.attachmentId]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'المرفق غير موجود' });
    const row = result.rows[0];
    const allowed = canManageAllClinics(req) || (row.clinic_id && (accessibleClinicIds(req) ?? []).includes(Number(row.clinic_id)));
    if (!allowed) return res.status(404).json({ message: 'المرفق غير موجود أو لا تملك صلاحية حذفه' });
    await pool.query('DELETE FROM attachments WHERE attachment_id = $1', [req.params.attachmentId]);
    if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
    return res.status(200).json({ message: 'تم حذف المرفق' });
  } catch (error) {
    console.error('Delete Attachment Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند حذف المرفق' });
  }
};