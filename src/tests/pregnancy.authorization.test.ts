import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { accessibleClinicIds, canManageAllClinics } from '../middlewares/auth.middleware';

// ============================================================================
// P0.4-A - Pregnancy authorization (pregnancies.controller.ts)
// Mirrors the real SQL predicates and the controller decision ORDER:
//   READ : pr.clinic_id in accessibleClinicIds OR active share (READ|WRITE) to scope
//   WRITE: pr.clinic_id in accessibleClinicIds OR active share (WRITE only) to scope
//   share must be status='ACTIVE' AND expires_at > NOW()
// Scope/isAdmin always come from the REAL middleware helpers (not req.user.clinicId).
// ============================================================================

type Patient = { patient_id: number; clinic_id: number; gender: string };
type Share = {
  patient_id: number;
  target_clinic_id: number;
  access_level: 'READ' | 'WRITE';
  status: 'ACTIVE' | 'REVOKED';
  expires_at: Date;
};
type Pregnancy = { pregnancy_id: number; patient_id: number; clinic_id: number; status: 'ACTIVE' | 'COMPLETED' };
type ClinicScope = number[] | null;

const NOW = new Date('2030-01-01T00:00:00.000Z');
const FUTURE = () => new Date(NOW.getTime() + 86400000);
const PAST = () => new Date(NOW.getTime() - 86400000);

// clinic 10 = patient A/B owner, clinic 20 = other clinic, clinic 30 = sharing clinic, clinic 40 = second assignment
const PATIENTS: Patient[] = [
  { patient_id: 1, clinic_id: 10, gender: 'FEMALE' },
  { patient_id: 2, clinic_id: 40, gender: 'FEMALE' },
  { patient_id: 3, clinic_id: 20, gender: 'FEMALE' },
  { patient_id: 9, clinic_id: 20, gender: 'MALE' },
];

const pregnancyFixture = (over: Partial<Pregnancy> & { pregnancy_id: number }): Pregnancy => ({
  patient_id: 1, clinic_id: 10, status: 'ACTIVE', ...over,
});

const shareFixture = (over: Partial<Share> & { patient_id: number; target_clinic_id: number }): Share => ({
  access_level: 'READ', status: 'ACTIVE', expires_at: FUTURE(), ...over,
});

const mkReq = (roleName: string, permissions: string[], clinicId: number | null, clinicIds: number[]): AuthenticatedRequest =>
  ({ user: { userId: 1, roleId: 1, clinicId, roleName, permissions, clinicIds } } as unknown as AuthenticatedRequest);

const DOCTOR = (clinicIds: number[], primary: number | null = clinicIds[0] ?? null) => mkReq('DOCTOR', ['MANAGE_PREGNANCY'], primary, clinicIds);
const NURSE = (clinicIds: number[], primary: number | null = clinicIds[0] ?? null) => mkReq('NURSE', ['MANAGE_PREGNANCY'], primary, clinicIds);
const ADMIN = (roleName = 'SUPER_ADMIN') => mkReq(roleName, [], 10, [10]);

// ---- SQL predicates (verbatim semantics) ----
// EXISTS (... AND sh.target_clinic_id = ANY($2::int[]) AND sh.status='ACTIVE' AND sh.expires_at > NOW())
const activeShareToScope = (patientId: number, scope: ClinicScope, shares: Share[], now: Date, level?: 'READ' | 'WRITE'): boolean =>
  scope !== null && shares.some((s) =>
    s.patient_id === patientId && scope.includes(s.target_clinic_id)
    && (level === undefined || s.access_level === level)
    && s.status === 'ACTIVE' && s.expires_at.getTime() > now.getTime());

// EXISTS (... AND sh.target_clinic_id = $2 ...) - createPregnancy patient query
const activeShareToClinic = (patientId: number, clinicId: number, shares: Share[], now: Date, level: 'READ' | 'WRITE'): boolean =>
  shares.some((s) => s.patient_id === patientId && s.target_clinic_id === clinicId
    && s.access_level === level && s.status === 'ACTIVE' && s.expires_at.getTime() > now.getTime());

