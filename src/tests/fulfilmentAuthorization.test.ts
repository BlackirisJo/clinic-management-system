import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';

/* ==========================================================================
 * Phase 10F.2 — صلاحية تسجيل قرار التنفيذ
 *
 * تسجيل قرار المريض فعل مستقل عن الكتابة عن روشتة وعن الصرف. phase 10F.1 ربطه
 * بـ CREATE_PRESCRIPTION بحجة سابقة 032 — وهذا خطأ: من يسأل المريض في الصيدلية
 * صيدلي، والصيدلي لا ينشئ الروشتات.
 *
 * ما تحرسه هذه الاختبارات:
 *   - الصيدلي والطبيب يستطيعان تسجيل القرار.
 *   - أدوار الاستقبال والممرضين والمحاسبة والمدقق المالي لا تستطيع.
 *   - المديران يتجاوزان الفحص كعادتهما.
 *   - الأهم: منح هذه الصلاحية لا يمنح إنشاء الروشتة ولا تفويض التكرار أبداً.
 * ========================================================================== */

const KEY = 'RECORD_PRESCRIPTION_FULFILMENT';

const role = (roleName: string, permissions: string[]) =>
  ({ user: { userId: 1, roleId: 1, clinicId: 1, roleName, permissions, clinicIds: [1] } } as unknown as AuthenticatedRequest);

const PHARMACIST_KEYS = [
  'VIEW_PRESCRIPTIONS',
  'VIEW_PHARMACY_QUEUE',
  'VIEW_INVENTORY',
  'MANAGE_INVENTORY',
  'MANAGE_SUPPLIERS',
  'DISPENSE_MEDICATIONS',
];

const runMiddleware = (required: string, user: AuthenticatedRequest) => {
  let error: any = null;
  let next = false;
  requirePermission(required)(user, { status: () => ({ json: () => undefined }) } as any, (e?: any) => {
    if (e) error = e;
    else next = true;
  });
  return { error, next };
};

/* ==========================================================================
 * 1. المصفوفة الكاملة
 * ========================================================================== */

test('AUTHZ: PHARMACIST مسجَّل بصلاحية الصيدلية فقط يستطيع تسجيل القرار', () => {
  const r = runMiddleware(KEY, role('PHARMACIST', [...PHARMACIST_KEYS, KEY]));
  assert.equal(r.next, true, 'الصيدلي يسأل المريض فيستطيع تسجيل الجواب');
  assert.equal(r.error, null);
});

test('AUTHZ: DOCTOR يستطيع تسجيل القرار', () => {
  const r = runMiddleware(KEY, role('DOCTOR', ['VIEW_PATIENTS', 'CREATE_PRESCRIPTION', 'VIEW_PRESCRIPTIONS', KEY]));
  assert.equal(r.next, true, 'الطبيب يسجّل القرار وقت الوصف');
  assert.equal(r.error, null);
});

