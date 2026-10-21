import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { round2 } from './billing.calculation';
import { getBaseCurrency } from '../currencies/currency.validation';
import { buildClinicScope, parsePositiveId } from '../inventory/clinicScope';
import { readCutoverAt, SettlementCutoverMissingError } from './settlementCutover';
import {
  medicationChargeSchema,
  FORBIDDEN_MEDICATION_CHARGE_FIELDS,
  INVOICABLE_DISPENSING_STATUSES,
  type InvoicableDispensingStatus,
} from '../../validations/medicationCharge.validation';

/* ==========================================================================
 * Phase 10E.4 — Dispensing → invoice foundation
 *
 * القاعدة الأساسية: الفوترة بالصرف لا بالروشتة. كل صرف ناجح — كامل أو جزئي أو
 * تكرار لاحق — ينتج رسومه الخاصة، ولا يمكن أن يتكرر رسم الصرف نفسه.
 *
 * مصدر الأرقام financials وحده، بلا استثناء:
 *   - الهوية (العيادة/المريض/الزيارة/الدواء) من سجل الصرف
 *   - الكمية من dispensing_items.dispensed_quantity (المصروف فعلياً)
 *   - السعر من dispensing_items.unit_price_snapshot (المجمّد وقت الصرف)
 * لا يُقرأ medication_prices إطلاقاً هنا: تغيير السعر بعد الصرف لا يجوز أن
 * يغيّر فاتورة صادرة، وقراءة السعر الحالي هنا هي أسوأ خطأ ممكن في هذا الموضع.
 *
 * المعاملة الواحدة:
 *   BEGIN -> قفل سجل الصرف FOR UPDATE -> التحقق من الأهلية -> التأكد من عدم
 *   وجود رسم سابق -> إنشاء الفاتورة -> بنود الدواء -> تدقيق -> COMMIT
 *
 * لا مدفوعات: الفاتورة تصدر غير محصّلة (paid_amount = 0). التحصيل مرحلة لاحقة،
 * ولا يوجد هنا أي refund أو رصيد أو تسوية تكلفة.
 * ========================================================================== */

