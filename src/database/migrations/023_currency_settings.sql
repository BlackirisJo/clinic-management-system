-- 023_currency_settings.sql
-- Master currency catalog and system base currency setting

CREATE TABLE IF NOT EXISTS currency_master (
    code VARCHAR(3) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    symbol_position VARCHAR(10) NOT NULL DEFAULT 'after',
    decimal_digits INT NOT NULL DEFAULT 2,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value VARCHAR(255) NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO currency_master (code, name, symbol, symbol_position, decimal_digits) VALUES
    ('JOD', 'Jordanian Dinar', 'د.أ', 'after', 2),
    ('USD', 'US Dollar', '$', 'before', 2),
    ('EUR', 'Euro', '€', 'before', 2),
    ('SAR', 'Saudi Riyal', 'SAR', 'after', 2),
    ('AED', 'UAE Dirham', 'AED', 'after', 2),
    ('KWD', 'Kuwaiti Dinar', 'KWD', 'after', 2),
    ('QAR', 'Qatari Riyal', 'QAR', 'after', 2),
    ('BHD', 'Bahraini Dinar', 'BHD', 'after', 2),
    ('OMR', 'Omani Rial', 'OMR', 'after', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO system_settings (key, value, description) VALUES
    ('base_currency', 'JOD', 'System default currency for new financial records')
ON CONFLICT (key) DO NOTHING;
