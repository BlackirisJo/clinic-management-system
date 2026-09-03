import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database';

export interface AuthenticatedRequest extends Request {
  authToken?: {
    jti: string;
  };
  user?: {
    userId: number;
    roleId: number;
    clinicId: number | null;
    roleName?: string;
    permissions?: string[];
  };
  patient?: { patientId: number; jti: string };
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

  if (!token) {
    return res.status(401).json({ message: 'رمز التوكن غير موجود' });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      return res.status(500).json({ message: 'إعدادات التوثيق غير مكتملة على الخادم' });
    }
    
    // استخدام التحويل إلى unknown أولاً لتجنب خطأ TS2352
    const decoded = jwt.verify(token, JWT_SECRET) as unknown as {
      userId: number;
      roleId: number;
      clinicId: number | null;
      jti?: string;
    };

    if (!decoded.jti) return res.status(403).json({ message: 'الجلسة غير صالحة' });
    const session = await pool.query(
      `SELECT 1 FROM user_sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.jti = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > NOW() AND u.status = 'ACTIVE'`,
      [decoded.jti, decoded.userId]
    );
    if (!session.rowCount) return res.status(403).json({ message: 'الجلسة منتهية أو ملغاة' });

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

    const roleName = roleAndPermissionsQuery.rows[0]?.role_name;
    const permissions = roleAndPermissionsQuery.rows
      .map((row) => row.permission_key)
      .filter((key): key is string => key !== null && key !== undefined);

    req.user = {
      userId: decoded.userId,
      roleId: decoded.roleId,
      clinicId: decoded.clinicId,
      roleName,
      permissions,
    };
    req.authToken = { jti: decoded.jti };

    return next();
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

    // السماح لكل من SUPER_ADMIN و SYSTEM_ADMIN بتجاوز الفحص
    if (
      req.user.roleName === 'SUPER_ADMIN' ||
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

export const authenticatePatientJWT = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!token) return res.status(401).json({ message: 'رمز دخول المريض غير موجود' });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ message: 'إعدادات التوثيق غير مكتملة على الخادم' });
    const decoded = jwt.verify(token, secret) as { patientId?: number; kind?: string; jti?: string };
    if (decoded.kind !== 'PATIENT' || !decoded.patientId || !decoded.jti) return res.status(403).json({ message: 'رمز المريض غير صالح' });
    const session = await pool.query(
      `SELECT 1 FROM patient_sessions WHERE patient_id = $1 AND jti = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
      [decoded.patientId, decoded.jti]
    );
    if (!session.rowCount) return res.status(403).json({ message: 'جلسة المريض منتهية أو ملغاة' });
    req.patient = { patientId: decoded.patientId, jti: decoded.jti };
    return next();
  } catch {
    return res.status(403).json({ message: 'رمز دخول المريض غير صالح أو منتهي الصلاحية' });
  }
};