import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { AppError } from './error.middleware';

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
    /** جميع العيادات المسند للمستخدم (الأساسية + الإسنادات الإضافية) — تُحمّل من قاعدة البيانات عند كل طلب */
    clinicIds?: number[];
  };
  patient?: { patientId: number; jti: string };
}

const isAdminRole = (roleName?: string) => roleName === 'SUPER_ADMIN' || roleName === 'SYSTEM_ADMIN';

// هل المستخدم مسند (أساسي أو إسناد إضافي) إلى عيادة معينة؟
export const isAssignedToClinic = (req: AuthenticatedRequest, clinicId: number): boolean => {
  if (req.user?.clinicIds?.length) return req.user.clinicIds.includes(clinicId);
  return req.user?.clinicId === clinicId;
};

// هل يملك المستخدم وصولاً إدارياً شاملاً لكل العيادات؟
export const canManageAllClinics = (req: AuthenticatedRequest): boolean => isAdminRole(req.user?.roleName);

// قائمة العيادات التي يمكن للمستخدم الوصول إليها (null = كل العيادات للمدراء)
export const accessibleClinicIds = (req: AuthenticatedRequest): number[] | null => {
  if (isAdminRole(req.user?.roleName)) return null;
  return req.user?.clinicIds ?? (req.user?.clinicId !== null && req.user?.clinicId !== undefined ? [req.user.clinicId] : []);
};

// هل المستخدم "مالي مركزي" يتعامل مع كل العيادات النشطة دون تقييد بالإسناد؟
// الأدوار المالية المركزية: SUPER_ADMIN, SYSTEM_ADMIN (عبر canManageAllClinics)
// (بالإضافة لأي دور يملك صلاحية مالية إدارية كـ MANAGE_SERVICES أو CREATE_EXPENSE)
export const isGlobalFinanceRole = (req: AuthenticatedRequest): boolean => {
  if (canManageAllClinics(req)) return true;
  const perms: string[] = req.user?.permissions ?? [];
  return perms.includes('MANAGE_SERVICES') || perms.includes('CREATE_EXPENSE');
};

// نطاق العيادات للعمليات المالية — مصدر الحقيقة الموحد.
// - المدراء (SUPER_ADMIN, SYSTEM_ADMIN): يرون كل العيادات (via canManageAllClinics).
// - الأدوار التي تملك MANAGE_SERVICES أو CREATE_EXPENSE: ترجع null = كل العيادات.
// - باقي المستخدمين: قائمة عياداتهم المسندة (الأساسية + clinic_staff).
export const financeClinicScope = (req: AuthenticatedRequest): number[] | null => {
  if (isGlobalFinanceRole(req)) return null;
  return accessibleClinicIds(req);
};

// تحميل جميع العيادات المسند إليها المستخدم (الأساسية + جدول العلاقة clinic_staff)
const loadUserClinicIds = async (userId: number, primaryClinicId: number | null): Promise<number[]> => {
  const result = await pool.query(
    `SELECT clinic_id FROM clinic_staff WHERE user_id = $1`,
    [userId]
  );
  const ids = new Set<number>(result.rows.map((row) => Number(row.clinic_id)));
  if (primaryClinicId !== null && primaryClinicId !== undefined) ids.add(Number(primaryClinicId));
  return [...ids];
};

// 1. التحقق من صحة توكن JWT (Authentication)
export const authenticateJWT = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Phase 3: code مستقر للترجمة في الواجهة — message والـ status كما هما تماماً
    return res.status(401).json({ message: 'تنسيق التوكن غير صالح أو غير موجود', code: ApiErrorCode.TOKEN_MISSING });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'رمز التوكن غير موجود', code: ApiErrorCode.TOKEN_INVALID });
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

    // إشارة صريحة للواجهة أن الجلسة غير صالحة (تنتهي بمعالجة مركزية وإعادة لتسجيل الدخول)
    // Phase 3: INVALID_SESSION يميّز توكناً بلا jti — نفس shape الـ SESSION_REVOKED ولا يغيّر أي status
    if (!decoded.jti) return res.status(403).json({ message: 'الجلسة غير صالحة', code: ApiErrorCode.INVALID_SESSION });
    const session = await pool.query(
      `SELECT 1 FROM user_sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.jti = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > NOW() AND u.status = 'ACTIVE'`,
      [decoded.jti, decoded.userId]
    );
    if (!session.rowCount) return res.status(403).json({ message: 'انتهت صلاحية جلستك أو تم إنهاؤها من قبل مدير النظام', code: ApiErrorCode.SESSION_REVOKED });

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
      return res.status(403).json({ message: 'الدور الخاص بك غير معرف بالنظام', code: ApiErrorCode.ROLE_UNKNOWN });
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
      clinicIds: await loadUserClinicIds(decoded.userId, decoded.clinicId),
    };
    req.authToken = { jti: decoded.jti };

    return next();
  } catch (error) {
    // توكن غير صالح أو منتهي الصلاحية — الواجهة تعامله كنهاية جلسة وتعيد المستخدم لتسجيل الدخول
    return res.status(403).json({ message: 'رمز التوكن غير صالح أو منتهي الصلاحية', code: ApiErrorCode.TOKEN_EXPIRED });
  }
};

// 2. التحقق من الصلاحية المحددة (Permission Authorization)
export const requirePermission = (requiredPermission: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('المستخدم غير موثق', 401, ApiErrorCode.UNAUTHENTICATED));
    }

    // السماح لكل من SUPER_ADMIN و SYSTEM_ADMIN بتجاوز الفحص
    if (
      req.user.roleName === 'SUPER_ADMIN' ||
      req.user.roleName === 'SYSTEM_ADMIN' ||
      (req.user.permissions && req.user.permissions.includes(requiredPermission))
    ) {
      return next();
    }

    return next(new AppError('عذراً، لا تمتلك الصلاحية الكافية لتنفيذ هذا الإجراء', 403, ApiErrorCode.FORBIDDEN));
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