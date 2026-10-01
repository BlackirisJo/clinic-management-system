-- 038: Stock Count Finalisation (Phase 10D.7)
-- One additive column and one index. Nothing else.
--
-- 10D.6 could open a count and record counted lines, but never closed one. This
-- migration adds the single piece of traceability that closing needs: WHO ended
-- the count. approved_by_user_id is deliberately NOT repurposed — it belongs to
-- an approval workflow that does not exist, and overwriting its meaning would
-- make an approval claim out of a finalisation that only ever measured stock.
--
-- Deliberately NOT in this migration:
-- - No status vocabulary change: 'OPEN' | 'FINALISED' | 'CANCELLED' is unchanged,
--   and chk_sc_finalised_consistent (finalised_at present iff FINALISED) still
--   holds exactly as written in 037.
-- - No column is removed, renamed, retyped or re-checked.
-- - No permission, no movement type, no new table.
-- - No CHECK requiring finalised_by_user_id on FINALISED rows: the writer is the
--   only way a row becomes FINALISED, so a constraint here would add no
--   guarantee the application does not already give, while risking a failure at
--   finalisation time.

ALTER TABLE stock_counts
    ADD COLUMN IF NOT EXISTS finalised_by_user_id INT REFERENCES users(user_id) ON DELETE RESTRICT;

-- "who finalised what" is the same audit lookup shape as counted_by/approved_by
CREATE INDEX IF NOT EXISTS idx_sc_finalised_by
    ON stock_counts (finalised_by_user_id);
