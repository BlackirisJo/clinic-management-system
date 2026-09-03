import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.INTEGRATION_BASE_URL;
const username = process.env.INTEGRATION_USERNAME;
const password = process.env.INTEGRATION_PASSWORD;
const integrationEnabled = Boolean(baseUrl && username && password);

test('API health endpoint responds with database status', { skip: !integrationEnabled }, async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as { database: string };
  assert.equal(body.database, 'OK');
});

test('authenticated API can access reports and revoke a session', { skip: !integrationEnabled }, async () => {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json() as { token: string };
  const headers = { authorization: `Bearer ${login.token}` };

  const reportResponse = await fetch(`${baseUrl}/api/reports/overview`, { headers });
  assert.equal(reportResponse.status, 200);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers });
  assert.equal(logoutResponse.status, 200);

  const revokedResponse = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal(revokedResponse.status, 403);
});