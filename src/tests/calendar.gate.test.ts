import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * T2/T9 — جدول حالات بوابة التقويم (Gate).
 *
 * مصدر الحقيقة دالة PostgreSQL calendar_gate (ترحيل 059) — وهي نفسها التي
 * يقرأها الـtrigger وتستدعيها الواجهة، فلا يمكن أن تختلف القواعد.
 *
 * ترتيب الأولوية (المثبت هنا لكل حالة):
 *   إجازة معتمدة  >  عطلة رسمية  >  استثناء عمل معتمد  >  جدول الأسبوع
 * وكل حالة تُفحص على مستويين: نتيجة البوابة، وقبول/رفض إدراج الموعد فعلياً.
 */

import {
  withTransaction,
  createFixtures,
  futureDate,
  readGate,
  tryInsertAppointment,
} from './helpers/calendarFixtures';

test('البوابة: لا عطل ولا إجازة ⇒ الحجز مقبول', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-open');
    const date = futureDate(30);

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, false, 'اليوم العادي يجب ألا يكون مغلقاً');
    assert.equal(gate.code, null);

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true, 'الموعد يجب أن يُقبل');
  });
});

test('البوابة: عطلة رسمية للعيادة تغلق اليوم', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-holiday');
    const date = futureDate(31);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة اختبار', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, true, 'عطلة العيادة يجب أن تغلق اليوم');
    assert.equal(gate.code, 'HOLIDAY');

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, false, 'الحجز في يوم عطلة يجب أن يُرفض');
    assert.equal(inserted.code, 'CL001', 'رمز الرفض المتوقع من مُشغّل البوابة');
  });
});

test('البوابة: عطلة وطنية (clinic_id IS NULL) تغلق كل العيادات', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-national');
    const other = await createFixtures(client, 'gate-national-other');
    const date = futureDate(32);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, NULL, 'عطلة وطنية اختبار', 'OFFICIAL', 'ACTIVE')`,
      [date]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, true);
    assert.equal(gate.code, 'HOLIDAY');

    const otherGate = await readGate(client, other.clinicId, other.doctorId, date);
    assert.equal(otherGate.is_blocked, true, 'العطلة الوطنية تسري على كل العيادات');

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, false, 'الحجز في يوم عطلة وطنية يجب أن يُرفض');
  });
});

test('البوابة: عطلة عيادة لا تسري على عيادة أخرى', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-scoped');
    const other = await createFixtures(client, 'gate-scoped-other');
    const date = futureDate(33);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة عيادة واحدة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const otherGate = await readGate(client, other.clinicId, other.doctorId, date);
    assert.equal(otherGate.is_blocked, false, 'عطلة عيادة لا تُغلق عيادة أخرى');

    const inserted = await tryInsertAppointment(client, { ...other, date });
    assert.equal(inserted.ok, true, 'الحجز في العيادة الأخرى يبقى ممكناً');
  });
});

test('البوابة: استثناء عمل معتمد يفتح يوم العطلة', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-exception');
    const date = futureDate(34);

    const holiday = await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة مع استثناء', 'OFFICIAL', 'ACTIVE') RETURNING holiday_id`,
      [date, fx.clinicId]
    );

    await client.query(
      `INSERT INTO work_exceptions (clinic_id, doctor_id, holiday_id, exception_date, status, reason, approved_at)
       VALUES ($1, $2, $3, $4::date, 'APPROVED', 'استثناء اختبار', CURRENT_TIMESTAMP)`,
      [fx.clinicId, fx.doctorId, holiday.rows[0].holiday_id, date]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, false, 'الاستثناء المعتمد يفتح تاريخ العطلة');
    assert.equal(gate.code, null);

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true, 'الحجز مسموح في يوم عطل مع استثناء معتمد');
  });
});

test('البوابة: استثناء بانتظار الاعتماد لا يفتح العطلة', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-pending-exception');
    const date = futureDate(35);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة مع استثناء معلّق', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );
    await client.query(
      `INSERT INTO work_exceptions (clinic_id, doctor_id, exception_date, status, reason)
       VALUES ($1, $2, $3::date, 'PENDING', 'استثناء بانتظار الاعتماد')`,
      [fx.clinicId, fx.doctorId, date]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, true, 'الاستثناء غير المعتمد لا يفتح العطلة');
    assert.equal(gate.code, 'HOLIDAY');
  });
});

