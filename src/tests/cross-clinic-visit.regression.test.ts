import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';

// اختبار تكامل انحداري (Regression) لسيناريو الزيارة عبر العيادات — HTTP فقط.
//
// يعيد استخدام البنية القائمة حرفياً كما في src/tests/clinical.integration.test.ts:
//   node:test + fetch + INTEGRATION_BASE_URL / INTEGRATION_USERNAME / INTEGRATION_PASSWORD
//   ونفس شكل مساعد الطلبات (api) ونفس نمط إنشاء البيانات (عيادات/أطباء/مرضى/مشاركات).
//
// المسار الحقيقي المُختبَر:
//   تسجيل دخول → JWT → وسيط الصلاحيات (CREATE_VISIT) → POST /api/patients/visits
//   → المتحكم createVisit الحقيقي → PostgreSQL حقيقي → INSERT حقيقي في visits.
//
// ملاحظة (هامة): هذا الاختبار HTTP فقط، ولا يثبت غياب قيد visits_patient_clinic_fk
// في قاعدة البيانات — ذلك تُحقّقه مراجعة migration 021 على مستوى المخطط، وهو خارج
// نطاق بنية الاختبار التكاملي القائمة (HTTP) عمداً وبدون أي بنية استقصاء جديدة.
//
// عزل بيانات الاختبار (test-only، دون أي تغيير في كود الإنتاج):
// - runId فريد لكل تشغيل (timestamp + عشوائي) لكل الأسماء — يعمل فوق قاعدة بيانات
//   تحوي بيانات تشغيل حقيقية أو بقايا اختبارات سابقة دون أي تصادم أسماء (409).
// - الأطباء (A + B المشترك + طبيب مُعطَّل) يُنشَؤون ذاتياً بأسماء فريدة عبر "عيادة
//   حاضنة" لأن إنشاء دور تشغيلي يشترط عيادة — لا افتراض وجود أطباء مسبقين، ولا
//   اعتماد على بيانات أنشأها clinical.integration.test أو أي اختبار آخر، ولا على
//   ترتيب تنفيذ ملفات الاختبار.
// - التنظيف عبر t.after يحذف فقط ما أنشأه هذا الاختبار: يلغي المشاركة المتبقية،
//   يزيل الإسنادات، ثم يحذف حسابات الأطباء المنشأة (حذفاً ناعماً). العيادات والمرضى
//   بلا نقاط حذف في الـ API فتُترك بأسماء فريدة تماماً لكل تشغيل.

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY_MS = 24 * 60 * 60 * 1000;

