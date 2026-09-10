import { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import { authenticateJWT, AuthenticatedRequest, requirePermission } from '../../middlewares/auth.middleware';
import { createUser, listUsers, updateUser, listDoctors } from './users.controller';
import { createUserSchema, updateUserSchema } from './users.validation';

const router = Router();
const validate = (schema: z.ZodType) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ message: 'بيانات المستخدم غير صالحة', errors: result.error });
  req.body = result.data;
  return next();
};

// التوثيق مطلوب لجميع مسارات المستخدمين
router.use(authenticateJWT);
// قائمة الأطباء — متاحة لكل من يملك صلاحية عرض المواعيد أو التعامل المالي (لاختيار الطبيب بالاسم في الفواتير)
// بدل قصرها على VIEW_APPOINTMENTS فقط الذي كان يمنع المحاسب من رؤية الأسماء
const allowDoctorsList = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (req.user?.roleName === 'SUPER_ADMIN' || req.user?.roleName === 'SYSTEM_ADMIN') return next();
  const perms = req.user?.permissions ?? [];
  const allowed = ['VIEW_APPOINTMENTS', 'MANAGE_APPOINTMENTS', 'CREATE_INVOICE', 'VIEW_INVOICES', 'MANAGE_SERVICES', 'VIEW_FINANCIAL_REPORTS'];
  if (allowed.some((k) => perms.includes(k))) return next();
  return res.status(403).json({ message: 'عذراً، لا تمتلك الصلاحية الكافية لتنفيذ هذا الإجراء' });
};
router.get('/doctors', allowDoctorsList, listDoctors);
// بقية مسارات إدارة المستخدمين — تتطلب صلاحية إدارة المستخدمين (إدارة النظام فقط)
router.get('/', requirePermission('MANAGE_USERS'), listUsers);
router.post('/', requirePermission('MANAGE_USERS'), validate(createUserSchema), createUser);
router.patch('/:id', requirePermission('MANAGE_USERS'), validate(updateUserSchema), updateUser);

export default router;