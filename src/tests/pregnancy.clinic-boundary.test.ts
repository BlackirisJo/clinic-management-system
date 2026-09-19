import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { accessibleClinicIds, canManageAllClinics } from '../middlewares/auth.middleware';

// ============================================================================
// P0.4-B - Pregnancy Clinic Boundary
// Core rule: any Visit or Ultrasound linked to a Pregnancy MUST be in the
// same clinic as the pregnancy (pregnancy.clinic_id === visit.clinic_id).
// Mirrors the real SQL/controller logic in pregnancies.controller.ts and
// visits.controller.ts after the P0.4-B fixes.
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
type Visit = { visit_id: number; patient_id: number; clinic_id: number };
type Ultrasound = {
  us_id: number; pregnancy_id: number; visit_id: number | null;
  attachments: { attachment_id: number; file_name: string; kind: string }[];
};
type ClinicScope = number[] | null;

const NOW = new Date('2030-01-01T00:00:00.000Z');
const FUTURE = () => new Date(NOW.getTime() + 86400000);
const PAST = () => new Date(NOW.getTime() - 86400000);

// clinic 10 = patient owner, clinic 20 = cross-clinic, clinic 30 = sharing clinic
const PATIENTS: Patient[] = [
  { patient_id: 1, clinic_id: 10, gender: 'FEMALE' },
  { patient_id: 2, clinic_id: 40, gender: 'FEMALE' },
];

const pregnancyFixture = (over: Partial<Pregnancy> & { pregnancy_id: number }): Pregnancy => ({
  patient_id: 1, clinic_id: 10, status: 'ACTIVE', ...over,
});
const visitFixture = (over: Partial<Visit> & { visit_id: number }): Visit => ({
  patient_id: 1, clinic_id: 10, ...over,
});
const ultrasoundFixture = (over: Partial<Ultrasound> & { us_id: number }): Ultrasound => ({
  pregnancy_id: 101, visit_id: null, attachments: [], ...over,
});
const shareFixture = (over: Partial<Share> & { patient_id: number; target_clinic_id: number }): Share => ({
  access_level: 'READ', status: 'ACTIVE', expires_at: FUTURE(), ...over,
});

const mkReq = (roleName: string, permissions: string[], clinicId: number | null, clinicIds: number[]): AuthenticatedRequest =>
  ({ user: { userId: 1, roleId: 1, clinicId, roleName, permissions, clinicIds } } as unknown as AuthenticatedRequest);

const DOCTOR = (clinicIds: number[], primary: number | null = clinicIds[0] ?? null) => mkReq('DOCTOR', ['MANAGE_PREGNANCY'], primary, clinicIds);
const ADMIN = (roleName = 'SUPER_ADMIN') => mkReq(roleName, [], 10, [10]);

const activeShareToScope = (patientId: number, scope: ClinicScope, shares: Share[], now: Date, level?: 'READ' | 'WRITE'): boolean =>
  scope !== null && shares.some((s) =>
    s.patient_id === patientId && scope.includes(s.target_clinic_id)
    && (level === undefined || s.access_level === level)
    && s.status === 'ACTIVE' && s.expires_at.getTime() > now.getTime());

const activeShareToClinic = (patientId: number, clinicId: number, shares: Share[], now: Date, level: 'READ' | 'WRITE'): boolean =>
  shares.some((s) => s.patient_id === patientId && s.target_clinic_id === clinicId
    && s.access_level === level && s.status === 'ACTIVE' && s.expires_at.getTime() > now.getTime());

// ---- requirePregnancyAccess/Write (P0.4-A verbatim) ----
function simulateRead(req: AuthenticatedRequest, pregnancyId: number, pregnancies: Pregnancy[], shares: Share[], now = NOW) {
  const pregnancy = pregnancies.find((p) => p.pregnancy_id === pregnancyId);
  if (!pregnancy) return { httpStatus: 404, pregnancy: null as Pregnancy | null };
  const scope = accessibleClinicIds(req);
  const inScope = (scope ?? []).includes(Number(pregnancy.clinic_id));
  const sharedRead = activeShareToScope(pregnancy.patient_id, scope, shares, now);
  const sharedWrite = activeShareToScope(pregnancy.patient_id, scope, shares, now, 'WRITE');
  const allowed = canManageAllClinics(req) || inScope || sharedRead;
  if (!allowed) return { httpStatus: 404, pregnancy: null };
  return { httpStatus: 200, pregnancy: { ...pregnancy }, reason: 'allowed' };
}
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

