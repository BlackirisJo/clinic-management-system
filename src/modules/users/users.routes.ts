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
// قائمة الأطباء لحجز المواعيد — متاحة لكل من يملك صلاحية عرض المواعيد (استقبال/طبيب/ممرض)
router.get('/doctors', requirePermission('VIEW_APPOINTMENTS'), listDoctors);
// بقية مسارات إدارة المستخدمين — تتطلب صلاحية إدارة المستخدمين (إدارة النظام فقط)
router.get('/', requirePermission('MANAGE_USERS'), listUsers);
router.post('/', requirePermission('MANAGE_USERS'), validate(createUserSchema), createUser);
router.patch('/:id', requirePermission('MANAGE_USERS'), validate(updateUserSchema), updateUser);

export default router;