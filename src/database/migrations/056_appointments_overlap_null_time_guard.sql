-- 056: Scope the doctor-overlap exclusion constraint to timed appointments
--
-- WHY A NEW MIGRATION (and not an edit of 004)
-- 004_appointment_overlap_constraint.sql is already recorded in schema_migrations
-- on every existing database, so editing its text would leave existing databases
-- running the old constraint while new ones run the new one. This forward-only
-- migration replaces the constraint in place instead, so old and new databases
-- converge on exactly the same definition.
--
-- ROOT CAUSE
-- 004 builds the excluded range as:
--   tsrange((appointment_date + start_time), (appointment_date + end_time), '[)')
-- start_time/end_time are nullable (012_appointments_optional_times.sql allows
-- (NULL, NULL)), and (date + NULL) IS NULL, so tsrange(NULL, NULL) yields the
-- UNBOUNDED range '(,)'. An unbounded range overlaps every other range, so a
-- single appointment stored without times blocked EVERY later booking for that
-- doctor — including bookings on a completely different date — with 23P01.
--
-- FIX
-- Restrict the constraint to the rows that actually occupy a time slot, i.e.
-- rows whose start_time and end_time are both present. This mirrors the rule the
-- application layer already applies when it looks for conflicts
-- (appointments.controller.ts: "AND start_time IS NOT NULL AND end_time IS NOT
-- NULL") and when it computes booked slots (doctorSchedules.controller.ts skips
-- appointments without times). Appointments without times remain allowed by the
-- schema (012) and keep their meaning: they do not reserve a time slot, so
-- there is no interval for them to overlap.
--
-- SCOPE
-- - Schema-only. It never deletes, rewrites or backfills appointment data.
-- - The constraint is not weakened for timed appointments: the scope
--   (doctor_id, clinic_id), the '[)' range semantics (adjacent periods stay
--   allowed) and the "status <> 'CANCELLED'" rule are all unchanged. Two
--   overlapping timed appointments for the same doctor in the same clinic are
--   still rejected with 23P01.
-- - The new predicate is a strict subset of the old one, so the constraint can
--   only accept more existing rows than before: applying it can never fail on
--   data that the old constraint already accepted.

ALTER TABLE appointments
    DROP CONSTRAINT IF EXISTS appointments_no_doctor_overlap;

ALTER TABLE appointments
    ADD CONSTRAINT appointments_no_doctor_overlap
    EXCLUDE USING gist (
        doctor_id WITH =,
        clinic_id WITH =,
        tsrange(
            (appointment_date + start_time),
            (appointment_date + end_time),
            '[)'
        ) WITH &&
    )
    WHERE (status <> 'CANCELLED' AND start_time IS NOT NULL AND end_time IS NOT NULL);
