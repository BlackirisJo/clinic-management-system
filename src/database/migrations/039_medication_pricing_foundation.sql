-- 039: Medication Pricing Foundation (Phase 10E.2)
-- The first selling-price data in the system. Before this migration the ONLY
-- price in the database was clinic_services.price, which prices clinic SERVICES
-- and is deliberately not reused here: nothing relates it to medications, and its
-- doctor_percentage / doctor_share semantics do not apply to a drug.
--
-- Price granularity: clinic + inventory item. inventory_items is the existing
-- clinic-to-medication bridge (clinic_id + medication_id), so a price belongs to
-- one clinic's stocked unit of one medication — not to the global medication
-- catalog, which is not clinic-scoped.
--
-- Cost stays where it is: inventory_batches.unit_cost is purchase cost, and
-- dispensing_item_batches.unit_cost_snapshot is the frozen historical dispensing
-- cost. Neither is a selling price and neither is altered here.
--
-- HISTORY MODEL — append-only, never an UPDATE of the amount:
--   Changing a price DEACTIVATES the current row (is_active = FALSE,
--   effective_to = NOW()) and INSERTS a new active row. unit_price on an existing
--   row is therefore immutable, so a price that was charged in the past can never
--   be rewritten by a later price change. This mirrors how
--   dispensing_item_batches.unit_cost_snapshot is frozen at dispensing time.
--
-- Deliberately NOT in this migration:
-- - No invoice, invoice_items row, payment or refund. Charging a dispensing is
--   Phase 10E.3; this phase stores prices only and creates no financial document.
-- - No dispensing_items.unit_price_snapshot column and no write to any dispensing
--   table: nothing here touches dispensing, FEFO, stock movements, stock counts,
--   returns, or COGS.
-- - No reuse of clinic_services, and no change to invoice_items.
-- - No deletion path. Prices are deactivated, never deleted, so that every
--   historical price a dispensing may later be charged against still exists.

CREATE TABLE IF NOT EXISTS medication_prices (
    price_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Server-derived from inventory_items.clinic_id at write time, never
    -- client-supplied. Denormalised so scoped reads are a single indexed predicate.
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    inventory_id INT NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    -- Selling price per one unit of inventory_items.uom. NULL is not allowed: an
    -- unknown selling price is not a price.
    unit_price NUMERIC(10,2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    -- effective_from defaults to the insert instant; the writer may backdate it
    -- explicitly. effective_to is closed by the server when the price stops being
    -- the current one, and is never set by a client.
    effective_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    effective_to TIMESTAMPTZ,
    created_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_mp_unit_price_nonneg CHECK (unit_price >= 0),
    -- effective_to must be present iff the price is no longer active: an active
    -- price is by definition the current one, and a deactivated price must state
    -- when it stopped being current.
    CONSTRAINT chk_mp_effective_consistent CHECK (
        (is_active AND effective_to IS NULL) OR (NOT is_active AND effective_to IS NOT NULL)
    )
);

-- At most one active price per inventory item: a stocked item has exactly one
-- current selling price. Superseded rows are unconstrained, which is what makes
-- the history complete.
CREATE UNIQUE INDEX IF NOT EXISTS uq_medication_prices_inventory_active
    ON medication_prices (inventory_id)
    WHERE is_active;

-- "the current price of this item" and "every price this item ever had"
CREATE INDEX IF NOT EXISTS idx_medication_prices_inventory_history
    ON medication_prices (inventory_id, effective_from DESC, price_id DESC);
CREATE INDEX IF NOT EXISTS idx_medication_prices_clinic
    ON medication_prices (clinic_id, is_active);
CREATE INDEX IF NOT EXISTS idx_medication_prices_created_by
    ON medication_prices (created_by_user_id);