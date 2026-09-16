import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';

// اختبار تكامل حقيقي (HTTP حقيقي + PostgreSQL حقيقي) لدعم موظف الاستقبال العامل
// في أكثر من عيادة داخل نفس المركز الطبي (clinic_staff متعدد) دون استخدام
// patient_clinic_shares بين عيادات المركز الداخلية.
//
// السيناريو الرسمي:
//   G = عيادة مالك المريض (Patient Owner Clinic) — عبر patients.clinic_id
//   D = عيادة المواجهة (Encounter Clinic) — عبر appointments.clinic_id / visits.clinic_id
//   موظف استقبال: primary = G + clinic_staff = {G, D} + صلاحيات المواعيد والزيارات
//
// ما يثبته الاختبار:
//   A) موعد في D لمريض مملوك لـ G → 201
//   B) زيارة في D لنفس المريض → 201
//   C) تحقق مباشر من PostgreSQL: مريض واحد فقط، الملكية بقيت G، الزيارة/الموعد في D
//   G) سلوك عيادة المالك يبقى عاملاً (موظف عضو في G فقط يعمل في G)
//   F) سلوك المشاركات الحالي يبقى عاملاً (WRITE لموظف خارج النطاق → يُقبل، READ فقط → مرفوض)
//   D/E/H) موظف عضو في G فقط يُرفض من D وC — لا وصول غير مصرح
//
// عزل البيانات: runId فريد لكل تشغيل (timestamp + عشوائي) لكل الأسماء، والتنظيف
// (t.after) يحذف فقط ما أنشأه هذا الاختبار (مستخدمون/إسنادات/مشاركات). العيادات
// والمرضى بلا نقاط حذف في الـ API فتُترك بأسماء فريدة تماماً لكل تشغيل.
// لا يعدّل هذا الاختبار أي شيء في production (rate limiter/auth/RBAC).

const baseUrl = process.env.INTEGRATION_BASE_URL;
const username = process.env.INTEGRATION_USERNAME;
const password = process.env.INTEGRATION_PASSWORD;
const integrationEnabled = Boolean(baseUrl && username && password);

const api = (token: string | null) => async (method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload ?? null });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const login = async (user: string, pass: string) => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  assert.equal(res.status, 200, `فشل تسجيل الدخول لـ ${user}`);
  return ((await res.json()) as { token: string }).token;
};

// اتصال مباشر بـ PostgreSQL للتحقق من الحالة الفعلية للبيانات (متطلب التحقق C)
const dbPool = (integrationEnabled && process.env.DB_HOST && process.env.DB_NAME)
  ? new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    })
  : null;

