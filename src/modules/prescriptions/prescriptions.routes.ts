import { Router } from 'express';
import {
  createMedication,
  getMedications,
  createPrescription,
  getPrescriptionById,
} from './prescriptions.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';

const router = Router();

// جميع المسارات محمية بالتوثيق
router.use(authenticateJWT);

// مسارات الدليل العام للأدوية
router.post('/medications', requirePermission('MANAGE_MEDICATIONS'), createMedication);
router.get('/medications', requirePermission('VIEW_MEDICATIONS'), getMedications);

// مسارات الروشتة الطبية
router.post('/', requirePermission('CREATE_PRESCRIPTION'), createPrescription);
router.get('/:id', requirePermission('VIEW_PRESCRIPTIONS'), getPrescriptionById);

export default router;