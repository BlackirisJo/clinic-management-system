-- استبدال حقول النص الحر (allergies / chronic_diseases) بجداول خيارات تفعيل:
-- مربع تفعيل (وجود الصف = ✓) لكل حساسية/مرض مزمن مع شدة المرض وتفاصيله
ALTER TABLE patient_medical_profiles DROP COLUMN IF EXISTS allergies;
ALTER TABLE patient_medical_profiles DROP COLUMN IF EXISTS chronic_diseases;

CREATE TABLE IF NOT EXISTS patient_allergies (
    allergy_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    allergen_key VARCHAR(50) NOT NULL,
    notes VARCHAR(500),
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (patient_id, allergen_key)
);

CREATE TABLE IF NOT EXISTS patient_chronic_conditions (
    condition_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    condition_key VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'UNSPECIFIED',
    notes VARCHAR(500),
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (patient_id, condition_key),
    CONSTRAINT patient_condition_severity_check
        CHECK (severity IN ('MILD', 'MODERATE', 'SEVERE', 'GESTATIONAL', 'TRANSIENT', 'UNSPECIFIED'))
);