test('receptionist multi-clinic: encounter clinic inside one medical center (HTTP + PostgreSQL)', { skip: !integrationEnabled }, async (t) => {
  assert.ok(dbPool, 'متغيرات DB_* مطلوبة للتحقق المباشر من PostgreSQL');
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const tomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const testPassword = 'ReceptionTest#2026';

  // 1) المدير — لتهيئة بيانات الاختبار فقط
  const adminToken = await login(username as string, password as string);
  const admin = api(adminToken);

  // 2) عيادات المركز: G (مالك المريض) + D (عيادة مواجهة) + C (عيادة لمسار المشاركات)
  const createClinic = async (label: string) => {
    const specialties = await admin('GET', '/api/clinical/specialties') as any;
    assert.equal(specialties.status, 200);
    const specialty = specialties.data.specialties.find((s: any) => s.specialty_key === 'GENERAL_PRACTICE') ?? specialties.data.specialties[0];
    assert.ok(specialty, 'يوجد تخصص واحد على الأقل');
    const created = await admin('POST', '/api/clinics', {
      clinic_name: `عيادة اختبار موظف متعدد ${label} ${runId}`,
      specialty_id: specialty.specialty_id,
    }) as any;
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return Number(created.data.clinic.clinic_id);
  };
  const clinicG = await createClinic('G');
  const clinicD = await createClinic('D');
  const clinicC = await createClinic('C');

  const createdUserIds: number[] = [];
  const createdShareIds: number[] = [];
  const staffAssignments: Array<{ clinicId: number; userId: number }> = [];
  const createUser = async (label: string, role_name: 'RECEPTIONIST' | 'DOCTOR', clinicId: number) => {
    const res = await admin('POST', '/api/users', {
      full_name: `اختبار موظف متعدد ${label} ${runId}`,
      username: `mc_${label}_${runId}`,
      password: testPassword,
      role_name,
      clinic_id: clinicId,
    }) as any;
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const user = res.data.user as { user_id: number };
    createdUserIds.push(Number(user.user_id));
    return Number(user.user_id);
  };

  // 3) طبيب أساسي في G ومُسند إضافياً إلى D وC (أهلية الطبيب في كل العيادات)
  const doctorId = await createUser('doc', 'DOCTOR', clinicG);
  for (const cid of [clinicD, clinicC]) {
    const assign = await admin('POST', `/api/clinics/${cid}/staff`, { user_id: doctorId }) as any;
    assert.equal(assign.status, 200, JSON.stringify(assign.data));
    staffAssignments.push({ clinicId: cid, userId: doctorId });
  }

  // 4) موظف استقبال 1: أساسي G + عضو clinic_staff في D (السيناريو الرسمي)
  const receptionist1Id = await createUser('rec1', 'RECEPTIONIST', clinicG);
  const assignRec1 = await admin('POST', `/api/clinics/${clinicD}/staff`, { user_id: receptionist1Id }) as any;
  assert.equal(assignRec1.status, 200, JSON.stringify(assignRec1.data));
  staffAssignments.push({ clinicId: clinicD, userId: receptionist1Id });
  // 5) موظف استقبال 2: عضو في G فقط (لحالات الرفض + سلوك عيادة المالك)
  await createUser('rec2', 'RECEPTIONIST', clinicG);
  // 6) موظف استقبال 3: عضو في C فقط (لا عضوية G — لإثبات مسار المشاركات دون الحالة الداخلية)
  await createUser('rec3', 'RECEPTIONIST', clinicC);

  const rec1 = api(await login(`mc_rec1_${runId}`, testPassword));
  const rec2 = api(await login(`mc_rec2_${runId}`, testPassword));
  const rec3 = api(await login(`mc_rec3_${runId}`, testPassword));

  // 7) المريض يُنشأ بواسطة rec1 — الملكية = عيادته الأساسية G (Owner Clinic)
  const patientRes = await rec1('POST', '/api/patients', {
    full_name: `مريض موظف متعدد ${runId}`,
    document_type: 'OTHER',
    document_number: `MC-${runId}`,
    phone: `0790${runId}`,
    gender: 'MALE',
    date_of_birth: '1991-02-10',
  }) as any;
  assert.equal(patientRes.status, 201, JSON.stringify(patientRes.data));
  const patientId = Number(patientRes.data.patient.patient_id);
  assert.equal(Number(patientRes.data.patient.clinic_id), clinicG, 'المريض مملوك لعيادة G (Owner Clinic)');

  // مريض ثانٍ في G لسيناريو المشاركات (F)
  const patient2Res = await rec1('POST', '/api/patients', {
    full_name: `مريض مشاركات موظف متعدد ${runId}`,
    document_type: 'OTHER',
    document_number: `MC2-${runId}`,
    phone: `0791${runId}`,
    gender: 'FEMALE',
    date_of_birth: '1993-07-01',
  }) as any;
  assert.equal(patient2Res.status, 201, JSON.stringify(patient2Res.data));
  const patient2Id = Number(patient2Res.data.patient.patient_id);

  // التنظيف (يُنفَّذ دائماً حتى عند فشل الاختبار): إلغاء المشاركات، إزالة الإسنادات،
  // ثم حذف حسابات الاختبار المنشأة فقط — لا يمس أي مستخدم/عيادة/مريض حقيقي.
  t.after(async () => {
    for (const shareId of createdShareIds) {
      // يُقبل 200 أو 404 (بعض المشاركات أُلغيت خلال السيناريو)
      await admin('DELETE', `/api/patients/${patient2Id}/shares/${shareId}`);
    }
    for (const a of staffAssignments) {
      await admin('DELETE', `/api/clinics/${a.clinicId}/staff/${a.userId}`);
    }
    for (const uid of createdUserIds) {
      const del = await admin('DELETE', `/api/users/${uid}`) as any;
      assert.equal(del.status, 200, `فشل حذف حساب الاختبار #${uid}: ${JSON.stringify(del.data)}`);
    }
    await dbPool?.end();
  });

  let appointmentDId = 0;
  let visitDId = 0;

  await t.test('A) موعد في D لمريض مملوك لـ G — موظف عضو في العيادتين → 201', async () => {
    const res = await rec1('POST', '/api/appointments', {
      clinic_id: clinicD, patient_id: patientId, doctor_id: doctorId, appointment_date: tomorrow,
      reason: 'موعد مركز داخلي',
    }) as any;
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(Number(res.data.appointment.clinic_id), clinicD, 'appointments.clinic_id = D (Encounter Clinic)');
    appointmentDId = Number(res.data.appointment.appointment_id);
  });

  await t.test('B) زيارة في D لنفس المريض — موظف عضو في العيادتين → 201', async () => {
    const res = await rec1('POST', '/api/patients/visits', {
      patient_id: patientId, clinic_id: clinicD, doctor_id: doctorId, notes: 'زيارة مركز داخلي',
    }) as any;
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(Number(res.data.visit.clinic_id), clinicD, 'visits.clinic_id = D (Encounter Clinic)');
    visitDId = Number(res.data.visit.visit_id);
  });

  await t.test('C) PostgreSQL: مريض واحد فقط، الملكية بقيت G، الزيارة والموعد في D', async () => {
    assert.ok(dbPool);
    const count = await dbPool.query(
      'SELECT COUNT(*)::int AS n FROM patients WHERE document_type = $1 AND document_number = $2',
      ['OTHER', `MC-${runId}`],
    );
    assert.equal(count.rows[0].n, 1, 'لا توجد نسخة ثانية من المريض');
    const owner = await dbPool.query('SELECT clinic_id FROM patients WHERE patient_id = $1', [patientId]);
    assert.equal(Number(owner.rows[0].clinic_id), clinicG, 'patients.clinic_id بقيت G (Owner Clinic)');
    const visit = await dbPool.query('SELECT clinic_id, patient_id FROM visits WHERE visit_id = $1', [visitDId]);
    assert.equal(Number(visit.rows[0].clinic_id), clinicD, 'visits.clinic_id = D (Encounter Clinic)');
    assert.equal(Number(visit.rows[0].patient_id), patientId, 'الزيارة لنفس المريض الأصلي');
    const appt = await dbPool.query('SELECT clinic_id, patient_id FROM appointments WHERE appointment_id = $1', [appointmentDId]);
    assert.equal(Number(appt.rows[0].clinic_id), clinicD, 'appointments.clinic_id = D');
    assert.equal(Number(appt.rows[0].patient_id), patientId, 'الموعد لنفس المريض الأصلي');
  });

  await t.test('G) سلوك عيادة المالك يبقى عاملاً — موظف عضو في G فقط يعمل في G → 201', async () => {
    const appt = await rec2('POST', '/api/appointments', {
      clinic_id: clinicG, patient_id: patientId, doctor_id: doctorId, appointment_date: tomorrow,
    }) as any;
    assert.equal(appt.status, 201, JSON.stringify(appt.data));
    const visit = await rec2('POST', '/api/patients/visits', {
      patient_id: patientId, clinic_id: clinicG, doctor_id: doctorId,
    }) as any;
    assert.equal(visit.status, 201, JSON.stringify(visit.data));
  });

  await t.test('F) مسار المشاركات يبقى عاملاً: WRITE لموظف عضو في الهدف فقط → 201', async () => {
    // rec3 عضو في C فقط (لا عضوية G → الحالة الداخلية لا تنطبق) والمريض مملوك لـ G
    const share = await admin('POST', `/api/patients/${patient2Id}/shares`, {
      target_clinic_id: clinicC, access_level: 'WRITE', expires_at: tomorrowIso,
    }) as any;
    assert.equal(share.status, 201, JSON.stringify(share.data));
    createdShareIds.push(Number(share.data.share.share_id));
    const appt = await rec3('POST', '/api/appointments', {
      clinic_id: clinicC, patient_id: patient2Id, doctor_id: doctorId, appointment_date: tomorrow,
    }) as any;
    assert.equal(appt.status, 201, JSON.stringify(appt.data));
    const visit = await rec3('POST', '/api/patients/visits', {
      patient_id: patient2Id, clinic_id: clinicC, doctor_id: doctorId,
    }) as any;
    assert.equal(visit.status, 201, JSON.stringify(visit.data));
  });

  await t.test('F2) مشاركة READ فقط تبقى مرفوضة → 403', async () => {
    // ألغِ WRITE ثم أنشئ READ لنفس الهدف (المشاركة النشطة فريدة لكل (مريض، هدف)).
    // ملاحظة: رفض وصول المريض في مسار الزيارة يعيد 403 (الـ 400 مخصص لرفض أهلية الطبيب).
    const revoke = await admin('DELETE', `/api/patients/${patient2Id}/shares/${createdShareIds[0]}`) as any;
    assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
    const readShare = await admin('POST', `/api/patients/${patient2Id}/shares`, {
      target_clinic_id: clinicC, access_level: 'READ', expires_at: tomorrowIso,
    }) as any;
    assert.equal(readShare.status, 201, JSON.stringify(readShare.data));
    createdShareIds.push(Number(readShare.data.share.share_id));
    const attempt = await rec3('POST', '/api/patients/visits', {
      patient_id: patient2Id, clinic_id: clinicC, doctor_id: doctorId,
    }) as any;
    assert.equal(attempt.status, 403, JSON.stringify(attempt.data));
  });

  await t.test('D) موعد في D من موظف عضو في G فقط → مرفوض 403', async () => {
    const res = await rec2('POST', '/api/appointments', {
      clinic_id: clinicD, patient_id: patientId, doctor_id: doctorId, appointment_date: tomorrow,
    }) as any;
    assert.equal(res.status, 403, JSON.stringify(res.data));
  });

  await t.test('E) زيارة في D من موظف عضو في G فقط → مرفوضة 403', async () => {
    const res = await rec2('POST', '/api/patients/visits', {
      patient_id: patientId, clinic_id: clinicD, doctor_id: doctorId,
    }) as any;
    assert.equal(res.status, 403, JSON.stringify(res.data));
  });

  await t.test('H) لا وصول غير مصرح: موظف G فقط في عيادة C غير مسندة → مرفوض 403', async () => {
    const res = await rec2('POST', '/api/appointments', {
      clinic_id: clinicC, patient_id: patientId, doctor_id: doctorId, appointment_date: tomorrow,
    }) as any;
    assert.equal(res.status, 403, JSON.stringify(res.data));
  });
});