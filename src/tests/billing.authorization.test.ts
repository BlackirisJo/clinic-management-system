import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { accessibleClinicIds, financeClinicScope, isAssignedToClinic, isGlobalFinanceRole } from '../middlewares/auth.middleware';

// ————————————————————————————————————————————————————————————————
// بناء كائن طلب (req) محاكى لأغراض اختبار دوال النطاق والصلاحيات.
// الدوال المستهدفة (auth.middleware.ts) لا تلمس قاعدة البيانات، لذا
// يمكن اختبارها أوفلاين بدون PostgreSQL على الإطلاق.
// ————————————————————————————————————————————————————————————————
const roles: Record<string, { roleName: string; permissions: string[]; clinicId: number | null; clinicIds: number[] }> = {
  SUPER_ADMIN: { roleName: 'SUPER_ADMIN', permissions: ['MANAGE_USERS', 'MANAGE_CLINICS'], clinicId: 1, clinicIds: [1] },
  SYSTEM_ADMIN: { roleName: 'SYSTEM_ADMIN', permissions: ['MANAGE_USERS', 'MANAGE_CLINICS'], clinicId: 1, clinicIds: [1, 2] },
  ACCOUNTANT: {
    roleName: 'ACCOUNTANT',
    permissions: ['MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS', 'VIEW_PATIENTS'],
    clinicId: 2,
    clinicIds: [],
  },
  DOCTOR: { roleName: 'DOCTOR', permissions: ['VIEW_PATIENTS', 'CREATE_VISIT'], clinicId: 1, clinicIds: [1, 2] },
  NURSE: { roleName: 'NURSE', permissions: ['VIEW_PATIENTS', 'CREATE_VISIT'], clinicId: 2, clinicIds: [2] },
  RECEPTIONIST: { roleName: 'RECEPTIONIST', permissions: ['VIEW_PATIENTS', 'CREATE_PATIENT'], clinicId: 1, clinicIds: [1] },
};

// محاكاة دليل العيادات النشطة كما يعيده listFinancialClinicDirectory
const MOCK_ACTIVE_CLINICS = [
  { clinic_id: 1, clinic_name: 'Clinic A', is_active: true },
  { clinic_id: 2, clinic_name: 'Clinic B', is_active: true },
  { clinic_id: 3, clinic_name: 'Clinic C (Inactive)', is_active: false },
];

// محاكاة استعلام الخدمات: null = يرى الجميع، وإلا قائمة معرّفات العيادات
const simulateServicesQuery = (allowedClinics: number[] | null, all: any[]) =>
  allowedClinics === null ? all : all.filter((s) => allowedClinics.includes(s.clinic_id));

const simulateExpensesQuery = (allowedClinics: number[] | null, all: any[]) =>
  allowedClinics === null ? all : all.filter((e) => allowedClinics.includes(e.clinic_id));

const simulateFinancialDirectory = (allowedClinics: number[] | null) =>
  allowedClinics === null
    ? MOCK_ACTIVE_CLINICS.filter((c) => c.is_active)
    : MOCK_ACTIVE_CLINICS.filter((c) => c.is_active && allowedClinics.includes(c.clinic_id));

const reqFor = (roleKey: string): AuthenticatedRequest => {
  const r = roles[roleKey];
  if (!r) throw new Error(`Unknown role key: ${roleKey}`);
  return {
    user: { userId: 1, roleId: 1, clinicId: r.clinicId, roleName: r.roleName, permissions: r.permissions, clinicIds: r.clinicIds },
  } as unknown as AuthenticatedRequest;
};

// ————————————————————————————————————————————————————————————————
// 1) isGlobalFinanceRole
// ————————————————————————————————————————————————————————————————
test('isGlobalFinanceRole: SUPER_ADMIN/SYSTEM_ADMIN/ACCOUNTANT هم ماليون مركزيون', () => {
  assert.equal(isGlobalFinanceRole(reqFor('SUPER_ADMIN')), true);
  assert.equal(isGlobalFinanceRole(reqFor('SYSTEM_ADMIN')), true);
  assert.equal(isGlobalFinanceRole(reqFor('ACCOUNTANT')), true);
});

