import { Router } from 'express';
import { listClinics, createClinic, updateClinic } from './clinics.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import { clinicSchema } from '../../validations/business.validation';

const router = Router();

// إدارة العيادات — متاحة لمدير النظام فقط (صلاحية MANAGE_CLINICS)
router.use(authenticateJWT, requirePermission('MANAGE_CLINICS'));
router.get('/', listClinics);
router.post('/', validateBody(clinicSchema), createClinic);
router.put('/:clinicId', validateBody(clinicSchema), updateClinic);

export default router;