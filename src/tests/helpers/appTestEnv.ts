// يجب أن يُستورد هذا الملف **قبل** أي وحدة تستعمل config/database،
// لأن config/database تقرأ متغيرات البيئة عند تحميلها (dotenv لا يطمس
// متغيراً موجوداً مسبقاً). الهدف: توجيه مجرى التطبيق (pool) إلى
// clinic_db_test حصراً، حتى لا يلمس هذا الاختبار قاعدة الإنتاج.
process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost';
process.env.DB_PORT = process.env.TEST_DB_PORT || '5433';
process.env.DB_USER = process.env.TEST_DB_USER || 'clinic_admin';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'clinic_secure_pass_2026';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'clinic_db_test';
// إغلاق اتصالات الـpool سريعاً حتى لا تتأخر نهاية عملية الاختبار 30 ثانية
// بانتظار مهلة الخمول (idle timeout).
process.env.DB_POOL_IDLE_TIMEOUT_MILLIS = '1000';

export {};
