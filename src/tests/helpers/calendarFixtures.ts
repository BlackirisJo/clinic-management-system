import assert from 'node:assert/strict';
import { Pool, types } from 'pg';
import type { PoolClient } from 'pg';

/**
 * أدوات مشتركة لاختبارات تقويم العطل والجدولة.
 *
 * قاعدة إلزامية: كل كتابة هنا تتم على clinic_db_test حصراً.
 * كل اختبار يكتب داخل BEGIN/ROLLBACK، أو ينشئ بيانات مسمّاة ب.RunId فريدة
 * ويحذفها في t.after — فلا يبقى أثر في القاعدة المشتركة.
 */

// أعمدة DATE تُقرأ نصاً خاماً (YYYY-MM-DD) تماماً كما في config/database،
// حتى لا يتحوّل التاريخ إلى كائن Date ينزاح حسب منطقة الخادم الزمنية.
types.setTypeParser(1082, (value: string) => value);

export const testPool = new Pool({
  host: process.env.TEST_DB_HOST || 'localhost',
  port: Number(process.env.TEST_DB_PORT) || 5433,
  user: process.env.TEST_DB_USER || 'clinic_admin',
  password: process.env.TEST_DB_PASSWORD || 'clinic_secure_pass_2026',
  database: process.env.TEST_DB_NAME || 'clinic_db_test',
});

export type PgClient = PoolClient;

export const assertTestDatabase = async (client: PgClient): Promise<void> => {
  const { rows } = await client.query('SELECT current_database() AS db');
  assert.equal(rows[0].db, 'clinic_db_test', 'اختبارات التقويم يجب أن تعمل على clinic_db_test حصراً');
};

export async function withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await assertTestDatabase(client);
    try {
      const result = await fn(client);
      await client.query('ROLLBACK');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/** تاريخ مستقبلي بصيغة YYYY-MM-DD (بأيام من اليوم). */
export const futureDate = (days: number): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export type Fixtures = {
  runId: string;
  clinicId: number;
  doctorId: number;
  patientId: number;
};

/** ينشئ عيادة وطبيباً ومريضاً باسم فريد — للاختبارات التي تكتب في القاعدة. */
export const createFixtures = async (client: PgClient, label: string): Promise<Fixtures> => {
  const runId = `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

  const clinic = await client.query('INSERT INTO clinics (clinic_name) VALUES ($1) RETURNING clinic_id', [
    `عيادة اختبار ${runId}`,
  ]);
  const clinicId = Number(clinic.rows[0].clinic_id);

  const role = await client.query(`SELECT role_id FROM roles WHERE role_name = 'DOCTOR'`);
  const doctor = await client.query(
    `INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, status)
     VALUES ($1, $2, $3, $4, 'test-hash', 'ACTIVE') RETURNING user_id`,
    [role.rows[0]?.role_id ?? null, clinicId, `طبيب اختبار ${runId}`, `doc_${runId}`]
  );
  const doctorId = Number(doctor.rows[0].user_id);

  const patient = await client.query(
    `INSERT INTO patients (clinic_id, full_name, phone, gender, date_of_birth)
     VALUES ($1, $2, $3, 'M', '1990-01-01') RETURNING patient_id`,
    [clinicId, `مريض اختبار ${runId}`, '0790000000']
  );
  const patientId = Number(patient.rows[0].patient_id);

  return { runId, clinicId, doctorId, patientId };
};

/** يحذف ما أنشأه createFixtures (بالترتيب الذي يحترم المفاتيح الأجنبية). */
export const cleanUpFixtures = async (client: PgClient, fixtures: Fixtures): Promise<void> => {
  await client.query('DELETE FROM calendar_change_notifications WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM calendar_changes WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM work_exceptions WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM doctor_leave WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM clinic_holidays WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM appointments WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM visits WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM patients WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM users WHERE clinic_id = $1', [fixtures.clinicId]);
  await client.query('DELETE FROM clinics WHERE clinic_id = $1', [fixtures.clinicId]);
};

export type InsertOutcome = { ok: boolean; code?: string; message?: string; detail?: string };

/** معرّف مستخدم إداري حقيقي (للمُنفِّذ في سجلات التدقيق) إن وُجد. */
export const findAdminUserId = async (client: PgClient): Promise<number | null> => {
  const { rows } = await client.query(
    `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
     WHERE r.role_name IN ('SYSTEM_ADMIN','SUPER_ADMIN') AND u.status = 'ACTIVE'
     ORDER BY u.user_id LIMIT 1`
  );
  return rows[0] ? Number(rows[0].user_id) : null;
};

/**
 * ينشئ بيانات ثابتة (تُحفظ) خارج معاملة الاختبار، لأن الـController يعمل
 * بمعاملاته الخاصة. تُحذف بعد الاختبار عبر cleanUpFixtures.
 * ملاحظة: الاتصال يُعاد للـpool فوراً — تسريب اتصال محجوز يمنع خروج العملية.
 */
export const createCommittedFixtures = async (
  label: string
): Promise<Fixtures & { adminUserId: number }> => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await assertTestDatabase(client);
    const fixtures = await createFixtures(client, label);
    const adminUserId = (await findAdminUserId(client)) ?? fixtures.doctorId;
    await client.query('COMMIT');
    return { ...fixtures, adminUserId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

/** ينفّذ عملية تنظيف على اتصال مستقل مع إرجاعه للـpool في كل الحالات. */
export const cleanupCommittedFixtures = async (fixtures: Fixtures): Promise<void> => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await cleanUpFixtures(client, fixtures);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

/**
 * إدراج موعد داخل SAVEPOINT: الرفض لا يُفسد المعاملة المحيطة،
 * فيمكن للحالة التالية أن تعمل على نفس الاتصال.
 */
export const tryInsertAppointment = async (
  client: PgClient,
  values: {
    clinicId: number;
    patientId: number;
    doctorId: number;
    date: string;
    start?: string | null;
    end?: string | null;
    reason?: string | null;
  }
): Promise<InsertOutcome> => {
  await client.query('SAVEPOINT ins');
  try {
    await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, reason, status)
       VALUES ($1, $2, $3, $4::date, $5::time, $6::time, $7, 'SCHEDULED')`,
      [values.clinicId, values.patientId, values.doctorId, values.date, values.start ?? '09:00', values.end ?? '09:30', values.reason ?? null]
    );
    await client.query('RELEASE SAVEPOINT ins');
    return { ok: true };
  } catch (err: any) {
    await client.query('ROLLBACK TO SAVEPOINT ins');
    return { ok: false, code: err?.code, message: err?.message, detail: err?.detail };
  }
};

/** نتيجة بوابة التقويم كما تراها قاعدة البيانات. */
export const readGate = async (
  client: PgClient,
  clinicId: number,
  doctorId: number,
  date: string
): Promise<{ is_blocked: boolean; code: string | null; detail: string | null }> => {
  const { rows } = await client.query(
    'SELECT is_blocked, code, detail FROM calendar_gate($1::int, $2::int, $3::date)',
    [clinicId, doctorId, date]
  );
  return rows[0] ?? { is_blocked: false, code: null, detail: null };
};
