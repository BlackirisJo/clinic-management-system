import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { accessibleClinicIds, canManageAllClinics, financeClinicScope, isGlobalFinanceRole } from '../middlewares/auth.middleware';

// ============================================================================
// P0.3 - Global clinic scope for USER MANAGEMENT (users.controller.ts)
// Regression guard: managerIsGlobal / listUsers scope must come from
// canManageAllClinics() (admin roles only) and NOT from isGlobalFinanceRole()
// (financial roles such as ACCOUNTANT, or any role holding MANAGE_SERVICES /
// CREATE_EXPENSE). Financial scope is intentionally left untouched.
// The helpers below mirror the actual controller gates line by line.
// ============================================================================

const roles: Record<string, { roleName: string; permissions: string[]; clinicId: number | null; clinicIds: number[] }> = {
  SUPER_ADMIN: { roleName: 'SUPER_ADMIN', permissions: ['MANAGE_USERS', 'MANAGE_CLINICS'], clinicId: 1, clinicIds: [1] },
  SYSTEM_ADMIN: { roleName: 'SYSTEM_ADMIN', permissions: ['MANAGE_USERS', 'MANAGE_CLINICS'], clinicId: 1, clinicIds: [1, 2] },
  ACCOUNTANT: {
    roleName: 'ACCOUNTANT',
    permissions: ['VIEW_PATIENTS', 'MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS'],
    clinicId: 2,
    clinicIds: [2],
  },
  // Custom role: financial permission (MANAGE_SERVICES) + MANAGE_USERS.
  // isGlobalFinanceRole() === true, canManageAllClinics() === false -> the exact P0.3 hole.
  FINANCE_MANAGER: {
    roleName: 'FINANCE_MANAGER',
    permissions: ['MANAGE_USERS', 'MANAGE_SERVICES', 'CREATE_EXPENSE', 'VIEW_REPORTS'],
    clinicId: 2,
    clinicIds: [2],
  },
  // Clinic-restricted operational manager: user management inside its own clinic only.
  CLINIC_MANAGER: { roleName: 'CLINIC_MANAGER', permissions: ['MANAGE_USERS', 'VIEW_PATIENTS'], clinicId: 1, clinicIds: [1] },
  DOCTOR: { roleName: 'DOCTOR', permissions: ['VIEW_PATIENTS', 'CREATE_VISIT'], clinicId: 1, clinicIds: [1] },
};

const reqFor = (roleKey: string): AuthenticatedRequest => {
  const r = roles[roleKey];
  if (!r) throw new Error(`Unknown role key: ${roleKey}`);
  return {
    user: { userId: 1, roleId: 1, clinicId: r.clinicId, roleName: r.roleName, permissions: r.permissions, clinicIds: r.clinicIds },
  } as unknown as AuthenticatedRequest;
};

type Target = { user_id: number; clinic_id: number | null; role_name: string };
const targetIn = (clinicId: number | null, roleName = 'DOCTOR'): Target => ({ user_id: 99, clinic_id: clinicId, role_name: roleName });

// listUsers (lines 24-45): global admins may see every clinic; everyone else is
// clamped to their assigned clinics, and an out-of-scope clinic_id filter is 403.
function simulateListUsersScope(req: AuthenticatedRequest, requestedClinic: number | null) {
  const isGlobal = canManageAllClinics(req); // P0.3 - was isGlobalFinanceRole
  if (isGlobal) return { httpStatus: 200, scopedTo: requestedClinic ? [requestedClinic] : null };
  const ids = accessibleClinicIds(req) ?? [];
  if (requestedClinic) {
    if (!ids.includes(requestedClinic)) return { httpStatus: 403, scopedTo: [] as number[] };
    return { httpStatus: 200, scopedTo: [requestedClinic] };
  }
  return { httpStatus: 200, scopedTo: ids };
}

// createUser (lines 136-144)
function simulateCreateUser(req: AuthenticatedRequest, body: { role_name: string; clinic_id?: number | null }) {
  const managerIsGlobal = canManageAllClinics(req); // P0.3
  const targetClinicId = body.clinic_id ?? req.user?.clinicId;
  if (!managerIsGlobal && targetClinicId !== req.user?.clinicId) return 403;
  if (body.role_name === 'SUPER_ADMIN' && !managerIsGlobal) return 403;
  if (body.role_name !== 'SUPER_ADMIN' && !targetClinicId) return 400;
  return 201;
}

// updateUser (lines 189-220): clinic gate, then role/clinic change guards
function simulateUpdateUser(req: AuthenticatedRequest, target: Target, body: { role_name?: string; clinic_id?: number | null; phone?: string } = {}) {
  const managerIsGlobal = canManageAllClinics(req); // P0.3
  if (!managerIsGlobal && target.clinic_id !== req.user?.clinicId) return 403;
  const finalRoleName = body.role_name ?? target.role_name;
  const finalClinicId = body.clinic_id !== undefined ? body.clinic_id : target.clinic_id;
  if (finalRoleName !== 'SUPER_ADMIN' && !finalClinicId) return 400;
  if (body.role_name === 'SUPER_ADMIN' && !managerIsGlobal) return 403;
  if (!managerIsGlobal && body.clinic_id !== undefined && body.clinic_id !== req.user?.clinicId) return 403;
  return 200;
}