// ---- requirePregnancyAccess (SELECT ... shared_read/shared_write) then in-code gate ----
function simulateRead(req: AuthenticatedRequest, pregnancyId: number, pregnancies: Pregnancy[], shares: Share[], now = NOW) {
  const pregnancy = pregnancies.find((p) => p.pregnancy_id === pregnancyId);
  if (!pregnancy) return { httpStatus: 404, pregnancy: null as Pregnancy | null, reason: 'not_found' };
  const scope = accessibleClinicIds(req);
  const inScope = (scope ?? []).includes(Number(pregnancy.clinic_id));
  const sharedRead = activeShareToScope(pregnancy.patient_id, scope, shares, now);
  const sharedWrite = activeShareToScope(pregnancy.patient_id, scope, shares, now, 'WRITE');
  const allowed = canManageAllClinics(req) || inScope || sharedRead;
  if (!allowed) return { httpStatus: 404, pregnancy: null, reason: 'no_access' };
  return { httpStatus: 200, pregnancy: { ...pregnancy, shared_read: sharedRead, shared_write: sharedWrite }, reason: 'allowed' };
}

// ---- requirePregnancyWrite: Access gate, then MANAGE_PREGNANCY, then WRITE scope ----
function simulateWrite(req: AuthenticatedRequest, pregnancyId: number, pregnancies: Pregnancy[], shares: Share[], now = NOW) {
  const read = simulateRead(req, pregnancyId, pregnancies, shares, now);
  if (read.httpStatus !== 200) return { httpStatus: read.httpStatus, reason: read.reason };
  const isGlobal = canManageAllClinics(req);
  const hasPermission = isGlobal || (req.user?.permissions ?? []).includes('MANAGE_PREGNANCY');
  if (!hasPermission) return { httpStatus: 403, reason: 'permission_missing' };
  const scope = accessibleClinicIds(req);
  const inScope = (scope ?? []).includes(Number(read.pregnancy?.clinic_id ?? -1));
  const sharedWrite = activeShareToScope(read.pregnancy?.patient_id ?? -1, scope, shares, now, 'WRITE');
  if (!isGlobal && !inScope && !sharedWrite) return { httpStatus: 403, reason: 'write_scope_denied' };
  return { httpStatus: 200, reason: 'allowed' };
}

// ---- createPregnancy (order preserved) ----
function simulateCreatePregnancy(
  req: AuthenticatedRequest,
  body: { patient_id?: number; clinic_id?: number; lmp_date?: string | null },
  patients: Patient[],
  shares: Share[],
  now = NOW,
) {
  const isGlobal = canManageAllClinics(req);
  const targetClinicId = Number(body.clinic_id ?? req.user?.clinicId);
  if (!body.patient_id || !targetClinicId || Number.isNaN(targetClinicId)) return { httpStatus: 400, reason: 'missing_fields' };
  const patient = patients.find((p) => p.patient_id === Number(body.patient_id));
  if (!patient) return { httpStatus: 404, reason: 'patient_not_found' };
  if (patient.gender !== 'FEMALE') return { httpStatus: 400, reason: 'not_female' };
  const scope = accessibleClinicIds(req) ?? [];
  if (!isGlobal && !scope.includes(targetClinicId)) return { httpStatus: 403, reason: 'clinic_out_of_scope' };
  const canWrite = activeShareToClinic(patient.patient_id, targetClinicId, shares, now, 'WRITE');
  const ownsPatient = Number(patient.clinic_id) === Number(targetClinicId);
  if (!isGlobal && !ownsPatient && !canWrite) return { httpStatus: 403, reason: 'patient_not_in_target_clinic' };
  return { httpStatus: 201, reason: 'created' };
}

