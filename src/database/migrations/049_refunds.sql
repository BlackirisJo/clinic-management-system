-- 049: Refund storage (Phase 10G.4a)
-- Idempotent migration. STORAGE ONLY — no endpoint, no writer, no behaviour.
--
-- 10G.3 activated the settlement boundary and made every new invoice
-- payment-backed: paid_amount is now the derived mirror of SUM(live payments).
-- Money in has a ledger. Money OUT has none — and `payments` structurally cannot
-- become it, because CHECK (amount > 0) leaves cash-out inexpressible by design.
--
-- This migration creates the storage half of that missing half. It grants the
-- permission that will gate the writer in 10G.4b and stops there: nothing in the
-- application can read or write this table yet, exactly as 047 shipped payments
-- with no writer and settlement_cutover empty.
--
-- ============================================================
-- 1. Why this is a separate table and not a signed payments row
-- ============================================================
-- The tempting design is one money table with a direction column. It is wrong here
-- for a concrete reason: 10G.2 built reconciliation on
--     invoices.paid_amount == SUM(payments WHERE voided_at IS NULL)
-- and on idx_payments_invoice_live, the partial index that makes that SUM cheap.
-- A signed amount would force the identity to become SUM(payments) - SUM(refunds),
-- which is a NET CASH figure, not "amount paid". Then invoiceStatus(net, paid)
-- would report a patient who paid in full and was refunded as UNPAID, and the
-- reports' `outstanding = net - paid` would grow by the refunded amount and
-- invent a debt that does not exist.
--
-- Two facts must stay separately comparable or reconciliation cannot detect a
-- refund that was never authorised: what came in, and what went back out.
--
-- So: payments is money in, refunds is money out. Each keeps its own immutable
-- history, its own live-sum index, and its own positive-amount rule. Nothing is
-- ever negative in either table, which is why a refund cannot be "un-refunded" by
-- flipping a sign — it is voided, exactly as a mis-keyed payment is.
--
-- ============================================================
-- 2. payment_id is NOT NULL — the anchor that makes over-refund a bound
-- ============================================================
-- A refund MUST name the payment whose cash it returns. That single decision
-- carries three properties that would otherwise have to be invented:
--
--   - Over-refund becomes an arithmetic fact:
--         SUM(live refunds on P) <= payments.amount
--     rather than a guess about the invoice's history.
--   - Clinic, currency and payer are AUTHORITY, not input: all three are copied
--     from the payment row, so a refund cannot disagree with the cash it returns.
--   - Multi-invoice refund is impossible by construction, not by policy. One
--     refund, one payment, one invoice reached through it.
--
-- invoice_id and clinic_id are denormalised exactly as payments does it: the
-- clinic scope of a refund must not depend on walking invoice_items, which can be
-- absent for a medication-only invoice, and reconciliation reports group by
-- clinic_id directly.
--
-- ON DELETE RESTRICT on every foreign key, for the same reason payments uses it:
-- deleting an invoice must never delete the record that money moved against it.
--
-- ============================================================
-- 3. reason and credit_id — the bridge to 044's entitlement
-- ============================================================
-- medication_return_credits.refund_due_amount is an AUTHORISATION: money that MAY
-- be handed back. Until now it had no consumer, so a credit row could claim an
-- entitlement that nothing could ever discharge.
--
-- credit_id is that link, and reason records which authorisation source was used.
-- Only RETURN_CREDIT exists today, because it is the only source that exists: a
-- service-level cancellation has no credit note table in this system, and
-- GOODWILL has no authorisation at all. Adding either without its source would be
-- inventing a requirement, so the CHECK admits one value and the column earns its
-- place by making each row self-describing in the audit trail.
--
-- credit_id is NULLABLE, and the entitlement requirement is a CHECK rather than
-- NOT NULL. That is deliberate and is what keeps this file from needing an ALTER
-- later: today the CHECK means a RETURN_CREDIT refund can never omit its credit,
-- and the moment a second reason is admitted the same CHECK stops demanding one
-- for that reason — no data migration, no dropped NOT NULL, no re-derivation of
-- existing rows.
--
-- credit_id is deliberately NOT UNIQUE, unlike return_item_id in 044. One credit
-- may legitimately be discharged in several partial hand-backs (several returns on
-- one invoice, or a patient taking part of it back in cash). The cap is an
-- aggregate the writer computes, not a uniqueness rule that would forbid the
-- second instalment.
--
-- ============================================================
-- 4. payer_type and method are constrained exactly as payments constrains them
-- ============================================================
-- method reuses the payment_method enum and admits CASH and CARD only, for the
-- same reason 047 does: INSURANCE and SPLIT are payer/contract facts, not ways of
-- handing over cash, and the CHECK is what stops that conflation from reaching a
-- disbursement. Historical invoices.payment_type values depend on those enum
-- members and must not be rewritten.
--
-- payer_type is VARCHAR + CHECK rather than a new enum type, matching 047: every
-- bounded value added after 001 is stored this way, because Postgres enums are
-- ALTER TYPE-only to extend.
--
-- A refund is returned to whoever paid. That is why payer_type is copied from the
-- payment and never supplied independently — the system cannot verify the identity
-- of the person taking the cash, so the column records the obligation, and
-- refunded_by_user_id records who discharged it.

