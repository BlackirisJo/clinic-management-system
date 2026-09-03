ALTER TABLE patients ADD COLUMN IF NOT EXISTS document_type VARCHAR(50);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_document_identity
    ON patients (document_type, document_number)
    WHERE document_type IS NOT NULL AND document_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS patient_sessions (
    session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    jti UUID UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_patient_sessions_active ON patient_sessions (patient_id, expires_at)
WHERE revoked_at IS NULL;