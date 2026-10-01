-- 030: Inventory Permissions (Phase 10B.2)
-- Idempotent migration: adds inventory permissions and grants to PHARMACIST, SUPER_ADMIN, SYSTEM_ADMIN

-- 1. Add inventory permissions
INSERT INTO permissions (permission_key, permission_group, description)
VALUES
  ('VIEW_INVENTORY', 'Inventory', 'View inventory items, batches, and suppliers'),
  ('MANAGE_INVENTORY', 'Inventory', 'Create, update, archive inventory items and manage batches'),
  ('MANAGE_SUPPLIERS', 'Inventory', 'Create, update, deactivate suppliers')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

-- 2. Grant inventory permissions to PHARMACIST role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name = 'PHARMACIST'
  AND p.permission_key IN ('VIEW_INVENTORY', 'MANAGE_INVENTORY', 'MANAGE_SUPPLIERS')
ON CONFLICT DO NOTHING;

-- 3. Grant inventory permissions to SUPER_ADMIN and SYSTEM_ADMIN (they get everything)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key IN ('VIEW_INVENTORY', 'MANAGE_INVENTORY', 'MANAGE_SUPPLIERS')
ON CONFLICT DO NOTHING;