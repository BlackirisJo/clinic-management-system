import { z } from 'zod';
import { INVENTORY_UOM_CODES, isInventoryUom } from '../lib/inventoryUom';

// Phase 10B.2A — Inventory item validation
// يقابل قيود الأعمدة في migration 029: NUMERIC(12,3) غير سالب + UOM مُشغّل

// الحد الأعلى لكمية المخزون (NUMERIC(12,3))
export const MAX_STOCK_QUANTITY = 999_999_999.999;

const id = z.coerce.number().int().positive();

// '' و null لا تمر عبر z.coerce (لأن null يتحول إلى 0) — تُعاملان كـ "غير مُرسل"
const quantity = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.coerce.number().finite().nonnegative().max(MAX_STOCK_QUANTITY),
);

// max_stock: null يعني "بلا حد أقصى" — ولا يجوز تحويله إلى 0
const nullableQuantity = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.union([z.literal(null), quantity]),
);

const uomCode = z
  .string()
  .trim()
  .min(1, 'وحدة القياس مطلوبة')
  .transform((value) => value.toUpperCase())
  .refine((value) => isInventoryUom(value), {
    message: `وحدة القياس غير صحيحة. القيم المسموحة: ${INVENTORY_UOM_CODES.join(', ')}`,
  });

export const inventoryItemCreateSchema = z.object({
  clinic_id: id,
  medication_id: id,
  uom: uomCode,
  min_stock: quantity.default(0),
  reorder_point: quantity.default(0),
  max_stock: nullableQuantity.default(null),
});

export const inventoryItemUpdateSchema = z.object({
  clinic_id: id.optional(),
  medication_id: id.optional(),
  uom: uomCode.optional(),
  min_stock: quantity.optional(),
  reorder_point: quantity.optional(),
  max_stock: nullableQuantity.optional(),
});

export type InventoryItemCreateInput = z.infer<typeof inventoryItemCreateSchema>;
export type InventoryItemUpdateInput = z.infer<typeof inventoryItemUpdateSchema>;

// قاعدة مدتها الأعمدة: max_stock فارغ أو >= reorder_point
// (نفس قيد chk_inventory_max_ge_reorder في migration 029)
export const isMaxStockWithinReorderPoint = (maxStock: number | null, reorderPoint: number): boolean =>
  maxStock === null || maxStock >= reorderPoint;