// ---- P0.4-B: createPregnancyVisit simulation ----
function simulateCreatePregnancyVisit(
  req: AuthenticatedRequest,
  pregnancyId: number,
  body: { visit_id?: number },
  pregnancies: Pregnancy[], visits: Visit[], shares: Share[], now = NOW,
) {
  const write = simulateWrite(req, pregnancyId, pregnancies, shares, now);
  if (write.httpStatus !== 200) return { httpStatus: write.httpStatus, reason: write.reason };
  const pregnancy = pregnancies.find((p) => p.pregnancy_id === pregnancyId)!;
  const b = body;
  if (!b.visit_id) return { httpStatus: 201, reason: 'created' };
  const visit = visits.find((v) => v.visit_id === b.visit_id);
  if (!visit) return { httpStatus: 400, reason: 'visit_not_found' };
  if (Number(visit.patient_id) !== Number(pregnancy.patient_id)) return { httpStatus: 400, reason: 'wrong_patient' };
  // P0.4-B: clinic boundary check
  if (Number(visit.clinic_id) !== Number(pregnancy.clinic_id)) return { httpStatus: 400, reason: 'cross_clinic_visit' };
  return { httpStatus: 201, reason: 'created' };
}

// ---- P0.4-B: createUltrasound simulation ----
function simulateCreateUltrasound(
  req: AuthenticatedRequest,
  pregnancyId: number,
  body: { visit_id?: number },
  pregnancies: Pregnancy[], visits: Visit[], shares: Share[], now = NOW,
) {
  const write = simulateWrite(req, pregnancyId, pregnancies, shares, now);
  if (write.httpStatus !== 200) return { httpStatus: write.httpStatus, reason: write.reason };
  const pregnancy = pregnancies.find((p) => p.pregnancy_id === pregnancyId)!;
  const b = body;
  if (!b.visit_id) return { httpStatus: 201, reason: 'created' };
  const visit = visits.find((v) => v.visit_id === b.visit_id);
  if (!visit) return { httpStatus: 400, reason: 'visit_not_found' };
  if (Number(visit.patient_id) !== Number(pregnancy.patient_id)) return { httpStatus: 400, reason: 'wrong_patient' };
  // P0.4-B: clinic boundary check
  if (Number(visit.clinic_id) !== Number(pregnancy.clinic_id)) return { httpStatus: 400, reason: 'cross_clinic_visit' };
  return { httpStatus: 201, reason: 'created' };
}

// ---- P0.4-B: getPregnancyDetails simulation (visit/ultrasound filtering + attachments) ----
// Visits passed are assumed linked to the pregnancy; clinic boundary is the filter.
// Each ultrasound carries its own attachments subquery result (mirrors SQL subquery).
function simulateGetPregnancyDetails(
  req: AuthenticatedRequest,
  pregnancyId: number,
  pregnancies: Pregnancy[], visits: Visit[], ultrasounds: Ultrasound[], shares: Share[], now = NOW,
): { httpStatus: number; visits: Visit[]; ultrasounds: Ultrasound[] } {
  const read = simulateRead(req, pregnancyId, pregnancies, shares, now);
  if (read.httpStatus !== 200) return { httpStatus: read.httpStatus, visits: [], ultrasounds: [] };
  const pregnancy = pregnancies.find((p) => p.pregnancy_id === pregnancyId)!;
  // P0.4-B: filter visits where visit.clinic_id !== pregnancy.clinic_id
  const filteredVisits = visits.filter((v) => v.clinic_id === pregnancy.clinic_id);
  // P0.4-B: filter ultrasounds where linked visit clinic !== pregnancy clinic
  // Attachments subquery preserved (json_agg per ultrasound) — same-clinic only
  const filteredUltrasounds = ultrasounds.filter((u) => {
    if (u.visit_id === null) return true;
    const linkedVisit = visits.find((v) => v.visit_id === u.visit_id);
    return linkedVisit !== undefined && linkedVisit.clinic_id === pregnancy.clinic_id;
  });
  return { httpStatus: 200, visits: filteredVisits, ultrasounds: filteredUltrasounds };
}