test('isGlobalFinanceRole: الأدوار التشغيلية العادية ليست مالية مركزية', () => {
  assert.equal(isGlobalFinanceRole(reqFor('DOCTOR')), false);
  assert.equal(isGlobalFinanceRole(reqFor('NURSE')), false);
  assert.equal(isGlobalFinanceRole(reqFor('RECEPTIONIST')), false);
});
// ————————————————————————————————————————————————————————————————
// 2) financeClinicScope — مصدر الحقيقة لنطاق العمليات المالية
// ————————————————————————————————————————————————————————————————
test('financeClinicScope: ACCOUNTANT يرى كل العيادات (null) ولو لم يُسند لأي عيادة', () => {
  assert.equal(financeClinicScope(reqFor('ACCOUNTANT')), null);
});

test('financeClinicScope: SYSTEM_ADMIN/SUPER_ADMIN يرون كل العيادات (null)', () => {
  assert.equal(financeClinicScope(reqFor('SYSTEM_ADMIN')), null);
  assert.equal(financeClinicScope(reqFor('SUPER_ADMIN')), null);
});

test('financeClinicScope: المستخدم العادي يرى عياداته المسندة فقط (الأساسية + clinic_staff)', () => {
  assert.deepEqual(financeClinicScope(reqFor('DOCTOR')), [1, 2]);
});

test('financeClinicScope: RECEPTIONIST يرى عيادته الأساسية فقط', () => {
  assert.deepEqual(financeClinicScope(reqFor('RECEPTIONIST')), [1]);
});

// ————————————————————————————————————————————————————————————————
// 3) دليل العيادات المالية
// ————————————————————————————————————————————————————————————————
test('ACCOUNTANT يحصل على جميع العيادات النشطة في الدليل المالي', () => {
  const result = simulateFinancialDirectory(financeClinicScope(reqFor('ACCOUNTANT')));
  assert.equal(result.length, 2);
  assert.ok(result.some((c) => c.clinic_name === 'Clinic A'));
  assert.ok(result.some((c) => c.clinic_name === 'Clinic B'));
});

test('SYSTEM_ADMIN يحصل على جميع العيادات النشطة في الدليل المالي', () => {
  const result = simulateFinancialDirectory(financeClinicScope(reqFor('SYSTEM_ADMIN')));
  assert.equal(result.length, 2);
});

test('المستخدم العادي يحصل على عياداته المسندة فقط في الدليل المالي', () => {
  const result = simulateFinancialDirectory(financeClinicScope(reqFor('RECEPTIONIST')));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.clinic_name, 'Clinic A');
});
// ————————————————————————————————————————————————————————————————
// 4) إنشاء خدمة (بدون قاعدة بيانات؛ نختبر صلاحية النطاق والتحقق من نشاط العيادة)
// ————————————————————————————————————————————————————————————————
const simulateCreateService = (roleKey: string, targetClinicId: number): { ok: boolean; message?: string } => {
  const scope = financeClinicScope(reqFor(roleKey));
  if (scope !== null && !scope.includes(targetClinicId)) {
    return { ok: false, message: 'لا يمكنك إنشاء خدمة في عيادة غير مسندة لك' };
  }
  const clinic = MOCK_ACTIVE_CLINICS.find((c) => c.clinic_id === targetClinicId);
  if (!clinic || !clinic.is_active) return { ok: false, message: 'العيادة غير موجودة أو غير فعالة' };
  return { ok: true };
};

test('ACCOUNTANT يستطيع إنشاء خدمة في Clinic A', () => {
  assert.equal(simulateCreateService('ACCOUNTANT', 1).ok, true);
});

