import { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import {
  createDoctorSchedule,
  getDoctorSchedules,
  getDoctorSchedule,
  updateDoctorSchedule,
  deleteDoctorSchedule,
  getDoctorAvailability,
  getDoctorWeeklySchedule,
} from './doctorSchedules.controller';
import { authenticateJWT, requirePermission, AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../middlewares/error.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import {
  createDoctorScheduleSchema,
  updateDoctorScheduleSchema,
  doctorScheduleQuerySchema,
  availabilityQuerySchema,
} from './doctorSchedules.validation';

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

const validateQuery = (schema: z.ZodType) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new AppError('معاملات الاستعلام غير صالحة', 400, ApiErrorCode.VALIDATION_ERROR, true, result.error));
    }
    return next();
  };
};

router.use(authenticateJWT);

router.post(
  '/',
  requirePermission('MANAGE_DOCTOR_SCHEDULES'),
  validate(createDoctorScheduleSchema),
  createDoctorSchedule
);

router.get(
  '/',
  requirePermission('VIEW_DOCTOR_SCHEDULES'),
  validateQuery(doctorScheduleQuerySchema),
  getDoctorSchedules
);

router.get(
  '/availability',
  requirePermission('VIEW_DOCTOR_SCHEDULES'),
  validateQuery(availabilityQuerySchema),
  getDoctorAvailability
);

router.get(
  '/weekly',
  requirePermission('VIEW_DOCTOR_SCHEDULES'),
  validateQuery(doctorScheduleQuerySchema),
  getDoctorWeeklySchedule
);

router.get(
  '/:id',
  requirePermission('VIEW_DOCTOR_SCHEDULES'),
  getDoctorSchedule
);

router.patch(
  '/:id',
  requirePermission('MANAGE_DOCTOR_SCHEDULES'),
  validate(updateDoctorScheduleSchema),
  updateDoctorSchedule
);

router.delete(
  '/:id',
  requirePermission('MANAGE_DOCTOR_SCHEDULES'),
  deleteDoctorSchedule
);

export default router;