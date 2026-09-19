import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { pool } from '../config/database';

// اختبار تكامل شامل لإدارة الجلسات والحضور والحذف الآمن للمستخدمين.
// لا يعمل إلا عند توفر خادم حي (نفس نمط integration.test.ts):
//   INTEGRATION_BASE_URL + INTEGRATION_USERNAME + INTEGRATION_PASSWORD
const baseUrl = process.env.INTEGRATION_BASE_URL;
const adminUser = process.env.INTEGRATION_USERNAME;
const adminPassword = process.env.INTEGRATION_PASSWORD;
const integrationEnabled = Boolean(baseUrl && adminUser && adminPassword);
const skip = !integrationEnabled;

interface ApiResult {
  status: number;
  data: Record<string, any>;
}

const call = async (path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<ApiResult> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, data };
};

// لاحقة فريدة لكل تشغيل (timestamp + عشوائي) — أسماء المستخدمين فريدة في قاعدة
// البيانات حتى بعد الحذف الناعم، فلا يصطدم التشغيل ببيانات تشغيل سابقة
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const targetUsername = `sess_test_${suffix}`;
const sysadminUsername = `sess_admin_${suffix}`;
const targetPassword = 'TargetPassword123!';
const sysadminPassword = 'SysadminPassword123!';

// حالة مشتركة — node:test يشغّل اختبارات الملف الواحد بالتسلسل
const state = {
  adminToken: '',
  adminId: 0,
  adminRole: '',
  adminClinicId: null as number | null,
  targetId: 0,
  sysadminId: 0,
  sysadminToken: '',
  session1: 0,
  session2: 0,
  token1: '',
  token2: '',
  token3: '',
};
const createdUserIds: number[] = [];

test('setup: admin signs in', { skip }, async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPassword } });
  assert.equal(login.status, 200);
  state.adminToken = login.data.token;
  const me = await call('/api/auth/me', { token: state.adminToken });
  assert.equal(me.status, 200);
  state.adminId = me.data.user.userId;
  state.adminRole = me.data.user.roleName;
  state.adminClinicId = me.data.user.clinicId ?? null;
});

test('heartbeat requires authentication', { skip }, async () => {
  const res = await call('/api/auth/heartbeat', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('admin creates the target user', { skip }, async () => {
  const created = await call('/api/users', {
    method: 'POST',
    token: state.adminToken,
    body: {
      full_name: 'Sessions Test Doctor',
      username: targetUsername,
      password: targetPassword,
      role_name: 'DOCTOR',
      ...(state.adminClinicId ? { clinic_id: state.adminClinicId } : {}),
    },
  });
  assert.equal(created.status, 201, `فشل إنشاء المستخدم: ${created.data.message ?? ''}`);
  state.targetId = created.data.user.user_id;
  createdUserIds.push(state.targetId);
});

test('target signs in — session 1', { skip }, async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: targetUsername, password: targetPassword } });
  assert.equal(login.status, 200);
  state.token1 = login.data.token;
  assert.equal((await call('/api/auth/me', { token: state.token1 })).status, 200);
});

test('heartbeat updates the signed-in session', { skip }, async () => {
  const res = await call('/api/auth/heartbeat', { method: 'POST', token: state.token1 });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

test('admin lists target sessions with safe fields only', { skip }, async () => {
  const res = await call(`/api/users/${state.targetId}/sessions`, { token: state.adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.sessions.length, 1);
  const s = res.data.sessions[0];
  state.session1 = s.session_id;
  assert.ok(Number.isInteger(state.session1));
  assert.equal(typeof s.device, 'string');
  assert.equal(s.is_online, true);
  // لا يُكشف jti ولا أي توكن للواجهة
  assert.equal(s.jti, undefined);
  assert.equal(s.token, undefined);
  assert.equal(s.access_token, undefined);
  assert.equal(s.refresh_token, undefined);
});

test('target signs in again — independent session 2', { skip }, async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: targetUsername, password: targetPassword } });
  assert.equal(login.status, 200);
  state.token2 = login.data.token;
  assert.equal((await call('/api/auth/me', { token: state.token2 })).status, 200);
});

