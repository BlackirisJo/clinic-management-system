-- 053: Link follow-up appointments to originating visits
-- Add visit_id to appointments for traceability and idempotency (one follow-up per visit)

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS visit_id INT REFERENCES visits(visit_id) ON DELETE SET NULL;

-- Ensure at most one follow-up appointment per visit
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_visit_id ON appointments (visit_id) WHERE visit_id IS NOT NULL;

-- Index for querying appointments by visit
CREATE INDEX IF NOT EXISTS idx_appointments_visit_id ON appointments (visit_id);