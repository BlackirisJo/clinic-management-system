import { z } from 'zod';

const id = z.coerce.number().int().positive();
const money = z.coerce.number().finite().nonnegative();

export const patientSchema = z.object({
  full_name: z.string().trim().min(3).max(150), national_id: z.string().max(50).optional(),
  document_type: z.enum(['NATIONAL_ID', 'PASSPORT', 'OTHER']),
  document_number: z.string().trim().min(1).max(100),
  phone: z.string().min(7).max(20), gender: z.enum(['MALE', 'FEMALE']), date_of_birth: z.string().date(),
});
export const visitSchema = z.object({ patient_id: id, clinic_id: id, doctor_id: id, notes: z.string().max(5000).optional() });
export const prescriptionSchema = z.object({
  visit_id: id, patient_id: id, notes: z.string().max(5000).optional(),
  items: z.array(z.object({ medication_id: id, dosage: z.string().min(1).max(100), frequency: z.string().min(1).max(100), duration: z.string().min(1).max(50), timing_instructions: z.string().max(150).optional(), repeats_count: z.coerce.number().int().positive().default(1) })).min(1).max(100),
});
export const serviceSchema = z.object({ clinic_id: id, service_name: z.string().trim().min(2).max(150), price: money, doctor_percentage: z.coerce.number().finite().min(0).max(100).default(0) });
export const invoiceSchema = z.object({
  patient_id: id, visit_id: id.optional(), discount_amount: money.optional(), payment_type: z.enum(['CASH', 'CARD', 'INSURANCE', 'SPLIT']).default('CASH'),
  items: z.array(z.object({ clinic_id: id, doctor_id: id.optional(), service_id: id.optional(), price: money })).min(1).max(100),
});
export const expenseSchema = z.object({ clinic_id: id, category: z.string().trim().min(2).max(100), amount: money, description: z.string().max(5000).optional() });
const ALLERGEN_KEYS = ['PENICILLIN', 'ASPIRIN', 'SULFA', 'LATEX', 'FOOD', 'POLLEN', 'INSECT_STING', 'OTHER'] as const;
const CONDITION_KEYS = ['DIABETES', 'HYPERTENSION', 'ASTHMA', 'HEART_DISEASE', 'KIDNEY_DISEASE', 'THYROID', 'ANEMIA', 'OTHER'] as const;
const SEVERITY_LEVELS = ['MILD', 'MODERATE', 'SEVERE', 'GESTATIONAL', 'TRANSIENT', 'UNSPECIFIED'] as const;

export const medicalProfileSchema = z.object({
  blood_type: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
  current_medications: z.string().trim().max(5000).optional(),
  medical_notes: z.string().trim().max(5000).optional(),
  allergies: z.array(z.object({
    allergen_key: z.enum(ALLERGEN_KEYS),
    notes: z.string().trim().max(500).optional(),
  })).max(20).optional(),
  chronic_conditions: z.array(z.object({
    condition_key: z.enum(CONDITION_KEYS),
    severity: z.enum(SEVERITY_LEVELS).default('UNSPECIFIED'),
    notes: z.string().trim().max(500).optional(),
  })).max(20).optional(),
});