test('البوابة: الإجازة المعتمدة تغلق اليوم (وتتقدّم على الاستثناء)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-leave');
    const date = futureDate(36);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة وإجازة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );
    await client.query(
      `INSERT INTO work_exceptions (clinic_id, doctor_id, exception_date, status, reason, approved_at)
       VALUES ($1, $2, $3::date, 'APPROVED', 'استثناء معتمد', CURRENT_TIMESTAMP)`,
      [fx.clinicId, fx.doctorId, date]
    );
    await client.query(
      `INSERT INTO doctor_leave (doctor_id, clinic_id, start_date, end_date, status, approved_at)
       VALUES ($1, $2, $3::date, $3::date, 'APPROVED', CURRENT_TIMESTAMP)`,
      [fx.doctorId, fx.clinicId, date]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, true, 'الإجازة المعتمدة تغلق اليوم');
    assert.equal(gate.code, 'LEAVE', 'الإجازة تتقدّم على العطلة وعلى الاستثناء');

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, false, 'الحجز في يوم إجازة معتمدة يجب أن يُرفض');
    assert.equal(inserted.code, 'CL001');
  });
});

test('البوابة: إجازة بانتظار الاعتماد لا تحجب الحجز', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-pending-leave');
    const date = futureDate(37);

    await client.query(
      `INSERT INTO doctor_leave (doctor_id, clinic_id, start_date, end_date, status)
       VALUES ($1, $2, $3::date, $3::date, 'PENDING')`,
      [fx.doctorId, fx.clinicId, date]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, false, 'الإجازة غير المعتمدة لا تحجب الحجز');

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true, 'الحجز يبقى ممكناً أثناء انتظار اعتماد الإجازة');
  });
});

test('البوابة: إلغاء العطلة يفتح الحجز فوراً (بلا نافذة زمنية)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-cancel-holiday');
    const date = futureDate(38);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة ملغاة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );
    await client.query(
      `UPDATE clinic_holidays
       SET status = 'CANCELLED', cancellation_reason = 'إلغاء اختبار', cancelled_at = CURRENT_TIMESTAMP
       WHERE holiday_date = $1::date AND clinic_id = $2`,
      [date, fx.clinicId]
    );

    const gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, false, 'إلغاء العطلة يسري فوراً');

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true, 'الحجز ينجح بعد إلغاء العطلة مباشرة');
  });
});

test('البوابة: إلغاء الإجازة يفتح الحجز فوراً', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-cancel-leave');
    const date = futureDate(39);

    await client.query(
      `INSERT INTO doctor_leave (doctor_id, clinic_id, start_date, end_date, status, approved_at)
       VALUES ($1, $2, $3::date, $3::date, 'APPROVED', CURRENT_TIMESTAMP)`,
      [fx.doctorId, fx.clinicId, date]
    );
    let gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, true);

    await client.query(
      `UPDATE doctor_leave SET status = 'CANCELLED' WHERE doctor_id = $1 AND clinic_id = $2 AND start_date = $3::date`,
      [fx.doctorId, fx.clinicId, date]
    );

    gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, false, 'إلغاء الإجازة يسري فوراً');
  });
});

test('البوابة: إلغاء استثناء العمل يعيد إغلاق يوم العطلة', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-cancel-exception');
    const date = futureDate(40);

    const holiday = await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE') RETURNING holiday_id`,
      [date, fx.clinicId]
    );
    const exception = await client.query(
      `INSERT INTO work_exceptions (clinic_id, doctor_id, holiday_id, exception_date, status, reason, approved_at)
       VALUES ($1, $2, $3, $4::date, 'APPROVED', 'استثناء', CURRENT_TIMESTAMP) RETURNING exception_id`,
      [fx.clinicId, fx.doctorId, holiday.rows[0].holiday_id, date]
    );

    let gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, false, 'الاستثناء المعتمد يفتح اليوم');

    await client.query(
      `UPDATE work_exceptions SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE exception_id = $1`,
      [exception.rows[0].exception_id]
    );

    gate = await readGate(client, fx.clinicId, fx.doctorId, date);
    assert.equal(gate.is_blocked, true, 'إلغاء الاستثناء يعيد إغلاق العطلة');
    assert.equal(gate.code, 'HOLIDAY');
  });
});

test('البوابة: موعد بلا وقت في يوم عطلة يُرفض (البوابة على مستوى التاريخ)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'gate-no-time');
    const date = futureDate(41);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const inserted = await tryInsertAppointment(client, { ...fx, date, start: null, end: null });
    assert.equal(inserted.ok, false, 'موعد بلا وقت يحجز يوماً كاملاً — فيُخضع لبوابة التاريخ');
    assert.equal(inserted.code, 'CL001');
  });
});
