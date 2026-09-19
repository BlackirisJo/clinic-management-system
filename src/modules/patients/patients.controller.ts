import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, accessibleClinicIds, canManageAllClinics } from '../../middlewares/auth.middleware';

// 1. إضافة مريض جديد
export const createPatient = async (req: AuthenticatedRequest, res: Response) => {
  const { full_name, national_id, document_type, document_number, phone, gender, date_of_birth } = req.body;
  // العيادة الأساسية للمستخدم، أو أول عيادة مسندة له، أو عيادة محددة من المدير
  let clinicId: number | null | undefined = req.user?.clinicId;
  if (canManageAllClinics(req) && req.body?.clinic_id) {
    clinicId = Number(req.body.clinic_id);
  } else if ((clinicId === null || clinicId === undefined) && req.user?.clinicIds?.length) {
    clinicId = req.user.clinicIds[0];
  }

  if (!full_name || !phone || !gender || !date_of_birth || !document_type || !document_number || clinicId === null || clinicId === undefined) {
    return res.status(400).json({ message: 'الرجاء تقديم كافة البيانات المطلوبة للمريض (نوع الوثيقة ورقمها إلزاميان)' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO patients (clinic_id, full_name, national_id, document_type, document_number, phone, gender, date_of_birth)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [clinicId, full_name, national_id || null, document_type, document_number, phone, gender, date_of_birth]
    );

    return res.status(201).json({
      message: 'تم إضافة المريض بنجاح',
      patient: result.rows[0],
    });
  } catch (error: any) {
    if (error.code === '23505') { // Unique constraint error
      if (error.constraint === 'idx_patients_document_identity') {
        return res.status(409).json({ message: 'رقم الوثيقة مسجل مسبقاً لمريض آخر بنفس نوع الوثيقة' });
      }
      return res.status(409).json({ message: 'الرقم الوطني مسجل لمريض آخر بالفعل' });
    }
    console.error('Create Patient Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إضافة المريض' });
  }
};

// 2. البحث واسترجاع قائمة المرضى
export const getPatients = async (req: AuthenticatedRequest, res: Response) => {
  const { search } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const clinicIds = accessibleClinicIds(req);
    // مرضى العيادات المسندة للمستخدم + المرضى المشاركين إليها + المرضى المرتبطين بموعد/زيارة في عيادات المستخدم
    // (حتى لو أُسس المريض في عيادة أخرى، فحجز موعد له في عيادتك يُظهره في قائمة مرضاك)
    let query = `SELECT p.*, EXISTS (
      SELECT 1 FROM patient_clinic_shares s
      WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($1::int[])
        AND s.status = 'ACTIVE' AND s.expires_at > NOW()
    ) AS is_shared
    FROM patients p
    WHERE ($1::int[] IS NULL OR p.clinic_id = ANY($1::int[]) OR EXISTS (
      SELECT 1 FROM patient_clinic_shares s
      WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($1::int[])
        AND s.status = 'ACTIVE' AND s.expires_at > NOW()
    ) OR EXISTS (
      SELECT 1 FROM appointments a
      WHERE a.patient_id = p.patient_id AND a.clinic_id = ANY($1::int[])
        AND a.status NOT IN ('CANCELLED')
    ) OR EXISTS (
      SELECT 1 FROM visits v
      WHERE v.patient_id = p.patient_id AND v.clinic_id = ANY($1::int[])
    ))`;
    const params: any[] = [clinicIds];

    if (search) {
      query += ` AND (p.full_name ILIKE $2 OR p.phone ILIKE $2 OR p.national_id ILIKE $2 OR p.document_number ILIKE $2)`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    return res.status(200).json({
      patients: result.rows,
      pagination: { page, limit, returned: result.rows.length },
    });
  } catch (error) {
    console.error('Get Patients Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع قائمة المرضى' });
  }
};

