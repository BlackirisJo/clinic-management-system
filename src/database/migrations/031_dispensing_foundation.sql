-- 031: Dispensing Foundation (Phase 10C.0)
-- Pre-work only: schema + permission. NO dispensing logic, endpoints, or stock movement.
-- Deliberately does NOT touch: stock_movements, inventory_batches quantities, quantity_reserved writers.

-- ============================================================
-- 1. Prescription quantity vocabulary
-- ============================================================
-- Historical rows keep NULL prescribed_quantity/uom: the free-text `dosage`
-- column (e.g. "1 x 3") is NEVER parsed to fabricate a quantity.
-- NULL means "not safely defined" — the future dispensing path must reject it.
--
-- repeats_count is deliberately NOT used as a quantity multiplier. It is only
-- stored and displayed today (PharmacyView renders "dosage × repeats_count") and
-- has no defined semantics in the backend, so 10C must not infer quantity from it.

ALTER TABLE prescription_items
    ADD COLUMN IF NOT EXISTS prescribed_quantity NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS uom VARCHAR(20);

-- A prescribed quantity must be strictly positive when defined (> 0 excludes a
-- meaningless zero, which is covered by NULL meaning "undefined" instead).
ALTER TABLE prescription_items
    ADD CONSTRAINT chk_pi_prescribed_quantity_positive CHECK (prescribed_quantity IS NULL OR prescribed_quantity > 0);

-- نفس مفردات وحدات القياس في inventory_items (migration 029) — بلا تحويل بين الوحدات
ALTER TABLE prescription_items
    ADD CONSTRAINT chk_pi_uom_valid CHECK (uom IS NULL OR uom IN (
    'TABLET', 'CAPSULE', 'ML', 'AMPULE', 'VIAL',
    'BOTTLE', 'TUBE', 'GRAM', 'PUFF', 'DROP', 'SUPPOSITORY'
));

