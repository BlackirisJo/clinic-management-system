-- 034: Stock Adjustments (Phase 10D.2)
-- Manual, batch-level stock adjustment header. One immutable row per operation.
--
-- Scope of this migration: the table only. No returns, waste/expiry, stock
-- counts, reconciliation, quarantine/release endpoints, and no new permission.
--
-- direction is an EXPLICIT column, never a sign: quantity is always > 0 and
-- chk_sa_before_after_consistent proves the header agrees with the direction.
-- Nothing here writes inventory_batches — that belongs to the transactional
-- controller (which also owns the guarded update).

-- ============================================================
-- 1. Stock adjustments (immutable history)
-- ============================================================
-- Identity, scope, direction, reason, actor and the resulting balances are all
-- frozen at insert time. There is no UPDATE path and no DELETE path: an
-- adjustment is an append-only correction record, and a mistake is corrected by
-- issuing the opposite adjustment, never by rewriting history.
CREATE TABLE IF NOT EXISTS stock_adjustments (
    adjustment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- clinic_id is server-derived (batch -> inventory_items.clinic_id), never client-supplied.
    -- Kept denormalised on purpose: the audit trail of WHO/WHERE/WHY must survive
    -- any later change to the batch's owning item.
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    inventory_id INT NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    medication_id INT NOT NULL REFERENCES medications(medication_id) ON DELETE RESTRICT,
    direction VARCHAR(10) NOT NULL,
    quantity NUMERIC(12,3) NOT NULL,
    quantity_before NUMERIC(12,3) NOT NULL,
    quantity_after NUMERIC(12,3) NOT NULL,
    -- WHO/WHY is mandatory: an unexplained stock change is not an audit trail.
    reason TEXT NOT NULL,
    notes TEXT,
    performed_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_sa_direction_valid CHECK (direction IN ('INCREASE', 'DECREASE')),
    -- quantity is never signed — direction alone carries the meaning
    CONSTRAINT chk_sa_quantity_positive CHECK (quantity > 0),
    CONSTRAINT chk_sa_before_nonneg CHECK (quantity_before >= 0),
    CONSTRAINT chk_sa_after_nonneg CHECK (quantity_after >= 0),
    -- a blank/whitespace reason is not a reason.
    -- btrim is given the full whitespace set on purpose: the default btrim()
    -- strips spaces only, so a tab/newline-only reason would slip through.
    CONSTRAINT chk_sa_reason_present CHECK (length(btrim(reason, E' \t\n\r\f\v')) > 0),
    -- the recorded balances must actually match the recorded direction
    CONSTRAINT chk_sa_before_after_consistent CHECK (
        (direction = 'INCREASE' AND quantity_after = quantity_before + quantity)
        OR
        (direction = 'DECREASE' AND quantity_after = quantity_before - quantity)
    )
);

-- ON DELETE RESTRICT on every FK above: no CASCADE, anywhere. Deleting a clinic,
-- item, batch, medication or user can never silently destroy adjustment history.
-- (users are soft-deleted in this system precisely so this holds.)

-- Listing/audit reads
CREATE INDEX IF NOT EXISTS idx_sa_clinic_created
    ON stock_adjustments (clinic_id, created_at DESC, adjustment_id DESC);
CREATE INDEX IF NOT EXISTS idx_sa_batch_created
    ON stock_adjustments (batch_id, created_at DESC, adjustment_id DESC);
CREATE INDEX IF NOT EXISTS idx_sa_performed_by
    ON stock_adjustments (performed_by_user_id);

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No quantity_reserved writers: the column stays untouched, and every future
--   mutation must keep respecting chk_batch_qty_reserved_le_on_hand.
-- - No unit_cost change, no backfill, no alteration of existing stock_movements
--   rows: historical ADJUSTMENT movements keep their original "increase" meaning.