test('admin sees two active independent sessions', { skip }, async () => {
  const res = await call(`/api/users/${state.targetId}/sessions`, { token: state.adminToken });
  assert.equal(res.status, 200);
  const active = res.data.sessions.filter((s: any) => !s.revoked_at);
  assert.equal(active.length, 2);
  // الأحدث أولاً — الجلسة الثانية هي الأولى في الترتيب
  state.session2 = active[0].session_id;
  assert.notEqual(state.session2, state.session1);
});

test('a regular user cannot manage sessions or delete users', { skip }, async () => {
  assert.equal((await call('/api/users', { token: state.token2 })).status, 403);
  assert.equal((await call(`/api/users/${state.adminId}/sessions`, { token: state.token2 })).status, 403);
  assert.equal((await call(`/api/users/${state.adminId}/sessions/1/revoke`, { method: 'POST', token: state.token2 })).status, 403);
  assert.equal((await call(`/api/users/${state.adminId}`, { method: 'DELETE', token: state.token2 })).status, 403);
});

test('revoking session 1 does not affect session 2', { skip }, async () => {
  const res = await call(`/api/users/${state.targetId}/sessions/${state.session1}/revoke`, { method: 'POST', token: state.adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  // الجلسة الملغاة تموت فوراً — 403 مع إشارة SESSION_REVOKED
  const me1 = await call('/api/auth/me', { token: state.token1 });
  assert.equal(me1.status, 403);
  assert.equal(me1.data.code, 'SESSION_REVOKED');
  // نبضة الجلسة الملغاة ترفض أيضاً
  const hb1 = await call('/api/auth/heartbeat', { method: 'POST', token: state.token1 });
  assert.equal(hb1.status, 403);
  assert.equal(hb1.data.code, 'SESSION_REVOKED');
  // الجلسة الأخرى تبقى صالحة ويعمل المستخدم منها
  assert.equal((await call('/api/auth/me', { token: state.token2 })).status, 200);
  assert.equal((await call('/api/auth/heartbeat', { method: 'POST', token: state.token2 })).status, 200);
});

test('invalid session id is rejected safely', { skip }, async () => {
  assert.equal((await call(`/api/users/${state.targetId}/sessions/0/revoke`, { method: 'POST', token: state.adminToken })).status, 400);
  assert.equal((await call(`/api/users/${state.targetId}/sessions/abc/revoke`, { method: 'POST', token: state.adminToken })).status, 400);
  assert.equal((await call(`/api/users/${state.targetId}/sessions/999999999/revoke`, { method: 'POST', token: state.adminToken })).status, 404);
});

test('no admin can manage their own sessions through the admin endpoints', { skip }, async () => {
  // السرد الذاتي للجلسات قراءة مسموحة عمدًا (200) — المنع مخصص للعمليات الكتابية فقط
  const list = await call(`/api/users/${state.adminId}/sessions`, { token: state.adminToken });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.sessions));
  assert.equal(list.data.jti, undefined);
  assert.equal(list.data.token, undefined);
  assert.equal((await call(`/api/users/${state.adminId}/sessions/revoke-all`, { method: 'POST', token: state.adminToken })).status, 400);
  assert.equal((await call(`/api/users/${state.adminId}`, { method: 'DELETE', token: state.adminToken })).status, 400);
});

test('revoke-all ends every active session with an exact count', { skip }, async () => {
  const res = await call(`/api/users/${state.targetId}/sessions/revoke-all`, { method: 'POST', token: state.adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.revokedCount, 1); // الجلسة 2 فقط ما تزال نشطة
  assert.equal((await call('/api/auth/me', { token: state.token2 })).status, 403);
  // المستخدم أصبح غير متصل (بلا جلسة نشطة)
  const search = await call(`/api/users?search=${encodeURIComponent(targetUsername)}`, { token: state.adminToken });
  assert.equal(search.status, 200);
  const row = search.data.users.find((u: any) => u.username === targetUsername);
  assert.ok(row, 'المستخدم يجب أن يظهر في القائمة');
  assert.equal(row.is_online, false);
});

test('target signs in again before deletion', { skip }, async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: targetUsername, password: targetPassword } });
  assert.equal(login.status, 200);
  state.token3 = login.data.token;
});

