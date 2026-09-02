import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: number;
    roleId: number;
    clinicId: number | null;
    roleName?: string;
    permissions?: string[];
  };
}

// 1. التحقق من صحة توكن JWT (Authentication)
export const authenticateJWT = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'تنسيق التوكن غير صالح أو غير موجود' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: number;
      roleId: number;
      clinicId: number | null;
    };

    // جلب اسم الدور والصلاحيات المرتبطة بـ role_id من قاعدة البيانات
    const roleAndPermissionsQuery = await pool.query(
      `SELECT r.role_name, p.permission_key 
       FROM roles r
       LEFT JOIN role_permissions rp ON r.role_id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.permission_id
       WHERE r.role_id = $1`,
      [decoded.roleId]
    );

    if (roleAndPermissionsQuery.rows.length === 0) {
      return res.status(403).json({ message: 'الدور الخاص بك غير معرف بالنظام' });
    }

    const roleName = roleAndPermissionsQuery.rows[0].role_name;
    const permissions = roleAndPermissionsQuery.rows
      .map((row) => row.permission_key)
      .filter((key) => key !== null);

    req.user = {
      userId: decoded.userId,
      roleId: decoded.roleId,
      clinicId: decoded.clinicId,
      roleName,
      permissions,
    };

    next();
  } catch (error) {
    return res.status(403).json({ message: 'رمز التوكن غير صالح أو منتهي الصلاحية' });
  }
};

// 2. التحقق من الصلاحية المحددة (Permission Authorization)
export const requirePermission = (requiredPermission: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: 'المستخدم غير موثق' });
    }

    // مدير النظام يملك صلاحية كاملة لتجاوز الفحص
    if (
      req.user.roleName === 'SYSTEM_ADMIN' ||
      (req.user.permissions && req.user.permissions.includes(requiredPermission))
    ) {
      return next();
    }

    return res.status(403).json({
      message: 'عذراً، لا تمتلك الصلاحية الكافية لتنفيذ هذا الإجراء',
    });
  };
};