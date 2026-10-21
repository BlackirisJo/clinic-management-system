-- 044: Medication return revenue credit + medication discount snapshot (Phase 10E.8)
-- One additive column on invoice_items, one additive credit table.
--
-- 10E.7 reversed the COST of a returned drug. Nothing reversed the REVENUE: the
-- patient kept a credit note in words only, and the clinic's books still showed
-- a charge for medication the patient no longer had. This phase closes that.
--
-- ============================================================
-- 1. The medication discount is NOT the clinic discount
-- ============================================================
-- invoices.discount_amount is a clinic/service-level invoice discount. It is a
-- single scalar with no per-item basis, so it can never be attributed to one
-- medication line. This phase therefore NEVER reads it when crediting.
--
-- A medication charge carries its own discount instead, snapshotted on the
-- invoice line as a value 0-100:
--     0   = no medication discount
--     100 = medication fully free
--     1-99 = that percentage of the medication charge
--
-- It is a single value, not a percent column beside an amount column: one
-- number, one meaning. Storing a separate "percent" would allow the two to
-- disagree. Whatever produced the value (loyalty in future) is irrelevant to
-- history, which is exactly why it is snapshotted.
--
-- NULL is required and means "no snapshot exists", NOT "no discount":
-- - invoice_items rows created before 10E.8 have no such column value, because
--   the discount they were charged was never recorded. Those rows are left NULL
--   and are NOT backfilled: asserting a discount now would be inventing a
--   historical financial fact.
-- - A credit cannot be computed from a line whose discount was never recorded,
--   so the credit path refuses to guess (see the controller). Readers must treat
--   NULL as unknown, not as zero.
--
-- The existing medication charge path writes the snapshot, defaulting to 0
-- because no loyalty system exists yet. It is written on every NEW medication
-- line, which is what makes every future reversal exact.

ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS medication_discount_value NUMERIC(5,2);

ALTER TABLE invoice_items
    ADD CONSTRAINT chk_ii_medication_discount_range
    CHECK (medication_discount_value IS NULL OR (medication_discount_value >= 0 AND medication_discount_value <= 100));

-- ============================================================
-- 2. The credit
-- ============================================================
-- One immutable row per return line. The original invoice_items row is never
-- touched: it remains the historical record of what was charged, and the credit
-- is a separate, additive statement about what that charge gave back.
--
-- The chain is deliberately explicit — return_item_id → reversal_id (10E.7's
-- cost side) → dispensing/dispensing_item → invoice/invoice_item — so the cost
-- and revenue sides of one return can be joined without inference, and so 10E.9
-- can attach an actual refund to this row later.
--
-- The calculation, in SQL and in NUMERIC:
--     gross            = returned_quantity × unit_price_snapshot
--     discount_amount  = ROUND(gross × medication_discount_value / 100, 2)
--     credit_amount    = gross - discount_amount
--
-- unit_price_snapshot and medication_discount_value are BOTH copied from the
-- invoice line. Neither is re-read from medication_prices, from a batch cost,
-- from the invoice's clinic discount, or from any current setting: a later price
-- or loyalty change must never restate a credit that was earned under the terms
-- in force at the time of the charge.
--
-- 2 decimals, matching every other money column on invoices/invoice_items. The
-- rounding happens once, here, in the database — never in JavaScript floats.

