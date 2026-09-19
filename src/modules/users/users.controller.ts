import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, canManageAllClinics, isGlobalFinanceRole } from '../../middlewares/auth.middleware';
import { hashPassword } from '../../utils/auth';
import { parseDeviceLabel } from '../../utils/device';

export const listUsers = async (req: AuthenticatedRequest, res: Response) => {
  // P0.3: نطاق إدارة المستخدمين العام (كل العيادات) للأدوار الإدارية المخوّلة فعلياً فقط
  // (SUPER_ADMIN / SYSTEM_ADMIN عبر canManageAllClinics) — لا يُمنح لمجرد امتلاك صلاحية مالية.
  const isGlobal = canManageAllClinics(req);
  const requestedClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const role = typeof req.query.role === 'string' ? req.query.role : null;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  try {
    const params: unknown[] = [];
    // المستخدمون المحذوفون (Soft Delete) مخفيون عن القائمة النشطة — سجلاتهم التاريخية تبقى سليمة
    let where = 'u.deleted_at IS NULL';

    // نطاق العيادات:
    // - المدير العام: يرى كل المستخدمين ما لم يحدد عيادة صراحة (ويتضمن وقتها الإسنادات الإضافية clinic_staff)
    // - الموظف العادي: يرى مستخدمي عياداته المسندة فقط (الأساسية + الإسنادات الإضافية)
    if (isGlobal) {
      if (requestedClinic) {
        params.push(requestedClinic);
        where += ` AND (u.clinic_id = $${params.length} OR EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $${params.length}
        ))`;
      }
    } else {
      const ids = req.user?.clinicIds ?? (req.user?.clinicId !== null && req.user?.clinicId !== undefined ? [req.user.clinicId] : []);
      if (requestedClinic) {
        if (!ids.includes(requestedClinic)) return res.status(403).json({ message: 'لا يمكنك عرض مستخدمي عيادة غير مسندة لك' });
        params.push(requestedClinic);
        where += ` AND (u.clinic_id = $${params.length} OR EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $${params.length}
        ))`;
      } else if (ids.length > 0) {
        params.push(ids);
        where += ` AND (u.clinic_id = ANY($${params.length}::int[]) OR EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = ANY($${params.length}::int[])
        ))`;
      }
    }

    // فلترة اختيارية حسب الدور/الحالة/البحث لدعم شاشات إسناد الطاقم
    if (role) {
      params.push(role);
      where += ` AND r.role_name = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND u.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (u.full_name ILIKE $${params.length} OR u.username ILIKE $${params.length})`;
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.username, u.phone, u.status, u.is_force_password_change,
              u.medical_license_no, u.sub_specialty, u.direct_phone, u.last_login_at,
              u.created_at, r.role_name, c.clinic_id, c.clinic_name,
              -- حالة الاتصال مشتقة من user_sessions (بلا N+1) — جلسة نشطة حديثة واحدة تكفي
              EXISTS (
                SELECT 1 FROM user_sessions us
                WHERE us.user_id = u.user_id
                  AND us.revoked_at IS NULL
                  AND us.expires_at > NOW()
                  AND us.last_seen_at >= NOW() - INTERVAL '60 seconds'
              ) AS is_online
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN clinics c ON c.clinic_id = u.clinic_id
       WHERE ${where}
       ORDER BY u.full_name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
     return res.status(200).json({ users: result.rows, pagination: { page, limit, returned: result.rows.length } });
  } catch (error) {
    console.error('List Users Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب المستخدمين' });
  }
};

