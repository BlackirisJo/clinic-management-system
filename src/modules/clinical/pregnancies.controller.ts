import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds, canManageAllClinics } from '../../middlewares/auth.middleware';

// ===== أدوات مساعدة =====
const audit = async (userId: number | undefined, clinicId: number | undefined, action: string, resource: string, resourceId: string | number, metadata?: unknown) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, clinicId ?? null, action, resource, String(resourceId), metadata ? JSON.stringify(metadata) : null]
    );
  } catch { /* تدقيق غير حرج */ }
};

// التحقق من وصول المستخدم لسجل الحمل عبر عياداته المسندة
export const requirePregnancyAccess = async (req: AuthenticatedRequest, res: Response, pregnancyId: string | string[] | number | undefined) => {
  const id = Array.isArray(pregnancyId) ? pregnancyId[0] : pregnancyId;
  const result = await pool.query(
    `SELECT pr.*, p.full_name AS patient_name, p.date_of_birth, p.gender, c.clinic_name, c.specialty_id,
            s.specialty_key, s.name_ar AS specialty_name
     FROM pregnancies pr
     JOIN patients p ON p.patient_id = pr.patient_id
     JOIN clinics c ON c.clinic_id = pr.clinic_id
     LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
     WHERE pr.pregnancy_id = $1`,
    [id]
  );
  if (!result.rowCount) {
    res.status(404).json({ message: 'سجل الحمل غير موجود' });
    return null;
  }
  const pregnancy = result.rows[0];
  const allowed = canManageAllClinics(req) || (accessibleClinicIds(req) ?? []).includes(Number(pregnancy.clinic_id));
  if (!allowed) {
    res.status(404).json({ message: 'سجل الحمل غير موجود أو لا تملك صلاحية الوصول إليه' });
    return null;
  }
  return pregnancy;
};

// التحقق من صلاحية الكتابة (طبيب/ممرضة مسندون لعيادة الحمل مع صلاحية MANAGE_PREGNANCY)
const requirePregnancyWrite = async (req: AuthenticatedRequest, res: Response, pregnancyId: string | string[] | number | undefined) => {
  const pregnancy = await requirePregnancyAccess(req, res, pregnancyId);
  if (!pregnancy) return null;
  const hasPermission = canManageAllClinics(req) || (req.user?.permissions ?? []).includes('MANAGE_PREGNANCY');
  if (!hasPermission) {
    res.status(403).json({ message: 'لا تملك صلاحية إدارة سجلات الحمل' });
    return null;
  }
  return pregnancy;
};

// حساب الأسبوع والأيام الحملية من تاريخ آخر دورة
const computeGestationalAge = (lmpDate: string | null) => {
  if (!lmpDate) return null;
  const lmp = new Date(lmpDate);
  const diffMs = Date.now() - lmp.getTime();
  const totalDays = Math.floor(diffMs / 86400000);
  if (totalDays < 0 || totalDays > 320) return null;
  return { weeks: Math.floor(totalDays / 7), days: totalDays % 7 };
};

