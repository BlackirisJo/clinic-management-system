-- 024_add_currency_code.sql
-- Add currency_code to financial records; backfill existing data with JOD

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'JOD';
ALTER TABLE invoices ADD CONSTRAINT invoices_currency_code_fk FOREIGN KEY (currency_code) REFERENCES currency_master(code) ON UPDATE CASCADE;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'JOD';
ALTER TABLE expenses ADD CONSTRAINT expenses_currency_code_fk FOREIGN KEY (currency_code) REFERENCES currency_master(code) ON UPDATE CASCADE;

-- Backfill: ensure all existing records have valid currency_code
UPDATE invoices SET currency_code = 'JOD' WHERE currency_code IS NULL OR currency_code NOT IN (SELECT code FROM currency_master);
UPDATE expenses SET currency_code = 'JOD' WHERE currency_code IS NULL OR currency_code NOT IN (SELECT code FROM currency_master);

-- Verify constraint: all existing values must match currency_master
-- This is safe because we backfilled with JOD which is seeded in currency_master