// قائمة الأطباء المتاحين لحجز المواعيد — أطباء عيادات المستخدم المسندة (الأساسية أو clinic_staff)
// وللمدير كل الأطباء (أو حسب العيادة المطلوبة)
export const listDoctors = async (req: AuthenticatedRequest, res: Response) => {
  // مقصود خارج تشديد P0.3: هذا دليل أطباء للقراءة فقط تستخدمه شاشة الفواتير لاختيار الطبيب
  // بالاسم عبر العيادات (BillingView)، فهو نطاق مالي وليس إدارة مستخدمين — لذلك يبقى كما هو.
  const isGlobal = isGlobalFinanceRole(req);
  const requestedClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  try {
    const params: unknown[] = [];
    let where = `u.status = 'ACTIVE'`;
    if (!isGlobal) {
      const ids = req.user?.clinicIds ?? (req.user?.clinicId !== null && req.user?.clinicId !== undefined ? [req.user.clinicId] : []);
      if (requestedClinic) {
        if (!ids.includes(requestedClinic)) return res.status(403).json({ message: 'لا يمكنك عرض أطباء عيادة غير مسندة لك' });
        params.push(requestedClinic);
        where += ` AND EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $${params.length}
          UNION SELECT 1 FROM users u2 WHERE u2.user_id = u.user_id AND u2.clinic_id = $${params.length}
        )`;
      } else {
        params.push(ids);
        where += ` AND EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = ANY($${params.length}::int[])
          UNION SELECT 1 FROM users u2 WHERE u2.user_id = u.user_id AND u2.clinic_id = ANY($${params.length}::int[])
        )`;
      }
    } else if (requestedClinic) {
      params.push(requestedClinic);
      where += ` AND EXISTS (
        SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $${params.length}
        UNION SELECT 1 FROM users u2 WHERE u2.user_id = u.user_id AND u2.clinic_id = $${params.length}
      )`;
    }
    const result = await pool.query(
      `SELECT DISTINCT u.user_id, u.full_name, u.sub_specialty, u.clinic_id, c.clinic_name
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN clinics c ON c.clinic_id = u.clinic_id
       WHERE r.role_name = 'DOCTOR' AND ${where}
       ORDER BY u.full_name ASC`,
      params
    );
    return res.status(200).json({ doctors: result.rows });
  } catch (error) {
    console.error('List Doctors Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب قائمة الأطباء' });
  }
};

export const createUser = async (req: AuthenticatedRequest, res: Response) => {
  const { full_name, username, password, role_name, clinic_id, phone, medical_license_no, sub_specialty, direct_phone } = req.body;
  // P0.3: الإنشاء عبر العيادات للأدوار الإدارية المخوّلة فقط — دور مالي لا يعبر نطاق عياداته
  const managerIsGlobal = canManageAllClinics(req);
  const targetClinicId = clinic_id ?? req.user?.clinicId;

  if (!managerIsGlobal && targetClinicId !== req.user?.clinicId) {
    return res.status(403).json({ message: 'لا يمكنك إنشاء مستخدم في عيادة أخرى' });
  }
  if (role_name === 'SUPER_ADMIN' && !managerIsGlobal) {
    return res.status(403).json({ message: 'لا يمكنك منح صلاحية مدير النظام' });
  }
  if (role_name !== 'SUPER_ADMIN' && !targetClinicId) {
    return res.status(400).json({ message: 'العيادة مطلوبة لهذا الدور' });
  }

  try {
    const role = await pool.query('SELECT role_id FROM roles WHERE role_name = $1', [role_name]);
    if (!role.rowCount) return res.status(400).json({ message: 'الدور غير موجود' });
    if (targetClinicId) {
      const clinic = await pool.query('SELECT 1 FROM clinics WHERE clinic_id = $1 AND is_active = TRUE', [targetClinicId]);
      if (!clinic.rowCount) return res.status(400).json({ message: 'العيادة غير موجودة أو غير فعالة' });
    }
    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, phone,
         medical_license_no, sub_specialty, direct_phone, is_force_password_change)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
       RETURNING user_id, full_name, username, phone, status, is_force_password_change, medical_license_no, sub_specialty, direct_phone, clinic_id`,
      [role.rows[0].role_id, targetClinicId ?? null, full_name, username, passwordHash, phone ?? null, medical_license_no ?? null, sub_specialty ?? null, direct_phone ?? null]
    );
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'USER_CREATED', 'USER', $3)`,
        [req.user?.userId, req.user?.clinicId, result.rows[0].user_id]
      );
    } catch (auditError) {
      console.error('User creation audit failed:', auditError);
    }
    return res.status(201).json({ user: { ...result.rows[0], role_name } });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ message: 'اسم المستخدم مستخدم بالفعل' });
    console.error('Create User Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء المستخدم' });
  }
};

