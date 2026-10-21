import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * T6 — التزامن: لا انزلاق حجز (slipping) ولا جمود (deadlock).
 *
 * القاعدة: كل من يلمس يوماً في التقويم يأخذ قفل (عيادة، يوم) قبل أن يقيّم
 * البوابة، ويحتفظ به حتى COMMIT/ROLLBACK. لذلك إما أن يسبق الحجزُ التصحيحَ
 * فيُدرَج ضمن الأثر، أو يليه فيُرفض — ولا يوجد نافذة بينهما يتسرب فيها حجز.
 *
 * ترتيب الأقفال تصاعدي دائماً بـ(عيادة، يوم) ⇒ لا يمكن أن يت form deadlock:
 * عمليتان تأخذان نفس المجموعة بالترتيب نفسه لا تتعارضان.
 */

import { Pool } from 'pg';
import { epochDay } from '../utils/calendarTime';
import { testPool, createCommittedFixtures, cleanupCommittedFixtures, futureDate } from './helpers/calendarFixtures';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/` promise` مع مهلة قصوى؛ يرفض إذا تجاوزت المهلة. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`operation timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
};

test('لا انزلاق: الحجز الذي يطابق تصحيح العطل إما يسبقها فيُدرَج، أو يتبعها فيُرفض', async (t) => {
  const fx = await createCommittedFixtures('concurrency-slip');
  t.after(() => cleanupCommittedFixtures(fx));

  const date = futureDate(95);
  const day = epochDay(date);

  // ————— الجلسة A: تصحيح العطل (يقفل اليوم ثم يعلن العطلة) —————
  const sessionA = await testPool.connect();
  await sessionA.query('BEGIN');
  await sessionA.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [fx.clinicId, day]);
  await sessionA.query(
    `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
     VALUES ($1::date, $2, 'عطلة متزامنة', 'OFFICIAL', 'ACTIVE')`,
    [date, fx.clinicId]
  );

  // ————— الجلسة B: حجز في نفس اليوم (يبدأ بطلب القفل نفسه) —————
  const sessionB = await testPool.connect();
  let bookingResult: { ok: boolean; code?: string } = { ok: false };
  const booking = (async () => {
    await sessionB.query('BEGIN');
    // هذا الطلب يجب أن ينتظر: القفل محجوز من A
    await sessionB.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [fx.clinicId, day]);
    // بعد أن يُفلت القفل، تُعاد قراءة البوابة ⇒ العطلة صارت سارية
    const gate = await sessionB.query(
      'SELECT is_blocked FROM calendar_gate($1::int, $2::int, $3::date)',
      [fx.clinicId, fx.doctorId, date]
    );
    if (gate.rows[0].is_blocked) {
      await sessionB.query('ROLLBACK');
      bookingResult = { ok: false, code: 'GATE_BLOCKED' };
      return;
    }
    try {
      await sessionB.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, status)
         VALUES ($1, $2, $3, $4::date, '09:00', '09:30', 'SCHEDULED')`,
        [fx.clinicId, fx.patientId, fx.doctorId, date]
      );
      await sessionB.query('COMMIT');
      bookingResult = { ok: true };
    } catch (err: any) {
      await sessionB.query('ROLLBACK').catch(() => undefined);
      bookingResult = { ok: false, code: err?.code };
    }
  })();

  // نترك B معلّقاً على القفل فترة قصيرة (لإثبات انتظاره) ثم نُنهي A
  await sleep(150);
  await sessionA.query('COMMIT');
  sessionA.release();

  await withTimeout(booking, 5000);
  sessionB.release();

  assert.equal(bookingResult.ok, false, 'الحجز بعد تصحيح العطل يجب أن يُرفض');
  assert.equal(bookingResult.code, 'GATE_BLOCKED');

  // لا حجز تسلّب إلى اليوم المغلق
  const appointments = await testPool.query(
    `SELECT count(*)::int AS cnt FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3::date`,
    [fx.doctorId, fx.clinicId, date]
  );
  assert.equal(appointments.rows[0].cnt, 0, 'لا حجز في يوم صارت مغلقاً');
});

test('لا جمود: نقلان متعاكسان في الوقت نفسه ينتهيان بلا خطأ جمود', async (t) => {
  const fx = await createCommittedFixtures('concurrency-deadlock');
  t.after(() => cleanupCommittedFixtures(fx));

  const dateA = futureDate(96);
  const dateB = futureDate(97);

  const created = await testPool.query(
    `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
     VALUES ($1::date, $2, 'عطلة الأصل', 'OFFICIAL', 'ACTIVE') RETURNING holiday_id`,
    [dateA, fx.clinicId]
  );
  const holidayId = Number(created.rows[0].holiday_id);

  // كل جلسة تنقل العطلة إلى التاريخ الآخر — والأقفال تُلتقط دائماً
  // بالترتيب التصاعدي (clinic_id, يوم) ⇒ لا جمود.
  const move = async (targetDate: string) => {
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const days = [dateA, dateB].map((date) => ({ clinic_id: fx.clinicId, date }));
      const ordered = days.sort((a, b) => epochDay(a.date) - epochDay(b.date));
      for (const day of ordered) {
        await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [day.clinic_id, epochDay(day.date)]);
      }
      await client.query(`UPDATE clinic_holidays SET holiday_date = $1::date WHERE holiday_id = $2`, [targetDate, holidayId]);
      await client.query('COMMIT');
      return { ok: true as const };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false as const, code: err?.code, message: err?.message };
    } finally {
      client.release();
    }
  };

  const results = await withTimeout(Promise.all([move(dateB), move(dateA)]), 10000);
  for (const result of results) {
    assert.notEqual(result.code, '40P01', 'لا يجوز أن يقع جمود (deadlock)');
    if (!result.ok) {
      // الفشل المسموح فقط: تعارض تفرّد (عطلة موجودة على التاريخ الهدف)
      assert.ok(
        result.code === '23505' || result.code === '23P01',
        `فشل غير متوقع: ${result.code} ${result.message ?? ''}`
      );
    }
  }
});
