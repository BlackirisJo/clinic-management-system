-- 035: Inventory Write-offs — damage/waste and expiry (Phase 10D.3)
-- One immutable header row per manual write-off of a single explicit batch.
--
-- Scope of this migration: the table only. No medication returns, no stock
-- counts, no reconciliation, no read endpoints, and no new permission.
--
-- This is an ACCOUNTING operation, not a process: nothing here is scheduled,
-- scanned or automatic. A user must explicitly invoke the write-off.
--
-- WASTE and EXPIRE both REMOVE stock, so direction is never a variable here:
-- chk_iwo_before_after_consistent is a plain subtraction.

-- ============================================================
-- 1. Inventory write-offs (immutable history)
-- ============================================================
-- Identity, scope, type, reason, actor and the resulting balances are frozen at
-- insert time. There is no UPDATE path and no DELETE path: a write-off is an
-- append-only correction record, never a rewritten one.
CREATE TABLE IF NOT EXISTS inventory_write_offs (
    write_off_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- clinic_id is server-derived (batch -> inventory_items.clinic_id), never client-supplied.
    -- Denormalised on purpose: the WHO/WHERE/WHY trail must survive any later
    -- change to the batch's owning item.
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    inventory_id INT NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    medication_id INT NOT NULL REFERENCES medications(medication_id) ON DELETE RESTRICT,
    -- 'type' is a non-reserved keyword in PostgreSQL; no quoting needed
    type VARCHAR(10) NOT NULL,
    quantity NUMERIC(12,3) NOT NULL,
    quantity_before NUMERIC(12,3) NOT NULL,
    quantity_after NUMERIC(12,3) NOT NULL,
    -- WHO/WHY is mandatory: an unexplained stock loss is not an audit trail
    reason TEXT NOT NULL,
    notes TEXT,
    performed_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_iwo_type_valid CHECK (type IN ('WASTE', 'EXPIRE')),
    -- quantity is never signed: a write-off only ever removes
    CONSTRAINT chk_iwo_quantity_positive CHECK (quantity > 0),
    CONSTRAINT chk_iwo_before_nonneg CHECK (quantity_before >= 0),
    CONSTRAINT chk_iwo_after_nonneg CHECK (quantity_after >= 0),
    -- a blank/whitespace reason is not a reason.
    -- btrim is given the full whitespace set on purpose: the default btrim()
    -- strips spaces only, so a tab/newline-only reason would slip through.
    CONSTRAINT chk_iwo_reason_present CHECK (length(btrim(reason, E' \t\n\r\f\v')) > 0),
    -- a write-off only ever subtracts, for both types
    CONSTRAINT chk_iwo_before_after_consistent CHECK (quantity_after = quantity_before - quantity)
);

-- ON DELETE RESTRICT on every FK above: no CASCADE, anywhere. Deleting a clinic,
-- item, batch, medication or user can never silently destroy write-off history.
-- (users are soft-deleted in this system precisely so this holds.)

CREATE INDEX IF NOT EXISTS idx_iwo_clinic_created
    ON inventory_write_offs (clinic_id, created_at DESC, write_off_id DESC);
CREATE INDEX IF NOT EXISTS idx_iwo_batch_created
    ON inventory_write_offs (batch_id, created_at DESC, write_off_id DESC);
CREATE INDEX IF NOT EXISTS idx_iwo_type_created
    ON inventory_write_offs (type, created_at DESC, write_off_id DESC);
CREATE INDEX IF NOT EXISTS idx_iwo_performed_by
    ON inventory_write_offs (performed_by_user_id);

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No cron, scheduler, background job or batch scan: EXPIRE is an explicit
--   user-initiated accounting write-off, never an automatic expiry process.
-- - No quarantine creation or release: a quarantined batch may still be written
--   off (WASTE and EXPIRE both remove stock), and its quarantine is left
--   exactly as it was for FEFO eligibility to keep using it.
-- - No quantity_reserved writers: the column stays untouched, and every future
--   mutation must keep respecting chk_batch_qty_reserved_le_on_hand.
-- - No unit_cost change, no backfill, and no alteration of existing
--   stock_movements rows or of Phase 10D.2 adjustment semantics.
