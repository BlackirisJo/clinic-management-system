-- 017: منع تكرار الأدوية على مستوى قاعدة البيانات (الاسم التجاري بدون حساسية لحالة الأحرف)
-- آمن للبيانات الموجودة: لا يحذف أي صف؛ يُنشأ الفهرس الفريد فقط إذا لم تكن هناك تكرارات حالية،
-- وإلا يُسجَّل تنبيه ليتم تنظيفها يدوياً (القرار متروك للمشرف لأنه قد يرتبط ببنود روشتات).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM medications GROUP BY lower(trade_name) HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '017: توجد أدوية مكررة بالاسم التجاري — تم تخطي إنشاء الفهرس الفريد (يرجى تنظيف التكرارات أولاً)';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medications_trade_name_lower
      ON medications (lower(trade_name));
  END IF;
END
$$;