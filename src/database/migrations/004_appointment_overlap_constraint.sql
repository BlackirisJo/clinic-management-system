CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments
    DROP CONSTRAINT IF EXISTS appointments_no_doctor_overlap;

ALTER TABLE appointments
    ADD CONSTRAINT appointments_no_doctor_overlap
    EXCLUDE USING gist (
        doctor_id WITH =,
        clinic_id WITH =,
        tsrange(
            (appointment_date + start_time)::timestamp,
            (appointment_date + end_time)::timestamp,
            '[)'
        ) WITH &&
    )
    WHERE (status <> 'CANCELLED');