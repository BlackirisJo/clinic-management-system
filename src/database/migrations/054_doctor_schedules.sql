-- 054: Doctor working schedules
-- Configurable weekly working hours for each doctor per clinic

CREATE TABLE IF NOT EXISTS doctor_schedules (
    schedule_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doctor_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_working_day BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT doctor_schedules_time_order CHECK (end_time > start_time)
);

-- Enable btree_gist for exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Exclude overlapping working periods for the same doctor/clinic/day
ALTER TABLE doctor_schedules
    DROP CONSTRAINT IF EXISTS doctor_schedules_no_overlap;

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

-- Index for efficient querying by doctor and clinic
CREATE INDEX IF NOT EXISTS idx_doctor_schedules_doctor_clinic
    ON doctor_schedules (doctor_id, clinic_id);

-- Index for querying schedules by clinic and day (for calendar views)
CREATE INDEX IF NOT EXISTS idx_doctor_schedules_clinic_day
    ON doctor_schedules (clinic_id, day_of_week) WHERE is_working_day = TRUE;

-- Permissions for doctor schedules
INSERT INTO permissions (permission_key, permission_group, description) VALUES
    ('MANAGE_DOCTOR_SCHEDULES', 'Scheduling', 'إنشاء وتعديل وحذف جداول عمل الأطباء'),
    ('VIEW_DOCTOR_SCHEDULES', 'Scheduling', 'عرض جداول عمل الأطباء والتوفر')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r, permissions p
WHERE r.role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN') AND p.permission_key IN ('MANAGE_DOCTOR_SCHEDULES', 'VIEW_DOCTOR_SCHEDULES')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r, permissions p
WHERE r.role_name = 'DOCTOR' AND p.permission_key = 'VIEW_DOCTOR_SCHEDULES'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r, permissions p
WHERE r.role_name = 'RECEPTIONIST' AND p.permission_key IN ('MANAGE_DOCTOR_SCHEDULES', 'VIEW_DOCTOR_SCHEDULES')
ON CONFLICT DO NOTHING;