import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { hashPassword } from '../../utils/auth';

// أدوات مساعدة: التحقق من أدوار المستخدمين قبل إسنادهم للعيادة
const verifyStaffIds = async (ids: number[], expectedRole: 'DOCTOR' | 'NURSE'): Promise<{ ok: boolean; message?: string }> => {
  if (!ids.length) return { ok: true };
  const result = await pool.query(
    `SELECT u.user_id, u.status, r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = ANY($1::int[])`,
    [ids]
  );
  const found = new Map(result.rows.map((row) => [Number(row.user_id), row]));
  for (const id of ids) {
    const user = found.get(Number(id));
    if (!user) return { ok: false, message: `المستخدم #${id} غير موجود` };
    if (user.role_name !== expectedRole) return { ok: false, message: `المستخدم المحدد لا يملك دور ${expectedRole === 'DOCTOR' ? 'طبيب' : 'ممرض/ة'}` };
    if (user.status !== 'ACTIVE') return { ok: false, message: `حساب المستخدم #${id} غير نشط` };
  }
  return { ok: true };
};

// إسناد مجموعة مستخدمين لعيادة (بدون نقلهم من عياداتهم الأساسية)
const assignStaff = async (clinicId: number, ids: number[], assignedBy?: number) => {
  for (const userId of ids) {
    await pool.query(
      `INSERT INTO clinic_staff (clinic_id, user_id, assigned_by)
       VALUES ($1, $2, $3) ON CONFLICT (clinic_id, user_id) DO NOTHING`,
      [clinicId, userId, assignedBy ?? null]
    );
  }
};

// 1. قائمة العيادات مع إحصائياتها وتخصصها (إدارة النظام)
export const listClinics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.clinic_id, c.clinic_name, c.is_active, c.created_at,
              s.specialty_id, s.specialty_key, s.name_ar AS specialty_name, s.name_en AS specialty_name_en,
              (SELECT COUNT(*)::int FROM clinic_staff cs JOIN users u ON u.user_id = cs.user_id
                 WHERE cs.clinic_id = c.clinic_id AND u.status = 'ACTIVE') AS staff_count,
              (SELECT COUNT(*)::int FROM patients p WHERE p.clinic_id = c.clinic_id) AS patients_count
       FROM clinics c
       LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
       ORDER BY c.clinic_id ASC`
    );
    return res.status(200).json({ clinics: result.rows });
  } catch (error) {
    console.error('List Clinics Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع العيادات' });
  }
};

// 1ب. دليل العيادات النشطة (بالاسم) — متاح لأي مستخدم موثق لاختيار العيادة بالاسم
// يُستخدم في نماذج الزيارات والمشاركات والإحالات بدل إدخال رقم العيادة يدوياً
export const listClinicDirectory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.clinic_id, c.clinic_name, c.is_active,
              s.specialty_id, s.specialty_key, s.name_ar AS specialty_name
       FROM clinics c
       LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
       WHERE c.is_active = TRUE
       ORDER BY c.clinic_name ASC`
    );
    return res.status(200).json({ clinics: result.rows });
  } catch (error) {
    console.error('List Clinic Directory Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع دليل العيادات' });
  }
};

// 2. تفاصيل عيادة واحدة (التخصص + الطاقم مقسم حسب الدور)
export const getClinic = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  try {
    const clinic = await pool.query(
      `SELECT c.clinic_id, c.clinic_name, c.is_active, c.created_at,
              s.specialty_id, s.specialty_key, s.name_ar AS specialty_name, s.name_en AS specialty_name_en
       FROM clinics c LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
       WHERE c.clinic_id = $1`,
      [clinicId]
    );
    if (!clinic.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    const staff = await pool.query(
      `SELECT u.user_id, u.full_name, u.username, u.sub_specialty, u.status, r.role_name, cs.assigned_at,
              (cs.clinic_id = u.clinic_id) AS is_primary
       FROM clinic_staff cs
       JOIN users u ON u.user_id = cs.user_id
       JOIN roles r ON r.role_id = u.role_id
       WHERE cs.clinic_id = $1
       ORDER BY CASE r.role_name WHEN 'DOCTOR' THEN 1 WHEN 'NURSE' THEN 2 ELSE 3 END, u.full_name ASC`,
      [clinicId]
    );
    const staffRows = staff.rows;
    return res.status(200).json({
      clinic: clinic.rows[0],
      staff: staffRows,
      doctors: staffRows.filter((m) => m.role_name === 'DOCTOR'),
      nurses: staffRows.filter((m) => m.role_name === 'NURSE'),
    });
  } catch (error) {
    console.error('Get Clinic Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند استرجاع العيادة' });
  }
};