// 3. تسجيل زيارة جديدة للمريض
export const createVisit = async (req: AuthenticatedRequest, res: Response) => {
  const { patient_id, clinic_id, doctor_id, notes } = req.body;
  const userClinicIds = accessibleClinicIds(req);

  if (!patient_id || !clinic_id || !doctor_id) {
    return res.status(400).json({ message: 'بيانات الزيارة غير مكتملة (المريض، العيادة، الطبيب)' });
  }
  // المستخدم يجب أن يكون مسنداً لعيادة الزيارة (أو مديراً)
  if (userClinicIds !== null && !userClinicIds.includes(Number(clinic_id))) {
    return res.status(403).json({ message: 'لا يمكنك تسجيل زيارة في عيادة غير مسندة لك' });
  }

  try {
    // الطبيب يجب أن يكون مسنداً لعيادة الزيارة (أساسي أو إسناد إضافي)
    const doctorMembership = await pool.query(
      `SELECT 1 FROM users u
       WHERE u.user_id = $1 AND u.status = 'ACTIVE' AND (
         u.clinic_id = $2 OR EXISTS (SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $2)
       )`,
      [doctor_id, clinic_id]
    );
    if (!doctorMembership.rowCount) {
      return res.status(400).json({ message: 'الطبيب المحدد غير مسند لهذه العيادة' });
    }

    // وصول المريض — إحدى الحالات الثلاث:
    // 1) المريض مملوك للعيادة نفسها (patients.clinic_id = العيادة الهدف).
    // 2) مشاركة WRITE نشطة إلى العيادة الهدف (patient_clinic_shares — كما هي دون تغيير).
    // 3) حالة المركز الطبي الداخلي: الموظف المسند لأكثر من عيادة داخل نفس المركز
    //    يعمل في العيادتين دون مشاركات — الحد الآمن (لا يوجد مفهوم "مركز" في المخطط):
    //    أن يكون عضواً في عيادة مالك المريض وفي العيادة الهدف معاً ضمن نطاقه
    //    (accessibleClinicIds = الأساسية + clinic_staff). المدراء (نطاق null) يبقى
    //    سلوكهم كما هو (ملكية أو مشاركة) دون توسيع.
    const ownership = await pool.query(
      `SELECT p.clinic_id AS owner_clinic_id,
              EXISTS (SELECT 1 FROM patient_clinic_shares s
                      WHERE s.patient_id = p.patient_id AND s.target_clinic_id = $2
                        AND s.access_level = 'WRITE' AND s.status = 'ACTIVE' AND s.expires_at > NOW()) AS can_write
       FROM patients p
       WHERE p.patient_id = $1`,
      [patient_id, clinic_id]
    );
    const patientAccess = ownership.rows[0];
    const targetClinicId = Number(clinic_id);
    const ownerClinicId = patientAccess ? Number(patientAccess.owner_clinic_id) : null;
    const sameOwnerClinic = Boolean(patientAccess) && ownerClinicId === targetClinicId;
    const internalCenterCase = Boolean(patientAccess) && !sameOwnerClinic
      && Array.isArray(userClinicIds)
      && userClinicIds.includes(ownerClinicId as number)
      && userClinicIds.includes(targetClinicId);
    const canUsePatient = Boolean(patientAccess) && (sameOwnerClinic || Boolean(patientAccess?.can_write) || internalCenterCase);
    if (!canUsePatient || ownership.rows.length !== 1) {
      return res.status(403).json({ message: 'بيانات الزيارة لا تنتمي إلى العيادة المحددة' });
    }
    const result = await pool.query(
      `INSERT INTO visits (patient_id, clinic_id, doctor_id, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [patient_id, clinic_id, doctor_id, notes || null]
    );

    return res.status(201).json({
      message: 'تم تسجيل الزيارة بنجاح',
      visit: result.rows[0],
    });
  } catch (error) {
    console.error('Create Visit Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الزيارة' });
  }
};

// 4. استرجاع السجل الطبي لزيارات مريض معين
export const getPatientVisits = async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const clinicIds = accessibleClinicIds(req);

  try {
    const result = await pool.query(
      `SELECT v.visit_id, v.visit_date, v.notes, v.visit_status, v.chief_complaint,
              c.clinic_name, c.clinic_id, s.name_ar AS specialty_name, u.full_name AS doctor_name
       FROM visits v
       JOIN clinics c ON v.clinic_id = c.clinic_id
       LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
       JOIN users u ON v.doctor_id = u.user_id
       WHERE v.patient_id = $1 AND ($2::int[] IS NULL OR v.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares sh
         WHERE sh.patient_id = v.patient_id AND sh.target_clinic_id = ANY($2::int[])
           AND sh.status = 'ACTIVE' AND sh.expires_at > NOW()
       ))
       ORDER BY v.visit_date DESC`,
      [patientId, clinicIds]
    );

    return res.status(200).json({
      visits: result.rows,
    });
  } catch (error) {
    console.error('Get Patient Visits Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند استرجاع زيارات المريض' });
  }
};

// سياسة إدارة المشاركات (إنشاء/عرض/إلغاء) — مصدر واحد للحقيقة:
// تُدار مشاركات المريض من عيادته المالكة فقط، أي يجب أن تكون عيادة المريض (patients.clinic_id)
// ضمن نطاق عيادات المستخدم (أو مدير شاملاً بنطاق null). تلقي عيادة لمشاركة (READ/WRITE) يمنحها
// وصولاً لبيانات السجل الطبي فقط، ولا يمنحها أي صلاحية على مشاركات المريض (لا عرض ولا إلغاء).
const findPatientInOwnerScope = async (
  patientId: unknown,
  clinicIds: number[] | null
): Promise<{ patient_id: number; owner_clinic_id: number } | null> => {
  const result = await pool.query(
    `SELECT p.patient_id, p.clinic_id AS owner_clinic_id
     FROM patients p
     WHERE p.patient_id = $1 AND ($2::int[] IS NULL OR p.clinic_id = ANY($2::int[]))`,
    [patientId, clinicIds]
  );
  return result.rows[0] ?? null;
};

export const sharePatientRecord = async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const { target_clinic_id, access_level = 'READ', expires_at } = req.body;
  const userId = req.user?.userId;

  if (userId === undefined || !target_clinic_id || !expires_at || !['READ', 'WRITE'].includes(access_level)) {
    return res.status(400).json({ message: 'بيانات المشاركة غير مكتملة أو غير صالحة' });
  }
  const expiry = new Date(expires_at);
  if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
    return res.status(400).json({ message: 'تاريخ انتهاء المشاركة غير صالح' });
  }

  try {
    // العيادة المالكة هي عيادة المريض الفعلية دائماً — ويشترط أن تكون ضمن نطاق عيادات المستخدم
    // (أو يكون المستخدم مديراً شاملاً)، فيمكن للمستخدمين متعددي العيادات المشاركة من أي عيادة مسندة لهم.
    const patient = await findPatientInOwnerScope(patientId, accessibleClinicIds(req));
    const targetClinic = await pool.query('SELECT 1 FROM clinics WHERE clinic_id = $1 AND is_active = TRUE', [target_clinic_id]);
    if (!patient || !targetClinic.rowCount) {
      return res.status(404).json({ message: 'المريض أو العيادة المستهدفة غير موجودة أو لا تملك صلاحية المشاركة' });
    }
    const ownerClinicId = patient.owner_clinic_id;

    const result = await pool.query(
      `INSERT INTO patient_clinic_shares
       (patient_id, owner_clinic_id, target_clinic_id, access_level, expires_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING share_id, patient_id, target_clinic_id, access_level, status, expires_at, created_at`,
      [patientId, ownerClinicId, target_clinic_id, access_level, expiry.toISOString(), userId]
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'PATIENT_RECORD_SHARED', 'PATIENT', $3, $4)`,
      [userId, ownerClinicId, patientId, JSON.stringify({ target_clinic_id, access_level })]
    );
    return res.status(201).json({ share: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ message: 'توجد مشاركة نشطة لهذه العيادة' });
    console.error('Share Patient Record Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء مشاركة السجل الطبي' });
  }
};

