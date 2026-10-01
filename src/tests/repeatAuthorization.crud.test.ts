import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import {
  getRepeatAuthorization,
  createRepeatAuthorization,
  updateRepeatAuthorization,
  cancelRepeatAuthorization,
} from '../modules/prescriptions/repeatAuthorizations.controller';

/* ==========================================================================
 * Phase 10C.4C — Repeat authorization API
 * Optional, per prescription item, clinic-scoped, audited, never derived from
 * repeats_count. Cancellation is logical; nothing is ever deleted.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);
const ORIGINAL_QUERY = pool.query.bind(pool);

const DOCTOR = {
  userId: 7, roleId: 2, clinicId: 1, roleName: 'DOCTOR',
  permissions: ['VIEW_PRESCRIPTIONS', 'CREATE_PRESCRIPTION'], clinicIds: [1],
};

const makeReq = (itemId: string, user: unknown = DOCTOR): AuthenticatedRequest =>
  ({ body: {}, params: { itemId }, query: {}, user } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

const AUTH_ROW: QueryRow = {
  repeat_auth_id: 1, prescription_item_id: 300, clinic_id: 1, max_cycles: 2,
  status: 'ACTIVE', authorized_by_user_id: 7, authorized_at: '2026-01-01',
};

interface Scenario {
  itemFound?: boolean;
  existingAuth?: boolean;
  activeAuth?: boolean;
  failOn?: string;
}

/** يحاكي pool.query و pool.connect معاً — لازم لأن القراءة قد تمر بأي منهما. */
async function withAuthMocks(scenario: Scenario, run: (calls: QueryCall[]) => Promise<void>) {
  const calls: QueryCall[] = [];
  const handler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    calls.push({ text, params });
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (scenario.failOn && t.includes(scenario.failOn)) {
      throw Object.assign(new Error('simulated failure'), { code: 'XX000' });
    }
    if (t.includes('FROM prescription_items pi')) {
      if (params.some((p) => Array.isArray(p) && p.length === 0)) return { rows: [], rowCount: 0 };
      if (scenario.itemFound === false) return { rows: [], rowCount: 0 };
      return { rows: [{ item_id: 300, prescription_id: 100, prescribed_quantity: 30, uom: 'TABLET', clinic_id: 1 }], rowCount: 1 };
    }
    if (t.startsWith('SELECT ra.repeat_auth_id')) {
      return { rows: scenario.existingAuth ? [AUTH_ROW] : [], rowCount: scenario.existingAuth ? 1 : 0 };
    }
    if (t.startsWith('SELECT repeat_auth_id')) {
      return { rows: scenario.existingAuth ? [{ repeat_auth_id: 1 }] : [], rowCount: scenario.existingAuth ? 1 : 0 };
    }
    if (t.startsWith('UPDATE prescription_repeat_authorizations')) {
      if (scenario.activeAuth === false) return { rows: [], rowCount: 0 };
      return { rows: [{ ...AUTH_ROW, max_cycles: 4, status: 'ACTIVE' }], rowCount: 1 };
    }
    if (t.startsWith('INSERT INTO prescription_repeat_authorizations')) return { rows: [AUTH_ROW], rowCount: 1 };
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => handler(text, params),
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => handler(text, params);
  try {
    await run(calls);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

/** ينفّذ العملية ويعيد الحالة + الاستعلامات + الكتابات. */
type Handler = (req: AuthenticatedRequest, res: any) => Promise<unknown>;

async function invoke(
  operation: Handler,
  scenario: Scenario,
  body: Record<string, unknown>,
  itemId = '300',
  user: unknown = DOCTOR,
) {
  let outcome: { captured: { status: number; body: any }; calls: QueryCall[] } = { captured: { status: 0, body: undefined }, calls: [] };
  await withAuthMocks(scenario, async (calls) => {
    const { res, captured } = makeRes();
    const req = { body, params: { itemId }, query: {}, user } as unknown as AuthenticatedRequest;
    await operation(req, res);
    outcome = { captured, calls };
  });
  const { calls } = outcome;
  return {
    captured: outcome.captured,
    calls,
    writes: calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.text.trim())),
    wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
    wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    find: (needle: string) => calls.find((c) => c.text.includes(needle)),
  };
}

