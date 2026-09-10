import { Router } from 'express';
import multer from 'multer';
import {
  getVisitDetails, updateVisitClinical,
  addVitalSign, deleteVitalSign,
  addDiagnosis, deleteDiagnosis,
  createLabOrder, updateLabOrder, saveLabResults,
  createImaging, updateImaging,
  createReferral,
  uploadAttachment, downloadAttachment, deleteAttachment,
} from './visits.controller';
import {
  listPregnancies, getPregnancyDetails, createPregnancy, updatePregnancy,
  createPregnancyVisit, updatePregnancyVisit, deletePregnancyVisit,
  createUltrasound, updateUltrasound, deleteUltrasound,
} from './pregnancies.controller';
import { listSpecialties } from './specialties.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import {
  visitClinicalSchema, vitalSignSchema, diagnosisSchema,
  labOrderSchema, labOrderUpdateSchema, labResultSchema,
  imagingSchema, referralSchema,
  pregnancySchema, pregnancyCreateSchema, pregnancyUpdateSchema, pregnancyVisitSchema, pregnancyVisitUpdateSchema,
  ultrasoundSchema, ultrasoundUpdateSchema,
} from './clinical.validation';

const router = Router();
const upload = multer({
  dest: 'uploads/visits/',
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.use(authenticateJWT);

// التخصصات الطبية — متاحة لجميع المستخدمين الموثقين (لعرض workflow العيادة)
router.get('/specialties', listSpecialties);

// ===== بيانات الزيارة السريرية =====
router.get('/visits/:visitId', getVisitDetails);
router.patch('/visits/:visitId', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(visitClinicalSchema), updateVisitClinical);
router.post('/visits/:visitId/vitals', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(vitalSignSchema), addVitalSign);
router.delete('/visits/:visitId/vitals/:vitalId', requirePermission('MANAGE_CLINICAL_DATA'), deleteVitalSign);
router.post('/visits/:visitId/diagnoses', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(diagnosisSchema), addDiagnosis);
router.delete('/visits/:visitId/diagnoses/:diagnosisId', requirePermission('MANAGE_CLINICAL_DATA'), deleteDiagnosis);
router.post('/visits/:visitId/lab-orders', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(labOrderSchema), createLabOrder);
router.patch('/visits/:visitId/lab-orders/:orderId', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(labOrderUpdateSchema), updateLabOrder);
router.put('/visits/:visitId/lab-orders/:orderId/results', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(labResultSchema), saveLabResults);
router.post('/visits/:visitId/imaging', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(imagingSchema), createImaging);
router.patch('/visits/:visitId/imaging/:imagingId', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(imagingSchema.partial()), updateImaging);
router.post('/visits/:visitId/referrals', requirePermission('MANAGE_CLINICAL_DATA'), validateBody(referralSchema), createReferral);
router.post('/visits/:visitId/attachments', requirePermission('MANAGE_CLINICAL_DATA'), upload.single('file'), uploadAttachment);
router.get('/attachments/:attachmentId/download', downloadAttachment);
router.delete('/attachments/:attachmentId', requirePermission('MANAGE_CLINICAL_DATA'), deleteAttachment);

// ===== سجلات الحمل (النسائية والتوليد) =====
router.get('/pregnancies', listPregnancies);
router.get('/pregnancies/:pregnancyId', getPregnancyDetails);
router.post('/pregnancies', requirePermission('MANAGE_PREGNANCY'), validateBody(pregnancyCreateSchema), createPregnancy);
router.patch('/pregnancies/:pregnancyId', requirePermission('MANAGE_PREGNANCY'), validateBody(pregnancyUpdateSchema), updatePregnancy);
router.post('/pregnancies/:pregnancyId/visits', requirePermission('MANAGE_PREGNANCY'), validateBody(pregnancyVisitSchema), createPregnancyVisit);
router.patch('/pregnancies/:pregnancyId/visits/:pvId', requirePermission('MANAGE_PREGNANCY'), validateBody(pregnancyVisitUpdateSchema), updatePregnancyVisit);
router.delete('/pregnancies/:pregnancyId/visits/:pvId', requirePermission('MANAGE_PREGNANCY'), deletePregnancyVisit);
router.post('/pregnancies/:pregnancyId/ultrasounds', requirePermission('MANAGE_PREGNANCY'), validateBody(ultrasoundSchema), createUltrasound);
router.patch('/pregnancies/:pregnancyId/ultrasounds/:usId', requirePermission('MANAGE_PREGNANCY'), validateBody(ultrasoundUpdateSchema), updateUltrasound);
router.delete('/pregnancies/:pregnancyId/ultrasounds/:usId', requirePermission('MANAGE_PREGNANCY'), deleteUltrasound);

export default router;