// ===== 1) قائمة سجلات حمل مريضة (أو كل سجلات عيادات المستخدم) =====
export const listPregnancies = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = req.query.patient_id ? Number(req.query.patient_id) : null;
    const params: unknown[] = [];
    let where = 'TRUE';
    if (patientId) {
      // أمن: حتى عند الاستعلام بمريض محدد، يجب أن يبقى نطاق العيادات مفروضاً في الخادم.
      // المستخدم لا يمكنه رؤية سجلات حمل مريضة من خارج عياداته (إلا عبر مشاركة نشطة)،
      // أو إذا كان مديراً شاملاً (canManageAllClinics).
      params.push(patientId);
      where = `pr.patient_id = $${params.length}`;
      if (!canManageAllClinics(req)) {
        const ids = accessibleClinicIds(req) ?? [];
        if (!ids.length) return res.status(200).json({ pregnancies: [] });
        params.push(ids);
        // المريضة يجب أن تنتمي لإحدى عيادات المستخدم أو تكون مشارَكةً إليها بنشاط
        where += ` AND (p.clinic_id = ANY($${params.length}::int[]) OR EXISTS (
          SELECT 1 FROM patient_clinic_shares s
          WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($${params.length}::int[])
            AND s.status = 'ACTIVE' AND s.expires_at > NOW()
        ))`;
      }
    } else if (!canManageAllClinics(req)) {
      const ids = accessibleClinicIds(req) ?? [];
      if (!ids.length) return res.status(200).json({ pregnancies: [] });
      params.push(ids);
      where = `pr.clinic_id = ANY($${params.length}::int[])`;
    }
    const result = await pool.query(
      `SELECT pr.*, p.full_name AS patient_name, c.clinic_name,
              (SELECT COUNT(*)::int FROM pregnancy_visits pv WHERE pv.pregnancy_id = pr.pregnancy_id) AS visits_count,
              (SELECT COUNT(*)::int FROM ultrasound_exams us WHERE us.pregnancy_id = pr.pregnancy_id) AS ultrasound_count,
              (SELECT json_build_object('pv_id', pv.pv_id, 'visit_date', pv.visit_date, 'ga_weeks', pv.ga_weeks, 'ga_days', pv.ga_days, 'next_visit_date', pv.next_visit_date)
               FROM pregnancy_visits pv WHERE pv.pregnancy_id = pr.pregnancy_id ORDER BY pv.visit_date DESC LIMIT 1) AS last_pregnancy_visit
       FROM pregnancies pr
       JOIN patients p ON p.patient_id = pr.patient_id
       JOIN clinics c ON c.clinic_id = pr.clinic_id
       WHERE ${where}
       ORDER BY pr.status ASC, pr.created_at DESC`,
      params
    );
    const pregnancies = result.rows.map((row) => ({
      ...row,
      current_gestational_age: row.status === 'ACTIVE' ? computeGestationalAge(row.lmp_date) : null,
    }));
    return res.status(200).json({ pregnancies });
  } catch (error) {
    console.error('List Pregnancies Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند استرجاع سجلات الحمل' });
  }
};

// ===== 2) تفاصيل سجل حمل + الخط الزمني (Timeline) =====
export const getPregnancyDetails = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyAccess(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  try {
    const [visits, ultrasounds, attachments] = await Promise.all([
      pool.query(
        `SELECT pv.*, u.full_name AS recorded_by_name,
                v.visit_id AS linked_visit_id, v.chief_complaint AS linked_visit_complaint
         FROM pregnancy_visits pv
         LEFT JOIN users u ON u.user_id = pv.recorded_by
         LEFT JOIN visits v ON v.visit_id = pv.visit_id
         WHERE pv.pregnancy_id = $1
         ORDER BY pv.visit_date ASC`,
        [pregnancy.pregnancy_id]
      ),
      pool.query(
        `SELECT us.*, u.full_name AS performed_by_name,
                (SELECT json_agg(json_build_object('attachment_id', a.attachment_id, 'file_name', a.file_name, 'kind', a.kind, 'created_at', a.created_at))
                 FROM attachments a WHERE a.ultrasound_id = us.us_id) AS attachments
         FROM ultrasound_exams us
         LEFT JOIN users u ON u.user_id = us.performed_by
         WHERE us.pregnancy_id = $1
         ORDER BY us.exam_date ASC`,
        [pregnancy.pregnancy_id]
      ),
      pool.query(
        `SELECT a.attachment_id, a.visit_id, a.ultrasound_id, a.kind, a.file_name, a.mime_type, a.size_bytes, a.created_at,
                u.full_name AS uploaded_by_name
         FROM attachments a LEFT JOIN users u ON u.user_id = a.uploaded_by
         WHERE a.pregnancy_id = $1
         ORDER BY a.created_at DESC`,
        [pregnancy.pregnancy_id]
      ),
    ]);
    const pregnancyWithGA = {
      ...pregnancy,
      current_gestational_age: pregnancy.status === 'ACTIVE' ? computeGestationalAge(pregnancy.lmp_date) : null,
    };
    return res.status(200).json({
      pregnancy: pregnancyWithGA,
      pregnancy_visits: visits.rows,
      ultrasounds: ultrasounds.rows,
      attachments: attachments.rows,
    });
  } catch (error) {
    console.error('Get Pregnancy Details Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند استرجاع تفاصيل الحمل' });
  }
};

