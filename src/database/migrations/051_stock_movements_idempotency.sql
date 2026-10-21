-- 051: Stock movements idempotency key for RECEIPT operations (Phase 4B.2)
-- Idempotent migration
-- Adds optional idempotency_key to stock_movements with a partial unique index
-- scoped to RECEIPT movements, following the payments/refunds pattern (migrations 047/049).
-- The index is globally unique for RECEIPT movements (on idempotency_key alone),
-- ensuring a key cannot be reused for a different receipt operation.

-- ============================================================
-- 1. Add idempotency_key column
-- ============================================================
-- The key is optional: NULL keys do not participate in the unique index,
-- preserving backward compatibility for callers that do not supply a key.
-- Max length 64 matches payments.idempotency_key and refunds.idempotency_key.
ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

-- ============================================================
-- 2. Partial unique index for RECEIPT idempotency (globally unique)
-- ============================================================
-- Uniqueness is on idempotency_key alone for RECEIPT movements.
-- This ensures:
--   * A key cannot be reused for a different receipt operation (even different batch)
--   * Other movement types (DISPENSE, RETURN, ADJUSTMENT, etc.) are completely unaffected
--   * NULL keys never collide (backward compatible)
--   * The index only applies when movement_type = 'RECEIPT' AND idempotency_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_receipt_idempotency
    ON stock_movements (idempotency_key)
    WHERE movement_type = 'RECEIPT' AND idempotency_key IS NOT NULL;

-- ============================================================
-- 3. No backfill, no data changes, no other constraints
-- ============================================================
-- Existing rows have NULL idempotency_key and are not affected by the index.
-- Historical data remains compatible.