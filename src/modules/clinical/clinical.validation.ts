import { z } from 'zod';

const id = z.coerce.number().int().positive();
const optionalId = z.coerce.number().int().positive().optional().nullable();
const num = (max: number) => z.coerce.number().finite().min(0).max(max).optional().nullable();
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional().nullable();
const shortText = (max = 200) => z.string().trim().max(max).optional().nullable();
const longText = (max = 5000) => z.string().trim().max(max).optional().nullable();

// ===== الزيارة: البيانات السريرية العامة =====
export const visitClinicalSchema = z.object({
  chief_complaint: longText().optional(),
  clinical_examination: longText().optional(),
  assessment: longText().optional(),
  treatment_plan: longText().optional(),
  follow_up_plan: longText().optional(),
  next_visit_date: z.string().datetime({ offset: true }).optional().nullable(),
  disposition: z.enum(['DISCHARGED', 'ADMITTED', 'REFERRED', 'OBSERVATION', 'LAMA', 'DECEASED']).optional().nullable(),
  triage_level: int(1, 5).optional().nullable(),
  visit_status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']).optional(),
});

// ===== العلامات الحيوية =====
export const vitalSignSchema = z.object({
  weight_kg: num(500),
  height_cm: num(300),
  systolic: int(40, 350),
  diastolic: int(20, 250),
  pulse: int(20, 300),
  temperature: num(45),
  respiratory_rate: int(0, 120),
  spo2: int(0, 100),
  pain_score: int(0, 10),
  notes: longText(1000),
}).refine((data) => {
  const hasAny = Object.entries(data).some(([key, value]) => key !== 'notes' && value !== undefined && value !== null);
  return hasAny;
}, { message: 'لا توجد قياسات لتسجيلها' });

// ===== التشخيص =====
export const diagnosisSchema = z.object({
  description: z.string().trim().min(2).max(2000),
  icd_code: shortText(20),
  diagnosis_type: z.enum(['PRIMARY', 'SECONDARY', 'DIFFERENTIAL']).default('PRIMARY'),
});

// ===== المختبر =====
export const labOrderSchema = z.object({
  test_name: z.string().trim().min(2).max(200),
  category: shortText(50),
  priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE'),
  notes: longText(2000),
});

