-- 047: Settlement foundation — payments, cutover marker, payment permission
-- (Phase 10G.1)
-- Idempotent migration
--
-- 10G.0 audited the settlement model and locked the policy. Nothing in the system
-- can record money today: there is no payments table, no payment endpoint, and
-- invoices.paid_amount is written once at issuance (billing.controller.ts writes
-- net_amount for service invoices, 0 for medication charges) and never again.
--
-- This migration is the STORAGE half of that foundation and nothing else. It
-- creates the two structures the later phases read and write, plus the one
-- permission that will gate the write. It deliberately inserts no cutover row,
-- so the boundary between legacy and payment-backed invoices does not exist yet,
-- and it changes no existing table, column, value, permission or role.
--
-- ============================================================
-- 1. payments — immutable transaction history
-- ============================================================
-- One row per cash-in against exactly one invoice. Multi-invoice allocation, a
-- general ledger, FX conversion and refunds are all absent by decision (10G.0),
-- and their absence is structural here: there is no allocation table to join
-- through, no currency-rate column to convert through, and no signed amount that
-- could double as a cash-out.
--
-- invoice_id is one column, not a join table: a payment settles one invoice. The
-- reason is not simplicity but auditability — reconciliation compares
-- SUM(live payments) to invoices.paid_amount per invoice, and a many-to-many
-- allocation would make that comparison indirect and therefore unverifiable.
--
-- amount NUMERIC(10,2) CHECK amount > 0 is what makes this table incapable of
-- expressing a refund. There is no sign bit to flip: cash out cannot be recorded
-- here at all, which is the whole reason refunds will be a separate table in a
-- later phase rather than a convention on this one.
--
-- method reuses the existing payment_method enum (001) rather than declaring a
-- new type, but the CHECK admits only CASH and CARD. INSURANCE and SPLIT remain
-- in the enum because historical invoices.payment_type values depend on them and
-- must not be rewritten; they are payer/contract facts, not methods of handing
-- over cash, and the CHECK is what stops that conflation from reaching a payment.
-- The payer who hands the cash over is payer_type, on its own column.
--
-- payer_type is VARCHAR + CHECK, not a new enum type, matching how every bounded
-- value added after 001 was stored (031 dispensing status, 044 return status, 045
-- fulfilment status). Postgres enums are ALTER TYPE-only to extend: a third payer
-- later would be a schema migration on an existing type rather than a CHECK edit.
--
-- voided_at / voided_by_user_id are the repair path for a mis-keyed payment. They
-- are additive and non-destructive: the row is never deleted and never updated in
-- amount, payer, method, currency or invoice, so the transaction history stays
-- complete while the live total that reconciliation uses can exclude it. Void is
-- not a refund — no cash moves and no negative row is written.
--
-- idempotency_key is the double-submit anchor for a money endpoint, the same
-- shape as medication_return_credits.return_item_id and the dispensing charge's
-- unique invoice line. Partial unique index, so NULL keys (no key supplied) do
-- not collide with each other.
--
-- received_at is server-defaulted and is never client-supplied: the time money
-- arrived is a system fact, and a client-chosen timestamp is a forgeable one.
-- created_at records when the row was written, which is a different fact from
-- when the payment happened.

CREATE TABLE IF NOT EXISTS payments (
    payment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- RESTRICT, never CASCADE: deleting an invoice must never delete the record
    -- that money arrived against it. There is no invoice DELETE endpoint, so this
    -- is a guard rather than a daily path.
    invoice_id INT NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
    -- Denormalised exactly like medication_return_credits.clinic_id (044): clinic
    -- scoping and per-clinic settlement reporting must not depend on walking
    -- invoice_items, which can be absent for a medication-only invoice.
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE RESTRICT,
    amount NUMERIC(10, 2) NOT NULL,
    -- Who handed over the cash. Never derived from method: a patient can pay by
    -- card and an insurer can pay in cash.
    payer_type VARCHAR(20) NOT NULL,
    -- How the cash was handed over. CASH and CARD only — see above.
    method payment_method NOT NULL,
    -- Copied from the invoice's currency. A payment in another currency needs an
    -- FX rate and a rate timestamp, and no rate source exists in this system, so
    -- the payment path must reject a currency mismatch rather than invent a rate.
    currency_code VARCHAR(3) NOT NULL REFERENCES currency_master(code) ON UPDATE CASCADE,
    received_by_user_id INT NOT NULL REFERENCES users(user_id),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at TIMESTAMPTZ NULL,
    voided_by_user_id INT NULL REFERENCES users(user_id),
    void_reason TEXT NULL,
    idempotency_key VARCHAR(64) NULL,
    note TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_payments_amount_positive CHECK (amount > 0),
    CONSTRAINT chk_payments_payer_type
        CHECK (payer_type IN ('PATIENT', 'INSURER')),
    CONSTRAINT chk_payments_method_cash_card
        CHECK (method IN ('CASH', 'CARD')),
    -- A void is one fact, not two halves that may disagree: a timestamp without an
    -- actor (or the reverse) would leave the live set ambiguous and make
    -- SUM(live payments) unreproducible.
    CONSTRAINT chk_payments_void_consistent
        CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL))
);

