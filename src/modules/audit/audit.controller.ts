import type { Response } from 'express';
import { pool } from '../../config/database';
import type { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import * as XLSX from 'xlsx';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EXPORT_SAFETY_LIMIT = 100000;

function canAccessLogs(req: AuthenticatedRequest): boolean {
  if (req.user?.roleName === 'SUPER_ADMIN') return true;
  if (req.user?.roleName === 'SYSTEM_ADMIN' && (req.user.permissions?.includes('VIEW_SYSTEM_LOGS') ?? false)) return true;
  return false;
}

function buildLogFilters(query: Record<string, string>) {
  const filters: string[] = [];
  const values: (string | number)[] = [];
  let paramIndex = 0;

  const {
    action,
    resource_type,
    user_name,
    clinic_name,
    date_from,
    date_to,
    search,
  } = query;

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

  return { filters, values, paramIndex, whereClause: filters.length ? `WHERE ${filters.join(' AND ')}` : '' };
}

function escapeCSV(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function formatLogRow(row: Record<string, unknown>): string[] {
  return [
    row.created_at ? new Date(row.created_at as string).toISOString() : '',
    (row.user_name as string) || '',
    (row.user_role_name as string) || '',
    (row.clinic_name as string) || '',
    (row.action as string) || '',
    (row.resource_type as string) || '',
    (row.resource_id as string) || '',
    row.metadata ? JSON.stringify(row.metadata) : '',
  ];
}

function buildCSV(data: Record<string, unknown>[]): string {
  const headers = ['Date/Time', 'User', 'Role', 'Clinic', 'Action', 'Resource Type', 'Resource ID', 'Metadata'];
  const lines = [headers.map(escapeCSV).join(',')];
  for (const row of data) {
    lines.push(formatLogRow(row).map(escapeCSV).join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

export const list = async (req: AuthenticatedRequest, res: Response) => {
  if (!canAccessLogs(req)) {
    return res.status(403).json({ message: 'غير مصرّح' });
  }

  const rawPage = parseInt(req.query.page as string || '', 10);
  const rawLimit = parseInt(req.query.limit as string || '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : DEFAULT_PAGE;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT ? rawLimit : DEFAULT_LIMIT;

  const offset = (page - 1) * limit;
  const { filters, values, paramIndex, whereClause } = buildLogFilters(req.query as Record<string, string>);

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

export const exportCSV = async (req: AuthenticatedRequest, res: Response) => {
  if (!canAccessLogs(req)) {
    return res.status(403).json({ message: 'غير مصرّح' });
  }

  try {
    const { filters, values, whereClause } = buildLogFilters(req.query as Record<string, string>);
    const data = await pool.query(
      `SELECT a.created_at, a.action, a.resource_type, a.resource_id, a.metadata,
              u.full_name AS user_name, u.username, r.role_name AS user_role_name, c.clinic_name
       FROM audit_logs a
       LEFT JOIN users u ON u.user_id = a.user_id
       LEFT JOIN clinics c ON c.clinic_id = a.clinic_id
       LEFT JOIN roles r ON r.role_id = u.role_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${values.length + 1}`,
      [...values, EXPORT_SAFETY_LIMIT]
    );
    const rows = data.rows.map((row) => ({
      created_at: row.created_at,
      user_name: row.user_name,
      user_role_name: row.user_role_name,
      clinic_name: row.clinic_name,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      metadata: row.metadata,
    }));
    const csv = buildCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="system_logs.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    console.error('Audit export CSV error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
};

export const exportExcel = async (req: AuthenticatedRequest, res: Response) => {
  if (!canAccessLogs(req)) {
    return res.status(403).json({ message: 'غير مصرّح' });
  }

  try {
    const { filters, values, whereClause } = buildLogFilters(req.query as Record<string, string>);
    const data = await pool.query(
      `SELECT a.created_at, a.action, a.resource_type, a.resource_id, a.metadata,
              u.full_name AS user_name, u.username, r.role_name AS user_role_name, c.clinic_name
       FROM audit_logs a
       LEFT JOIN users u ON u.user_id = a.user_id
       LEFT JOIN clinics c ON c.clinic_id = a.clinic_id
       LEFT JOIN roles r ON r.role_id = u.role_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${values.length + 1}`,
      [...values, EXPORT_SAFETY_LIMIT]
    );
    const rows = data.rows.map((row) => ({
      'Date/Time': row.created_at ? new Date(row.created_at as string).toISOString() : '',
      User: row.user_name || '',
      Role: row.user_role_name || '',
      Clinic: row.clinic_name || '',
      Action: row.action || '',
      'Resource Type': row.resource_type || '',
      'Resource ID': row.resource_id || '',
      Metadata: row.metadata ? JSON.stringify(row.metadata) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'System Logs');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="system_logs.xlsx"');
    return res.status(200).send(buf);
  } catch (error) {
    console.error('Audit export Excel error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
};
