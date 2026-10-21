-- 041: Medication Invoice Lines (Phase 10E.4)
-- Links a completed dispensing to exactly one medication invoice charge.
-- Foundation only: this migration adds columns and constraints. It creates no
-- invoice and contains no writer — the acting endpoint is the 10E.4 service.
--
-- CORE RULE — invoice by DISPENSING, not by prescription:
--   The unit of charging is the dispensing. A full dispensing, a partial
--   dispensing, and a later repeat dispensing of the SAME prescription are three
--   separate dispensings, so each produces its own charge. Basing uniqueness on
--   prescription_id would collapse a repeat charge into the first one, and
--   basing it on the visit would collapse unrelated visits together.
--
-- DUPLICATE PREVENTION:
--   uq_invoice_items_dispensing_item is the enforcement point. One
--   dispensing_item can be charged exactly once, so a dispensing can never be
--   invoiced twice — every one of its lines would collide. The index is PARTIAL
--   (WHERE dispensing_item_id IS NOT NULL), so clinic-service lines are entirely
--   unaffected and keep their existing ids.
--
-- IDENTITY IS COPIED, NOT REFERENCED FOR PRICE:
--   medication_id and dispensing_id are denormalised onto the line so a charge
--   stays readable after the source rows move on. unit_price_snapshot is the
--   frozen unit price copied from dispensing_items at charge time; it is NOT a
--   foreign key to medication_prices, so a later price change cannot alter a
--   charge that already exists.
--
-- PRESERVING THE EXISTING SERVICE MODEL:
--   clinic_services is untouched and no medication line references it
--   (chk_ii_medication_no_service). invoice_items.price and quantity keep their
--   exact meaning for service lines.
--
-- WHY price HOLDS THE LINE TOTAL ON A MEDICATION LINE:
--   Every existing revenue aggregate — billing.controller financial indicators,
--   reports.controller overview/summary — computes SUM(price * quantity). Those
--   must include medication revenue without being rewritten, so a medication
--   line stores its LINE TOTAL in price and 1 in quantity, keeping the product
--   correct. The exact unit price and the exact fractional dispensed quantity
--   are preserved alongside in unit_price_snapshot and dispensed_quantity, and
--   chk_ii_medication_line_total makes the two representations unable to drift.
--
--   This matters because dispensed_quantity is NUMERIC(12,3) and can be
--   fractional (ML, GRAM, PUFF doses), while the legacy quantity column is
--   INT NOT NULL CHECK (quantity BETWEEN 1 AND 9999) and cannot hold it.

-- ============================================================
-- 1. Medication charge columns on invoice_items
-- ============================================================
-- All nullable: an existing clinic-service line has none of these set, so no
-- historical invoice row changes meaning.
ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS dispensing_id INT REFERENCES dispensings(dispensing_id) ON DELETE RESTRICT;
ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS dispensing_item_id INT REFERENCES dispensing_items(dispensing_item_id) ON DELETE RESTRICT;
ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS medication_id INT REFERENCES medications(medication_id) ON DELETE RESTRICT;
-- الكمية المصروفة فعلياً — قد تكون كسرية (مل، غرام)، لذا لا تُخزَّن في quantity
ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS dispensed_quantity NUMERIC(12,3);
-- سعر البيع المجمّد وقت الصرف، لا السعر الحالي
ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS unit_price_snapshot NUMERIC(10,2);
-- إجمالي السطر عند التسعير، محفوظ صراحةً لا مُشتق
ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);

-- ============================================================
-- 2. Line-shape constraints
-- ============================================================
-- A medication line is complete or it is not a medication line: all five values
-- travel together, so a half-written charge can never look valid.
ALTER TABLE invoice_items
    ADD CONSTRAINT chk_ii_medication_line_complete CHECK (
        dispensing_item_id IS NULL
        OR (dispensing_id IS NOT NULL
            AND medication_id IS NOT NULL
            AND dispensed_quantity IS NOT NULL
            AND unit_price_snapshot IS NOT NULL
            AND line_total IS NOT NULL)
    );

-- بند الدواء لا يستخدم clinic_services إطلاقاً — خدمة ودواء لا يجتمعان في سطر واحد
ALTER TABLE invoice_items
    ADD CONSTRAINT chk_ii_medication_no_service CHECK (
        dispensing_item_id IS NULL OR service_id IS NULL
    );

-- صنف مخصوم دائماً، وسعر بيع المجمّد غير سالب، ومجموع السطر متسق
ALTER TABLE invoice_items
    ADD CONSTRAINT chk_ii_dispensed_quantity_positive CHECK (
        dispensing_item_id IS NULL OR dispensed_quantity > 0
    );
ALTER TABLE invoice_items
    ADD CONSTRAINT chk_ii_unit_price_nonneg CHECK (
        dispensing_item_id IS NULL OR unit_price_snapshot >= 0
    );
-- الإجمالي لا ينسجم إلا مع الكمية والسعر المجمّدين — يمنع انفصال price عن قيمته
ALTER TABLE invoice_items
    ADD CONSTRAINT chk_ii_medication_line_total CHECK (
        dispensing_item_id IS NULL
        OR line_total = ROUND(dispensed_quantity * unit_price_snapshot, 2)
    );

-- ============================================================
-- 3. Duplicate prevention — one charge per dispensing item
-- ============================================================
-- This is what makes "a dispensing is invoiced exactly once" a database fact
-- rather than an application convention: a second charge for the same
-- dispensing cannot be committed, because at least one of its lines collides.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_items_dispensing_item
    ON invoice_items (dispensing_item_id)
    WHERE dispensing_item_id IS NOT NULL;

-- "was this dispensing already charged?" — the lookup the writer races on
CREATE INDEX IF NOT EXISTS idx_invoice_items_dispensing
    ON invoice_items (dispensing_id)
    WHERE dispensing_id IS NOT NULL;

-- ============================================================
-- 4. Deliberately NOT in this migration
-- ============================================================
-- - No payment, refund, credit note or paid_amount change: the charge is issued
--   unpaid, and how it is settled is a later phase.
-- - No COGS, inventory valuation, or return financial reversal. The historical
--   dispensing cost stays on dispensing_item_batches.unit_cost_snapshot.
-- - No change to invoice_items.price / quantity / doctor_share semantics for
--   clinic-service lines, and no change to billing.controller or any report.
-- - No invoice_number, status or payment_status redesign.
-- - No backfill: no existing invoice row gains a dispensing reference.