import { Router } from 'express';
import {
	createPatient, getPatients, createVisit, getPatientVisits,
	sharePatientRecord, listPatientShares, revokePatientShare, getUnifiedMedicalRecord,
} from './patients.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware'; // <-- التأكد من وجود ../../

const router = Router();

// جميع المسارات متطلبة لتوثيق الـ JWT أولاً
router.use(authenticateJWT);

// مسارات إدارة المرضى
router.post('/', requirePermission('CREATE_PATIENT'), createPatient);
router.get('/', requirePermission('VIEW_PATIENTS'), getPatients);

// مسارات إدارة الزيارات الطبية
router.post('/visits', requirePermission('CREATE_VISIT'), createVisit);
router.get('/:patientId/visits', requirePermission('VIEW_PATIENTS'), getPatientVisits);
router.get('/:patientId/record', requirePermission('VIEW_SHARED_PATIENT_RECORDS'), getUnifiedMedicalRecord);
router.post('/:patientId/shares', requirePermission('SHARE_PATIENT_RECORDS'), sharePatientRecord);
router.get('/:patientId/shares', requirePermission('SHARE_PATIENT_RECORDS'), listPatientShares);
router.delete('/:patientId/shares/:shareId', requirePermission('SHARE_PATIENT_RECORDS'), revokePatientShare);

export default router;