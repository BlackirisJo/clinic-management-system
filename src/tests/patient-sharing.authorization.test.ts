import test from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Patient sharing (share management) authorization tests - P0.2
// Mirrors the SQL logic in patients.controller.ts after hardening, via the
// single source of truth findPatientInOwnerScope():
//   - Share management (create / list / revoke) is restricted to the OWNER
//     clinic scope: patients.clinic_id = ANY(scope)  (scope === null = admin).
//   - Receiving an ACTIVE READ/WRITE share grants access to the medical record
//     only - never to the patient's share list nor to revoking shares.
// Fixed clock NOW avoids expiry races in CI.
// ============================================================================

type Patient = { patient_id: number; clinic_id: number };
type Share = {
  share_id: number;
  patient_id: number;
  owner_clinic_id: number;
  target_clinic_id: number;
  access_level: 'READ' | 'WRITE';
  status: 'ACTIVE' | 'REVOKED';
  expires_at: Date;
  revoked_at: Date | null;
};
// null = global admin (SUPER_ADMIN / SYSTEM_ADMIN) - matches accessibleClinicIds(req)
type ClinicScope = number[] | null;

const NOW = new Date('2030-01-01T00:00:00.000Z');
const FUTURE = () => new Date(NOW.getTime() + 86400000);
const PAST = () => new Date(NOW.getTime() - 86400000);

// Patients: patient 1 is owned by clinic 2, patient 2 is owned by clinic 7
const PATIENTS: Patient[] = [
  { patient_id: 1, clinic_id: 2 },
  { patient_id: 2, clinic_id: 7 },
];

const shareFixture = (over: Partial<Share> & { share_id: number }): Share => ({
  patient_id: 1,
  owner_clinic_id: 2,
  target_clinic_id: 1,
  access_level: 'READ',
  status: 'ACTIVE',
  expires_at: FUTURE(),
  revoked_at: null,
  ...over,
});

// findPatientInOwnerScope(): $2::int[] IS NULL OR p.clinic_id = ANY($2::int[])
function findPatientInOwnerScope(patientId: number, scope: ClinicScope, patients: Patient[]): Patient | null {
  const patient = patients.find((p) => p.patient_id === patientId);
  if (!patient) return null;
  if (scope === null) return patient;
  return scope.includes(patient.clinic_id) ? patient : null;
}
// listPatientShares(): owner-scope gate, then
// SELECT ... WHERE s.patient_id = $1 AND s.owner_clinic_id = $2
function simulateListShares(patientId: number, scope: ClinicScope, patients: Patient[], shares: Share[]) {
  const patient = findPatientInOwnerScope(patientId, scope, patients);
  if (!patient) return { httpStatus: 404, shares: [] as Share[] };
  return {
    httpStatus: 200,
    shares: shares.filter((s) => s.patient_id === patient.patient_id && s.owner_clinic_id === patient.clinic_id),
  };
}

// revokePatientShare(): owner-scope gate, then
// UPDATE ... WHERE share_id = $1 AND patient_id = $2 AND owner_clinic_id = $3
// AND status = 'ACTIVE' RETURNING share_id
function simulateRevokeShare(
  shareId: number,
  patientId: number,
  scope: ClinicScope,
  patients: Patient[],
  shares: Share[],
  now: Date = NOW,
): { httpStatus: number } {
  const patient = findPatientInOwnerScope(patientId, scope, patients);
  if (!patient) return { httpStatus: 404 };
  const share = shares.find(
    (s) =>
      s.share_id === shareId &&
      s.patient_id === patientId &&
      s.owner_clinic_id === patient.clinic_id &&
      s.status === 'ACTIVE',
  );
  if (!share) return { httpStatus: 404 };
  share.status = 'REVOKED';
  share.revoked_at = now;
  return { httpStatus: 200 };
}

// sharePatientRecord(): owner-scope gate only (unchanged policy - regression guard)
function simulateCreateShare(patientId: number, scope: ClinicScope, patients: Patient[]): { httpStatus: number } {
  const patient = findPatientInOwnerScope(patientId, scope, patients);
  return { httpStatus: patient ? 201 : 404 };
}
// 1) Owner clinic keeps full management view of its own patient's shares
test('PS1 - owner clinic lists every share of its own patient', () => {
  const shares = [
    shareFixture({ share_id: 11, target_clinic_id: 1 }),
    shareFixture({ share_id: 12, target_clinic_id: 5, access_level: 'WRITE' }),
  ];
  const result = simulateListShares(1, [2], PATIENTS, shares);
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.shares.map((s) => s.share_id), [11, 12], 'owner sees shares to all target clinics');
});

// 2) A clinic holding an active READ share only gets record access - not the share list
test('PS2 - target clinic with an active READ share cannot list shares', () => {
  const shares = [shareFixture({ share_id: 11, target_clinic_id: 1 })];
  const result = simulateListShares(1, [1], PATIENTS, shares);
  assert.equal(result.httpStatus, 404, 'READ share grants reading the record only');
  assert.equal(result.shares.length, 0, 'no cross-clinic share enumeration');
});

// 3) WRITE is a record-level level, not a share-management privilege
test('PS3 - target clinic with an active WRITE share cannot list shares', () => {
  const shares = [shareFixture({ share_id: 11, target_clinic_id: 1, access_level: 'WRITE' })];
  const result = simulateListShares(1, [1], PATIENTS, shares);
  assert.equal(result.httpStatus, 404, 'WRITE share still grants no share management');
});

