import test from 'node:test';
import assert from 'node:assert/strict';
import cors from 'cors';

// Replicates the exact origin-resolution logic from src/app.ts:30-33
// so each test case can run with isolated env vars without module-cache conflicts.
function resolveAllowedOrigins(env: { NODE_ENV?: string; CORS_ORIGIN?: string | undefined }): string[] {
  const corsOriginRaw = env.CORS_ORIGIN;
  return (env.NODE_ENV === 'production'
    ? (corsOriginRaw || '').split(',').map((o: string) => o.trim()).filter(Boolean)
    : (corsOriginRaw || 'http://localhost:3000,http://localhost:5173').split(',').map((o: string) => o.trim()));
}

function corsRequest(allowedOrigins: string[], origin: string): Promise<{ aca: string | undefined }> {
  return new Promise((resolve) => {
    const middleware = cors({ origin: allowedOrigins });
    const req = { method: 'GET', headers: { origin } };
    const res: Record<string, string> = {};
    const fakeRes = {
      statusCode: 200,
      headers: res,
      setHeader(k: string, v: string) { res[k.toLowerCase()] = v; },
      getHeader(k: string) { return res[k.toLowerCase()]; },
      end() { resolve({ aca: res['access-control-allow-origin'] }); },
    };
    middleware(req as any, fakeRes as any, () => resolve({ aca: res['access-control-allow-origin'] }));
  });
}

test('CORS production + missing CORS_ORIGIN => no allowed origin', () => {
  const allowed = resolveAllowedOrigins({ NODE_ENV: 'production', CORS_ORIGIN: undefined });
  assert.deepEqual(allowed, []);
});

test('CORS production + explicit origin => only configured origin is allowed', async () => {
  const allowed = resolveAllowedOrigins({ NODE_ENV: 'production', CORS_ORIGIN: 'https://clinic.example.com' });
  assert.deepEqual(allowed, ['https://clinic.example.com']);

  const ok = await corsRequest(allowed, 'https://clinic.example.com');
  assert.equal(ok.aca, 'https://clinic.example.com');

  const blocked = await corsRequest(allowed, 'https://other.example.com');
  assert.equal(blocked.aca, undefined, 'Unconfigured origin should not receive ACA header');
});

test('CORS development + missing CORS_ORIGIN => localhost origins allowed', async () => {
  const allowed = resolveAllowedOrigins({ NODE_ENV: 'development', CORS_ORIGIN: undefined });
  assert.deepEqual(allowed, ['http://localhost:3000', 'http://localhost:5173']);

  const res3000 = await corsRequest(allowed, 'http://localhost:3000');
  assert.equal(res3000.aca, 'http://localhost:3000');

  const res5173 = await corsRequest(allowed, 'http://localhost:5173');
  assert.equal(res5173.aca, 'http://localhost:5173');
});

test('CORS development + explicit CORS_ORIGIN overrides localhost fallback', () => {
  const allowed = resolveAllowedOrigins({ NODE_ENV: 'development', CORS_ORIGIN: 'https://staging.example.com' });
  assert.deepEqual(allowed, ['https://staging.example.com']);
});