// resolveManageableTarget (lines 279-288) - gates listUserSessions / revokeUserSession / revokeAllUserSessions
function simulateManageTarget(req: AuthenticatedRequest, target: Target) {
  const managerIsGlobal = canManageAllClinics(req); // P0.3
  if (!managerIsGlobal && target.clinic_id !== req.user?.clinicId) return 403;
  if (target.role_name === 'SUPER_ADMIN' && req.user?.roleName !== 'SUPER_ADMIN') return 403;
  return 200;
}

// deleteUser (lines 422-431) + role hierarchy guard (line 428)
function simulateDeleteUser(req: AuthenticatedRequest, target: Target) {
  const managerIsGlobal = canManageAllClinics(req); // P0.3
  if (!managerIsGlobal && target.clinic_id !== req.user?.clinicId) return 403;
  if (target.role_name === 'SUPER_ADMIN' && req.user?.roleName !== 'SUPER_ADMIN') return 403;
  return 200;
}

// ============================================================================
// 1) Global admins keep the correct (unchanged) behaviour
// ============================================================================
test('US1 - canManageAllClinics: admin roles only', () => {
  assert.equal(canManageAllClinics(reqFor('SUPER_ADMIN')), true);
  assert.equal(canManageAllClinics(reqFor('SYSTEM_ADMIN')), true);
});

test('US2 - global admin creates users in any clinic (kept behaviour)', () => {
  assert.equal(simulateCreateUser(reqFor('SUPER_ADMIN'), { role_name: 'DOCTOR', clinic_id: 3 }), 201);
  assert.equal(simulateCreateUser(reqFor('SYSTEM_ADMIN'), { role_name: 'NURSE', clinic_id: 3 }), 201);
  assert.equal(simulateCreateUser(reqFor('SUPER_ADMIN'), { role_name: 'SUPER_ADMIN', clinic_id: null }), 201);
});

test('US3 - global admin updates/deletes/revokes sessions cross-clinic (kept behaviour)', () => {
  const other = targetIn(3);
  assert.equal(simulateUpdateUser(reqFor('SUPER_ADMIN'), other, { phone: '000' }), 200);
  assert.equal(simulateDeleteUser(reqFor('SUPER_ADMIN'), other), 200);
  assert.equal(simulateManageTarget(reqFor('SYSTEM_ADMIN'), other), 200);
});

test('US4 - global admin sees every clinic in listUsers and may filter by any clinic', () => {
  assert.deepEqual(simulateListUsersScope(reqFor('SUPER_ADMIN'), null).scopedTo, null);
  assert.equal(simulateListUsersScope(reqFor('SUPER_ADMIN'), 3).httpStatus, 200);
  assert.deepEqual(simulateListUsersScope(reqFor('SYSTEM_ADMIN'), 3).scopedTo, [3]);
});

// ============================================================================
// 2) ACCOUNTANT / financial roles must NOT get global user-management scope
// ============================================================================
test('US5 - ACCOUNTANT: financial role no longer gets global user scope', () => {
  const accountant = reqFor('ACCOUNTANT');
  assert.equal(isGlobalFinanceRole(accountant), true, 'still a financial role (billing untouched)');
  assert.equal(canManageAllClinics(accountant), false, 'P0.3: not a global admin role');
  const other = targetIn(3);
  assert.equal(simulateCreateUser(accountant, { role_name: 'DOCTOR', clinic_id: 3 }), 403, 'cross-clinic create denied');
  assert.equal(simulateUpdateUser(accountant, other, { phone: '000' }), 403, 'cross-clinic update denied');
  assert.equal(simulateDeleteUser(accountant, other), 403, 'cross-clinic delete denied');
  assert.equal(simulateManageTarget(accountant, other), 403, 'cross-clinic session management denied');
});

test('US6 - any role holding MANAGE_SERVICES/CREATE_EXPENSE: no global user scope', () => {
  const finance = reqFor('FINANCE_MANAGER');
  assert.equal(isGlobalFinanceRole(finance), true, 'financial permission detected');
  assert.equal(canManageAllClinics(finance), false, 'not an admin role despite MANAGE_USERS');
  assert.equal(simulateCreateUser(finance, { role_name: 'DOCTOR', clinic_id: 1 }), 403);
  assert.equal(simulateUpdateUser(finance, targetIn(1), { phone: '000' }), 403);
  assert.equal(simulateDeleteUser(finance, targetIn(1)), 403);
  assert.equal(simulateManageTarget(finance, targetIn(1)), 403);
});

test('US7 - ACCOUNTANT listUsers stays inside its clinics (no enumeration)', () => {
  const accountant = reqFor('ACCOUNTANT');
  assert.deepEqual(simulateListUsersScope(accountant, null).scopedTo, [2], 'clamped to assigned clinics');
  assert.equal(simulateListUsersScope(accountant, 1).httpStatus, 403, 'cannot enumerate another clinic');
  assert.equal(simulateListUsersScope(accountant, 2).httpStatus, 200, 'own clinic allowed');
});