/* ==========================================================================
 * CREATE
 * ========================================================================== */

test('AUTH: creating an authorization persists the server-derived clinic and user', async () => {
  const r = await invoke(createRepeatAuthorization, {}, { max_cycles: 3 });
  assert.equal(r.captured.status, 201);
  assert.deepEqual(r.find('INSERT INTO prescription_repeat_authorizations')!.params, [300, 1, 3, DOCTOR.userId]);
});

test('AUTH: a client-supplied clinic_id or authorized_by_user_id is ignored', async () => {
  const r = await invoke(createRepeatAuthorization, {}, { max_cycles: 3, clinic_id: 9, authorized_by_user_id: 999 });
  const params = r.find('INSERT INTO prescription_repeat_authorizations')!.params;
  assert.equal(params[1], 1, 'clinic comes from the visit, not the body');
  assert.equal(params[3], DOCTOR.userId, 'the author comes from the session');
});

test('AUTH: an existing authorization is re-activated rather than duplicated', async () => {
  const r = await invoke(createRepeatAuthorization, { existingAuth: true }, { max_cycles: 5 });
  assert.equal(r.captured.status, 201);
  assert.equal(r.calls.some((c) => c.text.includes('INSERT INTO prescription_repeat_authorizations')), false);
  const update = r.find('UPDATE prescription_repeat_authorizations')!;
  assert.match(update.text, /status = 'ACTIVE'/);
  assert.deepEqual(update.params, [5, DOCTOR.userId, 300]);
});

test('AUTH: creation is audited inside the same transaction', async () => {
  const r = await invoke(createRepeatAuthorization, {}, { max_cycles: 3 });
  const audit = r.find('INSERT INTO audit_logs')!;
  const metadata = JSON.parse(String(audit.params[3]));

  assert.equal(audit.params[0], DOCTOR.userId);
  assert.equal(audit.params[1], 1);
  assert.match(audit.text, /'REPEAT_AUTHORIZED'/);
  assert.equal(metadata.prescription_item_id, 300);
  assert.equal(metadata.prescription_id, 100);
  assert.equal(metadata.max_cycles, 3);
  assert.equal(metadata.authorized_by_user_id, DOCTOR.userId);
  assert.equal(r.wasCommitted, true);
});

test('AUTH: an audit failure rolls back the authorization', async () => {
  const r = await invoke(createRepeatAuthorization, { failOn: 'INSERT INTO audit_logs' }, { max_cycles: 3 });
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('AUTH: an insert failure rolls back completely with no audit', async () => {
  const r = await invoke(
    createRepeatAuthorization,
    { failOn: 'INSERT INTO prescription_repeat_authorizations' },
    { max_cycles: 3 },
  );
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.calls.some((c) => c.text.includes('INSERT INTO audit_logs')), false);
});

/* ==========================================================================
 * VALIDATION + SCOPE
 * ========================================================================== */

test('AUTH: an invalid max_cycles is rejected before any query', async () => {
  for (const body of [{}, { max_cycles: 0 }, { max_cycles: -1 }, { max_cycles: 1000 }, { max_cycles: 'abc' }]) {
    const r = await invoke(createRepeatAuthorization, {}, body);
    assert.equal(r.captured.status, 400, JSON.stringify(body));
    assert.equal(r.calls.length, 0, JSON.stringify(body));
  }
});

test('AUTH: an invalid item id is rejected before any query', async () => {
  const r = await invoke(createRepeatAuthorization, {}, { max_cycles: 2 }, 'abc');
  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0);
});

test('AUTH: an out-of-clinic item returns 404 with zero writes', async () => {
  const r = await invoke(createRepeatAuthorization, {}, { max_cycles: 3 }, '300', { ...DOCTOR, clinicIds: [] });
  assert.equal(r.captured.status, 404);
  assert.equal(r.writes.length, 0, 'no authorization row, no audit');
  assert.equal(r.wasRolledBack, true);
});