// ===== 3) إنشاء سجل حمل جديد =====
export const createPregnancy = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, clinic_id, lmp_date, edd_date, gravida, para, abortions, living_children, previous_pregnancies, blood_group, rh_factor, risk_level, risk_factors, notes } = req.body;
  const targetClinicId = canManageAllClinics(req) && clinic_id ? Number(clinic_id) : req.user?.clinicId;
  if (!patient_id || !targetClinicId) {
    return res.status(400).json({ message: 'المريضة والعيادة مطلوبان' });
  }
  try {
    const patient = await pool.query('SELECT patient_id, gender, clinic_id FROM patients WHERE patient_id = $1', [patient_id]);
    if (!patient.rowCount) return res.status(404).json({ message: 'المريضة غير موجودة' });
    if (patient.rows[0].gender !== 'FEMALE') {
      return res.status(400).json({ message: 'سجل الحمل متاح للمرضى من الإناث فقط' });
    }
    const allowedClinics = accessibleClinicIds(req) ?? [];
    if (!canManageAllClinics(req) && !allowedClinics.includes(Number(targetClinicId))) {
      return res.status(403).json({ message: 'لا يمكنك إنشاء سجل حمل في عيادة غير مسندة لك' });
    }
    // يمكن إنشاء الحمل لعيادة المريض أو لعيادة مسندة للمستخدم (عبر مشاركة السجل)
    const active = await pool.query(
      `SELECT pregnancy_id FROM pregnancies WHERE patient_id = $1 AND status = 'ACTIVE'`,
      [patient_id]
    );
    if (active.rowCount) {
      return res.status(409).json({ message: 'توجد حمل نشط لهذه المريضة بالفعل', pregnancy_id: active.rows[0].pregnancy_id });
    }
    // حساب EDD تلقائياً = LMP + 280 يوماً إذا لم يُدخل يدوياً
    let finalEdd = edd_date ?? null;
    if (!finalEdd && lmp_date) {
      const lmp = new Date(lmp_date);
      lmp.setDate(lmp.getDate() + 280);
      finalEdd = lmp.toISOString().slice(0, 10);
    }
    const result = await pool.query(
      `INSERT INTO pregnancies (patient_id, clinic_id, lmp_date, edd_date, gravida, para, abortions, living_children,
          previous_pregnancies, blood_group, rh_factor, risk_level, risk_factors, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [patient_id, targetClinicId, lmp_date ?? null, finalEdd, gravida ?? 1, para ?? 0, abortions ?? 0, living_children ?? 0,
       previous_pregnancies ?? null, blood_group ?? null, rh_factor ?? null, risk_level ?? 'NORMAL', risk_factors ?? null, notes ?? null, req.user?.userId]
    );
    await audit(req.user?.userId, targetClinicId, 'PREGNANCY_CREATED', 'PREGNANCY', result.rows[0].pregnancy_id);
    return res.status(201).json({ message: 'تم إنشاء سجل الحمل', pregnancy: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ message: 'توجد حمل نشط لهذه المريضة بالفعل' });
    console.error('Create Pregnancy Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إنشاء سجل الحمل' });
  }
};

// ===== 4) تحديث سجل الحمل (بما فيه إغلاقه عند الولادة) =====
export const updatePregnancy = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  const body = req.body;
  try {
    const params: unknown[] = [];
    const sets: string[] = [];
    const push = (value: unknown, column: string) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    const textFields: [string, unknown][] = [
      ['lmp_date', body.lmp_date], ['edd_date', body.edd_date], ['previous_pregnancies', body.previous_pregnancies],
      ['blood_group', body.blood_group], ['rh_factor', body.rh_factor], ['risk_level', body.risk_level],
      ['risk_factors', body.risk_factors], ['notes', body.notes], ['delivery_date', body.delivery_date],
      ['delivery_method', body.delivery_method], ['delivery_notes', body.delivery_notes],
    ];
    for (const [column, value] of textFields) {
      if (value !== undefined) push(value === null ? null : value, column);
    }
    for (const column of ['gravida', 'para', 'abortions', 'living_children'] as const) {
      if (body[column] !== undefined) push(body[column], column);
    }
    if (body.status !== undefined) {
      push(body.status, 'status');
      if (body.status === 'COMPLETED') {
        push(body.outcome ?? 'LIVE_BIRTH', 'outcome');
        params.push(new Date().toISOString());
        sets.push(`closed_at = $${params.length}`);
      } else {
        push('ONGOING', 'outcome');
        params.push(null);
        sets.push(`closed_at = $${params.length}`);
      }
    } else if (body.outcome !== undefined) {
      push(body.outcome, 'outcome');
    }
    if (!sets.length) return res.status(400).json({ message: 'لا توجد بيانات للتحديث' });
    params.push(pregnancy.pregnancy_id);
    const result = await pool.query(
      `UPDATE pregnancies SET ${sets.join(', ')}, updated_at = NOW() WHERE pregnancy_id = $${params.length} RETURNING *`,
      params
    );
    await audit(req.user?.userId, pregnancy.clinic_id, 'PREGNANCY_UPDATED', 'PREGNANCY', pregnancy.pregnancy_id);
    return res.status(200).json({ message: 'تم تحديث سجل الحمل', pregnancy: result.rows[0] });
  } catch (error) {
    console.error('Update Pregnancy Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تحديث سجل الحمل' });
  }
};

// ===== 5) إضافة زيارة متابعة حمل (تسجيل الحيوية والفحص في كل زيارة) =====
export const createPregnancyVisit = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  const b = req.body;
  try {
    if (b.visit_id) {
      const visit = await pool.query('SELECT visit_id, clinic_id, patient_id FROM visits WHERE visit_id = $1', [b.visit_id]);
      if (!visit.rowCount) return res.status(400).json({ message: 'الزيارة المرتبطة غير موجودة' });
      if (Number(visit.rows[0].patient_id) !== Number(pregnancy.patient_id)) {
        return res.status(400).json({ message: 'الزيارة لا تنتمي لنفس المريضة' });
      }
    }
    // تحقق منطقي قبل قاعدة البيانات: ضغط منعكس = خطأ عميل (400) وليس خطأ خادم
    if (b.systolic !== undefined && b.systolic !== null && b.diastolic !== undefined && b.diastolic !== null && Number(b.systolic) < Number(b.diastolic)) {
      return res.status(400).json({ message: 'الضغط الانقباضي يجب أن يكون أكبر من أو يساوي الانبساطي' });
    }
    const result = await pool.query(
      `INSERT INTO pregnancy_visits (pregnancy_id, visit_id, visit_date, ga_weeks, ga_days, weight_kg, systolic, diastolic,
          pulse, temperature, fundal_height_cm, fetal_heart_rate, fetal_presentation, symptoms, clinical_examination,
          diagnosis, treatment_plan, supplements, next_visit_date, risk_level, notes, recorded_by)
       VALUES ($1,$2,COALESCE($3, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [pregnancy.pregnancy_id, b.visit_id ?? null, b.visit_date ? new Date(b.visit_date).toISOString() : null,
       b.ga_weeks ?? null, b.ga_days ?? null, b.weight_kg ?? null, b.systolic ?? null, b.diastolic ?? null,
       b.pulse ?? null, b.temperature ?? null, b.fundal_height_cm ?? null, b.fetal_heart_rate ?? null,
       b.fetal_presentation ?? null, b.symptoms ?? null, b.clinical_examination ?? null, b.diagnosis ?? null,
       b.treatment_plan ?? null, b.supplements ?? null, b.next_visit_date ?? null, b.risk_level ?? 'NORMAL', b.notes ?? null, req.user?.userId]
    );
    // تحديث مستوى الخطورة على سجل الحمل إذا تغير
    if (b.risk_level && b.risk_level !== pregnancy.risk_level) {
      await pool.query('UPDATE pregnancies SET risk_level = $1, updated_at = NOW() WHERE pregnancy_id = $2', [b.risk_level, pregnancy.pregnancy_id]);
    }
    await audit(req.user?.userId, pregnancy.clinic_id, 'PREGNANCY_VISIT_ADDED', 'PREGNANCY', pregnancy.pregnancy_id, { pv_id: result.rows[0].pv_id });
    return res.status(201).json({ message: 'تمت إضافة زيارة المتابعة', pregnancy_visit: result.rows[0] });
  } catch (error) {
    console.error('Create Pregnancy Visit Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إضافة زيارة المتابعة' });
  }
};