test('US8 - financial roles cannot grant or escalate to SUPER_ADMIN', () => {
  const accountant = reqFor('ACCOUNTANT');
  assert.equal(simulateCreateUser(accountant, { role_name: 'SUPER_ADMIN', clinic_id: null }), 403);
  assert.equal(simulateUpdateUser(accountant, targetIn(2), { role_name: 'SUPER_ADMIN' }), 403);
});

test('US9 - financial (billing/reports) scope is untouched by P0.3', () => {
  assert.equal(financeClinicScope(reqFor('ACCOUNTANT')), null, 'still sees all clinics financially');
  assert.equal(financeClinicScope(reqFor('FINANCE_MANAGER')), null);
  assert.deepEqual(financeClinicScope(reqFor('CLINIC_MANAGER')), [1], 'no financial permission -> scoped to assigned clinics');
});

test('US10 - clinic-restricted manager stays inside its own clinic', () => {
  const manager = reqFor('CLINIC_MANAGER');
  assert.equal(canManageAllClinics(manager), false);
  assert.equal(simulateCreateUser(manager, { role_name: 'DOCTOR', clinic_id: 1 }), 201, 'own clinic create allowed');
  assert.equal(simulateCreateUser(manager, { role_name: 'DOCTOR', clinic_id: 2 }), 403, 'other clinic create denied');
  assert.equal(simulateUpdateUser(manager, targetIn(1), { phone: '000' }), 200, 'own clinic update allowed');
  assert.equal(simulateUpdateUser(manager, targetIn(2), { phone: '000' }), 403, 'other clinic update denied');
  assert.deepEqual(simulateListUsersScope(manager, null).scopedTo, [1]);
});

// ============================================================================
// 3) Clinic-restricted managers stay within their clinic on every mutation
// ============================================================================
test('US11 - restricted manager cannot move a user to another clinic', () => {
  const manager = reqFor('CLINIC_MANAGER');
  assert.equal(simulateUpdateUser(manager, targetIn(1), { clinic_id: 2 }), 403, 'cross-clinic reassignment denied');
  assert.equal(simulateUpdateUser(manager, targetIn(1), { clinic_id: 1 }), 200, 'same-clinic reassignment allowed');
});

// ============================================================================
// 4) create/update/delete/session revocation never exceed the clinic scope
// ============================================================================
test('US12 - user-management gates never exceed clinic scope', () => {
  const gates: Record<string, (req: AuthenticatedRequest, target: Target) => number> = {
    create: (req, target) => simulateCreateUser(req, { role_name: 'DOCTOR', clinic_id: target.clinic_id }),
    update: (req, target) => simulateUpdateUser(req, target, { phone: '000' }),
    delete: (req, target) => simulateDeleteUser(req, target),
    sessions: (req, target) => simulateManageTarget(req, target),
  };
  for (const roleKey of ['ACCOUNTANT', 'FINANCE_MANAGER', 'CLINIC_MANAGER', 'DOCTOR']) {
    const req = reqFor(roleKey);
    const outside = targetIn(3); // clinic 3 is outside every non-admin scope above
    for (const [gateName, gate] of Object.entries(gates)) {
      assert.equal(gate(req, outside), 403, `${roleKey}: ${gateName} must be denied outside clinic scope`);
    }
  }
});

test('US13 - session revocation (list/one/all) cannot cross clinics', () => {
  // listUserSessions / revokeUserSession / revokeAllUserSessions all call resolveManageableTarget
  for (const roleKey of ['ACCOUNTANT', 'CLINIC_MANAGER']) {
    const req = reqFor(roleKey);
    assert.equal(simulateManageTarget(req, targetIn(3)), 403, `${roleKey}: sessions of another clinic denied`);
    assert.equal(simulateManageTarget(req, targetIn(req.user?.clinicId as number)), 200, `${roleKey}: own clinic allowed`);
  }
});

test('US14 - role hierarchy guard is preserved', () => {
  const manager = reqFor('CLINIC_MANAGER');
  assert.equal(simulateManageTarget(manager, targetIn(1, 'SUPER_ADMIN')), 403, 'cannot manage a higher admin');
  assert.equal(simulateDeleteUser(manager, targetIn(1, 'SUPER_ADMIN')), 403, 'cannot delete a higher admin');
  assert.equal(simulateManageTarget(reqFor('SUPER_ADMIN'), targetIn(3, 'SUPER_ADMIN')), 200, 'SUPER_ADMIN keeps full access');
});

// Documented exception: the read-only doctors directory keeps its financial scope
// by design (users.routes.ts comment + BillingView needs cross-clinic doctor names).
test('US15 - doctors directory keeps its financial scope by design', () => {
  assert.equal(isGlobalFinanceRole(reqFor('ACCOUNTANT')), true, 'financial roles keep the read-only doctors directory');
  assert.equal(isGlobalFinanceRole(reqFor('CLINIC_MANAGER')), false, 'operational roles never did');
});