import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import {
  createMedication,
  updateMedication,
  deleteMedication,
} from '../modules/prescriptions/prescriptions.controller';

/* ==========================================================================
 * Phase 9B — Medication CRUD (direct controller tests, mocked pool.query)
 * No real PostgreSQL is used: only pool.query is stubbed and always restored.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);

async function withMockedPool(
  handler: (text: string, params: unknown[]) => MockResult,
  run: (calls: QueryCall[]) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return handler(text, params);
  };
  try {
    await run(calls);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const medicationReq = (body: Record<string, unknown> = {}, id?: string): AuthenticatedRequest =>
  ({ body, params: id === undefined ? {} : { id } } as unknown as AuthenticatedRequest);

const medicationRow = (over: Record<string, unknown> = {}): QueryRow => ({
  medication_id: 11, trade_name: 'Amoxil', scientific_name: 'Amoxicillin',
  default_dosage: null, instructions: null, strength: null, dosage_form: null, ...over,
});

const VALID_CREATE_BODY = {
  trade_name: 'Amoxil', scientific_name: 'Amoxicillin',
  default_dosage: '1 x 3', strength: '500 mg', dosage_form: 'CAPSULE',
};

/* ==========================================================================
 * 1. CREATE
 * ========================================================================== */

test('CREATE: valid medication with strength + valid dosage_form succeeds', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('SELECT medication_id')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO medications')) {
        return { rows: [medicationRow({ strength: '500 mg', dosage_form: 'CAPSULE' })], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await createMedication(medicationReq({ ...VALID_CREATE_BODY }), res);

      assert.equal(captured.status, 201);
      assert.equal(captured.body.medication.dosage_form, 'CAPSULE');
      assert.equal(captured.body.medication.strength, '500 mg');

      const insert = calls.find((c) => c.text.includes('INSERT INTO medications'));
      assert.ok(insert, 'INSERT must be executed');
      assert.equal(insert.params[0], 'Amoxil');
      assert.equal(insert.params[4], '500 mg', 'strength must be persisted');
      assert.equal(insert.params[5], 'CAPSULE', 'dosage_form must be persisted');
    },
  );
});

test('CREATE: invalid dosage_form returns 400 + VALIDATION_ERROR without touching the DB', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid dosage_form'); },
    async (calls) => {
      await createMedication(medicationReq({ ...VALID_CREATE_BODY, dosage_form: 'PILLS' }), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

/* ==========================================================================
 * 2. UPDATE
 * ========================================================================== */

test('UPDATE: valid update including strength + dosage_form returns 200 and the updated medication', async () => {
  const { res, captured } = makeRes();
  const updated = medicationRow({ medication_id: 7, strength: '250 mg/5ml', dosage_form: 'SYRUP' });

  await withMockedPool(
    (text) => {
      if (text.includes('SELECT medication_id')) return { rows: [medicationRow({ medication_id: 7 })], rowCount: 1 };
      if (text.includes('UPDATE medications')) return { rows: [updated], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateMedication(medicationReq({ strength: '250 mg/5ml', dosage_form: 'syrup' }, '7'), res);

      assert.equal(captured.status, 200);
      assert.equal(captured.body.medication.medication_id, 7);
      assert.equal(captured.body.medication.strength, '250 mg/5ml');
      assert.equal(captured.body.medication.dosage_form, 'SYRUP');

      const update = calls.find((c) => c.text.includes('UPDATE medications'));
      assert.ok(update, 'UPDATE must be executed');
      assert.match(update.text, /strength = \$\d/);
      assert.match(update.text, /dosage_form = \$\d/);
      assert.ok(update.params.includes('SYRUP'), 'dosage_form is normalised to upper case');
    },
  );
});

test('UPDATE: invalid dosage_form returns 400 + VALIDATION_ERROR', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    () => { throw new Error('pool.query must not be called for an invalid dosage_form'); },
    async (calls) => {
      await updateMedication(medicationReq({ dosage_form: 'INVALID_FORM' }, '7'), res);
      assert.equal(calls.length, 0);
    },
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, ApiErrorCode.VALIDATION_ERROR);
});

test('UPDATE: nonexistent medication returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('SELECT medication_id')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await updateMedication(medicationReq({ strength: '500 mg' }, '999'), res);
      assert.equal(calls.length, 1, 'no UPDATE is issued when the row does not exist');
    },
  );

  assert.equal(captured.status, 404);
});

/* ==========================================================================
 * 3. DELETE
 * ========================================================================== */

test('DELETE: existing unreferenced medication returns 200', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('SELECT medication_id')) return { rows: [medicationRow({ medication_id: 3 })], rowCount: 1 };
      if (text.includes('DELETE FROM medications')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await deleteMedication(medicationReq({}, '3'), res);
      assert.equal(calls.length, 2, 'SELECT then DELETE');
      assert.match(calls[1]!.text, /DELETE FROM medications/);
    },
  );

  assert.equal(captured.status, 200);
});

test('DELETE: nonexistent medication returns 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(
    (text) => {
      if (text.includes('SELECT medication_id')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await deleteMedication(medicationReq({}, '999'), res);
      assert.equal(calls.length, 1, 'DELETE must not run when the row does not exist');
    },
  );

  assert.equal(captured.status, 404);
});

test('DELETE: medication referenced by a prescription returns 409 (FK 23503)', async () => {
  const { res, captured } = makeRes();
  const fkViolation = Object.assign(new Error('violates foreign key constraint'), { code: '23503' });

  await withMockedPool(
    (text) => {
      if (text.includes('SELECT medication_id')) return { rows: [medicationRow({ medication_id: 4 })], rowCount: 1 };
      if (text.includes('DELETE FROM medications')) throw fkViolation;
      throw new Error(`Unexpected query: ${text}`);
    },
    async (calls) => {
      await deleteMedication(medicationReq({}, '4'), res);
      assert.equal(calls.length, 2);
    },
  );

  assert.equal(captured.status, 409);
  // Current implementation reuses ApiErrorCode.FORBIDDEN for this 409 (production code unchanged).
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.match(String(captured.body.message), /prescriptions/);
});

/* ==========================================================================
 * 4. AUTHORIZATION — requirePermission('MANAGE_MEDICATIONS') middleware
 * ========================================================================== */

test('AUTHORIZATION: requirePermission("MANAGE_MEDICATIONS") denies users without the permission (403)', () => {
  const runMiddleware = (roleName: string, permissions: string[]) => {
    const req = {
      user: { userId: 9, roleId: 9, clinicId: 1, roleName, permissions },
    } as unknown as AuthenticatedRequest;
    const mockRes = { status: (_code: number) => ({ json: (_body: any) => {} }) };
    let error: any = null;
    let nextCalled = false;

    requirePermission('MANAGE_MEDICATIONS')(req, mockRes as any, (err?: any) => {
      if (err) error = err; else nextCalled = true;
    });

    return { error, nextCalled };
  };

  const denied = runMiddleware('DOCTOR', ['VIEW_MEDICATIONS', 'CREATE_PRESCRIPTION']);
  assert.equal(denied.nextCalled, false, 'middleware must not call next() without the permission');
  assert.equal(denied.error?.statusCode, 403);
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware('DOCTOR', ['MANAGE_MEDICATIONS']);
  assert.equal(allowed.error, null);
  assert.equal(allowed.nextCalled, true, 'permission holder passes through');
});
