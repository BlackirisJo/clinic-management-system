// سجل وحدات التخصصات الطبية (Specialty Registry)
// هذه هي آلية التوسع المركزية: لإضافة تخصص جديد يُضاف صف في جدول specialties
// وإذا احتاج workflow خاص تُضاف الإعدادات هنا — دون تغيير بنية النظام
export interface SpecialtyFieldConfig {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'date';
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
}

export interface SpecialtyModuleConfig {
  key: string;
  nameAr: string;
  nameEn: string;
  // أقسام نموذج الزيارة التي تظهر لهذا التخصص (إضافة للبيانات السريرية المشتركة)
  visitSections: ('triage' | 'examination' | 'vitals' | 'growth' | 'pregnancy' | 'ecg' | 'derm_photos' | 'mse')[];
  // حقول إضافية للعرض في نموذج الزيارة (تُخزن في حقول الزيارة العامة حسب key)
  extraFields?: SpecialtyFieldConfig[];
  // وصف سير العمل (Workflow) لأغراض العرض
  workflow: string[];
}

const COMMON_EXAM: SpecialtyModuleConfig['visitSections'] = ['vitals', 'examination'];

export const SPECIALTY_MODULES: Record<string, SpecialtyModuleConfig> = {
  EMERGENCY: {
    key: 'EMERGENCY', nameAr: 'الطوارئ', nameEn: 'Emergency Medicine',
    visitSections: ['triage', ...COMMON_EXAM],
    workflow: ['الفرز (Triage)', 'العلامات الحيوية', 'الشكوى الرئيسية', 'التقييم', 'التشخيص', 'الفحوصات', 'العلاج', 'الأدوية', 'تقرير المصير (Disposition)'],
  },
  GENERAL_MEDICINE: {
    key: 'GENERAL_MEDICINE', nameAr: 'الطب العام', nameEn: 'General Medicine',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'العلامات الحيوية', 'الفحص', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  FAMILY_MEDICINE: {
    key: 'FAMILY_MEDICINE', nameAr: 'طب الأسرة', nameEn: 'Family Medicine',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'العلامات الحيوية', 'الفحص', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  INTERNAL_MEDICINE: {
    key: 'INTERNAL_MEDICINE', nameAr: 'الباطنية', nameEn: 'Internal Medicine',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'العلامات الحيوية', 'الفحص', 'الفحوصات المخبرية', 'التشخيص', 'خطة العلاج', 'المتابعة'],
  },
  PEDIATRICS: {
    key: 'PEDIATRICS', nameAr: 'الأطفال', nameEn: 'Pediatrics',
    visitSections: ['growth', ...COMMON_EXAM],
    extraFields: [{ key: 'vaccination_notes', label: 'التطعيمات', type: 'textarea', hint: 'التطعيمات السابقة أو المطلوبة في هذه الزيارة' }],
    workflow: ['العمر', 'الوزن والطول', 'النمو', 'العلامات الحيوية', 'التطعيمات', 'الأعراض', 'الفحص', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  OBSTETRICS_GYNECOLOGY: {
    key: 'OBSTETRICS_GYNECOLOGY', nameAr: 'النسائية والتوليد', nameEn: 'Obstetrics & Gynecology',
    visitSections: [...COMMON_EXAM, 'pregnancy'],
    workflow: ['سجل الحمل', 'العمر الحملي', 'العلامات الحيوية والوزن', 'أعراض المريضة', 'الفحص السريري', 'نبض الجنين وبيانات النمو', 'المختبر والسونار', 'التشخيص', 'خطة العلاج', 'الموعد القادم'],
  },
  CARDIOLOGY: {
    key: 'CARDIOLOGY', nameAr: 'القلب', nameEn: 'Cardiology',
    visitSections: [...COMMON_EXAM, 'ecg'],
    workflow: ['الأعراض', 'عوامل الخطورة', 'العلامات الحيوية', 'ECG', 'الفحوصات', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  DERMATOLOGY: {
    key: 'DERMATOLOGY', nameAr: 'الجلدية', nameEn: 'Dermatology',
    visitSections: [...COMMON_EXAM, 'derm_photos'],
    workflow: ['الأعراض', 'مدة الحالة', 'الفحص الجلدي', 'وصف الحالة', 'الصور', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  ORTHOPEDICS: {
    key: 'ORTHOPEDICS', nameAr: 'العظام', nameEn: 'Orthopedics',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'العلامات الحيوية', 'الفحص الحركي', 'الأشعة', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  OPHTHALMOLOGY: {
    key: 'OPHTHALMOLOGY', nameAr: 'العيون', nameEn: 'Ophthalmology',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'حدة الإبصار', 'فحص العين', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  ENT: {
    key: 'ENT', nameAr: 'الأنف والأذن والحنجرة', nameEn: 'ENT',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'الفحص', 'المنظار', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  DENTAL: {
    key: 'DENTAL', nameAr: 'الأسنان', nameEn: 'Dental',
    visitSections: COMMON_EXAM,
    workflow: ['الشكوى', 'فحص الفم والأسنان', 'الأشعة', 'التشخيص', 'خطة الأسنان', 'المتابعة'],
  },
  UROLOGY: {
    key: 'UROLOGY', nameAr: 'المسالك البولية', nameEn: 'Urology',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'الفحص', 'تحليل البول والسونار', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  GENERAL_SURGERY: {
    key: 'GENERAL_SURGERY', nameAr: 'الجراحة العامة', nameEn: 'General Surgery',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض', 'الفحص السريري', 'الفحوصات', 'التشخيص', 'الخطة الجراحية', 'المتابعة'],
  },
  NEUROLOGY: {
    key: 'NEUROLOGY', nameAr: 'الأعصاب', nameEn: 'Neurology',
    visitSections: COMMON_EXAM,
    workflow: ['الأعراض العصبية', 'الفحص العصبي', 'التصوير', 'التشخيص', 'العلاج', 'المتابعة'],
  },
  PSYCHIATRY: {
    key: 'PSYCHIATRY', nameAr: 'الطب النفسي', nameEn: 'Psychiatry',
    visitSections: [...COMMON_EXAM, 'mse'],
    extraFields: [{ key: 'mental_status_exam', label: 'Mental Status Examination', type: 'textarea', hint: 'المظهر، الكلام، الفكر، الإدراك، الوعي' }],
    workflow: ['التقييم الأولي', 'التاريخ النفسي', 'الأعراض', 'MSE', 'التشخيص', 'خطة العلاج', 'المتابعة'],
  },
  PHYSICAL_THERAPY: {
    key: 'PHYSICAL_THERAPY', nameAr: 'العلاج الطبيعي', nameEn: 'Physical Therapy',
    visitSections: COMMON_EXAM,
    workflow: ['التقييم الحركي', 'مدى الحركة', 'القوة', 'خطة التأهيل', 'المتابعة'],
  },
  NUTRITION: {
    key: 'NUTRITION', nameAr: 'التغذية', nameEn: 'Nutrition & Dietetics',
    visitSections: ['growth', ...COMMON_EXAM],
    workflow: ['الوزن والطول وBMI', 'العادات الغذائية', 'الأهداف', 'خطة التغذية', 'المتابعة'],
  },
};

// تكوين افتراضي لأي تخصص جديد يُضاف مستقبلاً في قاعدة البيانات دون إدخال هنا
export const DEFAULT_MODULE: Omit<SpecialtyModuleConfig, 'key' | 'nameAr' | 'nameEn'> = {
  visitSections: COMMON_EXAM,
  workflow: ['الأعراض', 'العلامات الحيوية', 'الفحص', 'التشخيص', 'العلاج', 'المتابعة'],
};

export const getSpecialtyModule = (specialtyKey?: string | null): SpecialtyModuleConfig | null => {
  if (!specialtyKey) return null;
  return SPECIALTY_MODULES[specialtyKey] || null;
};