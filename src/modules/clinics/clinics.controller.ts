import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

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