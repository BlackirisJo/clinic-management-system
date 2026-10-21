-- 040: Dispensing Financial Snapshot (Phase 10E.3)
-- One additive nullable column and one index. Nothing else.
--
-- 10E.2 gave medication_prices a clinic-scoped, append-only selling price, but
-- nothing connected a dispensing to a price: dispensing_items froze purchase
-- COST (dispensing_item_batches.unit_cost_snapshot) and no revenue side at all.
-- A later price change therefore had no way to alter — or even be seen against —
-- what a past dispensing was sold for.
--
-- unit_price_snapshot is the selling price frozen at dispensing time, per
-- dispensing item. It mirrors the existing unit_cost_snapshot on the same table:
-- the same "frozen at the moment of the transaction" intent, on the same row.
--
-- NULL is required, not optional-by-accident:
-- - dispensing_items rows created before 10E.3 have no selling price, because no
--   price existed when they were written. They must stay valid and must NOT be
--   backfilled from the current price: a backfill would assert a charge that
--   never happened, and would differ per row depending on when it ran.
-- - A zero price is a real, legitimate price (free medication), so it is
--   distinguishable from "unknown" rather than encoded as 0.
-- The dispensing writer only ever writes this column on INSERT. No code path
-- updates it, so a stored snapshot can never be rewritten by a later price change.
--
-- NUMERIC(10,2) deliberately matches medication_prices.unit_price and
-- invoice_items.price exactly, so no rounding or rescaling happens at the
-- snapshot boundary.
--
-- Deliberately NOT in this migration:
-- - No invoice, invoice_items row, payment or refund. Charging a dispensing is a
--   later phase; 10E.3 freezes a price, it does not bill.
-- - No COGS computation and no change to how dispensing_item_batches.unit_cost_snapshot
--   or medication_return_items.unit_cost_snapshot work.
-- - No backfill of historical rows, and no column on dispensing_item_batches: a
--   selling price is per medication/dispensing item, so one dispensing item fed
--   by several FEFO batches still carries exactly one selling price.
-- - No price_id / medication_prices FK column. The snapshot must survive the
--   price row it came from, so it stores the amount, not the reference.

ALTER TABLE dispensing_items
    ADD COLUMN IF NOT EXISTS unit_price_snapshot NUMERIC(10,2);

-- Non-negative, and NULL stays allowed for pre-10E.3 rows
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_unit_price_nonneg
    CHECK (unit_price_snapshot IS NULL OR unit_price_snapshot >= 0);

-- "what was this dispensing line charged at" — the read that 10E.3 exists for
CREATE INDEX IF NOT EXISTS idx_dispensing_items_unit_price
    ON dispensing_items (unit_price_snapshot);