// 3. إضافة عيادة جديدة بتخصصها وطاقمها (مدير النظام فقط)
export const createClinic = async (req: AuthenticatedRequest, res: Response) => {
  const clinic_name = String(req.body?.clinic_name ?? '').trim();
  const specialty_id = req.body?.specialty_id ? Number(req.body.specialty_id) : null;
  const doctor_ids: number[] = Array.isArray(req.body?.doctor_ids) ? req.body.doctor_ids.map(Number) : [];
  const nurse_ids: number[] = Array.isArray(req.body?.nurse_ids) ? req.body.nurse_ids.map(Number) : [];

  if (clinic_name.length < 2 || clinic_name.length > 150) {
    return res.status(400).json({ message: 'اسم العيادة يجب أن يكون بين 2 و 150 حرفًا' });
  }
  if (!specialty_id) {
    return res.status(400).json({ message: 'يجب اختيار التخصص الطبي للعيادة' });
  }

  try {
    const specialty = await pool.query('SELECT specialty_id FROM specialties WHERE specialty_id = $1', [specialty_id]);
    if (!specialty.rowCount) return res.status(400).json({ message: 'التخصص الطبي غير موجود' });
    const doctorCheck = await verifyStaffIds(doctor_ids, 'DOCTOR');
    if (!doctorCheck.ok) return res.status(400).json({ message: doctorCheck.message });
    const nurseCheck = await verifyStaffIds(nurse_ids, 'NURSE');
    if (!nurseCheck.ok) return res.status(400).json({ message: nurseCheck.message });

    const result = await pool.query(
      `INSERT INTO clinics (clinic_name, specialty_id) VALUES ($1, $2)
       RETURNING clinic_id, clinic_name, specialty_id, is_active, created_at`,
      [clinic_name, specialty_id]
    );
    const clinicId = result.rows[0].clinic_id;
    await assignStaff(clinicId, [...doctor_ids, ...nurse_ids], req.user?.userId);
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'CLINIC_CREATED', 'CLINIC', $2, $3)`,
      [req.user?.userId, clinicId, JSON.stringify({ specialty_id, doctors: doctor_ids.length, nurses: nurse_ids.length })]
    );
    return res.status(201).json({ message: 'تم إضافة العيادة بنجاح', clinic: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ message: 'اسم العيادة مستخدم بالفعل' });
    console.error('Create Clinic Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند إضافة العيادة' });
  }
};

// 4. تعديل عيادة (الاسم، التخصص، الحالة، الطاقم) — مدير النظام فقط
export const updateClinic = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = Number(req.params.clinicId);
  const clinic_name = req.body?.clinic_name !== undefined ? String(req.body.clinic_name).trim() : undefined;
  const is_active = typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined;
  const specialty_id = req.body?.specialty_id !== undefined ? (req.body.specialty_id === null ? null : Number(req.body.specialty_id)) : undefined;
  const replaceStaff = Array.isArray(req.body?.doctor_ids) || Array.isArray(req.body?.nurse_ids);
  const doctor_ids: number[] = Array.isArray(req.body?.doctor_ids) ? req.body.doctor_ids.map(Number) : [];
  const nurse_ids: number[] = Array.isArray(req.body?.nurse_ids) ? req.body.nurse_ids.map(Number) : [];

  if (clinic_name !== undefined && (clinic_name.length < 2 || clinic_name.length > 150)) {
    return res.status(400).json({ message: 'اسم العيادة يجب أن يكون بين 2 و 150 حرفًا' });
  }

  try {
    if (specialty_id !== undefined && specialty_id !== null) {
      const specialty = await pool.query('SELECT 1 FROM specialties WHERE specialty_id = $1', [specialty_id]);
      if (!specialty.rowCount) return res.status(400).json({ message: 'التخصص الطبي غير موجود' });
    }
    if (replaceStaff) {
      const doctorCheck = await verifyStaffIds(doctor_ids, 'DOCTOR');
      if (!doctorCheck.ok) return res.status(400).json({ message: doctorCheck.message });
      const nurseCheck = await verifyStaffIds(nurse_ids, 'NURSE');
      if (!nurseCheck.ok) return res.status(400).json({ message: nurseCheck.message });
    }

    const params: unknown[] = [];
    const sets: string[] = [];
    if (clinic_name !== undefined) { params.push(clinic_name); sets.push(`clinic_name = $${params.length}`); }
    if (specialty_id !== undefined) { params.push(specialty_id); sets.push(`specialty_id = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); sets.push(`is_active = $${params.length}`); }
    if (!sets.length && !replaceStaff) return res.status(400).json({ message: 'لا توجد بيانات للتعديل' });

    if (sets.length) {
      params.push(clinicId);
      const updated = await pool.query(
        `UPDATE clinics SET ${sets.join(', ')} WHERE clinic_id = $${params.length} RETURNING clinic_id`,
        params
      );
      if (!updated.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    } else {
      const exists = await pool.query('SELECT 1 FROM clinics WHERE clinic_id = $1', [clinicId]);
      if (!exists.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    }

    if (replaceStaff) {
      // استبدال قائمة الطاقم (إزالة الارتباط لا تحذف حساب المستخدم)
      await pool.query('DELETE FROM clinic_staff WHERE clinic_id = $1', [clinicId]);
      await assignStaff(clinicId, [...doctor_ids, ...nurse_ids], req.user?.userId);
      // إصلاح العيادة الأساسية لمن أُزيل من عيادته الأساسية: تُنقل لأسند آخر أو تُلغى
      await pool.query(
        `UPDATE users u SET clinic_id = (
           SELECT cs.clinic_id FROM clinic_staff cs WHERE cs.user_id = u.user_id ORDER BY cs.assigned_at ASC LIMIT 1
         )
         WHERE u.clinic_id = $1
           AND NOT EXISTS (SELECT 1 FROM clinic_staff cs2 WHERE cs2.user_id = u.user_id AND cs2.clinic_id = $1)`,
        [clinicId]
      );
    }

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
       VALUES ($1, 'CLINIC_UPDATED', 'CLINIC', $2)`,
      [req.user?.userId, clinicId]
    );
    const finalResult = await pool.query(
      `SELECT clinic_id, clinic_name, specialty_id, is_active, created_at FROM clinics WHERE clinic_id = $1`,
      [clinicId]
    );
    return res.status(200).json({ message: 'تم تحديث العيادة بنجاح', clinic: finalResult.rows[0] });
  } catch (error) {
    console.error('Update Clinic Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند تحديث العيادة' });
  }
};

// 4. فريق عمل العيادة (مدير النظام فقط)
export const listClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = req.params.clinicId;
  try {
    const clinic = await pool.query(
      `SELECT c.clinic_id, c.clinic_name, c.is_active, s.specialty_key, s.name_ar AS specialty_name
       FROM clinics c LEFT JOIN specialties s ON s.specialty_id = c.specialty_id
       WHERE c.clinic_id = $1`,
      [clinicId]
    );
    if (!clinic.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.username, u.sub_specialty, u.status, u.created_at, r.role_name,
              (cs.clinic_id = u.clinic_id) AS is_primary
       FROM clinic_staff cs
       JOIN users u ON u.user_id = cs.user_id
       JOIN roles r ON r.role_id = u.role_id
       WHERE cs.clinic_id = $1
       ORDER BY CASE r.role_name WHEN 'DOCTOR' THEN 1 WHEN 'NURSE' THEN 2 ELSE 3 END, u.full_name ASC`,
      [clinicId]
    );
    return res.status(200).json({ clinic: clinic.rows[0], staff: result.rows });
  } catch (error) {
    console.error('List Clinic Staff Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم عند جلب فريق العيادة' });
  }
};

