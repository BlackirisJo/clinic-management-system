import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { ApiErrorCode } from '../utils/apiErrors';

// ————————————————————————————————————————————————————————————————
// Phase 10A — Pharmacy Authorization Tests
// Tests the new pharmacy permissions: VIEW_PHARMACY_QUEUE, VIEW_PRESCRIPTIONS
// and the PHARMACIST role authorization via requirePermission middleware.
// ————————————————————————————————————————————————————————————————

// Mock response factory matching existing patterns
const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

// Helper to run requirePermission middleware with a given role/permissions
const runMiddleware = (requiredPermission: string, roleName: string, permissions: string[] = []) => {
  const req = {
    user: { userId: 9, roleId: 9, clinicId: 1, roleName, permissions },
  } as unknown as AuthenticatedRequest;
  const mockRes = { status: (_code: number) => ({ json: (_body: any) => {} }) };
  let error: any = null;
  let nextCalled = false;

  requirePermission(requiredPermission)(req, mockRes as any, (err?: any) => {
    if (err) error = err; else nextCalled = true;
  });

  return { error, nextCalled };
};

// ————————————————————————————————————————————————————————————————
// 1) VIEW_PHARMACY_QUEUE permission
// ————————————————————————————————————————————————————————————————

test('VIEW_PHARMACY_QUEUE: PHARMACIST role with permission can access', () => {
  const allowed = runMiddleware('VIEW_PHARMACY_QUEUE', 'PHARMACIST', ['VIEW_PHARMACY_QUEUE', 'VIEW_PRESCRIPTIONS']);
  assert.equal(allowed.error, null, 'PHARMACIST with VIEW_PHARMACY_QUEUE should pass');
  assert.equal(allowed.nextCalled, true, 'next() should be called for authorized user');
});

test('VIEW_PHARMACY_QUEUE: SUPER_ADMIN bypasses permission check', () => {
  const allowed = runMiddleware('VIEW_PHARMACY_QUEUE', 'SUPER_ADMIN', []);
  assert.equal(allowed.error, null, 'SUPER_ADMIN should bypass permission check');
  assert.equal(allowed.nextCalled, true);
});

test('VIEW_PHARMACY_QUEUE: SYSTEM_ADMIN bypasses permission check', () => {
  const allowed = runMiddleware('VIEW_PHARMACY_QUEUE', 'SYSTEM_ADMIN', []);
  assert.equal(allowed.error, null, 'SYSTEM_ADMIN should bypass permission check');
  assert.equal(allowed.nextCalled, true);
});

test('VIEW_PHARMACY_QUEUE: user without permission is denied (403)', () => {
  const denied = runMiddleware('VIEW_PHARMACY_QUEUE', 'DOCTOR', ['VIEW_PATIENTS', 'CREATE_VISIT']);
  assert.equal(denied.nextCalled, false, 'middleware must not call next() without the permission');
  assert.equal(denied.error?.statusCode, 403, 'should return 403 Forbidden');
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN, 'should use FORBIDDEN code');
});

test('VIEW_PHARMACY_QUEUE: user with VIEW_PRESCRIPTIONS but not VIEW_PHARMACY_QUEUE is denied', () => {
  const denied = runMiddleware('VIEW_PHARMACY_QUEUE', 'PHARMACIST', ['VIEW_PRESCRIPTIONS']);
  assert.equal(denied.nextCalled, false, 'VIEW_PRESCRIPTIONS alone does not grant VIEW_PHARMACY_QUEUE');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);
});

test('VIEW_PHARMACY_QUEUE: user with no permissions is denied', () => {
  const denied = runMiddleware('VIEW_PHARMACY_QUEUE', 'RECEPTIONIST', []);
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);
});

// ————————————————————————————————————————————————————————————————
// 2) VIEW_PRESCRIPTIONS permission
// ————————————————————————————————————————————————————————————————

test('VIEW_PRESCRIPTIONS: PHARMACIST role with permission can access', () => {
  const allowed = runMiddleware('VIEW_PRESCRIPTIONS', 'PHARMACIST', ['VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE']);
  assert.equal(allowed.error, null, 'PHARMACIST with VIEW_PRESCRIPTIONS should pass');
  assert.equal(allowed.nextCalled, true);
});

test('VIEW_PRESCRIPTIONS: SUPER_ADMIN bypasses permission check', () => {
  const allowed = runMiddleware('VIEW_PRESCRIPTIONS', 'SUPER_ADMIN', []);
  assert.equal(allowed.error, null, 'SUPER_ADMIN should bypass permission check');
  assert.equal(allowed.nextCalled, true);
});

test('VIEW_PRESCRIPTIONS: SYSTEM_ADMIN bypasses permission check', () => {
  const allowed = runMiddleware('VIEW_PRESCRIPTIONS', 'SYSTEM_ADMIN', []);
  assert.equal(allowed.error, null, 'SYSTEM_ADMIN should bypass permission check');
  assert.equal(allowed.nextCalled, true);
});

test('VIEW_PRESCRIPTIONS: user without permission is denied (403)', () => {
  const denied = runMiddleware('VIEW_PRESCRIPTIONS', 'DOCTOR', ['VIEW_PATIENTS', 'CREATE_VISIT']);
  assert.equal(denied.nextCalled, false, 'middleware must not call next() without the permission');
  assert.equal(denied.error?.statusCode, 403, 'should return 403 Forbidden');
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN, 'should use FORBIDDEN code');
});

test('VIEW_PRESCRIPTIONS: user with VIEW_PHARMACY_QUEUE but not VIEW_PRESCRIPTIONS is denied', () => {
  const denied = runMiddleware('VIEW_PRESCRIPTIONS', 'PHARMACIST', ['VIEW_PHARMACY_QUEUE']);
  assert.equal(denied.nextCalled, false, 'VIEW_PHARMACY_QUEUE alone does not grant VIEW_PRESCRIPTIONS');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);
});

// ————————————————————————————————————————————————————————————————
// 3) PHARMACIST role recognition
// ————————————————————————————————————————————————————————————————

test('PHARMACIST: role is recognized by requirePermission middleware', () => {
  // PHARMACIST with both permissions should pass both checks
  const queueAllowed = runMiddleware('VIEW_PHARMACY_QUEUE', 'PHARMACIST', ['VIEW_PHARMACY_QUEUE', 'VIEW_PRESCRIPTIONS']);
  assert.equal(queueAllowed.nextCalled, true, 'PHARMACIST should pass VIEW_PHARMACY_QUEUE check');

  const rxAllowed = runMiddleware('VIEW_PRESCRIPTIONS', 'PHARMACIST', ['VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE']);
  assert.equal(rxAllowed.nextCalled, true, 'PHARMACIST should pass VIEW_PRESCRIPTIONS check');
});

test('PHARMACIST: without any permissions is denied', () => {
  const denied = runMiddleware('VIEW_PHARMACY_QUEUE', 'PHARMACIST', []);
  assert.equal(denied.nextCalled, false, 'PHARMACIST without permissions should be denied');
  assert.equal(denied.error?.statusCode, 403);
});