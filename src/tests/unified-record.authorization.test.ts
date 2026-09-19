import test from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Unified medical record authorization tests - getUnifiedMedicalRecord
// Simulation mirroring the actual SQL logic in patients.controller.ts:
//   - Patient access gate: ownership within clinic scope OR active share to it
//   - Visits scope: v.clinic_id in scope OR active share into scope
//   - Prescriptions scope: via linked visit (JOIN visits), same rule
// Reference policy = getPatientVisits - same clinic/share rule.
// ============================================================================

type PatientRow = { patient_id: number; clinic_id: number };
type VisitRow = { visit_id: number; patient_id: number; clinic_id: number };
type PrescriptionRow = { prescription_id: number; patient_id: number; visit_clinic_id: number };
type Share = {
  patient_id: number;
  target_clinic_id: number;
  access_level: 'READ' | 'WRITE';
  status: 'ACTIVE' | 'REVOKED';
  expires_at: Date;
};
// null = global admin (SUPER_ADMIN/SYSTEM_ADMIN) sees all clinics - matches accessibleClinicIds
type ClinicScope = number[] | null;

// Active share = ACTIVE and not expired (actual WHERE conditions)
const isShareActive = (s: Share, now: Date): boolean =>
  s.status === 'ACTIVE' && s.expires_at.getTime() > now.getTime();

// EXISTS (...) in SQL: active share for the patient targeting one of the user's clinics
const hasActiveShareToScope = (patientId: number, scope: ClinicScope, shares: Share[], now: Date): boolean =>
  scope !== null && shares.some(
    (s) => s.patient_id === patientId && scope.includes(s.target_clinic_id) && isShareActive(s, now),
  );

// Patient access gate: $2 IS NULL OR p.clinic_id = ANY($2) OR EXISTS (active share)
function simulatePatientAccess(patient: PatientRow, scope: ClinicScope, shares: Share[], now: Date): { allowed: boolean; httpStatus: number } {
  const allowed =
    scope === null ||
    scope.includes(patient.clinic_id) ||
    hasActiveShareToScope(patient.patient_id, scope, shares, now);
  // No access -> record is treated as not found (404) as in the actual code
  return { allowed, httpStatus: allowed ? 200 : 404 };
}

// Visit row scope: v.clinic_id = ANY($2) OR EXISTS (active share into scope)
const isVisitVisible = (visit: VisitRow, scope: ClinicScope, shares: Share[], now: Date): boolean =>
  scope === null ||
  scope.includes(visit.clinic_id) ||
  hasActiveShareToScope(visit.patient_id, scope, shares, now);

// Prescription row scope: via v.clinic_id (linked visit), same rule
const isPrescriptionVisible = (rx: PrescriptionRow, scope: ClinicScope, shares: Share[], now: Date): boolean =>
  scope === null ||
  scope.includes(rx.visit_clinic_id) ||
  hasActiveShareToScope(rx.patient_id, scope, shares, now);

// Full path: access gate then row scope - mirrors getUnifiedMedicalRecord
function simulateUnifiedRecord(
  patientId: number,
  scope: ClinicScope,
  patients: PatientRow[],
  visits: VisitRow[],
  prescriptions: PrescriptionRow[],
  shares: Share[],
  now: Date = new Date(),
): { httpStatus: number; visits: VisitRow[]; prescriptions: PrescriptionRow[] } {
  const patient = patients.find((p) => p.patient_id === patientId);
  if (!patient) return { httpStatus: 404, visits: [], prescriptions: [] };
  const access = simulatePatientAccess(patient, scope, shares, now);
  if (!access.allowed) return { httpStatus: 404, visits: [], prescriptions: [] };
  return {
    httpStatus: 200,
    visits: visits.filter((v) => v.patient_id === patientId && isVisitVisible(v, scope, shares, now)),
    prescriptions: prescriptions.filter((p) => p.patient_id === patientId && isPrescriptionVisible(p, scope, shares, now)),
  };
}

// Base scenario: patient owned by clinic 2, visits in clinics 2 and 3, prescriptions linked to them
const BASE_PATIENT: PatientRow[] = [{ patient_id: 1, clinic_id: 2 }];
const BASE_VISITS: VisitRow[] = [
  { visit_id: 11, patient_id: 1, clinic_id: 2 }, // owner clinic visit
  { visit_id: 12, patient_id: 1, clinic_id: 3 }, // other clinic visit
];
const BASE_PRESCRIPTIONS: PrescriptionRow[] = [
  { prescription_id: 21, patient_id: 1, visit_clinic_id: 2 },
  { prescription_id: 22, patient_id: 1, visit_clinic_id: 3 },
];
// Fixed reference clock - expiry comparisons must be deterministic (no Date.now() race)
const NOW = new Date('2026-01-01T00:00:00Z');
const FUTURE = () => new Date(NOW.getTime() + 86400000);