export const listPatientShares = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // العرض من نطاق العيادة المالكة فقط (نفس سياسة sharePatientRecord) — لا تُعرض مشاركات المريض
    // لعيادة مستهدفة بمشاركة، حتى لا تكتشف العيادة المستهدفة بقية العيادات المشارَك إليها ومستويات وصولها.
    const patient = await findPatientInOwnerScope(req.params.patientId, accessibleClinicIds(req));
    if (!patient) return res.status(404).json({ message: 'السجل غير موجود أو لا تملك صلاحية الوصول' });
    const ownerClinicId = patient.owner_clinic_id;
    const result = await pool.query(
      `SELECT s.share_id, s.patient_id, s.target_clinic_id, c.clinic_name,
              s.access_level, s.status, s.expires_at, s.created_at
       FROM patient_clinic_shares s
       JOIN clinics c ON c.clinic_id = s.target_clinic_id
       WHERE s.patient_id = $1 AND s.owner_clinic_id = $2
       ORDER BY s.created_at DESC`,
      [req.params.patientId, ownerClinicId]
    );
    return res.status(200).json({ shares: result.rows });
  } catch (error) {
    console.error('List Patient Shares Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب مشاركات السجل' });
  }
};

export const revokePatientShare = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // الإلغاء من نطاق العيادة المالكة فقط — العيادة المستهدفة بمشاركة لا تملك إلغاء مشاركات المريض،
    // لا مشاركتها الخاصة ولا مشاركات العيادات الأخرى (منع تجاوز الصلاحيات عبر العيادات).
    const patient = await findPatientInOwnerScope(req.params.patientId, accessibleClinicIds(req));
    if (!patient) return res.status(404).json({ message: 'السجل غير موجود أو لا تملك صلاحية الوصول' });
    const ownerClinicId = patient.owner_clinic_id;
    const result = await pool.query(
      `UPDATE patient_clinic_shares SET status = 'REVOKED', revoked_at = NOW()
       WHERE share_id = $1 AND patient_id = $2 AND owner_clinic_id = $3 AND status = 'ACTIVE'
       RETURNING share_id`,
      [req.params.shareId, req.params.patientId, ownerClinicId]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'المشاركة النشطة غير موجودة' });
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'PATIENT_RECORD_SHARE_REVOKED', 'PATIENT_SHARE', $3)`,
      [req.user?.userId, req.user?.clinicId, req.params.shareId]
    );
    return res.status(200).json({ message: 'تم إلغاء مشاركة السجل بنجاح' });
  } catch (error) {
    console.error('Revoke Patient Share Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إلغاء المشاركة' });
  }
};

export const getUnifiedMedicalRecord = async (req: AuthenticatedRequest, res: Response) => {
  const patientId = req.params.patientId;
  // النطاق الكامل (null = المدراء يرون كل العيادات) بدل العيادة الأساسية فقط — يدعم الإسنادات المتعددة
  const clinicIds = accessibleClinicIds(req);
  try {
    const access = await pool.query(
      `SELECT p.patient_id, p.full_name, p.national_id, p.document_type, p.document_number, p.phone, p.gender, p.date_of_birth
       FROM patients p
       WHERE p.patient_id = $1 AND ($2::int[] IS NULL OR p.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares s
         WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($2::int[])
           AND s.status = 'ACTIVE' AND s.expires_at > NOW()
       ))`,
      [patientId, clinicIds]
    );
    if (!access.rowCount) return res.status(404).json({ message: 'السجل غير موجود أو لا تملك صلاحية الوصول' });

    // نفس scope الدالة المرجعية getPatientVisits (سطر 180): زيارات عيادات المستخدم فقط،
    // أو زيارات مرتبطة بمشاركة نشطة إلى إحدى عياداته — لا تسريب من عيادات أخرى.
    const visits = await pool.query(
      `SELECT v.visit_id, v.clinic_id, c.clinic_name, v.doctor_id, u.full_name AS doctor_name, v.visit_date, v.notes
       FROM visits v JOIN clinics c ON c.clinic_id = v.clinic_id JOIN users u ON u.user_id = v.doctor_id
       WHERE v.patient_id = $1 AND ($2::int[] IS NULL OR v.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares sh
         WHERE sh.patient_id = v.patient_id AND sh.target_clinic_id = ANY($2::int[])
           AND sh.status = 'ACTIVE' AND sh.expires_at > NOW()
       ))
       ORDER BY v.visit_date DESC`, [patientId, clinicIds]
    );
    // prescriptions بلا clinic_id في المخطط — scope عبر الزيارة المرتبطة (JOIN visits)
    // بنفس قاعدة العيادات/المشاركات النشطة أعلاه.
    const prescriptions = await pool.query(
      `SELECT p.prescription_id, p.visit_id, p.doctor_id, u.full_name AS doctor_name, p.notes, p.created_at
       FROM prescriptions p JOIN users u ON u.user_id = p.doctor_id
       JOIN visits v ON v.visit_id = p.visit_id
       WHERE p.patient_id = $1 AND ($2::int[] IS NULL OR v.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares sh
         WHERE sh.patient_id = p.patient_id AND sh.target_clinic_id = ANY($2::int[])
           AND sh.status = 'ACTIVE' AND sh.expires_at > NOW()
       ))
       ORDER BY p.created_at DESC`, [patientId, clinicIds]
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'PATIENT_RECORD_VIEWED', 'PATIENT', $3)`,
      [req.user?.userId, req.user?.clinicId, patientId]
    );
    return res.status(200).json({ patient: access.rows[0], visits: visits.rows, prescriptions: prescriptions.rows });
  } catch (error) {
    console.error('Unified Medical Record Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب السجل الطبي الموحد' });
  }
};

