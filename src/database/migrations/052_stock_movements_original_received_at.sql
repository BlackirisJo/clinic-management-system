-- 052: Track original received_at for idempotency replay validation (Phase 4B.3)
-- Idempotent migration
-- Adds original_received_at to stock_movements to distinguish client-provided
-- timestamps from database defaults during idempotent replay checks.
-- This ensures explicit→omitted and omitted→explicit replays are correctly rejected.

-- ============================================================
-- 1. Add original_received_at column
-- ============================================================
-- NULL means the original request omitted received_at (DB default was used).
-- A timestamp means the original request explicitly provided that value.
-- Existing rows get NULL (unknown/legacy behavior).
ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS original_received_at TIMESTAMPTZ;

-- ============================================================
-- 2. No backfill, no data changes, no other constraints
-- ============================================================
-- Historical rows have NULL original_received_at and are not affected.
-- The application handles NULL as "original request used DB default".