test('ACCOUNTANT يستطيع إنشاء خدمة في Clinic B', () => {
  assert.equal(simulateCreateService('ACCOUNTANT', 2).ok, true);
});

test('ACCOUNTANT لا يستطيع إنشاء خدمة في عيادة غير نشطة', () => {
  const r = simulateCreateService('ACCOUNTANT', 3);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'العيادة غير موجودة أو غير فعالة');
});

test('المستخدم العادي لا يستطيع إنشاء خدمة في عيادة غير مسندة له', () => {
  const r = simulateCreateService('DOCTOR', 4);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'لا يمكنك إنشاء خدمة في عيادة غير مسندة لك');
});

test('المستخدم العادي يستطيع إنشاء خدمة في عيادته المسندة', () => {
  assert.equal(simulateCreateService('DOCTOR', 1).ok, true);
// ————————————————————————————————————————————————————————————————
// 5) إنشاء مصروف (بدون قاعدة بيانات؛ نختبر صلاحية النطاق والتحقق من نشاط العيادة)
// ————————————————————————————————————————————————————————————————
const simulateCreateExpense = (roleKey: string, targetClinicId: number): { ok: boolean; message?: string } => {
  const scope = financeClinicScope(reqFor(roleKey));
  if (scope !== null && !scope.includes(targetClinicId)) {
    return { ok: false, message: 'لا يمكنك تسجيل مصروف في عيادة غير مسندة لك' };
  }
  const clinic = MOCK_ACTIVE_CLINICS.find((c) => c.clinic_id === targetClinicId);
  if (!clinic || !clinic.is_active) return { ok: false, message: 'العيادة غير موجودة أو غير فعالة' };
  return { ok: true };
};

test('ACCOUNTANT يستطيع إنشاء مصروف في Clinic A', () => {
  assert.equal(simulateCreateExpense('ACCOUNTANT', 1).ok, true);
});

test('ACCOUNTANT يستطيع إنشاء مصروف في Clinic B', () => {
  assert.equal(simulateCreateExpense('ACCOUNTANT', 2).ok, true);
});

test('ACCOUNTANT لا يستطيع إنشاء مصروف في عيادة غير نشطة', () => {
  const r = simulateCreateExpense('ACCOUNTANT', 3);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'العيادة غير موجودة أو غير فعالة');
});

test('المستخدم العادي لا يستطيع إنشاء مصروف في عيادة غير مسندة له', () => {
  const r = simulateCreateExpense('DOCTOR', 4);
  assert.equal(r.ok, false);
// المستخدم العادي يرى فقط ما يخص عياداته
test('المستخدم العادي يرى فقط خدمات/مصاريف عياداته المسندة', () => {
  const scope = financeClinicScope(reqFor('DOCTOR')); // [1, 2]
  const services = simulateServicesQuery(scope, EXISTING_SERVICES);
  assert.deepEqual(services.map((s) => s.service_id), [1, 2, 3]);

  const expenses = simulateExpensesQuery(scope, EXISTING_EXPENSES);
  assert.deepEqual(expenses.map((e) => e.expense_id), [1, 2]);
});

// ————————————————————————————————————————————————————————————————
// 7) البيانات القديمة لا تختفي (عرض كامل بلا فلترة خاطئة)
// ————————————————————————————————————————————————————————————————
test('البيانات القديمة تبقى كلها ظاهرة بعد "تسجيل دخول" المحاسب', () => {
  const beforeServices = EXISTING_SERVICES.length;
  const beforeExpenses = EXISTING_EXPENSES.length;

  const accountantScope = financeClinicScope(reqFor('ACCOUNTANT'));
  const services = simulateServicesQuery(accountantScope, EXISTING_SERVICES);
  const expenses = simulateExpensesQuery(accountantScope, EXISTING_EXPENSES);

  assert.equal(services.length, beforeServices);
  assert.equal(expenses.length, beforeExpenses);
});

// ————————————————————————————————————————————————————————————————
// 8) لا يحصل المحاسب على صلاحيات إدارية (Managers/System فقط)
// ————————————————————————————————————————————————————————————————
test('ACCOUNTANT لا يحصل على صلاحيات إدارة المستخدمين أو النظام بسبب الإصلاح', () => {
  const accountant = roles.ACCOUNTANT;
  if (!accountant) throw new Error('ACCOUNTANT role fixture missing');
  const perms: string[] = accountant.permissions;
  const forbidden = ['MANAGE_USERS', 'MANAGE_CLINICS', 'MANAGE_BACKUPS', 'RESTORE_BACKUPS', 'VIEW_BACKUP_LOGS'];
  for (const p of forbidden) assert.equal(perms.includes(p), false, `ACCOUNTANT يجب ألا يملك ${p}`);
  assert.equal(isAssignedToClinic(reqFor('ACCOUNTANT'), 3), false);
});

test('isAssignedToClinic: يعتمد على clinicIds ثم clinicId الأساسي', () => {
  assert.equal(isAssignedToClinic(reqFor('DOCTOR'), 2), true);
  assert.equal(isAssignedToClinic(reqFor('DOCTOR'), 5), false);
});

// ————————————————————————————————————————————————————————————————
// 9) accessibleClinicIds (سلوك باقي الأدوار لم يتغير)
// ————————————————————————————————————————————————————————————————
test('accessibleClinicIds: المدراء يعودون null دون تغيير', () => {
  assert.equal(accessibleClinicIds(reqFor('SYSTEM_ADMIN')), null);
});

test('accessibleClinicIds: المستخدم العادي يعيد عياداته المسندة', () => {
  assert.deepEqual(accessibleClinicIds(reqFor('DOCTOR')), [1, 2]);
});
  assert.equal(r.message, 'لا يمكنك تسجيل مصروف في عيادة غير مسندة لك');
});

test('المستخدم العادي يستطيع إنشاء مصروف في عيادته المسندة', () => {
  assert.equal(simulateCreateExpense('DOCTOR', 2).ok, true);
});

// ————————————————————————————————————————————————————————————————
// 6) العرض: ACCOUNTANT يرى كل الخدمات والمصاريف (بما فيها ما أنشأه SYSTEM_ADMIN)
// ————————————————————————————————————————————————————————————————
const EXISTING_SERVICES = [
  { service_id: 1, clinic_id: 1, service_name: 'Service A', price: 100, doctor_percentage: 0 },
  { service_id: 2, clinic_id: 2, service_name: 'Service B', price: 200, doctor_percentage: 10 },
  { service_id: 3, clinic_id: 1, service_name: 'Service C', price: 150, doctor_percentage: 15 },
];
const EXISTING_EXPENSES = [
  { expense_id: 1, clinic_id: 1, category: 'Rent', amount: 500, spent_by_user_id: 1 },
  { expense_id: 2, clinic_id: 2, category: 'Supplies', amount: 300, spent_by_user_id: 2 },
];

test('ACCOUNTANT يرى خدمة/مصروفاً أنشأهما SYSTEM_ADMIN في عيادتين مختلفتين', () => {
  const scope = financeClinicScope(reqFor('ACCOUNTANT')); // null
  const services = simulateServicesQuery(scope, EXISTING_SERVICES);
  const expenses = simulateExpensesQuery(scope, EXISTING_EXPENSES);

  assert.equal(services.length, EXISTING_SERVICES.length);
  assert.ok(services.some((s) => s.service_name === 'Service A'));
  assert.ok(services.some((s) => s.service_name === 'Service B'));

  assert.equal(expenses.length, EXISTING_EXPENSES.length);
  assert.ok(expenses.some((e) => e.category === 'Rent'));
  assert.ok(expenses.some((e) => e.category === 'Supplies'));
});
});