test('cross-clinic visit regression: WRITE share → visit persisted in target clinic', { skip: !integrationEnabled }, async (t) => {
  // 1) تسجيل دخول حقيقي (JWT/جلسة حقيقية)
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loginRes.status, 200);
  const { token } = await loginRes.json() as { token: string };
  const call = api(token);

  // معرف فريد لكل تشغيل — يمنع تصادم الأسماء مع بيانات سابقة أو تشغيلات متوازية
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

  // 2) تجهيز: تخصص موجود
  const specialties = await call('GET', '/api/clinical/specialties') as any;
  assert.equal(specialties.status, 200);
  const specialty = specialties.data.specialties.find((s: any) => s.specialty_key === 'GENERAL_PRACTICE') ?? specialties.data.specialties[0];
  assert.ok(specialty, 'يوجد تخصص واحد على الأقل');

  // 3) إنشاء العيادات: A (المالكة) + B (هدف السيناريو الإيجابي)
  //    + C/D/E (أهداف سيناريوهات الرفض — عيادة مستهدفة منفصلة لكل حالة
  //    لأن المشاركة النشطة فريدة لكل (مريض، عيادة مستهدفة)).
  //    نفس الطبيب قد يُسند لأكثر من عيادة — وهذا مسموح بالتصميم (clinic_staff):
  //    الطبيب B يُسند لعيادات B/C/D/E جميعاً، لأن السيناريوهات الإيجابية وسيناريوهات
  //    رفض المشاركة تختبر حالة المشاركة نفسها وليس أهلية الطبيب.
  const createdUserIds: number[] = [];
  const createdClinicIds: number[] = [];
  let clinicA = 0;
  let patientId = 0;
  let readShareId = 0;

  // أ) عيادة A تُنشأ أولاً فارغة — حاضنة حسابات أطباء الاختبار (إنشاء دور تشغيلي
  //    يشترط عيادة) ومالكة المريض في السيناريو.
  const createdA = await call('POST', '/api/clinics', {
    clinic_name: `عيادة اختبار انحداري المصدر ${runId}-A`,
    specialty_id: specialty.specialty_id,
  }) as any;
  assert.equal(createdA.status, 201, JSON.stringify(createdA.data));
  clinicA = Number(createdA.data.clinic.clinic_id);
  createdClinicIds.push(clinicA);

  // ب) أطباء الاختبار يُنشَؤون ذاتياً بأسماء فريدة — لا اعتماد على أطباء موجودين
  const createDoctor = async (label: string) => {
    const res = await call('POST', '/api/users', {
      full_name: `طبيب اختبار انحداري ${label} ${runId}`,
      username: `ccv_${label}_${runId}`,
      password: 'IntegrationTest#2026',
      role_name: 'DOCTOR',
      clinic_id: clinicA,
    }) as any;
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const user = res.data.user as { user_id: number; status: string };
    createdUserIds.push(Number(user.user_id));
    assert.equal(user.status, 'ACTIVE', `طبيب الاختبار ${label} نشط عند الإنشاء`);
    return Number(user.user_id);
  };
  const doctorAId = await createDoctor('a');
  const doctorBId = await createDoctor('b');
  // ج) طبيب ثالث يُعطَّل عمداً — لحالة الرفض "طبيب غير نشط"
  const doctorInactiveId = await createDoctor('x');
  const suspend = await call('PATCH', `/api/users/${doctorInactiveId}`, { status: 'SUSPENDED' }) as any;
  assert.equal(suspend.status, 200, JSON.stringify(suspend.data));

  // التنظيف (يُنفَّذ دائماً حتى عند فشل الاختبار): إلغاء المشاركة المتبقية، إزالة
  // إسنادات العيادات المنشأة، ثم حذف حسابات أطباء الاختبار المنشأة فقط — لا يمس
  // أي مستخدم/عيادة/مريض حقيقي.
  t.after(async () => {
    if (!createdUserIds.length) return;
    if (readShareId && patientId) {
      // يُقبل 200 أو 404 (المشاركة قد تكون أُلغيت/انتهت خلال السيناريو)
      await call('DELETE', `/api/patients/${patientId}/shares/${readShareId}`);
    }
    for (const cid of createdClinicIds) {
      for (const uid of createdUserIds) {
        // يُقبل 200 أو 404 (الطبيب A يملكه عيادة A أساسية بلا صف clinic_staff)
        await call('DELETE', `/api/clinics/${cid}/staff/${uid}`);
      }
    }
    for (const uid of createdUserIds) {
      const del = await call('DELETE', `/api/users/${uid}`) as any;
      assert.equal(del.status, 200, `فشل حذف حساب الاختبار #${uid}: ${JSON.stringify(del.data)}`);
    }
  });

  const createClinic = async (label: string, key: string, doctorId: number) => {
    const created = await call('POST', '/api/clinics', {
      clinic_name: `عيادة اختبار انحداري ${label} ${runId}-${key}`,
      specialty_id: specialty.specialty_id,
      doctor_ids: [doctorId],
    }) as any;
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const cid = Number(created.data.clinic.clinic_id);
    createdClinicIds.push(cid);
    return cid;
  };

  const clinicB = await createClinic('الهدف', 'B', doctorBId);
  const clinicC = await createClinic('قراءة', 'C', doctorBId);
  const clinicD = await createClinic('منتهية', 'D', doctorBId);
  const clinicE = await createClinic('ملغاة', 'E', doctorBId);

  // C) الطبيب النشط تابع لعيادة B (إسناد حقيقي عبر clinic_staff + مستخدم نشط)
  const detailB = await call('GET', `/api/clinics/${clinicB}`) as any;
  assert.equal(detailB.status, 200);
  assert.ok((detailB.data.doctors as any[]).some((d: any) => Number(d.user_id) === Number(doctorBId)), 'C) الطبيب مسند لعيادة B');

  // 4) المريض P1 يُنشأ في عيادة A — إثبات (A): المريض مملوك لعيادة A
  const patientRes = await call('POST', '/api/patients', {
    full_name: `مريض انحداري مشترك ${runId}`,
    document_type: 'OTHER',
    document_number: `REG-${runId}`,
    phone: `0790${runId}`,
    gender: 'MALE',
    date_of_birth: '1990-06-15',
    clinic_id: clinicA,
  }) as any;
  assert.equal(patientRes.status, 201, JSON.stringify(patientRes.data));
  patientId = Number(patientRes.data.patient.patient_id);
  assert.equal(Number(patientRes.data.patient.clinic_id), clinicA, 'A) المريض مملوك لعيادة A');

  const ownerList = await call('GET', `/api/patients?search=${encodeURIComponent(`مريض انحداري مشترك ${runId}`)}&limit=50`) as any;
  assert.equal(ownerList.status, 200);
  const ownerRow = (ownerList.data.patients as any[]).find((p: any) => Number(p.patient_id) === patientId);
  assert.ok(ownerRow, 'المريض يظهر في قائمة المرضى');
  assert.equal(Number(ownerRow.clinic_id), clinicA, 'A) قراءة عائدة: ملكية المريض لعيادة A');

  // 5) إثبات (B): مشاركة WRITE نشطة من عيادة A (المالكة) إلى عيادة B
  const tomorrow = new Date(Date.now() + DAY_MS).toISOString();
  const shareRes = await call('POST', `/api/patients/${patientId}/shares`, {
    target_clinic_id: clinicB,
    access_level: 'WRITE',
    expires_at: tomorrow,
  }) as any;
  assert.equal(shareRes.status, 201, JSON.stringify(shareRes.data));
  const writeShare = shareRes.data.share;
  assert.equal(Number(writeShare.target_clinic_id), clinicB, 'B) العيادة المستهدفة هي B');
  assert.equal(writeShare.access_level, 'WRITE', 'B) مستوى الوصول WRITE');
  assert.equal(writeShare.status, 'ACTIVE', 'B) المشاركة نشطة');

  const sharesList = await call('GET', `/api/patients/${patientId}/shares`) as any;
  assert.equal(sharesList.status, 200);
  assert.ok(
    (sharesList.data.shares as any[]).some((s: any) =>
      Number(s.share_id) === Number(writeShare.share_id)
      && s.access_level === 'WRITE' && s.status === 'ACTIVE'
      && Number(s.target_clinic_id) === clinicB),
    'B) قراءة عائدة: مشاركة WRITE نشطة لعيادة B',
  );

  // 6) إثبات (D): المستخدم الموثق يعمل ضمن سياق عيادة B ويملك CREATE_VISIT.
  //    وسيط الصلاحيات الحقيقي (requirePermission('CREATE_VISIT')) يُنفَّذ على كل نداء،
  //    وبقية الإثبات هو نجاح POST الزيارة في عيادة B أدناه (201).
  assert.equal(detailB.status, 200, 'D) المستخدم قادر على العمل في سياق عيادة B');

  // 7) إثبات (E) و(F): POST /api/patients/visits بعيادة B وطبيب B — يجب أن ينجح
  const visitRes = await call('POST', '/api/patients/visits', {
    patient_id: patientId,
    clinic_id: clinicB,
    doctor_id: doctorBId,
    notes: 'زيارة عبر العيادات — مشاركة WRITE نشطة',
  }) as any;
  assert.equal(visitRes.status, 201, JSON.stringify(visitRes.data));
  const visit = visitRes.data.visit;
  assert.equal(Number(visit.patient_id), patientId, 'F) patient_id = المريض');
  assert.equal(Number(visit.clinic_id), clinicB, 'F) clinic_id = عيادة B');
  assert.equal(Number(visit.doctor_id), Number(doctorBId), 'F) doctor_id = طبيب B');
  const visitId = Number(visit.visit_id);

  // 8) قراءة عائدة: الزيارة محفوظة فعلياً في PostgreSQL بعيادة B
  const visitsBack = await call('GET', `/api/patients/${patientId}/visits`) as any;
  assert.equal(visitsBack.status, 200);
  const persisted = (visitsBack.data.visits as any[]).find((v: any) => Number(v.visit_id) === visitId);
  assert.ok(persisted, 'الزيارة مُثبتة في قاعدة البيانات');
  assert.equal(Number(persisted.clinic_id), clinicB, 'F) الزيارة المحفوظة تخص عيادة B');

  // 9) إثبات (G) و(H): ملكية المريض بقيت لعيادة A، والزيارة محفوظة بعيادة B
  //    → أي أن visits.clinic_id != patients.clinic_id يُحفَظ بنجاح.
  const ownerListAfter = await call('GET', `/api/patients?search=${encodeURIComponent(`مريض انحداري مشترك ${runId}`)}&limit=50`) as any;
  assert.equal(ownerListAfter.status, 200);
  const ownerRowAfter = (ownerListAfter.data.patients as any[]).find((p: any) => Number(p.patient_id) === patientId);
  assert.ok(ownerRowAfter, 'المريض ما زال موجوداً');
  assert.equal(Number(ownerRowAfter.clinic_id), clinicA, 'G) عيادة مالك المريض بقيت A');
  assert.notEqual(Number(persisted.clinic_id), Number(ownerRowAfter.clinic_id), 'H) visits.clinic_id != patients.clinic_id محفوظ بنجاح');

  // ==================== سيناريوهات الرفض ====================
  // مريض ثانٍ في عيادة A بدون أي مشاركات مبدئياً
  const patient2Res = await call('POST', '/api/patients', {
    full_name: `مريض انحداري رفض ${runId}`,
    document_type: 'OTHER',
    document_number: `REG2-${runId}`,
    phone: `0791${runId}`,
    gender: 'FEMALE',
    date_of_birth: '1992-03-20',
    clinic_id: clinicA,
  }) as any;
  assert.equal(patient2Res.status, 201, JSON.stringify(patient2Res.data));
  const patient2Id = Number(patient2Res.data.patient.patient_id);
  assert.equal(Number(patient2Res.data.patient.clinic_id), clinicA, 'المريض الثاني مملوك لعيادة A');

  // N1) بدون أي مشاركة → رفض
  const noShare = await call('POST', '/api/patients/visits', {
    patient_id: patient2Id, clinic_id: clinicB, doctor_id: doctorBId,
  }) as any;
  assert.equal(noShare.status, 403, 'N1) بدون مشاركة: مرفوض');

  // N2) مشاركة READ فقط → رفض (العيادة المستهدفة C)
  const readShare = await call('POST', `/api/patients/${patient2Id}/shares`, {
    target_clinic_id: clinicC, access_level: 'READ', expires_at: tomorrow,
  }) as any;
  assert.equal(readShare.status, 201, JSON.stringify(readShare.data));
  readShareId = Number(readShare.data.share.share_id);
  const readAttempt = await call('POST', '/api/patients/visits', {
    patient_id: patient2Id, clinic_id: clinicC, doctor_id: doctorBId,
  }) as any;
  assert.equal(readAttempt.status, 403, 'N2) مشاركة READ فقط: مرفوضة');

  // N3) مشاركة WRITE منتهية الصلاحية → رفض (العيادة المستهدفة D).
  //     إنشاء مشاركة منتهية عبر POST غير ممكن مباشرة (الخادم يرفض تاريخاً منتهياً
  //     عند الإنشاء)، لذا تُنشأ مشاركة صلاحيتها ثانيتان ثم يُنتظر 4 ثوانٍ بهامش
  //     أمان لفارق الساعات قبل محاولة الزيارة — الحكم النهائي بـ NOW() في قاعدة البيانات.
  const expShare = await call('POST', `/api/patients/${patient2Id}/shares`, {
    target_clinic_id: clinicD, access_level: 'WRITE', expires_at: new Date(Date.now() + 2000).toISOString(),
  }) as any;
  assert.equal(expShare.status, 201, JSON.stringify(expShare.data));
  await wait(4000);
  const expiredAttempt = await call('POST', '/api/patients/visits', {
    patient_id: patient2Id, clinic_id: clinicD, doctor_id: doctorBId,
  }) as any;
  assert.equal(expiredAttempt.status, 403, 'N3) مشاركة WRITE منتهية: مرفوضة');

  // N4) مشاركة WRITE ملغاة → رفض (العيادة المستهدفة E)
  const revShare = await call('POST', `/api/patients/${patient2Id}/shares`, {
    target_clinic_id: clinicE, access_level: 'WRITE', expires_at: tomorrow,
  }) as any;
  assert.equal(revShare.status, 201, JSON.stringify(revShare.data));
  const preRevoke = await call('POST', '/api/patients/visits', {
    patient_id: patient2Id, clinic_id: clinicE, doctor_id: doctorBId,
  }) as any;
  assert.equal(preRevoke.status, 201, 'N4) قبل الإلغاء: الزيارة مسموحة (المشاركة فعالة)');
  const revokeRes = await call('DELETE', `/api/patients/${patient2Id}/shares/${revShare.data.share.share_id}`) as any;
  assert.equal(revokeRes.status, 200, JSON.stringify(revokeRes.data));
  const revokedAttempt = await call('POST', '/api/patients/visits', {
    patient_id: patient2Id, clinic_id: clinicE, doctor_id: doctorBId,
  }) as any;
  assert.equal(revokedAttempt.status, 403, 'N4) مشاركة WRITE ملغاة: مرفوضة');

  // N5) طبيب من عيادة أخرى (غير مسند لعيادة B) → مرفوض رغم مشاركة WRITE النشطة
  const wrongClinicDoctor = await call('POST', '/api/patients/visits', {
    patient_id: patientId, clinic_id: clinicB, doctor_id: doctorAId,
  }) as any;
  assert.equal(wrongClinicDoctor.status, 400, 'N5) طبيب غير مسند لعيادة B: مرفوض');

  // N6) طبيب غير نشط (SUSPENDED) → مرفوض رغم مشاركة WRITE النشطة
  const inactiveDoctorAttempt = await call('POST', '/api/patients/visits', {
    patient_id: patientId, clinic_id: clinicB, doctor_id: doctorInactiveId,
  }) as any;
  assert.equal(inactiveDoctorAttempt.status, 400, 'N6) طبيب غير نشط: مرفوض');
});
