-- =============================================================
-- 019_user_session_presence.sql
-- حضور الجلسات (Presence): آخر نشاط لكل جلسة + وصف الجهاز.
-- Migration idempotent — لا يعدل أي migration قديمة ولا يفقد بيانات.
-- =============================================================

-- 1) آخر ظهور للجلسة: تُحدّثه نبضة القلب (Heartbeat) للجلسة الحالية فقط
--    وتُضبط لحظة الإنشاء عند كل تسجيل دخول جديد.
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- 2) ترويسة User-Agent كما وردت عند تسجيل الدخول (نص خام مقتطع —
--    بلا device fingerprinting وبلا مكتبات خارجية).
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- 3) تسوية الجلسات الموجودة: اعتبر لحظة الإنشاء آخر ظهور حتى أول نبضة،
--    حتى لا تتأثر الجلسات الحالية سلباً بعد الترحيل.
UPDATE user_sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;