import { Router } from 'express';
import { createPatient, getPatients, createVisit, getPatientVisits } from './patients.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';

const router = Router();

// جميع المسارات متطلبة لتوثيق الـ JWT أولاً
router.use(authenticateJWT);

// مسارات إدارة المرضى
router.post('/', requirePermission('CREATE_PATIENT'), createPatient);
router.get('/', requirePermission('VIEW_PATIENTS'), getPatients);

// مسارات إدارة الزيارات الطبية
router.post('/visits', requirePermission('CREATE_VISIT'), createVisit);
router.get('/:patientId/visits', requirePermission('VIEW_PATIENTS'), getPatientVisits);

export default router;