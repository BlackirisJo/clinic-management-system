/**
 * Phase 10B.2A — Inventory UOM (وحدة القياس) codes
 *
 * Controlled/stable values mirroring the `chk_inventory_uom_valid` CHECK
 * constraint created by migration 029 (`inventory_items.uom`).
 *
 * UOM is NOT the same concept as medication dosage_form
 * (see `src/lib/dosageForm.ts`) — the two code sets are deliberately separate
 * and must never be merged or cross-validated against each other.
 */
export const INVENTORY_UOM_CODES = [
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

export type InventoryUomCode = (typeof INVENTORY_UOM_CODES)[number];

export function isInventoryUom(value: string): value is InventoryUomCode {
  return (INVENTORY_UOM_CODES as readonly string[]).includes(value);
}
