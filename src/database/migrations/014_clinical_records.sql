-- 014: البيانات الطبية المشتركة لجميع العيادات (تسجل داخل كل زيارة)
-- 1) توسيع جدول الزيارات بحقول سير العمل السريري (إضافة فقط دون تغيير الموجود)
ALTER TABLE visits ADD COLUMN IF NOT EXISTS chief_complaint TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS clinical_examination TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS assessment TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS treatment_plan TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS follow_up_plan TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS next_visit_date TIMESTAMPTZ;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS disposition VARCHAR(30);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triage_level INT CONSTRAINT visits_triage_level_check CHECK (triage_level BETWEEN 1 AND 5);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS visit_status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CONSTRAINT visits_status_check CHECK (visit_status IN ('OPEN', 'COMPLETED', 'CANCELLED'));
-- الزيارات القديمة المسجلة قبل التحديث تعتبر مكتملة
UPDATE visits SET visit_status = 'COMPLETED' WHERE visit_status = 'OPEN' AND visit_date < NOW() - INTERVAL '24 hours';
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits (visit_status);

-- 2) العلامات الحيوية (قياسات يمكن تسجيل أكثر من مجموعة في نفس الزيارة)
CREATE TABLE IF NOT EXISTS vital_signs (
    vital_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id INT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    weight_kg NUMERIC(5, 2),
    height_cm NUMERIC(5, 2),
    systolic INT,
    diastolic INT,
    pulse INT,
    temperature NUMERIC(4, 1),
    respiratory_rate INT,
    spo2 INT,
    pain_score INT CONSTRAINT vital_pain_score_check CHECK (pain_score BETWEEN 0 AND 10),
    notes TEXT,
    recorded_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vital_bp_check CHECK ((systolic IS NULL AND diastolic IS NULL) OR (systolic IS NOT NULL AND diastolic IS NOT NULL AND systolic >= diastolic))
);
CREATE INDEX IF NOT EXISTS idx_vital_signs_visit ON vital_signs (visit_id);

-- 3) التشخيصات المرتبطة بالزيارة
CREATE TABLE IF NOT EXISTS visit_diagnoses (
    diagnosis_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id INT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    icd_code VARCHAR(20),
    description TEXT NOT NULL,
    diagnosis_type VARCHAR(20) NOT NULL DEFAULT 'PRIMARY' CONSTRAINT visit_diagnosis_type_check CHECK (diagnosis_type IN ('PRIMARY', 'SECONDARY', 'DIFFERENTIAL')),
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visit_diagnoses_visit ON visit_diagnoses (visit_id);

-- 4) طلبات المختبر ونتائجها
CREATE TABLE IF NOT EXISTS lab_orders (
    order_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id INT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    test_name VARCHAR(200) NOT NULL,
    category VARCHAR(50),
    priority VARCHAR(10) NOT NULL DEFAULT 'ROUTINE' CONSTRAINT lab_priority_check CHECK (priority IN ('ROUTINE', 'URGENT', 'STAT')),
    status VARCHAR(20) NOT NULL DEFAULT 'ORDERED' CONSTRAINT lab_status_check CHECK (status IN ('ORDERED', 'COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    notes TEXT,
    ordered_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_visit ON lab_orders (visit_id);

CREATE TABLE IF NOT EXISTS lab_results (
    result_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INT NOT NULL REFERENCES lab_orders(order_id) ON DELETE CASCADE,
    analyte VARCHAR(200) NOT NULL,
    result_value VARCHAR(200),
    unit VARCHAR(50),
    reference_range VARCHAR(100),
    is_abnormal BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    resulted_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    resulted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lab_results_order ON lab_results (order_id);

-- 5) التصوير والفحوصات التشخيصية (أشعة/سونار عام/ECG...)
CREATE TABLE IF NOT EXISTS imaging_orders (
    imaging_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id INT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    modality VARCHAR(20) NOT NULL CONSTRAINT imaging_modality_check CHECK (modality IN ('XRAY', 'ULTRASOUND', 'CT', 'MRI', 'ECG', 'OTHER')),
    body_part VARCHAR(100),
    findings TEXT,
    impression TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'ORDERED' CONSTRAINT imaging_status_check CHECK (status IN ('ORDERED', 'COMPLETED', 'CANCELLED')),
    ordered_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    performed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_imaging_orders_visit ON imaging_orders (visit_id);

-- 6) الإحالات بين العيادات والتخصصات
CREATE TABLE IF NOT EXISTS referrals (
    referral_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id INT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    from_clinic_id INT REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    to_clinic_id INT REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    to_specialty_id INT REFERENCES specialties(specialty_id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CONSTRAINT referral_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED')),
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_referrals_visit ON referrals (visit_id);
CREATE INDEX IF NOT EXISTS idx_referrals_patient ON referrals (patient_id);

-- 7) المرفقات (صور وتقارير) مرتبطة بالمريض والزيارة واختيارياً بالحمل/السونار
CREATE TABLE IF NOT EXISTS attachments (
    attachment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    visit_id INT REFERENCES visits(visit_id) ON DELETE CASCADE,
    pregnancy_id INT,
    ultrasound_id INT,
    kind VARCHAR(50) NOT NULL DEFAULT 'DOCUMENT',
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    uploaded_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_visit ON attachments (visit_id);
CREATE INDEX IF NOT EXISTS idx_attachments_patient ON attachments (patient_id);

-- 8) عامل Rh للفصيلة الدموية في الملف الطبي المشترك للمريض
ALTER TABLE patient_medical_profiles ADD COLUMN IF NOT EXISTS rh_factor VARCHAR(10)
    CONSTRAINT patient_rh_check CHECK (rh_factor IN ('POSITIVE', 'NEGATIVE'));