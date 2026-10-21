-- 059: Appointment calendar gate (holidays and doctor leave)
--
-- WHY A NEW MIGRATION (and not an edit of 003/004/012/056)
-- Every one of those files is already recorded in schema_migrations on every
-- existing database, so editing its text would leave existing databases running
-- the old rule while new ones run the new one. This forward-only migration
-- installs the rule in place, so old and new databases converge on exactly the
-- same behaviour.
--
-- WHAT IT ENFORCES
-- Two of the three booking gates become a DATABASE rule, so that no writer can
-- bypass them: not the HTTP layer, not an import script, not a manual INSERT.
--
--   1. APPROVED doctor leave      -> the date is closed for that doctor, in
--                                     that clinic. Absolute: no work exception
--                                     can open it.
--   2. ACTIVE official holiday    -> the date is closed for that clinic (or for
--                                     the whole network when clinic_id IS NULL),
--                                     UNLESS an APPROVED work exception exists
--                                     for that doctor in that clinic.
--
-- The third gate — "the slot is inside the doctor's weekly schedule" — stays in
-- the application layer: a weekly pattern is a business rule, not a hard
-- invariant, and it is already checked by the booking endpoint.
--
-- PRIORITY (one rule, one place)
--   LEAVE  >  HOLIDAY  >  WORK EXCEPTION  >  weekly schedule  >  slot overlap
-- The personal leave outranks the work exception, so a work exception can never
-- silently cancel a leave. The same rule is also checked when an exception is
-- created or approved (trg_work_exceptions_leave_guard below), because an
-- approval can happen before or after a booking and the booking-time check
-- alone would be too late.
--
-- SCOPE
-- - The trigger fires on INSERT always, and on UPDATE only when the slot
--   identity changes (date, doctor, clinic, start or end time). A status-only
--   update (SCHEDULED -> CONFIRMED -> COMPLETED, or a cancellation) is NOT
--   gated: an appointment that already exists inside a holiday must stay
--   operable, otherwise it could not be completed or cancelled.
-- - The gate is a DATE-level rule: an appointment without a time still books a
--   day, so it is gated too. (Slot-level overlap is a different rule and stays
--   with appointments_no_doctor_overlap from 056.)
-- - The rule never deletes or cancels an appointment. It only refuses to
--   create or move one.
--
-- ERRORS
--   CL001 = the date is closed (booking refused)
--   CL002 = a work exception would override an approved leave (refused)
-- Both are plain, stable SQLSTATE codes; the API maps them to HTTP 409.

-- =============================================================
-- 1) The gate itself — one function, used by the trigger, by the
--    availability endpoint and by the impact preview, so that all three
--    always agree.
-- =============================================================
CREATE OR REPLACE FUNCTION calendar_gate(p_clinic_id int, p_doctor_id int, p_date date)
RETURNS TABLE (is_blocked boolean, code text, detail text)
LANGUAGE sql
STABLE
AS $$
    WITH leave_hit AS (
        SELECT l.leave_id
        FROM doctor_leave l
        WHERE l.doctor_id = p_doctor_id
          AND l.clinic_id = p_clinic_id
          AND l.status = 'APPROVED'
          AND l.start_date <= p_date
          AND l.end_date >= p_date
        LIMIT 1
    ),
    holiday_hit AS (
        SELECT h.holiday_id, h.name_ar, h.clinic_id
        FROM clinic_holidays h
        WHERE h.status = 'ACTIVE'
          AND h.holiday_date = p_date
          AND (h.clinic_id IS NULL OR h.clinic_id = p_clinic_id)
        ORDER BY h.clinic_id NULLS LAST   -- a clinic-specific holiday is more specific
        LIMIT 1
    ),
    exception_hit AS (
        SELECT e.exception_id
        FROM work_exceptions e
        WHERE e.status = 'APPROVED'
          AND e.doctor_id = p_doctor_id
          AND e.clinic_id = p_clinic_id
          AND e.exception_date = p_date
        LIMIT 1
    )
    SELECT
        CASE
            WHEN EXISTS (SELECT 1 FROM leave_hit) THEN TRUE
            WHEN EXISTS (SELECT 1 FROM holiday_hit)
                 AND NOT EXISTS (SELECT 1 FROM exception_hit) THEN TRUE
            ELSE FALSE
        END AS is_blocked,
        CASE
            WHEN EXISTS (SELECT 1 FROM leave_hit) THEN 'LEAVE'
            WHEN EXISTS (SELECT 1 FROM holiday_hit)
                 AND NOT EXISTS (SELECT 1 FROM exception_hit) THEN 'HOLIDAY'
            ELSE NULL
        END AS code,
        CASE
            WHEN EXISTS (SELECT 1 FROM leave_hit)
                THEN 'approved doctor leave covers this date'
            WHEN EXISTS (SELECT 1 FROM holiday_hit)
                 AND NOT EXISTS (SELECT 1 FROM exception_hit)
                THEN 'official holiday covers this date'
            ELSE NULL
        END AS detail;
