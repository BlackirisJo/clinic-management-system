import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression test for the unbounded-range defect in appointments_no_doctor_overlap.
 *
 * Root cause (fixed by 056_appointments_overlap_null_time_guard.sql):
 *   tsrange((appointment_date + start_time), (appointment_date + end_time), '[)')
 *   with a NULL start_time produced the UNBOUNDED range '(,)', which overlaps
 *   every other range — so one appointment stored without times blocked every
 *   later booking of that doctor, even on an unrelated date (23P01).
 *
 * The test talks to clinic_db_test ONLY. Every write below happens inside a
 * transaction that is rolled back, so the test leaves no rows behind. The only
 * committed write is the one-time application of migration 056, which mirrors
 * what `npm run migrate` does (apply a migration once, record it in
 * schema_migrations, never re-apply it).
 */

const MIGRATION_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '056_appointments_overlap_null_time_guard.sql');
const MIGRATION_VERSION = '056_appointments_overlap_null_time_guard.sql';

const testPool = new Pool({
  host: process.env.TEST_DB_HOST || 'localhost',
  port: Number(process.env.TEST_DB_PORT) || 5433,
  user: process.env.TEST_DB_USER || 'clinic_admin',
  password: process.env.TEST_DB_PASSWORD || 'clinic_secure_pass_2026',
  database: process.env.TEST_DB_NAME || 'clinic_db_test',
});

type PgClient = import('pg').PoolClient;

/** The definition shipped by 004 — the defective one. Used only to prove the
 *  regression is real; it is installed inside a transaction that is rolled back. */
const DEFECTIVE_CONSTRAINT_SQL = `
  ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_doctor_overlap;
  ALTER TABLE appointments ADD CONSTRAINT appointments_no_doctor_overlap
    EXCLUDE USING gist (
      doctor_id WITH =,
      clinic_id WITH =,
      tsrange((appointment_date + start_time), (appointment_date + end_time), '[)') WITH &&
    ) WHERE (status <> 'CANCELLED');
`;

async function ensureMigrationApplied(): Promise<void> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dbRows } = await client.query('SELECT current_database() AS db');
    assert.equal(
      dbRows[0].db,
      'clinic_db_test',
      'Migration 056 must run against clinic_db_test'
    );

    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [MIGRATION_VERSION]);
    if (applied.rowCount) {
      // Already applied — never re-apply, so a later revert of the constraint
      // is still caught by this test instead of being silently repaired.
      await client.query('ROLLBACK');
      return;
    }

    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
      [MIGRATION_VERSION]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    // قفل استشاري على مستوى المعاملة لتسلسل عمليات الإعداد بين الاتصالات المتزامنة.
    // بدون هذا، يمكن أن يحدث deadlock عندما يحمل اتصال واحد SharedLock على جدول users
    // وي_wait على ExclusiveLock على جدول appointments، بينما اتصال آخر يحمل العكس.
    await client.query('SELECT pg_advisory_xact_lock($1::int)', [495600]);
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

type InsertOutcome = { ok: boolean; code?: string; message?: string };

/** Insert that never poisons the surrounding transaction: a rejected insert is
 *  rolled back to a savepoint so the next case can still run. */
async function tryInsertAppointment(
  client: PgClient,
  values: { doctorId: number; clinicId: number; patientId: number; date: string; start?: string | null; end?: string | null; status?: string }
): Promise<InsertOutcome> {
  await client.query('SAVEPOINT ins');
  try {
    await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [values.clinicId, values.patientId, values.doctorId, values.date, values.start ?? null, values.end ?? null, values.status ?? 'SCHEDULED']
    );
    await client.query('RELEASE SAVEPOINT ins');
    return { ok: true };
  } catch (err: any) {
    await client.query('ROLLBACK TO SAVEPOINT ins');
    return { ok: false, code: err.code, message: err.message };
  }
}

type Probe = { doctorId: number; patientId: number; clinicId: number };

async function pickProbe(client: PgClient): Promise<Probe> {
  const { rows: doctors } = await client.query(
    `SELECT u.user_id
     FROM users u
     JOIN roles r ON r.role_id = u.role_id
     WHERE r.role_name = 'DOCTOR' AND u.status = 'ACTIVE'
     ORDER BY u.user_id
     LIMIT 1`
  );
  const { rows: patients } = await client.query('SELECT patient_id FROM patients ORDER BY patient_id LIMIT 1');
  const { rows: clinics } = await client.query('SELECT clinic_id FROM clinics ORDER BY clinic_id LIMIT 1');
  assert.ok(doctors.length && patients.length && clinics.length, 'probe data (doctor/patient/clinic) must exist');
  return {
    doctorId: doctors[0].user_id,
    patientId: patients[0].patient_id,
    clinicId: clinics[0].clinic_id,
  };
}

/** A doctor with no appointments of their own, so the scenario starts clean. */
async function clearDoctorAppointments(client: PgClient, doctorId: number): Promise<void> {
  await client.query('DELETE FROM appointments WHERE doctor_id = $1', [doctorId]);
}