// 4) Target clinic cannot revoke the share it received
test('PS4 - target clinic cannot revoke the share it received', () => {
  const received = shareFixture({ share_id: 11, target_clinic_id: 1 });
  const thirdClinic = shareFixture({ share_id: 12, target_clinic_id: 5, access_level: 'WRITE' });
  const result = simulateRevokeShare(11, 1, [1], PATIENTS, [received, thirdClinic]);
  assert.equal(result.httpStatus, 404);
  assert.equal(received.status, 'ACTIVE', 'received share stays ACTIVE');
});

// 5) Core bypass: target clinic revoking a share granted to a third clinic
test('PS5 - target clinic cannot revoke a share granted to a third clinic', () => {
  const received = shareFixture({ share_id: 11, target_clinic_id: 1 });
  const thirdClinic = shareFixture({ share_id: 12, target_clinic_id: 5 });
  const result = simulateRevokeShare(12, 1, [1], PATIENTS, [received, thirdClinic]);
  assert.equal(result.httpStatus, 404, 'cross-clinic revocation rejected');
  assert.equal(thirdClinic.status, 'ACTIVE', 'third-clinic share untouched');
});

// 6) Owner clinic revokes a third-clinic share (normal cleanup path preserved)
test('PS6 - owner clinic revokes an active share granted to a third clinic', () => {
  const thirdClinic = shareFixture({ share_id: 12, target_clinic_id: 5 });
  const result = simulateRevokeShare(12, 1, [2], PATIENTS, [thirdClinic]);
  assert.equal(result.httpStatus, 200);
  assert.equal(thirdClinic.status, 'REVOKED');
  assert.equal(thirdClinic.revoked_at, NOW, 'revoked_at stamped');
});

// 7) Already revoked share cannot be revoked again (status = 'ACTIVE' filter)
test('PS7 - owner clinic cannot re-revoke an already REVOKED share', () => {
  const alreadyRevoked = shareFixture({ share_id: 11, target_clinic_id: 1, status: 'REVOKED', revoked_at: PAST() });
  const result = simulateRevokeShare(11, 1, [2], PATIENTS, [alreadyRevoked]);
  assert.equal(result.httpStatus, 404);
  assert.equal(alreadyRevoked.status, 'REVOKED', 'state unchanged');
});
// 8) Expired but ACTIVE share is still revocable by the owner (preserved behavior)
test('PS8 - owner clinic can revoke an expired ACTIVE share', () => {
  const expired = shareFixture({ share_id: 12, target_clinic_id: 5, expires_at: PAST() });
  const result = simulateRevokeShare(12, 1, [2], PATIENTS, [expired]);
  assert.equal(result.httpStatus, 200);
  assert.equal(expired.status, 'REVOKED');
});

// 9) Expired share grants the target clinic nothing
test('PS9 - expired share gives the target clinic no management rights', () => {
  const expired = shareFixture({ share_id: 11, target_clinic_id: 1, expires_at: PAST() });
  assert.equal(simulateListShares(1, [1], PATIENTS, [expired]).httpStatus, 404, 'no listing via expired share');
  assert.equal(simulateRevokeShare(11, 1, [1], PATIENTS, [expired]).httpStatus, 404, 'no revoke via expired share');
  assert.equal(expired.status, 'ACTIVE', 'state unchanged');
});

// 10) Global admins (scope = null) keep unrestricted management
test('PS10 - global admin manages shares of any patient', () => {
  const receivedShare = shareFixture({ share_id: 11, target_clinic_id: 1 });
  const otherPatientShare = shareFixture({ share_id: 13, patient_id: 2, owner_clinic_id: 7, target_clinic_id: 3 });
  const listed = simulateListShares(2, null, PATIENTS, [receivedShare, otherPatientShare]);
  assert.equal(listed.httpStatus, 200);
  assert.deepEqual(listed.shares.map((s) => s.share_id), [13]);
  assert.equal(simulateRevokeShare(13, 2, null, PATIENTS, [receivedShare, otherPatientShare]).httpStatus, 200);
  assert.equal(otherPatientShare.status, 'REVOKED');
});

// 11) Out-of-scope clinic: no ownership and no share - nothing leaks
test('PS11 - out-of-scope clinic cannot list or revoke shares of a guessed patient id', () => {
  const received = shareFixture({ share_id: 11, target_clinic_id: 1 });
  assert.equal(simulateListShares(1, [4], PATIENTS, [received]).httpStatus, 404);
  assert.equal(simulateRevokeShare(11, 1, [4], PATIENTS, [received]).httpStatus, 404);
  assert.equal(received.status, 'ACTIVE');
});

// 12) Scope stays per-clinic: another clinic in the same user's scope grants nothing
test('PS12 - ownership does not extend across the user other assigned clinics', () => {
  // patient 2 is owned by clinic 7; the user works in clinics 7 and 2
  const shares = [shareFixture({ share_id: 21, patient_id: 2, owner_clinic_id: 7, target_clinic_id: 3 })];
  assert.equal(simulateListShares(2, [7, 2], PATIENTS, shares).httpStatus, 200, 'owner clinic within multi-clinic scope');
  assert.equal(simulateListShares(2, [2], PATIENTS, shares).httpStatus, 404, 'scope without the owner clinic is denied');
});

// 13) Create policy reused the same owner-scope rule before and after hardening
test('PS13 - share creation requires the owner clinic scope', () => {
  assert.equal(simulateCreateShare(1, [2], PATIENTS).httpStatus, 201, 'owner clinic may share its patient');
  assert.equal(simulateCreateShare(1, [1], PATIENTS).httpStatus, 404, 'share-receiving clinic may not re-share');
  assert.equal(simulateCreateShare(1, null, PATIENTS).httpStatus, 201, 'global admin may share');
});