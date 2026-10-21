-- 057: Clinic time zone
--
-- WHY
-- The schema stores wall-clock time only:
--   doctor_schedules.start_time / end_time  -> TIME  (no zone)
--   appointments.appointment_date + times   -> DATE + TIME (no zone)
-- Nothing in the schema records which time zone that wall clock belongs to, so
-- "now" and "today" cannot be interpreted for a clinic, and any conversion
-- performed in Node would silently depend on the server process time zone.
--
-- WHAT
-- 1. clinics.timezone (IANA name, e.g. 'Asia/Amman') — the explicit, per-clinic
--    statement of the wall clock the clinic operates in.
-- 2. system_settings['default_timezone'] — the fallback used when a clinic row
--    predates this migration (and for new clinics created without an explicit
--    value).
--
-- WHY 'Asia/Amman' as the default
-- The system base currency is JOD (migration 023, system_settings.base_currency),
-- so the deployment's default wall clock is Jordan local time. The value is a
-- plain column: it can be changed per clinic at any time without a data rewrite.
--
-- SCOPE / SAFETY
-- - Additive only: no row is deleted, no existing column is altered or dropped.
-- - The column is added as NULL first, backfilled, then set NOT NULL, so the
--   migration works the same on a fresh and on a populated database and never
--   rewrites the table with a table-lock + full scan.
-- - The value is validated in the application layer (pg_timezone_names /
--   Intl.supportedValuesOf('timeZone')). A CHECK constraint cannot reference a
--   system catalogue, so no CHECK is added here.
--
-- NOTE ON day_of_week
-- The time zone does NOT change how the day of week is computed for a given
-- calendar date: a DATE has no zone, so the day of week of a date is the same
-- everywhere. The application computes it with EXTRACT(DOW FROM date) instead
-- of new Date(date).getDay(), which depended on the Node process time zone.

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);

INSERT INTO system_settings (key, value, description)
VALUES ('default_timezone', 'Asia/Amman', 'Default clinic wall-clock time zone (IANA name)')
ON CONFLICT (key) DO NOTHING;

UPDATE clinics
SET timezone = COALESCE(
      NULLIF(BTRIM(timezone), ''),
      (SELECT value FROM system_settings WHERE key = 'default_timezone'),
      'Asia/Amman'
    )
WHERE timezone IS NULL OR BTRIM(timezone) = '';

ALTER TABLE clinics
    ALTER COLUMN timezone SET DEFAULT 'Asia/Amman',
    ALTER COLUMN timezone SET NOT NULL;
