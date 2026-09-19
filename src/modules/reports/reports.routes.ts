import { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import { authenticateJWT, AuthenticatedRequest, requirePermission } from '../../middlewares/auth.middleware';
import { AppError } from '../../middlewares/error.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { getAppointmentsReport, getClinicalReport, getFinancialReport, getOverviewReport, getPatientsReport } from './reports.controller';
import { reportQuerySchema } from './reports.validation';

const router = Router();
const validate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const result = reportQuerySchema.safeParse(req.query);
  if (!result.success) return next(new AppError('معاملات التقرير غير صالحة', 400, ApiErrorCode.VALIDATION_ERROR, true, result.error));
  res.locals.reportQuery = result.data;
  return next();
};

router.use(authenticateJWT, requirePermission('VIEW_REPORTS'), validate);
router.get('/overview', getOverviewReport);
router.get('/financial', getFinancialReport);
router.get('/clinical', getClinicalReport);
router.get('/appointments', getAppointmentsReport);
router.get('/patients', getPatientsReport);

export default router;