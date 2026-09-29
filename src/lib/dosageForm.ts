/**
 * Phase 9A — Medication Data Model
 * Coded/stable dosage form values. NOT free text.
 *
 * These codes are intentionally limited and stable.
 * Add a new code only after review — do not allow arbitrary strings.
 */
export const DOSAGE_FORM_CODES = [
  'TABLET',
  'CAPSULE',
  'INJECTION',
  'SUPPOSITORY',
  'SYRUP',
  'CREAM',
  'OINTMENT',
  'DROPS',
  'INHALER',
  'POWDER',
  'AMPULE',
  'VIAL',
] as const;

export type DosageFormCode = (typeof DOSAGE_FORM_CODES)[number];

export function isDosageForm(value: string): value is DosageFormCode {
  return (DOSAGE_FORM_CODES as readonly string[]).includes(value);
}

/** Human-readable label per code, for UI display. */
export const DOSAGE_FORM_LABELS: Record<DosageFormCode, { en: string; ar: string }> = {
  TABLET:     { en: 'Tablet',       ar: 'قرص' },
  CAPSULE:    { en: 'Capsule',      ar: 'كبسولة' },
  INJECTION:  { en: 'Injection',    ar: 'حقن' },
  SUPPOSITORY:{ en: 'Suppository',  ar: 'شرطة' },
  SYRUP:      { en: 'Syrup',        ar: 'شراب' },
  CREAM:      { en: 'Cream',        ar: 'كريم' },
  OINTMENT:   { en: 'Ointment',     ar: 'مرهم' },
  DROPS:      { en: 'Drops',        ar: 'قطرات' },
  INHALER:    { en: 'Inhaler',      ar: 'استنشاق' },
  POWDER:     { en: 'Powder',       ar: 'مسحوق' },
  AMPULE:     { en: 'Ampule',       ar: 'امبولة' },
  VIAL:       { en: 'Vial',         ar: 'فيال' },
};

export function dosageFormLabel(code: DosageFormCode, locale: 'en' | 'ar' = 'en'): string {
  return DOSAGE_FORM_LABELS[code][locale];
}