// 9. جلب ملف البيانات الطبية التكميلية للمريض (الحساسيات والأمراض المزمنة وغيرها)
export const getMedicalProfile = async (req: AuthenticatedRequest, res: Response) => {
  const patientId = req.params.patientId;
  const clinicIds = accessibleClinicIds(req);

  try {
    // العيادة المالكة أو أي مشاركة نشطة (قراءة/كتابة) ضمن كامل نطاق عيادات المستخدم
    const access = await pool.query(
      `SELECT 1 FROM patients p
       WHERE p.patient_id = $1 AND ($2::int[] IS NULL OR p.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares s
         WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($2::int[])
           AND s.status = 'ACTIVE' AND s.expires_at > NOW()
       ))`,
      [patientId, clinicIds]
    );
    if (!access.rowCount) return res.status(404).json({ message: 'السجل غير موجود أو لا تملك صلاحية الوصول' });

    const profile = await pool.query(
      `SELECT mp.profile_id, mp.patient_id, mp.blood_type, mp.current_medications, mp.medical_notes,
              mp.updated_by, mp.updated_at, u.full_name AS updated_by_name
       FROM patient_medical_profiles mp
       LEFT JOIN users u ON u.user_id = mp.updated_by
       WHERE mp.patient_id = $1`,
      [patientId]
    );
    const allergies = await pool.query(
      `SELECT allergen_key, notes FROM patient_allergies WHERE patient_id = $1 ORDER BY allergy_id`,
      [patientId]
    );
    const conditions = await pool.query(
      `SELECT condition_key, severity, notes FROM patient_chronic_conditions WHERE patient_id = $1 ORDER BY condition_id`,
      [patientId]
    );
    return res.status(200).json({
      profile: profile.rows[0] || null,
      allergies: allergies.rows,
      chronic_conditions: conditions.rows,
    });
  } catch (error) {
    console.error('Get Medical Profile Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب البيانات الطبية' });
  }
};

