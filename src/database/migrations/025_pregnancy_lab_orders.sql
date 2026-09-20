-- 025: طلبات المختبر المرتبطة بسجل الحمل
-- يتبع نفس نمط lab_orders/lab_results لكن مرتبط بـ pregnancies بدلاً من visits
CREATE TABLE IF NOT EXISTS pregnancy_lab_orders (
    pregnancy_lab_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pregnancy_id INT NOT NULL REFERENCES pregnancies(pregnancy_id) ON DELETE CASCADE,
    pregnancy_visit_id INT REFERENCES pregnancy_visits(pv_id) ON DELETE SET NULL,
    test_name VARCHAR(200) NOT NULL,
    category VARCHAR(50),
    priority VARCHAR(10) NOT NULL DEFAULT 'ROUTINE' CONSTRAINT pregnancy_lab_priority_check CHECK (priority IN ('ROUTINE', 'URGENT', 'STAT')),
    status VARCHAR(20) NOT NULL DEFAULT 'ORDERED' CONSTRAINT pregnancy_lab_status_check CHECK (status IN ('ORDERED', 'COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    notes TEXT,
    ordered_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_preg_lab_pregnancy ON pregnancy_lab_orders (pregnancy_id);
CREATE INDEX IF NOT EXISTS idx_preg_lab_visit ON pregnancy_lab_orders (pregnancy_visit_id);

CREATE TABLE IF NOT EXISTS pregnancy_lab_results (
    pregnancy_lab_result_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pregnancy_lab_id INT NOT NULL REFERENCES pregnancy_lab_orders(pregnancy_lab_id) ON DELETE CASCADE,
    analyte VARCHAR(200) NOT NULL,
    result_value VARCHAR(200),
    unit VARCHAR(50),
    reference_range VARCHAR(100),
    is_abnormal BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    resulted_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    resulted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_preg_lab_results ON pregnancy_lab_results (pregnancy_lab_id);
