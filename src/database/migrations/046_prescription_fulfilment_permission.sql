-- 046: Fulfilment decision permission (Phase 10F.2)
-- Idempotent migration
--
-- The recorded decision (clinic / external pharmacy / declined / cancelled) is a
-- distinct act from prescribing and from dispensing. Phase 10F.1 gated it behind
-- CREATE_PRESCRIPTION on the strength of the 032 precedent — repeat authorization
-- really is the same act as prescribing, so CREATE_PRESCRIPTION was right there.
-- Fulfilment is not: nobody may answer "will the patient take this?" by writing a
-- prescription, and the pharmacist who actually asks the question cannot prescribe.
--
-- So the gate becomes its own permission. It grants exactly one capability —
-- recording the decision — and nothing else: not prescribing, not dispensing, not
-- touching stock or money. The status ownership split from 10F.1 is unchanged;
-- DISPENSED_FROM_CLINIC and PARTIALLY_DISPENSED remain written by dispensing only.
--
-- ============================================================
-- 1. The permission
-- ============================================================
-- Group Pharmacy: the decision is recorded and read at the dispensing counter,
-- and the queue that surfaces it already lives there.
INSERT INTO permissions (permission_key, permission_group, description)
VALUES ('RECORD_PRESCRIPTION_FULFILMENT', 'Pharmacy', 'Record the patient fulfilment decision on prescription items (clinic, external pharmacy, declined, cancelled)')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

-- ============================================================
-- 2. Grants — doctor and pharmacist only, plus the admin roles
-- ============================================================
-- DOCTOR records the answer at prescribing time; PHARMACIST records the answer the
-- patient actually gave at the counter. Roles with no prescribing or pharmacy
-- rights are deliberately excluded: reception, nursing and the finance roles
-- neither prescribe nor dispense, so they gain nothing here.
--
-- SUPER_ADMIN / SYSTEM_ADMIN are listed for consistency with every other
-- permission migration in this project; requirePermission already bypasses them.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('PHARMACIST', 'DOCTOR', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key = 'RECORD_PRESCRIPTION_FULFILMENT'
ON CONFLICT DO NOTHING;

-- ============================================================
-- Deliberately NOT in this migration
-- ============================================================
-- - No grant of CREATE_PRESCRIPTION to the pharmacist. Recording an answer about
--   someone else's prescription must never become a licence to write one.
-- - No OR/AND permission logic: requirePermission takes a single key, and this
--   one key is granted to both roles that need it.
-- - No change to any existing permission, role or meaning.
-- - No change to the fulfilment endpoint's validation, status ownership or the
--   two-write contract from 10F.1.