-- 036: Medication Returns Foundation (Phase 10D.4)
-- Foundation + read APIs only. There is NO mutation endpoint in this phase:
-- nothing here creates, restocks, quarantines or wastes a return.
--
-- The only writer of these two tables in 10D.4 is Phase 10D.5. This migration
-- adds the traceability the return of dispensed stock depends on, so that when
-- 10D.5 does write a return it can never be reconstructed by inference.

-- ============================================================
-- 1. medication_returns (header)
-- ============================================================
-- A return header is only meaningful together with the ORIGINAL dispensing it
-- reverses, so original_dispensing_id is mandatory and RESTRICT: a return can
-- never outlive or orphan the dispensing it points at, and a dispensing can
-- never be deleted while a return references it.
CREATE TABLE IF NOT EXISTS medication_returns (
    return_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- clinic_id is server-derived at write time (the original dispensing's
    -- clinic), never client-supplied. Denormalised so the read API can enforce
    -- clinic scope with a single indexed predicate.
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    returned_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    -- the patient the stock was originally dispensed to
    dispensed_to_patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    original_dispensing_id INT NOT NULL REFERENCES dispensings(dispensing_id) ON DELETE RESTRICT,
    status VARCHAR(10) NOT NULL,
    -- WHY is mandatory: an unexplained return is not an audit trail.
    -- btrim is given the full whitespace set on purpose: the default btrim()
    -- strips spaces only, so a tab/newline-only reason would slip through.
    reason TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_mr_status_valid CHECK (status IN ('COMPLETED', 'VOIDED')),
    CONSTRAINT chk_mr_reason_present CHECK (length(btrim(reason, E' \t\n\r\f\v')) > 0)
);

-- ON DELETE RESTRICT on every FK above: no CASCADE, anywhere. Deleting a clinic,
-- user, patient or dispensing can never silently destroy return history.

CREATE INDEX IF NOT EXISTS idx_mr_clinic_created
    ON medication_returns (clinic_id, created_at DESC, return_id DESC);
CREATE INDEX IF NOT EXISTS idx_mr_patient_created
    ON medication_returns (dispensed_to_patient_id, created_at DESC, return_id DESC);
CREATE INDEX IF NOT EXISTS idx_mr_dispensing
    ON medication_returns (original_dispensing_id);
CREATE INDEX IF NOT EXISTS idx_mr_returned_by
    ON medication_returns (returned_by_user_id);

-- ============================================================
-- 2. medication_return_items (traceable allocation lines)
-- ============================================================
-- Each line points at ONE specific dispensing allocation
-- (dispensing_item_batch_id), and independently preserves the batch, the
-- medication and the HISTORICAL unit cost.
--
-- unit_cost_snapshot is a hard requirement, not a convenience: the cost of a
-- dispensing allocation is frozen at dispensing time, and must never be
-- re-derived from inventory_batches later, because the batch cost may have
-- changed in the meantime. NULL is not allowed here — "unknown historical
-- cost" is not an acceptable value in a return ledger.
CREATE TABLE IF NOT EXISTS medication_return_items (
    return_item_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    return_id INT NOT NULL REFERENCES medication_returns(return_id) ON DELETE RESTRICT,
    dispensing_item_batch_id BIGINT NOT NULL REFERENCES dispensing_item_batches(dispensing_item_batch_id) ON DELETE RESTRICT,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    medication_id INT NOT NULL REFERENCES medications(medication_id) ON DELETE RESTRICT,
    quantity NUMERIC(12,3) NOT NULL,
    unit_cost_snapshot NUMERIC(12,3) NOT NULL,
    -- The decision is recorded here, but 10D.4 performs NO action: it does not
    -- restock, does not create a batch_quarantines row and does not create a
    -- write-off. The acting endpoint is Phase 10D.5.
    restock_decision VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_mri_quantity_positive CHECK (quantity > 0),
    CONSTRAINT chk_mri_unit_cost_nonneg CHECK (unit_cost_snapshot >= 0),
    CONSTRAINT chk_mri_restock_decision_valid CHECK (restock_decision IN ('RESTOCK', 'QUARANTINE', 'WASTE'))
);

CREATE INDEX IF NOT EXISTS idx_mri_return_id ON medication_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_mri_dispensing_item_batch ON medication_return_items (dispensing_item_batch_id);
CREATE INDEX IF NOT EXISTS idx_mri_batch_id ON medication_return_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_mri_medication_id ON medication_return_items (medication_id);

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No mutation endpoint and no writer: creating, restocking, quarantining or
--   wasting a return is Phase 10D.5. Nothing in 10D.4 writes these tables.
-- - No 'RETURN' stock movement, no batch_quarantines row, no write-off record.
-- - No alteration of dispensing_items.dispensed_quantity / remaining_quantity,
--   prescription quantities, inventory quantities or existing stock movements:
--   a return is recorded, never applied, in this phase.
-- - No quantity_reserved writer, no cron, scheduler or background job.
-- - No FEFO change, no stock adjustment change, no write-off change.
