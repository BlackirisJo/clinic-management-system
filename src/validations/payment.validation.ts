import { z } from 'zod';

/* ==========================================================================
 * Phase 10G.2 — Payment recording validation
 *
 * جسم الطلب يحمل ما لا يعرفه إلا المستخدم: أي فاتورة، وكم دفعة، ومن دفع، وكيف.
 * وكل ما يحدد الهوية في السجل يُشتق على الخادم:
 *   - clinic_id            من بنود الفاتورة نفسها، لا من الطلب
 *   - received_by_user_id  من التوكن، لا من الجسم
 *   - received_at          وقت الخادم
 *   - paid_amount          مجموع الدفعات الحية، لا حقل يرسله أحد
 *
 * payer_type و method منفصلان عمداً. قيمتا INSURANCE و SPLIT موجودتان في
 * invoices.payment_type، وهما حقائق عن الدافع أو العقد لا عن طريقة تسليم
 * النقد، ولا تدخل هذه الشاشة. من يدفع نقداً ليس بالضرورة مريضاً، ومن يدفع
 * بالبطاقة ليس بالضرورة نقداً: الخلط بينهما هو ما يجعل رقم "المدفوع" بلا معنى.
 * ========================================================================== */

/** من سلّم النقد: المريض أو شركة التأمين. */
export const PAYMENT_PAYER_TYPES = ['PATIENT', 'INSURER'] as const;
export type PaymentPayerType = (typeof PAYMENT_PAYER_TYPES)[number];

/** طرق تسليم النقد المدعومة فعلياً. لا INSURANCE ولا SPLIT. */
export const PAYMENT_METHODS = ['CASH', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * حقول يُرفض وجودها في جسم الطلب. كل واحد منها محاولةً أن يقررها الخادم هويةً أو
 * مبلغاً محاسبياً، ومن يقرر صفَّه على السجل هو ما يجعل ذلك السجل ذا معنى.
 * تُرفض قبل أي وصول لقاعدة البيانات ولا تُتجاهل بصمت.
 */
export const FORBIDDEN_PAYMENT_FIELDS = [
  'clinic_id',
  'received_by_user_id',
  'received_at',
  'created_at',
  'payment_id',
  'paid_amount',
  'net_amount',
  'total_amount',
  'discount_amount',
  'voided_at',
  'voided_by_user_id',
  'void_reason',
  'status',
] as const;

const id = z.coerce.number().int().positive();

/** نقود بخانتين عشريتين بالضبط، مطابقة لـ NUMERIC(10,2) على payments.amount */
const paymentAmount = z.coerce
  .number()
  .finite('amount must be a number')
  .positive('amount must be greater than 0')
  .max(99_999_999.99, 'amount exceeds the supported range')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: 'amount supports at most 2 decimal places',
  });

export const paymentSchema = z.object({
  invoice_id: id,
  amount: paymentAmount,
  payer_type: z.enum(PAYMENT_PAYER_TYPES),
  method: z.enum(PAYMENT_METHODS),
  currency_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'currency_code must be a 3-letter code')
    .transform((value) => value.toUpperCase()),
  // مفتاح منع التكرار: الفهرس الفريد الجزئي على (invoice_id, idempotency_key)
  // هو الضمان الحقيقي، وهذا الحقل هو مرساه. اختياري: غيابه لا يمنع تسجيل دفعة.
  idempotency_key: z.string().trim().min(1).max(64).optional(),
  note: z.string().trim().max(1000).optional(),
});

export type PaymentInput = z.infer<typeof paymentSchema>;