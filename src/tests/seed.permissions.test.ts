import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T10 — بذر الصلاحيات (R9).
 *
 * العجز: قائمة PERMISSIONS في seed.ts كانت بلا مفاتيح الجدولة (أُضيفت في
 * الترحيلات 054/058 فقط)، وقاعدة "المزامنة لمرة واحدة إذا كان الدور بلا أي
 * صلاحية" كانت تُسقط قائمة الدور بالكامل متى منحه ترحيل صلاحية واحدة —
 * في بذر جديد كان الطبيب بلا VIEW_PATIENTS وبلا MANAGE_DOCTOR_LEAVE.
 *
 * الاختبار يفحص المصدر نفسه (seed.ts لا يمكن استيراده: يستدعي البذر عند
 * التحميل) ويتحقق من:
 *  1) كل مفاتيح الجدولة في قائمة الصلاحيات.
 *  2) منح الأدوار يطابق مصفوفة الأدوار × العمليات.
 *  3) المزامنة صارت بإصدار وتُنفَّذ إضافةً فقط، لا "مرة واحدة عند فراغ الدور".
 *  4) استثناء DELETE_USERS لمدير النظام يعمل فعلاً (عمود role_name في الاستعلام).
 */

// البذر لا يمكن استيراده (ينفّذ عند التحميل)، لذا يُفحص المصدر.
// يعمل في الحالتين: تشغيل من المصدر (tsx) وتشغيل من dist بعد البناء.
const resolveSeedSource = (): string => {
  const candidates = [
    path.join(__dirname, '..', 'scripts', 'seed.ts'),
    path.join(__dirname, '..', 'scripts', 'seed.js'),
    path.join(__dirname, '..', '..', 'src', 'scripts', 'seed.ts'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, 'لم يُعثر على src/scripts/seed.ts');
  return found as string;
};

const SEED_PATH = resolveSeedSource();
const SEED_SOURCE = fs.readFileSync(SEED_PATH, 'utf8');

const SCHEDULING_KEYS = [
  'VIEW_HOLIDAYS',
  'MANAGE_HOLIDAYS',
  'APPROVE_HOLIDAYS',
  'VIEW_DOCTOR_LEAVE',
  'MANAGE_DOCTOR_LEAVE',
  'APPROVE_DOCTOR_LEAVE',
  'MANAGE_WORK_EXCEPTIONS',
  'APPROVE_WORK_EXCEPTIONS',
  'VIEW_SCHEDULE_IMPACT',
];

/** يستخرج قيمة نصية من مصفوفة كائنات داخل مصدر البذر. */
const extractPermissionList = (source: string): string[] => {
  const permissionsBlock = source.slice(source.indexOf('const PERMISSIONS = ['), source.indexOf('const ROLES = ['));
  const keys = [...permissionsBlock.matchAll(/key:\s*'([A-Z_]+)'/g)].map((match) => match[1] as string);
  return keys;
};

/** يستخرج قائمة مفاتيح الدور من ROLE_PERMISSIONS. */
const extractRoleKeys = (source: string, role: string): string[] => {
  const block = source.slice(source.indexOf('const ROLE_PERMISSIONS'), source.indexOf('const seedDatabase'));
  const roleIndex = block.indexOf(`${role}: [`);
  assert.ok(roleIndex >= 0, `دور ${role} غير موجود في ROLE_PERMISSIONS`);
  const start = block.indexOf('[', roleIndex);
  const end = block.indexOf(']', start);
  const body = block.slice(start, end);
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
};

test('seed: كل مفاتيح صلاحيات الجدولة موجودة في قائمة الصلاحيات', () => {
  const keys = extractPermissionList(SEED_SOURCE);
  for (const key of SCHEDULING_KEYS) {
    assert.ok(keys.includes(key), `مفتاح ${key} مفقود من PERMISSIONS في seed.ts`);
  }
});

test('seed: منح الأدوار يطابق مصفوفة الدور × العملية', () => {
  const doctor = extractRoleKeys(SEED_SOURCE, 'DOCTOR');
  const receptionist = extractRoleKeys(SEED_SOURCE, 'RECEPTIONIST');
  const accountant = extractRoleKeys(SEED_SOURCE, 'ACCOUNTANT');
  const auditor = extractRoleKeys(SEED_SOURCE, 'FINANCIAL_AUDITOR');

  // الطبيب: يقرأ التقويم والأثر ويطلب إجازة لنفسه — ولا يعتمد شيئاً
  for (const key of ['VIEW_HOLIDAYS', 'VIEW_DOCTOR_LEAVE', 'VIEW_SCHEDULE_IMPACT', 'MANAGE_DOCTOR_LEAVE']) {
    assert.ok(doctor.includes(key), `الطبيب بلا ${key}`);
  }
  for (const key of ['APPROVE_HOLIDAYS', 'APPROVE_DOCTOR_LEAVE', 'APPROVE_WORK_EXCEPTIONS']) {
    assert.ok(!doctor.includes(key), `الطبيب لا يجب أن يملك ${key}`);
  }

  // الاستقبال: يقترح العطل والاستثناءات والإجازات، ولا يعتمد أياً منها
  for (const key of ['VIEW_HOLIDAYS', 'MANAGE_HOLIDAYS', 'MANAGE_WORK_EXCEPTIONS', 'MANAGE_DOCTOR_LEAVE', 'VIEW_SCHEDULE_IMPACT']) {
    assert.ok(receptionist.includes(key), `موظف الاستقبال بلا ${key}`);
  }
  for (const key of ['APPROVE_HOLIDAYS', 'APPROVE_DOCTOR_LEAVE', 'APPROVE_WORK_EXCEPTIONS']) {
    assert.ok(!receptionist.includes(key), `موظف الاستقبال لا يجب أن يملك ${key}`);
  }

  // الأدوار المالية لا تُمنح صلاحيات الجدولة
  for (const key of SCHEDULING_KEYS) {
    assert.ok(!accountant.includes(key), `المحاسب لا يجب أن يملك ${key}`);
    assert.ok(!auditor.includes(key), `المدقق المالي لا يجب أن يملك ${key}`);
  }
});

test('seed: المزامنة صارت مُصدَّرة بإصدار وتُنفَّذ إضافةً فقط', () => {
  assert.match(
    SEED_SOURCE,
    /ROLE_PERMISSION_SYNC_VERSION\s*=\s*'\d+'/,
    'يجب أن تُعرَّف نسخة مزامنة الصلاحيات'
  );
  assert.match(
    SEED_SOURCE,
    /seed\.role_permissions\.version/,
    'يجب حفظ نسخة المزامنة في system_settings'
  );
  // القاعدة القديمة (تخطّي الدور إن كان يملك أي صلاحية) يجب أن تكون gone
  assert.ok(
    !/COUNT\(\*\)::int AS cnt FROM role_permissions/.test(SEED_SOURCE),
    'قاعدة "المزامنة لمرة واحدة عند فراغ الدور" ما زالت موجودة — وهي سبب R9'
  );
});

test('seed: استثناء DELETE_USERS لمدير النظام يعمل (عمود role_name مختار)', () => {
  assert.match(
    SEED_SOURCE,
    /SELECT role_id, role_name FROM roles WHERE role_name IN \('SUPER_ADMIN', 'SYSTEM_ADMIN'\)/,
    'استعلام أدوار الإدارة يجب أن يجلب role_name — بدونه شرط استثناء DELETE_USERS لا يعمل'
  );
});
