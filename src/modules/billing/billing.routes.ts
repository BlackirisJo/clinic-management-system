import { Router } from 'express';
import {
  createClinicService,
  createInvoice,
  createExpense,
  getMonthlyFinancialKPIs,
} from './billing.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import { expenseSchema, invoiceSchema, serviceSchema } from '../../validations/business.validation';

const router = Router();

// جميع المسارات محمية بالتوثيق
router.use(authenticateJWT);

// خدمات العيادات
router.post('/services', requirePermission('MANAGE_SERVICES'), validateBody(serviceSchema), createClinicService);

// إصدار الفواتير والمصروفات
router.post('/invoices', requirePermission('CREATE_INVOICE'), validateBody(invoiceSchema), createInvoice);
router.post('/expenses', requirePermission('CREATE_EXPENSE'), validateBody(expenseSchema), createExpense);

// التقارير المالية
router.get('/reports/kpis', requirePermission('VIEW_FINANCIAL_REPORTS'), getMonthlyFinancialKPIs);

export default router;