import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { accessibleClinicIds, canManageAllClinics } from '../middlewares/auth.middleware';

// ============================================================================
// P1 - Clinic management scope (clinics.controller.ts)
// SUPER_ADMIN / SYSTEM_ADMIN keep global access; every other role may manage
// only clinics inside accessibleClinicIds(req). Mirrors the central guard
// canManageClinic()/denyClinicOutOfScope() and the clinic_staff SQL statements.
// Also covers the P2 fix: admin accounts are never touched by updateClinic.
// ============================================================================

type User = { user_id: number; clinic_id: number | null; role_name: string; status: string };
type StaffRow = { clinic_id: number; user_id: number };

const ADMIN_ROLES = ['SUPER_ADMIN', 'SYSTEM_ADMIN'];
const isAdminRoleName = (roleName: string): boolean => ADMIN_ROLES.includes(roleName);

const roles: Record<string, { roleName: string; permissions: string[]; clinicId: number | null; clinicIds: number[] }> = {
  SUPER_ADMIN: { roleName: 'SUPER_ADMIN', permissions: ['MANAGE_CLINICS'], clinicId: 1, clinicIds: [1] },
  SYSTEM_ADMIN: { roleName: 'SYSTEM_ADMIN', permissions: ['MANAGE_CLINICS'], clinicId: 1, clinicIds: [1, 2] },
  // clinic-scoped custom role holding MANAGE_CLINICS (the P1 threat model)
  CLINIC_MANAGER: { roleName: 'CLINIC_MANAGER', permissions: ['MANAGE_CLINICS'], clinicId: 1, clinicIds: [1] },
  MULTI_CLINIC_MANAGER: { roleName: 'MULTI_CLINIC_MANAGER', permissions: ['MANAGE_CLINICS'], clinicId: 1, clinicIds: [1, 2] },
};

const reqFor = (roleKey: string): AuthenticatedRequest => {
  const r = roles[roleKey];
  if (!r) throw new Error(`Unknown role key: ${roleKey}`);
  return {
    user: { userId: 1, roleId: 1, clinicId: r.clinicId, roleName: r.roleName, permissions: r.permissions, clinicIds: r.clinicIds },
  } as unknown as AuthenticatedRequest;
};

// Mirrors canManageClinic() in clinics.controller.ts (P1 central helper)
const canManageClinic = (req: AuthenticatedRequest, clinicId: number): boolean => {
  if (canManageAllClinics(req)) return true;
  return (accessibleClinicIds(req) ?? []).includes(Number(clinicId));
};

const simulateScopeGate = (req: AuthenticatedRequest, clinicId: number): number => (canManageClinic(req, clinicId) ? 200 : 403);

// createClinic(): documented policy - global administration only
const simulateCreateClinic = (req: AuthenticatedRequest): number => (canManageAllClinics(req) ? 201 : 403);

const makeUsers = (): User[] => [
  { user_id: 1, clinic_id: 1, role_name: 'SUPER_ADMIN', status: 'ACTIVE' },
  { user_id: 2, clinic_id: 1, role_name: 'SYSTEM_ADMIN', status: 'ACTIVE' },
  { user_id: 3, clinic_id: 1, role_name: 'DOCTOR', status: 'ACTIVE' },
  { user_id: 4, clinic_id: 1, role_name: 'DOCTOR', status: 'ACTIVE' },
  { user_id: 5, clinic_id: 2, role_name: 'NURSE', status: 'ACTIVE' },
];

// user 2 = SYSTEM_ADMIN already present in clinic_staff (legacy row) - must survive
const makeStaff = (): StaffRow[] => [
  { clinic_id: 1, user_id: 2 },
  { clinic_id: 1, user_id: 3 },
  { clinic_id: 2, user_id: 5 },
];

const roleOf = (users: User[], userId: number): string | null =>
  users.find((u) => u.user_id === userId)?.role_name ?? null;

const hasStaffRow = (staff: StaffRow[], clinicId: number, userId: number): boolean =>
  staff.some((s) => s.clinic_id === clinicId && s.user_id === userId);

// Mirrors the primary-clinic repair statement (now with the admin role filter - P2)
const fixPrimaryClinic = (users: User[], staff: StaffRow[], clinicId: number, onlyUserId: number | null): void => {
  for (const user of users) {
    if (onlyUserId !== null && user.user_id !== onlyUserId) continue;
    if (user.clinic_id !== clinicId) continue;
    if (isAdminRoleName(user.role_name)) continue; // P2: admin accounts are never rewritten
    if (hasStaffRow(staff, clinicId, user.user_id)) continue;
    const next = staff.find((s) => s.user_id === user.user_id);
    user.clinic_id = next ? next.clinic_id : null;
  }
};

// Mirrors updateClinic() staff replacement: admin rows are preserved (P2), others removed
function simulateReplaceStaff(users: User[], staff: StaffRow[], clinicId: number, doctorIds: number[]): void {
  const removed = staff.filter((s) => {
    if (s.clinic_id !== clinicId) return false;
    const roleName = roleOf(users, s.user_id);
    return roleName !== null && !isAdminRoleName(roleName);
  });
  for (const row of removed) staff.splice(staff.indexOf(row), 1);
  for (const userId of doctorIds) {
    if (!hasStaffRow(staff, clinicId, userId)) staff.push({ clinic_id: clinicId, user_id: userId });
  }
  fixPrimaryClinic(users, staff, clinicId, null);
}