test('AUTH: a missing prescription item returns 404 with zero writes', async () => {
  const r = await invoke(createRepeatAuthorization, { itemFound: false }, { max_cycles: 3 });
  assert.equal(r.captured.status, 404);
  assert.equal(r.writes.length, 0);
});

/* ==========================================================================
 * READ
 * ========================================================================== */

test('AUTH: reading a missing authorization reports the implicit max_cycles = 1', async () => {
  const r = await invoke(getRepeatAuthorization, {}, {});
  assert.equal(r.captured.status, 200);
  assert.deepEqual(r.captured.body.authorization, { prescription_item_id: 300, max_cycles: 1, status: 'NONE', implicit: true });
});

test('AUTH: reading an existing authorization returns it as explicit', async () => {
  const r = await invoke(getRepeatAuthorization, { existingAuth: true }, {});
  assert.equal(r.captured.status, 200);
  assert.equal(r.captured.body.authorization.max_cycles, 2);
  assert.equal(r.captured.body.authorization.implicit, false);
});

/* ==========================================================================
 * UPDATE
 * ========================================================================== */

test('AUTH: updating max_cycles is clinic-scoped and audited', async () => {
  const r = await invoke(updateRepeatAuthorization, { existingAuth: true }, { max_cycles: 4 });
  assert.equal(r.captured.status, 200);

  const update = r.find('UPDATE prescription_repeat_authorizations')!;
  assert.deepEqual(update.params, [4, DOCTOR.userId, 300, 1], 'the WHERE clause carries clinic 1');
  assert.ok(r.calls.some((c) => c.text.includes('INSERT INTO audit_logs')), 'update is audited');
  assert.equal(r.wasCommitted, true);
});

test('AUTH: update requires max_cycles in the body', async () => {
  const r = await invoke(updateRepeatAuthorization, {}, {});
  assert.equal(r.captured.status, 400);
  assert.equal(r.calls.length, 0);
});

test('AUTH: updating a non-existent authorization returns 404', async () => {
  const r = await invoke(updateRepeatAuthorization, { activeAuth: false }, { max_cycles: 4 });
  assert.equal(r.captured.status, 404);
  assert.equal(r.writes.filter((c) => /^(INSERT|DELETE)/i.test(c.text.trim())).length, 0, 'no row written');
  assert.equal(r.calls.some((c) => c.text.includes('INSERT INTO audit_logs')), false, 'nothing persisted, so nothing audited');
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

/* ==========================================================================
 * CANCEL
 * ========================================================================== */

test('AUTH: cancellation is logical and never deletes the row', async () => {
  const r = await invoke(cancelRepeatAuthorization, {}, {});

  assert.equal(r.captured.status, 200);
  const update = r.find('UPDATE prescription_repeat_authorizations')!;
  assert.match(update.text, /status = 'CANCELLED'/);
  assert.match(update.text, /AND status = 'ACTIVE'/);
  assert.equal(r.calls.some((c) => /^\s*DELETE/i.test(c.text)), false, 'authorization rows are never deleted');
  assert.ok(r.calls.some((c) => c.text.includes('INSERT INTO audit_logs')), 'cancellation is audited');
});

test('AUTH: cancelling an already-cancelled authorization returns 409 with nothing persisted', async () => {
  const r = await invoke(cancelRepeatAuthorization, { activeAuth: false }, {});
  assert.equal(r.captured.status, 409);
  assert.equal(r.writes.filter((c) => /^(INSERT|DELETE)/i.test(c.text.trim())).length, 0);
  assert.equal(r.calls.some((c) => c.text.includes('INSERT INTO audit_logs')), false);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

/* ==========================================================================
 * SAFETY
 * ========================================================================== */

test('AUTH: no endpoint ever references repeats_count', async () => {
  for (const op of [createRepeatAuthorization, updateRepeatAuthorization, cancelRepeatAuthorization, getRepeatAuthorization]) {
    const r = await invoke(op, { existingAuth: true }, { max_cycles: 2 });
    for (const call of r.calls) assert.doesNotMatch(call.text, /repeats_count/i);
  }
});

test('AUTH: the read-only helper exists for the documented read path', () => {
  assert.equal(typeof getRepeatAuthorization, 'function');
  assert.equal(typeof makeReq, 'function');
});
