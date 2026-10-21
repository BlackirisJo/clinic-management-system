import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  listBatches,
  listBatchesByExpiry,
  getBatch,
  getBatchAvailability,
  createBatch,
  createBatchWithReceipt,
  updateBatch,
  deactivateBatch,
} from './batches.controller';
import { getInventoryValuation } from './inventoryValuation.controller';

const router = Router();

// جميع مسارات الدفعات محمية بالتوثيق
router.use(authenticateJWT);

// القراءة تتطلب VIEW_INVENTORY، والاستلام/التعديل/إلغاء التنشيط تتطلب MANAGE_INVENTORY
router.get('/', requirePermission('VIEW_INVENTORY'), listBatches);
// التقويم المالي للمخزون — Phase 10E.6، قراءة فقط: لا تُعدّل كمية ولا تكلفة
router.get('/valuation', requirePermission('VIEW_INVENTORY'), getInventoryValuation);
// يجب أن يسبق /:id وإلا مطابق Express لقيمة id بالنص "expiry"
router.get('/expiry', requirePermission('VIEW_INVENTORY'), listBatchesByExpiry);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getBatch);
// حالة التوفّر للصرف المستقبلي (Phase 10B.4A) — قراءة فقط
router.get('/:id/availability', requirePermission('VIEW_INVENTORY'), getBatchAvailability);
router.post('/', requirePermission('MANAGE_INVENTORY'), createBatch);
// استلام ذري: إنشاء دفعة + حركة استلام في معاملة واحدة (Phase 4B.3)
router.post('/receive', requirePermission('MANAGE_INVENTORY'), createBatchWithReceipt);
// البيانات الوصفية فقط — لا تعديل للكميات (Phase 10B.3 لحركات المخزون)
router.put('/:id', requirePermission('MANAGE_INVENTORY'), updateBatch);
// إلغاء التنشيط لا يحذف — لا يوجد أي مسار حذف فعلي للدفعات
router.delete('/:id', requirePermission('MANAGE_INVENTORY'), deactivateBatch);

export default router;
