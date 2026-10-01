import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { createStockMovement, listStockMovements, getStockMovement } from './stockMovements.controller';

const router = Router();

// جميع مسارات حركات المخزون محمية بالتوثيق
router.use(authenticateJWT);

// القراءة/التدقيق تتطلب VIEW_INVENTORY — سجل الحركات للعيادات المسموحة فقط
router.get('/', requirePermission('VIEW_INVENTORY'), listStockMovements);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getStockMovement);

router.post('/', requirePermission('MANAGE_INVENTORY'), createStockMovement);

export default router;