-- ============================================================
-- 2. Dispensing permission
-- ============================================================
INSERT INTO permissions (permission_key, permission_group, description)
VALUES ('DISPENSE_MEDICATIONS', 'Pharmacy', 'Dispense prescribed medications and record dispensing transactions')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('PHARMACIST', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key = 'DISPENSE_MEDICATIONS'
ON CONFLICT DO NOTHING;

-- ============================================================
-- 3. Dispensings (header)
-- ============================================================
-- clinic_id / visit_id are denormalized from the prescription's visit so that
-- clinic scope, audit, and a future billing link never need a multi-table join.
--
-- ALL foreign keys are ON DELETE RESTRICT: dispensing history must never be
-- destroyed by deleting an upstream record. Note that prescription_items cascades
-- from prescriptions, so a RESTRICT here is what actually blocks that path.
CREATE TABLE IF NOT EXISTS dispensings (
    dispensing_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prescription_id INT NOT NULL REFERENCES prescriptions(prescription_id) ON DELETE RESTRICT,
    visit_id INT NOT NULL REFERENCES visits(visit_id) ON DELETE RESTRICT,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    patient_id INT NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    dispensed_by_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at TIMESTAMPTZ,
    voided_by_user_id INT REFERENCES users(user_id) ON DELETE RESTRICT,
    void_reason TEXT
);

ALTER TABLE dispensings
    ADD CONSTRAINT chk_dispensing_status_valid CHECK (status IN ('COMPLETED', 'PARTIAL', 'VOIDED'));

-- الإلغاء يتطلّب بيانات إلغاء كاملة والعكس (سجل ملغى بلا سبب = سجل ناقص)
ALTER TABLE dispensings
    ADD CONSTRAINT chk_dispensing_void_consistent
    CHECK ((status = 'VOIDED') = (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_dispensings_prescription_id ON dispensings (prescription_id);
CREATE INDEX IF NOT EXISTS idx_dispensings_clinic_id ON dispensings (clinic_id);
CREATE INDEX IF NOT EXISTS idx_dispensings_dispensed_by ON dispensings (dispensed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_dispensings_status ON dispensings (status);
CREATE INDEX IF NOT EXISTS idx_dispensings_created_at ON dispensings (created_at DESC);

-- ============================================================
-- 4. Dispensing items (per prescription line)
-- ============================================================
-- One row per prescription line, regardless of how many batches fulfil it.
-- prescribed = dispensed + remaining is enforced, so partial dispensing can
-- never drift. No selling price: charge pricing belongs to Phase 10E.
CREATE TABLE IF NOT EXISTS dispensing_items (
    dispensing_item_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispensing_id INT NOT NULL REFERENCES dispensings(dispensing_id) ON DELETE RESTRICT,
    prescription_item_id INT NOT NULL REFERENCES prescription_items(item_id) ON DELETE RESTRICT,
    medication_id INT NOT NULL REFERENCES medications(medication_id) ON DELETE RESTRICT,
    inventory_item_id INT NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    prescribed_quantity NUMERIC(12,3) NOT NULL,
    dispensed_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
    remaining_quantity NUMERIC(12,3) NOT NULL,
    uom VARCHAR(20) NOT NULL,
    unit_cost_snapshot NUMERIC(10,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_prescribed_quantity_positive CHECK (prescribed_quantity > 0);
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_dispensed_quantity_nonneg CHECK (dispensed_quantity >= 0);
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_remaining_quantity_nonneg CHECK (remaining_quantity >= 0);
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_quantities_balance CHECK (prescribed_quantity = dispensed_quantity + remaining_quantity);
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_uom_valid CHECK (uom IN (
    'TABLET', 'CAPSULE', 'ML', 'AMPULE', 'VIAL',
    'BOTTLE', 'TUBE', 'GRAM', 'PUFF', 'DROP', 'SUPPOSITORY'
));
ALTER TABLE dispensing_items
    ADD CONSTRAINT chk_di_unit_cost_nonneg CHECK (unit_cost_snapshot IS NULL OR unit_cost_snapshot >= 0);

-- مهم: يجعل "هل فُرِض هذا البند؟" استعلاماً واحداً بدل جمع كل عمليات الصرف
CREATE INDEX IF NOT EXISTS idx_dispensing_items_prescription_item ON dispensing_items (prescription_item_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_items_dispensing ON dispensing_items (dispensing_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_items_inventory_item ON dispensing_items (inventory_item_id);

-- ============================================================
-- 5. Dispensing item batches (allocation lines)
-- ============================================================
-- سطر تخصيص واحد لكل دفعة — يتيح إتمام سطر واحد من عدة دفعات (FEFO).
-- expiry_date_snapshot / unit_cost_snapshot تُجمَّد لحظة الصرف حتى لا تتغيّر
-- مع تعديلات الدفعة لاحقاً، وتصلح Phase 10E للربط بالفوترة دون إعادة تصميم.
CREATE TABLE IF NOT EXISTS dispensing_item_batches (
    dispensing_item_batch_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispensing_item_id INT NOT NULL REFERENCES dispensing_items(dispensing_item_id) ON DELETE RESTRICT,
    batch_id INT NOT NULL REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
    quantity NUMERIC(12,3) NOT NULL,
    unit_cost_snapshot NUMERIC(10,4),
    expiry_date_snapshot DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- سطر التخصيص يصف كمية موجبة دائماً — صفر أو سالب لا معنى له كتخصيص
ALTER TABLE dispensing_item_batches
    ADD CONSTRAINT chk_dib_quantity_positive CHECK (quantity > 0);
ALTER TABLE dispensing_item_batches
    ADD CONSTRAINT chk_dib_unit_cost_nonneg CHECK (unit_cost_snapshot IS NULL OR unit_cost_snapshot >= 0);

CREATE INDEX IF NOT EXISTS idx_dispensing_item_batches_item ON dispensing_item_batches (dispensing_item_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_item_batches_batch ON dispensing_item_batches (batch_id);

-- ============================================================
-- Not in this migration (by design)
-- ============================================================
-- - No stock_movements changes. DISPENSE movements come in 10C.2.
-- - No quantity_reserved writers. Dispensing deducts available stock directly.
-- - No change to inventory_batches quantity model, no packaging/unit conversion.
-- - The future locked FEFO allocator must run on the SAME PoolClient transaction
--   as dispensing. The read-only selectFefoBatches() helper stays unlocked; a
--   separate locked sibling must accept that client (Phase 10C.1).