// 5. إسناد موظف للعيادة (إنشاء جديد أو إسناد مستخدم موجود) — مدير النظام فقط
export const addClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = Number(req.params.clinicId);
  const { full_name, username, password, role_name, sub_specialty, user_id } = req.body;

  try {
    const clinic = await pool.query('SELECT clinic_id, is_active FROM clinics WHERE clinic_id = $1', [clinicId]);
    if (!clinic.rowCount) return res.status(404).json({ message: 'العيادة غير موجودة' });
    if (!clinic.rows[0].is_active) return res.status(400).json({ message: 'لا يمكن إسناد موظفين لعيادة موقوفة' });

    // حالة إسناد مستخدم موجود: يُضاف لطاقم العيادة دون إزالته من عياداته الأخرى
    if (user_id) {
      const existingUser = await pool.query(
        `SELECT u.user_id, u.clinic_id, u.status, r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`,
        [user_id]
      );
      if (!existingUser.rowCount) return res.status(404).json({ message: 'المستخدم غير موجود' });
      if (existingUser.rows[0].status !== 'ACTIVE') return res.status(400).json({ message: 'حساب المستخدم غير نشط' });
      if (['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(existingUser.rows[0].role_name)) {
        return res.status(400).json({ message: 'لا يمكن إسناد حساب إداري كموظف عيادة' });
      }

      const insert = await pool.query(
        `INSERT INTO clinic_staff (clinic_id, user_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, user_id) DO NOTHING
         RETURNING clinic_staff_id`,
        [clinicId, user_id, req.user?.userId]
      );
      if (!insert.rowCount) return res.status(409).json({ message: 'المستخدم مسبقاً في هذه العيادة' });

      // إذا كان المستخدم بلا عيادة أساسية (سُحبت سابقاً) تُعتبر هذه عيادته الأساسية
      if (existingUser.rows[0].clinic_id === null) {
        await pool.query('UPDATE users SET clinic_id = $1 WHERE user_id = $2', [clinicId, user_id]);
      }

      await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
         VALUES ($1, 'CLINIC_STAFF_ASSIGNED', 'USER', $2)`,
        [req.user?.userId, user_id]
      );
      const staffRow = await pool.query(
        `SELECT u.user_id, u.full_name, u.username, u.sub_specialty, u.status, r.role_name
         FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`,
        [user_id]
      );
      return res.status(200).json({ message: 'تم إسناد الموظف إلى العيادة بنجاح', staff: staffRow.rows[0] });
    }

    // حالة إنشاء مستخدم جديد: عيادته الأساسية هي هذه العيادة
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
      `INSERT INTO clinic_staff (clinic_id, user_id, assigned_by) VALUES ($1, $2, $3)
       ON CONFLICT (clinic_id, user_id) DO NOTHING`,
      [clinicId, result.rows[0].user_id, req.user?.userId]
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

// 7. إزالة موظف من العيادة (تُزيل الارتباط فقط — لا تحذف حساب المستخدم ولا بياناته)
export const removeClinicStaff = async (req: AuthenticatedRequest, res: Response) => {
  const clinicId = Number(req.params.clinicId);
  const userId = Number(req.params.userId);
  try {
    const result = await pool.query(
      `DELETE FROM clinic_staff cs
       USING users u, roles r
       WHERE u.user_id = cs.user_id AND r.role_id = u.role_id
         AND cs.clinic_id = $1 AND cs.user_id = $2
         AND r.role_name NOT IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
       RETURNING u.user_id, u.username`,
      [clinicId, userId]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'الموظف غير موجود في هذه العيادة' });

    // إذا كانت هذه عيادته الأساسية تُنقل لأسند آخر لديه، أو تُلغى الأساسية
    await pool.query(
      `UPDATE users u SET clinic_id = (
         SELECT cs.clinic_id FROM clinic_staff cs WHERE cs.user_id = u.user_id ORDER BY cs.assigned_at ASC LIMIT 1
       )
       WHERE u.user_id = $1 AND u.clinic_id = $2
         AND NOT EXISTS (SELECT 1 FROM clinic_staff cs2 WHERE cs2.user_id = u.user_id AND cs2.clinic_id = $2)`,
      [userId, clinicId]
    );

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