import type { PoolClient } from 'pg';
import type { Response } from 'express';
import { pool } from '../../config/database';
import type { AuthenticatedRequest } from '../../middlewares/auth.middleware';

// صلاحية إدارة الصلاحيات — يجب أن يبقى دائماً دور نشط يملكها ويضم مستخدماً نشطاً
// (حماية من انغلاق النظام — Lockout Protection — المرحلة 9)
const LOCKOUT_PERMISSION_KEY = 'MANAGE_PERMISSIONS';

// تسجيل العمليات الحساسة في سجل التدقيق (المرحلة 10) — بدون أي بيانات حساسة
const logAudit = async (
  userId: number | undefined,
  action: string,
  resourceType: string,
  resourceId: number | null,
  metadata?: Record<string, unknown>
) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId ?? null, action, resourceType, resourceId, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (error) {
    console.error('فشل تسجيل عملية التدقيق:', error);
  }
};

interface RoleRow {
  role_id: number;
  role_name: string;
  description: string | null;
  is_system: boolean;
  is_active: boolean;
  users_count: number;
  permissions: string[];
}

const getRoleById = async (roleId: number): Promise<RoleRow | null> => {
  const result = await pool.query(
    `SELECT r.role_id, r.role_name, r.description, r.is_system, r.is_active,
            (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.role_id) AS users_count,
            COALESCE(json_agg(DISTINCT p.permission_key) FILTER (WHERE p.permission_key IS NOT NULL), '[]') AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
     LEFT JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE r.role_id = $1
     GROUP BY r.role_id`,
    [roleId]
  );
  return (result.rows[0] as RoleRow | undefined) ?? null;
};

// يُستدعى داخل معاملة قاعدة البيانات: يتأكد أن النظام يحتفظ بعد التعديل بـ:
// 1) دور نشط واحد على الأقل يملك صلاحية إدارة الصلاحيات
// 2) مستخدم نشط واحد على الأقل يحمل دوراً يملك هذه الصلاحية
// وإلا يرمي خطأ يُرجع للعميل 400 ويُلغى التعديل بالكامل (ROLLBACK)
const assertSystemKeepsPermissionManager = async (client: PoolClient): Promise<void> => {
  const holders = await client.query(
    `SELECT COUNT(DISTINCT r.role_id)::int AS cnt
     FROM roles r
     JOIN role_permissions rp ON rp.role_id = r.role_id
     JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE p.permission_key = $1 AND r.is_active`,
    [LOCKOUT_PERMISSION_KEY]
  );
  if ((holders.rows[0] as { cnt: number }).cnt === 0) {
    throw new Error('LOCKOUT: لا يمكن إزالة صلاحية إدارة الصلاحيات من آخر دور نشط يملكها');
  }
  const activeAdmins = await client.query(
    `SELECT COUNT(DISTINCT u.user_id)::int AS cnt
     FROM users u
     JOIN roles r ON r.role_id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.role_id
     JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE p.permission_key = $1 AND u.status = 'ACTIVE' AND r.is_active`,
    [LOCKOUT_PERMISSION_KEY]
  );
  if ((activeAdmins.rows[0] as { cnt: number }).cnt === 0) {
    throw new Error('LOCKOUT: يجب أن يبقى مستخدم نشط واحد على الأقل يملك صلاحية إدارة الصلاحيات');
  }
};

const isLockoutError = (error: unknown): string | null => {
  if (error instanceof Error && error.message.startsWith('LOCKOUT:')) {
    return error.message.replace('LOCKOUT: ', '');
  }
  return null;
};

// 1. قائمة كل الصلاحيات مجمعة حسب المجموعة (لعرضها كـ Checkboxes في الواجهة)
export const listPermissionOptions = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT permission_key, permission_group, description
       FROM permissions
       ORDER BY permission_group, permission_key`
    );
    const byGroup = new Map<string, { group: string; permissions: { key: string; description: string | null }[] }>();
    for (const row of result.rows as { permission_key: string; permission_group: string; description: string | null }[]) {
      let group = byGroup.get(row.permission_group);
      if (!group) {
        group = { group: row.permission_group, permissions: [] };
        byGroup.set(row.permission_group, group);
      }
      group.permissions.push({ key: row.permission_key, description: row.description });
    }
    return res.json({ groups: [...byGroup.values()] });
  } catch (error) {
    console.error('خطأ في جلب الصلاحيات:', error);
    return res.status(500).json({ message: 'خطأ في جلب الصلاحيات' });
  }
};

// 2. قائمة الأدوار مع صلاحياتها وعدد المستخدمين
export const listRoles = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT r.role_id, r.role_name, r.description, r.is_system, r.is_active,
              (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.role_id) AS users_count,
              COALESCE(json_agg(DISTINCT p.permission_key) FILTER (WHERE p.permission_key IS NOT NULL), '[]') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
       LEFT JOIN permissions p ON p.permission_id = rp.permission_id
       GROUP BY r.role_id
       ORDER BY r.is_system DESC, r.role_id`
    );
    return res.json({ roles: result.rows });
  } catch (error) {
    console.error('خطأ في جلب الأدوار:', error);
    return res.status(500).json({ message: 'خطأ في جلب الأدوار' });
  }
};

