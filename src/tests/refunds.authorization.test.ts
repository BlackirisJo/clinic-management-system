import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';

/* ==========================================================================
 * Phase 10G.4a/4b — RECORD_REFUND authorization
 *
 * تحصيل المال وتوزيعه ليسا فعلاً واحداً. 10G.1 فصل RECORD_PAYMENT عن
 * CREATE_INVOICE لأن الإصدار يُثبت ديناً والتسوية تُثبت سداده. الفصل هنا أشدّ:
 * التحصيل مقيَّد بـ net_amount الخاص بالفاتورة، والاسترداد مقيَّد بقديد وصل فعلاً
 * إلى الصندوق. فدورٌ يستطيع التحصيل يستطيع — دون أن يمرّ بالصلاحية التي تسمح
 * بذلك — أن يردّ مالاً لم يُفوَّض بردّه.
 *
 * ما تحفظه هذه الاختبارات:
 *   - ACCOUNTANT يستطيع الاسترداد: هو نفسه من يُصدر ويحصّل ويُسوّي.
 *   - FINANCIAL_AUDITOR لا يستطيع، وهذا هو سبب استبعاده: دور التدقيق لا يملك أن
 *     يغيّر مالاً يفحصه.
 *   - لا دور سريري أو استقبال يرثها بقربها من CREATE_INVOICE أو RECORD_PAYMENT.
 *   - لا تصعيد في الاتجاهين: التسجيل لا يُعطي استرداداً، والاسترداد لا يُعطي تسجيلاً.
 *   - تجاوز المشرفين لم يتغيّر.
 *   - البوابة تُفحص قبل الجسم، ومنع منها لا يعرف شكل الطلب أصلاً.
 *   - 10G.4b أضافت المسار خلفها، وما زال كاتب واحد.
 * ========================================================================== */

const KEY = 'RECORD_REFUND';

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

/** The finance-writing rights ACCOUNTANT already holds, from seed.ts. */
const ACCOUNTANT_KEYS = [
  'VIEW_PATIENTS',
  'MANAGE_SERVICES',
  'CREATE_INVOICE',
  'VIEW_INVOICES',
  'RECORD_PAYMENT',
  'CREATE_EXPENSE',
  'VIEW_FINANCIAL_REPORTS',
  'VIEW_REPORTS',
];

const billingRoutes = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.routes.ts'), 'utf8');

/* ==========================================================================
 * 1. المصفوفة الكاملة
 * ======================================================================== */

test('AUTHZ: ACCOUNTANT يستطيع تسجيل استرداد', () => {
  const r = runMiddleware(KEY, role('ACCOUNTANT', [...ACCOUNTANT_KEYS, KEY]));
  assert.equal(r.next, true, 'الدور المالي الذي يُحصّل هو نفسه من يُعيد');
  assert.equal(r.error, null);
});

