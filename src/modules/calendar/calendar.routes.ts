import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  cancelHoliday,
  createException,
  createHoliday,
  createLeave,
  decideException,
  decideLeave,
  holidayImpact,
  listChanges,
  listExceptions,
  listHolidays,
  listLeave,
  listNotifications,
  previewGate,
  updateHoliday,
} from './calendar.controller';

const router = Router();

router.use(authenticateJWT);

// ————— العطل الرسمية —————
router.get('/holidays', requirePermission('VIEW_HOLIDAYS'), listHolidays);
router.post('/holidays', requirePermission('MANAGE_HOLIDAYS'), createHoliday);
router.get('/holidays/:id/impact', requirePermission('VIEW_SCHEDULE_IMPACT'), holidayImpact);
router.patch('/holidays/:id', requirePermission('MANAGE_HOLIDAYS'), updateHoliday);
router.post('/holidays/:id/cancel', requirePermission('APPROVE_HOLIDAYS'), cancelHoliday);

// ————— إجازات الأطباء —————
router.get('/leave', requirePermission('VIEW_DOCTOR_LEAVE'), listLeave);
router.post('/leave', requirePermission('MANAGE_DOCTOR_LEAVE'), createLeave);
router.patch('/leave/:id', requirePermission('APPROVE_DOCTOR_LEAVE'), decideLeave);

// ————— استثناءات العمل —————
router.get('/exceptions', requirePermission('VIEW_HOLIDAYS'), listExceptions);
router.post('/exceptions', requirePermission('MANAGE_WORK_EXCEPTIONS'), createException);
router.patch('/exceptions/:id', requirePermission('APPROVE_WORK_EXCEPTIONS'), decideException);

// ————— الأثر والسجلّات —————
router.get('/impact', requirePermission('VIEW_SCHEDULE_IMPACT'), holidayImpact);
router.get('/notifications', requirePermission('VIEW_HOLIDAYS'), listNotifications);
router.get('/changes', requirePermission('VIEW_HOLIDAYS'), listChanges);
router.get('/gate', requirePermission('VIEW_HOLIDAYS'), previewGate);

export default router;
