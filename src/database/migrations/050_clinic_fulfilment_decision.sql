-- 050: Add CLINIC_DISPENSING as explicit patient fulfilment decision (Phase 10F.2)
--
-- Business rule: Prescription != Patient Decision != Dispensing.
-- PENDING = "not decided yet" must NEVER be interpreted as "from clinic".
-- CLINIC_DISPENSING = explicit patient choice to get medication from clinic.
--
-- This migration adds CLINIC_DISPENSING to the CHECK constraint on
-- prescription_items.fulfilment_status. No other changes.

-- The constraint must be dropped and recreated because PostgreSQL
-- does not support ALTER CHECK CONSTRAINT ... ADD VALUE.
-- Since we only add one value, this is safe and fast.

ALTER TABLE prescription_items
    DROP CONSTRAINT IF EXISTS chk_pi_fulfilment_status;

ALTER TABLE prescription_items
    ADD CONSTRAINT chk_pi_fulfilment_status
    CHECK (fulfilment_status IN (
        'PENDING',
        'CLINIC_DISPENSING',
        'DISPENSED_FROM_CLINIC',
        'EXTERNAL_PHARMACY',
        'PATIENT_DECLINED',
        'PARTIALLY_DISPENSED',
        'CANCELLED'
    ));