-- 058: Official holiday calendar, doctor leave, work exceptions, change log
--
-- WHY
-- The schema had no notion of a closed day at all: doctor_schedules only
-- describes the weekly pattern, appointments only know their date. Nothing
-- could express "the clinic is officially closed on this date", "this doctor is
-- on leave", or "this doctor is explicitly allowed to work on that closed day".
-- Migration 059 adds the enforcement; this migration adds the data the
-- enforcement reads.
--
-- DESIGN RULES ENCODED HERE
-- 1. A holiday is scoped either to one clinic (clinic_id) or to the whole
--    network (clinic_id IS NULL = national). One table, two scopes.
-- 2. Cancellation is a state change (status='CANCELLED' + who/when/why), never
--    a DELETE: the effect stops immediately while the history stays auditable.
-- 3. Only ACTIVE rows are unique per (scope, date), so a cancelled holiday can
--    be declared again on the same date without a duplicate.
-- 4. A doctor leave is per (doctor, clinic): a doctor may work in several
--    clinics (clinic_staff) and each clinic has its own leave register.
-- 5. A work exception is the ONLY thing that can open a holiday, and it can
--    never override an approved leave (enforced in 059 by a trigger).
-- 6. Every change is recorded with WHO performed it, WHAT was decided, WHEN,
--    and the notification status. There is no notification channel in this
--    system, so the only honest notification state is a manual contact task:
--    the table deliberately forbids any other channel (see the CHECK below).
--
-- SCOPE / SAFETY
-- - Additive only. No existing table is altered and no existing row is touched.
-- - Idempotent: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING/UPDATE, in
--   the same style as 028/030/054.
-- - This migration does NOT install any enforcement. Until 059 is applied the
--   new tables are inert records; after 059 they become the source of truth
--   for the booking gate.

-- =============================================================
-- 1) Official holidays
-- =============================================================
CREATE TABLE IF NOT EXISTS clinic_holidays (
    holiday_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    holiday_date DATE NOT NULL,
    -- NULL = national holiday: applies to every clinic in the network.
    clinic_id INT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    name_ar VARCHAR(150) NOT NULL,
    name_en VARCHAR(150),
    holiday_type VARCHAR(20) NOT NULL DEFAULT 'OFFICIAL',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    CONSTRAINT clinic_holidays_type_check
        CHECK (holiday_type IN ('OFFICIAL', 'EMERGENCY', 'MAINTENANCE')),
    CONSTRAINT clinic_holidays_status_check
        CHECK (status IN ('ACTIVE', 'CANCELLED'))
);

-- Uniqueness applies to live holidays only, per scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clinic_holidays_national
    ON clinic_holidays (holiday_date)
    WHERE clinic_id IS NULL AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinic_holidays_clinic
    ON clinic_holidays (clinic_id, holiday_date)
    WHERE clinic_id IS NOT NULL AND status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_clinic_holidays_date
    ON clinic_holidays (holiday_date)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_clinic_holidays_clinic_date
    ON clinic_holidays (clinic_id, holiday_date)
    WHERE status = 'ACTIVE';

