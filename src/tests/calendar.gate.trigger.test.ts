import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * T3 — مُشغّل البوابة (trigger) على appointments.
 *
 * الهدف: إثبات أن القاعدة خط الدفاع الأخير — لا يمكن لأي كاتب (تطبيق،
 * استيراد، أو INSERT يدوي في psql) أن يتجاوزها. والtrigger لا يحذف ولا
 * يلغي أي موعد قائم: يرفض فقط الإنشاء أو النقل.
 */

import {
  withTransaction,
  createFixtures,
  futureDate,
  tryInsertAppointment,
} from './helpers/calendarFixtures';

const expectGateRejection = (outcome: { ok: boolean; code?: string; message?: string }) => {
  assert.equal(outcome.ok, false, 'كان يجب أن يُرفض الإدراج');
  assert.equal(outcome.code, 'CL001', 'الرمز المتوقع من مُشغّل البوابة');
};

test('المُشغِّل: إدراج مباشر في SQL داخل يوم عطلة يُرفض (لا يتجاوزه كاتب خارج التطبيق)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'trigger-insert');
    const date = futureDate(50);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const outcome = await tryInsertAppointment(client, { ...fx, date });
    expectGateRejection(outcome);
  });
});

test('المُشغِّل: نقل موعد قائم إلى يوم عطلة يُرفض', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'trigger-move');
    const openDate = futureDate(51);
    const holidayDate = futureDate(52);

    const inserted = await tryInsertAppointment(client, { ...fx, date: openDate });
    assert.equal(inserted.ok, true, 'الموعد الأصلي يجب أن يُقبل');

    const { rows } = await client.query(
      `SELECT appointment_id FROM appointments
       WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3::date`,
      [fx.doctorId, fx.clinicId, openDate]
    );
    const appointmentId = Number(rows[0].appointment_id);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE')`,
      [holidayDate, fx.clinicId]
    );

    await client.query('SAVEPOINT mv');
    let code: string | undefined;
    try {
      await client.query(`UPDATE appointments SET appointment_date = $1::date WHERE appointment_id = $2`, [
        holidayDate,
        appointmentId,
      ]);
    } catch (err: any) {
      code = err?.code;
    }
    await client.query('ROLLBACK TO SAVEPOINT mv');
    assert.equal(code, 'CL001', 'نقل الموعد إلى يوم عطلة يجب أن يُرفض');

    // والموعد بقي في مكانه (لم يُلغَ ولم يُحذف)
    const after = await client.query(`SELECT appointment_date, status FROM appointments WHERE appointment_id = $1`, [
      appointmentId,
    ]);
    assert.equal(String(after.rows[0].appointment_date), openDate, 'الموعد لم يُنقل');
    assert.equal(after.rows[0].status, 'SCHEDULED', 'الموعد لم يُلغَ');
  });
});

test('المُشغِّل: تغيير حالة موعد داخل العطل مسموح (وإلا تعطّل إنهاء الزيارة أو إلغاؤها)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'trigger-status');
    const date = futureDate(53);

    // موعد أُنشئ قبل إعلان العطلة
    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true, 'الموعد أُنشئ قبل العطلة');

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const { rows } = await client.query(
      `SELECT appointment_id FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3::date`,
      [fx.doctorId, fx.clinicId, date]
    );
    const appointmentId = Number(rows[0].appointment_id);

    const updated = await client.query(
      `UPDATE appointments SET status = 'CONFIRMED' WHERE appointment_id = $1 RETURNING status`,
      [appointmentId]
    );
    assert.equal(updated.rows[0].status, 'CONFIRMED', 'تغيير الحالة فقط يجب أن يمر');

    const cancelled = await client.query(
      `UPDATE appointments SET status = 'CANCELLED' WHERE appointment_id = $1 RETURNING status`,
      [appointmentId]
    );
    assert.equal(cancelled.rows[0].status, 'CANCELLED', 'إلغاء الموعد داخل العطل يجب أن يمر');
  });
});

test('المُشغِّل: إعلان عطلة فوق موعد قائم لا يلغي الموعد ولا يحذفه', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'trigger-no-cancel');
    const date = futureDate(54);

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const { rows } = await client.query(
      `SELECT status FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3::date`,
      [fx.doctorId, fx.clinicId, date]
    );
    assert.equal(rows.length, 1, 'الموعد ما زال موجوداً');
    assert.equal(rows[0].status, 'SCHEDULED', 'الموعد لم يُلغَ بصمت');
  });
});

test('المُشغِّل: تغيير الطبيب في موعد داخل العطل يُرفض (هوية الخانة تغيّرت)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'trigger-doctor-swap');
    const other = await createFixtures(client, 'trigger-doctor-swap-other');
    const date = futureDate(55);

    const inserted = await tryInsertAppointment(client, { ...fx, date });
    assert.equal(inserted.ok, true);

    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
       VALUES ($1::date, $2, 'عطلة', 'OFFICIAL', 'ACTIVE')`,
      [date, fx.clinicId]
    );

    const { rows } = await client.query(
      `SELECT appointment_id FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3::date`,
      [fx.doctorId, fx.clinicId, date]
    );
    const appointmentId = Number(rows[0].appointment_id);

    await client.query('SAVEPOINT swp');
    let code: string | undefined;
    try {
      await client.query(`UPDATE appointments SET doctor_id = $1 WHERE appointment_id = $2`, [
        other.doctorId,
        appointmentId,
      ]);
    } catch (err: any) {
      code = err?.code;
    }
    await client.query('ROLLBACK TO SAVEPOINT swp');
    assert.equal(code, 'CL001', 'نقل الموعد إلى طبيب آخر داخل العطل يجب أن يُرفض');
  });
});

test('المُشغِّل: استثناء العمل لا يتجاوز إجازة معتمدة (CL002)', async () => {
  await withTransaction(async (client) => {
    const fx = await createFixtures(client, 'trigger-leave-guard');
    const date = futureDate(56);

    await client.query(
      `INSERT INTO doctor_leave (doctor_id, clinic_id, start_date, end_date, status, approved_at)
       VALUES ($1, $2, $3::date, $3::date, 'APPROVED', CURRENT_TIMESTAMP)`,
      [fx.doctorId, fx.clinicId, date]
    );

    await client.query('SAVEPOINT ex');
    let code: string | undefined;
    try {
      await client.query(
        `INSERT INTO work_exceptions (clinic_id, doctor_id, exception_date, status, reason, approved_at)
         VALUES ($1, $2, $3::date, 'APPROVED', 'محاولة تجاوز إجازة', CURRENT_TIMESTAMP)`,
        [fx.clinicId, fx.doctorId, date]
      );
    } catch (err: any) {
      code = err?.code;
    }
    await client.query('ROLLBACK TO SAVEPOINT ex');
    assert.equal(code, 'CL002', 'اعتماد استثناء فوق إجازة معتمدة يجب أن يُرفض');
  });
});
