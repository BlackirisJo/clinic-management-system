import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-only-jwt-secret';

test('hashes and compares passwords', async () => {
  const { hashPassword, comparePassword } = await import('../utils/auth');
  const hash = await hashPassword('CorrectPassword123!');

  assert.equal(await comparePassword('CorrectPassword123!', hash), true);
  assert.equal(await comparePassword('WrongPassword123!', hash), false);
});

test('generates a verifiable JWT', async () => {
  const jwt = await import('jsonwebtoken');
  const { generateToken } = await import('../utils/auth');
  const token = generateToken({ userId: 1, roleId: 1, clinicId: 1 });
  const payload = jwt.default.verify(token, 'test-only-jwt-secret') as { userId: number };

  assert.equal(payload.userId, 1);
});