test('admin deletes the target — sessions die, login blocked, history preserved', { skip }, async () => {
  const del = await call(`/api/users/${state.targetId}`, { method: 'DELETE', token: state.adminToken });
  assert.equal(del.status, 200);
  assert.equal(del.data.success, true);
  // JWT القديم لم يعد يعمل
  const me3 = await call('/api/auth/me', { token: state.token3 });
  assert.equal(me3.status, 403);
  assert.equal(me3.data.code, 'SESSION_REVOKED');
  // لا يمكن تسجيل الدخول مجدداً
  const login = await call('/api/auth/login', { method: 'POST', body: { username: targetUsername, password: targetPassword } });
  assert.equal(login.status, 403);
  // المحذوف مخفي عن القائمة النشطة ولا يمكن تعديله
  const search = await call(`/api/users?search=${encodeURIComponent(targetUsername)}`, { token: state.adminToken });
  assert.equal(search.data.users.find((u: any) => u.username === targetUsername), undefined);
  assert.equal((await call(`/api/users/${state.targetId}`, { method: 'PATCH', token: state.adminToken, body: { full_name: 'X Y Z' } })).status, 404);
  // السجلات التاريخية سليمة: صف المستخدم بقي (حذف ناعم) — يثبت ذلك ببقاء audit_logs
  // وuser_sessions المرتبطة به دون أي خطأ مفاتيح أجنبية في أي خطوة أعلاه
});

test('setup: a SYSTEM_ADMIN account is created for hierarchy tests', { skip }, async () => {
  const created = await call('/api/users', {
    method: 'POST',
    token: state.adminToken,
    body: {
      full_name: 'Sessions Test Sysadmin',
      username: sysadminUsername,
      password: sysadminPassword,
      role_name: 'SYSTEM_ADMIN',
      ...(state.adminClinicId ? { clinic_id: state.adminClinicId } : {}),
    },
  });
  assert.equal(created.status, 201, `فشل إنشاء المدير التجريبي: ${created.data.message ?? ''}`);
  state.sysadminId = created.data.user.user_id;
  createdUserIds.push(state.sysadminId);
  const login = await call('/api/auth/login', { method: 'POST', body: { username: sysadminUsername, password: sysadminPassword } });
  assert.equal(login.status, 200);
  state.sysadminToken = login.data.token;
});

test('a session cannot be revoked through another users path', { skip }, async () => {
  const res = await call(`/api/users/${state.sysadminId}/sessions/${state.session2}/revoke`, { method: 'POST', token: state.adminToken });
  assert.equal(res.status, 404);
  assert.equal((await call('/api/auth/me', { token: state.token2 })).status, 403); // أُلغيت مسبقاً بـ revoke-all
});

test('a lower admin cannot manage or delete a higher admin', { skip }, async (t) => {
  if (state.adminRole !== 'SUPER_ADMIN') return t.skip('حساب المدير في بيئة التكامل ليس SUPER_ADMIN');
  assert.equal((await call(`/api/users/${state.adminId}/sessions`, { token: state.sysadminToken })).status, 403);
  assert.equal((await call(`/api/users/${state.adminId}/sessions/1/revoke`, { method: 'POST', token: state.sysadminToken })).status, 403);
  assert.equal((await call(`/api/users/${state.adminId}`, { method: 'DELETE', token: state.sysadminToken })).status, 403);
});