$$;

COMMENT ON FUNCTION calendar_gate(int, int, date) IS
    'Booking gate for a (clinic, doctor, date) triple. Returns is_blocked, code (LEAVE|HOLIDAY) and detail. Priority: leave > holiday > work exception.';

-- =============================================================
-- 2) The trigger that enforces the gate on appointments
-- =============================================================
CREATE OR REPLACE FUNCTION trg_appointments_calendar_gate_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    gate_result RECORD;
BEGIN
    -- Only a change of the slot identity is gated. A status change on an
    -- appointment that already exists must stay possible, otherwise an
    -- appointment created before a holiday was declared could never be
    -- confirmed, completed or cancelled.
    IF TG_OP = 'UPDATE' THEN
        IF NOT (
               NEW.appointment_date IS DISTINCT FROM OLD.appointment_date
            OR NEW.doctor_id         IS DISTINCT FROM OLD.doctor_id
            OR NEW.clinic_id         IS DISTINCT FROM OLD.clinic_id
            OR NEW.start_time        IS DISTINCT FROM OLD.start_time
            OR NEW.end_time          IS DISTINCT FROM OLD.end_time
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    SELECT * INTO gate_result
    FROM calendar_gate(NEW.clinic_id, NEW.doctor_id, NEW.appointment_date);

    IF gate_result.is_blocked THEN
        RAISE EXCEPTION USING
            ERRCODE = 'CL001',
            MESSAGE = 'booking refused: the date is closed by the clinic calendar',
            DETAIL = gate_result.code || ': ' || gate_result.detail;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_appointments_calendar_gate ON appointments;

CREATE TRIGGER trg_appointments_calendar_gate
    BEFORE INSERT OR UPDATE ON appointments
    FOR EACH ROW
    EXECUTE FUNCTION trg_appointments_calendar_gate_fn();

-- =============================================================
-- 3) A work exception can never override an approved leave
--    Checked when the exception is created and when it is approved, so the
--    conflict can never enter the table in the first place.
-- =============================================================
CREATE OR REPLACE FUNCTION trg_work_exceptions_leave_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    needs_check BOOLEAN := FALSE;
    leave_row RECORD;
BEGIN
    IF NEW.status = 'APPROVED' THEN
        IF TG_OP = 'INSERT' THEN
            needs_check := TRUE;
        ELSIF OLD.status IS DISTINCT FROM 'APPROVED' THEN
            needs_check := TRUE;
        END IF;
    END IF;

    IF needs_check THEN
        SELECT l.leave_id, l.start_date, l.end_date INTO leave_row
        FROM doctor_leave l
        WHERE l.doctor_id = NEW.doctor_id
          AND l.clinic_id = NEW.clinic_id
          AND l.status = 'APPROVED'
          AND l.start_date <= NEW.exception_date
          AND l.end_date >= NEW.exception_date
        LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION USING
                ERRCODE = 'CL002',
                MESSAGE = 'work exception refused: it would override an approved doctor leave',
                DETAIL = 'leave_id=' || leave_row.leave_id
                         || ', leave=' || leave_row.start_date || '..' || leave_row.end_date
                         || ', exception_date=' || NEW.exception_date;
        END IF;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_exceptions_leave_guard ON work_exceptions;

CREATE TRIGGER trg_work_exceptions_leave_guard
    BEFORE INSERT OR UPDATE ON work_exceptions
    FOR EACH ROW
    EXECUTE FUNCTION trg_work_exceptions_leave_guard_fn();
