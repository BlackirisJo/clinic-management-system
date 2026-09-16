import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';

// اختبار تكامل شامل لنظام المركز الطبي متعدد التخصصات
// يُشغّل مقابل خادم حي: INTEGRATION_BASE_URL + INTEGRATION_USERNAME + INTEGRATION_PASSWORD
//
// عزل الاختبار (test-only، دون أي تغيير في كود الإنتاج):
// - runId فريد لكل تشغيل (timestamp + عشوائي) لكل الأسماء — يعمل فوق قاعدة بيانات
//   تحوي بيانات تشغيل حقيقية أو بقايا اختبارات سابقة دون أي تصادم.
// - الطاقم (طبيبان + طبيب "غريب" + ممرضة) يُنشأ ذاتياً بأسماء فريدة — لا افتراض
//   وجود طبيب/ممرض مسبقين ولا اعتماد على بيانات أنشأتها اختبارات أخرى.
// - التنظيف عبر t.after يحذف فقط ما أنشأه هذا الاختبار (يزيل الإسنادات ثم يحذف
//   الحسابات حذفاً ناعماً) — ولا يمس أي مستخدم/عيادة/مريض حقيقي.
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

test('medical center integration: clinic → specialty → staff → patient → visit → clinical data → pregnancy', { skip: !integrationEnabled }, async (t) => {
  // معرف فريد لكل تشغيل — يمنع تصادم الأسماء مع بيانات سابقة أو تشغيلات متوازية
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

  // 1) تسجيل الدخول كمدير
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loginRes.status, 200);
  const { token } = await loginRes.json() as { token: string };
  const call = api(token);

  // 2) قائمة التخصصات متاحة وتحتوي التخصصات الرئيسية
  const specialties = await call('GET', '/api/clinical/specialties') as any;
  assert.equal(specialties.status, 200);
  assert.ok(specialties.data.specialties.length >= 18);
  const obgyn = specialties.data.specialties.find((s: any) => s.specialty_key === 'OBSTETRICS_GYNECOLOGY');
  assert.ok(obgyn, 'النسائية والتوليد موجودة');
  assert.ok(obgyn.module.workflow.length > 0, 'workflow التخصص معرف');

  // 3أ) عيادة حاضنة فارغة: إنشاء دور تشغيلي (طبيب/ممرض) يشترط عيادة — تُنشأ حاضنة
  //     اختبار خاصة بدل الاعتماد على عيادة حقيقية أو على clinic_id الخاص بالمدير.
  const anchor = await call('POST', '/api/clinics', {
    clinic_name: `عيادة حاضنة اختبار ${runId}`,
    specialty_id: obgyn.specialty_id,
  }) as any;
  assert.equal(anchor.status, 201, JSON.stringify(anchor.data));
  const anchorClinicId = Number(anchor.data.clinic.clinic_id);

  // 3ب) إنشاء طاقم الاختبار ذاتياً — لا افتراض وجود طبيب/ممرض نشطين في قاعدة البيانات
  const createdUserIds: number[] = [];
  let clinicId = 0;
  // التنظيف (يُنفَّذ دائماً حتى عند فشل الاختبار): إزالة إسنادات عيادة الاختبار ثم
  // حذف حسابات الاختبار المنشأة فقط — لا يمس أي مستخدم حقيقي. الخطوة الأخيرة في
  // الاختبار تُسجّل الخروج عمداً، لذا تُنشأ جلسة تنظيف بديلة عند الحاجة.
  t.after(async () => {
    if (!createdUserIds.length) return;
    let cleanupToken = token;
    const probe = await call('GET', '/api/auth/me');
    if (probe.status !== 200) {
      const relogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(relogin.status, 200, 'فشل إنشاء جلسة التنظيف');
      cleanupToken = ((await relogin.json()) as { token: string }).token;
    }
    const cleanupCall = api(cleanupToken);
    if (clinicId) {
      for (const userId of createdUserIds) {
        // يُقبل 200 أو 404 (الممرض أُزيل أصلاً في خطوة سابقة / لم يُسند إطلاقاً)
        await cleanupCall('DELETE', `/api/clinics/${clinicId}/staff/${userId}`);
      }
    }
    for (const userId of createdUserIds) {
      const del = await cleanupCall('DELETE', `/api/users/${userId}`) as any;
      assert.equal(del.status, 200, `فشل حذف حساب الاختبار #${userId}: ${JSON.stringify(del.data)}`);
    }
    await cleanupCall('POST', '/api/auth/logout');
  });
  const createStaffUser = async (label: string, role_name: 'DOCTOR' | 'NURSE') => {
    const res = await call('POST', '/api/users', {
      full_name: `اختبار تكامل ${label} ${runId}`,
      username: `clin_${label}_${runId}`,
      password: 'IntegrationTest#2026',
      role_name,
      clinic_id: anchorClinicId,
    }) as any;
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const user = res.data.user as { user_id: number; status: string };
    createdUserIds.push(Number(user.user_id));
    assert.equal(user.status, 'ACTIVE', `حساب الاختبار ${label} نشط عند الإنشاء`);
    return user;
  };
  const doctor = await createStaffUser('doc_a', 'DOCTOR');
  const nurse = await createStaffUser('nurse_a', 'NURSE');
  const secondDoctor = await createStaffUser('doc_b', 'DOCTOR');
  const foreignDoctor = await createStaffUser('doc_c', 'DOCTOR');

  // 3ج) إنشاء عيادة الاختبار بتخصصها وإسناد الطاقم إليها عند الإنشاء
  const created = await call('POST', '/api/clinics', {
    clinic_name: `عيادة تجريبية متكاملة ${runId}`,
    specialty_id: obgyn.specialty_id,
    doctor_ids: [doctor.user_id],
    nurse_ids: [nurse.user_id],
  }) as any;
  assert.equal(created.status, 201, JSON.stringify(created.data));
  clinicId = Number(created.data.clinic.clinic_id);

  // 4) تفاصيل العيادة تعيد التخصص والطاقم المقسم حسب الدور
  const detail = await call('GET', `/api/clinics/${clinicId}`) as any;
  assert.equal(detail.status, 200);
  assert.equal(detail.data.clinic.clinic_id, clinicId);
  assert.ok(detail.data.clinic.specialty_id, 'العيادة مرتبطة بتخصص');
  assert.ok(detail.data.doctors.some((d: any) => d.user_id === doctor.user_id), 'الطبيب مسند');
  assert.ok(detail.data.nurses.some((n: any) => n.user_id === nurse.user_id), 'الممرض مسند');

  // 5) إسناد طبيب ثانٍ أنشأناه — نفس الحساب يعمل في أكثر من عيادة (الأساسية + الإسناد الإضافي)
  const assign = await call('POST', `/api/clinics/${clinicId}/staff`, { user_id: secondDoctor.user_id }) as any;
  assert.equal(assign.status, 200, JSON.stringify(assign.data));
  const stillThere = await call('GET', `/api/users?role=DOCTOR&search=${encodeURIComponent(runId)}&limit=100`) as any;
  assert.equal(stillThere.status, 200);
  assert.ok(stillThere.data.users.some((u: any) => u.user_id === secondDoctor.user_id), 'المستخدم ما زال في النظام');
  // إعادة جلب تفاصيل العيادة بعد الإسناد الإضافي — حتى تكون "قائمة الفريق" حديثة
  // (كان الجلب السابق قبل إسناد الطبيب الثاني فيختار الاختبار طبيباً أصبح مسنداً فعلاً).
  const freshDetail = await call('GET', `/api/clinics/${clinicId}`) as any;
  const staffAfterAssignments = freshDetail.data?.staff ?? [...(freshDetail.data?.doctors ?? []), ...(freshDetail.data?.nurses ?? [])];

  // 6) رفض إسناد ممرض في قائمة الأطباء (تحقق الدور)
  const wrongRole = await call('POST', '/api/clinics', {
    clinic_name: `عيادة خاطئة ${runId}`, specialty_id: obgyn.specialty_id, doctor_ids: [nurse.user_id],
  }) as any;
  assert.equal(wrongRole.status, 400, 'إسناد ممرض كطبيب مرفوض');

  // 7) إنشاء مريضة في العيادة الجديدة (المدير يحدد العيادة)
  const patientRes = await call('POST', '/api/patients', {
    full_name: `مريضة تجريبية ${runId}`,
    document_type: 'OTHER',
    document_number: `TC-${runId}`,
    phone: `0790${runId}`,
    gender: 'FEMALE',
    date_of_birth: '1995-04-12',
    clinic_id: clinicId,
  }) as any;
  assert.equal(patientRes.status, 201, JSON.stringify(patientRes.data));
  const patientId = patientRes.data.patient.patient_id as number;

  // 8) تسجيل زيارة في العيادة الجديدة على الطبيب المسند
  const visitRes = await call('POST', '/api/patients/visits', {
    patient_id: patientId, clinic_id: clinicId, doctor_id: doctor.user_id, notes: 'زيارة أولى تجريبية',
  }) as any;
  assert.equal(visitRes.status, 201, JSON.stringify(visitRes.data));
  const visitId = visitRes.data.visit.visit_id as number;

  // 9) رفض طبيب غير مسند للعيادة — طبيب الاختبار "الغريب" (أنشأناه ولم يُسند لهذه العيادة إطلاقاً)
  assert.ok(!staffAfterAssignments.some((s: any) => Number(s.user_id) === Number(foreignDoctor.user_id)), 'الطبيب الغريب غير مسند لعيادة الاختبار');
  const badVisit = await call('POST', '/api/patients/visits', {
    patient_id: patientId, clinic_id: clinicId, doctor_id: foreignDoctor.user_id,
  }) as any;
  assert.equal(badVisit.status, 400, 'زيارة بطبيب غير مسند مرفوضة');

  // 10) البيانات السريرية: شكوى/فحص/تقييم/خطة
  const clinical = await call('PATCH', `/api/clinical/visits/${visitId}`, {
    chief_complaint: 'ألم بالصدر وضيق بالنفس',
    clinical_examination: 'القلب: نظم منتظم، لا لغط',
    assessment: 'خطر قلبي متوسط',
    treatment_plan: 'راحة + أسبرين + إحالة قلب',
    follow_up_plan: 'مراجعة بعد أسبوع',
    visit_status: 'COMPLETED',
  }) as any;
  assert.equal(clinical.status, 200, JSON.stringify(clinical.data));

  // 11) العلامات الحيوية (قياسان في نفس الزيارة)
  const vitals1 = await call('POST', `/api/clinical/visits/${visitId}/vitals`, {
    weight_kg: 72.5, height_cm: 165, systolic: 135, diastolic: 85, pulse: 88, temperature: 37.2, spo2: 97,
  }) as any;
  assert.equal(vitals1.status, 201, JSON.stringify(vitals1.data));
  const vitals2 = await call('POST', `/api/clinical/visits/${visitId}/vitals`, { systolic: 130, diastolic: 80 }) as any;
  assert.equal(vitals2.status, 201);
  // ضغط منعكس (انقباضي أقل من الانبساطي) مرفوض من قيد قاعدة البيانات
  const badVitals = await call('POST', `/api/clinical/visits/${visitId}/vitals`, { systolic: 60, diastolic: 120 }) as any;
  assert.ok(badVitals.status >= 400, 'قياس ضغط منعكس مرفوض');

  // 12) التشخيص
  const diagnosis = await call('POST', `/api/clinical/visits/${visitId}/diagnoses`, { description: 'ارتفاع ضغط شرياني', diagnosis_type: 'PRIMARY' }) as any;
  assert.equal(diagnosis.status, 201);

  // 13) المختبر: طلب CBC + إدخال النتائج
  const labOrder = await call('POST', `/api/clinical/visits/${visitId}/lab-orders`, { test_name: 'CBC', category: 'CBC', priority: 'ROUTINE' }) as any;
  assert.equal(labOrder.status, 201);
  const orderId = labOrder.data.order.order_id as number;
  const labResults = await call('PUT', `/api/clinical/visits/${visitId}/lab-orders/${orderId}/results`, {
    results: [
      { analyte: 'Hemoglobin', result_value: '11.2', unit: 'g/dL', reference_range: '12-16', is_abnormal: true },
      { analyte: 'WBC', result_value: '7.5', unit: '10^9/L', reference_range: '4-11' },
    ],
  }) as any;
  assert.equal(labResults.status, 200, JSON.stringify(labResults.data));
  assert.equal(labResults.data.results.length, 2);

  // 14) تصوير ECG
  const imaging = await call('POST', `/api/clinical/visits/${visitId}/imaging`, { modality: 'ECG', findings: 'نظم جيبي طبيعي', status: 'COMPLETED' }) as any;
  assert.equal(imaging.status, 201);

  // 15) إحالة لتخصص آخر
  const referral = await call('POST', `/api/clinical/visits/${visitId}/referrals`, { reason: 'متابعة تخصصية', to_specialty_id: obgyn.specialty_id }) as any;
  assert.equal(referral.status, 201);

  // 16) تفاصيل الزيارة تعيد كل شيء
  const visitDetails = await call('GET', `/api/clinical/visits/${visitId}`) as any;
  assert.equal(visitDetails.status, 200);
  assert.equal(visitDetails.data.vitals.length, 2);
  assert.equal(visitDetails.data.diagnoses.length, 1);
  assert.equal(visitDetails.data.lab_orders.length, 1);
  assert.equal(visitDetails.data.lab_orders[0].results.length, 2);
  assert.equal(visitDetails.data.imaging.length, 1);
  assert.equal(visitDetails.data.referrals.length, 1);

  // 17) سجل الحمل: إنشاء (EDD تلقائي = LMP + 280 يوماً)
  const pregnancy = await call('POST', '/api/clinical/pregnancies', {
    patient_id: patientId, clinic_id: clinicId,
    lmp_date: '2026-01-01', gravida: 2, para: 1, abortions: 0,
    blood_group: 'O+', rh_factor: 'POSITIVE',
    previous_pregnancies: '2024 ولادة طبيعية سليمة',
    risk_level: 'NORMAL',
  }) as any;
  assert.equal(pregnancy.status, 201, JSON.stringify(pregnancy.data));
  const pregnancyId = pregnancy.data.pregnancy.pregnancy_id as number;
  assert.equal(pregnancy.data.pregnancy.edd_date, '2026-10-08', 'EDD محسوب تلقائياً');

  // منع حمل نشط ثانٍ لنفس المريضة
  const dup = await call('POST', '/api/clinical/pregnancies', {
    patient_id: patientId, clinic_id: clinicId, lmp_date: '2026-02-01',
  }) as any;
  assert.equal(dup.status, 409, 'حمل نشط ثانٍ مرفوض');

  // 18) زيارات متابعة حمل (الثانية مرتبطة بالزيارة) مع قياسات مستقلة لكل زيارة
  const pv1 = await call('POST', `/api/clinical/pregnancies/${pregnancyId}/visits`, {
    visit_id: visitId, ga_weeks: 8, ga_days: 3,
    weight_kg: 72.5, systolic: 118, diastolic: 76, pulse: 80, temperature: 36.8,
    fetal_heart_rate: 165,
    symptoms: 'غثيان صباحي', diagnosis: 'حمل سليم', treatment_plan: 'حمض فوليك + راحة',
    supplements: 'Folic acid 5mg', next_visit_date: '2026-04-01', risk_level: 'NORMAL',
  }) as any;
  assert.equal(pv1.status, 201, JSON.stringify(pv1.data));
  const pv2 = await call('POST', `/api/clinical/pregnancies/${pregnancyId}/visits`, {
    ga_weeks: 12, ga_days: 0, weight_kg: 73.8, systolic: 122, diastolic: 79,
    fetal_heart_rate: 158, symptoms: 'تحسن الغثيان', risk_level: 'NORMAL',
  }) as any;
  assert.equal(pv2.status, 201);

  // 19) سونار بقياسات جنينية مرتبط بالزيارة والحمل
  const us = await call('POST', `/api/clinical/pregnancies/${pregnancyId}/ultrasounds`, {
    visit_id: visitId, ga_weeks: 12, ga_days: 0, fetus_count: 1,
    bpd_cm: 2.1, hc_cm: 7.1, ac_cm: 6.2, fl_cm: 1.1, efw_g: 58,
    amniotic_fluid_index: 12.5, placenta_position: 'خلفي علوي',
    impression: 'حمل حي مفرد بالنسب الطبيعية',
  }) as any;
  assert.equal(us.status, 201, JSON.stringify(us.data));

  // 20) الخط الزمني: زارتان + سونار مرتبطان بالحمل الصحيح
  const timeline = await call('GET', `/api/clinical/pregnancies/${pregnancyId}`) as any;
  assert.equal(timeline.status, 200);
  assert.equal(timeline.data.pregnancy_visits.length, 2);
  assert.equal(timeline.data.ultrasounds.length, 1);
  assert.equal(timeline.data.ultrasounds[0].visit_id, visitId, 'السونار مربوط بالزيارة');
  assert.ok(timeline.data.pregnancy_visits[0].ga_weeks === 8, 'الترتيب الزمني صاعد');
  assert.ok(timeline.data.pregnancy.current_gestational_age, 'العمر الحملي الحالي محسوب');

  // 21) تعديل زيارة متابعة
  const pvUpdate = await call('PATCH', `/api/clinical/pregnancies/${pregnancyId}/visits/${pv1.data.pregnancy_visit.pv_id}`, {
    diagnosis: 'حمل سليم — غثيان خفيف',
  }) as any;
  assert.equal(pvUpdate.status, 200);

  // 22) رفع صورة سونار كمرفق مرتبط بالحمل والزيارة ثم تنزيلها
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngBuffer = Buffer.from(pngBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pngBuffer)], { type: 'image/png' }), 'ultrasound.png');
  form.append('kind', 'ULTRASOUND');
  form.append('pregnancy_id', String(pregnancyId));
  const attachRes = await fetch(`${baseUrl}/api/clinical/visits/${visitId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(attachRes.status, 201, await attachRes.clone().text());
  const attachment = await attachRes.json() as any;
  const attachmentId = attachment.attachment.attachment_id as number;
  const download = await fetch(`${baseUrl}/api/clinical/attachments/${attachmentId}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(download.status, 200);
  const timelineAfterAttach = await call('GET', `/api/clinical/pregnancies/${pregnancyId}`) as any;
  assert.equal(timelineAfterAttach.data.attachments.length, 1, 'المرفق مرئي في تفاصيل الحمل');

  // 23) إزالة الممرض من العيادة — حسابه يبقى في النظام دون حذف
  const remove = await call('DELETE', `/api/clinics/${clinicId}/staff/${nurse.user_id}`) as any;
  assert.equal(remove.status, 200);
  const userStill = await call('GET', `/api/users?role=NURSE&search=${encodeURIComponent(runId)}&limit=100`) as any;
  assert.equal(userStill.status, 200);
  assert.ok(userStill.data.users.some((u: any) => u.user_id === nurse.user_id), 'حساب الممرض لم يُحذف');

  // 24) الوظائف القديمة تعمل: العيادات والمرضى والتقارير والمواعيد
  const clinicsList = await call('GET', '/api/clinics') as any;
  assert.equal(clinicsList.status, 200);
  assert.ok(clinicsList.data.clinics.some((c: any) => c.clinic_id === clinicId && c.specialty_name), 'قائمة العيادات تعرض التخصص');
  const patientsList = await call('GET', '/api/patients?limit=5') as any;
  assert.equal(patientsList.status, 200);
  const reports = await call('GET', '/api/reports/overview') as any;
  assert.equal(reports.status, 200);
  const appointments = await call('GET', '/api/appointments?limit=5') as any;
  assert.equal(appointments.status, 200);

  // 25) الصلاحيات: الجلسة الملغاة تُمنع من الوصول
  await call('POST', '/api/auth/logout');
  const afterLogout = await call('GET', `/api/clinical/visits/${visitId}`) as any;
  assert.equal(afterLogout.status, 403, 'الجلسة الملغاة ممنوعة');
});