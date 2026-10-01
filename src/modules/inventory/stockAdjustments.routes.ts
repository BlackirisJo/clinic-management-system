import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { createStockAdjustment } from './stockAdjustments.controller';

const router = Router();

// كل مسارات التسويات محمية بالتوثيق
router.use(authenticateJWT);

/**
 * POST فقط.
 *
 * سجل التسوية تاريخ غير قابل للتعديل: لا PUT ولا PATCH ولا DELETE.
 * التصحيح يتم بتسوية معاكسة، لا بإعادة كتابة التاريخ. كما لا يوجد مسار قراءة
 * في هذه المرحلة — قراءة سجل التسويات لاحقاً (Phase 10D.3).
 */
router.post('/', requirePermission('MANAGE_INVENTORY'), createStockAdjustment);

export default router;
