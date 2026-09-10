import { Router } from 'express';
import {
  createClinicService,
  listClinicServices,
  createInvoice,
  listInvoices,
  createExpense,
  listExpenses,
  getMonthlyFinancialKPIs,
} from './billing.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import { expenseSchema, invoiceSchema, serviceSchema } from '../../validations/business.validation';

const router = Router();

// جميع المسارات محمية بالتوثيق
router.use(authenticateJWT);

// السماح بأي صلاحية مالية للقراءة (المحاسب + الإدارة) بدل صلاحية واحدة
const requireAny = (keys: string[]) => {
  return (req: any, res: any, next: any) => {
    if (req.user?.roleName === 'SUPER_ADMIN' || req.user?.roleName === 'SYSTEM_ADMIN') return next();
    const perms: string[] = req.user?.permissions ?? [];
    if (keys.some((k) => perms.includes(k))) return next();
    return res.status(403).json({ message: 'عذراً، لا تمتلك الصلاحية الكافية لتنفيذ هذا الإجراء' });
  };
};

// خدمات العيادات
router.post('/services', requirePermission('MANAGE_SERVICES'), validateBody(serviceSchema), createClinicService);
router.get('/services', requireAny(['MANAGE_SERVICES', 'VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), listClinicServices);

// إصدار الفواتير والمصروفات
router.post('/invoices', requirePermission('CREATE_INVOICE'), validateBody(invoiceSchema), createInvoice);
router.get('/invoices', requireAny(['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), listInvoices);
router.post('/expenses', requirePermission('CREATE_EXPENSE'), validateBody(expenseSchema), createExpense);
router.get('/expenses', requireAny(['VIEW_FINANCIAL_REPORTS', 'VIEW_INVOICES', 'CREATE_EXPENSE']), listExpenses);

// التقارير المالية
router.get('/reports/kpis', requirePermission('VIEW_FINANCIAL_REPORTS'), getMonthlyFinancialKPIs);

export default router;