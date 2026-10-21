-- 042: Dispensing COGS (Phase 10E.5)
-- One additive nullable column and one index. Nothing else.
--
-- 10E.3 froze the selling price of a dispensing. Nothing recorded what that
-- dispensed stock COST, so a margin could never be computed after the fact.
--
-- cogs_amount is the cost of goods sold for ONE dispensing item, frozen at the
-- moment the dispensing completed — the moment inventory actually leaves the
-- clinic. It is derived ONLY from that item's own allocation snapshots:
--
--     SUM(dispensing_item_batches.quantity * dispensing_item_batches.unit_cost_snapshot)
--
-- Never from inventory_batches.unit_cost (the batch's CURRENT cost, which a
-- later repricing would rewrite), never from medication_prices.unit_price, and
-- never from the invoice's selling price. Those would all describe today rather
-- than history, and would let a later price change silently restate a past
-- dispensing's margin.
--
-- Multi-batch is the normal case, not an edge case: FEFO may fulfil one
-- dispensing item from several batches, each with its own acquisition cost.
-- The SUM over all of that item's allocation rows is the only correct answer,
-- and it is why this is a per-ITEM figure rather than a per-batch one.
--
-- NULL is required, not optional-by-accident:
-- - dispensing_items rows created before 10E.5 have no COGS, because none was
--   recorded when they were written. They must stay valid and must NOT be
--   backfilled: their dispensing_item_batches rows are equally historical, but
--   a backfill would assert a cost computed long after the fact rather than
--   one frozen at the financial event.
-- - NULL therefore means "not recognized", and readers must treat it as such
--   rather than as zero. A missing cost is a real gap, not free medication.
-- The dispensing writer only ever writes this column inside the transaction
-- that completes the dispensing, immediately after the allocation rows it
-- derives from. No code path updates it afterwards.
--
-- NUMERIC(20,7) is deliberate and is NOT a currency precision. The product of
-- quantity NUMERIC(12,3) and unit_cost_snapshot NUMERIC(10,4) carries up to
-- SEVEN decimal places, so any narrower scale would silently round the frozen
-- cost and break the tie-out back to the allocation rows that produced it.
-- Callers that need a display or reporting figure round it themselves.
--
-- Deliberately NOT in this migration:
-- - No COGS for medication returns. A return reverses cost, and reversal is
--   Phase 10E.7. Existing return movements and their unit_cost_snapshot are
--   untouched, so return stock keeps its own historical cost unchanged.
-- - No inventory valuation of remaining stock (Phase 10E.6) and no
--   per-dispensing total column: the total is SUM(cogs_amount) over the
--   dispensing's items, so storing it would duplicate data already present.
-- - No ledger, journal entry, account, or chart of accounts. This is one
--   measured cost figure on the dispensing, not an accounting system.
-- - No change to medication pricing, FEFO ordering, stock deduction, or the
--   10E.4 invoice behaviour.

ALTER TABLE dispensing_items
    ADD COLUMN IF NOT EXISTS cogs_amount NUMERIC(20,7);

-- Non-negative, and NULL stays allowed for pre-10E.5 rows
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_cogs_nonneg
    CHECK (cogs_amount IS NULL OR cogs_amount >= 0);

-- "what did this dispensing line cost" — the read 10E.5 exists for, and the
-- same shape as the 10E.3 unit_price_snapshot index.
CREATE INDEX IF NOT EXISTS idx_dispensing_items_cogs
    ON dispensing_items (cogs_amount);
