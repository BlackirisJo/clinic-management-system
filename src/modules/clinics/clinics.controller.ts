import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { hashPassword } from '../../utils/auth';

// 1. قائمة العيادات مع إحصائياتها (مدير النظام فقط)
export const listClinics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.clinic_id, c.clinic_name, c.is_active, c.created_at,
              (SELECT COUNT(*)::int FROM users u WHERE u.clinic_id = c.clinic_id) AS staff_count,
              (SELECT COUNT(*)::int FROM patients p WHERE p.clinic_id = c.clinic_id) AS patients_count
       FROM clinics c
       ORDER BY c.clinic_id ASC`
    );
    return res.status(200).json({ clinics: result.rows });
  } catch (error) {
    console.error('List Clinics Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع العيادات' });
  }
};

// 2. إضافة عيادة جديدة (مدير النظام فقط)
export const createClinic = async (req: AuthenticatedRequest, res: Response) => {
  const clinic_name = String(req.body?.clinic_name ?? '').trim();

  if (clinic_name.length < 2 || clinic_name.length > 150) {
    return res.status(400).json({ message: 'اسم العيادة يجب أن يكون بين 2 و 150 حرفًا' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO clinics (clinic_name) VALUES ($1) RETURNING clinic_id, clinic_name, is_active, created_at`,
      [clinic_name]
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
       VALUES ($1, 'CLINIC_CREATED', 'CLINIC', $2)`,
      [req.user?.userId, result.rows[0].clinic_id]
    );
    return res.status(201).json({ message: 'تم إضافة العيادة بنجاح', clinic: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ message: 'اسم العيادة مستخدم بالفعل' });
    console.error('Create Clinic Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إضافة العيادة' });
  }
};

// 3. تعديل عيادة (الاسم و/أو الحالة) — مدير النظام فقط
export const updateClinic = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  const clinic_name = String(req.body?.clinic_name ?? '').trim();
  const is_active = typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined;

  if (clinic_name.length < 2 || clinic_name.length > 150) {
    return res.status(400).json({ message: 'اسم العيادة يجب أن يكون بين 2 و 150 حرفًا' });
  }

  try {
    const params: any[] = [clinic_name];
    let sql = `UPDATE clinics SET clinic_name = $1`;
    if (is_active !== undefined) {
      params.push(is_active);
      sql += `, is_active = $${params.length}`;
    }
    params.push(clinicId);
    sql += ` WHERE clinic_id = $${params.length} RETURNING clinic_id, clinic_name, is_active, created_at`;

    const result = await pool.query(sql, params);
    if (!result.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
       VALUES ($1, 'CLINIC_UPDATED', 'CLINIC', $2)`,
      [req.user?.userId, clinicId]
    );
    return res.status(200).json({ message: 'تم تحديث العيادة بنجاح', clinic: result.rows[0] });
  } catch (error) {
    console.error('Update Clinic Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند تحديث العيادة' });
  }
};

