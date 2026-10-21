import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  fulfilmentDecisionSchema,
  DECISION_OWNED_FULFILMENT_STATUSES,
  DISPENSING_OWNED_FULFILMENT_STATUSES,
  FULFILMENT_SOURCES,
  FORBIDDEN_FULFILMENT_FIELDS,
  type FulfilmentDecisionInput,
} from '../../validations/fulfilmentDecision.validation';
import { buildClinicScope, parsePositiveId } from '../inventory/clinicScope';

/* ==========================================================================
 * Phase 10F.2 — قرار المريض بشأن التنفيذ (fulfilment decision)
 *
 * القاعدة: الروشتة ليست صرفاً. هذا المسار يكتب قرار المريض فقط — من أين سيأخذ
 * الدواء أم Decline — ولا يفعل ولا يفتح: لا صرف، لا خصم مخزون، لا حركة مخزون،
 * لا فاتورة، لا تعديل مالي، لا تعديل بنود صرف. سجل التدقيق الوحيد هو
 * استثناء مقصود، وهو سجل لا أثر مالي فيه.
 *
 * ملكية الحالة مقسومة عمداً:
 *   هذا المسار : PENDING | CLINIC_DISPENSING | EXTERNAL_PHARMACY | PATIENT_DECLINED | CANCELLED
 *   مسار الصرف  : DISPENSED_FROM_CLINIC | PARTIALLY_DISPENSED (قائم، بلا تعديل)
 *
 * ممنوع على أي مستخدم أن يكتب حالة يملكها مسار الصرف: ادعاء صرف لم يحدث أسوأ
 * من غيابه، لذلك يُرفض ولا يُقبل أي تجاوز.
 * ========================================================================== */

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

const conflictError = (res: Response, message: string, extra: Record<string, unknown> = {}) =>
  res.status(409).json({ message, code: ApiErrorCode.FORBIDDEN, ...extra });

// موحّد: بند غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده)
const itemNotFound = (res: Response) =>
  res.status(404).json({ message: 'بند الروشتة المطلوب غير موجود' });

/** أعمدة القراءة المُعادة — عمود قرار فقط، بلا أي عمود مخزون أو مالي */
const DECISION_COLUMNS = `pi.item_id, pi.prescription_id, pi.fulfilment_status, pi.decision_note,
       pi.decided_by_user_id, pi.decided_at, pi.source`;

/**
 * يحمّل بند الروشتة ضمن نطاق العيادات ويشتق عيادته من الزيارة، مقفلاً FOR UPDATE.
 * القفل هو ما يمنع السباق: لو تزامن هذا المسار مع مسار الصرف على نفس البند،
 * فالقفل يُجبر أحدهما على الانتظار ثم قراءة الحالة الحقيقية بعد قفل الآخر.
 *
 * يستقبل منفّذ الاستعلام (pool للقراءة فقط، أو client داخل معاملة) حتى تُقرأ
 * الحالة على نفس الاتصال الذي ستُكتب عليه.
 */
const loadPrescriptionItemForUpdate = async (
  req: AuthenticatedRequest,
  itemId: number,
  run: { query: (text: string, params: unknown[]) => Promise<{ rows: any[] }> },
) => {
  const scope = buildClinicScope(req, [itemId], 'v.clinic_id');
  const result = await run.query(
    `SELECT pi.item_id, pi.prescription_id, pi.fulfilment_status, v.clinic_id
     FROM prescription_items pi
     JOIN prescriptions p ON p.prescription_id = pi.prescription_id
     JOIN visits v ON v.visit_id = p.visit_id
     WHERE pi.item_id = $1${scope.clause}
     FOR UPDATE OF pi`,
    scope.params,
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    item_id: Number(row.item_id),
    prescription_id: Number(row.prescription_id),
    clinic_id: Number(row.clinic_id),
    // صفوف ما قبل 045 تحمل PENDING افتراضياً، وغياب العمود يُقرأ PENDING أيضاً
    fulfilment_status:
      row.fulfilment_status === null || row.fulfilment_status === undefined
        ? 'PENDING'
        : String(row.fulfilment_status),
  };
};

