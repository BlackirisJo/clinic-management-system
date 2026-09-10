import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { hashPassword } from '../../utils/auth';

const isFinanceBypass = (roleName?: string, permissions: string[] = []): boolean => {
  if (roleName === 'SUPER_ADMIN' || roleName === 'SYSTEM_ADMIN') return true;
  if (roleName === 'ACCOUNTANT') return true;
  return permissions.includes('MANAGE_SERVICES') || permissions.includes('CREATE_EXPENSE');
};

export const listUsers = async (req: AuthenticatedRequest, res: Response) => {
  const isGlobal = isFinanceBypass(req.user?.roleName, req.user?.permissions ?? []);
  const requestedClinic = req.query.clinic_id ? Number(req.query.clinic_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const role = typeof req.query.role === 'string' ? req.query.role : null;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  try {
    const params: unknown[] = [];
    let where = 'TRUE';

    // نطاق العيادات:
    // - المدير العام: يرى كل المستخدمين ما لم يحدد عيادة صراحة (ويتضمن وقتها الإسنادات الإضافية clinic_staff)
    // - الموظف العادي: يرى مستخدمي عياداته المسندة فقط (الأساسية + الإسنادات الإضافية)
    if (isGlobal) {
      if (requestedClinic) {
        params.push(requestedClinic);
        where = `(u.clinic_id = $${params.length} OR EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $${params.length}
        ))`;
      }
    } else {
      const ids = req.user?.clinicIds ?? (req.user?.clinicId !== null && req.user?.clinicId !== undefined ? [req.user.clinicId] : []);
      if (requestedClinic) {
        if (!ids.includes(requestedClinic)) return res.status(403).json({ message: 'لا يمكنك عرض مستخدمي عيادة غير مسندة لك' });
        params.push(requestedClinic);
        where = `(u.clinic_id = $${params.length} OR EXISTS (
          SELECT 1 FROM clinic_staff cs WHERE cs.user_id = u.user_id AND cs.clinic_id = $${params.length}
        ))`;
      } else if (ids.length > 0) {
        params.push(ids);
        where = `(u.clinic_id = ANY($${params.length}::int[]) OR EXISTS (
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
              u.created_at, r.role_name, c.clinic_id, c.clinic_name
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
  const isGlobal = isFinanceBypass(req.user?.roleName, req.user?.permissions ?? []);
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
  const managerIsGlobal = isFinanceBypass(req.user?.roleName, req.user?.permissions ?? []);
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
  const managerIsGlobal = isFinanceBypass(req.user?.roleName, req.user?.permissions ?? []);
  const current = await pool.query(
    `SELECT u.user_id, u.role_id, u.clinic_id, r.role_name
     FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1`, [targetId]
  );
  if (!current.rowCount) return res.status(404).json({ message: 'المستخدم غير موجود' });
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