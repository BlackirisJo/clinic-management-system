import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserSchema, updateUserSchema } from '../modules/users/users.validation';

test('accepts a valid doctor account', () => {
  assert.equal(createUserSchema.safeParse({
    full_name: 'Test Doctor',
    username: 'test_doctor',
    password: 'StrongPassword123!',
    role_name: 'DOCTOR',
    clinic_id: 1,
  }).success, true);
});

test('rejects weak passwords and invalid usernames', () => {
  assert.equal(createUserSchema.safeParse({
    full_name: 'Test Doctor',
    username: 'bad username',
    password: 'short',
    role_name: 'DOCTOR',
    clinic_id: 1,
  }).success, false);
});

test('accepts account suspension updates', () => {
  assert.equal(updateUserSchema.safeParse({ status: 'SUSPENDED' }).success, true);
});