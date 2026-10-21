import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest, financeClinicScope } from '../../middlewares/auth.middleware';
import { round2 } from './billing.calculation';
import { classifyByCreatedAt, readCutoverAt, SettlementCutoverMissingError } from './settlementCutover';
import { refundSchema, FORBIDDEN_REFUND_FIELDS } from '../../validations/refund.validation';

/* ==========================================================================
 * Phase 10G.4b — Cash out: recording a refund against a settled payment
 *
 * 10G.2 gave money IN a ledger and made invoices.paid_amount its derived mirror.
 * This is the other side, and the whole phase turns on one refusal: a refund
 * does NOT reduce invoices.paid_amount.
 *
 * That single decision is what lets both directions stay separately comparable.
 * If paid_amount absorbed the refund it would stop being "amount paid" and become
 * net cash, and then invoiceStatus(net, paid) would report a patient who paid in
 * full and was refunded in full as UNPAID — while reports' `outstanding = net -
 * paid` would grow by the refunded amount and invent a debt that does not exist.
 * Reconciliation's identity (paid_amount == SUM(live payments)) is what makes an
 * unauthorised refund detectable at all; a column that both sides write is a
 * column that cannot be trusted to detect anything.
 *
 * So: payments is money in, refunds is money out, and the invoice is untouched by
 * both. A refunded invoice still reads PAID — which is true — and the cash that
 * went back out lives in its own table with its own live-sum index.
 *
 * ============================================================
 * 1. The lock is the PAYMENT, not the invoice
 * ============================================================
 * The payment path locks the invoice row. Locking it here too would serialise
 * every refund on an invoice behind one row for no reason: the refund's bound is
 * a fact about the payment it returns, and two payments of the same invoice have
 * independent refundable balances. It would also couple two write paths that
 * otherwise never meet on a row, which is how deadlocks are built.
 *
 * So the order is: cutover -> payment FOR UPDATE -> credit FOR UPDATE (only when
 * a credit is named). The invoice is READ, unlocked — created_at for
 * classification and its line clinics for scoping, never locked, for the same
 * reason the payment path leaves invoice_items alone. A refund that names a
 * credit locks credit AFTER payment, always in that order, so two refunds
 * touching both rows cannot invert.
 *
 * ============================================================
 * 2. What the caller may say, and what it may not
 * ============================================================
 * The client names a payment, an amount, a currency and an entitlement. The
 * invoice, the clinic, the payer and the method are read from the payment and
 * copied. That is not validation politeness: it is what makes over-refund an
 * arithmetic fact. The cap is
 *
 *     payment.amount  -  SUM(live refunds on that payment)
 *
 * and a payment-anchored refund is by construction single-invoice, because the
 * invoice is reached THROUGH the payment.
 *
 * ============================================================
 * 3. Both caps, from live aggregates and nothing else
 * ============================================================
 * Two independent bounds must hold, and neither is read from a cached column:
 *
 *   - against the payment: the cash that actually arrived
 *   - against the credit:  the entitlement 044 authorised, minus what it has
 *                           already discharged
 *
 * invoices.paid_amount and medication_return_credits.refund_due_amount are
 * snapshots of a decision made at a moment in the past. A refund is judged
 * against live sums, so a stale snapshot can neither authorise nor block one.
 * refund_due_amount IS read — as the entitlement's original size — but never as
 * "what is left": the remainder is recomputed from live refund rows every time.
 *
 * ============================================================
 * 4. Deliberately NOT here
 * ============================================================
 * No refund void (the columns and the CHECK arrived in 049; the endpoint is a
 * separate decision). No payment void. No reports, no KPIs, no UI, no FX, no
 * goodwill, no service-cancellation refund, no multi-invoice refund, and no
 * change to invoices, payments, invoice_items, credits or reversals.
 *
 * DEFERRED, deliberately unresolved (see the phase report): a Return Credit
 * recorded BEFORE payment yields refund_due_amount = 0, after which recordPayment
 * still permits collecting the full net_amount. 044 computed that entitlement
 * against a paid_amount of zero, and nothing re-derives it once payment arrives.
 * The consequence is a patient who owes nothing and can still be charged, then
 * refunded. Fixing it means changing 044's semantics or adding a re-derivation
 * step, and both are larger than this phase. It is recorded, not silently fixed.
 * ========================================================================== */

/** A scoped refusal inside the transaction — always a rollback and a response. */
class RefundError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = { message, code, reason: code, ...extra };
  }
}

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

