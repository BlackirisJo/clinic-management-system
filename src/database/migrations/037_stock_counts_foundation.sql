-- 037: Stock Counts Foundation (Phase 10D.6)
-- Physical stock counting: a count session and the lines recorded against it.
--
-- Scope of this migration: the two tables ONLY. It creates no stock effect of
-- any kind. Nothing here writes inventory_batches, nothing inserts into
-- stock_movements, and nothing creates or releases a quarantine.
--
-- The whole point of a physical count is to record what is physically on the
-- shelf next to what the system believes. So a count line stores THREE numbers
-- and they are frozen at insert time:
--   system_quantity   — the batch's on-hand quantity at line-creation time
--   counted_quantity  — what a human physically counted
--   variance          — counted_quantity - system_quantity
-- Nothing recomputes them later. In particular the variance of an old line is
-- never restated against a newer system quantity: a variance is a statement
-- about a moment in time, and rewriting it would destroy the evidence.
--
-- 10D.6 records state. It does not act on it:
-- - No finalisation endpoint, no approval, no status transition.
-- - system_quantity_at_finalisation and adjusted_quantity are declared for the
--   later phases and stay NULL forever in this phase: 10D.7 owns them.
-- - No ADJUSTMENT / ADJUSTMENT_DECREASE movement from a variance, no
--   reconciliation, no automatic or scheduled counting.
-- - quantity_reserved is deliberately NOT snapshotted: this phase is an on-hand
--   count, and the existing architecture keeps reservation accounting separate.

-- ============================================================
-- 1. stock_counts (the counting session)
-- ============================================================
-- One row per physical count of one clinic's stock. Denormalised clinic_id is
-- deliberate: the WHO/WHERE audit of a count must survive any later change to a
-- batch's owning inventory item, and the read API can enforce clinic scope with
-- a single indexed predicate.
CREATE TABLE IF NOT EXISTS stock_counts (
    count_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- server-derived from the authenticated user's clinic scope, never client-supplied
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    counted_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    -- stays NULL in 10D.6: there is no approval endpoint in this phase
    approved_by_user_id INT REFERENCES users(user_id) ON DELETE RESTRICT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- stays NULL while OPEN; only a finalisation (10D.7) may set it
    finalised_at TIMESTAMPTZ,

    CONSTRAINT chk_sc_status_valid CHECK (status IN ('OPEN', 'FINALISED', 'CANCELLED')),
    -- A count is either finished (and then it says exactly when) or it is not
    -- finished (and then it carries no finished-at timestamp). There is no third
    -- state, so no reader ever has to guess which of the two columns is truth.
    CONSTRAINT chk_sc_finalised_consistent CHECK (
        (status = 'FINALISED' AND finalised_at IS NOT NULL)
        OR
        (status IN ('OPEN', 'CANCELLED') AND finalised_at IS NULL)
    )
);

-- ON DELETE RESTRICT on every FK above: no CASCADE, anywhere. Deleting a clinic
-- or a user can never silently destroy counting history (users are soft-deleted
-- in this system precisely so this holds).

-- Listing / lookup reads
CREATE INDEX IF NOT EXISTS idx_sc_clinic_created
    ON stock_counts (clinic_id, created_at DESC, count_id DESC);
CREATE INDEX IF NOT EXISTS idx_sc_status_created
    ON stock_counts (status, created_at DESC, count_id DESC);
CREATE INDEX IF NOT EXISTS idx_sc_counted_by
    ON stock_counts (counted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_sc_approved_by
    ON stock_counts (approved_by_user_id);

-- ============================================================
-- 2. stock_count_lines (the counted batches)
-- ============================================================
-- One line per batch per count, carrying the three frozen numbers plus the
-- medication identity (denormalised from the batch's inventory item so the
-- detail read never has to re-join through inventory_items, which may later be
-- archived).
--
-- batch_id is intentionally NOT constrained to the count's clinic by a foreign
-- key — PostgreSQL cannot express "this batch belongs to the same clinic" in a
-- CHECK. The controller enforces it inside the line transaction, together with
-- the caller's clinic scope; this migration only guarantees the FK exists and
-- the arithmetic is exact.
CREATE TABLE IF NOT EXISTS stock_count_lines (
    count_line_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    count_id INT NOT NULL REFERENCES stock_counts(count_id) ON DELETE RESTRICT,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    medication_id INT NOT NULL REFERENCES medications(medication_id) ON DELETE RESTRICT,
    -- the on-hand snapshot, read under a row lock at line-creation time
    system_quantity NUMERIC(12,3) NOT NULL,
    -- what the human physically counted; zero is a real and valid answer
    counted_quantity NUMERIC(12,3) NOT NULL,
    -- the frozen difference, computed once by the server
    variance NUMERIC(12,3) NOT NULL,
    -- 10D.7 columns. Declared now so the later phase is additive; nothing in
    -- 10D.6 populates them, and no endpoint in this phase may.
    system_quantity_at_finalisation NUMERIC(12,3),
    adjusted_quantity NUMERIC(12,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- A count can never invent negative stock, and the snapshot it freezes can
    -- never be negative either.
    CONSTRAINT chk_scl_system_nonneg CHECK (system_quantity >= 0),
    CONSTRAINT chk_scl_counted_nonneg CHECK (counted_quantity >= 0),
    -- The whole value of the line is this identity. Both sides are NUMERIC with
    -- scale 3, so the subtraction is exact decimal arithmetic — never a float —
    -- and the stored variance can never silently disagree with its inputs.
    CONSTRAINT chk_scl_variance_consistent CHECK (variance = counted_quantity - system_quantity),
    -- the later-phase columns stay non-negative when they are eventually filled
    CONSTRAINT chk_scl_system_at_finalisation_nonneg CHECK (
        system_quantity_at_finalisation IS NULL OR system_quantity_at_finalisation >= 0
    ),
    CONSTRAINT chk_scl_adjusted_nonneg CHECK (adjusted_quantity IS NULL OR adjusted_quantity >= 0),
    -- A batch is counted once per count. The uniqueness is what makes the
    -- concurrent-insert race resolve in the database rather than in a read.
    CONSTRAINT uq_scl_count_batch UNIQUE (count_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_scl_count_id ON stock_count_lines (count_id);
CREATE INDEX IF NOT EXISTS idx_scl_batch_id ON stock_count_lines (batch_id);
CREATE INDEX IF NOT EXISTS idx_scl_medication_id ON stock_count_lines (medication_id);

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No UPDATE or DELETE path for a recorded line. A miscount is corrected by
--   10D.7's finalisation flow or by a new count, never by rewriting the record.
-- - No stock movement type is added: stock_movements keeps its existing
--   vocabulary unchanged.
-- - No write to inventory_batches.quantity_on_hand or quantity_reserved.
-- - No trigger, no cron, no scheduler, no automatic counting.
