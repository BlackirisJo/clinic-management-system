-- 043: Medication Return Financial Reversal (Phase 10E.7)
-- One additive table. No existing table is altered.
--
-- 10D records what was returned; 10E.5 records what dispensing cost; 10E.6 values
-- what stock remains. Nothing recorded the FINANCIAL CONSEQUENCE of a return, so
-- a returned drug left its cost stranded in COGS forever and a wasted drug left
-- no trace of the loss.
--
-- This table is that missing fact, and it is additive: it never rewrites
-- dispensing_items.cogs_amount, dispensing_item_batches.unit_cost_snapshot,
-- invoice_items, or any existing return row. Those are historical facts of what
-- happened; this is a separate, additive recognition of what that return did to
-- the cost side.
--
-- ============================================================
-- 1. Why the reversal is anchored on the ALLOCATION, not the return row
-- ============================================================
-- return_item_id is the identity anchor: exactly one reversal per return line,
-- which is what makes the whole thing idempotent (uq below) and makes a second
-- reversal of the same return impossible rather than merely unlikely.
--
-- The COST, however, is deliberately read from dispensing_item_batches and NOT
-- from medication_return_items.unit_cost_snapshot. That column is NUMERIC(12,3)
-- while the allocation's is NUMERIC(10,4), and 10D.5 writes it ROUND(...,3). A
-- cost of 2.5678 is therefore already stored there as 2.568. Reversing COGS from
-- that column would overstate every reversal (20 units: 51.360000 instead of the
-- exact 51.3560000). This column is copied straight from the allocation so the
-- reversal ties out exactly against the cogs_amount recognized in 10E.5.
--
-- Likewise inventory_batches.unit_cost is never used: a batch may have been
-- repriced since the dispensing, and the reversal must describe what the
-- dispensing ACTUALLY cost at the time, not what the batch costs today.
--
-- ============================================================
-- 2. Amount model
-- ============================================================
--     cogs_reversal_amount = returned_quantity × unit_cost_snapshot
--
-- NUMERIC(20,7) matches 10E.5's cogs_amount exactly, so reversal and recognition
-- are the same scale and net to exactly zero — no rounding drift. It is 7
-- decimals because quantity NUMERIC(12,3) × unit_cost NUMERIC(10,4) carries 7.
--
-- The three return decisions are financially distinct:
--
--  RESTOCK    stock physically returns to a batch  -> reverse COGS, no loss.
--  QUARANTINE stock physically returns but is held -> reverse COGS, no loss.
--             Quarantine blocks FEFO, not value: 10E.6 deliberately keeps
--             quarantined stock in the physical valuation.
--  WASTE      stock is destroyed, no batch credit   -> reverse COGS AND record an
--             equal loss. Reversing alone would understate total expense; the
--             paired loss keeps the loss visible and auditable rather than
--             silently absorbed. This is a single amount on a single row, NOT a
--             general ledger: there are no accounts, no journal and no entries.
--
-- ============================================================
-- 3. Immutability and clinic scope
-- ============================================================
-- Immutable: the writer only ever INSERTs. No code path updates a reversal, so a
-- recognised reversal can never be rewritten. Correcting a return is a matter of
-- a new, visible fact, exactly as with every other financial snapshot here.
--
-- clinic_id is copied from the original dispensing (server-derived at write
-- time, never client-supplied) so a reversal is clinic-scoped on one indexed
-- predicate, matching medication_returns.
--
-- Every FK is ON DELETE RESTRICT: return and reversal history must never be
-- destroyed by deleting an upstream record.
--
-- Deliberately NOT here:
-- - No invoice credit, revenue reversal, refund or payment. This phase is the
--   COST side only; the REVENUE side of a return is Phase 10E.8.
-- - No alteration or widening of medication_return_items.unit_cost_snapshot and
--   no repair of the values already rounded there. Historical rows are left
--   exactly as 10D wrote them; this table simply does not depend on them.
-- - No change to voidDispensing, to inventory valuation (10E.6), or to any
--   stock quantity, movement or quarantine behaviour.

CREATE TABLE IF NOT EXISTS medication_return_reversals (
    reversal_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- One reversal per return line. This is the idempotency backstop: a second
    -- attempt for the same return item violates it and becomes a 409.
    return_item_id INT NOT NULL UNIQUE
        REFERENCES medication_return_items(return_item_id) ON DELETE RESTRICT,
    -- The allocation the cost is read from and the reversal is anchored to.
    dispensing_item_batch_id BIGINT NOT NULL
        REFERENCES dispensing_item_batches(dispensing_item_batch_id) ON DELETE RESTRICT,
    -- Denormalised from the allocation for clinic scoping and so 10E.8 can reach
    -- the invoice line without re-deriving the chain.
    dispensing_id INT NOT NULL REFERENCES dispensings(dispensing_id) ON DELETE RESTRICT,
    dispensing_item_id INT NOT NULL
        REFERENCES dispensing_items(dispensing_item_id) ON DELETE RESTRICT,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,

    -- Copied from the return line so the reversal stands on its own as a fact.
    returned_quantity NUMERIC(12,3) NOT NULL,
    -- Copied from dispensing_item_batches (NUMERIC 10,4), NOT from the return row.
    unit_cost_snapshot NUMERIC(10,4) NOT NULL,
    cogs_reversal_amount NUMERIC(20,7) NOT NULL,
    -- Equals cogs_reversal_amount for WASTE, exactly 0 otherwise.
    loss_amount NUMERIC(20,7) NOT NULL DEFAULT 0,
    restock_decision VARCHAR(20) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_mrr_quantity_positive CHECK (returned_quantity > 0),
    CONSTRAINT chk_mrr_unit_cost_nonneg CHECK (unit_cost_snapshot >= 0),
    CONSTRAINT chk_mrr_reversal_nonneg CHECK (cogs_reversal_amount >= 0),
    CONSTRAINT chk_mrr_loss_nonneg CHECK (loss_amount >= 0),
    -- Same vocabulary as medication_return_items.chk_mri_restock_decision_valid
    CONSTRAINT chk_mrr_restock_decision_valid
        CHECK (restock_decision IN ('RESTOCK', 'QUARANTINE', 'WASTE')),
    -- The decision/loss pairing is a financial invariant, not a convention:
    -- a wasted unit must carry a loss, and a restocked or quarantined one must
    -- not invent one.
    CONSTRAINT chk_mrr_loss_matches_decision
        CHECK ((restock_decision = 'WASTE') = (loss_amount > 0))
);

CREATE INDEX IF NOT EXISTS idx_mrr_clinic_created
    ON medication_return_reversals (clinic_id, created_at DESC, reversal_id DESC);
CREATE INDEX IF NOT EXISTS idx_mrr_dispensing_item_batch
    ON medication_return_reversals (dispensing_item_batch_id);
CREATE INDEX IF NOT EXISTS idx_mrr_dispensing
    ON medication_return_reversals (dispensing_id);