export const labOrderUpdateSchema = z.object({
  status: z.enum(['ORDERED', 'COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  notes: longText(2000).optional(),
});

export const labResultSchema = z.object({
  results: z.array(z.object({
    analyte: z.string().trim().min(1).max(200),
    result_value: shortText(200),
    unit: shortText(50),
    reference_range: shortText(100),
    is_abnormal: z.boolean().default(false),
    notes: longText(1000),
  })).min(1).max(100),
});

// ===== التصوير =====
export const imagingSchema = z.object({
  modality: z.enum(['XRAY', 'ULTRASOUND', 'CT', 'MRI', 'ECG', 'OTHER']),
  body_part: shortText(100),
  findings: longText().optional(),
  impression: longText().optional(),
  status: z.enum(['ORDERED', 'COMPLETED', 'CANCELLED']).optional(),
});

// ===== الإحالات =====
export const referralSchema = z.object({
  reason: z.string().trim().min(2).max(2000),
  to_clinic_id: optionalId,
  to_specialty_id: optionalId,
  notes: longText(2000),
}).refine((data) => data.to_clinic_id || data.to_specialty_id, {
  message: 'يجب تحديد العيادة المستهدفة أو التخصص المستهدف',
});

// ===== الحمل =====
// قيمة فارغة '' تعامل كـ null (النماذج ترسلها للحقول غير المعبأة)
const emptyToNull = (schema: z.ZodType) => z.preprocess((v) => (v === '' ? null : v), schema);
export const pregnancySchema = z.object({
  lmp_date: emptyToNull(z.string().date().optional().nullable()),
  edd_date: emptyToNull(z.string().date().optional().nullable()),
  gravida: int(1, 30),
  para: int(0, 30),
  abortions: int(0, 30),
  living_children: int(0, 30),
  previous_pregnancies: longText(3000),
  blood_group: emptyToNull(z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional().nullable()),
  rh_factor: emptyToNull(z.enum(['POSITIVE', 'NEGATIVE']).optional().nullable()),
  risk_level: z.enum(['NORMAL', 'HIGH']).default('NORMAL'),
  risk_factors: longText(2000),
  notes: longText(3000),
});

// إنشاء حمل جديد يتطلب المريضة (والعيادة اختيارياً للمدراء)
export const pregnancyCreateSchema = pregnancySchema.extend({
  patient_id: id,
  clinic_id: optionalId,
});

export const pregnancyUpdateSchema = pregnancySchema.partial().extend({
  status: z.enum(['ACTIVE', 'COMPLETED']).optional(),
  outcome: z.enum(['ONGOING', 'LIVE_BIRTH', 'STILLBIRTH', 'MISCARRIAGE']).optional(),
  delivery_date: z.string().date().optional().nullable(),
  delivery_method: z.enum(['VAGINAL', 'VAGINAL_ASSISTED', 'CESAREAN']).optional().nullable(),
  delivery_notes: longText(3000).optional().nullable(),
});

export const pregnancyVisitSchema = z.object({
  visit_id: optionalId,
  visit_date: z.string().datetime({ offset: true }).optional(),
  ga_weeks: int(0, 45),
  ga_days: int(0, 6),
  weight_kg: num(500),
  systolic: int(40, 350),
  diastolic: int(20, 250),
  pulse: int(20, 300),
  temperature: num(45),
  fundal_height_cm: num(100),
  fetal_heart_rate: int(0, 300),
  fetal_presentation: shortText(30),
  symptoms: longText(3000),
  clinical_examination: longText(3000),
  diagnosis: longText(3000),
  treatment_plan: longText(3000),
  supplements: longText(2000),
  next_visit_date: z.string().date().optional().nullable(),
  risk_level: z.enum(['NORMAL', 'HIGH']).default('NORMAL'),
  notes: longText(2000),
}).refine((data) => data.ga_weeks !== undefined && data.ga_weeks !== null, {
  message: 'العمر الحملي (بالأسابيع) مطلوب',
});

export const pregnancyVisitUpdateSchema = z.object({
  visit_id: optionalId,
  ga_weeks: int(0, 45).optional(),
  ga_days: int(0, 6).optional(),
  weight_kg: num(500).optional(),
  systolic: int(40, 350).optional(),
  diastolic: int(20, 250).optional(),
  pulse: z.number().optional().nullable(),
  temperature: num(45).optional(),
  fundal_height_cm: z.number().optional().nullable(),
  fetal_heart_rate: z.number().optional().nullable(),
  fetal_presentation: shortText(30).nullable().optional(),
  symptoms: longText(3000).nullable().optional(),
  clinical_examination: longText(3000).nullable().optional(),
  diagnosis: longText(3000).nullable().optional(),
  treatment_plan: longText(3000).nullable().optional(),
  supplements: longText(2000).nullable().optional(),
  next_visit_date: z.string().date().nullable().optional(),
  risk_level: z.enum(['NORMAL', 'HIGH']).default('NORMAL'),
});

export const ultrasoundUpdateSchema = z.object({
  visit_id: optionalId.nullable().optional(),
  exam_date: z.string().datetime({ offset: true }).nullable().optional(),
    ga_weeks: int(0, 45).optional(),
    ga_days: int(0, 6).optional(),
    fetus_count: int(1, 10).default(1).optional(),
    fetal_presentation: shortText(30).nullable().optional(),
    bpd_cm: z.number().optional().nullable(),
    hc_cm: z.number().optional().nullable(),
    ac_cm: z.number().optional().nullable(),
    fl_cm: z.number().optional().nullable(),
    efw_g: z.number().optional().nullable(),
    amniotic_fluid_index: z.number().optional().nullable(),
    placenta_position: shortText(50).nullable().optional(),
    findings: longText(3000).nullable().optional(),
    impression: longText(3000).nullable().optional(),
    report_text: longText(10000).nullable().optional(),
});
export const ultrasoundSchema = z.object({
  visit_id: optionalId,
  exam_date: z.string().datetime({ offset: true }).optional(),
  ga_weeks: int(0, 45),
  ga_days: int(0, 6),
  fetus_count: int(1, 10).default(1),
  fetal_presentation: shortText(30),
  bpd_cm: num(30),
  hc_cm: num(80),
  ac_cm: num(80),
  fl_cm: num(30),
  efw_g: int(0, 8000),
  amniotic_fluid_index: num(40),
  placenta_position: shortText(50),
  findings: longText(3000),
  impression: longText(3000),
  report_text: longText(10000),
});

// ===== العيادة: التخصص والطاقم =====
export const clinicUpdateSchema = z.object({
  clinic_name: z.string().trim().min(2).max(150).optional(),
  specialty_id: optionalId,
  is_active: z.boolean().optional(),
  doctor_ids: z.array(id).max(200).optional(),
  nurse_ids: z.array(id).max(200).optional(),
});

export const clinicCreateSchema = clinicUpdateSchema.extend({
  clinic_name: z.string().trim().min(2).max(150),
  specialty_id: id,
});

// ===== سجل الحمل — طلبات المختبر =====
export const pregnancyLabOrderSchema = z.object({
  test_name: z.string().trim().min(2).max(200),
  category: shortText(50),
  priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE'),
  notes: longText(2000),
  pregnancy_visit_id: optionalId.nullable().optional(),
});
export const pregnancyLabOrderUpdateSchema = z.object({
  status: z.enum(['ORDERED', 'COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  notes: longText(2000).optional(),
});
export const pregnancyLabResultSchema = z.object({
  results: z.array(z.object({
    analyte: z.string().trim().min(1).max(200),
    result_value: shortText(200),
    unit: shortText(50),
    reference_range: shortText(100),
    is_abnormal: z.boolean().default(false),
    notes: longText(1000),
  })).min(1).max(100),
});

// ===== تقرير الطوارئ الطبي — تجميعي للعيادات =====
export const emergencyReportSchema = z.object({
  patient_id: z.coerce.number().int().positive(),
  clinic_ids: z.array(z.coerce.number().int().positive()).max(20).optional(),
});