CREATE TABLE IF NOT EXISTS refunds (
    refund_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The cash being returned. NOT NULL: see section 2.
    payment_id INT NOT NULL REFERENCES payments(payment_id) ON DELETE RESTRICT,
    -- Reached through the payment, denormalised for scoping and reporting.
    invoice_id INT NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    amount NUMERIC(10, 2) NOT NULL,
    -- Who the money goes back to. Copied from payments.payer_type by the writer.
    payer_type VARCHAR(20) NOT NULL,
    -- How it goes back. CASH and CARD only — see section 4.
    method payment_method NOT NULL,
    -- Copied from the payment and the invoice. No rate source exists in this
    -- system, so a mismatch must be refused by the writer, never converted.
    currency_code VARCHAR(3) NOT NULL REFERENCES currency_master(code) ON UPDATE CASCADE,
    -- The 044 entitlement this refund discharges. Required for RETURN_CREDIT.
    credit_id INT NULL REFERENCES medication_return_credits(credit_id) ON DELETE RESTRICT,
    -- Which authorisation source was used. One value exists; see section 3.
    reason VARCHAR(30) NOT NULL,
    reason_note TEXT NULL,
    refunded_by_user_id INT NOT NULL REFERENCES users(user_id),
    -- Server clock, never client-supplied: when the money actually left.
    refunded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The repair path for a mis-keyed refund, identical in shape to payments: the
    -- row is never deleted and never signed, so the transaction history stays
    -- complete while the live sum that caps future refunds can exclude it. A void
    -- is not a second refund and no cash moves.
    voided_at TIMESTAMPTZ NULL,
    voided_by_user_id INT NULL REFERENCES users(user_id),
    void_reason TEXT NULL,
    -- Double-submit anchor, same shape as payments.idempotency_key. Partial
    -- unique, so absent keys do not collide with each other.
    idempotency_key VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_refunds_amount_positive CHECK (amount > 0),
    CONSTRAINT chk_refunds_payer_type
        CHECK (payer_type IN ('PATIENT', 'INSURER')),
    CONSTRAINT chk_refunds_method_cash_card
        CHECK (method IN ('CASH', 'CARD')),
    -- One value today, and only one is legitimate: it is the sole authorisation
    -- source that exists. Widening this CHECK is how a second source arrives.
    CONSTRAINT chk_refunds_reason
        CHECK (reason IN ('RETURN_CREDIT')),
    -- A refund may not exist without the entitlement it discharges. Written as a
    -- CHECK rather than NOT NULL so a second reason can be admitted later without
    -- altering this column; see section 3.
    CONSTRAINT chk_refunds_return_credit_needs_credit
        CHECK (reason <> 'RETURN_CREDIT' OR credit_id IS NOT NULL),
    -- A void is one fact, not two halves that may disagree.
    CONSTRAINT chk_refunds_void_consistent
        CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL))
);

-- The aggregate that caps over-refund per payment: the live rows for one payment.
CREATE INDEX IF NOT EXISTS idx_refunds_payment_live
    ON refunds (payment_id) WHERE voided_at IS NULL;

