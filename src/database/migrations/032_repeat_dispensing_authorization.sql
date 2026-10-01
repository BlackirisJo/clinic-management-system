-- 032: Repeat dispensing authorization (Phase 10C.4C)
-- Explicit, per-prescription-item repeat authorization.
--
-- CRITICAL: prescription_items.repeats_count is NOT read, NOT reinterpreted and
-- NOT migrated here. It stays display-only legacy metadata. Only an explicit
-- row in this table enables cycles > 1.

-- ============================================================
-- 1. Repeat authorization (optional, one row per prescription item)
-- ============================================================
-- max_cycles counts the INITIAL dispensing: 1 = initial only, no repeats.
-- No row at all means implicit max_cycles = 1 — so every existing prescription
-- is correctly non-repeatable with zero backfill.
CREATE TABLE IF NOT EXISTS prescription_repeat_authorizations (
    repeat_auth_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prescription_item_id INT NOT NULL UNIQUE REFERENCES prescription_items(item_id) ON DELETE RESTRICT,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    max_cycles INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    authorized_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    authorized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE prescription_repeat_authorizations
    ADD CONSTRAINT chk_pra_max_cycles CHECK (max_cycles >= 1);

ALTER TABLE prescription_repeat_authorizations
    ADD CONSTRAINT chk_pra_status_valid CHECK (status IN ('ACTIVE', 'CANCELLED'));

CREATE INDEX IF NOT EXISTS idx_pra_clinic_id ON prescription_repeat_authorizations (clinic_id);
CREATE INDEX IF NOT EXISTS idx_pra_authorized_by ON prescription_repeat_authorizations (authorized_by_user_id);

-- ============================================================
-- 2. Which repeat cycle a dispensed quantity belongs to
-- ============================================================
-- cycle_index 0 = initial dispensing. A prescription advances to the next
-- cycle only when the whole prescription reaches zero remaining, so a
-- prescription never sits across two different cycle indices at once.
--
-- Scope: remaining within a cycle is
--   prescribed_quantity - SUM(dispensed_quantity WHERE cycle_index = current)
-- which is exactly what chk_di_quantities_balance already enforces per cycle.
ALTER TABLE dispensing_items
    ADD COLUMN IF NOT EXISTS cycle_index INT NOT NULL DEFAULT 0;

ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_cycle_index_nonneg CHECK (cycle_index >= 0);

CREATE INDEX IF NOT EXISTS idx_di_prescription_item_cycle
    ON dispensing_items (prescription_item_id, cycle_index);

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No backfill of repeat authorizations from repeats_count (would invent intent).
-- - No new permission: CREATE_PRESCRIPTION (Prescriptions group) already covers
--   the clinical act of authorizing a refill.
-- - No refill time window, no billing, no returns.