// 10. حفظ/تحديث ملف البيانات الطبية (يكمله الطبيب) — يستبدل الحساسيات والأمراض المزمنة بالكامل حسب مربعات التفعيل
export const saveMedicalProfile = async (req: AuthenticatedRequest, res: Response) => {
  const patientId = req.params.patientId;
  const userId = req.user?.userId;
  const { blood_type, current_medications, medical_notes, allergies, chronic_conditions } = req.body;

  if (userId === undefined) {
    return res.status(401).json({ message: 'المستخدم غير موثق' });
  }

  const client = await pool.connect();
  try {
    // يُسمح بالتعديل للعيادة المالكة أو عيادة لديها مشاركة كتابة نشطة — ضمن كامل نطاق عيادات المستخدم
    const access = await client.query(
      `SELECT 1 FROM patients p
       WHERE p.patient_id = $1 AND ($2::int[] IS NULL OR p.clinic_id = ANY($2::int[]) OR EXISTS (
         SELECT 1 FROM patient_clinic_shares s
         WHERE s.patient_id = p.patient_id AND s.target_clinic_id = ANY($2::int[])
           AND s.access_level = 'WRITE' AND s.status = 'ACTIVE' AND s.expires_at > NOW()
       ))`,
      [patientId, accessibleClinicIds(req)]
    );
    if (!access.rowCount) {
      client.release();
      return res.status(404).json({ message: 'السجل غير موجود أو لا تملك صلاحية تعديل البيانات الطبية' });
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO patient_medical_profiles (patient_id, blood_type, current_medications, medical_notes, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (patient_id) DO UPDATE SET
         blood_type = EXCLUDED.blood_type,
         current_medications = EXCLUDED.current_medications,
         medical_notes = EXCLUDED.medical_notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [patientId, blood_type ?? null, current_medications ?? null, medical_notes ?? null, userId]
    );

    // الحساسيات: تُستبدل بالكامل (وجود الصف = مربع التفعيل ✓)
    await client.query('DELETE FROM patient_allergies WHERE patient_id = $1', [patientId]);
    for (const allergy of allergies ?? []) {
      await client.query(
        `INSERT INTO patient_allergies (patient_id, allergen_key, notes, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (patient_id, allergen_key) DO UPDATE SET notes = EXCLUDED.notes`,
        [patientId, allergy.allergen_key, allergy.notes ?? null, userId]
      );
    }

    // الأمراض المزمنة: تُستبدل بالكامل مع شدة كل مرض
    await client.query('DELETE FROM patient_chronic_conditions WHERE patient_id = $1', [patientId]);
    for (const condition of chronic_conditions ?? []) {
      await client.query(
        `INSERT INTO patient_chronic_conditions (patient_id, condition_key, severity, notes, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (patient_id, condition_key) DO UPDATE SET severity = EXCLUDED.severity, notes = EXCLUDED.notes`,
        [patientId, condition.condition_key, condition.severity ?? 'UNSPECIFIED', condition.notes ?? null, userId]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'PATIENT_MEDICAL_PROFILE_UPDATED', 'PATIENT', $3)`,
      [userId, req.user?.clinicId, patientId]
    );
    await client.query('COMMIT');

    const profile = await client.query(
      `SELECT mp.profile_id, mp.patient_id, mp.blood_type, mp.current_medications, mp.medical_notes,
              mp.updated_by, mp.updated_at, u.full_name AS updated_by_name
       FROM patient_medical_profiles mp
       LEFT JOIN users u ON u.user_id = mp.updated_by
       WHERE mp.patient_id = $1`,
      [patientId]
    );
    const allergyRows = await client.query(
      `SELECT allergen_key, notes FROM patient_allergies WHERE patient_id = $1 ORDER BY allergy_id`,
      [patientId]
    );
    const conditionRows = await client.query(
      `SELECT condition_key, severity, notes FROM patient_chronic_conditions WHERE patient_id = $1 ORDER BY condition_id`,
      [patientId]
    );

    return res.status(200).json({
      message: 'تم حفظ البيانات الطبية بنجاح',
      profile: profile.rows[0],
      allergies: allergyRows.rows,
      chronic_conditions: conditionRows.rows,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* الجلسة قد تكون مغلقة بالفعل */ }
    console.error('Save Medical Profile Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند حفظ البيانات الطبية' });
  } finally {
    client.release();
  }
};