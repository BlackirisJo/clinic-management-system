import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { createInventoryWriteOff } from './writeOffs.controller';

const router = Router();

// كل مسارات الكتابة-off محمية بالتوثيق
router.use(authenticateJWT);

/**
 * POST فقط.
 *
 * سجل الكتابة-off تاريخ غير قابل للتعديل: لا PUT ولا PATCH ولا DELETE.
 * التصحيح يتم بعملية معاكسة، لا بإعادة كتابة التاريخ.
 * لا يوجد مسار قراءة في هذه المرحلة، ولا مسار إرجاع الأدوية (returns).
 *
 * EXPIRE عملية محاسبة يدوية: لا cron ولا ماسح ولا خصم تلقائي.
 */
router.post('/', requirePermission('MANAGE_INVENTORY'), createInventoryWriteOff);

export default router;
