import { Router } from 'express';
import {
	createPatient, getPatients, createVisit, getPatientVisits,
	sharePatientRecord, listPatientShares, revokePatientShare, getUnifiedMedicalRecord,
	getMedicalProfile, saveMedicalProfile,
} from './patients.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware'; // <-- التأكد من وجود ../../
import { validateBody } from '../../middlewares/validate.middleware';
import { patientSchema, visitSchema, medicalProfileSchema } from '../../validations/business.validation';

const router = Router();

// جميع المسارات متطلبة لتوثيق الـ JWT أولاً
router.use(authenticateJWT);

// مسارات إدارة المرضى
router.post('/', requirePermission('CREATE_PATIENT'), validateBody(patientSchema), createPatient);
router.get('/', requirePermission('VIEW_PATIENTS'), getPatients);

// مسارات إدارة الزيارات الطبية
router.post('/visits', requirePermission('CREATE_VISIT'), validateBody(visitSchema), createVisit);
router.get('/:patientId/visits', requirePermission('VIEW_PATIENTS'), getPatientVisits);
router.get('/:patientId/record', requirePermission('VIEW_SHARED_PATIENT_RECORDS'), getUnifiedMedicalRecord);
router.get('/:patientId/medical-profile', requirePermission('VIEW_PATIENTS'), getMedicalProfile);
router.put('/:patientId/medical-profile', requirePermission('EDIT_PATIENT_MEDICAL'), validateBody(medicalProfileSchema), saveMedicalProfile);
router.post('/:patientId/shares', requirePermission('SHARE_PATIENT_RECORDS'), sharePatientRecord);
router.get('/:patientId/shares', requirePermission('SHARE_PATIENT_RECORDS'), listPatientShares);
router.delete('/:patientId/shares/:shareId', requirePermission('SHARE_PATIENT_RECORDS'), revokePatientShare);

export default router;