// ===== 6) تعديل زيارة متابعة =====
export const updatePregnancyVisit = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  const b = req.body;
  try {
    const existing = await pool.query('SELECT pv_id FROM pregnancy_visits WHERE pv_id = $1 AND pregnancy_id = $2', [req.params.pvId, pregnancy.pregnancy_id]);
    if (!existing.rowCount) return res.status(404).json({ message: 'زيارة المتابعة غير موجودة' });
    const fields: [string, unknown][] = [
      ['visit_date', b.visit_date ? new Date(b.visit_date).toISOString() : undefined],
      ['ga_weeks', b.ga_weeks], ['ga_days', b.ga_days], ['weight_kg', b.weight_kg],
      ['systolic', b.systolic], ['diastolic', b.diastolic], ['pulse', b.pulse], ['temperature', b.temperature],
      ['fundal_height_cm', b.fundal_height_cm], ['fetal_heart_rate', b.fetal_heart_rate],
      ['fetal_presentation', b.fetal_presentation], ['symptoms', b.symptoms], ['clinical_examination', b.clinical_examination],
      ['diagnosis', b.diagnosis], ['treatment_plan', b.treatment_plan], ['supplements', b.supplements],
      ['next_visit_date', b.next_visit_date], ['risk_level', b.risk_level], ['notes', b.notes],
    ];
    const params: unknown[] = [];
    const sets: string[] = [];
    for (const [column, value] of fields) {
      if (value !== undefined) { params.push(value); sets.push(`${column} = $${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ message: 'لا توجد بيانات للتحديث' });
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);
    params.push(req.params.pvId);
    const result = await pool.query(
      `UPDATE pregnancy_visits SET ${sets.join(', ')} WHERE pv_id = $${params.length} RETURNING *`,
      params
    );
    await audit(req.user?.userId, pregnancy.clinic_id, 'PREGNANCY_VISIT_UPDATED', 'PREGNANCY', pregnancy.pregnancy_id);
    return res.status(200).json({ message: 'تم تحديث زيارة المتابعة', pregnancy_visit: result.rows[0] });
  } catch (error) {
    console.error('Update Pregnancy Visit Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تحديث زيارة المتابعة' });
  }
};

// ===== 7) حذف زيارة متابعة =====
export const deletePregnancyVisit = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  try {
    const result = await pool.query(
      'DELETE FROM pregnancy_visits WHERE pv_id = $1 AND pregnancy_id = $2 RETURNING pv_id',
      [req.params.pvId, pregnancy.pregnancy_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'زيارة المتابعة غير موجودة' });
    return res.status(200).json({ message: 'تم حذف زيارة المتابعة' });
  } catch (error) {
    console.error('Delete Pregnancy Visit Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند حذف زيارة المتابعة' });
  }
};

// ===== 8) إضافة فحص سونار =====
export const createUltrasound = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  const b = req.body;
  try {
    if (b.visit_id) {
      const visit = await pool.query('SELECT patient_id FROM visits WHERE visit_id = $1', [b.visit_id]);
      if (!visit.rowCount || Number(visit.rows[0].patient_id) !== Number(pregnancy.patient_id)) {
        return res.status(400).json({ message: 'الزيارة المرتبطة غير موجودة أو لا تنتمي لنفس المريضة' });
      }
    }
    const result = await pool.query(
      `INSERT INTO ultrasound_exams (pregnancy_id, visit_id, exam_date, ga_weeks, ga_days, fetus_count, fetal_presentation,
          bpd_cm, hc_cm, ac_cm, fl_cm, efw_g, amniotic_fluid_index, placenta_position, findings, impression, report_text, performed_by)
       VALUES ($1,$2,COALESCE($3, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [pregnancy.pregnancy_id, b.visit_id ?? null, b.exam_date ? new Date(b.exam_date).toISOString() : null,
       b.ga_weeks ?? null, b.ga_days ?? null, b.fetus_count ?? 1, b.fetal_presentation ?? null,
       b.bpd_cm ?? null, b.hc_cm ?? null, b.ac_cm ?? null, b.fl_cm ?? null, b.efw_g ?? null,
       b.amniotic_fluid_index ?? null, b.placenta_position ?? null, b.findings ?? null, b.impression ?? null, b.report_text ?? null, req.user?.userId]
    );
    await audit(req.user?.userId, pregnancy.clinic_id, 'ULTRASOUND_ADDED', 'PREGNANCY', pregnancy.pregnancy_id, { us_id: result.rows[0].us_id });
    return res.status(201).json({ message: 'تمت إضافة فحص السونار', ultrasound: result.rows[0] });
  } catch (error) {
    console.error('Create Ultrasound Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند إضافة فحص السونار' });
  }
};

// ===== 9) تعديل فحص سونار =====
export const updateUltrasound = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  const b = req.body;
  try {
    const existing = await pool.query('SELECT us_id FROM ultrasound_exams WHERE us_id = $1 AND pregnancy_id = $2', [req.params.usId, pregnancy.pregnancy_id]);
    if (!existing.rowCount) return res.status(404).json({ message: 'فحص السونار غير موجود' });
    const fields: [string, unknown][] = [
      ['exam_date', b.exam_date ? new Date(b.exam_date).toISOString() : undefined],
      ['ga_weeks', b.ga_weeks], ['ga_days', b.ga_days], ['fetus_count', b.fetus_count],
      ['fetal_presentation', b.fetal_presentation], ['bpd_cm', b.bpd_cm], ['hc_cm', b.hc_cm],
      ['ac_cm', b.ac_cm], ['fl_cm', b.fl_cm], ['efw_g', b.efw_g], ['amniotic_fluid_index', b.amniotic_fluid_index],
      ['placenta_position', b.placenta_position], ['findings', b.findings], ['impression', b.impression], ['report_text', b.report_text],
    ];
    const params: unknown[] = [];
    const sets: string[] = [];
    for (const [column, value] of fields) {
      if (value !== undefined) { params.push(value); sets.push(`${column} = $${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ message: 'لا توجد بيانات للتحديث' });
    params.push(req.params.usId);
    const result = await pool.query(
      `UPDATE ultrasound_exams SET ${sets.join(', ')} WHERE us_id = $${params.length} RETURNING *`,
      params
    );
    await audit(req.user?.userId, pregnancy.clinic_id, 'ULTRASOUND_UPDATED', 'PREGNANCY', pregnancy.pregnancy_id);
    return res.status(200).json({ message: 'تم تحديث فحص السونار', ultrasound: result.rows[0] });
  } catch (error) {
    console.error('Update Ultrasound Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند تحديث فحص السونار' });
  }
};

// ===== 10) حذف فحص سونار =====
export const deleteUltrasound = async (req: AuthenticatedRequest, res: Response) => {
  const pregnancy = await requirePregnancyWrite(req, res, req.params.pregnancyId);
  if (!pregnancy) return;
  try {
    const result = await pool.query(
      'DELETE FROM ultrasound_exams WHERE us_id = $1 AND pregnancy_id = $2 RETURNING us_id',
      [req.params.usId, pregnancy.pregnancy_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'فحص السونار غير موجود' });
    return res.status(200).json({ message: 'تم حذف فحص السونار' });
  } catch (error) {
    console.error('Delete Ultrasound Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند حذف فحص السونار' });
  }
};