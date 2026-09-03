import { Router } from 'express';
import {
  createMedication,
  getMedications,
  createPrescription,
  getPrescriptionById,
} from './prescriptions.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import { prescriptionSchema } from '../../validations/business.validation';

const router = Router();

// جميع المسارات محمية بالتوثيق
router.use(authenticateJWT);

// مسارات الدليل العام للأدوية
router.post('/medications', requirePermission('MANAGE_MEDICATIONS'), createMedication);
router.get('/medications', requirePermission('VIEW_MEDICATIONS'), getMedications);

// مسارات الروشتة الطبية
router.post('/', requirePermission('CREATE_PRESCRIPTION'), validateBody(prescriptionSchema), createPrescription);
router.get('/:id', requirePermission('VIEW_PRESCRIPTIONS'), getPrescriptionById);

export default router;