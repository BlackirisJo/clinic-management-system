import { Router } from 'express';
import {
  createAppointment,
  getAppointments,
  updateAppointmentStatus,
} from './appointments.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';

const router = Router();

router.use(authenticateJWT);

// حجز موعد جديد
router.post('/', requirePermission('MANAGE_APPOINTMENTS'), createAppointment);

// عرض وتصفية المواعيد
router.get('/', requirePermission('VIEW_APPOINTMENTS'), getAppointments);

// تحديث حالة الموعد
router.patch('/:id/status', requirePermission('MANAGE_APPOINTMENTS'), updateAppointmentStatus);

export default router;