-- 015: نظام متابعة الحمل لعيادة النسائية والتوليد (Obstetrics & Gynecology)
-- 1) سجل الحمل — سجل حمل نشط واحد فقط لكل مريضة
CREATE TABLE IF NOT EXISTS pregnancies (
    pregnancy_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    lmp_date DATE,
    edd_date DATE,
    gravida INT,
    para INT DEFAULT 0,
    abortions INT DEFAULT 0,
    living_children INT DEFAULT 0,
    previous_pregnancies TEXT,
    blood_group VARCHAR(5),
    rh_factor VARCHAR(10) CONSTRAINT pregnancy_rh_check CHECK (rh_factor IN ('POSITIVE', 'NEGATIVE')),
    risk_level VARCHAR(10) NOT NULL DEFAULT 'NORMAL' CONSTRAINT pregnancy_risk_check CHECK (risk_level IN ('NORMAL', 'HIGH')),
    risk_factors TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CONSTRAINT pregnancy_status_check CHECK (status IN ('ACTIVE', 'COMPLETED')),
    outcome VARCHAR(20) NOT NULL DEFAULT 'ONGOING' CONSTRAINT pregnancy_outcome_check CHECK (outcome IN ('ONGOING', 'LIVE_BIRTH', 'STILLBIRTH', 'MISCARRIAGE')),
    delivery_date DATE,
    delivery_method VARCHAR(50),
    delivery_notes TEXT,
    notes TEXT,
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ,
    CONSTRAINT pregnancy_dates_check CHECK (lmp_date IS NULL OR edd_date IS NULL OR edd_date > lmp_date),
    CONSTRAINT pregnancy_counts_check CHECK (COALESCE(gravida, 1) >= 1 AND COALESCE(para, 0) >= 0 AND COALESCE(abortions, 0) >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_pregnancy_per_patient
    ON pregnancies (patient_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_pregnancies_patient ON pregnancies (patient_id);
CREATE INDEX IF NOT EXISTS idx_pregnancies_clinic ON pregnancies (clinic_id);

-- 2) زيارات المتابعة الدورية للحمل — تسجل البيانات الحيوية والفحوصات في كل زيارة
CREATE TABLE IF NOT EXISTS pregnancy_visits (
    pv_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pregnancy_id INT NOT NULL REFERENCES pregnancies(pregnancy_id) ON DELETE CASCADE,
    visit_id INT REFERENCES visits(visit_id) ON DELETE SET NULL,
    visit_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ga_weeks INT CONSTRAINT pv_ga_weeks_check CHECK (ga_weeks BETWEEN 0 AND 45),
    ga_days INT CONSTRAINT pv_ga_days_check CHECK (ga_days BETWEEN 0 AND 6),
    weight_kg NUMERIC(5, 2),
    systolic INT,
    diastolic INT,
    pulse INT,
    temperature NUMERIC(4, 1),
    fundal_height_cm NUMERIC(4, 1),
    fetal_heart_rate INT,
    fetal_presentation VARCHAR(30),
    symptoms TEXT,
    clinical_examination TEXT,
    diagnosis TEXT,
    treatment_plan TEXT,
    supplements TEXT,
    next_visit_date DATE,
    risk_level VARCHAR(10) NOT NULL DEFAULT 'NORMAL' CONSTRAINT pv_risk_check CHECK (risk_level IN ('NORMAL', 'HIGH')),
    notes TEXT,
    recorded_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pv_bp_check CHECK ((systolic IS NULL AND diastolic IS NULL) OR (systolic IS NOT NULL AND diastolic IS NOT NULL AND systolic >= diastolic))
);
CREATE INDEX IF NOT EXISTS idx_pregnancy_visits_pregnancy ON pregnancy_visits (pregnancy_id, visit_date);

-- 3) فحوصات السونار أثناء الحمل مع القياسات الجنينية
CREATE TABLE IF NOT EXISTS ultrasound_exams (
    us_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pregnancy_id INT NOT NULL REFERENCES pregnancies(pregnancy_id) ON DELETE CASCADE,
    visit_id INT REFERENCES visits(visit_id) ON DELETE SET NULL,
    exam_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ga_weeks INT CONSTRAINT us_ga_weeks_check CHECK (ga_weeks BETWEEN 0 AND 45),
    ga_days INT CONSTRAINT us_ga_days_check CHECK (ga_days BETWEEN 0 AND 6),
    fetus_count INT NOT NULL DEFAULT 1,
    fetal_presentation VARCHAR(30),
    bpd_cm NUMERIC(4, 1),
    hc_cm NUMERIC(4, 1),
    ac_cm NUMERIC(4, 1),
    fl_cm NUMERIC(4, 1),
    efw_g INT,
    amniotic_fluid_index NUMERIC(4, 1),
    placenta_position VARCHAR(50),
    findings TEXT,
    impression TEXT,
    report_text TEXT,
    performed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ultrasound_pregnancy ON ultrasound_exams (pregnancy_id, exam_date);