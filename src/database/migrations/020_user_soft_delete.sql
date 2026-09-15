-- =============================================================
-- 020_user_soft_delete.sql
-- حذف آمن للمستخدمين (Soft Delete): نظام طبي — الزيارات والفواتير
-- والروشتات وسجلات التدقيق مرتبطة بمعرف المستخدم بقيود NOT NULL،
-- والحذف الفعلي (Hard Delete) سيدمر بيانات طبية/تاريخية.
-- لذلك الحذف فعلياً = تعطيل + وسم deleted_at + إنهاء جميع الجلسات.
-- + صلاحية حذف المستخدمين (DELETE_USERS) — لأعلى دور إداري فقط.
-- Migration idempotent — لا يعدل أي migration قديمة ولا يفقد بيانات.
-- =============================================================

-- 1) وسم الحذف الناعم: صف المستخدم لا يُحذف إطلاقاً حتى تبقى كل
--    السجلات المرتبطة به (والمفاتيح الأجنبية) سليمة.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2) صلاحية حذف المستخدمين — إدارة حساسة تظهر في فهرس الصلاحيات
INSERT INTO permissions (permission_key, permission_group, description)
VALUES ('DELETE_USERS', 'System', 'حذف/تعطيل حسابات المستخدمين مع إنهاء جميع جلساتهم')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;

-- 3) منح DELETE_USERS لأعلى دور إداري فقط (SUPER_ADMIN) — لا يُمنح لـ SYSTEM_ADMIN
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_name = 'SUPER_ADMIN'
  AND p.permission_key = 'DELETE_USERS'
ON CONFLICT DO NOTHING;