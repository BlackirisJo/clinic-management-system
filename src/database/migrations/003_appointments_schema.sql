CREATE TABLE IF NOT EXISTS appointments (
    appointment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    patient_id INT NOT NULL REFERENCES patients(patient_id),
    doctor_id INT NOT NULL REFERENCES users(user_id),
    appointment_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    reason TEXT,
    notes TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT appointments_time_order CHECK (end_time > start_time),
    CONSTRAINT appointments_status_check CHECK (status IN ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
);

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date
    ON appointments (doctor_id, appointment_date, start_time);