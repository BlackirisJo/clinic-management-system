import { Router } from 'express';
import {
  createMedication,
  getMedications,
  updateMedication,
  deleteMedication,
  createPrescription,
  getPrescriptionById,
  getPharmacyQueue,
} from './prescriptions.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import { prescriptionSchema } from '../../validations/business.validation';
import {
  getRepeatAuthorization,
  createRepeatAuthorization,
  updateRepeatAuthorization,
  cancelRepeatAuthorization,
} from './repeatAuthorizations.controller';
import { recordFulfilmentDecision } from './fulfilmentDecisions.controller';

const router = Router();

// جميع المسارات محمية بالتوثيق
router.use(authenticateJWT);

// مسارات الدليل العام للأدوية
router.post('/medications', requirePermission('MANAGE_MEDICATIONS'), createMedication);
router.get('/medications', requirePermission('VIEW_MEDICATIONS'), getMedications);
router.put('/medications/:id', requirePermission('MANAGE_MEDICATIONS'), updateMedication);
router.delete('/medications/:id', requirePermission('MANAGE_MEDICATIONS'), deleteMedication);

// مسارات الصيدلية
router.get('/pharmacy/queue', requirePermission('VIEW_PHARMACY_QUEUE'), getPharmacyQueue);

// مسارات الروشتة الطبية
router.post('/', requirePermission('CREATE_PRESCRIPTION'), validateBody(prescriptionSchema), createPrescription);

// --- تفويض صرف متكرر (Phase 10C.4C) ---
// قرار سريري → CREATE_PRESCRIPTION (لا صلاحية جديدة). لا يُشتق من repeats_count.
// تسبق /:id بالضرورة: Express يطابق بالترتيب، و/:id كان يلتقط هذا المسار أولاً.
router.get('/items/:itemId/repeat-authorization', requirePermission('VIEW_PRESCRIPTIONS'), getRepeatAuthorization);
router.post('/items/:itemId/repeat-authorization', requirePermission('CREATE_PRESCRIPTION'), createRepeatAuthorization);
router.put('/items/:itemId/repeat-authorization', requirePermission('CREATE_PRESCRIPTION'), updateRepeatAuthorization);
router.delete('/items/:itemId/repeat-authorization', requirePermission('CREATE_PRESCRIPTION'), cancelRepeatAuthorization);

// --- قرار المريض بشأن التنفيذ (Phase 10F.1) ---
// صلاحية مستقلة (Phase 10F.2) لا CREATE_PRESCRIPTION: تسجيل رأي المريض ليس
// كتابة روشتة، والصيدلي الذي يسأل المريض في الصيدلية لا يملك CREATE_PRESCRIPTION.
// الفعل الوحيد المُمنح هو تسجيل القرار — لا صرف ولا فاتورة ولا خصم مخزون.
router.patch('/items/:id/fulfilment', requirePermission('RECORD_PRESCRIPTION_FULFILMENT'), recordFulfilmentDecision);

// العرض من داخل ملف المريض متاح لأي دور يملك عرض المرضى (طبيب/ممرض/استقبال)، مع فحص العيادة داخل الكنترولر
router.get('/:id', requirePermission('VIEW_PATIENTS'), getPrescriptionById);

export default router;