/** Same wording as the payment path: a caller outside the scope learns nothing. */
const paymentNotFound = (res: Response) =>
  res.status(404).json({ message: 'الدفعة المطلوبة غير موجودة', code: ApiErrorCode.VALIDATION_ERROR });

interface LockedPayment {
  paymentId: number;
  invoiceId: number;
  clinicId: number;
  amount: number;
  payerType: string;
  method: string;
  currencyCode: string;
  voidedAt: Date | null;
}

/**
 * The one lock that matters. Taking it is what turns "how much of this payment
 * has already gone back?" into an atomic read: a concurrent refund waits behind
 * this row and then sees the total this one just committed.
 */
const lockPayment = async (client: PoolClient, paymentId: number): Promise<LockedPayment | null> => {
  const result = await client.query(
    `SELECT payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code, voided_at
     FROM payments
     WHERE payment_id = $1
     FOR UPDATE`,
    [paymentId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    paymentId: Number(row.payment_id),
    invoiceId: Number(row.invoice_id),
    clinicId: Number(row.clinic_id),
    amount: round2(Number(row.amount)),
    payerType: String(row.payer_type),
    method: String(row.method),
    currencyCode: String(row.currency_code),
    voidedAt: row.voided_at === null || row.voided_at === undefined ? null : new Date(row.voided_at),
  };
};

/** Invoice facts for classification only. Read unlocked, like the payment path reads invoice_items. */
const readInvoiceForClassification = async (
  client: PoolClient,
  invoiceId: number,
): Promise<{ createdAt: Date } | null> => {
  const result = await client.query(`SELECT created_at FROM invoices WHERE invoice_id = $1`, [invoiceId]);
  if (result.rows.length === 0) return null;
  return { createdAt: new Date(result.rows[0].created_at) };
};

/**
 * The invoice's clinics, from its lines. Never from the request, never from the
 * payments table — a refund's clinic is the payment's clinic, and this read
 * exists only to refuse an invoice that has no single clinic to be refunded
 * against. Read unlocked, deliberately.
 */
const resolveInvoiceClinics = async (client: PoolClient, invoiceId: number): Promise<number[]> => {
  const result = await client.query(
    `SELECT DISTINCT clinic_id FROM invoice_items WHERE invoice_id = $1 ORDER BY clinic_id`,
    [invoiceId],
  );
  return result.rows.map((row) => Number(row.clinic_id));
};

/** Scope check. null = central finance, every clinic. */
const assertClinicInScope = (req: AuthenticatedRequest, clinicId: number): void => {
  const allowed = financeClinicScope(req);
  if (allowed === null) return;
  if (!allowed.includes(clinicId)) throw new RefundError(404, ApiErrorCode.VALIDATION_ERROR, 'الدفعة المطلوبة غير موجودة');
};

/** A previous refund under the same key. The partial unique index is the guarantee; this is the clean read. */
const findByIdempotencyKey = async (
  client: PoolClient,
  paymentId: number,
  key: string,
): Promise<Record<string, unknown> | null> => {
  const result = await client.query(
    `SELECT refund_id, payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code,
            credit_id, reason, reason_note, refunded_by_user_id, refunded_at, idempotency_key, created_at,
            voided_at, voided_by_user_id, void_reason
     FROM refunds
     WHERE payment_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [paymentId, key],
  );
  return result.rows.length === 0 ? null : result.rows[0];
};

/** Live refunds on one payment. Never read from a cached column: there is none. */
const liveRefundedOnPayment = async (client: PoolClient, paymentId: number): Promise<number> => {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS refunded
     FROM refunds
     WHERE payment_id = $1 AND voided_at IS NULL`,
    [paymentId],
  );
  return round2(Number(result.rows[0].refunded));
};

interface LockedCredit {
  creditId: number;
  invoiceId: number;
  currencyCode: string;
  refundDue: number;
}

/**
 * The 044 entitlement, locked. Locked because two refunds naming the same credit
 * would otherwise both read the same un-refunded remainder and jointly exceed it.
 * Always taken AFTER the payment, so both refund paths agree on the order.
 */
const lockCredit = async (client: PoolClient, creditId: number): Promise<LockedCredit | null> => {
  const result = await client.query(
    `SELECT credit_id, invoice_id, currency_code, refund_due_amount
     FROM medication_return_credits
     WHERE credit_id = $1
     FOR UPDATE`,
    [creditId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    creditId: Number(row.credit_id),
    invoiceId: Number(row.invoice_id),
    currencyCode: String(row.currency_code),
    refundDue: round2(Number(row.refund_due_amount)),
  };
};

/** Live refunds charged against one entitlement. The remainder is never read from a column. */
const liveRefundedOnCredit = async (client: PoolClient, creditId: number): Promise<number> => {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS refunded
     FROM refunds
     WHERE credit_id = $1 AND voided_at IS NULL`,
    [creditId],
  );
  return round2(Number(result.rows[0].refunded));
};

/** One audit row, inside the transaction, before COMMIT. */
const writeRefundAudit = async (
  client: PoolClient,
  userId: number,
  clinicId: number,
  refundId: number,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'REFUND_RECORDED', 'REFUND', $3, $4)`,
    [userId, clinicId, String(refundId), JSON.stringify(metadata)],
  );
};

/* ==========================================================================
 * The write path
 * ======================================================================== */
export const recordRefund = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Any server-decided field in the body is forgery, refused before the database.
  const forbiddenField = FORBIDDEN_REFUND_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب تسجيل استرداد — هذه القيم تُشتق على الخادم من الدفعة`);
  }

  const parsed = refundSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات تسجيل الاسترداد غير صالحة');

  const refundedByUserId = req.user?.userId ?? null;
  if (refundedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لتسجيل الاسترداد');
  }

  const { payment_id: paymentId, amount, currency_code: currencyCode, reason, credit_id: creditId } = parsed.data;
  const idempotencyKey = parsed.data.idempotency_key ?? null;
  const reasonNote = parsed.data.note ?? null;
  const refundAmount = round2(amount);

  // RETURN_CREDIT has exactly one authorisation source, and 049 makes the credit
  // mandatory for it: CHECK (reason <> 'RETURN_CREDIT' OR credit_id IS NOT NULL).
  //
  // Refused HERE, as a body-validation error, rather than left to that CHECK. The
  // constraint is the last word, not the first line of defence: without this the
  // insert reaches the database and comes back as a 23514 the caller sees as an
  // internal error, which tells them nothing about which field was missing. The
  // column stays nullable so admitting a second reason later needs no migration —
  // the requirement is per-reason, not structural.
  if (reason === 'RETURN_CREDIT' && creditId === undefined) {
    return validationError(res, 'استرداد ائتمان الإرجاع يتطلب credit_id — لا يوجد مصدر تفويض آخر');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 0) The boundary first, before any lock. A missing marker is not an answer:
    //    this database is not in a state this code may move money against.
    const cutoverAt = await readCutoverAt(client);

    // 1) Start from the payment and lock it. Everything else is reached from here.
    const payment = await lockPayment(client, paymentId);
    if (payment === null) {
      await client.query('ROLLBACK');
      return paymentNotFound(res);
    }

    // 2) A voided payment has no cash to return. Its void is the repair record;
    //    refunding against it would hand back money that was already retracted.
    if (payment.voidedAt !== null) {
      throw new RefundError(
        409,
        ApiErrorCode.PAYMENT_VOIDED,
        'الدفعة المطلوبة ملغاة، ولا يُردّ منها نقد',
        { payment_id: paymentId, voided_at: payment.voidedAt.toISOString() },
      );
    }

    // 3) Legacy invoice: pre-cutover paid_amount is a historical assertion, and
    //    refunding one would rewrite a number that has no receipt behind it.
    //    Classification is by created_at alone, exactly as the payment path.
    const invoice = await readInvoiceForClassification(client, payment.invoiceId);
    if (invoice === null) {
      await client.query('ROLLBACK');
      return paymentNotFound(res);
    }
    if (classifyByCreatedAt(invoice.createdAt, cutoverAt) === 'LEGACY') {
      throw new RefundError(
        409,
        ApiErrorCode.LEGACY_INVOICE_READ_ONLY,
        'هذه الفاتورة صدرت قبل تفعيل سجل التسوية، واستردادها مغلقة',
        {
          payment_id: paymentId,
          invoice_id: payment.invoiceId,
          created_at: invoice.createdAt.toISOString(),
          cutover_at: cutoverAt.toISOString(),
        },
      );
    }

    // 4) One clinic for the invoice, and it must be the payment's clinic.
    const invoiceClinics = await resolveInvoiceClinics(client, payment.invoiceId);
    if (invoiceClinics.length === 0) {
      throw new RefundError(
        409,
        ApiErrorCode.CROSS_CLINIC_INVOICE,
        'لا يمكن الاسترداد من فاتورة بلا بنود — لا عيادة تُنسب إليها',
        { invoice_id: payment.invoiceId, reason_detail: 'INVOICE_WITHOUT_LINES' },
      );
    }
    if (invoiceClinics.length > 1 || invoiceClinics[0] !== payment.clinicId) {
      // More than one clinic means no truthful clinic for a single refund; a
      // payment whose clinic disagrees with the invoice's lines means the two
      // authorities already disagree, and picking either would be a guess.
      throw new RefundError(
        409,
        ApiErrorCode.CROSS_CLINIC_INVOICE,
        'الفاتورة والدفعة لا تتفقان على عيادة واحدة للاسترداد',
        {
          invoice_id: payment.invoiceId,
          payment_id: paymentId,
          payment_clinic_id: payment.clinicId,
          invoice_clinic_ids: invoiceClinics,
        },
      );
    }
    assertClinicInScope(req, payment.clinicId);

    // 5) No rate source exists in this system, so a currency that does not match
    //    the payment's cash is refused rather than converted.
    if (currencyCode !== payment.currencyCode) {
      throw new RefundError(
        409,
        ApiErrorCode.CURRENCY_MISMATCH,
        'عملة الاسترداد لا تطابق عملة الدفعة',
        { payment_id: paymentId, payment_currency: payment.currencyCode, requested_currency: currencyCode },
      );
    }

    // 6) Replay before the caps, for the same reason the payment path does it
    //    before its overpayment check: the refund already stored would itself
    //    consume the remaining balance and make a successful retry look like an
    //    over-refund.
    if (idempotencyKey !== null) {
      const replay = await findByIdempotencyKey(client, paymentId, idempotencyKey);
      if (replay !== null) {
        await client.query('ROLLBACK');
        return res.status(200).json({ message: 'سبق تسجيل هذا الاسترداد بنفس مفتاح التكرار', idempotent_replay: true, refund: replay });
      }
    }

    // 7) The entitlement, when named. Locked after the payment, always.
    if (creditId !== undefined) {
      const credit = await lockCredit(client, creditId);
      if (credit === null) {
        throw new RefundError(
          404,
          ApiErrorCode.VALIDATION_ERROR,
          'ائتمان الإرجاع المطلوب غير موجود',
          { credit_id: creditId },
        );
      }
      // The credit must belong to the very invoice the payment settled. A credit
      // from another invoice would discharge an entitlement against unrelated
      // cash.
      if (credit.invoiceId !== payment.invoiceId) {
        throw new RefundError(
          409,
          ApiErrorCode.VALIDATION_ERROR,
          'ائتمان الإرجاع لا ينتمي إلى فاتورة هذه الدفعة',
          { credit_id: creditId, credit_invoice_id: credit.invoiceId, payment_invoice_id: payment.invoiceId },
        );
      }
      if (credit.currencyCode !== payment.currencyCode) {
        throw new RefundError(
          409,
          ApiErrorCode.CURRENCY_MISMATCH,
          'عملة ائتمان الإرجاع لا تطابق عملة الدفعة',
          { credit_id: creditId, credit_currency: credit.currencyCode, payment_currency: payment.currencyCode },
        );
      }
      // The entitlement is owed to the patient. Refund_due_amount in 044 is the
      // patient-facing portion and is 0 for INSURANCE and SPLIT invoices, so an
      // insurer's cash must never be returned against it.
      if (payment.payerType === 'INSURER') {
        throw new RefundError(
          409,
          ApiErrorCode.PAYER_MISMATCH,
          'استحقاق الإرجاع حقّ المريض، ولا يُفرَّغ من نقد شركة التأمين',
          { payment_id: paymentId, payer_type: payment.payerType, credit_id: creditId },
        );
      }

      // The remainder is recomputed from live rows every time. refund_due_amount
      // is read as the entitlement's ORIGINAL size, never as what is left of it.
      const alreadyRefunded = await liveRefundedOnCredit(client, creditId);
      const remainingEntitlement = round2(credit.refundDue - alreadyRefunded);
      if (refundAmount > remainingEntitlement) {
        throw new RefundError(
          409,
          ApiErrorCode.NO_REFUND_ENTITLEMENT,
          'مبلغ الاسترداد يتجاوز الاستحقاق المتبقي على ائتمان الإرجاع',
          {
            credit_id: creditId,
            refund_due_amount: credit.refundDue,
            already_refunded: alreadyRefunded,
            remaining_entitlement: remainingEntitlement,
            requested: refundAmount,
          },
        );
      }
    }

    // 8) The payment cap: the cash that actually arrived, less what already went
    //    back out. This is the bound that makes over-refund arithmetic.
    const alreadyRefundedOnPayment = await liveRefundedOnPayment(client, paymentId);
    const refundableRemaining = round2(payment.amount - alreadyRefundedOnPayment);
    if (refundAmount > refundableRemaining) {
      throw new RefundError(
        409,
        ApiErrorCode.REFUND_EXCEEDS_PAYMENT,
        'مبلغ الاسترداد يتجاوز نقد الدفعة المتبقي',
        {
          payment_id: paymentId,
          payment_amount: payment.amount,
          already_refunded: alreadyRefundedOnPayment,
          refundable_remaining: refundableRemaining,
          requested: refundAmount,
        },
      );
    }

    // 9) Insert under a savepoint: a unique-index collision with a concurrent
    //    request carrying the same key is caught here instead of taking the whole
    //    transaction down, and is then read as a replay rather than a 500.
    let refund: Record<string, unknown>;
    try {
      await client.query('SAVEPOINT insert_refund');
      const inserted = await client.query(
        `INSERT INTO refunds (payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code,
                              credit_id, reason, reason_note, refunded_by_user_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING refund_id, payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code,
                   credit_id, reason, reason_note, refunded_by_user_id, refunded_at, idempotency_key, created_at,
                   voided_at, voided_by_user_id, void_reason`,
        [
          payment.paymentId,
          payment.invoiceId,
          payment.clinicId,
          refundAmount,
          payment.payerType,
          payment.method,
          payment.currencyCode,
          creditId ?? null,
          reason,
          reasonNote,
          refundedByUserId,
          idempotencyKey,
        ],
      );
      await client.query('RELEASE SAVEPOINT insert_refund');
      refund = inserted.rows[0]!;
    } catch (insertError: any) {
      await client.query('ROLLBACK TO SAVEPOINT insert_refund');
      if (insertError?.code === '23505' && idempotencyKey !== null) {
        const replay = await findByIdempotencyKey(client, paymentId, idempotencyKey);
        await client.query('ROLLBACK');
        return res.status(200).json({ message: 'سبق تسجيل هذا الاسترداد بنفس مفتاح التكرار', idempotent_replay: true, refund: replay });
      }
      throw insertError;
    }

    await writeRefundAudit(client, refundedByUserId, payment.clinicId, Number(refund.refund_id), {
      payment_id: payment.paymentId,
      invoice_id: payment.invoiceId,
      credit_id: creditId ?? null,
      amount: refundAmount,
      payer_type: payment.payerType,
      method: payment.method,
      currency_code: payment.currencyCode,
      reason,
      idempotency_key: idempotencyKey,
      payment_amount: payment.amount,
      refunded_total: round2(alreadyRefundedOnPayment + refundAmount),
      refundable_remaining: round2(refundableRemaining - refundAmount),
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'تم تسجيل الاسترداد بنجاح',
      idempotent_replay: false,
      refund,
      payment: {
        payment_id: payment.paymentId,
        invoice_id: payment.invoiceId,
        clinic_id: payment.clinicId,
        amount: payment.amount,
        payer_type: payment.payerType,
        method: payment.method,
        currency_code: payment.currencyCode,
        refunded_total: round2(alreadyRefundedOnPayment + refundAmount),
        refundable_remaining: round2(refundableRemaining - refundAmount),
      },
      // Echoed, never re-derived and never written. A refund does not move
      // paid_amount, so the invoice still reads exactly as the payment left it —
      // including a status of PAID for a fully paid then fully refunded invoice.
      invoice: { invoice_id: payment.invoiceId, paid_amount_unchanged: true },
    });
  } catch (error: any) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof SettlementCutoverMissingError) {
      return res.status(503).json({ message: error.message, code: ApiErrorCode.SETTLEMENT_CUTOVER_MISSING });
    }
    if (error instanceof RefundError) {
      return res.status(error.status).json(error.payload);
    }
    console.error('Record Refund Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الاسترداد', code: ApiErrorCode.INTERNAL_ERROR });
  } finally {
    client?.release();
  }
};