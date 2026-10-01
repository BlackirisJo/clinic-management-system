import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest, canManageAllClinics, accessibleClinicIds } from '../../middlewares/auth.middleware';
import { canAccessLogs } from '../audit/audit.controller';
import {
  stockCountCreateSchema,
  stockCountLineCreateSchema,
  stockCountFinaliseSchema,
  FORBIDDEN_STOCK_COUNT_FIELDS,
  FORBIDDEN_STOCK_COUNT_LINE_FIELDS,
  FORBIDDEN_STOCK_COUNT_FINALISE_FIELDS,
  INITIAL_STOCK_COUNT_STATUS,
  STOCK_COUNT_FINALISATION_REASON,
  STOCK_COUNT_REFERENCE_TYPE,
  FINAL_VARIANCE_ADJUSTMENT,
  MAX_COUNT_QUANTITY,
  roundCountQuantity,
  type StockCountLineCreateInput,
} from '../../validations/stockCount.validation';
import {
  stockCountListQuerySchema,
  stockCountReconciliationQuerySchema,
  DEFAULT_STOCK_COUNT_LIMIT,
  type StockCountListQuery,
} from '../../validations/stockCountRead.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10D.6 — Stock count foundation
 *
 * هذه المرحلة تسجّل الحالة فقط. لا مسار فيها يغيّر كمية مخزون:
 * - لا UPDATE على inventory_batches إطلاقاً
 * - لا INSERT في stock_movements إطلاقاً
 * - لا عزل ولا إطلاق عزل
 * - لا تسوية من الفارق، ولا اعتماد، ولا إنهاء للعد
 *
 * الأرقام الثلاثة في سطر العد (system_quantity / counted_quantity / variance)
 * تُجمَّد لحظة إنشاء السطر تحت قفل صف الدفعة، ولا يُعاد حسابها بعد ذلك أبداً.
 *
 * فتح جلسة العد — معاملة واحدة:
 *   BEGIN -> اشتقاق العيادة من نطاق المستخدم -> إدراج رأس العد -> سجل تدقيق -> COMMIT
 *
 * تسجيل سطر عد — معاملة واحدة:
 *   BEGIN
 *   -> قفل الدفعة FOR UPDATE (وحدها تمنح system_quantity متسقة)
 *   -> التحقق أن العد موجود ومحصور بالعيادات ومفتوح
 *   -> التحقق أن الدفعة تنتمي لنفس عيادة العد
 *   -> التحقق من عدم وجود سطر لنفس (العد، الدفعة)
 *   -> إدراج السطر بلقطةSYSTEMمحسوبة على الخادم
 *   -> COMMIT
 *
 * لا SKIP LOCKED: قفل الدفعة ينتظر المتسابق بدلاً من تجاوزه.
 * ========================================================================== */

