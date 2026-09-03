import { Router } from 'express';
import {
  createAppointment,
  getAppointments,
  updateAppointmentStatus,
} from './appointments.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';

const router = Router();

// تطبيق التوثيق (JWT) على جميع مسارات المواعيد
router.use(authenticateJWT);

// 1. إنشاء حجز موعد جديد
router.post(
  '/', 
  requirePermission('MANAGE_APPOINTMENTS'), 
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
  updateAppointmentStatus
);

export default router;