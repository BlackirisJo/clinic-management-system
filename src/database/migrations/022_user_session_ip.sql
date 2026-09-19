-- =============================================================
-- 022_user_session_ip.sql
-- حفظ عنوان IP الحقيقي للعميل عند تسجيل الدخول.
-- Migration idempotent — لا يعدل أي migration قديمة ولا يفقد بيانات.
-- =============================================================

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ip_address INET;