// 1) Clinic A user cannot see Clinic B record for a patient not shared with them
test('UR1 - Clinic A user cannot see Clinic B record (no share): 404 and no rows', () => {
  const result = simulateUnifiedRecord(1, [1], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, [], NOW);
  assert.equal(result.httpStatus, 404, 'record must be 404 (not found or no access permission)');
  assert.equal(result.visits.length, 0, 'no visits without patient access');
  assert.equal(result.prescriptions.length, 0, 'no prescriptions without patient access');
});

// 2) No regression: normal access within the same clinic works as before
test('UR2 - Normal access within owner clinic: sees only its visits and prescriptions', () => {
  const result = simulateUnifiedRecord(1, [2], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, [], NOW);
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.visits.map((v) => v.visit_id), [11], 'owner clinic visits only');
  assert.deepEqual(result.prescriptions.map((p) => p.prescription_id), [21], 'only prescriptions of allowed visits');
});

// 3) READ share allows reading per the current policy (reference: getPatientVisits -
//    patient-level share opens the patient's visit record to the target clinic)
test('UR3 - Active READ share: target clinic reads the shared patient record', () => {
  const shares: Share[] = [
    { patient_id: 1, target_clinic_id: 1, access_level: 'READ', status: 'ACTIVE', expires_at: FUTURE() },
  ];
  const result = simulateUnifiedRecord(1, [1], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, shares, NOW);
  assert.equal(result.httpStatus, 200);
  assert.ok(result.visits.some((v) => v.clinic_id === 2), 'owner clinic visit visible with active share');
  assert.ok(result.prescriptions.some((p) => p.visit_clinic_id === 2), 'owner clinic prescription visible with active share');
});

// 4) WRITE share does not become global access: an unrelated clinic sees nothing
test('UR4 - WRITE share to another clinic: grants no access to a third clinic', () => {
  const shares: Share[] = [
    { patient_id: 1, target_clinic_id: 1, access_level: 'WRITE', status: 'ACTIVE', expires_at: FUTURE() },
  ];
  // Clinic 5 user (no ownership, no share into it) - WRITE share means nothing to them
  const outsider = simulateUnifiedRecord(1, [5], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, shares, NOW);
  assert.equal(outsider.httpStatus, 404, 'WRITE share to another clinic opens nothing to a third clinic');
  assert.equal(outsider.visits.length, 0);
});

// 5) WRITE share to the target clinic allows reading (reference policy - reading is not READ-only)
test('UR5 - Active WRITE share to target clinic: scoped reading works', () => {
  const shares: Share[] = [
    { patient_id: 1, target_clinic_id: 1, access_level: 'WRITE', status: 'ACTIVE', expires_at: FUTURE() },
  ];
  const result = simulateUnifiedRecord(1, [1], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, shares, NOW);
  assert.equal(result.httpStatus, 200);
  assert.ok(result.visits.some((v) => v.clinic_id === 2));
});

// 6) Visits from a third clinic (old expired/revoked WRITE share) do not leak to the owner clinic
test('UR6 - Owner clinic does not see third-clinic visits after share ends', () => {
  const expiredShares: Share[] = [
    { patient_id: 1, target_clinic_id: 3, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(NOW.getTime() - 1000) },
  ];
  const revokedShares: Share[] = [
    { patient_id: 1, target_clinic_id: 3, access_level: 'WRITE', status: 'REVOKED', expires_at: FUTURE() },
  ];
  for (const [label, shares] of [['expired', expiredShares], ['revoked', revokedShares]] as const) {
    const result = simulateUnifiedRecord(1, [2], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, [...shares], NOW);
    assert.equal(result.httpStatus, 200, `owner access to own patient record stays intact (${label})`);
    assert.deepEqual(result.visits.map((v) => v.visit_id), [11], `clinic 3 visit hidden (${label})`);
    assert.deepEqual(result.prescriptions.map((p) => p.prescription_id), [21], `clinic 3 prescription hidden (${label})`);
  }
});

// 7) Global admins (scope=null) keep full access - designed SUPER_ADMIN/SYSTEM_ADMIN behavior
test('UR7 - Global admin (null scope): sees all clinics without restriction', () => {
  const result = simulateUnifiedRecord(1, null, BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, [], NOW);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.visits.length, 2, 'all visits visible to global admin');
  assert.equal(result.prescriptions.length, 2, 'all prescriptions visible to global admin');
});

// 8) Prescription linked to an out-of-scope visit is hidden even if the user has their own visits for the patient
test('UR8 - prescriptions scoped via linked visit (no leak via patient_id alone)', () => {
  // Patient in clinic 2, user from clinic 2, prescription linked to a clinic-3 visit with no share
  const result = simulateUnifiedRecord(1, [2], BASE_PATIENT, BASE_VISITS, BASE_PRESCRIPTIONS, [], NOW);
  assert.equal(result.httpStatus, 200);
  assert.ok(!result.prescriptions.some((p) => p.prescription_id === 22), 'out-of-scope visit prescription hidden');
  assert.ok(!result.visits.some((v) => v.visit_id === 12), 'out-of-scope visit hidden');
});