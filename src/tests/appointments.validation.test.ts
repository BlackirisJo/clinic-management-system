import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppointmentSchema, updateAppointmentStatusSchema } from '../modules/appointments/appointments.validation';

test('accepts a valid appointment payload', () => {
  const result = createAppointmentSchema.safeParse({
    clinic_id: 1,
    patient_id: 3,
    doctor_id: 1,
    appointment_date: '2026-09-11',
    start_time: '12:00:00',
    end_time: '12:30:00',
  });

  assert.equal(result.success, true);
});

test('rejects an appointment whose end precedes its start', () => {
  const result = createAppointmentSchema.safeParse({
    clinic_id: 1,
    patient_id: 3,
    doctor_id: 1,
    appointment_date: '2026-09-11',
    start_time: '12:30:00',
    end_time: '12:00:00',
  });

  assert.equal(result.success, false);
});

test('accepts only statuses supported by the database', () => {
  assert.equal(updateAppointmentStatusSchema.safeParse({ status: 'CONFIRMED' }).success, true);
  assert.equal(updateAppointmentStatusSchema.safeParse({ status: 'PENDING' }).success, false);
});