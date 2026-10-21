import { z } from 'zod';

/* ==========================================================================
 * Phase 10E.6 — Inventory valuation query validation
 * Read-only report. The valuation itself is a pure read of
 * inventory_batches.quantity_on_hand × inventory_batches.unit_cost, so this
 * schema validates FILTERS only — there is nothing to write.
 * ========================================================================== */

export const DEFAULT_INVENTORY_VALUATION_LIMIT = 50;
export const MAX_INVENTORY_VALUATION_LIMIT = 500;

const optionalQueryInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min, message).max(max, message),
  ).optional();

/**
 * Filters justified by the existing inventory architecture:
 * - batch_id      : a batch is the unit of valuation
 * - inventory_id  : batches belong to exactly one inventory item
 * - medication_id : inventory_items are the clinic↔medication bridge (10E.1)
 *
 * There is deliberately NO cost, status, expiry or quarantine filter: those
 * would imply re-deriving the state semantics this report only READS, and the
 * report is required to show every physical batch regardless of its state.
 *
 * clinic_id is intentionally NOT a field. Clinic scope comes from the
 * authenticated session via buildClinicScope; any client-supplied clinic value
 * is dropped by the schema and can never widen the query.
 */
export const inventoryValuationQuerySchema = z.object({
  batch_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف الدفعة غير صالح'),
  inventory_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف صنف المخزون غير صالح'),
  medication_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف الدواء غير صالح'),
  limit: optionalQueryInt(1, MAX_INVENTORY_VALUATION_LIMIT, `الحد يجب أن يكون بين 1 و ${MAX_INVENTORY_VALUATION_LIMIT}`),
  offset: optionalQueryInt(0, Number.MAX_SAFE_INTEGER, 'البداية يجب أن تكون 0 أو أكثر'),
});

export type InventoryValuationQuery = z.infer<typeof inventoryValuationQuerySchema>;
