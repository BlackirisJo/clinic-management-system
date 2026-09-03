import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { hashPassword } from '../../utils/auth';

const canManageAllClinics = (req: AuthenticatedRequest) => req.user?.roleName === 'SUPER_ADMIN' || req.user?.roleName === 'SYSTEM_ADMIN';

export const listUsers = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = canManageAllClinics(req) && req.query.clinic_id ? Number(req.query.clinic_id) : req.user?.clinicId;
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.username, u.phone, u.status, u.is_force_password_change,
              u.medical_license_no, u.sub_specialty, u.direct_phone, u.last_login_at,
              u.created_at, r.role_name, c.clinic_id, c.clinic_name
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN clinics c ON c.clinic_id = u.clinic_id
       WHERE ($1::int IS NULL OR u.clinic_id = $1)
       ORDER BY u.created_at DESC`, [clinicId]);
    return res.status(200).json({ users: result.rows });
  } catch (error) {
    console.error('List Users Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب المستخدمين' });
  }
};

export const createUser = async (req: AuthenticatedRequest, res: Response) => {
  const { full_name, username, password, role_name, clinic_id, phone, medical_license_no, sub_specialty, direct_phone } = req.body;
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
  const managerIsGlobal = canManageAllClinics(req);
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
    return res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    console.error('Update User Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تعديل المستخدم' });
  }
};