// ---- listPregnancies patient_id branch: patient gate AND pregnancy gate ----
function simulateListPregnancies(
  req: AuthenticatedRequest,
  patientId: number,
  patients: Patient[],
  pregnancies: Pregnancy[],
  shares: Share[],
  now = NOW,
) {
  const patient = patients.find((p) => p.patient_id === patientId);
  if (!patient) return { httpStatus: 200, ids: [] as number[] };
  if (canManageAllClinics(req)) {
    return { httpStatus: 200, ids: pregnancies.filter((p) => p.patient_id === patientId).map((p) => p.pregnancy_id) };
  }
  const scope = accessibleClinicIds(req) ?? [];
  if (!scope.length) return { httpStatus: 200, ids: [] };
  const patientGate = scope.includes(patient.clinic_id) || activeShareToScope(patientId, scope, shares, now);
  if (!patientGate) return { httpStatus: 200, ids: [] };
  const ids = pregnancies
    .filter((p) => p.patient_id === patientId && p.status === 'ACTIVE')
    .filter((p) => scope.includes(p.clinic_id) || activeShareToScope(p.patient_id, scope, shares, now))
    .map((p) => p.pregnancy_id);
  return { httpStatus: 200, ids };
}

const PREG_OWNER = pregnancyFixture({ pregnancy_id: 101 }); // patient 1, clinic 10
const PREG_OTHER = pregnancyFixture({ pregnancy_id: 102, clinic_id: 20 }); // same patient 1, created by clinic 20
const PREG_FOREIGN = pregnancyFixture({ pregnancy_id: 103, patient_id: 3, clinic_id: 20 });
const PREG_SECOND = pregnancyFixture({ pregnancy_id: 104, patient_id: 2, clinic_id: 40 });
const ALL_PREGNANCIES = (): Pregnancy[] => [PREG_OWNER, PREG_OTHER, PREG_FOREIGN, PREG_SECOND];

const READ_SHARE_TO_30 = () => [shareFixture({ patient_id: 1, target_clinic_id: 30 })];
const WRITE_SHARE_TO_30 = () => [shareFixture({ patient_id: 1, target_clinic_id: 30, access_level: 'WRITE' })];

const OUTSIDER = () => DOCTOR([30], 30); // clinic-scoped to 30 only, no shares
const OWNER_DOCTOR = () => DOCTOR([10], 10);
// ============================================================================
// PA1-PA4: owner clinic vs unrelated clinic
// ============================================================================
test('PA1 - owner clinic READ = PASS', () => {
  const result = simulateRead(OWNER_DOCTOR(), 101, ALL_PREGNANCIES(), [], NOW);
  assert.equal(result.httpStatus, 200);
});

test('PA2 - owner clinic WRITE = PASS', () => {
  assert.equal(simulateWrite(OWNER_DOCTOR(), 101, ALL_PREGNANCIES(), [], NOW).httpStatus, 200);
  // MANAGE_PREGNANCY is still required for writes (role permissions not expanded)
  const noPerm = mkReq('RECEPTIONIST', ['VIEW_PATIENTS'], 10, [10]);
  assert.equal(simulateWrite(noPerm, 101, ALL_PREGNANCIES(), [], NOW).httpStatus, 403);
});

test('PA3 - unrelated clinic READ = DENY', () => {
  const result = simulateRead(OUTSIDER(), 101, ALL_PREGNANCIES(), [], NOW);
  assert.equal(result.httpStatus, 404, 'record is hidden from out-of-scope clinic');
});

test('PA4 - unrelated clinic WRITE = DENY', () => {
  assert.equal(simulateWrite(OUTSIDER(), 101, ALL_PREGNANCIES(), [], NOW).httpStatus, 404);
});

// ============================================================================
// PA5-PA8: patient sharing
// ============================================================================
test('PA5 - active READ share allows READ', () => {
  const result = simulateRead(DOCTOR([30], 30), 101, ALL_PREGNANCIES(), READ_SHARE_TO_30(), NOW);
  assert.equal(result.httpStatus, 200);
});

test('PA6 - active WRITE share allows READ', () => {
  const result = simulateRead(DOCTOR([30], 30), 101, ALL_PREGNANCIES(), WRITE_SHARE_TO_30(), NOW);
  assert.equal(result.httpStatus, 200);
});

test('PA7 - active WRITE share allows WRITE', () => {
  const result = simulateWrite(DOCTOR([30], 30), 101, ALL_PREGNANCIES(), WRITE_SHARE_TO_30(), NOW);
  assert.equal(result.httpStatus, 200);
});

