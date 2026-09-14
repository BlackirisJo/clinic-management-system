-- =============================================================
-- 018_dynamic_permissions.sql
-- نظام صلاحيات ديناميكي: إدارة الأدوار والصلاحيات من داخل النظام
-- بدون تعديل الكود (مرحلة 3). Migration idempotent ولا يفقد بيانات.
-- =============================================================

-- 1) أعمدة إدارة الأدوار: وسم الأدوار النظامية + حالة التفعيل
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- 2) وسم الأدوار الأساسية — لا يجوز حذفها أو تعطيلها من الواجهة
UPDATE roles SET is_system = TRUE
WHERE role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN', 'DOCTOR', 'NURSE', 'ACCOUNTANT', 'RECEPTIONIST', 'FINANCIAL_AUDITOR');

-- 3) صلاحية إدارة الصلاحيات (تظهر فقط لمن يملكها)
INSERT INTO permissions (permission_key, permission_group, description)
VALUES ('MANAGE_PERMISSIONS', 'System', 'إدارة الأدوار والصلاحيات وربطها بالمستخدمين')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

-- 4) منح صلاحية إدارة الصلاحيات لأدوار الإدارة الأساسية (حماية من انغلاق النظام)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND p.permission_key = 'MANAGE_PERMISSIONS'
ON CONFLICT DO NOTHING;