-- 055: Verify and repair the doctor_schedules overlap exclusion constraint
--
-- Forward-only repair. Guarantees that doctor_schedules_no_overlap exists on
-- doctor_schedules with EXACTLY the required definition:
--   scope      : doctor_id, clinic_id, day_of_week
--   range      : tsrange(DATE '2000-01-01' + start_time, ... end_time, '[)')
--   operator   : && (overlap) — adjacent periods are allowed
--   filter     : is_working_day = TRUE (non-working days are not constrained)
--
-- WHY A NEW MIGRATION FILE (and not an edit of 054)
-- 054_doctor_schedules.sql is already recorded in schema_migrations on every
-- existing database, so editing its text would leave existing databases running
-- the old constraint while new ones run the new one. This file repairs the
-- constraint in place instead, so both converge on the same definition.
--
-- HOW THE DEFINITION IS VERIFIED (not just the name)
-- The old version only asked "is there a constraint NAMED doctor_schedules_no_overlap?"
-- and therefore accepted a constraint whose definition was wrong. This version
-- renders the required definition with the SAME PostgreSQL instance (on an empty
-- scratch table cloned from doctor_schedules) and compares it, byte for byte,
-- with pg_get_constraintdef() of the live constraint. Both sides come from one
-- deparser, so the comparison cannot be fooled by spelling and cannot drift
-- between PostgreSQL versions.
--
-- A constraint that exists under the expected name but with a different
-- definition is NOT silently accepted: it is reported and explicitly replaced
-- by the correct one, and the replacement is refused when the existing data
-- would not satisfy it (the preflight overlap check below).
--
-- Because PostgreSQL rejects a GiST index expression that is not IMMUTABLE,
-- the existence of this index also proves the time range is a constant,
-- IMMUTABLE expression (now()/date_trunc()/CURRENT_DATE can never be in it).
--
-- Never alters or deletes schedule data. Before (re)creating the constraint it
-- runs a preflight overlap check; if overlapping working-period rows exist it
-- aborts and reports the conflicting schedule_id values so they can be
-- resolved first.
--
-- The whole repair runs inside ONE DO block, so it is atomic even when the
-- migration is executed without an outer transaction: either the constraint
-- ends up correct, or the migration fails and the database is untouched.

-- Ensure btree_gist is available for scalar = operators in the GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  table_oid   regclass;
  live_oid    oid;
  ref_oid     oid;
  live_def    text;
  ref_def     text;
  overlap_ids text;
  missing_cols text;