// 4. فريق عمل العيادة (مدير النظام فقط)
export const listClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  try {
    const clinic = await pool.query('SELECT clinic_id, clinic_name, is_active FROM clinics WHERE clinic_id = $1', [clinicId]);
    if (!clinic.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.username, u.sub_specialty, u.status, u.created_at, r.role_name
       FROM users u JOIN roles r ON r.role_id = u.role_id
       WHERE u.clinic_id = $1
       ORDER BY CASE r.role_name WHEN 'DOCTOR' THEN 1 WHEN 'NURSE' THEN 2 ELSE 3 END, u.full_name ASC`,
      [clinicId]
    );
    return res.status(200).json({ clinic: clinic.rows[0], staff: result.rows });
  } catch (error) {
    console.error('List Clinic Staff Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب فريق العيادة' });
  }
};

// 5. إسناد موظف جديد للعيادة (إنشاء حسابه مباشرة داخلها) — مدير النظام فقط
export const addClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  const { full_name, username, password, role_name, sub_specialty } = req.body;

  try {
    const clinic = await pool.query('SELECT clinic_id, is_active FROM clinics WHERE clinic_id = $1', [clinicId]);
    if (!clinic.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    if (!clinic.rows[0].is_active) return res.status(400).json({ message: 'لا يمكن إسناد موظفين لعيادة موقوفة' });
    const role = await pool.query('SELECT role_id FROM roles WHERE role_name = $1', [role_name]);
    if (!role.rowCount) return res.status(400).json({ message: 'الدور غير موجود' });

    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, sub_specialty, status, is_force_password_change)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', TRUE)
       RETURNING user_id, full_name, username, sub_specialty, status`,
      [role.rows[0].role_id, clinicId, full_name, username, passwordHash, sub_specialty ?? null]
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
       VALUES ($1, 'CLINIC_STAFF_ADDED', 'USER', $2)`,
      [req.user?.userId, result.rows[0].user_id]
    );
    return res.status(201).json({ message: 'تم إسناد الموظف إلى العيادة بنجاح', staff: { ...result.rows[0], role_name } });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ message: 'اسم المستخدم مستخدم بالفعل' });
    console.error('Add Clinic Staff Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إسناد الموظف' });
  }
};

// 6. تعديل بيانات موظف في العيادة (الاسم، التخصص، الحالة، كلمة المرور)
export const updateClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  const userId = req.params.userId;
  const { full_name, sub_specialty, status, password } = req.body;

  try {
    // منع التعديل على حسابات الإدارة من هذه الشاشة
    const existing = await pool.query(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
       WHERE u.user_id = $1 AND u.clinic_id = $2 AND r.role_name NOT IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')`,
      [userId, clinicId]
    );
    if (!existing.rowCount) return res.status(404).json({ message: 'الموظف غير موجود في هذه العيادة' });

    const params: any[] = [];
    const sets: string[] = [];
    if (full_name) { params.push(full_name); sets.push(`full_name = $${params.length}`); }
    if (sub_specialty !== undefined) { params.push(sub_specialty); sets.push(`sub_specialty = $${params.length}`); }
    if (status) { params.push(status); sets.push(`status = $${params.length}`); }
    if (password) {
      const passwordHash = await hashPassword(password);
      params.push(passwordHash);
      sets.push(`password_hash = $${params.length}`);
      params.push(true);
      sets.push(`is_force_password_change = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ message: 'لا توجد بيانات للتعديل' });

    params.push(userId);
    const result = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE user_id = $${params.length}
       RETURNING user_id, full_name, username, sub_specialty, status`,
      params
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
       VALUES ($1, 'CLINIC_STAFF_UPDATED', 'USER', $2)`,
      [req.user?.userId, userId]
    );
    return res.status(200).json({ message: 'تم تحديث بيانات الموظف بنجاح', staff: result.rows[0] });
  } catch (error) {
    console.error('Update Clinic Staff Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند تحديث الموظف' });
  }
};

// 7. إزالة موظف من العيادة (يُفقد صلاحية الوصول لبياناتها دون حذف حسابه)
export const removeClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  const userId = req.params.userId;
  try {
    const result = await pool.query(
      `UPDATE users u SET clinic_id = NULL
       FROM roles r
       WHERE u.role_id = r.role_id AND u.user_id = $1 AND u.clinic_id = $2
         AND r.role_name NOT IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
       RETURNING u.user_id, u.username`,
      [userId, clinicId]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'الموظف غير موجود في هذه العيادة' });
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
       VALUES ($1, 'CLINIC_STAFF_REMOVED', 'USER', $2)`,
      [req.user?.userId, userId]
    );
    return res.status(200).json({ message: 'تم إزالة الموظف من العيادة' });
  } catch (error) {
    console.error('Remove Clinic Staff Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إزالة الموظف' });
  }
};