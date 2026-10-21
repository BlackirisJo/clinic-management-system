import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression tests for migration 055 (doctor schedule overlap constraint).
 *
 * 055 must guarantee that doctor_schedules_no_overlap exists with EXACTLY the
 * required definition — not merely that a constraint with that NAME exists.
 *
 * Every test runs inside a transaction that is rolled back, and every failure
 * expectation runs inside a savepoint, so the shared test database is never
 * left with a changed constraint, table or row. The "table missing" case drops
 * doctor_schedules only inside that transaction; PostgreSQL restores it when
 * the transaction rolls back.
 */

const MIGRATION_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '055_doctor_schedule_overlap_constraint.sql');
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

const testPool = new Pool({
  host: process.env.TEST_DB_HOST || 'localhost',
  port: Number(process.env.TEST_DB_PORT) || 5433,
  user: process.env.TEST_DB_USER || 'clinic_admin',
  password: process.env.TEST_DB_PASSWORD || 'clinic_secure_pass_2026',
  database: process.env.TEST_DB_NAME || 'clinic_db_test',
});

type PgClient = import('pg').PoolClient;

const CONSTRAINT_NAME = 'doctor_schedules_no_overlap';

const constraintDefinition = async (client: PgClient): Promise<string | null> => {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'doctor_schedules'::regclass AND conname = $1`,
    [CONSTRAINT_NAME]
  );
  return rows.length ? rows[0].def : null;
};

async function withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT current_database() AS db');
    assert.equal(rows[0].db, 'clinic_db_test', 'the migration tests must run against clinic_db_test');
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

/** Runs the migration inside a savepoint and returns the error it raised. */
async function runMigrationExpectingFailure(client: PgClient): Promise<any> {
  await client.query('SAVEPOINT mig');
  try {
    await client.query(MIGRATION_SQL);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT mig');
    return err;
  }
  await client.query('RELEASE SAVEPOINT mig');
  throw new Error('the migration was expected to fail but it succeeded');
}

/** Runs the migration and collects the notices it emitted. */
async function runMigration(client: PgClient): Promise<string[]> {
  const notices: string[] = [];
  const listener = (n: any) => notices.push(n.message);
  client.on('notice', listener);
  try {
    await client.query(MIGRATION_SQL);
  } finally {
    client.removeListener('notice', listener);
  }
  return notices;
}

/** The elements the constraint definition must contain (checked independently
 *  of how the migration itself compares definitions). */
function assertRequiredDefinition(def: string | null): void {
  assert.ok(def, `${CONSTRAINT_NAME} must exist`);
  assert.match(def, /EXCLUDE USING gist/, 'must be an exclusion constraint backed by GiST');
  assert.match(def, /doctor_id WITH =/, 'must scope on doctor_id');
  assert.match(def, /clinic_id WITH =/, 'must scope on clinic_id');
  assert.match(def, /day_of_week WITH =/, 'must scope on day_of_week');
  assert.match(def, /tsrange\(/, 'must exclude a time range');
  assert.match(def, /'2000-01-01'::date \+ start_time/, 'the range must start from a constant date plus start_time');
  assert.match(def, /'2000-01-01'::date \+ end_time/, 'the range must end at a constant date plus end_time');
  assert.match(def, /'\[\)'/, 'the range must use [) so adjacent periods stay allowed');
  assert.match(def, /WITH &&/, 'the operator must be the overlap operator');
  assert.match(def, /is_working_day = true/, 'the constraint must be restricted to working days');
  assert.doesNotMatch(def, /now\(\)|current_date|date_trunc|CURRENT_TIMESTAMP/i,
    'the range expression must not depend on the current time');
}

test('MIGRATION 055 | the required definition covers doctor, clinic, day, a constant IMMUTABLE range, overlap and working days', async () => {
  await withTransaction(async (client) => {
    const def = await constraintDefinition(client);
    assertRequiredDefinition(def);
  });
});

test('MIGRATION 055 | an already correct constraint is verified and left untouched', async () => {
  await withTransaction(async (client) => {
    const before = await constraintDefinition(client);
    assert.ok(before, 'the constraint must exist before the migration runs');

    const notices = await runMigration(client);

    const after = await constraintDefinition(client);
    assert.equal(after, before, 'a correct constraint must not be modified');
    assert.ok(
      notices.some((n) => n.includes('already exists with the expected definition')),
      `the migration must report that it verified the constraint — notices: ${JSON.stringify(notices)}`
    );
  });
});

test('MIGRATION 055 | a missing constraint is created with the required definition', async () => {
  await withTransaction(async (client) => {
    await client.query(`ALTER TABLE doctor_schedules DROP CONSTRAINT ${CONSTRAINT_NAME}`);
    assert.equal(await constraintDefinition(client), null, 'the constraint must be gone before the migration runs');

    const notices = await runMigration(client);

    const after = await constraintDefinition(client);
    assert.ok(after, 'the migration must create the constraint');
    assertRequiredDefinition(after);
    assert.ok(
      notices.some((n) => n.includes('was created with the verified definition')),
      `the migration must report the creation — notices: ${JSON.stringify(notices)}`
    );
  });
});

test('MIGRATION 055 | a same-named constraint with a different definition is detected and replaced', async () => {
  await withTransaction(async (client) => {
    // (a) a definition without the working-day filter: it would constrain
    //     non-working days that must stay unconstrained.
    await client.query(`ALTER TABLE doctor_schedules DROP CONSTRAINT ${CONSTRAINT_NAME}`);
    await client.query(
      `ALTER TABLE doctor_schedules ADD CONSTRAINT ${CONSTRAINT_NAME}
       EXCLUDE USING gist (
         doctor_id WITH =, clinic_id WITH =, day_of_week WITH =,
         tsrange((DATE '2000-01-01' + start_time)::timestamp,
                 (DATE '2000-01-01' + end_time)::timestamp, '[)') WITH &&
       )`
    );
    const wrongA = await constraintDefinition(client);
    assert.ok(wrongA && !wrongA.includes('is_working_day'), 'the wrong definition must lack the working-day filter');

    const noticesA = await runMigration(client);

    const repairedA = await constraintDefinition(client);
    assertRequiredDefinition(repairedA);
    assert.notEqual(repairedA, wrongA, 'the wrong definition must have been replaced');
    assert.ok(
      noticesA.some((n) => n.includes('DIFFERENT definition')),
      `the migration must report the replacement — notices: ${JSON.stringify(noticesA)}`
    );

    // (b) a definition that forgets day_of_week: it would forbid the same slot
    //     on every day of the week.
    await client.query(`ALTER TABLE doctor_schedules DROP CONSTRAINT ${CONSTRAINT_NAME}`);
    await client.query(
      `ALTER TABLE doctor_schedules ADD CONSTRAINT ${CONSTRAINT_NAME}
       EXCLUDE USING gist (
         doctor_id WITH =, clinic_id WITH =,
         tsrange((DATE '2000-01-01' + start_time)::timestamp,
                 (DATE '2000-01-01' + end_time)::timestamp, '[)') WITH &&
       ) WHERE (is_working_day = TRUE)`
    );
    const wrongB = await constraintDefinition(client);
    assert.ok(wrongB && !wrongB.includes('day_of_week'), 'the wrong definition must lack day_of_week');

    const noticesB = await runMigration(client);

    const repairedB = await constraintDefinition(client);
    assertRequiredDefinition(repairedB);
    assert.notEqual(repairedB, wrongB, 'the wrong definition must have been replaced');
    assert.ok(
      noticesB.some((n) => n.includes('DIFFERENT definition')),
      `the migration must report the replacement — notices: ${JSON.stringify(noticesB)}`
    );
  });
});

test('MIGRATION 055 | a missing table stops the migration with a clear message', async () => {
  // The table is dropped only inside a transaction that is rolled back, so the
  // shared test database keeps its table and constraint.
  await withTransaction(async (client) => {
    await client.query('DROP TABLE doctor_schedules');

    const err = await runMigrationExpectingFailure(client);

    assert.equal(err.code, 'P0001', 'the migration must fail with a raised exception');
    assert.match(err.message, /doctor_schedules does not exist/, 'the message must say the table is missing');
    assert.match(err.message, /054_doctor_schedules\.sql/, 'the message must say which migration has to be applied first');
    assert.notEqual(err.code, '42P01', 'the migration must not fail with an undefined-table error');
  });

  // The rollback must have restored the table and its constraint.
  const client = await testPool.connect();
  try {
    const { rows } = await client.query(`SELECT to_regclass('doctor_schedules') IS NOT NULL AS present`);
    assert.equal(rows[0].present, true, 'doctor_schedules must be restored after the rollback');
    const def = await constraintDefinition(client);
    assertRequiredDefinition(def);
  } finally {
    client.release();
  }
});

test('MIGRATION 055 | overlapping rows abort the migration and name the conflicting rows', async () => {
  await withTransaction(async (client) => {
    await client.query(`ALTER TABLE doctor_schedules DROP CONSTRAINT ${CONSTRAINT_NAME}`);

    const { rows: doctorRows } = await client.query(
      `SELECT u.user_id FROM users u
       JOIN roles r ON r.role_id = u.role_id
       WHERE r.role_name = 'DOCTOR' AND u.status = 'ACTIVE'
       ORDER BY u.user_id LIMIT 1`
    );
    const { rows: clinicRows } = await client.query('SELECT clinic_id FROM clinics ORDER BY clinic_id LIMIT 1');
    assert.ok(doctorRows.length && clinicRows.length, 'probe doctor and clinic must exist');
    const doctorId = doctorRows[0].user_id;
    const clinicId = clinicRows[0].clinic_id;

    const { rows: inserted } = await client.query(
      `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
       VALUES ($1, $2, 1, '09:00', '11:00', TRUE), ($1, $2, 1, '10:00', '12:00', TRUE)
       RETURNING schedule_id`,
      [doctorId, clinicId]
    );
    const ids = inserted.map((r: any) => String(r.schedule_id)).sort();

    const err = await runMigrationExpectingFailure(client);

    assert.equal(err.code, 'P0001', 'the migration must fail with a raised exception');
    assert.match(err.message, /overlapping schedule rows exist/, 'the message must report the overlap');
    for (const id of ids) {
      assert.ok(err.message.includes(id), `the message must name the conflicting schedule_id ${id}`);
    }
    assert.equal(
      await constraintDefinition(client),
      null,
      'no constraint may be installed over overlapping rows'
    );
  });
});

test('MIGRATION 055 | adjacent periods stay allowed and a real overlap stays rejected', async () => {
  await withTransaction(async (client) => {
    await runMigration(client);

    const { rows: doctorRows } = await client.query(
      `SELECT u.user_id FROM users u
       JOIN roles r ON r.role_id = u.role_id
       WHERE r.role_name = 'DOCTOR' AND u.status = 'ACTIVE'
       ORDER BY u.user_id LIMIT 1`
    );
    const { rows: clinicRows } = await client.query('SELECT clinic_id FROM clinics ORDER BY clinic_id LIMIT 1');
    const doctorId = doctorRows[0].user_id;
    const clinicId = clinicRows[0].clinic_id;

    await client.query('DELETE FROM doctor_schedules WHERE doctor_id = $1', [doctorId]);

    const insert = async (day: number, start: string, end: string) => {
      await client.query('SAVEPOINT ins');
      try {
        await client.query(
          `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
           VALUES ($1, $2, $3, $4, $5, TRUE)`,
          [doctorId, clinicId, day, start, end]
        );
        await client.query('RELEASE SAVEPOINT ins');
        return { ok: true };
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT ins');
        return { ok: false, code: err.code };
      }
    };

    const first = await insert(1, '09:00', '11:00');
    assert.ok(first.ok, 'the first period must be accepted');

    const adjacent = await insert(1, '11:00', '13:00');
    assert.ok(adjacent.ok, 'a period that starts when the previous one ends must stay allowed');

    const overlapping = await insert(1, '10:00', '12:00');
    assert.equal(overlapping.ok, false, 'a real overlap must be rejected');
    assert.equal(overlapping.code, '23P01', 'the overlap must be rejected by the exclusion constraint');
  });
});
