import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest, financeClinicScope } from '../../middlewares/auth.middleware';
import { invoiceStatus, round2 } from './billing.calculation';
import { classifyByCreatedAt, readCutoverAt, SettlementCutoverMissingError } from './settlementCutover';
import { paymentSchema, FORBIDDEN_PAYMENT_FIELDS } from '../../validations/payment.validation';

/* ==========================================================================
 * Phase 10G.2 — تسجيل دفعة على فاتورة
 *
* القاعدة: الدفعات سجل، والذاكرة المخزَّنة مُشتقّة. المدفوع على الفاتورة ليس
 * عدّاداً يُزاد عليه، بل صورة لمجموع الدفعات الحية. مجموع الدفعات هو مصدر
 * الحقيقة، والفاتورة مجرد نسخة منه: لو زاد رقمان أو نُسي أحدهما فال مصدر
 * واحد، وهو ما يجعل التسوية قابلة للتحقق بدل أن تكون صنفاً من الأرقام.
 *
 * قفل واحد فقط: صف الفاتورة FOR UPDATE. بنود الفاتورة (invoice_items) تُقرأ
 * ولا تُقفل أبداً، لأن مسار إرجاع الدواء يقفلها بترتيب مختلف، وإضافتها إلى
 * ترتيب القفل هنا تصنع حلقة جمود. صف الفاتورة وحده يكفي: كل دفعتين على
 * الفاتورة نفسها تتسلسلان خلفه، فلا يسبق أحدهما الآخر في قراءة المجموع.
 *
 * داخل المعاملة الواحدة:
 *   BEGIN -> قفل الفاتورة -> اشتقاق عيادة الفاتورة وفحص النطاق -> مطابقة العملة
 *   -> إعادة مفاتيح تكرار سابقة -> مجموع المدفوع الحي -> اتساق الذاكرة المخزَّنة
 *   -> رفض التجاوز -> إدراج الدفعة -> إعادة اشتقاق paid_amount من الدفعات
 *   -> تدقيق -> COMMIT
 *
 * لا استرداد هنا: لا جدول استرداد ولا مبلغ سالب، فالدفعة النقدية يجب أن تكون
 * موجبة دائماً، وأي صادر نقدي سيكون جدولاً منفصلاً في مرحلة لاحقة.
 *
 * Phase 10G.3: عتبة التسوية. الفاتورة التي صدرت قبل العتبة لها مدفوعها
 * تأكيد تاريخي، فتسجيل دفعة عليها يعني إعادة كتابة رقم لا سند له، فيُرفض
 * برمز ثابت LEGACY_INVOICE_READ_ONLY. التصنيف ب.created_at مقابل العتبة
 * المقروءة من قاعدة البيانات — لا بوجود دفعات ولا بغيرها.
 * ========================================================================== */

/** خطأ نطاقي/منطقي داخل المعاملة — يؤدي دائماً إلى ROLLBACK ثم استجابة. */
class PaymentError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = { message, code, ...extra };
  }
}

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

/** موحّد: فاتورة غير موجودة أو خارج نطاق عيادات المستخدم (لا يُكشف وجودها) */
const invoiceNotFound = (res: Response) =>
  res.status(404).json({ message: 'الفاتورة المطلوبة غير موجودة', code: ApiErrorCode.VALIDATION_ERROR });

interface LockedInvoice {
  invoiceId: number;
  patientId: number;
  netAmount: number;
  paidAmount: number;
  currencyCode: string;
  createdAt: Date;
}

/**
 * قفل الفاتورة. القفل يجعل "كم دُفع على هذه الفاتورة؟" ذرّياً: أي دفعة
 * متزامنة تنتظر خلف هذا الصف ثم ترى المجموع الذي تعيده هذه الدفعة نفسها.
 */
