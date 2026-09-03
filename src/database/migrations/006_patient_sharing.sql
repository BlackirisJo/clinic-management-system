CREATE TABLE IF NOT EXISTS patient_clinic_shares (
    share_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    owner_clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    target_clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    access_level VARCHAR(10) NOT NULL DEFAULT 'READ',
    status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    expires_at TIMESTAMPTZ NOT NULL,
    created_by_user_id INT NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT patient_share_different_clinics CHECK (owner_clinic_id <> target_clinic_id),
    CONSTRAINT patient_share_access_check CHECK (access_level IN ('READ', 'WRITE')),
    CONSTRAINT patient_share_status_check CHECK (status IN ('ACTIVE', 'REVOKED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_patient_share
    ON patient_clinic_shares (patient_id, target_clinic_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_patient_shares_target
    ON patient_clinic_shares (patient_id, target_clinic_id, expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    clinic_id INT REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(100),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);