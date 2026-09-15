require('dotenv').config();
const BASE = 'http://localhost:3000';
(async () => {
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_INITIAL_PASSWORD }) });
  const lj = await login.json();
  if (!login.ok) throw new Error('LOGIN_FAIL ' + JSON.stringify(lj));
  const token = lj.token;
  const roles = async () => (await (await fetch(BASE + '/api/permissions/roles', { headers: { Authorization: 'Bearer ' + token } })).json()).roles;
  const show = async (tag, roleName) => {
    const d = (await roles()).find(x => x.role_name === roleName);
    console.log(tag + ' ' + roleName + '(' + d.role_id + ') count=' + d.permissions.length + ' = ' + JSON.stringify(d.permissions));
    return d;
  };
  const nurse = await show('BEFORE', 'NURSE');
  const next = Array.from(new Set([...nurse.permissions, 'MANAGE_APPOINTMENTS']));
  console.log('SENDING ' + JSON.stringify(next));
  const res = await fetch(BASE + '/api/permissions/roles/' + nurse.role_id + '/permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ permission_keys: next }) });
  const j = await res.json();
  console.log('SAVE status=' + res.status + ' msg=' + j.message + ' hasRole=' + Boolean(j.role));
  await show('AFTER', 'NURSE');
})().catch(e => { console.error('TEST_FAIL: ' + e.message); process.exit(1); });