// 3. إنشاء دور جديد مع صلاحياته
export const createRole = async (req: AuthenticatedRequest, res: Response) => {
  const { role_name, description, permission_keys } = req.body as {
    role_name: string;
    description?: string;
    permission_keys?: string[];
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM roles WHERE role_name = $1', [role_name]);
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'اسم الدور مستخدم بالفعل' });
    }
    const created = await client.query(
      `INSERT INTO roles (role_name, description, is_system, is_active)
       VALUES ($1, $2, FALSE, TRUE)
       RETURNING role_id`,
      [role_name, description ?? '']
    );
    const roleId = (created.rows[0] as { role_id: number }).role_id;
    if (permission_keys && permission_keys.length > 0) {
      const perms = await client.query('SELECT permission_id FROM permissions WHERE permission_key = ANY($1)', [permission_keys]);
      if (perms.rowCount !== new Set(permission_keys).size) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'إحدى الصلاحيات المرسلة غير معروفة في النظام' });
      }
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, permission_id FROM permissions WHERE permission_key = ANY($2)`,
        [roleId, permission_keys]
      );
    }
    await assertSystemKeepsPermissionManager(client);
    await client.query('COMMIT');
    await logAudit(req.user?.userId, 'ROLE_CREATED', 'ROLE', roleId, { role_name });
    return res.status(201).json({ message: 'تم إنشاء الدور بنجاح', role_id: roleId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const lockoutMessage = isLockoutError(error);
    if (lockoutMessage) return res.status(400).json({ message: lockoutMessage });
    console.error('خطأ في إنشاء الدور:', error);
    return res.status(500).json({ message: 'خطأ في إنشاء الدور' });
  } finally {
    client.release();
  }
};

// 4. تعديل بيانات الدور (الاسم والوصف) — ممنوع تغيير اسم الأدوار الأساسية
export const updateRole = async (req: AuthenticatedRequest, res: Response) => {
  const roleId = Number(req.params.roleId);
  const { role_name, description } = req.body as { role_name?: string; description?: string };
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return res.status(400).json({ message: 'معرف الدور غير صالح' });
  }
  try {
    const role = await getRoleById(roleId);
    if (!role) return res.status(404).json({ message: 'الدور غير موجود' });
    if (role.is_system && role_name && role_name !== role.role_name) {
      return res.status(400).json({ message: 'لا يمكن تغيير اسم دور أساسي في النظام' });
    }
    const newName = role_name?.trim() || role.role_name;
    const newDescription = description !== undefined ? description : role.description;
    if (newName !== role.role_name) {
      const duplicate = await pool.query('SELECT 1 FROM roles WHERE role_name = $1 AND role_id <> $2', [newName, roleId]);
      if (duplicate.rowCount) return res.status(409).json({ message: 'اسم الدور مستخدم بالفعل' });
    }
    await pool.query('UPDATE roles SET role_name = $1, description = $2 WHERE role_id = $3', [newName, newDescription, roleId]);
    await logAudit(req.user?.userId, 'ROLE_UPDATED', 'ROLE', roleId, { role_name: newName });
    return res.json({ message: 'تم تحديث الدور بنجاح' });
  } catch (error) {
    console.error('خطأ في تحديث الدور:', error);
    return res.status(500).json({ message: 'خطأ في تحديث الدور' });
  }
};

// 5. حفظ صلاحيات الدور (استبدال كامل داخل معاملة) — ممنوع على SUPER_ADMIN
export const setRolePermissions = async (req: AuthenticatedRequest, res: Response) => {
  const roleId = Number(req.params.roleId);
  const { permission_keys } = req.body as { permission_keys: string[] };
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return res.status(400).json({ message: 'معرف الدور غير صالح' });
  }
  const client = await pool.connect();
  try {
    const role = await getRoleById(roleId);
    if (!role) {
      return res.status(404).json({ message: 'الدور غير موجود' });
    }
    if (role.role_name === 'SUPER_ADMIN') {
      return res.status(400).json({ message: 'لا يمكن تعديل صلاحيات دور SUPER_ADMIN — هو مصدر الحماية من انغلاق النظام' });
    }
    await client.query('BEGIN');
    const perms = await client.query('SELECT permission_id FROM permissions WHERE permission_key = ANY($1)', [permission_keys]);
    if (perms.rowCount !== new Set(permission_keys).size) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'إحدى الصلاحيات المرسلة غير معروفة في النظام' });
    }
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    if (permission_keys.length > 0) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, permission_id FROM permissions WHERE permission_key = ANY($2)`,
        [roleId, permission_keys]
      );
    }
    await assertSystemKeepsPermissionManager(client);
    await client.query('COMMIT');
    await logAudit(req.user?.userId, 'PERMISSION_CHANGED', 'ROLE', roleId, {
      role_name: role.role_name,
      permissions_count: permission_keys.length,
    });
    return res.json({ message: 'تم حفظ صلاحيات الدور بنجاح' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const lockoutMessage = isLockoutError(error);
    if (lockoutMessage) return res.status(400).json({ message: lockoutMessage });
    console.error('خطأ في حفظ صلاحيات الدور:', error);
    return res.status(500).json({ message: 'خطأ في حفظ صلاحيات الدور' });
  } finally {
    client.release();
  }
};

