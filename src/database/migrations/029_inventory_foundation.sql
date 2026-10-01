-- 029: Inventory Foundation (Phase 10B.1)
-- Idempotent migration: creates suppliers, inventory_items, inventory_batches, stock_movements
-- No dispensing tables. No business logic/triggers. No seed data.

-- ============================================================
-- 1. Inventory UOM codes (reference values, not a separate table)
-- ============================================================
-- UOM is stored as a coded TEXT column on inventory_items.
-- Allowed values enforced by CHECK constraint.
-- UOM and dosage_form are different concepts — separate code sets.

-- ============================================================
-- 2. Suppliers
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    name VARCHAR(200) NOT NULL,
    contact_info TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_suppliers_clinic_id ON suppliers (clinic_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_clinic_name ON suppliers (clinic_id, name);

-- ============================================================
-- 3. Inventory Items (one per clinic + medication)
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_items (
    inventory_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    medication_id INT NOT NULL REFERENCES medications(medication_id) ON DELETE RESTRICT,
    uom VARCHAR(20) NOT NULL,
    min_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
    reorder_point NUMERIC(12,3) NOT NULL DEFAULT 0,
    max_stock NUMERIC(12,3),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique stock definition per clinic + medication
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_clinic_medication
    ON inventory_items (clinic_id, medication_id)
    WHERE deleted_at IS NULL;

-- Stock thresholds non-negative
ALTER TABLE inventory_items
    ADD CONSTRAINT chk_inventory_min_stock_nonneg CHECK (min_stock >= 0);
ALTER TABLE inventory_items
    ADD CONSTRAINT chk_inventory_reorder_point_nonneg CHECK (reorder_point >= 0);
ALTER TABLE inventory_items
    ADD CONSTRAINT chk_inventory_max_stock_nonneg CHECK (max_stock IS NULL OR max_stock >= 0);
-- max_stock must be NULL or >= reorder_point
ALTER TABLE inventory_items
    ADD CONSTRAINT chk_inventory_max_ge_reorder CHECK (max_stock IS NULL OR max_stock >= reorder_point);

-- UOM controlled coded value (separate from dosage_form)
ALTER TABLE inventory_items
    ADD CONSTRAINT chk_inventory_uom_valid CHECK (uom IN (
        'TABLET', 'CAPSULE', 'ML', 'AMPULE', 'VIAL',
        'BOTTLE', 'TUBE', 'GRAM', 'PUFF', 'DROP', 'SUPPOSITORY'
    ));

-- ============================================================
-- 4. Inventory Batches (lot-level stock with expiry/cost/supplier)
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_batches (
    batch_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_id INT NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    supplier_id INT REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
    lot_number VARCHAR(100) NOT NULL,
    expiry_date DATE NOT NULL,
    quantity_on_hand NUMERIC(12,3) NOT NULL DEFAULT 0,
    quantity_reserved NUMERIC(12,3) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(10,4),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique lot within inventory item
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_batches_inventory_lot
    ON inventory_batches (inventory_id, lot_number);

-- Quantities non-negative
ALTER TABLE inventory_batches
    ADD CONSTRAINT chk_batch_qty_on_hand_nonneg CHECK (quantity_on_hand >= 0);
ALTER TABLE inventory_batches
    ADD CONSTRAINT chk_batch_qty_reserved_nonneg CHECK (quantity_reserved >= 0);
ALTER TABLE inventory_batches
    ADD CONSTRAINT chk_batch_qty_reserved_le_on_hand CHECK (quantity_reserved <= quantity_on_hand);
-- unit_cost NULL or >= 0
ALTER TABLE inventory_batches
    ADD CONSTRAINT chk_batch_unit_cost_nonneg CHECK (unit_cost IS NULL OR unit_cost >= 0);

-- FEFO query support
CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry ON inventory_batches (expiry_date);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_inventory_id ON inventory_batches (inventory_id);

-- ============================================================
-- 5. Stock Movements (immutable audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_movements (
    movement_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    movement_type VARCHAR(20) NOT NULL,
    quantity NUMERIC(12,3) NOT NULL,
    reference_type VARCHAR(50),
    reference_id VARCHAR(100),
    performed_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Movement type controlled values
ALTER TABLE stock_movements
    ADD CONSTRAINT chk_movement_type_valid CHECK (movement_type IN (
        'RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'WASTE', 'EXPIRE'
    ));

-- Quantity always positive (movement_type determines meaning)
ALTER TABLE stock_movements
    ADD CONSTRAINT chk_movement_quantity_positive CHECK (quantity > 0);

-- Indexes for audit/FEFO/traceability
CREATE INDEX IF NOT EXISTS idx_stock_movements_batch_created ON stock_movements (batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reference ON stock_movements (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements (created_at);