test('AUTHZ: الأدوار غير المخوّلة تُرفض بـ 403', () => {
  const denied = [
    ['NURSE', ['VIEW_PATIENTS', 'CREATE_VISIT', 'VIEW_APPOINTMENTS']],
    ['RECEPTIONIST', ['VIEW_PATIENTS', 'CREATE_PATIENT', 'CREATE_VISIT', 'VIEW_APPOINTMENTS']],
    ['ACCOUNTANT', ['VIEW_PATIENTS', 'MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES']],
    ['FINANCIAL_AUDITOR', ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS']],
  ] as const;

  for (const [roleName, permissions] of denied) {
    const r = runMiddleware(KEY, role(roleName, [...permissions]));
    assert.equal(r.next, false, `${roleName} مرفوض`);
    assert.equal(r.error?.statusCode, 403, roleName);
  }
});

test('AUTHZ: حتى صاحب كل صلاحيات الصيدلية الأخرى يُرفض', () => {
  const r = runMiddleware(KEY, role('PHARMACIST', PHARMACIST_KEYS));
  assert.equal(r.next, false, 'صلاحية الصرف وحدها لا تكفي لتسجيل القرار');
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
 * 2. الأهم: منح صلاحية القرار لا يمنح إنشاء الروشتة ولا تفويض التكرار
 * ========================================================================== */

test('NO ESCALATION: PHARMACIST يبقى ممنوعاً من إنشاء روشتة', () => {
  const r = runMiddleware('CREATE_PRESCRIPTION', role('PHARMACIST', [...PHARMACIST_KEYS, KEY]));
  assert.equal(r.next, false, 'تسجيل قرار ≠ إنشاء روشتة');
  assert.equal(r.error?.statusCode, 403);
});

test('NO ESCALATION: PHARMACIST يبقى ممنوعاً من تفويض التكرار (كتابة)', () => {
  for (const required of ['CREATE_PRESCRIPTION']) {
    const r = runMiddleware(required, role('PHARMACIST', [...PHARMACIST_KEYS, KEY]));
    assert.equal(r.next, false, required);
  }
});

test('NO ESCALATION: كتابة ملف الأدوية مقصورة على MANAGE_MEDICATIONS', () => {
  const r = runMiddleware('MANAGE_MEDICATIONS', role('PHARMACIST', [...PHARMACIST_KEYS, KEY]));
  assert.equal(r.next, false, 'صلاحية القرار لا تفتح دليل الأدوية');
});

test('NO ESCALATION: الصلاحيات قائمة مسطّحة — امتلاك واحدة لا يعني أخرى', () => {
  // الفحص في requirePermission تختبر على قائمة الصلاحيات: لا وراثة ولا
  // تسلسل. هذا هو الفحص البرمجي لمنع "التبسيط" لاحقاً بمنح CREATE_PRESCRIPTION.
  const pharmacist = role('PHARMACIST', [...PHARMACIST_KEYS, KEY]);
  assert.equal(runMiddleware(KEY, pharmacist).next, true);
  assert.equal(runMiddleware('CREATE_PRESCRIPTION', pharmacist).next, false);
  assert.equal(runMiddleware('DISPENSE_MEDICATIONS', pharmacist).next, true);
});

/* ==========================================================================
 * 3. المسار نفسه يحمل المفتاح الجديد
 * ========================================================================== */

const routesSource = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'prescriptions', 'prescriptions.routes.ts'),
    'utf8',
  );

test('ROUTE: مسار القرار يطلب RECORD_PRESCRIPTION_FULFILMENT', () => {
  const source = routesSource();
  const line = source.split('\n').find((l) => l.includes("'/items/:id/fulfilment'"));
  assert.ok(line, 'مسار القرار موجود');
  assert.match(line!, /requirePermission\('RECORD_PRESCRIPTION_FULFILMENT'\)/);
  assert.doesNotMatch(line!, /CREATE_PRESCRIPTION/);
});

test('ROUTE: إنشاء الروشتة وتفويض التكرار بقيا على CREATE_PRESCRIPTION', () => {
  const source = routesSource();
  for (const route of ["router.post('/', requirePermission('CREATE_PRESCRIPTION')", "'/items/:itemId/repeat-authorization', requirePermission('CREATE_PRESCRIPTION')"]) {
    assert.ok(source.includes(route), route);
  }
});

test('ROUTE: كل بوابة مسار مفتاح واحد فقط بلا OR/AND', () => {
  const source = routesSource();
  const gates = source.match(/requirePermission\([^)]*\)/g) ?? [];
  assert.ok(gates.length > 0, 'البوابات موجودة');
  for (const gate of gates) {
    assert.match(gate, /^requirePermission\('[A-Z_]+'\)$/, `مفتاح واحد فقط، بلا دمج: ${gate}`);
  }
});

/* ==========================================================================
 * 4. الترحيل: منح واحد بالضبط لأربعة أدوار، ولا شيء غيرها
 * ========================================================================== */