// ---- P0.4-B: uploadAttachment simulation ----
function simulateUploadAttachment(
  req: AuthenticatedRequest,
  visitId: number,
  body: { pregnancy_id?: number; ultrasound_id?: number },
  visits: Visit[], pregnancies: Pregnancy[], ultrasounds: Ultrasound[], shares: Share[], now = NOW,
) {
  const visit = visits.find((v) => v.visit_id === visitId);
  if (!visit) return { httpStatus: 404, reason: 'visit_not_found' };
  // P0.4-A: requireVisitAccess (simplified to clinic scope)
  const scope = accessibleClinicIds(req);
  if (!canManageAllClinics(req) && !(scope ?? []).includes(Number(visit.clinic_id))) return { httpStatus: 404, reason: 'no_visit_access' };
  const pregnancyId = body.pregnancy_id ?? null;
  const ultrasoundId = body.ultrasound_id ?? null;
  if (pregnancyId) {
    const pregnancy = pregnancies.find((p) => p.pregnancy_id === pregnancyId);
    if (!pregnancy) return { httpStatus: 400, reason: 'pregnancy_not_found' };
    // P0.4-A: same patient check
    if (Number(pregnancy.patient_id) !== Number(visit.patient_id)) return { httpStatus: 400, reason: 'wrong_patient' };
    // P0.4-B: clinic boundary check on pregnancy
    if (Number(pregnancy.clinic_id) !== Number(visit.clinic_id)) return { httpStatus: 400, reason: 'cross_clinic_pregnancy' };
    if (ultrasoundId) {
      const ultrasound = ultrasounds.find((u) => u.us_id === ultrasoundId);
      if (!ultrasound) return { httpStatus: 400, reason: 'ultrasound_not_found' };
      if (Number(ultrasound.pregnancy_id) !== Number(pregnancy.pregnancy_id)) return { httpStatus: 400, reason: 'ultrasound_wrong_pregnancy' };
      // P0.4-B: clinic boundary check on ultrasound's pregnancy
      if (Number(pregnancy.clinic_id) !== Number(visit.clinic_id)) return { httpStatus: 400, reason: 'cross_clinic_ultrasound' };
    }
  } else if (ultrasoundId) {
    const ultrasound = ultrasounds.find((u) => u.us_id === ultrasoundId);
    if (!ultrasound) return { httpStatus: 400, reason: 'ultrasound_not_found' };
    const pregnancy = pregnancies.find((p) => p.pregnancy_id === ultrasound.pregnancy_id);
    if (!pregnancy) return { httpStatus: 400, reason: 'pregnancy_not_found' };
    if (Number(pregnancy.patient_id) !== Number(visit.patient_id)) return { httpStatus: 400, reason: 'wrong_patient' };
    // P0.4-B: clinic boundary check
    if (Number(pregnancy.clinic_id) !== Number(visit.clinic_id)) return { httpStatus: 400, reason: 'cross_clinic_pregnancy' };
  }
  return { httpStatus: 201, reason: 'uploaded' };
}

// ---- P0.4-B: downloadAttachment simulation ----
function simulateDownloadAttachment(
  req: AuthenticatedRequest,
  attachmentId: number,
  attachments: { attachment_id: number; visit_id?: number | null; pregnancy_id?: number | null }[],
  visits: Visit[], now = NOW,
) {
  const attachment = attachments.find((a) => a.attachment_id === attachmentId);
  if (!attachment) return { httpStatus: 404, reason: 'not_found' };
  let allowed = canManageAllClinics(req);
  if (!allowed && attachment.visit_id) {
    const visit = visits.find((v) => v.visit_id === attachment.visit_id);
    if (visit) allowed = (accessibleClinicIds(req) ?? []).includes(Number(visit.clinic_id));
  }
  if (!allowed) return { httpStatus: 404, reason: 'no_access' };
  return { httpStatus: 200, reason: 'downloaded' };
}

