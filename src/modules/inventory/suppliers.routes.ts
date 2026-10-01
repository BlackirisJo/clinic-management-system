import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
} from './suppliers.controller';

const router = Router();

// جميع مسارات الموردين محمية بالتوثيق
router.use(authenticateJWT);

// القراءة تتطلب VIEW_INVENTORY، والتعديل/إلغاء التنشيط تتطلب MANAGE_SUPPLIERS
router.get('/', requirePermission('VIEW_INVENTORY'), listSuppliers);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getSupplier);
router.post('/', requirePermission('MANAGE_SUPPLIERS'), createSupplier);
router.put('/:id', requirePermission('MANAGE_SUPPLIERS'), updateSupplier);
// إلغاء التنشيط لا يحذف — لا يوجد أي مسار حذف فعلي للموردين
router.delete('/:id', requirePermission('MANAGE_SUPPLIERS'), deactivateSupplier);

export default router;