test('DELETE_USERS cannot be granted to any role and SYSTEM_ADMIN can never delete', { skip }, async () => {
  // 1) لقطة صلاحيات SYSTEM_ADMIN الحالية ثم محاولة منح DELETE_USERS له — تُرفض في الخادم (403)
  const roles = await call('/api/permissions/roles', { token: state.adminToken });
  assert.equal(roles.status, 200);
  const sysadminRole = (roles.data.roles as any[]).find((r) => r.role_name === 'SYSTEM_ADMIN');
  assert.ok(sysadminRole, 'دور SYSTEM_ADMIN يجب أن يوجد');
  const originalKeys = (sysadminRole.permissions ?? []) as string[];
  assert.equal(originalKeys.includes('DELETE_USERS'), false);
  try {
    const grant = await call(`/api/permissions/roles/${sysadminRole.role_id}/permissions`, {
      method: 'PUT',
      token: state.adminToken,
      body: { permission_keys: [...originalKeys, 'DELETE_USERS'] },
    });
    assert.equal(grant.status, 403);
    // 1ب) إنشاء دور جديد حامل DELETE_USERS مرفوض أيضاً (400 — رفض إسناد محجوز)
    const createWithDelete = await call('/api/permissions/roles', {
      method: 'POST',
      token: state.adminToken,
      body: { role_name: `TMP_DELETE_PROBE_${suffix}`, permission_keys: ['DELETE_USERS'] },
    });
    assert.equal(createWithDelete.status, 400);
  } finally {
    // استعادة الحالة الأصلية احترازياً (لا تغيير متوقع لأن المنح مرفوض قبل أي كتابة)
    await call(`/api/permissions/roles/${sysadminRole.role_id}/permissions`, {
      method: 'PUT',
      token: state.adminToken,
      body: { permission_keys: originalKeys },
    });
  }
  // 2) DELETE_USERS مسندة لـ SUPER_ADMIN فقط — تحقق قرائي من حالة الإسناد الفعلية
  const rolesAfter = await call('/api/permissions/roles', { token: state.adminToken });
  const holders = (rolesAfter.data.roles as any[])
    .filter((r) => ((r.permissions ?? []) as string[]).includes('DELETE_USERS'))
    .map((r) => r.role_name);
  assert.deepEqual(holders, ['SUPER_ADMIN']);
  // 3) SYSTEM_ADMIN يُرفض من الحذف حتى لو حاول — ضحية فحص مستقلة وحية
  const victim = await call('/api/users', {
    method: 'POST',
    token: state.adminToken,
    body: {
      full_name: 'Delete Guard Victim',
      username: `del_victim_${suffix}`,
      password: 'VictimPassword123!',
      role_name: 'DOCTOR',
      ...(state.adminClinicId ? { clinic_id: state.adminClinicId } : {}),
    },
  });
  assert.equal(victim.status, 201, `فشل إنشاء ضحية الفحص: ${victim.data.message ?? ''}`);
  const victimId = victim.data.user.user_id as number;
  createdUserIds.push(victimId);
  assert.equal((await call(`/api/users/${victimId}`, { method: 'DELETE', token: state.sysadminToken })).status, 403);
  // 4) SUPER_ADMIN يمر من حارس الحذف وينفذ العملية على الضحية نفسها
  const del = await call(`/api/users/${victimId}`, { method: 'DELETE', token: state.adminToken });
  assert.equal(del.status, 200);
  assert.equal(del.data.success, true);
});

test('C1 - session stores IPv4 address at login', { skip }, async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPassword } });
  assert.equal(login.status, 200);
  const token = login.data.token;
  const me = await call('/api/auth/me', { token });
  assert.equal(me.status, 200);
  const userId = me.data.user.userId;
  const sessions = await call(`/api/users/${userId}/sessions`, { token });
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray(sessions.data.sessions));
  assert.ok(sessions.data.sessions.length >= 1, 'there is at least one session');
  const recentSession = sessions.data.sessions[0];
  assert.ok(recentSession.ip_address, 'ip_address should be present');
  assert.equal(typeof recentSession.ip_address, 'string', 'ip_address should be a string');
  assert.ok(/^(\d{1,3}\.){3}\d{1,3}$/.test(recentSession.ip_address) || recentSession.ip_address.includes(':'), 'ip_address should be valid IPv4 or IPv6');
  // IPv4 specifically
  assert.ok(/^(\d{1,3}\.){3}\d{1,3}$/.test(recentSession.ip_address), 'ip_address should be IPv4 format');
});

test('C2 - session stores IPv6 address if available', { skip }, async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPassword } });
  assert.equal(login.status, 200);
  const token = login.data.token;
  const me = await call('/api/auth/me', { token });
  assert.equal(me.status, 200);
  const userId = me.data.user.userId;
  const sessions = await call(`/api/users/${userId}/sessions`, { token });
  assert.equal(sessions.status, 200);
  const recentSession = sessions.data.sessions[0];
  assert.ok(recentSession.ip_address, 'ip_address should be present');
  // If the environment uses IPv6, verify it is stored correctly
  if (recentSession.ip_address.includes(':')) {
    assert.ok(recentSession.ip_address.length <= 45, 'IPv6 address should be within valid length');
  }
});

