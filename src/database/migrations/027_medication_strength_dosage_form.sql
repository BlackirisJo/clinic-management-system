-- 027: إضافة حقول strength و dosage_form للدواء (Phase 9A — Medication Data Model)
-- آمن للبيانات-existing: الحقول تُضاف كـ NULL، لا تُحذف أو تُعدّل أي حقل موجود.
-- dosage_form هو قيمة مُشغّلة (coded) من مجموعة محدودة متفق عليها.

ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS strength VARCHAR(100),
  ADD COLUMN IF NOT EXISTS dosage_form VARCHAR(50);

-- تعليق توضيحي على الحقل الجديد (اختياري، ل-support الم ╳ explorers)
COMMENT ON COLUMN medications.strength IS 'قوة الدواء مثل 500 mg أو 120 mg/5ml';
COMMENT ON COLUMN medications.dosage_form IS 'شكل الدواء المُشغّل: TABLET | CAPSULE | INJECTION | SUPPOSITORY | SYRUP | CREAM | OINTMENT | DROPS | INHALER | POWDER | AMPULE | VIAL';