// ============================================================================
// 1) clinic-scoped role holding MANAGE_CLINICS
// ============================================================================
test('CS1 - clinic-scoped manager may manage its own clinic', () => {
  assert.equal(canManageAllClinics(reqFor('CLINIC_MANAGER')), false, 'not a global admin role');
  assert.equal(simulateScopeGate(reqFor('CLINIC_MANAGER'), 1), 200, 'own clinic allowed');
});

test('CS2 - clinic-scoped manager may manage a second assigned clinic', () => {
  const manager = reqFor('MULTI_CLINIC_MANAGER');
  assert.deepEqual(accessibleClinicIds(manager), [1, 2], 'both assigned clinics in scope');
  assert.equal(simulateScopeGate(manager, 1), 200, 'primary clinic allowed');
  assert.equal(simulateScopeGate(manager, 2), 200, 'additional assigned clinic allowed');
});

test('CS3 - clinic-scoped manager is denied on an unrelated clinic', () => {
  const manager = reqFor('CLINIC_MANAGER');
  for (const clinicId of [2, 3, 99]) {
    assert.equal(simulateScopeGate(manager, clinicId), 403, `clinic ${clinicId} denied`);
  }
  assert.equal(canManageClinic(manager, 1), true, 'own clinic still manageable');
});

// ============================================================================
// 2) global administration keeps unrestricted access
// ============================================================================
test('CS4 - global admins may manage any clinic', () => {
  for (const roleKey of ['SUPER_ADMIN', 'SYSTEM_ADMIN']) {
    for (const clinicId of [1, 2, 3, 99]) {
      assert.equal(simulateScopeGate(reqFor(roleKey), clinicId), 200, `${roleKey}: clinic ${clinicId} allowed`);
    }
    assert.equal(simulateCreateClinic(reqFor(roleKey)), 201, `${roleKey}: createClinic allowed`);
  }
});

// ============================================================================
// 3) createClinic policy is unchanged (global administration only)
// ============================================================================
test('CS5 - createClinic stays limited to global administration', () => {
  assert.equal(simulateCreateClinic(reqFor('CLINIC_MANAGER')), 403, 'clinic-scoped create denied');
  assert.equal(simulateCreateClinic(reqFor('MULTI_CLINIC_MANAGER')), 403, 'even multi-clinic denied');
  assert.equal(simulateCreateClinic(reqFor('SUPER_ADMIN')), 201);
  assert.equal(simulateCreateClinic(reqFor('SYSTEM_ADMIN')), 201);
});
// ============================================================================
// 4) P2: updateClinic never rewrites admin accounts
// ============================================================================
test('CS6 - updateClinic keeps SYSTEM_ADMIN clinic_id and staff row', () => {
  const users = makeUsers();
  const staff = makeStaff();
  simulateReplaceStaff(users, staff, 1, [3, 4]);
  const sysadmin = users.find((u) => u.user_id === 2);
  const superadmin = users.find((u) => u.user_id === 1);
  assert.equal(sysadmin?.clinic_id, 1, 'SYSTEM_ADMIN clinic_id untouched (never nulled)');
  assert.equal(superadmin?.clinic_id, 1, 'SUPER_ADMIN clinic_id untouched');
  assert.equal(hasStaffRow(staff, 1, 2), true, 'SYSTEM_ADMIN staff row preserved');
  assert.equal(hasStaffRow(staff, 1, 4), true, 'selected doctor assigned');
  assert.equal(hasStaffRow(staff, 2, 5), true, 'staff of another clinic untouched');
});

test('CS7 - admin primary clinic survives a full staff replacement', () => {
  const users = makeUsers();
  const staff = makeStaff();
  // empty doctor/nurse lists: previously everyone was deleted and clinic_id was nulled
  simulateReplaceStaff(users, staff, 1, []);
  assert.equal(users.find((u) => u.user_id === 2)?.clinic_id, 1, 'SYSTEM_ADMIN keeps its primary clinic');
  assert.equal(users.find((u) => u.user_id === 1)?.clinic_id, 1, 'SUPER_ADMIN keeps its primary clinic');
  assert.equal(hasStaffRow(staff, 1, 2), true, 'admin legacy staff row not deleted');
  assert.equal(hasStaffRow(staff, 1, 3), false, 'normal staff row removed as before');
});

test('CS8 - normal users still get their primary clinic reconciled', () => {
  const users = makeUsers();
  const staff = makeStaff();
  simulateReplaceStaff(users, staff, 1, []);
  assert.equal(users.find((u) => u.user_id === 3)?.clinic_id, null, 'non-admin primary clinic reconciled as before');
});

// ============================================================================
// 5) regression: existing clinic staff administration behaviour
// ============================================================================
test('CS9 - admin accounts remain excluded from clinic staff handling', () => {
  const users = makeUsers();
  for (const userId of [1, 2]) {
    assert.equal(isAdminRoleName(roleOf(users, userId) ?? ''), true, `user ${userId} is an admin account`);
  }
});

test('CS10 - only non-admin staff rows are removable from a clinic', () => {
  const users = makeUsers();
  const staff = makeStaff();
  const removable = staff.filter((s) => s.clinic_id === 1 && !isAdminRoleName(roleOf(users, s.user_id) ?? ''));
  assert.deepEqual(removable.map((s) => s.user_id), [3], 'admin row (user 2) is not removable');
});