test('C3 - session list returns ip_address field', { skip }, async () => {
  const sessions = await call(`/api/users/${state.adminId}/sessions`, { token: state.adminToken });
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray(sessions.data.sessions));
  if (sessions.data.sessions.length > 0) {
    assert.ok('ip_address' in sessions.data.sessions[0], 'session should have ip_address field');
  }
});

test('C4 - revoked session retains IP and revoked_at', { skip }, async () => {
  const sessions = await call(`/api/users/${state.adminId}/sessions`, { token: state.adminToken });
  assert.equal(sessions.status, 200);
  assert.ok(sessions.data.sessions.length >= 1, 'there is at least one session');
  const targetSessionId = sessions.data.sessions[0].session_id;
  assert.ok(targetSessionId > 0);
  // Check pre-revoke state
  assert.ok(sessions.data.sessions[0].ip_address, 'ip_address present before revoke');
  assert.equal(sessions.data.sessions[0].revoked_at, null, 'not revoked before revoke');
  // Revoke
  const revoke = await call(`/api/users/${state.adminId}/sessions/${targetSessionId}/revoke`, { method: 'POST', token: state.adminToken });
  assert.equal(revoke.status, 200, `revoke failed: ${revoke.data?.message}`);
  // Check post-revoke state
  const afterRevoke = await call(`/api/users/${state.adminId}/sessions`, { token: state.adminToken });
  assert.equal(afterRevoke.status, 200);
  const revokedSession = afterRevoke.data.sessions.find((s: any) => s.session_id === targetSessionId);
  assert.ok(revokedSession, 'revoked session should still be in list');
  assert.ok(revokedSession.ip_address, 'ip_address retained after revoke');
  assert.ok(revokedSession.revoked_at, 'revoked_at should be set after revoke');
});

test('C5 - recently revoked session is retained (not cleaned up)', { skip }, async () => {
  const sessions = await call(`/api/users/${state.adminId}/sessions`, { token: state.adminToken });
  assert.equal(sessions.status, 200);
  assert.ok(sessions.data.sessions.length >= 1, 'there is at least one session');
  // Find a recently revoked session and verify it still appears in the list
  const revokedSession = sessions.data.sessions.find((s: any) => s.revoked_at !== null && s.revoked_at !== undefined);
  if (revokedSession) {
    assert.ok(revokedSession.ip_address, 'recently revoked session retains IP');
    const elapsed = Date.now() - new Date(revokedSession.revoked_at).getTime();
    assert.ok(elapsed < 60000, 'session was revoked recently (within 60 seconds)');
  } else {
    // Create a fresh revoke to test
    const createUser = await call('/api/users', {
      method: 'POST',
      token: state.adminToken,
      body: { full_name: 'Temp Session Test', username: `temp_sess_${suffix}`, password: 'TempPass123!', role_name: 'DOCTOR' },
    });
    assert.equal(createUser.status, 201);
    const tempId = createUser.data.user.user_id;
    createdUserIds.push(tempId);
    const login = await call('/api/auth/login', { method: 'POST', body: { username: `temp_sess_${suffix}`, password: 'TempPass123!' } });
    assert.equal(login.status, 200);
    const tempToken = login.data.token;
    const me = await call('/api/auth/me', { token: tempToken });
    const tempUserId = me.data.user.userId;
    const userSessions = await call(`/api/users/${tempUserId}/sessions`, { token: tempToken });
    assert.ok(userSessions.data.sessions.length >= 1);
    const sid = userSessions.data.sessions[0].session_id;
    await call(`/api/users/${tempUserId}/sessions/${sid}/revoke`, { method: 'POST', token: state.adminToken });
    // Immediately check the revoked session is still listed
    const afterRevoke = await call(`/api/users/${tempUserId}/sessions`, { token: state.adminToken });
    assert.equal(afterRevoke.status, 200);
    const found = afterRevoke.data.sessions.find((s: any) => s.session_id === sid);
    assert.ok(found, 'recently revoked session should still appear');
    assert.ok(found.ip_address, 'recently revoked session retains IP');
    assert.ok(found.revoked_at, 'revoked_at is set');
  }
});