/** حالات القرار المسجَّلة فعلاً — لا يجوز محوُها بلا تأكيد صريح */
const isRecordedDecision = (status: string): boolean =>
  status === 'CLINIC_DISPENSING' || status === 'EXTERNAL_PHARMACY' || status === 'PATIENT_DECLINED' || status === 'CANCELLED';

/**
 * يسجّل/يحدّث قرار المريض لبند روشتة واحد.
 *
 * الاستعلامان الوحيدان اللذان يكتبان هما UPDATE prescription_items (خمسة أعمدة
 * قرار فقط) و INSERT في audit_logs. لا استعلام على المخزون ولا الحركات ولا
 * الفواتير ولا جداول الصرف إطلاقاً — لا قراءة ولا كتابة.
 */
export const recordFulfilmentDecision = async (req: AuthenticatedRequest, res: Response) => {
  const itemId = parsePositiveId(req.params.id);
  if (itemId === null) return validationError(res, 'معرّف بند الروشتة غير صالح');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const forbiddenField = FORBIDDEN_FULFILMENT_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(
      res,
      `الحقل ${forbiddenField} غير مقبول في تسجيل قرار التنفيذ — هذه القيم تُشتق من سجل الصرف أو من الجلسة`,
    );
  }

  const parsed = fulfilmentDecisionSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات قرار التنفيذ غير صالحة');

  // هوية المُسجِّل من الجلسة حصراً — لا تُقرأ من جسم الطلب أبداً
  const userId = req.user?.userId;
  if (userId === undefined || userId === null) {
    return res.status(401).json({ message: 'المستخدم غير موثق', code: ApiErrorCode.UNAUTHENTICATED });
  }

  const decision: FulfilmentDecisionInput = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await loadPrescriptionItemForUpdate(req, itemId, client);
    if (item === null) {
      await client.query('ROLLBACK');
      return itemNotFound(res);
    }

    const current = item.fulfilment_status;
    const next = decision.fulfilment_status;

    // 1) حالات مسار الصرف لا تُكتب من هنا إطلاقاً — رفض قبل أي كتابة
    if (
      (DISPENSING_OWNED_FULFILMENT_STATUSES as readonly string[]).includes(next) ||
      (DISPENSING_OWNED_FULFILMENT_STATUSES as readonly string[]).includes(current)
    ) {
      await client.query('ROLLBACK');
      return conflictError(
        res,
        'حالة التنفيذ هذه يكتبها مسار الصرف وحده ولا تُسجَّل كقرار للمريض',
        {
          reason: 'DISPENSING_OWNED_STATUS',
          current_fulfilment_status: current,
          requested_fulfilment_status: next,
          dispensing_owned_statuses: DISPENSING_OWNED_FULFILMENT_STATUSES,
          decision_owned_statuses: DECISION_OWNED_FULFILMENT_STATUSES,
        },
      );
    }

    // 2) الرجوع إلى PENDING يمحو قراراً مسجَّلاً، فلا يُمحى إلا بتأكيد صريح.
    //    هذه هي نقطة "عدم تجاوز صامت لقرار المريض": لا يستطيع أحد أن يعيد البند
    //    إلى "لم يُقرَّر بعد" ثم يصرفه من العيادة دون أثر صريح على السجل.
    if (next === 'PENDING' && isRecordedDecision(current) && decision.reset_to_pending !== true) {
      await client.query('ROLLBACK');
      return conflictError(
        res,
        'يوجد قرار مسجَّل للمريض — العودة إلى "لم يُقرَّر بعد" تتطلب تأكيداً صريحاً',
        {
          reason: 'RESET_REQUIRES_CONFIRMATION',
          current_fulfilment_status: current,
          requested_fulfilment_status: next,
          required_flag: 'reset_to_pending',
        },
      );
    }

    // 3) PENDING تعني "لم يُقرَّر بعد": تُمسح ملاحظة القرار ومُسجِّله وتوقيته.
    //    بقاؤها بعد الرجوع سيجعل "بلا قرار" يحمل هوية ووقت مَن تراجع عنه.
    //    ملاحظة decision_note اختيارية؛ إرساله بلا قيمة يمسح الملاحظة.
    const note = decision.decision_note === undefined ? null : decision.decision_note;
    // المصدر مشتق من الحالة نفسها، لا من العميل: قرار خارجي ⇒ مصدر خارجي.
    const source = decision.source ?? (next === 'EXTERNAL_PHARMACY' ? 'EXTERNAL' : 'CLINIC');
    const decidedBy = next === 'PENDING' ? null : userId;

    // 4) كتابة أعمدة القرار الخمسة فقط، محروسة بالعيادة المشتقّة وبالحالة
    //    المقروءة تحت القفل: صفر صف = تغيّر شيء بين القراءة والكتابة.
    //    decided_at من ساعة الخادم (NOW()) لا من جسم الطلب.
    // cast صريح على $1: نفس الباراميتر يُسنَد إلى عمود VARCHAR ويُقارن بثابت نصّي،
    // وبلا cast يستنتج PostgreSQL نوعين مختلفين له (text مقابل character varying)
    // فيرفض الاستعلام بالخطأ 42P08 قبل أي كتابة.
    const updated = await client.query(
      `UPDATE prescription_items AS pi
       SET fulfilment_status = $1::varchar(24),
           decision_note = $2,
           decided_by_user_id = $3,
           decided_at = CASE WHEN $1::varchar(24) = 'PENDING' THEN NULL ELSE NOW() END,
           source = $4
       WHERE pi.item_id = $5
         AND pi.fulfilment_status = $6
         AND EXISTS (
           SELECT 1
           FROM prescriptions p
           JOIN visits v ON v.visit_id = p.visit_id
           WHERE p.prescription_id = pi.prescription_id
             AND v.clinic_id = $7
         )
       RETURNING ${DECISION_COLUMNS}`,
      [next, note, decidedBy, source, itemId, current, item.clinic_id],
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return conflictError(res, 'تغيّرت حالة بند الروشتة أثناء التسجيل — أعد المحاولة', {
        reason: 'STALE_FULFILMENT_STATUS',
      });
    }

    // 5) التدقيق — داخل نفس المعاملة، ففشله يُسقط القرار ولا يترك أثراً جزئياً.
    //    سجل التدقيق يحتفظ بما مُسح عند الرجوع إلى PENDING فلا يضيع.
    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'PRESCRIPTION_FULFILMENT_DECISION_RECORDED', 'PRESCRIPTION_ITEM', $3, $4)`,
      [
        userId,
        item.clinic_id,
        String(itemId),
        JSON.stringify({
          prescription_item_id: itemId,
          prescription_id: item.prescription_id,
          previous_fulfilment_status: current,
          fulfilment_status: next,
          decision_note: note,
          source,
          decided_by_user_id: decidedBy,
          reset_to_pending: decision.reset_to_pending === true,
          // صريح في السجل: قرار مُوثَّق فقط، بلا أثر مخزوني ولا مالي
          inventory_effect: 'NONE',
          financial_effect: 'NONE',
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'تم تسجيل قرار المريض',
      fulfilment: updated.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Record Fulfilment Decision Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تسجيل قرار التنفيذ',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client.release();
  }
};

/** القيم المسموح كتابتها — مُصدَّرة للواجهة والاختبارات بلا تكرار القوائم */
export const FULFILMENT_DECISION_OPTIONS = {
  decision_owned: DECISION_OWNED_FULFILMENT_STATUSES,
  sources: FULFILMENT_SOURCES,
};
