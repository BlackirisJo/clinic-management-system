import { z } from 'zod';

/* ==========================================================================
 * Phase 10G.4b — Refund write validation
 *
 * The body carries only what the caller is the only one to know: WHICH payment
 * its cash is coming back from, HOW MUCH, in WHICH currency, and against WHICH
 * entitlement. Everything that identifies the record is derived on the server
 * from the payment itself:
 *
 *   - invoice_id          from payment_id, never from the body. A refund that
 *                        spans two invoices is impossible by construction, not
 *                        by policy.
 *   - clinic_id           from the payment
 *   - payer_type          from the payment. Whoever paid is whoever gets the
 *                        money back, and this system cannot verify the identity
 *                        of the person taking the cash.
 *   - method              from the payment too. How the money goes back is not
 *                        the caller's choice: what returned is what came in.
 *   - refunded_by_user_id from the token
 *   - refunded_at         server clock
 *
 * currency_code is the one derived value the caller is still required to send.
 * That is deliberate: it makes the caller state which currency they believe they
 * are handing back, so a mismatch is an explicit refusal rather than a silent
 * substitution of the caller's intent with whatever the ledger happens to hold.
 *
 * RETURN_CREDIT is the only admissible reason, because it is the only
 * authorisation source that exists: there is no service-cancellation credit note
 * and no goodwill entitlement here, so a second reason would be an invented
 * requirement.
 *
 * credit_id is optional at the SCHEMA level while the requirement itself is
 * enforced in the DATABASE (`RETURN_CREDIT => credit_id IS NOT NULL` is a CHECK,
 * not a NOT NULL). That split is the point: admitting a second reason later must
 * not require dropping a NOT NULL and re-deriving existing rows.
 * ========================================================================== */

/** Fields refused in the body: each one is the server's decision, not the caller's. */
export const FORBIDDEN_REFUND_FIELDS = [
  // identity and scope
  'refund_id',
  'invoice_id',
  'clinic_id',
  'payer_type',
  'method',
  // actor and clock
  'refunded_by_user_id',
  'refunded_at',
  'created_at',
  // invoice arithmetic
  'paid_amount',
  'net_amount',
  'total_amount',
  'discount_amount',
  'status',
  // void: a separate, deliberate path, never reached from the recording screen
  'voided_at',
  'voided_by_user_id',
  'void_reason',
] as const;

/** The one reason that exists today: the 044 medication-return credit. */
export const REFUND_REASONS = ['RETURN_CREDIT'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

const id = z.coerce.number().int().positive();

/**
 * Money to exactly two decimals, matching NUMERIC(10,2) on refunds.amount.
 *
 * Positive is a doubled guarantee here, not a redundancy: a cash-out is never
 * zero (there is no such thing as a zero-cash movement to record) and never
 * negative, because a refund cannot be un-refunded by flipping a sign — it is
 * voided, exactly as a mis-keyed payment is. CHECK (amount > 0) in 049 is the
 * last word at the database level.
 */
const refundAmount = z.coerce
  .number()
  .finite('amount must be a number')
  .positive('amount must be greater than 0')
  .max(99_999_999.99, 'amount exceeds the supported range')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: 'amount supports at most 2 decimal places',
  });

/**
 * `.strict()` is load-bearing. Any unknown key — which includes every field in
 * FORBIDDEN_REFUND_FIELDS — is refused with a 400 at the validation middleware,
 * so none of them can reach a real request quietly. The controller's own check
 * does not replace it: the middleware guards the route, the controller guards any
 * direct call.
 */
export const refundSchema = z
  .object({
    /** The payment whose cash is coming back. The single anchor. */
    payment_id: id,
    amount: refundAmount,
    currency_code: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'currency_code must be a 3-letter code')
      .transform((value) => value.toUpperCase()),
    reason: z.enum(REFUND_REASONS),
    /** The 044 entitlement being discharged. Optional here; required for RETURN_CREDIT by 049. */
    credit_id: id.optional(),
    /** Double-submit anchor: the partial unique index on (payment_id, idempotency_key). */
    idempotency_key: z.string().trim().min(1).max(64).optional(),
    /** Stored in reason_note — refunds has no separate note column in 049. */
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export type RefundInput = z.infer<typeof refundSchema>;