test('APPOINTMENTS OVERLAP | migration 056 is applied once and carries the null-time guard', async () => {
  await ensureMigrationApplied();

  const client = await testPool.connect();
  try {
    const { rows: dbRows } = await client.query('SELECT current_database() AS db');
    assert.equal(dbRows[0].db, 'clinic_db_test', 'the assertion must run against clinic_db_test');

    const { rows: applied } = await client.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [MIGRATION_VERSION]
    );
    assert.equal(applied.length, 1, 'migration 056 must be recorded exactly once');

    const { rows: constraints } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conname = 'appointments_no_doctor_overlap' AND conrelid = 'appointments'::regclass`
    );
    assert.equal(constraints.length, 1, 'appointments_no_doctor_overlap must exist on appointments');
    const def = constraints[0].def;
    assert.match(def, /start_time IS NOT NULL/, 'the constraint must ignore appointments without a start time');
    assert.match(def, /end_time IS NOT NULL/, 'the constraint must ignore appointments without an end time');
    assert.match(def, /status.*CANCELLED/, 'the cancelled-appointment rule must be preserved');
    assert.match(def, /EXCLUDE USING gist/, 'the constraint must stay an exclusion constraint');
  } finally {
    client.release();
  }
});

test('APPOINTMENTS OVERLAP | the pre-fix definition reproduces the defect (the regression is real)', async () => {
  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    // Restore the definition shipped by 004 inside this transaction only.
    await client.query(DEFECTIVE_CONSTRAINT_SQL);

    const timeless = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-01-01',
      start: null,
      end: null,
    });
    assert.ok(timeless.ok, 'an appointment without times is accepted by the schema');

    const laterBooking = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-06-15',
      start: '10:00',
      end: '11:00',
    });
    assert.equal(
      laterBooking.ok,
      false,
      'BEFORE THE FIX the timeless appointment must block an unrelated later date'
    );
    assert.equal(laterBooking.code, '23P01', 'the pre-fix failure is an exclusion violation');
  });
});

test('APPOINTMENTS OVERLAP | an appointment without times does not block a valid booking on a later day', async () => {
  await ensureMigrationApplied();

  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    const timeless = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-01-01',
      start: null,
      end: null,
    });
    assert.ok(timeless.ok, 'an appointment without times is still accepted');

    const laterBooking = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-06-15',
      start: '10:00',
      end: '11:00',
    });
    assert.ok(laterBooking.ok, 'a valid booking on a later day must not be blocked by an appointment without times');
  });
});

test('APPOINTMENTS OVERLAP | an appointment without times reserves no time slot on its own day', async () => {
  await ensureMigrationApplied();

  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    const timeless = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-03-10',
      start: null,
      end: null,
    });
    assert.ok(timeless.ok, 'an appointment without times is still accepted');

    const sameDayBooking = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-03-10',
      start: '10:00',
      end: '11:00',
    });
    assert.ok(
      sameDayBooking.ok,
      'an appointment without times must not reserve a slot — it matches the application rule that ignores appointments without times'
    );
  });
});

test('APPOINTMENTS OVERLAP | a real overlap between two timed appointments is still rejected', async () => {
  await ensureMigrationApplied();

  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    const first = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-01',
      start: '10:00',
      end: '11:00',
    });
    assert.ok(first.ok, 'the first timed appointment is accepted');

    const overlapping = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-01',
      start: '10:30',
      end: '11:30',
    });
    assert.equal(overlapping.ok, false, 'an overlapping timed appointment must be rejected');
    assert.equal(overlapping.code, '23P01', 'the overlap must be rejected by the exclusion constraint');
  });
});

test('APPOINTMENTS OVERLAP | two adjacent timed periods are still accepted', async () => {
  await ensureMigrationApplied();

  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    const first = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-02',
      start: '09:00',
      end: '11:00',
    });
    assert.ok(first.ok, 'the first timed appointment is accepted');

    const adjacent = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-02',
      start: '11:00',
      end: '13:00',
    });
    assert.ok(adjacent.ok, 'a period that starts exactly when the previous one ends must stay allowed');
  });
});

test('APPOINTMENTS OVERLAP | the constraint still separates different doctors and different clinics', async () => {
  await ensureMigrationApplied();

  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    const { rows: otherDoctors } = await client.query(
      `SELECT u.user_id FROM users u
       JOIN roles r ON r.role_id = u.role_id
       WHERE r.role_name = 'DOCTOR' AND u.status = 'ACTIVE' AND u.user_id <> $1
       ORDER BY u.user_id LIMIT 1`,
      [probe.doctorId]
    );
    const { rows: otherClinics } = await client.query(
      'SELECT clinic_id FROM clinics WHERE clinic_id <> $1 ORDER BY clinic_id LIMIT 1',
      [probe.clinicId]
    );

    const base = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-03',
      start: '10:00',
      end: '11:00',
    });
    assert.ok(base.ok, 'the base timed appointment is accepted');

    if (otherDoctors.length) {
      const otherDoctor = await tryInsertAppointment(client, {
        ...probe,
        doctorId: otherDoctors[0].user_id,
        date: '2030-04-03',
        start: '10:00',
        end: '11:00',
      });
      assert.ok(otherDoctor.ok, 'the same slot for another doctor must stay allowed');
    }

    if (otherClinics.length) {
      const otherClinic = await tryInsertAppointment(client, {
        ...probe,
        clinicId: otherClinics[0].clinic_id,
        date: '2030-04-03',
        start: '10:00',
        end: '11:00',
      });
      assert.ok(otherClinic.ok, 'the same slot in another clinic must stay allowed');
    }
  });
});

test('APPOINTMENTS OVERLAP | a cancelled appointment does not block a timed booking', async () => {
  await ensureMigrationApplied();

  await withTransaction(async (client) => {
    const probe = await pickProbe(client);
    await clearDoctorAppointments(client, probe.doctorId);

    const cancelled = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-04',
      start: '10:00',
      end: '11:00',
      status: 'CANCELLED',
    });
    assert.ok(cancelled.ok, 'the cancelled appointment is accepted');

    const replacement = await tryInsertAppointment(client, {
      ...probe,
      date: '2030-04-04',
      start: '10:00',
      end: '11:00',
    });
    assert.ok(replacement.ok, 'a cancelled appointment must not block the same slot');
  });
});