test('PA8 - active READ share does NOT allow WRITE', () => {
  const shares = READ_SHARE_TO_30();
  const req = DOCTOR([30], 30);
  assert.equal(simulateRead(req, 101, ALL_PREGNANCIES(), shares, NOW).httpStatus, 200, 'read allowed');
  const write = simulateWrite(req, 101, ALL_PREGNANCIES(), shares, NOW);
  assert.equal(write.httpStatus, 403, 'read-only share cannot write');
  assert.equal(write.reason, 'write_scope_denied');
});

// ============================================================================
// PA9-PA10: share lifecycle
// ============================================================================
test('PA9 - expired share is ignored for READ and WRITE', () => {
  const shares = [shareFixture({ patient_id: 1, target_clinic_id: 30, access_level: 'WRITE', expires_at: PAST() })];
  const req = DOCTOR([30], 30);
  assert.equal(simulateRead(req, 101, ALL_PREGNANCIES(), shares, NOW).httpStatus, 404, 'expired share grants no read');
  assert.equal(simulateWrite(req, 101, ALL_PREGNANCIES(), shares, NOW).httpStatus, 404, 'expired share grants no write');
});

test('PA10 - revoked (non-ACTIVE) share is ignored', () => {
  const shares = [shareFixture({ patient_id: 1, target_clinic_id: 30, access_level: 'WRITE', status: 'REVOKED' })];
  const req = DOCTOR([30], 30);
  assert.equal(simulateRead(req, 101, ALL_PREGNANCIES(), shares, NOW).httpStatus, 404);
  assert.equal(simulateWrite(req, 101, ALL_PREGNANCIES(), shares, NOW).httpStatus, 404);
});

// ============================================================================
// PA11-PA12: createPregnancy
// ============================================================================
test('PA11 - createPregnancy for an unrelated patient = DENY', () => {
  const req = DOCTOR([30], 30);
  // patient 1 is owned by clinic 10, no share to clinic 30 -> patient_id alone is not enough
  const result = simulateCreatePregnancy(req, { patient_id: 1, clinic_id: 30 }, PATIENTS, [], NOW);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.reason, 'patient_not_in_target_clinic');
});

test('PA12 - createPregnancy through an active WRITE share = PASS', () => {
  const req = DOCTOR([30], 30);
  const ok = simulateCreatePregnancy(req, { patient_id: 1, clinic_id: 30 }, PATIENTS, WRITE_SHARE_TO_30(), NOW);
  assert.equal(ok.httpStatus, 201, 'write share allows creating the pregnancy in the sharing clinic');
  // READ share must not be enough for creation (write path)
  const readOnly = simulateCreatePregnancy(req, { patient_id: 1, clinic_id: 30 }, PATIENTS, READ_SHARE_TO_30(), NOW);
  assert.equal(readOnly.httpStatus, 403, 'read share cannot create');
  // clinic must be inside the user scope even with a share
  const outOfScope = simulateCreatePregnancy(req, { patient_id: 1, clinic_id: 99 }, PATIENTS, WRITE_SHARE_TO_30(), NOW);
  assert.equal(outOfScope.httpStatus, 403);
  assert.equal(outOfScope.reason, 'clinic_out_of_scope');
});

// ============================================================================
// PA13: listPregnancies cannot leak records of unrelated clinics
// ============================================================================
test('PA13 - listPregnancies with patient_id cannot expose unrelated-clinic records', () => {
  // patient 1 is owned by clinic 10, but pregnancy 102 was created by clinic 20
  const owner = simulateListPregnancies(OWNER_DOCTOR(), 1, PATIENTS, ALL_PREGNANCIES(), [], NOW);
  assert.equal(owner.httpStatus, 200);
  assert.deepEqual(owner.ids, [101], 'only the clinic-10 record is listed; the clinic-20 record stays hidden');

  // clinic 30 with an active share for that patient: share grants the shared patient record (P0.1 parity)
  const shared = simulateListPregnancies(DOCTOR([30], 30), 1, PATIENTS, ALL_PREGNANCIES(), READ_SHARE_TO_30(), NOW);
  assert.deepEqual(shared.ids, [101, 102], 'share-based reader sees the shared patient record');

  // clinic 30 with NO share: the patient gate alone fails
  const noShare = simulateListPregnancies(DOCTOR([30], 30), 1, PATIENTS, ALL_PREGNANCIES(), [], NOW);
  assert.deepEqual(noShare.ids, [], 'no share -> no rows');

  // unrelated patient (owned by clinic 20) is not reachable from clinic 10
  const foreign = simulateListPregnancies(OWNER_DOCTOR(), 3, PATIENTS, ALL_PREGNANCIES(), [], NOW);
  assert.deepEqual(foreign.ids, [], 'foreign patient is not enumerable');
});