/** خطأ نطاقي/منطقي داخل المعاملة — يؤدي دائماً إلى ROLLBACK ثم استجابة. */
class StockCountError extends Error {
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

// موحّد: عد غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده)
const countNotFound = (res: Response) =>
  res.status(404).json({ message: 'جلسة الجرد المطلوبة غير موجودة' });

/** حقول العرض الآمنة للمستخدمين — الاسم فقط، بلا اسم مستخدم ولا بريد ولا هوية. */
const COUNTED_BY_NAME = 'cu.full_name AS counted_by_name';
const FINALISED_BY_NAME = 'fu.full_name AS finalised_by_name';
const APPROVED_BY_NAME = 'au.full_name AS approved_by_name';

/**
 * اشتقاق عيادة العد من نطاق المستخدم المُصادَق عليه — لا من جسم الطلب أبداً.
 * الترتيب: عيادة المستخدم الأساسية إن كانت في نطاقه، ثم عيادة وحيدة إن كانت
 * نطاقه عيادة واحدة. لا يوجد مسار يُخترع فيه مرشّح.
 */
const resolveCountClinic = (req: AuthenticatedRequest): number | null => {
  const primary = req.user?.clinicId ?? null;
  if (primary !== null && typeof primary === 'number' && primary > 0) {
    if (canManageAllClinics(req)) return primary;
    const scoped = accessibleClinicIds(req) ?? [];
    if (scoped.includes(primary)) return primary;
  }
  const scoped = accessibleClinicIds(req) ?? [];
  return scoped.length === 1 ? scoped[0]! : null;
};

/* ==========================================================================
 * 1. فتح جلسة عد (POST /api/stock-counts)
 * ========================================================================== */
export const createStockCount = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // حارس صريح قبل أي وصول لقاعدة البيانات: الهوية والنطاق والحالة ليست
  // مُدخَلات — كلها تُشتق من الخادم
  const forbiddenField = FORBIDDEN_STOCK_COUNT_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب فتح الجرد — هذه القيم تُشتق من الخادم`);
  }

  const parsed = stockCountCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات فتح جلسة الجرد غير صالحة');

  const countedByUserId = req.user?.userId ?? null;
  if (countedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لفتح جلسة الجرد');
  }

  // العيادة من نطاق الوصول، لا من الطلب. ولا مرشّح واضح = لا فتح.
  const clinicId = resolveCountClinic(req);
  if (clinicId === null) {
    return validationError(res, 'تعذّر تحديد عيادة الجرد من نطاق صلاحياتك');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // status يحدده الخادم دائماً: كل عد جديد OPEN
    const header = await client.query(
      `INSERT INTO stock_counts (clinic_id, status, counted_by_user_id, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING count_id, clinic_id, status, counted_by_user_id, approved_by_user_id,
                 notes, created_at, finalised_at`,
      [clinicId, INITIAL_STOCK_COUNT_STATUS, countedByUserId, parsed.data.notes ?? null],
    );

    // سجل تدقيق واحد لفتح الجلسة فقط. لا سجل لكل سطر: تسجيل سطر عد قراءة
    // فيزيائية لا تغيير مخزون، وسطر العد نفسه هو السجل.
    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'STOCK_COUNT_OPENED', 'STOCK_COUNT', $3, $4)`,
      [
        countedByUserId,
        clinicId,
        String(header.rows[0].count_id),
        JSON.stringify({
          count_id: header.rows[0].count_id,
          clinic_id: clinicId,
          status: INITIAL_STOCK_COUNT_STATUS,
          counted_by_user_id: countedByUserId,
          notes: parsed.data.notes ?? null,
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'تم فتح جلسة الجرد بنجاح',
      stock_count: header.rows[0],
    });
  } catch (error: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — يُتجاهل لأن العملية فشلت أصلاً
      }
    }
    if (error?.code === '23503') return validationError(res, 'العيادة أو المستخدم المحدد غير موجود');
    if (error?.code === '23514') {
      return res.status(409).json({
        message: 'جلسة الجرد تخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Create Stock Count Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء فتح جلسة الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};

/* ==========================================================================
 * 2. تسجيل سطر عد (POST /api/stock-counts/:id/lines)
 * ========================================================================== */

const runAddStockCountLine = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  countId: number,
  input: StockCountLineCreateInput,
): Promise<Record<string, unknown>> => {
  // 1) قفل الدفعة أولاً — هذا هو ما يجعل لقطة system_quantity متسقة.
  //    النطاق يمر عبر صنف المخزون (i.clinic_id)، لا عبر الدفعة وحدها.
  const batchScope = buildClinicScope(req, [input.batch_id], 'i.clinic_id');
  const locked = await client.query(
    `SELECT b.batch_id, b.inventory_id, b.quantity_on_hand, b.lot_number, b.expiry_date, b.is_active,
            i.medication_id, i.clinic_id
     FROM inventory_batches b
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     WHERE b.batch_id = $1 AND i.deleted_at IS NULL${batchScope.clause}
     FOR UPDATE OF b`,
    batchScope.params,
  );
  // الدفعة الغائبة والخارجة عن النطاق تُعامَلان بنفس 404 تماماً
  if (locked.rows.length === 0) {
    throw new StockCountError(404, ApiErrorCode.VALIDATION_ERROR, 'الدفعة المطلوبة غير موجودة');
  }
  const batch = locked.rows[0];
  const batchClinicId = Number(batch.clinic_id);

  // 2) العد نفسه: محصور بالعيادات، ومفتوح فقط.
  //    ترتيب القفل ثابت في كل طلبات هذا المسار (الدفعة ثم العد) فلا يمكن أن
  //    يتشابك طلبان متقاطعان على نفس الدفعة/العد.
  const countScope = buildClinicScope(req, [countId], 'sc.clinic_id');
  const counted = await client.query(
    `SELECT sc.count_id, sc.clinic_id, sc.status
     FROM stock_counts sc
     WHERE sc.count_id = $1${countScope.clause}
     FOR UPDATE OF sc`,
    countScope.params,
  );
  // العد الغائب والخارج عن النطاق يُعامَلان بنفس 404 تماماً
  if (counted.rows.length === 0) {
    throw new StockCountError(404, ApiErrorCode.VALIDATION_ERROR, 'جلسة الجرد المطلوبة غير موجودة');
  }
  const count = counted.rows[0];
  const countClinicId = Number(count.clinic_id);
  if (String(count.status) !== 'OPEN') {
    throw new StockCountError(409, ApiErrorCode.FORBIDDEN, 'لا يمكن إضافة سطر إلى جلسة جرد غير مفتوحة', {
      count_id: countId,
      status: count.status,
    });
  }

  // 3) الدفعة يجب أن تنتمي لنفس عيادة العد — لا يُسمح بخلط عيادات في جرد واحد
  if (batchClinicId !== countClinicId) {
    throw new StockCountError(404, ApiErrorCode.VALIDATION_ERROR, 'الدفعة المطلوبة غير موجودة', {
      count_id: countId,
      batch_id: input.batch_id,
    });
  }

  // 4) لا سطر مكرر لنفس (العد، الدفعة). الفحص الصريح يعطي رداً سريعاً وواضحاً،
  //    والـ UNIQUE في قاعدة البيانات هو الضمان الأخير — السباق المتزامن يُحسم هناك.
  const existing = await client.query(
    'SELECT count_line_id FROM stock_count_lines WHERE count_id = $1 AND batch_id = $2',
    [countId, input.batch_id],
  );
  if (existing.rows.length > 0) {
    throw new StockCountError(
      409,
      ApiErrorCode.FORBIDDEN,
      'هذه الدفعة مسجّلة بالفعل في هذه جلسة الجرد',
      { count_id: countId, batch_id: input.batch_id },
    );
  }

  // 5) اللقطة تُحسب مرة واحدة على الخادم من الصف المقفول، وتُجمَّد.
  //    الفارق = counted - system، بحساب رقمي دقيق لا بنقطة عائمة.
  //    لا يُعاد حساب الفارق لاحقاً من كمية المخزون الحالية.
  const systemQuantity = roundCountQuantity(Number(batch.quantity_on_hand));
  const variance = roundCountQuantity(input.counted_quantity - systemQuantity);

  const inserted = await client.query(
    `INSERT INTO stock_count_lines
       (count_id, batch_id, medication_id, system_quantity, counted_quantity, variance)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING count_line_id, count_id, batch_id, medication_id,
               system_quantity, counted_quantity, variance,
               system_quantity_at_finalisation, adjusted_quantity, created_at`,
    [
      countId,
      input.batch_id,
      Number(batch.medication_id),
      systemQuantity,
      input.counted_quantity,
      variance,
    ],
  );

  return {
    ...inserted.rows[0],
    lot_number: batch.lot_number,
    expiry_date: batch.expiry_date,
    batch_is_active: batch.is_active,
    // الدفعة تُقرأ للمعلومة فقط: لا يُلمس رصيدها ولا حالتها
    current_quantity_on_hand: systemQuantity,
  };
};

/** تسجيل سطر عد واحد — عملية ذرّية واحدة على نفس PoolClient. */
export const addStockCountLine = async (req: AuthenticatedRequest, res: Response) => {
  const countId = parsePositiveId(req.params.id);
  if (countId === null) return validationError(res, 'معرّف جلسة الجرد غير صالح');

  const body = (req.body ?? {}) as Record<string, unknown>;

  // كل قيم السطر المُشتقّة مرفوضة صراحةً — 400 قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_STOCK_COUNT_LINE_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب تسجيل سطر الجرد — هذه القيم تُشتق من الخادم`);
  }

  const parsed = stockCountLineCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات تسجيل سطر الجرد غير صالحة');

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const line = await runAddStockCountLine(client, req, countId, parsed.data);
    await client.query('COMMIT');
    return res.status(201).json({
      message: 'تم تسجيل سطر الجرد بنجاح',
      line,
    });
  } catch (error: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — يُتجاهل لأن العملية فشلت أصلاً
      }
    }
    if (error instanceof StockCountError) {
      return res.status(error.status).json(error.payload);
    }
    // uq_scl_count_batch: سباق متزامن على نفس (العد، الدفعة) يُحسم في القاعدة
    if (error?.code === '23505') {
      return res.status(409).json({
        message: 'هذه الدفعة مسجّلة بالفعل في هذه جلسة الجرد',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    if (error?.code === '23503') return validationError(res, 'العد أو الدفعة أو الدواء المحدد غير موجود');
    if (error?.code === '23514') {
      return res.status(409).json({
        message: 'سطر الجرد يخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Add Stock Count Line Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تسجيل سطر الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};

/* ==========================================================================
 * 3. إنهاء جلسة جرد (POST /api/stock-counts/:id/finalise) — Phase 10D.7
 *
 * عملية واحدة داخل معاملة واحدة على نفس PoolClient:
 *   BEGIN
 *   -> قفل سجل العد FOR UPDATE والتحقق: موجود، محصور بالعيادات، ما زال OPEN
 *   -> تحميل بنود العد
 *   -> رفض عدّ فارغ (لا يوجد ما يُنهى)
 *   -> قفل كل الدفعات المشار إليها بترتيب batch_id تصاعدي حتمي
 *   -> إعادة قراءة كمية كل دفعة تحت تلك الأقفال
 *   -> الفارق النهائي لكل سطر = counted_quantity - الكمية الحيّة
 *   -> لكل فارق غير صفر: رأس stock_adjustments + تحديث الدفعة بحارس + حركة مخزون
 *   -> تحديث البنود: system_quantity_at_finalisation و adjusted_quantity فقط
 *   -> إغلاق العد: status + finalised_at + finalised_by_user_id
 *   -> سجل تدقيق واحد
 *   COMMIT
 *
 * ثلاث قواعد لا تُخترق:
 *   1) الفارق النهائي يُحسب من الكمية الحيّة المقفولة، لا من variance القديم.
 *      العد قد يكون مفتوحاً أياماً، وخلالها يتحرك المخزون؛ التسوية تصحّح الحالة
 *      الراهنة، لا ما كانت عليه لحظة التسجيل.
 *   2) الأدلة الأصلية لا تُلمس: system_quantity و counted_quantity و variance
  *      تبقى كما سُجّلت. ولا يُكتب إلا ما صُحِّح فعلاً.
 *   3) quantity_reserved لا يُكتب أبداً. النقصان يُرفض إذا ما كان عدده النهائي
 *      ينزل تحت المحجوز.
 * ========================================================================== */

interface FinalisationLine {
  count_line_id: number;
  batch_id: number;
  medication_id: number;
  system_quantity: number;
  counted_quantity: number;
  variance: number;
}

interface LockedFinalisationBatch {
  batch_id: number;
  inventory_id: number;
  quantity_on_hand: number;
  quantity_reserved: number;
}

/** ينفّذ الإنهاء داخل معاملة قائمة — يرمي StockCountError عند أي رفض. */
const runStockCountFinalisation = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  countId: number,
  finalisedByUserId: number,
): Promise<Record<string, unknown>> => {
  // 1) قفل العد. هو القفل الذي يجعل كل ما بعده متسقاً: لا يمكن لسطر جديد أن
  //    يُضاف (مسار 10D.6 يقفل نفس الصف) ما دمنا نحمله.
  const countScope = buildClinicScope(req, [countId], 'sc.clinic_id');
  const counted = await client.query(
    `SELECT sc.count_id, sc.clinic_id, sc.status, sc.counted_by_user_id,
            sc.finalised_at, sc.finalised_by_user_id
     FROM stock_counts sc
     WHERE sc.count_id = $1${countScope.clause}
     FOR UPDATE OF sc`,
    countScope.params,
  );
  // الغائب والخارج عن النطاق: نفس 404 تماماً — لا يُكشف وجوده
  if (counted.rows.length === 0) {
    throw new StockCountError(404, ApiErrorCode.VALIDATION_ERROR, 'جلسة الجرد المطلوبة غير موجودة');
  }
  const count = counted.rows[0];
  // العيادة من سجل العد نفسه، لا من العميل
  const clinicId = Number(count.clinic_id);
  if (String(count.status) !== 'OPEN') {
    throw new StockCountError(409, ApiErrorCode.FORBIDDEN, 'جلسة الجرد ليست مفتوحة — لا يمكن إنهاؤها', {
      count_id: countId,
      status: count.status,
    });
  }

  // 2) بنود العد. البنود لا تُعدَّل ولا تُحذف، وقفل العد يمنع إضافتها الآن.
  const linesResult = await client.query(
    `SELECT count_line_id, batch_id, medication_id, system_quantity, counted_quantity, variance
     FROM stock_count_lines
     WHERE count_id = $1
     ORDER BY count_line_id ASC`,
    [countId],
  );
  const lines: FinalisationLine[] = linesResult.rows.map((row) => ({
    count_line_id: Number(row.count_line_id),
    batch_id: Number(row.batch_id),
    medication_id: Number(row.medication_id),
    system_quantity: Number(row.system_quantity),
    counted_quantity: Number(row.counted_quantity),
    variance: Number(row.variance),
  }));
  // عدّ بلا سطور لا يمكن إنهاؤه: لا دليل على أي تصحيح
  if (lines.length === 0) {
    throw new StockCountError(409, ApiErrorCode.FORBIDDEN, 'لا يمكن إنهاء جلسة جرد بلا سطور مسجّلة', {
      count_id: countId,
    });
  }

  // 3) قفل الدفعات بترتيب batch_id تصاعدي — ترتيب حتمي مستقل عن ترتيب الطلب،
  //    فلا يمكن أن يتشابك إنهاءان متقاطعان. لا SKIP LOCKED: من ينتظر يُحسم، ومن
  //    يتجاوزه لا يُعدّ آخر من تَمّ.
  const batchIds = [...new Set(lines.map((line) => line.batch_id))].sort((a, b) => a - b);
  const batchScope = buildClinicScope(req, [batchIds], 'i.clinic_id');
  const batchesResult = await client.query(
    `SELECT b.batch_id, b.inventory_id, b.quantity_on_hand, b.quantity_reserved, i.clinic_id
     FROM inventory_batches b
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     WHERE b.batch_id = ANY($1::int[])${batchScope.clause}
     ORDER BY b.batch_id ASC
     FOR UPDATE OF b`,
    batchScope.params,
  );
  // RESTRICT يمنع حذف دفعة مُشار إليها، لذا أي نقص هنا يعني خللاً لا يمكن إكماله
  if (batchesResult.rows.length !== batchIds.length) {
    throw new StockCountError(409, ApiErrorCode.FORBIDDEN, 'إحدى دفعات هذا العد لم تعد متاحة', {
      count_id: countId,
      expected_batches: batchIds.length,
      found_batches: batchesResult.rows.length,
    });
  }
  const batches = new Map<number, LockedFinalisationBatch>(
    batchesResult.rows.map((row) => [
      Number(row.batch_id),
      {
        batch_id: Number(row.batch_id),
        inventory_id: Number(row.inventory_id),
        // الكمية الحيّة كما قُرئت تحت القفل — مصدر التسوية الوحيد
        quantity_on_hand: Number(row.quantity_on_hand),
        quantity_reserved: Number(row.quantity_reserved),
      },
    ]),
  );

  // 4) الحساب والتطبيق، سطراً سطراً.
  const adjustments: Record<string, unknown>[] = [];
  const movements: Record<string, unknown>[] = [];
  const appliedLines: Record<string, unknown>[] = [];
  let totalIncreaseQuantity = 0;
  let totalDecreaseQuantity = 0;

  for (const line of lines) {
    const batch = batches.get(line.batch_id)!;
    // 4a) الفارق النهائي من الكمية الحيّة، لا من variance المُسجَّل
    const currentQuantity = roundCountQuantity(batch.quantity_on_hand);
    const finalVariance = roundCountQuantity(line.counted_quantity - currentQuantity);
    const magnitude = roundCountQuantity(Math.abs(finalVariance));

    if (finalVariance !== 0) {
      const kind = finalVariance > 0 ? 'POSITIVE' : 'NEGATIVE';
      const { direction, movement_type: movementType } = FINAL_VARIANCE_ADJUSTMENT[kind];

      // النقصان لا يجوز أن يمسّ المحجوز: الكمية النهائية يجب أن تغطيه
      if (finalVariance < 0 && line.counted_quantity < batch.quantity_reserved) {
        throw new StockCountError(
          409,
          ApiErrorCode.FORBIDDEN,
          'تصحيح الجرد ينزل تحت الكمية المحجوزة في الدفعة',
          {
            count_id: countId,
            batch_id: line.batch_id,
            counted_quantity: line.counted_quantity,
            quantity_reserved: batch.quantity_reserved,
          },
        );
      }

      // 4b) رأس التسوية على جدول 10D.2 نفسه — بلا جدول جديد وبلا دلالة جديدة
      const adjustment = await client.query(
        `INSERT INTO stock_adjustments
           (clinic_id, batch_id, inventory_id, medication_id, direction, quantity,
            quantity_before, quantity_after, reason, notes, performed_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING adjustment_id, batch_id, medication_id, direction, quantity,
                   quantity_before, quantity_after, reason, performed_by_user_id, created_at`,
        [
          clinicId,
          line.batch_id,
          batch.inventory_id,
          line.medication_id,
          direction,
          magnitude,
          currentQuantity,
          line.counted_quantity,
          STOCK_COUNT_FINALISATION_REASON,
          `جرد فعلي — إنهاء جلسة الجرد رقم ${countId}`,
          finalisedByUserId,
        ],
      );
      adjustments.push(adjustment.rows[0]);

      // 4c) تحديث الرصيد بحارس: نفس الدفعة، نفس الصنف، نفس العيادة، نفس الكمية
      //     المقروءة تحت القفل، وعدم كسر quantity_reserved <= quantity_on_hand
      const updateScope = buildClinicScope(
        req,
        [line.counted_quantity, line.batch_id, currentQuantity, batch.inventory_id, clinicId],
        'i.clinic_id',
      );
      const updated = await client.query(
        `UPDATE inventory_batches b
         SET quantity_on_hand = $1, updated_at = NOW()
         FROM inventory_items i
         WHERE b.inventory_id = i.inventory_id
           AND b.batch_id = $2
           AND i.inventory_id = $4
           AND i.clinic_id = $5
           AND b.quantity_on_hand = $3
           AND b.quantity_on_hand >= 0
           AND $1 <= ${MAX_COUNT_QUANTITY}
           AND $1 >= b.quantity_reserved${updateScope.clause}
         RETURNING b.batch_id, b.quantity_on_hand, b.quantity_reserved`,
        updateScope.params,
      );
      if (updated.rowCount !== 1) {
        throw new StockCountError(
          409,
          ApiErrorCode.FORBIDDEN,
          'تغيّر رصيد الدفعة أثناء إنهاء الجرد — أعد المحاولة',
          { count_id: countId, batch_id: line.batch_id },
        );
      }
      // المخزون الحيّ يتقدّم، حتى لو صادف أن عاد لنفس القيمة في سطر آخر
      batch.quantity_on_hand = line.counted_quantity;

      // 4d) حركة المخزون — كمية موجبة دائماً، والمرجع هو جلسة العد
      const movement = await client.query(
        `INSERT INTO stock_movements
           (batch_id, movement_type, quantity, reference_type, reference_id, performed_by_user_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING movement_id, batch_id, movement_type, quantity, reference_type, reference_id,
                   performed_by_user_id, created_at`,
        [
          line.batch_id,
          movementType,
          magnitude,
          STOCK_COUNT_REFERENCE_TYPE,
          String(countId),
          finalisedByUserId,
          `جرد فعلي — إنهاء جلسة الجرد رقم ${countId}`,
        ],
      );
      movements.push(movement.rows[0]);

      if (finalVariance > 0) totalIncreaseQuantity = roundCountQuantity(totalIncreaseQuantity + magnitude);
      else totalDecreaseQuantity = roundCountQuantity(totalDecreaseQuantity + magnitude);
    }

    // 4e) السطر يُحدَّث بالتصحيح الفعلي فقط — الأدلة الأصلية تبقى كما هي
    const lineUpdate = await client.query(
      `UPDATE stock_count_lines
       SET system_quantity_at_finalisation = $1, adjusted_quantity = $2
       WHERE count_line_id = $3 AND count_id = $4
       RETURNING count_line_id, batch_id, medication_id,
                 system_quantity, counted_quantity, variance,
                 system_quantity_at_finalisation, adjusted_quantity`,
      [currentQuantity, magnitude, line.count_line_id, countId],
    );
    if (lineUpdate.rowCount !== 1) {
      throw new StockCountError(409, ApiErrorCode.FORBIDDEN, 'تعذّر تحديث سطر الجرد', {
        count_id: countId,
        count_line_id: line.count_line_id,
      });
    }
    const stored = lineUpdate.rows[0];
    appliedLines.push({
      count_line_id: stored.count_line_id,
      batch_id: stored.batch_id,
      medication_id: stored.medication_id,
      system_quantity: Number(stored.system_quantity),
      counted_quantity: Number(stored.counted_quantity),
      variance_at_count: Number(stored.variance),
      system_quantity_at_finalisation: Number(stored.system_quantity_at_finalisation),
      adjusted_quantity: Number(stored.adjusted_quantity),
      movement_type: finalVariance > 0 ? 'ADJUSTMENT' : finalVariance < 0 ? 'ADJUSTMENT_DECREASE' : null,
    });
  }

  // 5) إغلاق العد — الحالة والوقت والمنفّذ من الخادم
  const header = await client.query(
    `UPDATE stock_counts
     SET status = 'FINALISED', finalised_at = NOW(), finalised_by_user_id = $1
     WHERE count_id = $2 AND status = 'OPEN'
     RETURNING count_id, clinic_id, status, counted_by_user_id, finalised_by_user_id,
               created_at, finalised_at`,
    [finalisedByUserId, countId],
  );
  if (header.rowCount !== 1) {
    throw new StockCountError(409, ApiErrorCode.FORBIDDEN, 'سبق إنهاء هذه الجلسة — لم يُطبَّق أي تصحيح', {
      count_id: countId,
    });
  }

  // 6) سجل تدقيق واحد، بعد كل الكتابات على المخزون، داخل نفس المعاملة:
  //    فشله يُسقط التسويات والحركات والبنود والإغلاق كاملة.
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'STOCK_COUNT_FINALISED', 'STOCK_COUNT', $3, $4)`,
    [
      finalisedByUserId,
      clinicId,
      String(countId),
      JSON.stringify({
        count_id: countId,
        clinic_id: clinicId,
        counted_by_user_id: Number(count.counted_by_user_id),
        finalised_by_user_id: finalisedByUserId,
        line_count: appliedLines.length,
        total_increase_quantity: totalIncreaseQuantity,
        total_decrease_quantity: totalDecreaseQuantity,
        lines: appliedLines,
      }),
    ],
  );

  return {
    count: header.rows[0],
    line_count: appliedLines.length,
    total_increase_quantity: totalIncreaseQuantity,
    total_decrease_quantity: totalDecreaseQuantity,
    lines: appliedLines,
    adjustments,
    movements,
  };
};

/** إنهاء جلسة جرد — عملية ذرّية واحدة على نفس PoolClient. */
export const finaliseStockCount = async (req: AuthenticatedRequest, res: Response) => {
  const countId = parsePositiveId(req.params.id);
  if (countId === null) return validationError(res, 'معرّف جلسة الجرد غير صالح');

  const body = (req.body ?? {}) as Record<string, unknown>;

  // حارس صريح قبل أي وصول لقاعدة البيانات: كل قيم الإنهاء مُشتقّة
  const forbiddenField = FORBIDDEN_STOCK_COUNT_FINALISE_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب إنهاء الجرد — هذه القيم تُشتق من الخادم`);
  }

  // ولا حقل أعمال واحد: أي حقل غير متوقع يُرفض هنا
  const parsed = stockCountFinaliseSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'طلب إنهاء الجرد لا يقبل أي حقول');

  // المنفّذ من المستخدم الموثّق دائماً
  const finalisedByUserId = req.user?.userId ?? null;
  if (finalisedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لإنهاء جلسة الجرد');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await runStockCountFinalisation(client, req, countId, finalisedByUserId);
    await client.query('COMMIT');
    return res.status(200).json({
      message: 'تم إنهاء جلسة الجرد وتطبيق التصحيحات',
      ...result,
    });
  } catch (error: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // الاتصال قد يكون منهاراً — يُتجاهل لأن العملية فشلت أصلاً
      }
    }
    if (error instanceof StockCountError) {
      return res.status(error.status).json(error.payload);
    }
    if (error?.code === '23503') return validationError(res, 'أحد المراجع المرتبطة غير موجود');
    if (error?.code === '23514') {
      return res.status(409).json({
        message: 'إنهاء الجرد يخالف قيداً معرّفاً في قاعدة بيانات المخزون',
        code: ApiErrorCode.FORBIDDEN,
      });
    }
    console.error('Finalise Stock Count Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إنهاء جلسة الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client?.release();
  }
};

/* ==========================================================================
 * 5. قائمة جلسات الجرد (GET /api/stock-counts) — Phase 10D.8
 *
 * قراءة فقط بالكامل: لا معاملات، لا FOR UPDATE، لا RETURNING، ولا أي كتابة.
 * الاستعلامان (الرأس + البنود) لكل طلب تفصيلي، والاسمان يُجلبان بانضمام واحد
 * لكل جهة — لا استعلام لكل سطر.
 * ========================================================================== */

const buildListFilters = (query: StockCountListQuery): { clause: string; params: unknown[] } => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.status !== undefined) {
    params.push(query.status);
    conditions.push(`sc.status = $${params.length}`);
  }
  return { clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
};