BEGIN
  ------------------------------------------------------------------
  -- 1. The table must exist. The migration that creates it (054) has to be
  --    applied first. Never create a substitute table and never swallow the
  --    error: the migration stops here with an explicit message.
  ------------------------------------------------------------------
  table_oid := to_regclass('doctor_schedules');
  IF table_oid IS NULL THEN
    RAISE EXCEPTION
      'Cannot apply 055_doctor_schedule_overlap_constraint.sql: table doctor_schedules does not exist. '
      'Apply 054_doctor_schedules.sql first, then re-run this migration.';
  END IF;

  ------------------------------------------------------------------
  -- 2. The columns the constraint is built on must be present.
  ------------------------------------------------------------------
  SELECT string_agg(missing, ', ' ORDER BY missing)
  INTO missing_cols
  FROM unnest(ARRAY['doctor_id','clinic_id','day_of_week','start_time','end_time','is_working_day']) AS missing
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = table_oid
      AND a.attname = missing
      AND a.attnum > 0
      AND NOT a.attisdropped
  );

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot apply 055_doctor_schedule_overlap_constraint.sql: doctor_schedules is missing required column(s): %. '
      'Apply 054_doctor_schedules.sql first, then re-run this migration.', missing_cols;
  END IF;

  ------------------------------------------------------------------
  -- 3. Render the REQUIRED definition with this same PostgreSQL instance on
  --    an empty scratch table, so the comparison below is exact and immune to
  --    deparser differences between PostgreSQL versions. The scratch table is
  --    temporary and is removed when this transaction ends.
  ------------------------------------------------------------------
  IF to_regclass('pg_temp.doctor_schedules_defcheck') IS NOT NULL THEN
    EXECUTE 'DROP TABLE pg_temp.doctor_schedules_defcheck';
  END IF;
  CREATE TEMP TABLE doctor_schedules_defcheck (LIKE doctor_schedules) ON COMMIT DROP;
  ALTER TABLE doctor_schedules_defcheck
    ADD CONSTRAINT doctor_schedules_no_overlap
    EXCLUDE USING gist (
      doctor_id WITH =,
      clinic_id WITH =,
      day_of_week WITH =,
      tsrange(
        (DATE '2000-01-01' + start_time)::timestamp,
        (DATE '2000-01-01' + end_time)::timestamp,
        '[)'
      ) WITH &&
    )
    WHERE (is_working_day = TRUE);

  SELECT c.oid INTO ref_oid
  FROM pg_constraint c
  WHERE c.conrelid = 'doctor_schedules_defcheck'::regclass
    AND c.conname = 'doctor_schedules_no_overlap';

  SELECT pg_get_constraintdef(ref_oid) INTO ref_def;

  ------------------------------------------------------------------
  -- 4. Look the live constraint up and compare its ACTUAL definition.
  ------------------------------------------------------------------
  SELECT c.oid INTO live_oid
  FROM pg_constraint c
  WHERE c.conrelid = table_oid
    AND c.conname = 'doctor_schedules_no_overlap';

  IF live_oid IS NOT NULL THEN
    SELECT pg_get_constraintdef(live_oid) INTO live_def;

    IF live_def = ref_def THEN
      RAISE NOTICE
        '055: doctor_schedules_no_overlap already exists with the expected definition — verified, nothing to do.';
      RETURN;
    END IF;

    RAISE NOTICE
      '055: doctor_schedules_no_overlap exists with a DIFFERENT definition and is being replaced. Old: %  New: %',
      live_def, ref_def;

    ALTER TABLE doctor_schedules DROP CONSTRAINT doctor_schedules_no_overlap;
  END IF;

  ------------------------------------------------------------------
  -- 5. Preflight: detect existing overlapping working-period rows under the
  --    semantics of the constraint that is about to be installed. If any
  --    overlap exists, abort and report the conflicting schedule_id values
  --    instead of installing a constraint over dirty data.
  ------------------------------------------------------------------
  SELECT string_agg(a.schedule_id::text, ', ' ORDER BY a.schedule_id)
  INTO overlap_ids
  FROM doctor_schedules a
  JOIN doctor_schedules b
    ON a.doctor_id = b.doctor_id
   AND a.clinic_id = b.clinic_id
   AND a.day_of_week = b.day_of_week
   AND a.schedule_id <> b.schedule_id
   AND a.is_working_day = TRUE
   AND b.is_working_day = TRUE
   AND (DATE '2000-01-01' + a.start_time)::timestamp
       < (DATE '2000-01-01' + b.end_time)::timestamp
   AND (DATE '2000-01-01' + b.start_time)::timestamp
       < (DATE '2000-01-01' + a.end_time)::timestamp;

  IF overlap_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot add doctor_schedules_no_overlap: overlapping schedule rows exist (schedule_id: %). '
      'Resolve overlaps before re-running this migration.', overlap_ids;
  END IF;

  ------------------------------------------------------------------
  -- 6. Install the verified constraint.
  ------------------------------------------------------------------
  ALTER TABLE doctor_schedules
    ADD CONSTRAINT doctor_schedules_no_overlap
    EXCLUDE USING gist (
      doctor_id WITH =,
      clinic_id WITH =,
      day_of_week WITH =,
      tsrange(
        (DATE '2000-01-01' + start_time)::timestamp,
        (DATE '2000-01-01' + end_time)::timestamp,
        '[)'
      ) WITH &&
    )
    WHERE (is_working_day = TRUE);

  RAISE NOTICE '055: doctor_schedules_no_overlap was created with the verified definition.';
END $$;