CREATE TABLE IF NOT EXISTS medication_return_credits (
    credit_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Idempotency anchor, identical to 10E.7: one credit per return line.
    return_item_id INT NOT NULL UNIQUE
        REFERENCES medication_return_items(return_item_id) ON DELETE RESTRICT,
    -- The 10E.7 cost reversal for the same return line. Ties the two halves of
    -- the return's financial effect together.
    reversal_id INT NOT NULL
        REFERENCES medication_return_reversals(reversal_id) ON DELETE RESTRICT,
    dispensing_id INT NOT NULL REFERENCES dispensings(dispensing_id) ON DELETE RESTRICT,
    dispensing_item_id INT NOT NULL
        REFERENCES dispensing_items(dispensing_item_id) ON DELETE RESTRICT,
    -- The charged line being credited. It is never modified.
    invoice_id INT NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
    invoice_item_id INT NOT NULL REFERENCES invoice_items(item_id) ON DELETE RESTRICT,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,

    returned_quantity NUMERIC(12,3) NOT NULL,
    -- Historical unit price and historical medication discount, both copied.
    unit_price_snapshot NUMERIC(10,2) NOT NULL,
    medication_discount_value NUMERIC(5,2) NOT NULL,
    -- gross = returned_quantity × unit_price_snapshot
    gross_amount NUMERIC(12,2) NOT NULL,
    -- gross − credit. This is what the medication was actually worth at the time
    -- it was charged, and it is what the credit is made of.
    net_amount NUMERIC(12,2) NOT NULL,
    credit_amount NUMERIC(12,2) NOT NULL,

    -- ============================================================
    -- 3. Revenue credit vs money owed vs money returned
    -- ============================================================
    -- These are three different facts and are stored as three columns so none
    -- can be mistaken for another:
    --
    -- credit_amount  — REVENUE was reduced. Always populated; the accounting fact.
    -- applied_to_outstanding — the credit cancelled part of what the patient still
    --   owed. Meaningful only while net_amount > paid_amount.
    -- refund_due_amount — an entitlement: money that MAY be handed back, and
    --   ONLY the portion that exceeds what was actually paid. It is NOT a refund
    --   and NOT a payment: there is no payment table, so no money has moved and
    --   this column never claims otherwise.
    --
    -- refund_due_amount is deliberately 0 for INSURANCE and SPLIT invoices: the
    -- payer is not the patient, and inventing a patient/payer split here would be
    -- a guess about a subsystem that does not exist. The revenue credit is still
    -- recorded in full; only the patient-facing entitlement is deferred.
    applied_to_outstanding NUMERIC(12,2) NOT NULL,
    refund_due_amount NUMERIC(12,2) NOT NULL,
    -- Copied so a later change to the invoice's payment state cannot silently
    -- rewrite what this row was decided against.
    invoice_net_amount NUMERIC(10,2) NOT NULL,
    invoice_paid_amount NUMERIC(10,2) NOT NULL,
    -- Copied, never converted.
    currency_code VARCHAR(10) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_mrc_quantity_positive CHECK (returned_quantity > 0),
    CONSTRAINT chk_mrc_discount_range
        CHECK (medication_discount_value >= 0 AND medication_discount_value <= 100),
    CONSTRAINT chk_mrc_amounts_nonneg
        CHECK (gross_amount >= 0 AND net_amount >= 0 AND credit_amount >= 0
               AND applied_to_outstanding >= 0 AND refund_due_amount >= 0),
    -- The credit is exactly the part that cancelled an outstanding balance plus
    -- the part that became refundable. Nothing may be lost or invented between
    -- them; that identity is the whole point of keeping them apart.
    CONSTRAINT chk_mrc_credit_split
        CHECK (applied_to_outstanding + refund_due_amount = credit_amount),
    -- net can never exceed gross, and the discount is the only difference.
    CONSTRAINT chk_mrc_net_le_gross CHECK (net_amount <= gross_amount)
);

CREATE INDEX IF NOT EXISTS idx_mrc_clinic_created
    ON medication_return_credits (clinic_id, created_at DESC, credit_id DESC);
CREATE INDEX IF NOT EXISTS idx_mrc_invoice
    ON medication_return_credits (invoice_id);
CREATE INDEX IF NOT EXISTS idx_mrc_invoice_item
    ON medication_return_credits (invoice_item_id);

-- ============================================================
-- Deliberately NOT here
-- ============================================================
-- - No payment, refund, or cash-movement table. refund_due_amount is an
--   entitlement, never a transaction.
-- - No loyalty system, and no allocation of invoices.discount_amount to a
--   medication line. The two discounts are independent by design.
-- - No backfill of medication_discount_value on pre-10E.8 invoice lines.
-- - No mutation of invoice_items, invoices totals, dispensing facts, or anything
--   10E.7 wrote. This is purely additive.
