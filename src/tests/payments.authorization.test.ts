import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';

/* ==========================================================================
 * Phase 10G.1 — RECORD_PAYMENT authorization
 *
 * Recording that money arrived is not issuing the document that says it is owed.
 * 10G.0 ruled out reusing CREATE_INVOICE for the same reason 046 ruled it out for
 * the fulfilment decision: the two acts answer different questions and the people
 * who answer them are often not the same person. Issuing asserts a debt;
 * settling asserts its discharge, and only the second assertion moves the ledger.
 *
 * What these tests hold:
 *   - the role that already writes finance (ACCOUNTANT) can settle.
 *   - FINANCIAL_AUDITOR cannot, and that exclusion is the point of the phase:
 *     the read-only inspection role must never be able to change money.
 *   - no clinical or reception role inherits it by proximity to CREATE_INVOICE.
 *   - the two permissions do not leak into each other, in either direction.
 *   - the admin bypass is untouched.
 *   - nothing is gated by RECORD_PAYMENT yet: this phase ships no endpoint, so
 *     the permission is granted but unused and therefore cannot be exercised.
 * ========================================================================== */

const KEY = 'RECORD_PAYMENT';

const role = (roleName: string, permissions: string[]) =>
  ({ user: { userId: 1, roleId: 1, clinicId: 1, roleName, permissions, clinicIds: [1] } } as unknown as AuthenticatedRequest);

const runMiddleware = (required: string, user: AuthenticatedRequest) => {
  let error: any = null;
  let next = false;
  requirePermission(required)(user, { status: () => ({ json: () => undefined }) } as any, (e?: any) => {
    if (e) error = e;
    else next = true;
  });
  return { error, next };
};

const ACCOUNTANT_KEYS = [
  'VIEW_PATIENTS',
  'MANAGE_SERVICES',
  'CREATE_INVOICE',
  'VIEW_INVOICES',
  'CREATE_EXPENSE',
  'VIEW_FINANCIAL_REPORTS',
  'VIEW_REPORTS',
];

/* ==========================================================================
 * 1. المصفوفة الكاملة
 * ======================================================================== */

test('AUTHZ: ACCOUNTANT يستطيع تسجيل الدفعة', () => {
  const r = runMiddleware(KEY, role('ACCOUNTANT', [...ACCOUNTANT_KEYS, KEY]));
  assert.equal(r.next, true, 'الدور المالي الذي يُصدر الفاتورة هو نفسه من يُسوّيها');
  assert.equal(r.error, null);
});

