import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import {
  listMedicationPrices,
  getMedicationPrice,
  createMedicationPrice,
  updateMedicationPrice,
  deactivateMedicationPrice,
} from './medicationPrices.controller';

const router = Router();

// جميع مسارات أسعار بيع الأدوية محمية بالتوثيق
router.use(authenticateJWT);

// القراءة تتطلب VIEW_INVENTORY، وكل تغيير سعر يتطلب MANAGE_INVENTORY
router.get('/', requirePermission('VIEW_INVENTORY'), listMedicationPrices);
router.get('/:id', requirePermission('VIEW_INVENTORY'), getMedicationPrice);
router.post('/', requirePermission('MANAGE_INVENTORY'), createMedicationPrice);
// PUT ينهي صلاحية السعر الحالي وينشئ سعراً جديداً — لا يُعدَّل مبلغ قائم
router.put('/:id', requirePermission('MANAGE_INVENTORY'), updateMedicationPrice);
// DELETE إنهاء صلاحية فقط، لا حذف فعلي — يبقى السعر التاريخي محفوظاً
router.delete('/:id', requirePermission('MANAGE_INVENTORY'), deactivateMedicationPrice);

export default router;