import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  createStockCount,
  addStockCountLine,
  finaliseStockCount,
  listStockCounts,
  getStockCount,
  getStockCountAudit,
  getStockCountReconciliation,
} from './stockCounts.controller';

const router = Router();

// كل مسارات الجرد محمية بالتوثيق
router.use(authenticateJWT);

/**
 * الكتابة (MANAGE_INVENTORY): فتح جلسة عد، تسجيل سطور، وإنهاء العد.
 * القراءة (VIEW_INVENTORY): عرض الجلسات وسطورها.
 *
 * الإنهاء (Phase 10D.7) عملية واحدة لا رجعة فيها: تُغلق العد وتصحّح المخزون
 * تحت نفس المعاملة. لا يوجد PUT/PATCH/DELETE — سطر العد المسجَّل تاريخ لا يُعاد
 * كتابته، والتصحيح بعملية لاحقة لا بإعادة تحرير السجل.
 *
 * لا يوجد مسار GET /:id/lines: البنود جزء من تفاصيل الجلسة نفسها، وفصلها
 * لمعون استعلام بلا فائدة.
 *
 * تقرير المطابقة (Phase 10D.9) قراءة فقط تحت VIEW_INVENTORY: يقارن دليل آخر
 * عدّ منتهٍ بالمخزون الحيّ، ولا يغيّر شيئاً ولا يسجّل شيئاً لمجرد الاطلاع.
 */
router.post('/', requirePermission('MANAGE_INVENTORY'), createStockCount);
router.post('/:id/lines', requirePermission('MANAGE_INVENTORY'), addStockCountLine);
router.post('/:id/finalise', requirePermission('MANAGE_INVENTORY'), finaliseStockCount);

router.get('/', requirePermission('VIEW_INVENTORY'), listStockCounts);
// قبل /:id بالضرورة: خلاف ذلك لالتقط Express كلمة "reconciliation" معرّفاً
// لجلسة عدّ وأعاد 400 بدلاً من التقرير.
router.get('/reconciliation', requirePermission('VIEW_INVENTORY'), getStockCountReconciliation);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getStockCount);
// سجلات النظام تبقى مقصورة: الصلاحية تُفحص داخل الكنترولر (SUPER_ADMIN / VIEW_SYSTEM_LOGS)
router.get('/:id/audit', requirePermission('VIEW_INVENTORY'), getStockCountAudit);

export default router;