-- The aggregate reconciliation reads on every invoice: live payments only, so a
-- voided row leaves the sum without leaving the history.
CREATE INDEX IF NOT EXISTS idx_payments_invoice_live
    ON payments (invoice_id) WHERE voided_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_invoice_idempotency
    ON payments (invoice_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 2. settlement_cutover — the one immutable boundary marker
-- ============================================================
-- The single row that separates legacy invoices from payment-backed ones, and it
-- is written exactly once, by a later migration, when the payment write path is
-- deployed and verified. 10G.1 creates the table and leaves it EMPTY on purpose:
-- activating the boundary before payments can be recorded would make every
-- invoice issued from that moment unsettleable.
--
-- This is NOT a row in system_settings (023). That table is an ordinary editable
-- key/value store served by the settings endpoints: a cutover boundary anyone can
-- retype is not a boundary. Here nothing in the application writes, updates or
-- deletes this table — no route, no controller, no seed, no setting screen — and
-- the trigger below refuses UPDATE, DELETE and TRUNCATE at the database itself,
-- so the immutability holds even against a direct psql session or a bug in code
-- that has not been written yet.
--
-- singleton BOOLEAN PRIMARY KEY CHECK (singleton) is the standard single-row
-- idiom: CHECK (singleton) rejects FALSE, so the primary key admits at most one
-- row and no second marker can ever be inserted beside the first.
--
-- cutover_at is read by BOTH the write path and reconciliation SQL, so it has one
-- source of truth. A constant compiled into a controller and a constant typed
-- into a report would be two boundaries that can drift; here the database holds
-- the value and the code reads it.

CREATE TABLE IF NOT EXISTS settlement_cutover (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    cutover_at TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    set_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION settlement_cutover_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'settlement_cutover is immutable: % is not permitted. The cutover marker is written once and never moved; classify invoices by created_at against it instead.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- Row level: moving or removing the boundary itself.
DROP TRIGGER IF EXISTS trg_settlement_cutover_immutable ON settlement_cutover;
CREATE TRIGGER trg_settlement_cutover_immutable
    BEFORE UPDATE OR DELETE ON settlement_cutover
    FOR EACH ROW EXECUTE FUNCTION settlement_cutover_is_immutable();

-- Statement level: TRUNCATE has no rows to fire a row trigger on.
DROP TRIGGER IF EXISTS trg_settlement_cutover_no_truncate ON settlement_cutover;
CREATE TRIGGER trg_settlement_cutover_no_truncate
    BEFORE TRUNCATE ON settlement_cutover
    FOR EACH STATEMENT EXECUTE FUNCTION settlement_cutover_is_immutable();

-- ============================================================
-- 3. RECORD_PAYMENT — its own permission
-- ============================================================
-- Recording a payment is not issuing an invoice. 10G.0 ruled out reusing
-- CREATE_INVOICE for the same reason 046 ruled it out for the fulfilment
-- decision: the two acts answer different questions, and the person who answers
-- them is often not the same person. Issuing an invoice asserts what is owed;
-- recording a payment asserts that money actually arrived, and only the second
-- assertion moves the ledger. A role that can bill a patient must not thereby be
-- able to declare the bill settled.
--
-- Grant: ACCOUNTANT holds the finance-writing rights already (CREATE_INVOICE,
-- CREATE_EXPENSE, MANAGE_SERVICES), so it is the role that settles. RECEPTIONIST
-- is excluded — it has no CREATE_INVOICE, so it cannot even produce the document
-- it would be settling. DOCTOR, NURSE and PHARMACIST are clinical roles with no
-- financial rights at all.
--
-- FINANCIAL_AUDITOR is excluded deliberately and structurally: its role is
-- read-only inspection (VIEW_INVOICES, VIEW_FINANCIAL_REPORTS, VIEW_REPORTS). A
-- permission that can write money must never be reachable by the role whose whole
-- purpose is to check someone else's money without changing it.
--
-- SUPER_ADMIN and SYSTEM_ADMIN are listed for consistency with every other
-- permission migration in this project; requirePermission already bypasses them,
-- and seed.ts grants administrators every permission in the table regardless.

INSERT INTO permissions (permission_key, permission_group, description)
VALUES ('RECORD_PAYMENT', 'Finance', 'تسجيل دفعة محصّلة على فاتورة')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('ACCOUNTANT', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key = 'RECORD_PAYMENT'
ON CONFLICT DO NOTHING;

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - NO cutover row. settlement_cutover is created empty and stays empty until the
--   payment write path is live and verified. Boundary activation is a later phase.
-- - NO payment endpoint, route, controller or validation. Nothing writes a payment
--   yet, so this table has no writer in the application.
-- - NO change to invoices.paid_amount, and no change to any existing invoice.
--   billing.controller.ts and medicationCharges.controller.ts are untouched: service
--   invoices still record paid_amount = net_amount and medication invoices still
--   record 0.
-- - NO change to invoices.payment_type, and no removal of INSURANCE or SPLIT from
--   the payment_method enum. Migration 044 reads invoices.payment_type to decide
--   whether a return credit becomes a refund entitlement, and historical invoice
--   rows still carry those values; changing either would silently restate credit
--   derivation. Rejecting SPLIT on newly issued invoices belongs to the cutover
--   phase, once a payment can be recorded against the invoices being issued.
-- - NO refund table and no signed amount. A refund is a separate cash-out
--   transaction and cannot be expressed by this schema.
-- - NO allocation table, no general ledger, no accounts, no journal entries.
-- - NO FX: no rate column, no rate timestamp, no converted amount.
-- - NO multi-invoice payment: one payment, one invoice.
-- - NO mutation of any existing permission, role, table or column. This migration
--   is purely additive.