// ============================================================================
// PA14: multi-clinic assignments (accessibleClinicIds, not only req.user.clinicId)
// ============================================================================
test('PA14 - multi-clinic user operates in any assigned clinic', () => {
  const multi = NURSE([10, 40], 10); // primary clinic 10, additional assignment 40
  assert.deepEqual(accessibleClinicIds(multi), [10, 40]);
  assert.equal(simulateRead(multi, 104, ALL_PREGNANCIES(), [], NOW).httpStatus, 200, 'read in secondary clinic');
  assert.equal(simulateWrite(multi, 104, ALL_PREGNANCIES(), [], NOW).httpStatus, 200, 'write in secondary clinic');
  const created = simulateCreatePregnancy(multi, { patient_id: 2, clinic_id: 40 }, PATIENTS, [], NOW);
  assert.equal(created.httpStatus, 201, 'create in secondary assigned clinic without relying on req.user.clinicId');
  // clinic 30 is not assigned -> denied even though the user has other clinics
  const denied = simulateCreatePregnancy(multi, { patient_id: 2, clinic_id: 30 }, PATIENTS, [], NOW);
  assert.equal(denied.httpStatus, 403);
  assert.equal(denied.reason, 'clinic_out_of_scope');
  // omitted clinic_id falls back to the primary clinic (existing behaviour)
  const fallback = simulateCreatePregnancy(multi, { patient_id: 2 }, PATIENTS, [], NOW);
  assert.equal(fallback.httpStatus, 403, 'patient 2 is not owned by the primary clinic');
  assert.equal(fallback.reason, 'patient_not_in_target_clinic');
});

// ============================================================================
// Global admins unchanged + preserved validations
// ============================================================================
test('PA-ADMIN - global admins keep unrestricted access', () => {
  for (const roleName of ['SUPER_ADMIN', 'SYSTEM_ADMIN']) {
    const admin = mkReq(roleName, [], 10, [10]);
    assert.equal(canManageAllClinics(admin), true);
    assert.equal(simulateRead(admin, 103, ALL_PREGNANCIES(), [], NOW).httpStatus, 200, 'read any clinic');
    assert.equal(simulateWrite(admin, 103, ALL_PREGNANCIES(), [], NOW).httpStatus, 200, 'write any clinic without sharing');
    assert.deepEqual(simulateListPregnancies(admin, 1, PATIENTS, ALL_PREGNANCIES(), [], NOW).ids, [101, 102]);
    assert.equal(simulateCreatePregnancy(admin, { patient_id: 3, clinic_id: 20 }, PATIENTS, [], NOW).httpStatus, 201);
  }
});

test('PA-VALID - existing pregnancy validations are preserved', () => {
  const owner = OWNER_DOCTOR();
  assert.equal(simulateCreatePregnancy(owner, { patient_id: 9, clinic_id: 10 }, PATIENTS, [], NOW).httpStatus, 400, 'male patient rejected');
  assert.equal(simulateCreatePregnancy(owner, { patient_id: 999, clinic_id: 10 }, PATIENTS, [], NOW).httpStatus, 404, 'unknown patient');
  const noClinic = mkReq('DOCTOR', ['MANAGE_PREGNANCY'], null, [10]); // clinicId null -> no target clinic
  assert.equal(simulateCreatePregnancy(noClinic, { patient_id: 1 }, PATIENTS, [], NOW).httpStatus, 400, 'clinic required');
  assert.equal(simulateCreatePregnancy(owner, { patient_id: 1, clinic_id: 10 }, PATIENTS, [], NOW).httpStatus, 201, 'owner clinic create allowed');
});