const lockInvoice = async (client: PoolClient, invoiceId: number): Promise<LockedInvoice | null> => {
  const result = await client.query(
    `SELECT invoice_id, patient_id, net_amount, paid_amount, currency_code, created_at
     FROM invoices
     WHERE invoice_id = $1
     FOR UPDATE`,
    [invoiceId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    invoiceId: Number(row.invoice_id),
    patientId: Number(row.patient_id),
    netAmount: round2(Number(row.net_amount)),
    paidAmount: round2(Number(row.paid_amount)),
    currencyCode: String(row.currency_code),
    createdAt: new Date(row.created_at),
  };
};

/**
 * عيادة الفاتورة من بنودها — لا من الطلب، ولا من جدول الفواتير ( فهو لا يملك
 * عمود عيادة أصلاً: الفاتورة قد تجمع بنوداً من أكثر من عيادة).
 *
 * تُقرأ البنود بلا قفل عمداً: مسار إرجاع الدواء يقفل invoice_items بترتيب
 * مختلف، ولا يجوز أن يقفل هذا المسار ما يقفله ذلك.
 *
 * أكثر من عيادة = لا يوجد أساس صادق لنسبة دفعة واحدة إلى عيادة واحدة، و
 * payments.clinic_id عمود واحد لا يحتمل نسبة واحدة. تُرفض الفاتورة صراحةً
 * بدل أن يُختلق لها عيادة واحدة.
 */
const resolveInvoiceClinic = async (client: PoolClient, invoiceId: number): Promise<number[]> => {
  const result = await client.query(
    `SELECT DISTINCT clinic_id FROM invoice_items WHERE invoice_id = $1 ORDER BY clinic_id`,
    [invoiceId],
  );
  return result.rows.map((row) => Number(row.clinic_id));
};

/** فحص النطاق: null = كل العيادات (المالية المركزية والمديران). */
const assertInvoiceClinicInScope = (req: AuthenticatedRequest, clinicId: number): void => {
  const allowed = financeClinicScope(req);
  if (allowed === null) return;
  if (!allowed.includes(clinicId)) {
    // نفس رسالة الغياب تماماً: من لا يملك النطاق لا يعرف أن الفاتورة موجودة
    throw new PaymentError(404, ApiErrorCode.VALIDATION_ERROR, 'الفاتورة المطلوبة غير موجودة');
  }
};

/** دفعة سابقة بنفس المفتاح — الفهرس الفريد هو الضمان، وهذا هو التحويل النظيف. */
const findByIdempotencyKey = async (
  client: PoolClient,
  invoiceId: number,
  key: string,
): Promise<Record<string, unknown> | null> => {
  const result = await client.query(
    `SELECT payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code,
            received_by_user_id, received_at, idempotency_key, note, created_at,
            voided_at, voided_by_user_id, void_reason
     FROM payments
     WHERE invoice_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [invoiceId, key],
  );
  return result.rows.length === 0 ? null : result.rows[0];
};

/** المدفوع الحي = مجموع الدفعات غير الملغاة. لا يُقرأ من الفاتورة. */
const livePaidTotal = async (client: PoolClient, invoiceId: number): Promise<number> => {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS live_paid
     FROM payments
     WHERE invoice_id = $1 AND voided_at IS NULL`,
    [invoiceId],
  );
  return round2(Number(result.rows[0].live_paid));
};

/** سجل تدقيق واحد للدفعة — داخل نفس المعاملة، قبل COMMIT */
const writePaymentAudit = async (
  client: PoolClient,
  userId: number,
  clinicId: number,
  paymentId: number,
  invoiceId: number,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'PAYMENT_RECORDED', 'PAYMENT', $3, $4)`,
    [userId, clinicId, String(paymentId), JSON.stringify({ invoice_id: invoiceId, ...metadata })],
  );
};

/* ==========================================================================
 * تسجيل دفعة: فاتورة واحدة، دفعة واحدة
 * ========================================================================== */
export const recordPayment = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // أي حقل يقرره الخادم في الجسم = تزوير، ويُرفض قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_PAYMENT_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب تسجيل دفعة — هذه القيم تُشتق على الخادم`);
  }

  const parsed = paymentSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات تسجيل الدفعة غير صالحة');

  const recordedByUserId = req.user?.userId ?? null;
  if (recordedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لتسجيل الدفعة');
  }

  const { invoice_id: invoiceId, amount, payer_type: payerType, method, currency_code: currencyCode } = parsed.data;
  const idempotencyKey = parsed.data.idempotency_key ?? null;
  const note = parsed.data.note ?? null;
  const paymentAmount = round2(amount);

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 0) العتبة أولاً، قبل أي قفل. غيابها لا يُقرأ كـ"legacy" ولا كـ"بعد العتبة":
    //    هو قاعدة بيانات غير مهيأة للتسوية، ويُرفض صريحاً. ترمي فتُلغى المعاملة.
    const cutoverAt = await readCutoverAt(client);

    // 1) قفل الفاتورة وحده
    const invoice = await lockInvoice(client, invoiceId);
    if (invoice === null) {
      await client.query('ROLLBACK');
      return invoiceNotFound(res);
    }

    // 2) فاتورة قبل العتبة: مدفوعها تأكيد تاريخي، والتسوية مغلقة عليها.
    //    التصنيف ب.created_at وحده، لا بوجود دفعات: فاتورة حديثة غير محصّلة لا
    //    دفعات لها، وتلك قديمة لن تحمل دفعة أبداً.
    const settlementClass = classifyByCreatedAt(invoice.createdAt, cutoverAt);
    if (settlementClass === 'LEGACY') {
      throw new PaymentError(
        409,
        ApiErrorCode.LEGACY_INVOICE_READ_ONLY,
        'هذه الفاتورة صدرت قبل تفعيل سجل التسوية، وتسويتها مغلقة',
        {
          invoice_id: invoiceId,
          created_at: invoice.createdAt.toISOString(),
          cutover_at: cutoverAt.toISOString(),
          reason: 'LEGACY_INVOICE_READ_ONLY',
        },
      );
    }

    // 2) عيادة الفاتورة من بنودها، ثم فحص نطاق المستخدم
    const invoiceClinics = await resolveInvoiceClinic(client, invoiceId);
    if (invoiceClinics.length === 0) {
      throw new PaymentError(
        409,
        ApiErrorCode.FORBIDDEN,
        'لا يمكن تسجيل دفعة على فاتورة بلا بنود — لا عيادة تُنسب إليها الدفعة',
        { invoice_id: invoiceId, reason: 'INVOICE_WITHOUT_LINES' },
      );
    }
    if (invoiceClinics.length > 1) {
      throw new PaymentError(
        409,
        ApiErrorCode.FORBIDDEN,
        'هذه الفاتورة تجمع بنوداً من أكثر من عيادة، ولا يوجد أساس صادق لنسبة دفعة واحدة إليها',
        { invoice_id: invoiceId, clinic_ids: invoiceClinics, reason: 'CROSS_CLINIC_INVOICE' },
      );
    }
    const clinicId = invoiceClinics[0]!;
    assertInvoiceClinicInScope(req, clinicId);

    // 3) العملة: لا يوجد مصدر أسعار صرف في النظام، فلا يُحوَّل ولا يُختلق
    if (currencyCode !== invoice.currencyCode) {
      throw new PaymentError(
        409,
        ApiErrorCode.FORBIDDEN,
        'عملة الدفعة لا تطابق عملة الفاتورة',
        {
          invoice_id: invoiceId,
          invoice_currency: invoice.currencyCode,
          payment_currency: currencyCode,
          reason: 'CURRENCY_MISMATCH',
        },
      );
    }

    // 4) إعادة الطلب نفسها: المفتاح موجود سلفاً، فلا دفعة ثانية ولا خطأ تجاوز.
    //    قبل فحص التجاوز عمداً: الدفعة المسجَّلة نفسها تجعل المجموع مساوياً للصافي،
    //    ففحص التجاوز أولاً كان سيرفض إعادة طلب ناجح.
    if (idempotencyKey !== null) {
      const replay = await findByIdempotencyKey(client, invoiceId, idempotencyKey);
      if (replay !== null) {
        await client.query('ROLLBACK');
        return res.status(200).json({
          message: 'سبق تسجيل هذه الدفعة بنفس مفتاح التكرار',
          idempotent_replay: true,
          payment: replay,
          invoice: {
            invoice_id: invoice.invoiceId,
            net_amount: invoice.netAmount,
            paid_amount: invoice.paidAmount,
            remaining: round2(invoice.netAmount - invoice.paidAmount),
            status: invoiceStatus(invoice.netAmount, invoice.paidAmount),
          },
        });
      }
    }

    // 5) المدفوع الحي من الدفعات، لا من الذاكرة المخزَّنة على الفاتورة
    const paidBefore = await livePaidTotal(client, invoiceId);

    // 6) الذاكرة المخزَّنة يجب أن تطابق ما تثبته الدفعات، وإلا فهي تسيء تمثيل
    //    نفسها ولا يجوز إعادة اشتقاقها فوق أساس لا نعرفه. فاتورة قديمة دفعها
    //    مسجَّل في العمود ولا تملك أي دفعة هي الحالة الوحيدة التي يبلغها هذا
    //    الشرط اليوم: تأكيد بلا سند، فلا يُبنى عليه تحصيل جديد ولا يُمحى.
    if (paidBefore !== invoice.paidAmount) {
      throw new PaymentError(
        409,
        ApiErrorCode.FORBIDDEN,
        'مدفوع الفاتورة المخزَّن لا يطابق مجموع دفعاتها — لن يُعاد اشتقاقه على أساس لا نعرفه',
        {
          invoice_id: invoiceId,
          stored_paid_amount: invoice.paidAmount,
          live_payments_total: paidBefore,
          reason: 'SETTLEMENT_OUT_OF_SYNC',
        },
      );
    }

    // 7) تجاوز المبلغ: مسموح الجزئي، ومسموء بلوغ المتبقي بالضبط، ومرفوض الزيادة
    const paidAfter = round2(paidBefore + paymentAmount);
    if (paidAfter > invoice.netAmount) {
      throw new PaymentError(
        409,
        ApiErrorCode.FORBIDDEN,
        'مبلغ الدفعة يتجاوز المتبقي على الفاتورة',
        {
          invoice_id: invoiceId,
          net_amount: invoice.netAmount,
          paid_amount: paidBefore,
          remaining: round2(invoice.netAmount - paidBefore),
          requested: paymentAmount,
          reason: 'OVERPAYMENT',
        },
      );
    }

    // 8) الإدراج داخل نقطة حفظ: تحتها يلتقط تعارض المفتاح الفريد بدل أن يُسقط
    //    المعاملة كاملة، فيُقرأ كإعادة طلب لا كعطل خادم
    let payment: Record<string, unknown>;
    try {
      await client.query('SAVEPOINT insert_payment');
      const inserted = await client.query(
        `INSERT INTO payments (invoice_id, clinic_id, amount, payer_type, method, currency_code,
                               received_by_user_id, idempotency_key, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING payment_id, invoice_id, clinic_id, amount, payer_type, method, currency_code,
                   received_by_user_id, received_at, idempotency_key, note, created_at,
                   voided_at, voided_by_user_id, void_reason`,
        [invoiceId, clinicId, paymentAmount, payerType, method, currencyCode, recordedByUserId, idempotencyKey, note],
      );
      await client.query('RELEASE SAVEPOINT insert_payment');
      payment = inserted.rows[0]!;
    } catch (insertError: any) {
      await client.query('ROLLBACK TO SAVEPOINT insert_payment');
      if (insertError?.code === '23505' && idempotencyKey !== null) {
        const replay = await findByIdempotencyKey(client, invoiceId, idempotencyKey);
        await client.query('ROLLBACK');
        return res.status(200).json({
          message: 'سبق تسجيل هذه الدفعة بنفس مفتاح التكرار',
          idempotent_replay: true,
          payment: replay,
          invoice: {
            invoice_id: invoice.invoiceId,
            net_amount: invoice.netAmount,
            paid_amount: invoice.paidAmount,
            remaining: round2(invoice.netAmount - invoice.paidAmount),
            status: invoiceStatus(invoice.netAmount, invoice.paidAmount),
          },
        });
      }
      throw insertError;
    }

    // 9) إعادة اشتقاق الذاكرة المخزَّنة من الدفعات الحية — لا جمع على قيمة مقروءة
    const updated = await client.query(
      `UPDATE invoices
       SET paid_amount = COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = $1 AND voided_at IS NULL), 0)
       WHERE invoice_id = $1
       RETURNING net_amount, paid_amount`,
      [invoiceId],
    );
    const netAmount = round2(Number(updated.rows[0]!.net_amount));
    const paidAmount = round2(Number(updated.rows[0]!.paid_amount));

    await writePaymentAudit(client, recordedByUserId, clinicId, Number(payment.payment_id), invoiceId, {
      amount: paymentAmount,
      payer_type: payerType,
      method,
      currency_code: currencyCode,
      idempotency_key: idempotencyKey,
      net_amount: netAmount,
      paid_amount: paidAmount,
      remaining: round2(netAmount - paidAmount),
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'تم تسجيل الدفعة بنجاح',
      idempotent_replay: false,
      payment,
      invoice: {
        invoice_id: invoiceId,
        net_amount: netAmount,
        paid_amount: paidAmount,
        remaining: round2(netAmount - paidAmount),
        status: invoiceStatus(netAmount, paidAmount),
      },
    });
  } catch (error: any) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    // غياب العتبة: قاعدة غير مهيأة للتسوية. يُرفض صريحاً ولا يُقرأ كـ"legacy".
    if (error instanceof SettlementCutoverMissingError) {
      return res.status(503).json({ message: error.message, code: ApiErrorCode.SETTLEMENT_CUTOVER_MISSING });
    }
    if (error instanceof PaymentError) {
      return res.status(error.status).json(error.payload);
    }
    console.error('Record Payment Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الدفعة', code: ApiErrorCode.INTERNAL_ERROR });
  } finally {
    // المسار الناجح وحده يملك connection؛ ومسارات الرفض تُحرّره أيضاً هنا.
    client?.release();
  }
};