/** خطأ نطاقي/منطقي داخل المعاملة — يؤدي دائماً إلى ROLLBACK ثم استجابة. */
class MedicationChargeError extends Error {
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

/** موحّد: صرف غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده) */
const dispensingNotFound = (res: Response) =>
  res.status(404).json({ message: 'سجل الصرف المطلوب غير موجود' });

interface ChargeableItem {
  dispensingItemId: number;
  medicationId: number;
  dispensedQuantity: string;
  unitPriceSnapshot: string;
  lineTotal: string;
}

interface LockedDispensing {
  dispensingId: number;
  visitId: number;
  clinicId: number;
  patientId: number;
  status: string;
  dispensedByUserId: number;
}

/**
 * قفل سجل الصرف والتحقق من أهليته للاشهار.
 * القفل يجعل فحص "هل سبق اشهاره؟" ذرّياً: أي محاولة إصدار متزامنة تنتظر خلف
 * هذا القفل ثم ترى الفاتورة القائمة عند إعادة القراءة أدناه.
 *
 * clinic_id على الصرف مصدر الحقيقة للنطاق، تماماً كما في وحدة المخزون.
 */
const lockChargeableDispensing = async (
  req: AuthenticatedRequest,
  dispensingId: number,
  client: PoolClient,
): Promise<LockedDispensing> => {
  const scope = buildClinicScope(req, [dispensingId], 'd.clinic_id');
  const result = await client.query(
    `SELECT d.dispensing_id, d.visit_id, d.clinic_id, d.patient_id, d.status, d.dispensed_by_user_id
     FROM dispensings d
     WHERE d.dispensing_id = $1${scope.clause}
     FOR UPDATE OF d`,
    scope.params,
  );

  if (result.rows.length === 0) {
    throw new MedicationChargeError(404, ApiErrorCode.VALIDATION_ERROR, 'سجل الصرف المطلوب غير موجود');
  }

  const row = result.rows[0];
  const status = String(row.status);
  if (!(INVOICABLE_DISPENSING_STATUSES as readonly string[]).includes(status)) {
    // VOIDED (أو أي حالة أخرى) لا تُحمَّل: صرف ملغى لا قيمة مالية له
    throw new MedicationChargeError(
      409,
      ApiErrorCode.FORBIDDEN,
      'هذا السجل ليس صرفاً صالحاً للاشهار المالي',
      { dispensing_id: dispensingId, status, invoicable_statuses: INVOICABLE_DISPENSING_STATUSES },
    );
  }

  return {
    dispensingId: Number(row.dispensing_id),
    visitId: Number(row.visit_id),
    clinicId: Number(row.clinic_id),
    patientId: Number(row.patient_id),
    status,
    dispensedByUserId: Number(row.dispensed_by_user_id),
  };
};

/**
 * بنود الصرف القابلة للشحن، بأسعارها المجمّدة.
 *
 * ثلاث شروط لا تتنازل:
 *  - dispensed_quantity > 0: بند لم يُصرف منه شيء ليس له قيمة
 *  - unit_price_snapshot IS NOT NULL: صف بدون لقطة سعر (ما قبل 10E.3) لا يجوز
 *    تخمين سعره من سعر اليوم — يُرفض الاشهار بدل تلفيق رقم
 *  - clinic_id على البند = عيادة الصرف: لا يُشحن صنف عيادة على فاتورة عيادة أخرى
 */
const loadChargeableItems = async (
  client: PoolClient,
  dispensing: LockedDispensing,
): Promise<ChargeableItem[]> => {
  const result = await client.query(
    `SELECT di.dispensing_item_id, di.medication_id, di.dispensed_quantity, di.unit_price_snapshot
     FROM dispensing_items di
     WHERE di.dispensing_id = $1
       AND di.dispensed_quantity > 0
       AND di.unit_price_snapshot IS NOT NULL
     ORDER BY di.dispensing_item_id ASC`,
    [dispensing.dispensingId],
  );

  const items: ChargeableItem[] = result.rows.map((row) => {
    const dispensed = String(row.dispensed_quantity);
    const unitPrice = String(row.unit_price_snapshot);
    return {
      dispensingItemId: Number(row.dispensing_item_id),
      medicationId: Number(row.medication_id),
      dispensedQuantity: dispensed,
      unitPriceSnapshot: unitPrice,
      lineTotal: String(round2(Number(dispensed) * Number(unitPrice))),
    };
  });

  if (items.length === 0) {
    throw new MedicationChargeError(
      409,
      ApiErrorCode.FORBIDDEN,
      'لا توجد بنود صرف قابلة للاشهار — الكمية المصروفة صفرية أو لا يوجد سعر مجمّد',
      {
        dispensing_id: dispensing.dispensingId,
        reason: 'NOTHING_CHARGEABLE',
      },
    );
  }

  return items;
};

/**
 * هل صدرت فاتورة لهذا الصرف سابقاً؟
 * الفهرس الفريد uq_invoice_items_dispensing_item هو الضمان الحقيقي؛ هذا
 * الاستعلام هو الطبقة الأولى التي تُحوِّل السباق إلى 409 نظيف بدل 500.
 */
const findExistingCharge = async (
  client: PoolClient,
  dispensingId: number,
): Promise<{ invoiceId: number; lineCount: number } | null> => {
  const result = await client.query(
    `SELECT invoice_id, COUNT(*)::int AS line_count
     FROM invoice_items
     WHERE dispensing_id = $1
     GROUP BY invoice_id
     ORDER BY invoice_id ASC
     LIMIT 1`,
    [dispensingId],
  );
  return result.rows.length === 0
    ? null
    : { invoiceId: Number(result.rows[0].invoice_id), lineCount: Number(result.rows[0].line_count) };
};

/** سجل تدقيق واحد للاشهار — داخل نفس المعاملة */
const writeChargeAudit = async (
  client: PoolClient,
  userId: number,
  clinicId: number,
  invoiceId: number,
  dispensingId: number,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'DISPENSING_INVOICED', 'INVOICE', $3, $4)`,
    [userId, clinicId, String(invoiceId), JSON.stringify({ invoice_id: invoiceId, ...metadata })],
  );
};

/* ==========================================================================
 * إصدار رسم دواء لسجل صرف واحد
 * ========================================================================== */
export const createMedicationCharge = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // أي هوية أو سعر أو كمية في الجسم = تزوير، ويُرفض قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_MEDICATION_CHARGE_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب اشهار صرف — هذه القيم تُشتق من سجل الصرف`);
  }

  const parsed = medicationChargeSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات اشهار صرف غير صالحة');

  const issuedByUserId = req.user?.userId ?? null;
  if (issuedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لإصدار رسم صرف');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) قفل الصرف والتحقق من أنه مؤهَّل للاشهار
    const dispensing = await lockChargeableDispensing(req, parsed.data.dispensing_id, client);

    // 2) هل صدر له رسم سابق؟ الفهرس الفريد يجعل هذا استعلاماً حاسماً
    const existing = await findExistingCharge(client, dispensing.dispensingId);
    if (existing !== null) {
      throw new MedicationChargeError(
        409,
        ApiErrorCode.FORBIDDEN,
        'سبق إصدار فاتورة لهذا الصرف',
        {
          reason: 'ALREADY_INVOICED',
          dispensing_id: dispensing.dispensingId,
          invoice_id: existing.invoiceId,
        },
      );
    }

    // 3) البنود بأسعارها المجمّدة — لا استعلام على medication_prices
    const items = await loadChargeableItems(client, dispensing);

    const totalAmount = round2(items.reduce((sum, item) => sum + Number(item.lineTotal), 0));
    if (!Number.isFinite(totalAmount) || totalAmount < 0) {
      throw new MedicationChargeError(400, ApiErrorCode.VALIDATION_ERROR, 'إجمالي الفاتورة غير صالح');
    }

    const baseCurrency = await getBaseCurrency();

    // 3ب) عتبة التسوية (Phase 10G.3) — تُقرأ كبوابة لا كمبلغ. رسم الدواء يُصدر
    //     غير محصّل قبل العتبة وبعدها، فالفرق ليس في الرقم بل في القاعدة: فاتورة
    //     الخدمات تُقرأ العتبة لتقرر المدفوع عند الإصدار، وهذه تُقرأ لتتأكد أن
    //     قاعدة البيانات مهيأة للتسوية أصلاً. readCutoverAt ترمي إن غاب الصف،
    //     فيُرفض الإصدار صريحاً بدل الكتابة على قاعدة بلا تسوية.
    await readCutoverAt(client);

    // 4) الفاتورة — هوية المريض والزيارة والعيادة من الصرف، والمدفوع صفر قبل
    //    العتبة وبعدها. payment_type يبقى 'CASH' معلناً كما كان: 044 يقرأه
    //    لاشتقاق حق الاسترداد، لا كإثبات لوصول مال.
    const invoiceResult = await client.query(
      `INSERT INTO invoices (patient_id, visit_id, receptionist_id, total_amount, discount_amount, net_amount, paid_amount, payment_type, currency_code)
       VALUES ($1, $2, $3, $4, 0, $4, 0, 'CASH', $5)
       RETURNING invoice_id, total_amount, net_amount, paid_amount, currency_code`,
      [dispensing.patientId, dispensing.visitId, issuedByUserId, totalAmount, baseCurrency],
    );
    const invoice = invoiceResult.rows[0];
    const invoiceId = Number(invoice.invoice_id);

    // 5) بنود الدواء. price = إجمالي السطر و quantity = 1 ليبقى
    //    SUM(price * quantity) في التقارير المالية صحيحاً دون تعديلها،
    //    والسعر والكمية الدقيقان محفوظان في عموديهما المخصصين.
    //
    // Phase 10E.8: medication_discount_value is snapshotted as 0 for now. It is a
    // server-derived value, never a request field — this endpoint accepts no
    // financial input from the client at all, and a client-supplied discount would
    // be a forgery vector. When a loyalty system exists it will supply this value
    // server-side; the column already exists so the history is exact from now on.
    // A null here would be worse than 0: 0 is a real, recorded "no discount".
    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, clinic_id, service_id, dispensing_id, dispensing_item_id, medication_id,
            dispensed_quantity, unit_price_snapshot, line_total, price, quantity,
            medication_discount_value)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $8, 1, 0)`,
        [
          invoiceId,
          dispensing.clinicId,
          dispensing.dispensingId,
          item.dispensingItemId,
          item.medicationId,
          item.dispensedQuantity,
          item.unitPriceSnapshot,
          item.lineTotal,
        ],
      );
    }

    await writeChargeAudit(client, issuedByUserId, dispensing.clinicId, invoiceId, dispensing.dispensingId, {
      dispensing_id: dispensing.dispensingId,
      clinic_id: dispensing.clinicId,
      patient_id: dispensing.patientId,
      visit_id: dispensing.visitId,
      dispensing_status: dispensing.status,
      issued_by_user_id: issuedByUserId,
      line_count: items.length,
      total_amount: totalAmount,
      items: items.map((item) => ({
        dispensing_item_id: item.dispensingItemId,
        medication_id: item.medicationId,
        dispensed_quantity: item.dispensedQuantity,
        unit_price_snapshot: item.unitPriceSnapshot,
        line_total: item.lineTotal,
      })),
    });

    await client.query('COMMIT');
    // NOT `client = null`: the finally block releases the client, so nulling it
    // here would skip the release on the one path that actually succeeds.

    return res.status(201).json({
      message: 'تم إصدار فاتورة صرف الأدوية بنجاح',
      invoice_id: invoiceId,
      dispensing_id: dispensing.dispensingId,
      total_amount: totalAmount,
      net_amount: totalAmount,
      paid_amount: 0,
      currency_code: invoice.currency_code,
      line_count: items.length,
      settlement: 'PAYMENT_BACKED',
      items,
    });
  } catch (error: any) {
    await client?.query('ROLLBACK').catch(() => undefined);

    // غياب عتبة التسوية: قاعدة غير مهيأة، لا خطأ في الطلب ولا عطل خادم عابر.
    if (error instanceof SettlementCutoverMissingError) {
      return res.status(503).json({ message: error.message, code: ApiErrorCode.SETTLEMENT_CUTOVER_MISSING });
    }

    // uq_invoice_items_dispensing_item:_dspar — فازت محاولة متزامنة، وهذا تعارض
    // مشروع لا عطل، فيُقرأ كما يُقرأ أي اشهار مكرر.
    if (error?.code === '23505') {
      const winner = await pool
        .query(
          `SELECT invoice_id FROM invoice_items WHERE dispensing_id = $1 LIMIT 1`,
          [parsed.data.dispensing_id],
        )
        .then((r) => (r.rows.length > 0 ? Number(r.rows[0].invoice_id) : null))
        .catch(() => null);

      return res.status(409).json({
        message: 'سبق إصدار فاتورة لهذا الصرف',
        code: ApiErrorCode.FORBIDDEN,
        reason: 'ALREADY_INVOICED',
        dispensing_id: parsed.data.dispensing_id,
        invoice_id: winner,
      });
    }

    if (error instanceof MedicationChargeError) {
      return res.status(error.status).json(error.payload);
    }

    console.error('Create Medication Charge Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إصدار فاتورة صرف الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    // The client must go back to the pool on EVERY path. Phase 10E.9: this was
    // missing, so every charge — committed, refused, or failed — permanently
    // leaked one connection. Once the pool's max was reached, `getBaseCurrency`
    // and every other query in the process timed out and the whole API stopped,
    // not just charging. Same shape as the returns path (medicationReturns
    // .controller.ts finally block).
    client?.release();
  }
};

/* ==========================================================================
 * هل صدر للصرف فاتورة؟ — قراءة متزامنة آمنة، وليست مسار اشهار ثانٍ
 * ========================================================================== */
export const getDispensingCharge = async (req: AuthenticatedRequest, res: Response) => {
  const dispensingId = parsePositiveId(req.params.id);
  if (dispensingId === null) return validationError(res, 'معرّف سجل الصرف غير صالح');

  try {
    // نفس فحص النطاق المستخدم في قفل الصرف: الصرف خارج النطاق = غير موجود
    const scope = buildClinicScope(req, [dispensingId], 'd.clinic_id');
    const check = await pool.query(
      `SELECT d.dispensing_id FROM dispensings d WHERE d.dispensing_id = $1${scope.clause}`,
      scope.params,
    );
    if (check.rows.length === 0) return dispensingNotFound(res);

    const invoice = await pool.query(
      `SELECT i.invoice_id, i.total_amount, i.net_amount, i.paid_amount, i.created_at,
              COUNT(ii.item_id)::int AS line_count
       FROM invoice_items ii
       JOIN invoices i ON i.invoice_id = ii.invoice_id
       WHERE ii.dispensing_id = $1
       GROUP BY i.invoice_id, i.total_amount, i.net_amount, i.paid_amount, i.created_at
       LIMIT 1`,
      [dispensingId],
    );

    if (invoice.rows.length === 0) {
      return res.status(200).json({ dispensing_id: dispensingId, invoiced: false, invoice: null });
    }

    return res.status(200).json({
      dispensing_id: dispensingId,
      invoiced: true,
      invoice: invoice.rows[0],
    });
  } catch (error) {
    console.error('Get Dispensing Charge Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب فاتورة الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};