export const updateUser = async (req: AuthenticatedRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const updates: Record<string, unknown> = {};
  const body = req.body;
  // P0.3: نفس سياسة createUser — النطاق العام للإدارة للأدوار الإدارية فقط
  const managerIsGlobal = canManageAllClinics(req);
  const current = await pool.query(
    `SELECT u.user_id, u.role_id, u.clinic_id, u.deleted_at, r.role_name
     FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1`, [targetId]
  );
  if (!current.rowCount || current.rows[0].deleted_at) return res.status(404).json({ message: 'المستخدم غير موجود' });
  if (!managerIsGlobal && current.rows[0].clinic_id !== req.user?.clinicId) return res.status(403).json({ message: 'لا يمكنك تعديل مستخدم من عيادة أخرى' });
  if (targetId === req.user?.userId && (body.role_name || body.status === 'SUSPENDED' || body.clinic_id !== undefined)) {
    return res.status(400).json({ message: 'لا يمكنك تغيير دور أو عيادة أو حالة حسابك الحالي' });
  }
  const finalRoleName = body.role_name ?? current.rows[0].role_name;
  const finalClinicId = body.clinic_id !== undefined ? body.clinic_id : current.rows[0].clinic_id;
  if (finalRoleName !== 'SUPER_ADMIN' && !finalClinicId) {
    return res.status(400).json({ message: 'الدور التشغيلي يحتاج إلى عيادة' });
  }
  try {
    if (body.full_name !== undefined) updates.full_name = body.full_name;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.medical_license_no !== undefined) updates.medical_license_no = body.medical_license_no;
    if (body.sub_specialty !== undefined) updates.sub_specialty = body.sub_specialty;
    if (body.direct_phone !== undefined) updates.direct_phone = body.direct_phone;
    if (body.status !== undefined) updates.status = body.status;
    if (body.is_force_password_change !== undefined) updates.is_force_password_change = body.is_force_password_change;
    if (body.password) { updates.password_hash = await hashPassword(body.password); updates.is_force_password_change = true; }
    if (body.role_name) {
      if (body.role_name === 'SUPER_ADMIN' && !managerIsGlobal) return res.status(403).json({ message: 'لا يمكنك منح صلاحية مدير النظام' });
      const role = await pool.query('SELECT role_id FROM roles WHERE role_name = $1', [body.role_name]);
      if (!role.rowCount) return res.status(400).json({ message: 'الدور غير موجود' });
      updates.role_id = role.rows[0].role_id;
    }
    if (body.clinic_id !== undefined) {
      if (!managerIsGlobal && body.clinic_id !== req.user?.clinicId) return res.status(403).json({ message: 'لا يمكنك نقل المستخدم إلى عيادة أخرى' });
      updates.clinic_id = body.clinic_id;
    }
    const entries = Object.entries(updates);
    if (!entries.length) return res.status(400).json({ message: 'لا توجد تغييرات صالحة' });
    const values = entries.map(([, value]) => value);
    const setClause = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
    const result = await pool.query(`UPDATE users SET ${setClause}, updated_at = NOW() WHERE user_id = $${values.length + 1} RETURNING user_id, full_name, username, phone, status, is_force_password_change, role_id, clinic_id`, [...values, targetId]);
    if (body.status && body.status !== 'ACTIVE' || body.password) {
      await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [targetId]);
    }
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'USER_UPDATED', 'USER', $3)`,
        [req.user?.userId, req.user?.clinicId, targetId]
      );
    } catch (auditError) {
      console.error('User update audit failed:', auditError);
    }
    return res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    console.error('Update User Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تعديل المستخدم' });
  }
};

// ——————————————————————————————————————————————————————————————
// إدارة جلسات المستخدم (Presence / Sessions) — مبنية على جدول user_sessions الحالي.
// لا يُكشف jti ولا أي توكن للواجهة — معرفات الجلسات الداخلية (session_id) فقط.
// ——————————————————————————————————————————————————————————————

interface TargetUserRow {
  user_id: number;
  username: string;
  clinic_id: number | null;
  deleted_at: Date | null;
  role_name: string | null;
}

const parseTargetId = (req: AuthenticatedRequest): number | null => {
  const targetId = Number(req.params.id);
  return Number.isInteger(targetId) && targetId > 0 ? targetId : null;
};

// الحواجز المشتركة لإدارة حساب مستخدم آخر:
// 1) موجود وغير محذوف  2) نطاق العيادة (نفس نمط updateUser)  3) حماية الدور الأعلى
// 4) selfBlocked: المسارات الإدارية ترفض استهداف الحساب الحالي منعاً لإنهاء
//    جلسة المدير نفسه بالخطأ — له مساراته الخاصة /api/auth/logout و /api/auth/logout-all.
const resolveManageableTarget = async (
  req: AuthenticatedRequest,
  targetId: number,
  res: Response,
  selfBlocked: boolean
): Promise<TargetUserRow | null> => {
  const current = await pool.query(
    `SELECT u.user_id, u.username, u.clinic_id, u.deleted_at, r.role_name
     FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1`, [targetId]
  );
  const target = current.rows[0] as TargetUserRow | undefined;
  if (!target || target.deleted_at) {
    res.status(404).json({ message: 'المستخدم غير موجود' });
    return null;
  }
  // P0.3: إدارة الجلسات (عرض/إنهاء) بنفس نطاق الإدارة — لا نطاق مالي عام
  const managerIsGlobal = canManageAllClinics(req);
  if (!managerIsGlobal && target.clinic_id !== req.user?.clinicId) {
    res.status(403).json({ message: 'لا يمكنك إدارة مستخدم من عيادة أخرى' });
    return null;
  }
  // حماية الحسابات الإدارية: مدير أقل صلاحية لا يدير جلسات/حساب مدير أعلى منه
  if (target.role_name === 'SUPER_ADMIN' && req.user?.roleName !== 'SUPER_ADMIN') {
    res.status(403).json({ message: 'لا يمكنك إدارة حساب مدير أعلى منك' });
    return null;
  }
  if (selfBlocked && targetId === req.user?.userId) {
    res.status(400).json({ message: 'لا يمكنك إدارة جلسات حسابك الحالي من هنا — استخدم تسجيل الخروج' });
    return null;
  }
  return target;
};

// قائمة جلسات مستخدم محدد — معلومات آمنة فقط (بلا jti ولا توكنات)
export const listUserSessions = async (req: AuthenticatedRequest, res: Response) => {
  const targetId = parseTargetId(req);
  if (targetId === null) return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
  try {
    const target = await resolveManageableTarget(req, targetId, res, false);
    if (!target) return;
    const sessions = await pool.query(
      `SELECT session_id, created_at, last_seen_at, expires_at, revoked_at, user_agent,
              (revoked_at IS NULL AND expires_at > NOW() AND last_seen_at >= NOW() - INTERVAL '60 seconds') AS is_online
       FROM user_sessions
       WHERE user_id = $1
       ORDER BY (revoked_at IS NOT NULL) ASC, created_at DESC`,
      [targetId]
    );
    return res.status(200).json({
      sessions: sessions.rows.map((row) => ({
        session_id: Number(row.session_id),
        device: parseDeviceLabel(row.user_agent),
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        is_online: Boolean(row.is_online),
      })),
    });
  } catch (error) {
    console.error('List User Sessions Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب جلسات المستخدم' });
  }
};

// إنهاء جلسة واحدة محددة — بلا مساس بأي جلسة أخرى لنفس المستخدم
export const revokeUserSession = async (req: AuthenticatedRequest, res: Response) => {
  const targetId = parseTargetId(req);
  const sessionId = Number(req.params.sessionId);
  if (targetId === null) return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
  if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: 'معرف الجلسة غير صالح' });
  try {
    const target = await resolveManageableTarget(req, targetId, res, true);
    if (!target) return;
    const session = await pool.query(
      'SELECT session_id, revoked_at FROM user_sessions WHERE session_id = $1 AND user_id = $2',
      [sessionId, targetId]
    );
    if (!session.rowCount) return res.status(404).json({ message: 'الجلسة غير موجودة لهذا المستخدم' });
    if (session.rows[0].revoked_at) return res.status(400).json({ message: 'الجلسة ملغاة مسبقاً' });
    // إلغاء هذه الجلسة فقط — لا حذف للسجل ولا مساس ببقية الجلسات
    const revoked = await pool.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING session_id`,
      [sessionId, targetId]
    );
    if (!revoked.rowCount) return res.status(400).json({ message: 'الجلسة ملغاة مسبقاً' });
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'USER_SESSION_REVOKED', 'USER_SESSION', $3, $4)`,
        [req.user?.userId, req.user?.clinicId, sessionId, JSON.stringify({ target_user_id: targetId })]
      );
    } catch (auditError) {
      console.error('Session revoke audit failed:', auditError);
    }
    return res.status(200).json({ success: true, message: 'تم إنهاء الجلسة المحددة وسيتم تسجيل خروج المستخدم منها' });
  } catch (error) {
    console.error('Revoke User Session Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنهاء الجلسة' });
  }
};

// إنهاء جميع جلسات المستخدم — بدون حذف سجلات الجلسات
export const revokeAllUserSessions = async (req: AuthenticatedRequest, res: Response) => {
  const targetId = parseTargetId(req);
  if (targetId === null) return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
  try {
    const target = await resolveManageableTarget(req, targetId, res, true);
    if (!target) return;
    const revoked = await pool.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       RETURNING session_id`,
      [targetId]
    );
    const revokedCount = revoked.rowCount ?? 0;
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'USER_SESSIONS_REVOKED', 'USER', $3, $4)`,
        [req.user?.userId, req.user?.clinicId, targetId, JSON.stringify({ target_user_id: targetId, revoked_count: revokedCount })]
      );
    } catch (auditError) {
      console.error('Sessions revoke-all audit failed:', auditError);
    }
    return res.status(200).json({ success: true, revokedCount, message: 'تم إنهاء جميع جلسات المستخدم' });
  } catch (error) {
    console.error('Revoke All User Sessions Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنهاء الجلسات' });
  }
};

// حذف المستخدم — حذف ناعم إجبارياً (نظام طبي):
// الزيارات والفواتير والروشتات وسجلات التدقيق مرتبطة بمعرف المستخدم بقيود NOT NULL،
// والحذف الفعلي سيدمر بيانات طبية/تاريخية. لذلك: تعطيل + وسم deleted_at + إنهاء كل الجلسات.
export const deleteUser = async (req: AuthenticatedRequest, res: Response) => {
  const targetId = parseTargetId(req);
  if (targetId === null) return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // قفل صف الهدف داخل المعاملة لمنع تغير حالته أثناء العملية
    const current = await client.query(
      `SELECT u.user_id, u.username, u.clinic_id, u.deleted_at, r.role_name
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
       WHERE u.user_id = $1 FOR UPDATE OF u`, [targetId]
    );
    const target = current.rows[0] as TargetUserRow | undefined;
    if (!target || target.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    // لا يجوز لأي مدير حذف نفسه — حتى لو نُفذ الطلب يدوياً
    if (targetId === req.user?.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'لا يمكنك حذف حسابك الحالي' });
    }
    // P0.3: الحذف عبر العيادات للأدوار الإدارية المخوّلة فقط — لا لمجرد صلاحية مالية
    const managerIsGlobal = canManageAllClinics(req);
    if (!managerIsGlobal && target.clinic_id !== req.user?.clinicId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'لا يمكنك حذف مستخدم من عيادة أخرى' });
    }
    // مدير أقل صلاحية لا يحذف مديراً أعلى منه
    if (target.role_name === 'SUPER_ADMIN' && req.user?.roleName !== 'SUPER_ADMIN') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'لا يمكنك حذف حساب مدير أعلى منك' });
    }

    // 1) إنهاء جميع جلسات المستخدم داخل نفس المعاملة (لا يبقى JWT صالحاً على أي جهاز)
    const revoked = await client.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       RETURNING session_id`, [targetId]
    );
    const revokedCount = revoked.rowCount ?? 0;

    // 2) الحذف الناعم: تعطيل + وسم الحذف — دون أي حذف فعلي للصف أو السجلات المرتبطة
    const deleted = await client.query(
      `UPDATE users SET status = 'SUSPENDED', deleted_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND deleted_at IS NULL
       RETURNING user_id`, [targetId]
    );
    if (!deleted.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    // 3) حماية من انغلاق النظام: يجب أن يبقى مدير نشط واحد على الأقل غير المستهدف
    const remaining = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM users u
       LEFT JOIN roles r ON r.role_id = u.role_id
       WHERE u.user_id <> $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
         AND (
           r.role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
           OR EXISTS (
             SELECT 1 FROM role_permissions rp
             JOIN permissions p ON p.permission_id = rp.permission_id
             WHERE rp.role_id = u.role_id AND p.permission_key = 'MANAGE_USERS'
           )
         )`, [targetId]
    );
    if ((remaining.rows[0] as { cnt: number }).cnt === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'لا يمكنك حذف آخر مدير نشط في النظام' });
    }

    // 4) سجل التدقيق داخل نفس المعاملة — بلا بيانات حساسة (لا كلمات مرور/توكنات/jti)
    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'USER_DELETED', 'USER', $3, $4)`,
      [req.user?.userId, req.user?.clinicId, targetId, JSON.stringify({ target_username: target.username, mode: 'soft_delete', revoked_sessions: revokedCount })]
    );
    await client.query('COMMIT');
    return res.status(200).json({ success: true, message: 'تم حذف المستخدم وإنهاء جميع جلساته' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Delete User Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء حذف المستخدم' });
  } finally {
    client.release();
  }
};