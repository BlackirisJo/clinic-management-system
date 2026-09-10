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
// العرض من داخل ملف المريض متاح لأي دور يملك عرض المرضى (طبيب/ممرض/استقبال)، مع فحص العيادة داخل الكنترولر
router.get('/:id', requirePermission('VIEW_PATIENTS'), getPrescriptionById);

export default router;