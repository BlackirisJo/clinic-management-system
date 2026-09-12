-- 016: إدارة الفواتير والخدمات والمصاريف
-- إضافي وآمن: لا يحذف أي بيانات قديمة، القيم الافتراضية تملأ الحقول الجديدة تلقائياً.

-- 1) دعم الكميات في بنود الفواتير (البنود القديمة تصبح quantity = 1 بدون تغيير القيم)
ALTER TABLE invoice_items ADD COLUMN quantity INT NOT NULL DEFAULT 1
  CHECK (quantity BETWEEN 1 AND 9999);

-- 2) حقول إدارة الخدمات (تاريخ الإنشاء/آخر تعديل)
ALTER TABLE clinic_services ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE clinic_services ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3) حقول إدارة المصاريف: آخر تعديل + حذف ناعم (soft delete) للحفاظ على التاريخ المالي
ALTER TABLE expenses ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE expenses ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_expenses_deleted_at ON expenses (deleted_at);

-- 4) فهرس دعم استعلامات البنود (تسريع قائمة/تفاصيل الفواتير)
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items (invoice_id);