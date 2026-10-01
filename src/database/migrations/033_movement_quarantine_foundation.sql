-- 033: Movement direction + quarantine foundation (Phase 10D.1)
-- Foundation only. No adjustment/return/waste/expiry/count endpoints.
--
-- ADJUSTMENT_DECREASE is ADDITIVE. Existing ADJUSTMENT rows keep their meaning
-- ("increase") forever; no existing row is altered, backfilled or re-signed.

-- ============================================================
-- 1. Extend the movement-type vocabulary with a decreasing adjustment
-- ============================================================
-- quantity stays strictly positive: the movement type alone determines direction.
-- No signed quantity and no direction column are introduced.
ALTER TABLE stock_movements
    DROP CONSTRAINT IF EXISTS chk_movement_type_valid;

ALTER TABLE stock_movements
    ADD CONSTRAINT chk_movement_type_valid CHECK (movement_type IN (
    'RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'ADJUSTMENT_DECREASE', 'WASTE', 'EXPIRE'
));

-- ============================================================
-- 2. Quarantine foundation
-- ============================================================
-- Quarantine = stock physically present but not available for dispensing/FEFO.
-- Modelled as a first-class record (NOT a bare boolean) so WHO / WHEN / WHY and
-- the release are permanently auditable.
--
-- Granularity is per batch: a quarantined batch is entirely ineligible.
-- The partial-quantity case is deliberately out of 10D.1 scope.
--
-- The batch FK is ON DELETE RESTRICT so quarantine history can never be destroyed
-- by deleting a batch, and inventory_batches itself is never deleted.
CREATE TABLE IF NOT EXISTS batch_quarantines (
    quarantine_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    quarantined_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMPTZ,
    released_by_user_id INT REFERENCES users(user_id) ON DELETE RESTRICT,
    release_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_bq_reason_present CHECK (length(btrim(reason)) > 0),
    CONSTRAINT chk_bq_release_pair
        CHECK ((released_at IS NULL) = (released_by_user_id IS NULL)),
    CONSTRAINT chk_bq_release_reason
        CHECK (released_at IS NULL OR (release_reason IS NOT NULL AND length(btrim(release_reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_bq_batch_id ON batch_quarantines (batch_id);
CREATE INDEX IF NOT EXISTS idx_bq_clinic_id ON batch_quarantines (clinic_id);
CREATE INDEX IF NOT EXISTS idx_bq_quarantined_by ON batch_quarantines (quarantined_by_user_id);

-- دفعة واحدة لا تملك أكثر من عزل نشط واحد؛ السجلات المُحرَّرة تبقى للتدقيق
CREATE UNIQUE INDEX IF NOT EXISTS uq_bq_one_active_per_batch
    ON batch_quarantines (batch_id)
    WHERE released_at IS NULL;

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No endpoints: no quarantine/release operation, no adjustment, no return,
--   no waste/expiry, no stock count, no reconciliation.
-- - No quantity_reserved writers (the column stays untouched, and every future
--   mutation must respect chk_batch_qty_reserved_le_on_hand).
-- - No new permission, no location/packaging model, no backfill.
