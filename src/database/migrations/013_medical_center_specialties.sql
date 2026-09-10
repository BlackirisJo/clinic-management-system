-- 013: تحويل النظام إلى مركز طبي متعدد التخصصات
-- 1) جدول التخصصات الطبية
CREATE TABLE IF NOT EXISTS specialties (
    specialty_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    specialty_key VARCHAR(50) UNIQUE NOT NULL,
    name_ar VARCHAR(100) NOT NULL,
    name_en VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2) ربط العيادة بتخصص طبي حقيقي (nullable حتى لا يُكسر أي صف موجود)
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS specialty_id INT REFERENCES specialties(specialty_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clinics_specialty ON clinics (specialty_id);

-- 3) بذر التخصصات الرئيسية لمركز طبي شامل
INSERT INTO specialties (specialty_key, name_ar, name_en, description, sort_order) VALUES
    ('EMERGENCY',              'الطوارئ',                  'Emergency Medicine',        'فرز وحالات الطوارئ والإسعاف الأولي', 10),
    ('GENERAL_MEDICINE',       'الطب العام',                'General Medicine',          'الرعاية الطبية العامة', 20),
    ('FAMILY_MEDICINE',        'طب الأسرة',                 'Family Medicine',           'رعاية الأسرة والمتابعة الشاملة', 30),
    ('INTERNAL_MEDICINE',      'الباطنية',                  'Internal Medicine',         'أمراض الباطنة العامة', 40),
    ('PEDIATRICS',             'الأطفال',                   'Pediatrics',                'طب الأطفال والنمو والتطعيمات', 50),
    ('OBSTETRICS_GYNECOLOGY',  'النسائية والتوليد',         'Obstetrics & Gynecology',   'متابعة الحمل وصحة المرأة', 60),
    ('CARDIOLOGY',             'القلب',                     'Cardiology',                'أمراض القلب والأوعية الدموية', 70),
    ('DERMATOLOGY',            'الجلدية',                   'Dermatology',               'أمراض الجلد والحساسية', 80),
    ('ORTHOPEDICS',            'العظام',                    'Orthopedics',               'جراحة العظام والمفاصل', 90),
    ('OPHTHALMOLOGY',          'العيون',                    'Ophthalmology',             'طب وجراحة العيون', 100),
    ('ENT',                    'الأنف والأذن والحنجرة',     'ENT',                       'طب الأنف والأذن والحنجرة', 110),
    ('DENTAL',                 'الأسنان',                   'Dental',                    'طب وجراحة الأسنان', 120),
    ('UROLOGY',                'المسالك البولية',           'Urology',                   'جراحة المسالك البولية', 130),
    ('GENERAL_SURGERY',        'الجراحة العامة',            'General Surgery',           'العمليات الجراحية العامة', 140),
    ('NEUROLOGY',              'الأعصاب',                   'Neurology',                 'أمراض الجهاز العصبي', 150),
    ('PSYCHIATRY',             'الطب النفسي',               'Psychiatry',                'الصحة النفسية والعلاج النفسي', 160),
    ('PHYSICAL_THERAPY',       'العلاج الطبيعي',            'Physical Therapy',          'إعادة التأهيل والعلاج الطبيعي', 170),
    ('NUTRITION',              'التغذية',                   'Nutrition & Dietetics',     'التغذية العلاجية وأسلوب الحياة', 180)
ON CONFLICT (specialty_key) DO NOTHING;

-- 4) ربط العيادات الموجودة فعلياً بالتخصص المناسب حسب الاسم (آمن وقابل للتكرار)
UPDATE clinics SET specialty_id = (SELECT specialty_id FROM specialties WHERE specialty_key = 'OBSTETRICS_GYNECOLOGY')
WHERE specialty_id IS NULL AND clinic_name ILIKE '%نسائ%';
UPDATE clinics SET specialty_id = (SELECT specialty_id FROM specialties WHERE specialty_key = 'EMERGENCY')
WHERE specialty_id IS NULL AND clinic_name ILIKE '%طوارئ%';
UPDATE clinics SET specialty_id = (SELECT specialty_id FROM specialties WHERE specialty_key = 'DENTAL')
WHERE specialty_id IS NULL AND (clinic_name ILIKE '%اسنان%' OR clinic_name ILIKE '%أسنان%' OR clinic_name ILIKE '%فك%');
UPDATE clinics SET specialty_id = (SELECT specialty_id FROM specialties WHERE specialty_key = 'PEDIATRICS')
WHERE specialty_id IS NULL AND (clinic_name ILIKE '%أطفال%' OR clinic_name ILIKE '%اطفال%');
UPDATE clinics SET specialty_id = (SELECT specialty_id FROM specialties WHERE specialty_key = 'CARDIOLOGY')
WHERE specialty_id IS NULL AND (clinic_name ILIKE '%قلب%' OR clinic_name ILIKE '%قلبي%');
UPDATE clinics SET specialty_id = (SELECT specialty_id FROM specialties WHERE specialty_key = 'GENERAL_MEDICINE')
WHERE specialty_id IS NULL;

-- 5) إسناد الطاقم للعيادات (many-to-many): مستخدم واحد يمكن أن يعمل في عدة عيادات
--    يبقى users.clinic_id هو "العيادة الأساسية" للتوافق الكامل مع النظام الحالي
CREATE TABLE IF NOT EXISTS clinic_staff (
    clinic_staff_id INT GENERATED ALWAYS AS IDENTITY,
    clinic_id INT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    assigned_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (clinic_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_clinic_staff_user ON clinic_staff (user_id);

-- ترحيل الإسنادات الحالية (users.clinic_id) إلى جدول العلاقة
INSERT INTO clinic_staff (clinic_id, user_id)
SELECT clinic_id, user_id FROM users WHERE clinic_id IS NOT NULL
ON CONFLICT (clinic_id, user_id) DO NOTHING;

-- 6) صلاحيات البيانات السريرية والحمل (توسيع لنظام الصلاحيات الموجود وليس نظاماً جديداً)
INSERT INTO permissions (permission_key, permission_group, description) VALUES
    ('MANAGE_CLINICAL_DATA', 'Clinical', 'تسجيل وتعديل البيانات السريرية للزيارة (العلامات الحيوية، التشخيص، الفحوصات)'),
    ('MANAGE_PREGNANCY',     'Clinical', 'إنشاء ومتابعة سجلات الحمل في عيادة النسائية والتوليد')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r, permissions p
WHERE r.role_name = 'DOCTOR' AND p.permission_key IN ('MANAGE_CLINICAL_DATA', 'MANAGE_PREGNANCY')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r, permissions p
WHERE r.role_name = 'NURSE' AND p.permission_key IN ('MANAGE_CLINICAL_DATA')
ON CONFLICT DO NOTHING;