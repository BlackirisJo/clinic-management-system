-- 028: Add PHARMACIST role and pharmacy permissions (Phase 10A)
-- Idempotent migration

-- 1. Add new pharmacy permissions
INSERT INTO permissions (permission_key, permission_group, description)
VALUES 
  ('VIEW_PRESCRIPTIONS', 'Pharmacy', 'View prescriptions in pharmacy queue'),
  ('VIEW_PHARMACY_QUEUE', 'Pharmacy', 'Access pharmacy queue dashboard')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

-- 2. Add PHARMACIST role (system role, not user-creatable)
INSERT INTO roles (role_name, description, is_system, is_active)
VALUES ('PHARMACIST', 'Pharmacist - manages pharmacy queue and dispenses medications', TRUE, TRUE)
ON CONFLICT (role_name) DO UPDATE
SET description = EXCLUDED.description, is_system = EXCLUDED.is_system, is_active = EXCLUDED.is_active;

-- 3. Grant pharmacy permissions to PHARMACIST role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name = 'PHARMACIST'
  AND p.permission_key IN ('VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE')
ON CONFLICT DO NOTHING;

-- 4. Grant pharmacy permissions to SUPER_ADMIN and SYSTEM_ADMIN (they get everything)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key IN ('VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE')
ON CONFLICT DO NOTHING;