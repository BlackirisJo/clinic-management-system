import { Router } from 'express';
import multer from 'multer';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  generateMedicationTemplate,
  validateMedicationImport,
  executeMedicationImport,
} from './medication.import.controller';

const router = Router();

// رفع ملف في الذاكرة فقط (بدون حفظ على القرص) — حد أقصى 5MB وامتداد .csv فقط
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const isCsv = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || file.originalname.toLowerCase().endsWith('.csv');
    if (isCsv) return callback(null, true);
    return callback(new Error('الملف يجب أن يكون بصيغة CSV'));
  },
});

router.use(authenticateJWT);

// تحميل نموذج CSV فارغ
router.get('/import/template', requirePermission('VIEW_MEDICATIONS'), generateMedicationTemplate);

// فحص الملف وإرجاع Preview
router.post('/import/validate', requirePermission('MANAGE_MEDICATIONS'), upload.single('file'), validateMedicationImport);

// تنفيذ الاستيراد
router.post('/import', requirePermission('MANAGE_MEDICATIONS'), upload.single('file'), executeMedicationImport);

export default router;