import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '054_doctor_schedules.sql');

const testPool = new Pool({
  host: 'localhost',
  port: 5433,
  user: 'clinic_admin',
  password: 'clinic_secure_pass_2026',
  database: 'clinic_db_test',
});

type PgClient = import('pg').PoolClient;

let migrationCommitted = false;

async function ensureMigrationApplied(): Promise<void> {
  if (migrationCommitted) return;
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dbRows } = await client.query('SELECT current_database() AS db');
    assert.equal(
      dbRows[0].db,
      'clinic_db_test',
      'Migration 054 must run against clinic_db_test'
    );
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
      ['054_doctor_schedules.sql']
    );
    await client.query('COMMIT');
    migrationCommitted = true;
  } finally {
    client.release();
  }
}

async function withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
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

async function insertSchedule(
  client: PgClient,
  { doctorId = 2, clinicId = 1, dayOfWeek = 1, startTime = '09:00', endTime = '11:00', isWorkingDay = true }
): Promise<void> {
  await client.query(
    `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [doctorId, clinicId, dayOfWeek, startTime, endTime, isWorkingDay]
  );
}

test('DOCTOR SCHEDULES | migration 054 executes successfully on PostgreSQL 16', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dbRows } = await client.query('SELECT current_database() AS db');
    assert.equal(dbRows[0].db, 'clinic_db_test');

    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    await client.query(sql);

    const { rows: constraints } = await client.query(
      "SELECT conname FROM pg_constraint WHERE conname = 'doctor_schedules_no_overlap'"
    );
    assert.equal(constraints.length, 1, 'doctor_schedules_no_overlap constraint must exist');

    const { rows: extensions } = await client.query(
      "SELECT extname FROM pg_extension WHERE extname = 'btree_gist'"
    );
    assert.equal(extensions.length, 1, 'btree_gist extension must be enabled');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('DOCTOR SCHEDULES | overlapping periods rejected for same doctor/clinic/weekday', async () => {
  await ensureMigrationApplied();
  await withTransaction(async (client) => {
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '09:00', endTime: '11:00' });

    let threw = false;
    try {
      await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '10:00', endTime: '12:00' });
    } catch (e: any) {
      threw = true;
      assert.equal(e.code, '23P01', 'exclusion violation must raise 23P01');
    }
    assert.ok(threw, 'overlapping insert must be rejected');
  });
});

test('DOCTOR SCHEDULES | adjacent periods accepted for same doctor/clinic/weekday', async () => {
  await ensureMigrationApplied();
  await withTransaction(async (client) => {
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '09:00', endTime: '11:00' });
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '11:00', endTime: '13:00' });
  });
});

test('DOCTOR SCHEDULES | different doctors, clinics, weekdays are independent', async () => {
  await ensureMigrationApplied();
  await withTransaction(async (client) => {
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '09:00', endTime: '11:00' });
    await insertSchedule(client, { doctorId: 3, clinicId: 1, dayOfWeek: 1, startTime: '09:00', endTime: '11:00' });
    await insertSchedule(client, { doctorId: 2, clinicId: 2, dayOfWeek: 1, startTime: '09:00', endTime: '11:00' });
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 2, startTime: '09:00', endTime: '11:00' });
  });
});

test('DOCTOR SCHEDULES | non-working-day rows not constrained by exclusion filter', async () => {
  await ensureMigrationApplied();
  await withTransaction(async (client) => {
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '09:00', endTime: '11:00', isWorkingDay: false });
    await insertSchedule(client, { doctorId: 2, clinicId: 1, dayOfWeek: 1, startTime: '10:00', endTime: '12:00', isWorkingDay: false });
  });
});

test('DOCTOR SCHEDULES | concurrent conflicting inserts cannot both succeed', async () => {
  await ensureMigrationApplied();

  // القادح الأول يُدخل ويُcommited مباشرة (البيان يصبح مرئياً لكل الجلسات)
  await testPool.query(
    `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
     VALUES (2, 1, 1, '09:00', '11:00', TRUE)`
  );

  // القادح الثاني يحاول إدراجاً متداخلاً في معاملة منفصلة — يجب أن يُرفَض
  const c2 = await testPool.connect();
  try {
    await c2.query('BEGIN');
    let threw = false;
    try {
      await c2.query(
        `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
         VALUES (2, 1, 1, '10:00', '12:00', TRUE)`
      );
    } catch (e: any) {
      threw = true;
      assert.equal(e.code, '23P01', 'انتهاك الضغط على التقاطع يجب أن يرفع 23P01');
    }
    assert.ok(threw, 'إدراج متزامن متعارض يجب أن يُرفَض');
    await c2.query('ROLLBACK').catch(() => undefined);
  } finally {
    c2.release();
  }

  // تنظيف الصف الذي تم commitedه
  await testPool.query(
    `DELETE FROM doctor_schedules
     WHERE doctor_id = 2 AND clinic_id = 1 AND day_of_week = 1
       AND start_time = '09:00' AND end_time = '11:00'`
  );
});