-- =============================================================
-- 2) Doctor personal leave
-- =============================================================
CREATE TABLE IF NOT EXISTS doctor_leave (
    leave_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doctor_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    leave_type VARCHAR(20) NOT NULL DEFAULT 'ANNUAL',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    reason TEXT,
    requested_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    approved_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    decision_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT doctor_leave_dates_check CHECK (end_date >= start_date),
    CONSTRAINT doctor_leave_type_check
        CHECK (leave_type IN ('ANNUAL', 'SICK', 'UNPAID', 'OTHER')),
    CONSTRAINT doctor_leave_status_check
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doctor_leave_approved
    ON doctor_leave (doctor_id, clinic_id, start_date, end_date)
    WHERE status = 'APPROVED';

-- The hot path of the booking gate: "is this doctor on leave on this date?".
CREATE INDEX IF NOT EXISTS idx_doctor_leave_approved_range
    ON doctor_leave (doctor_id, clinic_id, start_date, end_date)
    WHERE status = 'APPROVED';

CREATE INDEX IF NOT EXISTS idx_doctor_leave_clinic_range
    ON doctor_leave (clinic_id, start_date, end_date);

-- =============================================================
-- 3) Explicit work exceptions (the only way a holiday can be worked through)
-- =============================================================
CREATE TABLE IF NOT EXISTS work_exceptions (
    exception_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    doctor_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    -- The holiday this exception opens, when there is one. NULL means the
    -- exception simply declares an extra working day.
    holiday_id INT NULL REFERENCES clinic_holidays(holiday_id) ON DELETE SET NULL,
    exception_date DATE NOT NULL,
    -- NULL = no dedicated window: the weekly schedule still defines the hours.
    start_time TIME NULL,
    end_time TIME NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    reason TEXT NOT NULL,
    requested_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    approved_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    cancelled_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    cancelled_at TIMESTAMPTZ,
    decision_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT work_exceptions_status_check
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT work_exceptions_time_check CHECK (
        (start_time IS NULL AND end_time IS NULL) OR
        (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_exceptions_approved
    ON work_exceptions (clinic_id, doctor_id, exception_date)
    WHERE status = 'APPROVED';

CREATE INDEX IF NOT EXISTS idx_work_exceptions_approved_date
    ON work_exceptions (clinic_id, doctor_id, exception_date)
    WHERE status = 'APPROVED';

-- =============================================================
-- 4) Change log: who decided what, when, and the notification state
-- =============================================================
CREATE TABLE IF NOT EXISTS calendar_changes (
    change_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    change_type VARCHAR(30) NOT NULL,
    entity_type VARCHAR(30) NOT NULL,
    entity_id INT NOT NULL,
    clinic_id INT NULL REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    from_date DATE NULL,
    to_date DATE NULL,
    decision VARCHAR(20) NULL,
    impact_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    performed_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notification_status VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUIRED',
    CONSTRAINT calendar_changes_decision_check
        CHECK (decision IS NULL OR decision IN ('PROPOSED', 'CONFIRMED', 'CANCELLED', 'REJECTED')),
    CONSTRAINT calendar_changes_notification_status_check
        CHECK (notification_status IN ('NOT_REQUIRED', 'PENDING_CONTACT', 'ACKNOWLEDGED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_changes_entity
    ON calendar_changes (entity_type, entity_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_calendar_changes_clinic
    ON calendar_changes (clinic_id, performed_at DESC);

-- =============================================================
-- 5) Notification tasks
--    The system has no delivery channel (no SMS / e-mail / push anywhere in
--    the code base), so a notification is a MANUAL contact task owned by the
--    staff. The channel CHECK forbids recording a delivery that did not happen:
--    a row can only say "a contact task exists and was / was not acknowledged".
-- =============================================================
CREATE TABLE IF NOT EXISTS calendar_change_notifications (
    notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    change_id BIGINT NOT NULL REFERENCES calendar_changes(change_id) ON DELETE CASCADE,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    appointment_id INT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    patient_id INT NULL REFERENCES patients(patient_id) ON DELETE SET NULL,
    doctor_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_CONTACT',
    note TEXT,
    created_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMPTZ,
    CONSTRAINT calendar_change_notifications_channel_check CHECK (channel = 'MANUAL'),
    CONSTRAINT calendar_change_notifications_status_check
        CHECK (status IN ('PENDING_CONTACT', 'ACKNOWLEDGED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_change_notifications_status
    ON calendar_change_notifications (clinic_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calendar_change_notifications_change
    ON calendar_change_notifications (change_id);

-- =============================================================
-- 6) Permissions
-- =============================================================
INSERT INTO permissions (permission_key, permission_group, description) VALUES
    ('VIEW_HOLIDAYS',            'Scheduling', 'عرض تقويم العطل الرسمية وإجازات الأطباء واستثناءات العمل'),
    ('MANAGE_HOLIDAYS',          'Scheduling', 'إنشاء وتعديل ونقل العطل الرسمية (دون اعتماد)'),
    ('APPROVE_HOLIDAYS',         'Scheduling', 'اعتماد وإلغاء العطل الرسمية'),
    ('VIEW_DOCTOR_LEAVE',        'Scheduling', 'عرض إجازات الأطباء'),
    ('MANAGE_DOCTOR_LEAVE',      'Scheduling', 'طلب وتعديل إجازات الأطباء (دون اعتماد)'),
    ('APPROVE_DOCTOR_LEAVE',     'Scheduling', 'اعتماد ورفض إجازات الأطباء'),
    ('MANAGE_WORK_EXCEPTIONS',   'Scheduling', 'طلب استثناء العمل في يوم عطلة'),
    ('APPROVE_WORK_EXCEPTIONS',  'Scheduling', 'اعتماد وإلغاء استثناءات العمل'),
    ('VIEW_SCHEDULE_IMPACT',     'Scheduling', 'معاينة أثر تغييرات التقويم على المواعيد القائمة')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

-- Read access: doctors and receptionists see the calendar and the impact.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name IN ('DOCTOR', 'RECEPTIONIST')
  AND p.permission_key IN ('VIEW_HOLIDAYS', 'VIEW_DOCTOR_LEAVE', 'VIEW_SCHEDULE_IMPACT')
ON CONFLICT DO NOTHING;

-- A doctor may request a leave for himself; reception may request for the
-- doctors of the clinics they are assigned to.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name IN ('DOCTOR', 'RECEPTIONIST')
  AND p.permission_key = 'MANAGE_DOCTOR_LEAVE'
ON CONFLICT DO NOTHING;

-- Reception proposes holidays and work exceptions; it does not approve them.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name = 'RECEPTIONIST'
  AND p.permission_key IN ('MANAGE_HOLIDAYS', 'MANAGE_WORK_EXCEPTIONS')
ON CONFLICT DO NOTHING;

-- Approval rights sit with the administrative roles. requirePermission() lets
-- SUPER_ADMIN and SYSTEM_ADMIN through unconditionally, so the separation
-- between "manage" and "approve" is additionally enforced in the controller
-- (the requester may never approve their own request).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key IN (
      'VIEW_HOLIDAYS', 'MANAGE_HOLIDAYS', 'APPROVE_HOLIDAYS',
      'VIEW_DOCTOR_LEAVE', 'MANAGE_DOCTOR_LEAVE', 'APPROVE_DOCTOR_LEAVE',
      'MANAGE_WORK_EXCEPTIONS', 'APPROVE_WORK_EXCEPTIONS',
      'VIEW_SCHEDULE_IMPACT'
  )
ON CONFLICT DO NOTHING;