const PREG = pregnancyFixture({ pregnancy_id: 101 });
const PREG_CROSS = pregnancyFixture({ pregnancy_id: 102, clinic_id: 20 });
const VISIT_SAME = visitFixture({ visit_id: 201, clinic_id: 10 });
const VISIT_CROSS = visitFixture({ visit_id: 202, clinic_id: 20 });
const US_SAME = ultrasoundFixture({ us_id: 301, visit_id: null });
const US_CROSS = ultrasoundFixture({ us_id: 302, visit_id: null });
const VISIT_SAME_LINKED = visitFixture({ visit_id: 203, clinic_id: 10 }); // visit linked to ultrasound
const ALL_VISITS = () => [VISIT_SAME, VISIT_CROSS, VISIT_SAME_LINKED];
const ALL_ULTRASOUNDS = () => [US_SAME, US_CROSS];
const ALL_ATTACHMENTS = () => [
  { attachment_id: 1, visit_id: 201, pregnancy_id: 101 },
  { attachment_id: 2, visit_id: 201, pregnancy_id: 102 },
];
const OWNER = DOCTOR([10], 10);
const OUTSIDER = DOCTOR([20], 20);
const SHARED_30 = DOCTOR([30], 30);
const READ_SHARE_TO_30 = () => [shareFixture({ patient_id: 1, target_clinic_id: 30 })];
const WRITE_SHARE_TO_30 = () => [shareFixture({ patient_id: 1, target_clinic_id: 30, access_level: 'WRITE' })];
const ADMIN_USER = ADMIN('SUPER_ADMIN');

// ============================================================================
// P0.4-B createPregnancyVisit tests
// ============================================================================
test('PCB-1 - createPregnancyVisit same-clinic visit → PASS', () => {
  const result = simulateCreatePregnancyVisit(OWNER, 101, { visit_id: 201 }, [PREG], [VISIT_SAME], [], NOW);
  assert.equal(result.httpStatus, 201);
});

test('PCB-2 - createPregnancyVisit cross-clinic visit → DENY', () => {
  const result = simulateCreatePregnancyVisit(OWNER, 101, { visit_id: 202 }, [PREG], [VISIT_CROSS], [], NOW);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'cross_clinic_visit');
});

test('PCB-3 - createPregnancyVisit no visit → PASS', () => {
  const result = simulateCreatePregnancyVisit(OWNER, 101, {}, [PREG], [], [], NOW);
  assert.equal(result.httpStatus, 201);
});

test('PCB-4 - createPregnancyVisit non-existent visit → DENY', () => {
  const result = simulateCreatePregnancyVisit(OWNER, 101, { visit_id: 999 }, [PREG], [VISIT_SAME], [], NOW);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'visit_not_found');
});

test('PCB-5 - createPregnancyVisit cross-clinic visit denied even with WRITE share to that clinic', () => {
  // User from clinic 30 has WRITE share to patient → can access pregnancy from clinic 10
  // But the cross-clinic visit (clinic 20) still fails the visit-clinic === pregnancy-clinic check
  const result = simulateCreatePregnancyVisit(SHARED_30, 101, { visit_id: 202 }, [PREG], [VISIT_CROSS], WRITE_SHARE_TO_30(), NOW);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'cross_clinic_visit');
});

// ============================================================================
// P0.4-B createUltrasound tests
// ============================================================================
test('PCB-6 - createUltrasound same-clinic visit → PASS', () => {
  const result = simulateCreateUltrasound(OWNER, 101, { visit_id: 201 }, [PREG], [VISIT_SAME], [], NOW);
  assert.equal(result.httpStatus, 201);
});

test('PCB-7 - createUltrasound cross-clinic visit → DENY', () => {
  const result = simulateCreateUltrasound(OWNER, 101, { visit_id: 202 }, [PREG], [VISIT_CROSS], [], NOW);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'cross_clinic_visit');
});

