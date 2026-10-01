import { z } from 'zod';

/* ==========================================================================
 * Phase 10B.2C — Inventory batch validation
 * يقابل قيود migration 029: NUMERIC(12,3) للكمية، NUMERIC(10,4) للتكلفة،
 * UNIQUE(inventory_id, lot_number)، و CHECK الكميات غير السالبة والمحجوزة.
 * ========================================================================== */

// الحد الأعلى للكمية (NUMERIC(12,3)) والتكلفة (NUMERIC(10,4))
export const MAX_BATCH_QUANTITY = 999_999_999.999;
export const MAX_UNIT_COST = 999_999.9999;

const id = z.coerce.number().int().positive();

const quantity = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.coerce.number().finite().nonnegative().max(MAX_BATCH_QUANTITY),
);

const nullableUnitCost = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.union([z.literal(null), z.coerce.number().finite().nonnegative().max(MAX_UNIT_COST)]),
);

const nullableSupplierId = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.union([z.literal(null), id]),
);

const lotNumber = z.string().trim().min(1, 'رقم التشغيلة مطلوب').max(100, 'رقم التشغيلة طويل جداً');

// يُخزَّن كنص ISO (YYYY-MM-DD) تفادياً لانزياح المنطقة الزمنية على عمود DATE
const expiryDate = z.coerce.date().transform((value) => value.toISOString().slice(0, 10));

const receivedAt = z.coerce.date();

// تحويل صريح بلا z.coerce.boolean (الذي يحوّل أي نص غير فارغ — بما فيه "false" — إلى true)
const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

// الاستلام: الكمية الابتدائية مسموحة هنا فقط — بعد ذلك عبر حركات المخزون (Phase 10B.3)
export const batchCreateSchema = z.object({
  inventory_id: id,
  supplier_id: nullableSupplierId.default(null),
  lot_number: lotNumber,
  expiry_date: expiryDate,
  quantity_on_hand: quantity.default(0),
  quantity_reserved: quantity.default(0),
  unit_cost: nullableUnitCost.default(null),
  received_at: receivedAt.optional(),
});

// تحديث البيانات الوصفية فقط.
// quantity_on_hand / quantity_reserved غير موجودين هنا البتة — لا يمكن تعديلهما عبر هذا المسار.
export const batchUpdateSchema = z.object({
  // inventory_id مُرسل للتحقق من النطاق فقط — لا يُغيَّر (انظر الكنترولر)
  inventory_id: id.optional(),
  supplier_id: nullableSupplierId.optional(),
  lot_number: lotNumber.optional(),
  expiry_date: expiryDate.optional(),
  unit_cost: nullableUnitCost.optional(),
  received_at: receivedAt.optional(),
  is_active: booleanFlag.optional(),
});

export type BatchCreateInput = z.infer<typeof batchCreateSchema>;
export type BatchUpdateInput = z.infer<typeof batchUpdateSchema>;

// نفس قيد chk_batch_qty_reserved_le_on_hand في migration 029
export const isReservedWithinOnHand = (reserved: number, onHand: number): boolean => reserved <= onHand;

/* ==========================================================================
 * Phase 10B.4B-1 — قراءة الدفعات حسب حالة الانتهاء (قراءة فقط)
 * ========================================================================== */

export const EXPIRY_STATUSES = ['expired', 'expiring'] as const;
export type ExpiryStatus = (typeof EXPIRY_STATUSES)[number];

export const MAX_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_LIMIT = 50;
export const MAX_EXPIRY_LIMIT = 200;

const expiryQueryInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min, message).max(max, message),
  ).optional();

// status مطلوب، و days مطلوب فقط مع expiring. clinic_id غير مُعرَّف عمداً.
export const expiryListQuerySchema = z
  .object({
    status: z.enum(EXPIRY_STATUSES),
    days: expiryQueryInt(0, MAX_EXPIRY_DAYS, `عدد الأيام يجب أن يكون بين 0 و ${MAX_EXPIRY_DAYS}`),
    limit: expiryQueryInt(1, MAX_EXPIRY_LIMIT, `الحد يجب أن يكون بين 1 و ${MAX_EXPIRY_LIMIT}`),
    offset: expiryQueryInt(0, Number.MAX_SAFE_INTEGER, 'البداية يجب أن تكون 0 أو أكثر'),
  })
  .refine((value) => value.status !== 'expiring' || value.days !== undefined, {
    message: 'days مطلوب عند status=expiring',
    path: ['days'],
  });

export type ExpiryListQuery = z.infer<typeof expiryListQuerySchema>;