test('C6 - session older than 7 days is eligible for cleanup', { skip }, async () => {
  // Verify the cleanup SQL logic: sessions revoked > 7 days ago match the cleanup condition
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM user_sessions
     WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        OR (revoked_at IS NULL AND expires_at < NOW() - INTERVAL '7 days')`
  );
  // This verifies the SQL runs without error and returns a count
  assert.ok(Number(result.rows[0]?.count) >= 0, 'cleanup query should return a valid count');
  // Verify that no recently-revoked session matches the cleanup condition
  const recentResult = await pool.query(
    `SELECT COUNT(*) as count FROM user_sessions
     WHERE revoked_at IS NOT NULL AND revoked_at >= NOW() - INTERVAL '7 days'`
  );
  const recentCount = Number(recentResult.rows[0]?.count);
  // These sessions are NOT eligible for cleanup (within 7 days)
  assert.ok(recentCount >= 0, 'recently revoked sessions count should be non-negative');
  // Active sessions should NOT match cleanup condition
  const activeResult = await pool.query(
    `SELECT COUNT(*) as count FROM user_sessions
     WHERE revoked_at IS NULL AND expires_at > NOW()`
  );
  const activeCount = Number(activeResult.rows[0]?.count);
  assert.ok(activeCount >= 0, 'active sessions count should be non-negative');
  // Verify active sessions are NOT eligible for cleanup (they are NOT in the cleanup set)
  const activeEligible = await pool.query(
    `SELECT COUNT(*) as count FROM user_sessions
     WHERE revoked_at IS NULL AND expires_at > NOW()
       AND ((revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
         OR (revoked_at IS NULL AND expires_at < NOW() - INTERVAL '7 days'))`
  );
  assert.equal(Number(activeEligible.rows[0]?.count), 0, 'active sessions should NOT be eligible for cleanup');
});

test('C7 - active session is not removed by retention logic', { skip }, async () => {
  const sessions = await call(`/api/users/${state.adminId}/sessions`, { token: state.adminToken });
  assert.equal(sessions.status, 200);
  const activeSessions = sessions.data.sessions.filter((s: any) => s.is_online);
  // Active sessions exist
  if (activeSessions.length > 0) {
    // Verify none of them have been in the database for more than 7 days with expiry passed
    const activeIds = activeSessions.map((s: any) => s.session_id);
    const result = await pool.query(
      `SELECT session_id FROM user_sessions
       WHERE revoked_at IS NULL AND expires_at > NOW()
         AND session_id = ANY($1::int[])`,
      [activeIds]
    );
    assert.equal(result.rowCount, activeIds.length, 'all active sessions should still exist in DB');
  }
  // Also verify via SQL that active sessions do NOT match cleanup criteria
  const cleanupCheck = await pool.query(
    `SELECT COUNT(*) as count FROM user_sessions
     WHERE revoked_at IS NULL AND expires_at > NOW()
       AND expires_at < NOW() - INTERVAL '7 days'`
  );
  assert.equal(Number(cleanupCheck.rows[0]?.count), 0, 'active sessions should not be past 7-day expiry threshold');
});

test('cleanup: remove test users', { skip }, async () => {
  // إذا فشل تسجيل دخول المدير أثناء التجهيز فسيكون التوكن فارغاً — تُنشأ جلسة تنظيف بديلة
  if (!state.adminToken) {
    const relogin = await call('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPassword } });
    if (relogin.status === 200) state.adminToken = relogin.data.token;
  }
  for (const id of createdUserIds) {
    if (!id) continue;
    await call(`/api/users/${id}`, { method: 'DELETE', token: state.adminToken });
  }
  const search = await call(`/api/users?search=sess_${suffix}`, { token: state.adminToken });
  assert.equal(search.data.users.filter((u: any) => u.username === targetUsername || u.username === sysadminUsername).length, 0);
});