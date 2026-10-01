import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { createDispensing, voidDispensing } from './dispensings.controller';
import {
  listDispensings,
  getDispensing,
  getDispensingMovements,
  getDispensingAudit,
} from './dispensingReads.controller';

const router = Router();

router.use(authenticateJWT);

// --- قراءة وتدقيق (Phase 10C.5) — قراءة فقط ---
// VIEW_PRESCRIPTIONS يغطي الطبيب والصيدلي معاً، ويطابق طبيعة سجل الصرف.
router.get('/', requirePermission('VIEW_PRESCRIPTIONS'), listDispensings);
router.get('/:id', requirePermission('VIEW_PRESCRIPTIONS'), getDispensing);
router.get('/:id/movements', requirePermission('VIEW_PRESCRIPTIONS'), getDispensingMovements);
// سجلات النظام تبقى مقصورة: الصلاحية تُفحص داخل الكنترولر (SUPER_ADMIN / VIEW_SYSTEM_LOGS)
router.get('/:id/audit', requirePermission('VIEW_PRESCRIPTIONS'), getDispensingAudit);

// الصرف والإلغاء يتطلبان صلاحية DISPENSE_MEDICATIONS (Migration 030 / 031)
router.post('/', requirePermission('DISPENSE_MEDICATIONS'), createDispensing);
// إلغاء صرف وإرجاع الكميات المسجّلة — لا يُعاد بناؤها من بيانات الروشتة
router.post('/:id/void', requirePermission('DISPENSE_MEDICATIONS'), voidDispensing);

export default router;