export const listStockCounts = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = stockCountListQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تصفية جلسات الجرد غير صالحة');
  const query = parsed.data;

  const limit = query.limit ?? DEFAULT_STOCK_COUNT_LIMIT;
  const offset = query.offset ?? 0;
  const filters = buildListFilters(query);

  try {
    const scope = buildClinicScope(req, filters.params, 'sc.clinic_id');
    const next = scope.params.length + 1;
    // approved_by_user_id يُقرأ هنا كحقل عرض فقط (انضمام واحد) ولا يُكتب أبداً
    // في أي مسار.
    const result = await pool.query(
      `SELECT sc.count_id, sc.clinic_id, sc.status, sc.notes, sc.created_at, sc.finalised_at,
              sc.counted_by_user_id, sc.approved_by_user_id, sc.finalised_by_user_id,
              ${COUNTED_BY_NAME}, ${APPROVED_BY_NAME}, ${FINALISED_BY_NAME},
              (SELECT COUNT(*)::int FROM stock_count_lines scl WHERE scl.count_id = sc.count_id) AS line_count
       FROM stock_counts sc
       JOIN users cu ON cu.user_id = sc.counted_by_user_id
       LEFT JOIN users au ON au.user_id = sc.approved_by_user_id
       LEFT JOIN users fu ON fu.user_id = sc.finalised_by_user_id
       WHERE 1=1${filters.clause}${scope.clause}
       ORDER BY sc.created_at DESC, sc.count_id DESC
       LIMIT $${next} OFFSET $${next + 1}`,
      [...scope.params, limit, offset],
    );

    return res.status(200).json({
      counts: result.rows,
      pagination: { limit, offset, returned: result.rows.length },
    });
  } catch (error) {
    console.error('List Stock Counts Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب جلسات الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/* ==========================================================================
 * 6. تفاصيل جلسة جرد (GET /api/stock-counts/:id) — Phase 10D.8
 * ========================================================================== */
export const getStockCount = async (req: AuthenticatedRequest, res: Response) => {
  const countId = parsePositiveId(req.params.id);
  if (countId === null) return validationError(res, 'معرّف جلسة الجرد غير صالح');

  try {
    const scope = buildClinicScope(req, [countId], 'sc.clinic_id');
    const header = await pool.query(
      `SELECT sc.count_id, sc.clinic_id, sc.status, sc.notes, sc.created_at, sc.finalised_at,
              sc.counted_by_user_id, sc.approved_by_user_id, sc.finalised_by_user_id,
              ${COUNTED_BY_NAME}, ${APPROVED_BY_NAME}, ${FINALISED_BY_NAME}, c.clinic_name
       FROM stock_counts sc
       JOIN users cu ON cu.user_id = sc.counted_by_user_id
       LEFT JOIN users au ON au.user_id = sc.approved_by_user_id
       LEFT JOIN users fu ON fu.user_id = sc.finalised_by_user_id
       JOIN clinics c ON c.clinic_id = sc.clinic_id
       WHERE sc.count_id = $1${scope.clause}`,
      scope.params,
    );
    if (header.rows.length === 0) return countNotFound(res);

    // البنود في استعلام واحد بلا N+1: دواء واحد وانضمام دفعة واحدة يجلبان الهوية
    // لكل البنود معاً.
    //
    // كل رقم هنا مخزَّن تاريخياً: system_quantity لقطة لحظة التسجيل،
    // counted_quantity العد الفعلي، variance فارقُ وقت العد (لا يُعاد حسابه من
    // رصيد الدفعة الحالي)، و system_quantity_at_finalisation / adjusted_quantity
    // لقطتا الإنهاء. لا شيء في هذا الاستعلام يُشتق من الكمية الحيّة، لأن سطر
    // العد دليل على لحظة في الزمن، وإعادته ليست دليلاً.
    const lines = await pool.query(
      `SELECT scl.count_line_id, scl.batch_id, scl.medication_id,
              scl.system_quantity, scl.counted_quantity, scl.variance,
              scl.system_quantity_at_finalisation, scl.adjusted_quantity, scl.created_at,
              m.trade_name, m.scientific_name, m.strength, m.dosage_form,
              b.lot_number, b.expiry_date
       FROM stock_count_lines scl
       JOIN medications m ON m.medication_id = scl.medication_id
       LEFT JOIN inventory_batches b ON b.batch_id = scl.batch_id
       WHERE scl.count_id = $1
       ORDER BY scl.count_line_id ASC`,
      [countId],
    );

    return res.status(200).json({
      count: {
        ...header.rows[0],
        line_count: lines.rows.length,
        lines: lines.rows.map((row) => ({
          count_line_id: row.count_line_id,
          batch_id: row.batch_id,
          medication_id: row.medication_id,
          medication: {
            trade_name: row.trade_name,
            scientific_name: row.scientific_name,
            strength: row.strength,
            dosage_form: row.dosage_form,
          },
          system_quantity: row.system_quantity,
          counted_quantity: row.counted_quantity,
          variance: row.variance,
          system_quantity_at_finalisation: row.system_quantity_at_finalisation,
          adjusted_quantity: row.adjusted_quantity,
          // هوية الدفعة للعرض فقط: رقم التشغيلة وتاريخ الصلاحية
          lot_number: row.lot_number,
          expiry_date: row.expiry_date,
          created_at: row.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('Get Stock Count Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب تفاصيل جلسة الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/* ==========================================================================
 * 7. سجل تدقيق جلسة الجرد (GET /api/stock-counts/:id/audit) — Phase 10D.8
 *
 * قراءة فقط. لا يكتب أي سجل: القراءة لا تُحدِث شيئاً، ولا يوجد مسار يسجّل
 * "شُوهد".
 *
 * يُتبع هنا نفس النمط الموجود في سجلات الإرجاع (10D.4): صلاحية سجلات
 * النظام تبقى canAccessLogs بالضبط، والنطاق يمر عبر سجل العد نفسه — فلا
 * يُكشف وجود عدّ خارج نطاق المستخدم.
 *
 * الحدثان المتوقعان لجلسة واحدة هما STOCK_COUNT_OPENED (10D.6) و
 * STOCK_COUNT_FINALISED (10D.7)، وكلاهما resource_type = 'STOCK_COUNT'. أي
 * سجل آخر — سواء لأنواع موارد أخرى أو لجلسات أخرى — لا يمكن أن يصل إلى هنا.
 * ========================================================================== */
export const getStockCountAudit = async (req: AuthenticatedRequest, res: Response) => {
  const countId = parsePositiveId(req.params.id);
  if (countId === null) return validationError(res, 'معرّف جلسة الجرد غير صالح');

  // سجلات النظام مقصورة عمداً — القاعدة نفسها المستخدمة في وحدة التدقيق
  if (!canAccessLogs(req)) {
    return res.status(403).json({ message: 'غير مصرّح', code: ApiErrorCode.FORBIDDEN });
  }

  try {
    // النطاق عبر سجل العد نفسه: غير موجود أو خارج النطاق => نفس 404
    const scopeCheck = buildClinicScope(req, [countId], 'sc.clinic_id');
    const scoped = await pool.query(
      `SELECT sc.count_id FROM stock_counts sc WHERE sc.count_id = $1${scopeCheck.clause}`,
      scopeCheck.params,
    );
    if (scoped.rows.length === 0) return countNotFound(res);

    const scope = buildClinicScope(req, [String(countId)], 'sc.clinic_id');
    const result = await pool.query(
      `SELECT a.audit_id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at,
              a.clinic_id, u.full_name AS user_name
       FROM audit_logs a
       JOIN stock_counts sc ON sc.count_id = a.resource_id::int
       LEFT JOIN users u ON u.user_id = a.user_id
       WHERE a.resource_type = 'STOCK_COUNT'
         AND a.resource_id = $1${scope.clause}
       ORDER BY a.created_at ASC, a.audit_id ASC`,
      scope.params,
    );

    return res.status(200).json({
      count_id: countId,
      audit_logs: result.rows,
      returned: result.rows.length,
    });
  } catch (error) {
    console.error('Get Stock Count Audit Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب سجل تدقيق جلسة الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/* ==========================================================================
 * 8. تقرير مطابقة الجرد بالمخزون الحيّ (GET /api/stock-counts/reconciliation)
 *    — Phase 10D.9
 *
 * تقرير قراءة فقط. لا معاملة، ولا FOR UPDATE، ولا RETURNING، ولا أي كتابة:
 * لا تعديل، ولا حركة، ولا تبنيد، ولا إرجاع، ولا عزل، ولا سجل تدقيق لمجرد
 * الاطلاع. المطابقة عملية تحقّق من دليل، وليست عملية مخزون.
 *
 * الأرقام الأربعة لكل سطر مختلفة تماماً، ولا تُدمج ولا يُعاد تفسير أي منها:
 *   counted_quantity                 — ما عدّه الإنسان فعلاً (دليل مجمّد)
 *   system_quantity_at_finalisation  — لقطة الكمية الحيّة قبل تصحيح الإنهاء
 *   adjusted_quantity                — مقدار التصحيح المطلق عند الإنهاء
 *   current_quantity_on_hand         — الكمية الحيّة الآن في الدفعة
 *
 * الفرق المُشتق (reconciliation_difference) هو current - counted، ويُحسب في
 * SQL لا في JavaScript: العمودان NUMERIC(12,3) فيجب أن يبقى الفرق حساباً
 * عشرياً مطابقاً تماماً، لا فرقاً عشوائي الفواصل. وهو ليس variance القديم ولا
 * بديل عنه — variance مجمّد لحظة التسجيل، وهذا فرقٌ على الحالة الحيّة اليوم.
 *
 * لا يُستبعد أي دفعة بسبب انتهاء صلاحيتها أو تعطيلها أو عزلها أو صفر
 * مخزونها: هذا تقرير دليل، وليس اختيار FEFO، وقواعد الأهلية ليست له.
 *
 * النطاق: عيادة جلسة العد نفسها (stock_counts.clinic_id) — العلاقة المرجعية.
 * 10D.6 يفرض عند تسجيل كل سطر أن عيادة الدفعة تساوي عيادة العد، فالنطاق عبر
 * رأس العد يغطي البنود جميعاً دون انضمام إضافي.
 * ========================================================================== */

/** يحسب الفارق في SQL: quantity_on_hand - counted_quantity، أو NULL إن غابت الدفعة. */
const RECONCILIATION_DIFFERENCE = 'b.quantity_on_hand - scl.counted_quantity AS reconciliation_difference';

export const getStockCountReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = stockCountReconciliationQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تقرير مطابقة الجرد غير صالحة');
  const { count_id: countId, inventory_id: inventoryId, batch_id: batchId, limit, offset } = parsed.data;

  const limitValue = limit ?? DEFAULT_STOCK_COUNT_LIMIT;
  const offsetValue = offset ?? 0;

  try {
    // 1) اختيار جلسة الجرد المرجعية.
    //    - مع count_id: تلك الجلسة بالضبط، شريطة أن تكون FINALISED؛ عداد غير
    //      منتهٍ أو غائب أو خارج النطاق => نفس 404 تماماً (لا تسريب للوجود).
    //    - بدونه: أحدث جلسة FINALISED ضمن نطاق المستخدم، ولا شيء غير ذلك —
    //      لا يُختار عد OPEN ولا CANCELLED أبداً.
    const resolver = buildClinicScope(req, countId === undefined ? [] : [countId], 'sc.clinic_id');
    const target = await pool.query(
      `SELECT sc.count_id, sc.created_at, sc.finalised_at
       FROM stock_counts sc
       WHERE ${countId === undefined ? "sc.status = 'FINALISED'" : 'sc.count_id = $1'}
         AND sc.status = 'FINALISED'${resolver.clause}
       ORDER BY sc.created_at DESC, sc.count_id DESC
       LIMIT 1`,
      resolver.params,
    );

    if (target.rows.length === 0) {
      // طلب صريح لعدّ غير موجود/خارج النطاق/غير منتهٍ = 404 كأي عدّ آخر.
      if (countId !== undefined) return countNotFound(res);
      // لا يوجد عدّ منتهٍ واحد في النطاق: نتيجة فارغة، لا إنشاء ولا تعديل.
      return res.status(200).json({
        count_id: null,
        count_created_at: null,
        finalised_at: null,
        rows: [],
        pagination: { limit: limitValue, offset: offsetValue, returned: 0 },
      });
    }

    const header = target.rows[0];
    const resolvedCountId = Number(header.count_id);

    // 2) سطور التقرير: استعلام واحد قائم على مجموعة، بلا N+1. هوية الدواء
    //    والدفعة وحالة العزل كلها تأتي بانضمام واحد لكل جهة، والكمية الحيّة تُقرأ
    //    من inventory_batches في نفس اللحظة — لا من أي لقطة تاريخية.
    const params: unknown[] = [resolvedCountId];
    const filters: string[] = [];
    if (inventoryId !== undefined) {
      params.push(inventoryId);
      filters.push(` AND b.inventory_id = $${params.length}`);
    }
    if (batchId !== undefined) {
      params.push(batchId);
      filters.push(` AND scl.batch_id = $${params.length}`);
    }
    params.push(limitValue, offsetValue);

    const result = await pool.query(
      `SELECT scl.count_line_id, sc.count_id, sc.created_at AS count_created_at, sc.finalised_at,
              b.inventory_id, scl.batch_id, scl.medication_id,
              m.trade_name, m.scientific_name, m.strength, m.dosage_form,
              b.lot_number, b.expiry_date,
              scl.counted_quantity, scl.system_quantity_at_finalisation, scl.adjusted_quantity,
              b.quantity_on_hand AS current_quantity_on_hand,
              ${RECONCILIATION_DIFFERENCE},
              b.quantity_reserved, b.is_active AS batch_is_active,
              (q.quarantine_id IS NOT NULL) AS is_quarantined
       FROM stock_count_lines scl
       JOIN stock_counts sc ON sc.count_id = scl.count_id
       JOIN medications m ON m.medication_id = scl.medication_id
       LEFT JOIN inventory_batches b ON b.batch_id = scl.batch_id
       LEFT JOIN batch_quarantines q ON q.batch_id = scl.batch_id AND q.released_at IS NULL
       WHERE scl.count_id = $1${filters.join('')}
       ORDER BY scl.count_line_id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return res.status(200).json({
      count_id: resolvedCountId,
      count_created_at: header.created_at,
      finalised_at: header.finalised_at,
      rows: result.rows.map((row) => ({
        count_line_id: Number(row.count_line_id),
        count_id: resolvedCountId,
        count_created_at: row.count_created_at,
        finalised_at: row.finalised_at,
        inventory_id: row.inventory_id === null || row.inventory_id === undefined ? null : Number(row.inventory_id),
        batch_id: Number(row.batch_id),
        medication_id: Number(row.medication_id),
        medication: {
          trade_name: row.trade_name,
          scientific_name: row.scientific_name,
          strength: row.strength,
          dosage_form: row.dosage_form,
        },
        lot_number: row.lot_number ?? null,
        expiry_date: row.expiry_date ?? null,
        // الدليل التاريخي — يُقرأ كما هو ولا يُعاد حسابه ولا يُفترض عليه
        counted_quantity: row.counted_quantity,
        system_quantity_at_finalisation: row.system_quantity_at_finalisation,
        adjusted_quantity: row.adjusted_quantity,
        // الحالة الحيّة الآن: NULL إن لم تعد الدفعة قابلة للوصول، ولا يُختلق لها رقم
        current_quantity_on_hand: row.current_quantity_on_hand ?? null,
        reconciliation_difference: row.reconciliation_difference ?? null,
        quantity_reserved: row.quantity_reserved ?? null,
        // حالة الدفعة للقراءة فقط — لا تُستخدم كقاعدة أهلية
        batch_is_active: row.batch_is_active ?? null,
        is_quarantined: row.is_quarantined === true,
      })),
      pagination: { limit: limitValue, offset: offsetValue, returned: result.rows.length },
    });
  } catch (error) {
    console.error('Get Stock Count Reconciliation Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب تقرير مطابقة الجرد',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};
