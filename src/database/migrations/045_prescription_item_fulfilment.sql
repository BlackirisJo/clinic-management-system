-- 045: Patient fulfilment decision per prescription item (Phase 10F.1)
--
-- The business rule: Prescription != Dispensing. Writing a prescription never
-- touches inventory, stock_movements, dispensings, invoice_items or any other
-- financial record, and Phase 1 proved that already holds. What the system
-- could NOT express was the only decision that actually remains: the PATIENT's
-- answer to "will you take this from the clinic, get it from an outside
-- pharmacy, or not take it at all?".
--
-- So this migration adds only the place that answer is written down. It creates
-- no dispensing, no stock movement, no charge, and touches no existing column.
--
-- ============================================================
-- 1. Additive only: existing rows are never rewritten
-- ============================================================
-- Every column added here is either nullable or carries a NOT NULL DEFAULT.
-- On PostgreSQL 11+ a NOT NULL DEFAULT is a metadata-only operation, so no
-- table rewrite and no row-by-row backfill happens: existing prescription_items
-- simply acquire 'PENDING' as the value they were always implicitly in.
--
-- 'PENDING' therefore means "not decided yet" and is deliberately NOT the same
-- fact as 'PATIENT_DECLINED'. Collapsing the two would destroy the only
-- distinction this phase exists to record.

ALTER TABLE prescription_items
    ADD COLUMN IF NOT EXISTS fulfilment_status VARCHAR(24) NOT NULL DEFAULT 'PENDING';

ALTER TABLE prescription_items
    ADD COLUMN IF NOT EXISTS decision_note VARCHAR(500);

ALTER TABLE prescription_items
    ADD COLUMN IF NOT EXISTS decided_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE prescription_items
    ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE prescription_items
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'CLINIC';

-- ============================================================
-- 2. Status ownership is expressed, not merely documented
-- ============================================================
-- fulfilment_status holds all six values because the column has to be able to
-- hold what the DISPENSING flow writes as well as what the decision endpoint
-- writes. Who may set which value is enforced in the application layer:
--
--   decision endpoint (PATCH /api/prescriptions/items/:id/fulfilment)
--       PENDING | EXTERNAL_PHARMACY | PATIENT_DECLINED | CANCELLED
--   dispensing flow (existing Phase 10C path)
--       DISPENSED_FROM_CLINIC | PARTIALLY_DISPENSED
--
-- The database refuses anything outside the list; the application refuses a
-- value the caller does not own. Neither substitutes for the other.
ALTER TABLE prescription_items
    ADD CONSTRAINT chk_pi_fulfilment_status
    CHECK (fulfilment_status IN (
        'PENDING',
        'DISPENSED_FROM_CLINIC',
        'EXTERNAL_PHARMACY',
        'PATIENT_DECLINED',
        'PARTIALLY_DISPENSED',
        'CANCELLED'
    ));

-- source answers "where is this medication coming from", which is not the same
-- question as fulfilment_status: a decision may be pending while the intended
-- source is already the clinic.
ALTER TABLE prescription_items
    ADD CONSTRAINT chk_pi_source
    CHECK (source IN ('CLINIC', 'EXTERNAL'));

CREATE INDEX IF NOT EXISTS idx_pi_fulfilment_status
    ON prescription_items (fulfilment_status);

-- ============================================================
-- 3. Deliberately NOT in this migration
-- ============================================================
-- - No backfill: no existing row's fulfilment_status is asserted. A prescription
--   from before this phase has no recorded patient answer, and 'not yet decided'
--   is the honest description of it.
-- - No new permission: CREATE_PRESCRIPTION (Prescriptions group) already covers
--   a recorded clinical decision on a prescription item, exactly as it already
--   covered repeat authorization in 032.
-- - No trigger, no generated column, no view. The dispensing flow writes
--   DISPENSED_FROM_CLINIC / PARTIALLY_DISPENSED itself; a trigger would move
--   that fact out of the transaction that actually dispenses.
-- - No constraint tying fulfilment_status to source: 'PENDING' with source
--   'EXTERNAL' is a legitimate "expected outside, not confirmed yet" row, and
--   forbidding it would invent workflow this phase was not asked for.