const MIGRATION_PATH = path.join(
  __dirname, '..', '..', 'src', 'database', 'migrations', '046_prescription_fulfilment_permission.sql',
);
const migrationSource = () => fs.readFileSync(MIGRATION_PATH, 'utf8');

test('MIGRATION: الملف موجود ويسجّل المفتاح في مجموعة Pharmacy', () => {
  const sql = migrationSource();
  assert.match(sql, /INSERT INTO permissions/);
  assert.match(sql, /'RECORD_PRESCRIPTION_FULFILMENT',\s*'Pharmacy'/);
});

test('MIGRATION: منح الدور محصور في PHARMACIST و DOCTOR و SUPER_ADMIN و SYSTEM_ADMIN', () => {
  const sql = migrationSource();
  const grant = sql.slice(sql.indexOf('INSERT INTO role_permissions'));
  const match = /r\.role_name IN \(([^)]*)\)/.exec(grant);
  assert.ok(match, 'قائمة الأدوار موجودة');
  const roles = match![1]!
    .split(',')
    .map((r) => r.trim().replace(/^'|'$/g, ''))
    .sort();
  assert.deepEqual(roles, ['DOCTOR', 'PHARMACIST', 'SUPER_ADMIN', 'SYSTEM_ADMIN']);
});

test('MIGRATION: الأدوار المستثناة لا تُمنح — والقائمة لا تذكر أياً منها', () => {
  const sql = migrationSource();
  const grant = sql.slice(sql.indexOf('INSERT INTO role_permissions'));
  for (const roleName of ['NURSE', 'RECEPTIONIST', 'ACCOUNTANT', 'FINANCIAL_AUDITOR']) {
    assert.ok(!grant.includes(`'${roleName}'`), `${roleName} لا يُمنح`);
  }
});

test('MIGRATION: الترحيل idempotent ولا يمنح CREATE_PRESCRIPTION للصيدلي', () => {
  const sql = migrationSource();
  assert.match(sql, /ON CONFLICT \(permission_key\) DO UPDATE/);
  assert.match(sql, /ON CONFLICT DO NOTHING/);
  assert.ok(!/role_name IN \([^)]*PHARMACIST[^)]*\)[\s\S]{0,200}CREATE_PRESCRIPTION/.test(sql), 'لا منح مُجمَّل خطأ');
});

test('MIGRATION: ملف الأثر أقدم لا يمس', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', '..', 'src', 'database', 'migrations'));
  assert.ok(files.includes('045_prescription_item_fulfilment.sql'), '045 موجود');
  assert.ok(files.includes('046_prescription_fulfilment_permission.sql'), '046 موجود');
  assert.ok(
    !files.some((f) => /^04[0-5]_/.test(f) && f !== '045_prescription_item_fulfilment.sql' && f.startsWith('046')),
    'لا ملف متداخل أو مكرر',
  );
});

test('SEED: المفتاح الجديد ضمن قائمة صلاحيات البذر', () => {
  const seed = fs.readFileSync(require.resolve('../scripts/seed'), 'utf8');
  assert.match(seed, /key: 'RECORD_PRESCRIPTION_FULFILMENT', group: 'Pharmacy'/);
});

/* ==========================================================================
 * 5. الواجهة تستخدم المفتاح الجديد لا القديم
 * ========================================================================== */

test('UI: بوابة القرار في الواجهة تستخدم المفتاح الجديد', () => {
  const view = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'views', 'PrescriptionsView.jsx'),
    'utf8',
  );
  assert.match(view, /permissions\?\.includes\('RECORD_PRESCRIPTION_FULFILMENT'\)/);
  const gate = view.slice(view.indexOf('const canDecide'));
  assert.doesNotMatch(gate.slice(0, 400), /CREATE_PRESCRIPTION/, 'لا أثر للبوابة القديمة');
});