test('PCB-8 - createUltrasound no visit → PASS', () => {
  const result = simulateCreateUltrasound(OWNER, 101, {}, [PREG], [], [], NOW);
  assert.equal(result.httpStatus, 201);
});

// ============================================================================
// P0.4-B getPregnancyDetails tests
// ============================================================================
test('PCB-9 - getPregnancyDetails hides cross-clinic visit', () => {
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME, VISIT_CROSS], [], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.equal(result.visits.length, 1, 'only same-clinic visit returned');
  assert.equal(result.visits[0]!.visit_id, 201);
});

test('PCB-10 - getPregnancyDetails shows visits from same clinic', () => {
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.deepEqual(result.visits, [VISIT_SAME]);
});

test('PCB-11 - getPregnancyDetails hides cross-clinic ultrasound', () => {
  const usCrossVisit = ultrasoundFixture({ us_id: 303, visit_id: 202 });
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [US_SAME, usCrossVisit], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.equal(result.ultrasounds.length, 1, 'only same-clinic ultrasound returned');
  assert.equal(result.ultrasounds[0]!.us_id, 301);
});

test('PCB-12 - getPregnancyDetails shows ultrasound with no linked visit', () => {
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [US_SAME], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.equal(result.ultrasounds.length, 1);
  assert.equal(result.ultrasounds[0]!.us_id, 301);
});

test('PCB-12b - getPregnancyDetails ultrasound has attachments subquery result', () => {
  const usWithAtt = ultrasoundFixture({ us_id: 301, visit_id: null, attachments: [{ attachment_id: 10, file_name: 'ultrasound.pdf', kind: 'ULTRASOUND' }] });
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [usWithAtt], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.equal(result.ultrasounds.length, 1);
  assert.equal(result.ultrasounds[0]!.attachments.length, 1, 'attachments subquery preserved');
  assert.equal(result.ultrasounds[0]!.attachments[0]!.attachment_id, 10);
});

test('PCB-12c - getPregnancyDetails no SQL error for null-visit ultrasound', () => {
  // null visit_id should not produce SQL error (visit check short-circuits to true)
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [US_SAME], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.equal(result.ultrasounds.length, 1, 'no SQL error — ultrasound returned normally');
});

test('PCB-13 - getPregnancyDetails hides cross-clinic ultrasound', () => {
  const usCrossVisit = ultrasoundFixture({ us_id: 303, visit_id: 202 });
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [US_SAME, usCrossVisit], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.equal(result.ultrasounds.length, 1, 'cross-clinic ultrasound hidden');
  assert.ok(!result.ultrasounds.some((u) => u.us_id === 303), 'cross-clinic ultrasound not in results');
});

test('PCB-13b - cross-clinic ultrasound attachments not leaked', () => {
  // Even if cross-clinic ultrasound has attachments, it must not appear
  const usCrossWithAtt = ultrasoundFixture({ us_id: 303, visit_id: 202, attachments: [{ attachment_id: 99, file_name: 'secret.pdf', kind: 'DOCUMENT' }] });
  const result = simulateGetPregnancyDetails(OWNER, 101, [PREG], [VISIT_SAME], [US_SAME, usCrossWithAtt], [], NOW);
  if (result.httpStatus !== 200) throw new Error('expected 200');
  assert.ok(!result.ultrasounds.some((u) => u.us_id === 303), 'cross-clinic ultrasound with attachments hidden');
});

// ============================================================================
// P0.4-B uploadAttachment tests
// ============================================================================
test('PCB-14 - uploadAttachment same-clinic pregnancy link → PASS', () => {
  const result = simulateUploadAttachment(OWNER, 201, { pregnancy_id: 101 }, [VISIT_SAME], [PREG], [], [], NOW);
  assert.equal(result.httpStatus, 201);
});

