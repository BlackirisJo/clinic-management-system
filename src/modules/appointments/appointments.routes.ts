import { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import {
  createAppointment,
  getAppointments,
  updateAppointmentStatus,
} from './appointments.controller';
import { authenticateJWT, requirePermission, AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../middlewares/error.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { createAppointmentSchema, updateAppointmentStatusSchema } from './appointments.validation';

const router = Router();

const validate = (schema: z.ZodType) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new AppError('بيانات الطلب غير صالحة', 400, ApiErrorCode.VALIDATION_ERROR, true, result.error));
    }
    req.body = result.data;
    return next();
  };
};

// تطبيق التوثيق (JWT) على جميع مسارات المواعيد
router.use(authenticateJWT);

// 1. إنشاء حجز موعد جديد
router.post(
  '/', 
  requirePermission('MANAGE_APPOINTMENTS'), 
  validate(createAppointmentSchema),
  createAppointment
);

// 2. عرض وتصفية المواعيد (حسب الطبيب، المريض، أو التاريخ)
router.get(
  '/', 
  requirePermission('VIEW_APPOINTMENTS'), 
  getAppointments
);

// 3. تحديث حالة الموعد (تأكيد، إلغاء، إكمال الحضور، إلخ)
router.patch(
  '/:id/status', 
  requirePermission('MANAGE_APPOINTMENTS'), 
  validate(updateAppointmentStatusSchema),
  updateAppointmentStatus
);

export default router;