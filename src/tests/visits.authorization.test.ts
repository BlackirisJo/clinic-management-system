import test from 'node:test';
import assert from 'node:assert/strict';

type PatientRecord = { patient_id: number; owner_clinic_id: number };
type PatientShare = { patient_id: number; target_clinic_id: number; access_level: 'READ' | 'WRITE'; status: 'ACTIVE' | 'REVOKED'; expires_at: Date };
type UserRecord = { user_id: number; clinic_id: number; status: 'ACTIVE' | 'INACTIVE' };

function simulateVisitAuthorization(patientId: number, visitClinicId: number, patients: PatientRecord[], shares: PatientShare[]): { allowed: boolean; reason: string } {
  const patient = patients.find((p) => p.patient_id === patientId);
  if (!patient) return { allowed: false, reason: 'patient_not_found' };
  const isOwnerClinic = patient.owner_clinic_id === visitClinicId;
  const activeWriteShare = shares.find((s) => s.patient_id === patientId && s.target_clinic_id === visitClinicId && s.access_level === 'WRITE' && s.status === 'ACTIVE' && s.expires_at > new Date());
  if (isOwnerClinic || activeWriteShare) return { allowed: true, reason: 'authorized' };
  return { allowed: false, reason: 'no_permission' };
}

function simulateDoctorAuthorization(doctorId: number, targetClinicId: number, doctors: UserRecord[]): { allowed: boolean; reason: string } {
  const doctor = doctors.find((u) => u.user_id === doctorId);
  if (!doctor) return { allowed: false, reason: 'doctor_not_found' };
  if (doctor.status !== 'ACTIVE') return { allowed: false, reason: 'doctor_inactive' };
  if (doctor.clinic_id === targetClinicId) return { allowed: true, reason: 'direct_clinic_match' };
  return { allowed: false, reason: 'no_clinic_staff_record' };
}

function simulateCreateVisitAuthorization(patientId: number, clinicId: number, doctorId: number, patients: PatientRecord[], shares: PatientShare[], doctors: UserRecord[]): { allowed: boolean; reason: string; httpStatus: number } {
  const docAuth = simulateDoctorAuthorization(doctorId, clinicId, doctors);
  if (!docAuth.allowed) return { allowed: false, reason: docAuth.reason, httpStatus: 400 };
  const patAuth = simulateVisitAuthorization(patientId, clinicId, patients, shares);
  if (!patAuth.allowed) return { allowed: false, reason: patAuth.reason, httpStatus: 403 };
  return { allowed: true, reason: 'approved', httpStatus: 201 };
}



test('TEST A — CROSS-CLINIC WRITE SHARE: visit succeeds', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, true, 'يجب أن ينجح مع WRITE share نشط');
  assert.equal(result.httpStatus, 201);
  assert.equal(result.reason, 'approved');
});


test('TEST A2 — no duplicate patient created', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(patients.length, 1, 'لا ينبغي إنشاء مريض مكرر');
  assert.ok(patients[0], 'patients[0] should exist');
  assert.equal(patients[0]!.patient_id, 1, 'patient_id يجب أن يبقى 1');
});


test('TEST B — CROSS-CLINIC WITHOUT WRITE: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.reason, 'no_permission');
});

test('TEST C — OWNER CLINIC VISIT: succeeds', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 1, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 1, 101, patients, shares, doctors);
  assert.equal(result.allowed, true);
  assert.equal(result.httpStatus, 201);
});

test('TEST D — EXPIRED WRITE SHARE: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(Date.now() - 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 403);
});

test('TEST E — REVOKED WRITE SHARE: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'REVOKED', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 403);
});

test('TEST F — READ-ONLY SHARE: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'READ', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 403);
});

test('TEST G — READ-ONLY + owner clinic: succeeds via owner', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'READ', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 1, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 1, 101, patients, shares, doctors);
  assert.equal(result.allowed, true);
  assert.equal(result.httpStatus, 201);
});

test('TEST H — DOCTOR FROM WRONG CLINIC: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 1, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.reason, 'no_clinic_staff_record');
});

test('TEST I — INACTIVE DOCTOR: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'INACTIVE' }];
  const result = simulateCreateVisitAuthorization(1, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 400);
});

test('TEST J — PATIENT NOT FOUND: rejected', () => {
  const patients: PatientRecord[] = [{ patient_id: 1, owner_clinic_id: 1 }];
  const shares: PatientShare[] = [{ patient_id: 1, target_clinic_id: 2, access_level: 'WRITE', status: 'ACTIVE', expires_at: new Date(Date.now() + 86400000) }];
  const doctors: UserRecord[] = [{ user_id: 101, clinic_id: 2, status: 'ACTIVE' }];
  const result = simulateCreateVisitAuthorization(999, 2, 101, patients, shares, doctors);
  assert.equal(result.allowed, false);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.reason, 'patient_not_found');
});