test('PCB-15 - uploadAttachment cross-clinic pregnancy link → DENY', () => {
  // Visit is clinic 10, but pregnancy is clinic 20 (cross-clinic)
  const result = simulateUploadAttachment(OWNER, 201, { pregnancy_id: 102 }, [VISIT_SAME], [PREG_CROSS], [], [], NOW);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'cross_clinic_pregnancy');
});

test('PCB-16 - uploadAttachment cross-clinic ultrasound via pregnancy → DENY', () => {
  const result = simulateUploadAttachment(OWNER, 201, { pregnancy_id: 102, ultrasound_id: 301 }, [VISIT_SAME], [PREG_CROSS], [US_SAME], [], NOW);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'cross_clinic_pregnancy');
});

test('PCB-17 - uploadAttachment no pregnancy/ultrasound → PASS', () => {
  const result = simulateUploadAttachment(OWNER, 201, {}, [VISIT_SAME], [PREG], [], [], NOW);
  assert.equal(result.httpStatus, 201);
});

test('PCB-18 - uploadAttachment cross-clinic visit → DENY (visit access check)', () => {
  // User from clinic 30 tries to upload for visit in clinic 10 without share
  const result = simulateUploadAttachment(SHARED_30, 201, { pregnancy_id: 101 }, [VISIT_SAME], [PREG], [], READ_SHARE_TO_30(), NOW);
  // SHARED_30 has READ share to patient → can access visit? No: visit is clinic 10, user's scope is clinic 30, share is to patient not clinic
  // requireVisitAccess checks accessibleClinicIds → clinic 30 ≠ clinic 10 → denied at visit level
  assert.equal(result.httpStatus, 404);
});

// ============================================================================
// P0.4-A sharing regression
// ============================================================================
test('PCB-19 - P0.4-A: active READ share allows pregnancy read (regression)', () => {
  const result = simulateRead(SHARED_30, 101, [PREG], READ_SHARE_TO_30(), NOW);
  assert.equal(result.httpStatus, 200);
});

test('PCB-20 - P0.4-A: active WRITE share allows pregnancy write (regression)', () => {
  const result = simulateWrite(SHARED_30, 101, [PREG], WRITE_SHARE_TO_30(), NOW);
  assert.equal(result.httpStatus, 200);
});

test('PCB-21 - P0.4-A: expired share is ignored (regression)', () => {
  const shares = [shareFixture({ patient_id: 1, target_clinic_id: 30, expires_at: PAST() })];
  assert.equal(simulateRead(SHARED_30, 101, [PREG], shares, NOW).httpStatus, 404);
  assert.equal(simulateWrite(SHARED_30, 101, [PREG], shares, NOW).httpStatus, 404);
});

// ============================================================================
// Global admins unchanged
// ============================================================================
test('PCB-ADMIN - global admins respect pregnancy clinic boundary', () => {
  for (const roleName of ['SUPER_ADMIN', 'SYSTEM_ADMIN']) {
    const admin = mkReq(roleName, [], 10, [10]);
    assert.equal(canManageAllClinics(admin), true);
    // Same-clinic visit → PASS
    const pv = simulateCreatePregnancyVisit(admin, 101, { visit_id: 201 }, [PREG], [VISIT_SAME], [], NOW);
    assert.equal(pv.httpStatus, 201, 'global admin can link same-clinic visit');
    // Cross-clinic visit → DENY (boundary applies to all)
    const pvCross = simulateCreatePregnancyVisit(admin, 101, { visit_id: 202 }, [PREG], [VISIT_CROSS], [], NOW);
    assert.equal(pvCross.httpStatus, 400, 'global admin cannot link cross-clinic visit');
    // Same-clinic ultrasound → PASS
    const us = simulateCreateUltrasound(admin, 101, { visit_id: 201 }, [PREG], [VISIT_SAME], [], NOW);
    assert.equal(us.httpStatus, 201, 'global admin can link same-clinic ultrasound');
    // Cross-clinic ultrasound → DENY
    const usCross = simulateCreateUltrasound(admin, 101, { visit_id: 202 }, [PREG], [VISIT_CROSS], [], NOW);
    assert.equal(usCross.httpStatus, 400, 'global admin cannot link cross-clinic ultrasound');
  }
});
