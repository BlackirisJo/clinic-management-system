-- 048: Settlement cutover activation (Phase 10G.3)
-- Idempotent migration
--
-- 10G.1 created the marker table and left it empty on purpose. 10G.2 built the
-- payment write path on top of it. This migration writes the ONE row that turns
-- the boundary on, and it is the only row that will ever be written.
--
-- ============================================================
-- 1. What the marker means
-- ============================================================
--   created_at <  cutover_at  ->  LEGACY
--       The invoice's paid_amount is a historical settlement ASSERTION. It is
--       never re-derived, never incremented, and never given a synthetic payment
--       row. Settlement is closed to it.
--
--   created_at >= cutover_at  ->  PAYMENT-BACKED
--       The invoice is born unpaid (paid_amount = 0) and its paid_amount may only
--       move through payment rows, re-derived from the live sum of those rows.
--
-- Classification is by created_at and nothing else. It is deliberately NOT
-- "has payment rows": a payment-backed invoice that has not been paid yet looks
-- exactly like a legacy invoice in that test, and mistaking one for the other
-- either freezes an unsettleable invoice or silently re-derives a settled one.
--
-- ============================================================
-- 2. Why cutover_at is the migration's own timestamp
-- ============================================================
-- CURRENT_TIMESTAMP is the server clock at the start of this migration's
-- transaction: fixed, server-side, chosen here rather than supplied by a client,
-- and identical for every statement in the file. The trigger installed in 047
-- refuses UPDATE, DELETE and TRUNCATE on this row forever after.
--
-- Deploy order is not neutral, and this migration has one safe order:
--   1. deploy the code that reads the marker (invoice issuance and payment
--      recording both answer SETTLEMENT_CUTOVER_MISSING / 503 while the row is
--      absent — they refuse, they do not guess);
--   2. run this migration.
--
-- The reverse order is a real hazard, not a theoretical one. Between step 2 and
-- step 1 the PREVIOUS build is still serving, and that build issues service
-- invoices with paid_amount = net_amount. Those invoices would be written with
-- created_at >= cutover_at, so the new code would classify them PAYMENT_BACKED —
-- while carrying a settled paid_amount and no payment row to support it. Payment
-- recording would then refuse them with SETTLEMENT_OUT_OF_SYNC, and reconciliation
-- would count them as backed by rows that do not exist. Neither is repairable
-- without rewriting historical invoices, which is forbidden here.
--
-- That hazard is why invoice issuance reads the marker instead of hard-coding a
-- boundary: the moment this row exists, issuance cannot be born-paid any more,
-- so the marker and the issuance rule change together in one release. There is no
-- window in which the row is present and issuance is still legacy — the code and
-- the data cannot disagree about which side of the line an invoice falls on.
--
-- If the new code ever runs against a database where this row does not exist,
-- invoice issuance and payment recording both fail closed with
-- SETTLEMENT_CUTOVER_MISSING rather than guessing which side of the line an
-- invoice falls on.
--
-- ============================================================
-- 3. The row
-- ============================================================
-- ON CONFLICT DO NOTHING, so re-running this migration never moves the boundary:
-- a second run leaves the ORIGINAL cutover_at in place. That is the whole point
-- of a boundary — it may be set once, and a retry must not rewrite history that
-- later invoices were classified against.
--
-- Deliberately NOT here:
--   - No UPDATE of any invoice. Historical invoices keep their paid_amount as-is;
--     the legacy assertion is not evidence and is not invented into evidence.
--   - No payment rows at all, synthetic or otherwise.
--   - No change to reports, KPIs, refunds, allocation or 043/044.
INSERT INTO settlement_cutover (singleton, cutover_at, reason, set_by)
VALUES (
    TRUE,
    CURRENT_TIMESTAMP,
    'Settlement payment ledger activated',
    'migration 048 (phase 10G.3)'
)
ON CONFLICT (singleton) DO NOTHING;