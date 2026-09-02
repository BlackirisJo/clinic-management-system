-- 1. أنواع البيانات المخصصة (ENUMS)
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'PASSWORD_RESET_REQUIRED');
CREATE TYPE backup_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'RESTORED');
CREATE TYPE payment_method AS ENUM ('CASH', 'CARD', 'INSURANCE', 'SPLIT');

-- 2. الأدوار والصلاحيات (RBAC)
CREATE TABLE roles (
    role_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE permissions (
    permission_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_key VARCHAR(100) UNIQUE NOT NULL,
    permission_group VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE TABLE role_permissions (
    role_id INT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    permission_id INT NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- 3. العيادات والمستخدمين (الأطباء، المحاسبين، الآدمن)
CREATE TABLE clinics (
    clinic_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_name VARCHAR(150) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
    user_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id INT REFERENCES roles(role_id) ON DELETE SET NULL,
    clinic_id INT REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    full_name VARCHAR(150) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone VARCHAR(20),
    status account_status DEFAULT 'ACTIVE',
    is_force_password_change BOOLEAN DEFAULT FALSE,
    medical_license_no VARCHAR(50),
    sub_specialty TEXT,
    direct_phone VARCHAR(20),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. السجلات والزيارات والأدوية
CREATE TABLE patients (
    patient_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    national_id VARCHAR(50) UNIQUE,
    phone VARCHAR(20) NOT NULL,
    gender VARCHAR(10) NOT NULL,
    date_of_birth DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE visits (
    visit_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id),
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id),
    doctor_id INT NOT NULL REFERENCES users(user_id),
    visit_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

CREATE TABLE medications (
    medication_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trade_name VARCHAR(150) NOT NULL,
    scientific_name VARCHAR(150) NOT NULL,
    default_dosage VARCHAR(100),
    instructions TEXT
);

-- 5. الروشتة القياسية
CREATE TABLE prescriptions (
    prescription_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id INT NOT NULL REFERENCES visits(visit_id),
    patient_id INT NOT NULL REFERENCES patients(patient_id),
    doctor_id INT NOT NULL REFERENCES users(user_id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE prescription_items (
    item_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prescription_id INT NOT NULL REFERENCES prescriptions(prescription_id) ON DELETE CASCADE,
    medication_id INT NOT NULL REFERENCES medications(medication_id),
    dosage VARCHAR(100) NOT NULL,
    frequency VARCHAR(100) NOT NULL,
    duration VARCHAR(50) NOT NULL,
    timing_instructions VARCHAR(150),
    repeats_count INT DEFAULT 1
);

-- 6. المالية ودور المحاسب
CREATE TABLE clinic_services (
    service_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    service_name VARCHAR(150) NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    doctor_percentage NUMERIC(5, 2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE invoices (
    invoice_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id INT NOT NULL REFERENCES patients(patient_id),
    visit_id INT REFERENCES visits(visit_id),
    receptionist_id INT NOT NULL REFERENCES users(user_id),
    total_amount NUMERIC(10, 2) NOT NULL,
    discount_amount NUMERIC(10, 2) DEFAULT 0,
    net_amount NUMERIC(10, 2) NOT NULL,
    paid_amount NUMERIC(10, 2) NOT NULL,
    payment_type payment_method DEFAULT 'CASH',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE invoice_items (
    item_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id INT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id),
    doctor_id INT REFERENCES users(user_id),
    service_id INT REFERENCES clinic_services(service_id),
    price NUMERIC(10, 2) NOT NULL,
    doctor_share NUMERIC(10, 2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE expenses (
    expense_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id INT REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    category VARCHAR(100) NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    description TEXT,
    spent_by_user_id INT NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. سجل النسخ الاحتياطي المشفر
CREATE TABLE database_backups (
    backup_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_id INT NOT NULL REFERENCES users(user_id),
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    checksum_sha256 VARCHAR(64) NOT NULL,
    encryption_algorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
    status backup_status DEFAULT 'IN_PROGRESS',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 8. رؤية الإحصائيات المجمعة (Materialized View)
CREATE MATERIALIZED VIEW mv_clinic_monthly_kpis AS
SELECT 
    c.clinic_id,
    c.clinic_name,
    DATE_TRUNC('month', i.created_at) AS stat_month,
    COUNT(DISTINCT i.patient_id) AS unique_patients,
    COUNT(DISTINCT v.visit_id) AS total_visits,
    COALESCE(SUM(ii.price), 0) AS total_revenue,
    COALESCE(SUM(ii.doctor_share), 0) AS total_doctor_payout,
    (COALESCE(SUM(ii.price), 0) - COALESCE(SUM(ii.doctor_share), 0)) AS net_clinic_margin
FROM clinics c
LEFT JOIN invoice_items ii ON c.clinic_id = ii.clinic_id
LEFT JOIN invoices i ON ii.invoice_id = i.invoice_id
LEFT JOIN visits v ON i.visit_id = v.visit_id
GROUP BY c.clinic_id, c.clinic_name, DATE_TRUNC('month', i.created_at);

CREATE UNIQUE INDEX idx_mv_clinic_kpis ON mv_clinic_monthly_kpis (clinic_id, stat_month);