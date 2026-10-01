/**
 * Phase 10C.1 — Frontend inventory UOM codes.
 * Independent from backend src/lib/inventoryUom.ts (same 11 codes, no conversion).
 * Stable, limited set. NOT free text.
 */
export const UOM_CODES = [
  'TABLET',
  'CAPSULE',
  'ML',
  'AMPULE',
  'VIAL',
  'BOTTLE',
  'TUBE',
  'GRAM',
  'PUFF',
  'DROP',
  'SUPPOSITORY',
] as const;

export type UomCode = (typeof UOM_CODES)[number];

export function isUom(value: string): value is UomCode {
  return (UOM_CODES as readonly string[]).includes(value);
}

/** Fallback shown when a legacy prescription item has no UOM. */
export const UOM_FALLBACK = '—';

export function uomLabel(code: string | null | undefined, t: (key: string) => string): string {
  if (!code) return UOM_FALLBACK;
  const key = `uom.${code}`;
  const label = t(key);
  return label && label !== key ? label : code;
}