// 6. تفعيل/تعطيل دور — ممنوع على الأدوار الأساسية، مع حماية من الانغلاق
export const updateRoleStatus = async (req: AuthenticatedRequest, res: Response) => {
  const roleId = Number(req.params.roleId);
  const { is_active } = req.body as { is_active: boolean };
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return res.status(400).json({ message: 'معرف الدور غير صالح' });
  }
  const client = await pool.connect();
  try {
    const role = await getRoleById(roleId);
    if (!role) {
      return res.status(404).json({ message: 'الدور غير موجود' });
    }
    if (role.is_system) {
      return res.status(400).json({ message: 'لا يمكن تعطيل أو تفعيل دور أساسي في النظام' });
    }
    await client.query('BEGIN');
    await client.query('UPDATE roles SET is_active = $1 WHERE role_id = $2', [is_active, roleId]);
    if (!is_active) {
      await assertSystemKeepsPermissionManager(client);
    }
    await client.query('COMMIT');
    await logAudit(req.user?.userId, 'ROLE_STATUS_CHANGED', 'ROLE', roleId, { role_name: role.role_name, is_active });
    return res.json({ message: is_active ? 'تم تفعيل الدور بنجاح' : 'تم تعطيل الدور بنجاح' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const lockoutMessage = isLockoutError(error);
    if (lockoutMessage) return res.status(400).json({ message: lockoutMessage });
    console.error('خطأ في تغيير حالة الدور:', error);
    return res.status(500).json({ message: 'خطأ في تغيير حالة الدور' });
  } finally {
    client.release();
  }
};

// 7. حذف دور — ممنوع على الأدوار الأساسية، وممنوع إذا كان لا يزال مستخدماً
export const deleteRole = async (req: AuthenticatedRequest, res: Response) => {
  const roleId = Number(req.params.roleId);
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return res.status(400).json({ message: 'معرف الدور غير صالح' });
  }
  const client = await pool.connect();
  try {
    const role = await getRoleById(roleId);
    if (!role) {
      return res.status(404).json({ message: 'الدور غير موجود' });
    }
    if (role.is_system) {
      return res.status(400).json({ message: 'لا يمكن حذف دور أساسي في النظام' });
    }
    if (role.users_count > 0) {
      return res.status(400).json({ message: 'لا يمكن حذف دور لا يزال مستخدماً من طرف حسابات — أعد إسناد المستخدمين أولاً' });
    }
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    await client.query('DELETE FROM roles WHERE role_id = $1', [roleId]);
    await assertSystemKeepsPermissionManager(client);
    await client.query('COMMIT');
    await logAudit(req.user?.userId, 'ROLE_DELETED', 'ROLE', roleId, { role_name: role.role_name });
    return res.json({ message: 'تم حذف الدور بنجاح' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const lockoutMessage = isLockoutError(error);
    if (lockoutMessage) return res.status(400).json({ message: lockoutMessage });
    console.error('خطأ في حذف الدور:', error);
    return res.status(500).json({ message: 'خطأ في حذف الدور' });
  } finally {
    client.release();
  }
};