-- The aggregate that answers "what did this invoice give back", for reconciliation.
CREATE INDEX IF NOT EXISTS idx_refunds_invoice_live
    ON refunds (invoice_id) WHERE voided_at IS NULL;

-- The 044 bridge: the live refunds charged against one entitlement.
CREATE INDEX IF NOT EXISTS idx_refunds_credit_live
    ON refunds (credit_id) WHERE credit_id IS NOT NULL AND voided_at IS NULL;

-- Per-clinic refund activity, the same ordering shape as 044's credit index.
CREATE INDEX IF NOT EXISTS idx_refunds_clinic_created
    ON refunds (clinic_id, refunded_at DESC, refund_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_payment_idempotency
    ON refunds (payment_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 5. RECORD_REFUND — its own permission
-- ============================================================
-- Granting RECORD_PAYMENT would be a silent promotion from collecting to
-- disbursing. The two permissions are bounded by different ceilings: a payment is
-- capped by the invoice's own net_amount, while a refund is capped by cash that
-- actually arrived. A role that can collect could therefore hand back money it
-- was never authorised to hand back — and would do so without ever touching the
-- permission that says it may.
--
-- Issuing an invoice asserts what is owed, recording a payment asserts cash
-- arrived, issuing a refund asserts cash left AND that collections were
-- overstated. Three different questions, often three different people.
--
-- Grant: ACCOUNTANT holds the finance-writing rights already (CREATE_INVOICE,
-- RECORD_PAYMENT, CREATE_EXPENSE, MANAGE_SERVICES), so it is the role that
-- settles and the role that returns. RECEPTIONIST has no CREATE_INVOICE, so it
-- cannot even produce the document it would be returning against. DOCTOR, NURSE
-- and PHARMACIST are clinical roles with no financial rights at all.
--
-- FINANCIAL_AUDITOR is excluded deliberately and structurally: it is read-only
-- inspection (VIEW_INVOICES, VIEW_FINANCIAL_REPORTS, VIEW_REPORTS), and a
-- permission that moves money must never be reachable by the role whose whole
-- purpose is to check someone else's money without changing it.
--
-- SUPER_ADMIN and SYSTEM_ADMIN are listed for consistency with every other
-- permission migration in this project; requirePermission already bypasses them,
-- and seed.ts grants administrators every permission in the table regardless.

INSERT INTO permissions (permission_key, permission_group, description)
VALUES ('RECORD_REFUND', 'Finance', 'تسجيل استرداد نقدي على دفعة محصّلة')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('ACCOUNTANT', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key = 'RECORD_REFUND'
ON CONFLICT DO NOTHING;

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - NO endpoint, route, controller or validation. Nothing writes or reads a
--   refund yet: this table has no writer in the application, exactly as payments
--   had none in 10G.1.
-- - NO behaviour of any kind. The caps (amount <= the payment's unrefunded
--   balance, amount <= the credit's unrefunded entitlement) are cross-row facts
--   that a CHECK cannot express; they belong to the 10G.4b write path, under the
--   invoice/payment row locks. The schema here cannot enforce them and does not
--   pretend to.
-- - NO refund void and NO payment void. Both tables already carry the void
--   columns and the consistency CHECK; the endpoints are a separate decision and
--   are deliberately not introduced by this file.
-- - NO change to payments, invoices, invoice_items or to 043/044/047/048. No
--   column is added to any existing table, no row is updated, and
--   invoices.paid_amount is not mentioned here at all: a refund does not move it,
--   and the table it would move is not this one's business.
-- - NO change to reports, KPIs or the overview. reports.controller.ts reads
--   invoices.paid_amount and has never read the payments table; a refunds table
--   is invisible to it, and adding net-cash reporting is a later phase with its
--   own numbers to agree on.
-- - NO second reason value (SERVICE_CANCELLATION, GOODWILL): neither has an
--   authorisation source in this system.
-- - NO UI, no i18n, no allocation table, no multi-invoice refund, no general
--   ledger, no FX or rate column, no unsigned or negative amount anywhere.
