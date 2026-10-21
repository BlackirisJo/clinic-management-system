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
import { createMedicationCharge, getDispensingCharge } from './medicationCharges.controller';
import { recordPayment } from './payments.controller';
import { recordRefund } from './refunds.controller';
import { authenticateJWT, requirePermission, canManageAllClinics } from '../../middlewares/auth.middleware';
import { AppError } from '../../middlewares/error.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { validateBody } from '../../middlewares/validate.middleware';
import { expenseSchema, expenseUpdateSchema, invoiceSchema, serviceSchema, serviceUpdateSchema } from '../../validations/business.validation';
import { medicationChargeSchema } from '../../validations/medicationCharge.validation';
import { paymentSchema } from '../../validations/payment.validation';
import { refundSchema } from '../../validations/refund.validation';

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

// رسم دواء لسجل صرف واحد (Phase 10E.4).
// CREATE_INVOICE موجودة أصلاً، فلا صلاحية جديدة. القراءة تتبع صلاحية عرض
// الفواتير نفسها. المسارات أضيق من /invoices فتُسجَّل قبلها.
router.post('/medication-charges', requirePermission('CREATE_INVOICE'), validateBody(medicationChargeSchema), createMedicationCharge);
router.get('/medication-charges/:dispensingId', requireAny(['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'CREATE_INVOICE']), getDispensingCharge);

// تسجيل دفعة على فاتورة (Phase 10G.2).
// RECORD_PAYMENT صلاحية مستقلة عن CREATE_INVOICE: إصدار الفاتورة يقرّر ما هو
// مستحق، وتسجيل الدفعة يقرّر أن النقد وصل فعلاً. من يُصدر الفاتورة لا يُشتق
// منه أنه يملك تسويتها. المسار أوسع من /invoices/:id في Methods لا في الشكل،
// فيُسجَّل قبل لا بعد.
router.post('/payments', requirePermission('RECORD_PAYMENT'), validateBody(paymentSchema), recordPayment);

// تسجيل استرداد نقدي على دفعة محصّلة (Phase 10G.4b).
// RECORD_REFUND صلاحية مستقلة عن RECORD_PAYMENT: سقفان مختلفان. السقف الأول
// net_amount الفاتورة، والثاني نقد وصل فعلاً — فمن يجمع يستطيع أن يردّ بلا أن
// يكون مُفوَّض بالردّ. refundSchema صارم (.strict) فلا تمرّ أي قيمة يقررها
// الخادم من العميل، حتى عبر وسيط التحقق.
router.post('/refunds', requirePermission('RECORD_REFUND'), validateBody(refundSchema), recordRefund);

// التقارير المالية
router.get('/reports/kpis', requirePermission('VIEW_FINANCIAL_REPORTS'), getMonthlyFinancialKPIs);

export default router;