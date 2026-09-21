import type { Response } from 'express';
import { pool } from '../../config/database';
import type { AuthenticatedRequest } from '../../middlewares/auth.middleware';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const list = async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.roleName !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'غير مصرّح' });
  }

  const rawPage = parseInt(req.query.page as string || '', 10);
  const rawLimit = parseInt(req.query.limit as string || '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : DEFAULT_PAGE;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT ? rawLimit : DEFAULT_LIMIT;

  const {
    action,
    resource_type,
    user_name,
    clinic_name,
    date_from,
    date_to,
    search,
  } = (req.query as Record<string, string>);

  const offset = (page - 1) * limit;
  const filters: string[] = [];
  const values: (string | number)[] = [];
  let paramIndex = 0;

  if (action) {
    paramIndex++;
    filters.push(`a.action = $${paramIndex}`);
    values.push(action);
  }
  if (resource_type) {
    paramIndex++;
    filters.push(`a.resource_type = $${paramIndex}`);
    values.push(resource_type);
  }
  if (user_name) {
    paramIndex++;
    filters.push(`LOWER(u.full_name) LIKE LOWER($${paramIndex})`);
    values.push(`%${user_name}%`);
  }
  if (clinic_name) {
    paramIndex++;
    filters.push(`LOWER(c.clinic_name) LIKE LOWER($${paramIndex})`);
    values.push(`%${clinic_name}%`);
  }
  if (date_from) {
    paramIndex++;
    filters.push(`a.created_at >= $${paramIndex}`);
    values.push(date_from);
  }
  if (date_to) {
    paramIndex++;
    const toDate = new Date(date_to + 'T00:00:00Z');
    if (Number.isNaN(toDate.getTime())) {
      values.push(date_to);
      filters.push(`a.created_at <= $${paramIndex}`);
    } else {
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      values.push(toDate.toISOString().replace(/Z$/, ''));
      filters.push(`a.created_at < $${paramIndex}`);
    }
  }
  if (search) {
    paramIndex++;
    filters.push(`(
      LOWER(a.action) LIKE LOWER($${paramIndex}) OR
      LOWER(a.resource_type) LIKE LOWER($${paramIndex}) OR
      LOWER(a.resource_id) LIKE LOWER($${paramIndex}) OR
      LOWER(u.full_name) LIKE LOWER($${paramIndex}) OR
      LOWER(c.clinic_name) LIKE LOWER($${paramIndex}) OR
      LOWER(u.username) LIKE LOWER($${paramIndex}) OR
      LOWER(r.role_name) LIKE LOWER($${paramIndex})
    )`);
    values.push(`%${search}%`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_logs a
       LEFT JOIN users u ON u.user_id = a.user_id
       LEFT JOIN clinics c ON c.clinic_id = a.clinic_id
       LEFT JOIN roles r ON r.role_id = u.role_id
       ${whereClause}`,
      values
    );
    const total = Number(countResult.rows[0]?.total) || 0;

    const rows = await pool.query(
      `SELECT a.audit_id, a.user_id, a.clinic_id, a.action, a.resource_type, a.resource_id,
              a.metadata, a.created_at,
              u.full_name AS user_name, u.username, r.role_name AS user_role_name,
              c.clinic_name
       FROM audit_logs a
       LEFT JOIN users u ON u.user_id = a.user_id
       LEFT JOIN clinics c ON c.clinic_id = a.clinic_id
       LEFT JOIN roles r ON r.role_id = u.role_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`,
      [...values, limit, offset]
    );

    return res.status(200).json({
      logs: rows.rows.map((row) => ({
        audit_id: row.audit_id,
        user_id: row.user_id,
        clinic_id: row.clinic_id,
        user_name: row.user_name,
        username: row.username,
        user_role_name: row.user_role_name,
        clinic_name: row.clinic_name,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        metadata: row.metadata,
        created_at: row.created_at,
      })),
      total,
      page,
      limit,
    });
  } catch (error) {
    console.error('Audit list error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
};
