/**
 * Phase 9C — Frontend dosage-form codes.
 * Independent from backend src/lib/dosageForm.ts.
 * Stable, limited set. NOT free text.
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

/** Fallback placeholder used when a legacy medication has no dosage form. */
export const DOSAGE_FORM_FALLBACK = '—';

export function dosageFormLabel(code: string | null | undefined, t: (key: string) => string): string {
  if (!code) return DOSAGE_FORM_FALLBACK;
  const key = `dosageForm.${code}` as const;
  const label = t(key);
  return label && label !== key ? label : code;
}