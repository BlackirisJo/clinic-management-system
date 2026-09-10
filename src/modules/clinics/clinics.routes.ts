import { Router } from 'express';
import {
  listClinics, listClinicDirectory, getClinic, createClinic, updateClinic,
  listClinicStaff, addClinicStaff, updateClinicStaff, removeClinicStaff,
} from './clinics.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import { clinicSchema, clinicStaffSchema, clinicStaffUpdateSchema } from '../../validations/business.validation';

const router = Router();

// دليل العيادات النشطة (بالاسم) — أي مستخدم مسجل دخول يمكنه الاختيار بالاسم
router.get('/directory', authenticateJWT, listClinicDirectory);

// إدارة العيادات — متاحة لمدير النظام فقط (صلاحية MANAGE_CLINICS)
router.use(authenticateJWT, requirePermission('MANAGE_CLINICS'));
router.get('/', listClinics);
router.post('/', validateBody(clinicSchema), createClinic);
router.get('/:clinicId', getClinic);
router.put('/:clinicId', validateBody(clinicSchema), updateClinic);

// إسناد وإدارة فريق العمل (الأطباء والممرضين) على العيادة
router.get('/:clinicId/staff', listClinicStaff);
router.post('/:clinicId/staff', validateBody(clinicStaffSchema), addClinicStaff);
router.put('/:clinicId/staff/:userId', validateBody(clinicStaffUpdateSchema), updateClinicStaff);
router.delete('/:clinicId/staff/:userId', removeClinicStaff);

export default router;