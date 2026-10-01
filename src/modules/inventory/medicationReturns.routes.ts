import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  listMedicationReturns,
  getMedicationReturn,
  getMedicationReturnMovements,
  getMedicationReturnAudit,
  createMedicationReturn,
} from './medicationReturns.controller';

const router = Router();

// كل مسارات الإرجاع محمية بالتوثيق
router.use(authenticateJWT);

/**
 * تنفيذ إرجاع دواء من مريض (Phase 10D.5).
 *
 * سجل الإرجاع تاريخ لا يُعدَّل: لا PUT ولا PATCH ولا DELETE. الإلغاء عملية
 * مستقلة لاحقاً، لا تعديل على سجل قائم.
 */
router.post('/', requirePermission('DISPENSE_MEDICATIONS'), createMedicationReturn);

// قراءة وتدقيق (Phase 10D.4) — كل المسارات GET
router.get('/', requirePermission('VIEW_INVENTORY'), listMedicationReturns);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getMedicationReturn);
router.get('/:id/movements', requirePermission('VIEW_INVENTORY'), getMedicationReturnMovements);
// سجلات النظام تبقى مقصورة: الصلاحية تُفحص داخل الكنترولر (SUPER_ADMIN / VIEW_SYSTEM_LOGS)
router.get('/:id/audit', requirePermission('VIEW_INVENTORY'), getMedicationReturnAudit);

export default router;
