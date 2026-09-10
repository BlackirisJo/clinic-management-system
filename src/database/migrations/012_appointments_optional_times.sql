-- السماح بقيم NULL لوقت البدء والنهاية في جدول المواعيد (اختيارية)
ALTER TABLE appointments
    ALTER COLUMN start_time DROP NOT NULL,
    ALTER COLUMN end_time DROP NOT NULL;

-- تحديث قيد ترتيب الأوقات للسماح بقيم NULL
ALTER TABLE appointments
    DROP CONSTRAINT IF EXISTS appointments_time_order;

ALTER TABLE appointments
    ADD CONSTRAINT appointments_time_order
    CHECK (
        (start_time IS NULL AND end_time IS NULL) OR
        (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    );

