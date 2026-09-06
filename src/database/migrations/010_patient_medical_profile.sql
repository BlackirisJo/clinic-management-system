-- ملف البيانات الطبية التكميلية للمريض (يكمله الطبيب بعد إدخال المريض)
-- سجل واحد لكل مريض، ويُحدَّث عبر UPSERT باستخدام القيد الفريد على patient_id
CREATE TABLE IF NOT EXISTS patient_medical_profiles (
    profile_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL UNIQUE REFERENCES patients(patient_id) ON DELETE CASCADE,
    blood_type VARCHAR(5),
    allergies TEXT,
    chronic_diseases TEXT,
    current_medications TEXT,
    medical_notes TEXT,
    updated_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
