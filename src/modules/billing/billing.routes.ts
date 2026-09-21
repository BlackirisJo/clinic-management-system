import { Router } from 'express';
import {
  createClinicService,
  listClinicServices,
  getClinicService,
  updateClinicService,
  deleteClinicService,
  createInvoice,
  listInvoices,
  getInvoice,
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  getMonthlyFinancialKPIs,
} from './billing.controller';
import { authenticateJWT, requirePermission, canManageAllClinics } from '../../middlewares/auth.middleware';
import { AppError } from '../../middlewares/error.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { validateBody } from '../../middlewares/validate.middleware';
import { expenseSchema, expenseUpdateSchema, invoiceSchema, serviceSchema, serviceUpdateSchema } from '../../validations/business.validation';

const router = Router();

// جميع المسارات محمية بالتوثيق
router.use(authenticateJWT);

// السماح بأي صلاحية مالية للقراءة (إدارة + أدوار مالية محددة) بدل صلاحية واحدة
const requireAny = (keys: string[]) => {
  return (req: any, res: any, next: any) => {
    if (canManageAllClinics(req)) return next();
    const perms: string[] = req.user?.permissions ?? [];
    if (keys.some((k) => perms.includes(k))) return next();
    return next(new AppError('عذراً، لا تمتلك الصلاحية الكافية لتنفيذ هذا الإجراء', 403, ApiErrorCode.FORBIDDEN));
  };
};

// خدمات العيادات
router.post('/services', requirePermission('MANAGE_SERVICES'), validateBody(serviceSchema), createClinicService);
router.get('/services', requireAny(['MANAGE_SERVICES', 'VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), listClinicServices);
router.get('/services/:id', requireAny(['MANAGE_SERVICES', 'VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), getClinicService);
router.put('/services/:id', requirePermission('MANAGE_SERVICES'), validateBody(serviceUpdateSchema), updateClinicService);
router.delete('/services/:id', requirePermission('MANAGE_SERVICES'), deleteClinicService);

// إصدار الفواتير والمصروفات
router.post('/invoices', requirePermission('CREATE_INVOICE'), validateBody(invoiceSchema), createInvoice);
router.get('/invoices', requireAny(['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), listInvoices);
router.get('/invoices/:id', requireAny(['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), getInvoice);
router.post('/expenses', requirePermission('CREATE_EXPENSE'), validateBody(expenseSchema), createExpense);
router.get('/expenses', requireAny(['VIEW_FINANCIAL_REPORTS', 'VIEW_INVOICES', 'CREATE_EXPENSE']), listExpenses);
router.get('/expenses/:id', requireAny(['VIEW_FINANCIAL_REPORTS', 'VIEW_INVOICES', 'CREATE_EXPENSE']), getExpense);
router.put('/expenses/:id', requirePermission('CREATE_EXPENSE'), validateBody(expenseUpdateSchema), updateExpense);
router.delete('/expenses/:id', requirePermission('CREATE_EXPENSE'), deleteExpense);

// التقارير المالية
router.get('/reports/kpis', requirePermission('VIEW_FINANCIAL_REPORTS'), getMonthlyFinancialKPIs);

export default router;