test('AUTHZ: FINANCIAL_AUDITOR لا يستطيع تسجيل دفعة', () => {
  const r = runMiddleware(KEY, role('FINANCIAL_AUDITOR', ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS']));
  assert.equal(r.next, false, 'مدقق المال يقرأ ولا يكتب — وهذا هو سبب استبعاده');
  assert.equal(r.error?.statusCode, 403);
});

test('AUTHZ: لا أحد يرث الصلاحية ممن يملك صلاحيات مالية أخرى', () => {
  const denied = [
    ['RECEPTIONIST', ['VIEW_PATIENTS', 'CREATE_PATIENT', 'CREATE_VISIT', 'VIEW_APPOINTMENTS']],
    ['DOCTOR', ['VIEW_PATIENTS', 'CREATE_PRESCRIPTION', 'VIEW_PRESCRIPTIONS']],
    ['NURSE', ['VIEW_PATIENTS', 'CREATE_VISIT']],
    ['PHARMACIST', ['VIEW_PRESCRIPTIONS', 'DISPENSE_MEDICATIONS', 'MANAGE_INVENTORY']],
  ] as const;

  for (const [roleName, permissions] of denied) {
    const r = runMiddleware(KEY, role(roleName, [...permissions]));
    assert.equal(r.next, false, `${roleName} مرفوض`);
    assert.equal(r.error?.statusCode, 403, roleName);
  }
});

test('AUTHZ: حتى صاحب كل صلاحيات المال الأخرى يُرفض', () => {
  const r = runMiddleware(KEY, role('ACCOUNTANT', [...ACCOUNTANT_KEYS]));
  assert.equal(r.next, false, 'كل صلاحية مالية أخرى لا تساوي صلاحية تسوية');
  assert.equal(r.error?.statusCode, 403);
});

test('AUTHZ: SUPER_ADMIN و SYSTEM_ADMIN يتجاوزان الفحص بقائمة صلاحيات فارغة', () => {
  for (const roleName of ['SUPER_ADMIN', 'SYSTEM_ADMIN']) {
    const r = runMiddleware(KEY, role(roleName, []));
    assert.equal(r.next, true, roleName);
    assert.equal(r.error, null, roleName);
  }
});

/* ==========================================================================
 * 2. لا تصعيد: الإصدار والتسجيل فعلان مختلفان
 * ======================================================================== */

test('NO ESCALATION: RECORD_PAYMENT لا تمنح إنشاء فاتورة', () => {
  const accountant = role('ACCOUNTANT', [...ACCOUNTANT_KEYS, KEY]);
  assert.equal(runMiddleware('CREATE_INVOICE', accountant).next, true, 'المحاسب يُصدر فعلاً — بصلاحية CREATE_INVOICE الخاصة به');
  const settlerOnly = role('ACCOUNTANT', ['VIEW_INVOICES', KEY]);
  assert.equal(runMiddleware('CREATE_INVOICE', settlerOnly).next, false, 'من يملك التسوية وحدها لا يصدر الفاتورة');
});

test('NO ESCALATION: CREATE_INVOICE لا تمنح تسوية فاتورة', () => {
  const issuer = role('ACCOUNTANT', ['CREATE_INVOICE', 'VIEW_INVOICES']);
  assert.equal(runMiddleware(KEY, issuer).next, false, 'إصدار فاتورة لا يساوي إعلانها محصّلة');
  assert.equal(runMiddleware(KEY, issuer).error?.statusCode, 403);
});

test('NO ESCALATION: الصلاحيات قائمة مسطّحة — امتلاك واحدة لا يعني أخرى', () => {
  // الفحص في requirePermission يختبر على قائمة الصلاحيات: لا وراثة ولا تسلسل.
  // هذا هو الحاجز البرمجي ضد "تبسيط" لاحق بمنح CREATE_INVOICE مكان RECORD_PAYMENT.
  const holder = role('ACCOUNTANT', ['VIEW_INVOICES', KEY]);
  assert.equal(runMiddleware(KEY, holder).next, true);
  assert.equal(runMiddleware('CREATE_EXPENSE', holder).next, false, 'التسوية لا تفتح المصاريف');
  assert.equal(runMiddleware('MANAGE_SERVICES', holder).next, false, 'ولا إدارة الخدمات');
});

/* ==========================================================================
 * 3. nothing is gated by the new permission yet
 * ======================================================================== */

const billingRoutes = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.routes.ts'), 'utf8');

test('ROUTE: المسار الوحيد للدفع هو تسجيل دفعة، وهو بوابته RECORD_PAYMENT', () => {
  const source = billingRoutes();
  const paymentRoutes = source.split('\n').filter((l) => /router\.(post|get|put|patch|delete)\('\/payments/.test(l));
  assert.equal(paymentRoutes.length, 1, 'لا مسار قراءة ولا تعديل ولا حذف للدفعات');
  assert.match(paymentRoutes[0]!, /router\.post/);
  assert.match(paymentRoutes[0]!, /requirePermission\('RECORD_PAYMENT'\)/);
});

test('ROUTE: بوابات الفواتير والمصاريف ورسوم الأدوية بقيت على مفاتيحها', () => {
  const source = billingRoutes();
  for (const gate of [
    "router.post('/invoices', requirePermission('CREATE_INVOICE')",
    "router.post('/expenses', requirePermission('CREATE_EXPENSE')",
    "router.post('/medication-charges', requirePermission('CREATE_INVOICE')",
  ]) {
    assert.ok(source.includes(gate), `unchanged gate: ${gate}`);
  }
});

test('SOURCE: سلوك إصدار الفاتورة يطابق ما بعد العتبة', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.controller.ts'),
    'utf8',
  );
  // Phase 10G.3: a service invoice is born unpaid once the boundary has passed,
  // and the declared payment_type survives as a declaration (044 reads it).
  assert.match(controller, /issuedPaidAmount = paymentBacked \? 0 : netAmount/);
  assert.doesNotMatch(controller, /discount, netAmount, netAmount, payment_type/);
  const charge = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'medicationCharges.controller.ts'),
    'utf8',
  );
  assert.match(charge, /\$4, 0, \$4, 0, 'CASH', \$5\)/, 'رسوم الدواء تبقى غير محصّلة');
  assert.match(charge, /readCutoverAt/, 'وتقرأ العتبة قبل الإصدار');
});

test('SOURCE: لا صلاحية جديدة أُضيفت لغير RECORD_PAYMENT في هذه المرحلة', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '047_payments.sql'),
    'utf8',
  );
  const keys = [...migration.matchAll(/INSERT INTO permissions[\s\S]*?VALUES \('([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['RECORD_PAYMENT'], 'exactly one permission is introduced');
});