test('AUTHZ: FINANCIAL_AUDITOR لا يستطيع تسجيل استرداد', () => {
  const r = runMiddleware(KEY, role('FINANCIAL_AUDITOR', ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS']));
  assert.equal(r.next, false, 'مدقق المال يقرأ ولا يوزّع — وهذا هو سبب استبعاده');
  assert.equal(r.error?.statusCode, 403);
});

test('AUTHZ: لا أحد يرث الصلاحية ممن يملك صلاحيات مالية أخرى', () => {
  const denied = [
    ['RECEPTIONIST', ['VIEW_PATIENTS', 'CREATE_PATIENT', 'CREATE_VISIT', 'VIEW_APPOINTMENTS', 'CREATE_INVOICE']],
    ['DOCTOR', ['VIEW_PATIENTS', 'CREATE_PRESCRIPTION', 'VIEW_PRESCRIPTIONS']],
    ['NURSE', ['VIEW_PATIENTS', 'CREATE_VISIT']],
    ['PHARMACIST', ['VIEW_PRESCRIPTIONS', 'DISPENSE_MEDICATIONS', 'MANAGE_INVENTORY']],
  ] as const;

  for (const [roleName, permissions] of denied) {
    // RECEPTIONIST is given CREATE_INVOICE on purpose: even the ability to
    // produce the document a refund would return against is not enough.
    const r = runMiddleware(KEY, role(roleName, [...permissions]));
    assert.equal(r.next, false, `${roleName} مرفوض`);
    assert.equal(r.error?.statusCode, 403, roleName);
  }
});

test('AUTHZ: حتى صاحب كل صلاحيات المال الأخرى يُرفض', () => {
  const r = runMiddleware(KEY, role('ACCOUNTANT', [...ACCOUNTANT_KEYS]));
  assert.equal(r.next, false, 'تحصيل المال وإصدار الفاتورة وتسجيل المصاريف لا تساوي توزيع المال');
  assert.equal(r.error?.statusCode, 403);
});

test('AUTHZ: حتى من يملك RECORD_PAYMENT وحدها يُرفض', () => {
  // The sharpest case: the same accountant, on the same day, with the same
  // permissions list — minus the new key. Collecting must not imply disbursing.
  const r = runMiddleware(KEY, role('ACCOUNTANT', ['VIEW_INVOICES', 'RECORD_PAYMENT']));
  assert.equal(r.next, false, 'تسجيل دفعة ليس تفويضاً بإرجاعها');
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
 * 2. لا تصعيد: التحصيل والاسترداد والت إصدار ثلاثة أسئلة
 * ======================================================================== */

test('NO ESCALATION: RECORD_REFUND لا تمنح تسجيل دفعة', () => {
  const refundOnly = role('ACCOUNTANT', ['VIEW_INVOICES', KEY]);
  assert.equal(runMiddleware('RECORD_PAYMENT', refundOnly).next, false, 'من يوزّع لا يحصّل');
  assert.equal(runMiddleware('RECORD_PAYMENT', refundOnly).error?.statusCode, 403);
});

test('NO ESCALATION: RECORD_REFUND لا تمنح إنشاء فاتورة', () => {
  const refundOnly = role('ACCOUNTANT', ['VIEW_INVOICES', KEY]);
  assert.equal(runMiddleware('CREATE_INVOICE', refundOnly).next, false, 'من يوزّع لا يُصدر');
  const accountant = role('ACCOUNTANT', [...ACCOUNTANT_KEYS, KEY]);
  assert.equal(runMiddleware('CREATE_INVOICE', accountant).next, true, 'المحساب يُصدر فعلاً — بصلاحية CREATE_INVOICE الخاصة به');
});

test('NO ESCALATION: الصلاحيات قائمة مسطّحة — امتلاك واحدة لا يعني أخرى', () => {
  // requirePermission tests membership in a flat list: no inheritance, no
  // hierarchy. This is the code barrier against a later "simplification" that
  // would let CREATE_INVOICE or RECORD_PAYMENT stand in for RECORD_REFUND.
  const holder = role('ACCOUNTANT', ['VIEW_INVOICES', KEY]);
  assert.equal(runMiddleware(KEY, holder).next, true);
  for (const other of ['CREATE_EXPENSE', 'MANAGE_SERVICES', 'VIEW_FINANCIAL_REPORTS']) {
    assert.equal(runMiddleware(other, holder).next, false, `${other} لا تفتح الاسترداد`);
  }
});

/* ==========================================================================
 * 3. the gate, now that a route exists behind it
 * ======================================================================== */

test('ROUTE: مسار الاسترداد واحد، وبوابته RECORD_REFUND وحدها', () => {
  const source = billingRoutes();
  const refundRoutes = source.split('\n').filter((l) => /router\.(post|get|put|patch|delete)\(.*refund/i.test(l));
  assert.equal(refundRoutes.length, 1, 'لا مسار قراءة ولا تعديل ولا حذف للاسترداد');
  assert.match(refundRoutes[0]!, /router\.post/);
  assert.match(refundRoutes[0]!, /requirePermission\('RECORD_REFUND'\)/);
  assert.doesNotMatch(refundRoutes[0]!, /RECORD_PAYMENT|CREATE_INVOICE/, 'ولا يرث أياً منهما');
});

test('ROUTE: بوابات الفواتير والدفعات والمصاريف ورسوم الأدوية بقيت على مفاتيحها', () => {
  const source = billingRoutes();
  for (const gate of [
    "router.post('/invoices', requirePermission('CREATE_INVOICE')",
    "router.post('/payments', requirePermission('RECORD_PAYMENT')",
    "router.post('/expenses', requirePermission('CREATE_EXPENSE')",
    "router.post('/medication-charges', requirePermission('CREATE_INVOICE')",
  ]) {
    assert.ok(source.includes(gate), `unchanged gate: ${gate}`);
  }
});

test('AUTHZ: من يملك RECORD_PAYMENT وحدها لا يبلغ بوابة الاسترداد', () => {
  // The gate is checked before the body, so a caller who cannot refund never
  // reaches validation and learns nothing about the shape of the request.
  const source = billingRoutes();
  const refundRoute = source.split('\n').find((l) => l.includes("router.post('/refunds'"))!;
  const permissionAt = refundRoute.indexOf('requirePermission');
  const validationAt = refundRoute.indexOf('validateBody');
  assert.ok(permissionAt > -1 && validationAt > permissionAt, 'الصلاحية قبل التحقق من الجسم');
});

test('SOURCE: كاتب واحد للاسترداد، وهو مسار التسجيل نفسه', () => {
  const modulesDir = path.join(__dirname, '..', 'modules');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /\b(?:FROM|INTO|UPDATE|JOIN)\s+refunds\b/i.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(modulesDir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(modulesDir);
  assert.deepEqual(offenders, ['billing/refunds.controller.js'], 'الكتابة كلها في مسار واحد خلف البوابة');
});

test('SOURCE: لا صلاحية جديدة أُضيفت لغير RECORD_REFUND في هذه المرحلة', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '049_refunds.sql'),
    'utf8',
  );
  const keys = [...migration.matchAll(/INSERT INTO permissions[\s\S]*?VALUES \('([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['RECORD_REFUND'], 'exactly one permission is introduced');
});

test('SEED: المخزن يطابق الترحيل — ACCOUNTANT يأخذ المفتاح، والمدقق لا', () => {
  const seed = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'scripts', 'seed.ts'), 'utf8');
  const matrix = seed.slice(seed.indexOf('const ROLE_PERMISSIONS'));
  const accountant = /ACCOUNTANT: \[([^\]]*)\]/.exec(matrix);
  assert.ok(accountant, 'ACCOUNTANT row exists');
  assert.ok(accountant![1]!.includes("'RECORD_REFUND'"), 'a fresh database grants it');
  const auditor = /FINANCIAL_AUDITOR: \[([^\]]*)\]/.exec(matrix);
  assert.ok(auditor, 'FINANCIAL_AUDITOR row exists');
  assert.ok(!auditor![1]!.includes('RECORD_REFUND'), 'the read-only auditor never holds it');
});
