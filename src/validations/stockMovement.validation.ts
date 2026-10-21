import { z } from 'zod';

/* ==========================================================================
 * Phase 10B.3A — Stock movement validation
 * يقابل قيود migration 029: movement_type المُشغّل، quantity > 0 (NUMERIC 12,3)،
 * reference_type VARCHAR(50)، reference_id VARCHAR(100)، notes TEXT.
 * ========================================================================== */

// أنواع حركات المخزون كما هي في قيد chk_movement_type_valid
export const STOCK_MOVEMENT_TYPES = [
  'RECEIPT',
  'DISPENSE',
  'RETURN',
  'ADJUSTMENT',
  'ADJUSTMENT_DECREASE',
  'WASTE',
  'EXPIRE',
] as const;

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

// quantity دائماً موجبة، والاتجاه يحدده movement_type.
// ADJUSTMENT يظل زيادة فقطهناك: القيود أضيفت ADJUSTMENT_DECREASE منفصلاً
// (migration 033) بدل قلب معنى ADJUSTMENT أو إضافة عمود اتجاه/إشارة.
export const STOCK_INCREASING_TYPES: readonly StockMovementType[] = ['RECEIPT', 'RETURN', 'ADJUSTMENT'];
export const STOCK_DECREASING_TYPES: readonly StockMovementType[] = [
  'DISPENSE',
  'WASTE',
  'EXPIRE',
  'ADJUSTMENT_DECREASE',
];

export const isStockIncreasing = (movementType: StockMovementType): boolean =>
  STOCK_INCREASING_TYPES.includes(movementType);

// حدود inventory_batches.quantity_on_hand (NUMERIC 12,3)
const MAX_STOCK_QUANTITY = 999_999_999.999;
const SCALE = 1000;

const id = z.coerce.number().int().positive();

// لا يُقرَّب السعر الصامت: أكثر من 3 خانات عشرية لا تتسق مع NUMERIC(12,3)
const movementQuantity = z
  .coerce.number()
  .finite()
  .positive('الكمية يجب أن تكون أكبر من صفر')
  .max(MAX_STOCK_QUANTITY, 'الكمية تتجاوز الحد المسموح')
  .refine((value) => Math.abs(value * SCALE - Math.round(value * SCALE)) < 1e-6, {
    message: 'الكمية لا تقبل أكثر من 3 خانات عشرية',
  });

// '' يعني "غير مُرسل" — يُخزَّن NULL
const optionalText = (max: number, message: string) =>
  z.preprocess((value) => (value === '' || value === undefined ? null : value), z.string().trim().max(max, message).nullable()).optional();

export const stockMovementCreateSchema = z.object({
  batch_id: id,
  movement_type: z.enum(STOCK_MOVEMENT_TYPES),
  quantity: movementQuantity,
  reference_type: optionalText(50, 'نوع المرجع طويل جداً'),
  reference_id: optionalText(100, 'معرّف المرجع طويل جداً'),
  notes: optionalText(5000, 'الملاحظات طويلة جداً'),
  // performed_by_user_id مقصود عدم وجوده: يُؤخذ من المستخدم الموثَّق دائماً
  // idempotency_key: اختياري — مفتاح منع التكرار لعمليات RECEIPT.
  // الفهرس الفريد الجزئي على (batch_id, idempotency_key) WHERE movement_type='RECEIPT'
  // هو الضمان الحقيقي، وهذا الحقل هو مرساه. غيابه لا يمنع تسجيل حركة.
  idempotency_key: z.string().trim().min(1).max(64).optional(),
});

export type StockMovementCreateInput = z.infer<typeof stockMovementCreateSchema>;

/**
 * حقول يُرفض وجودها في جسم طلب تسجيل حركة مخزون. كل منها يُشتق على الخادم:
 *   - movement_id          مُولَّد من التسلسل
 *   - performed_by_user_id من المستخدم الموثَّق دائماً
 *   - created_at           طابع قاعدة البيانات
 *   - received_at / original_received_at لا وجود لهما في stock_movements
 *     أصلاً — استلام الدفعة يولّد received_at عبر الخادم (migration 029)
 * تُرفض قبل أي وصول لقاعدة البيانات ولا تُتجاهل بصمت.
 */
export const FORBIDDEN_STOCK_MOVEMENT_FIELDS = [
  'movement_id',
  'performed_by_user_id',
  'received_at',
  'original_received_at',
  'created_at',
  'updated_at',
] as const;

/* ==========================================================================
 * Phase 10B.3B — قراءة/تدقيق حركات المخزون (قراءة فقط)
 * حدود آمنة للترقيم، و clinic_id غير مقبول أصلاً من الاستعلام.
 * ========================================================================== */

export const DEFAULT_STOCK_MOVEMENT_LIMIT = 50;
export const MAX_STOCK_MOVEMENT_LIMIT = 200;

const optionalQueryInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min, message).max(max, message),
  ).optional();

const optionalQueryText = (max: number) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.string().trim().min(1).max(max),
  ).optional();

const optionalQueryDate = (message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.date().optional(),
  ).optional();

export const stockMovementListQuerySchema = z.object({
  batch_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف الدفعة غير صالح'),
  movement_type: z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.enum(STOCK_MOVEMENT_TYPES),
  ).optional(),
  reference_type: optionalQueryText(50),
  reference_id: optionalQueryText(100),
  performed_by_user_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف المستخدم غير صالح'),
  created_from: optionalQueryDate('تاريخ الحركة من غير صالح'),
  created_to: optionalQueryDate('تاريخ الحركة إلى غير صالح'),
  limit: optionalQueryInt(1, MAX_STOCK_MOVEMENT_LIMIT, `الحد يجب أن يكون بين 1 و ${MAX_STOCK_MOVEMENT_LIMIT}`),
  offset: optionalQueryInt(0, Number.MAX_SAFE_INTEGER, 'البداية يجب أن تكون 0 أو أكثر'),
  // clinic_id غير مُعرَّف هنا عمداً: أي قيمة ترسل من العميل تُهمَل ولا تُستخدم في الاستعلام
}).refine(
  (data) => {
    if (data.created_from && data.created_to) {
      return data.created_from <= data.created_to;
    }
    return true;
  },
  { message: 'تاريخ الحركة من يجب أن يكون قبل أو يساوي تاريخ الحركة إلى', path: ['created_from'] },
);

export type StockMovementListQuery = z.infer<typeof stockMovementListQuerySchema>;
