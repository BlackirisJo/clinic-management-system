import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  listInventoryItems,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  archiveInventoryItem,
} from './inventory.controller';

const router = Router();

// جميع مسارات المخزون محمية بالتوثيق
router.use(authenticateJWT);

// القراءة تتطلب VIEW_INVENTORY، والتعديل/الأرشفة تتطلب MANAGE_INVENTORY
router.get('/', requirePermission('VIEW_INVENTORY'), listInventoryItems);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getInventoryItem);
router.post('/', requirePermission('MANAGE_INVENTORY'), createInventoryItem);
router.put('/:id', requirePermission('MANAGE_INVENTORY'), updateInventoryItem);
router.delete('/:id', requirePermission('MANAGE_INVENTORY'), archiveInventoryItem);

export default router;
