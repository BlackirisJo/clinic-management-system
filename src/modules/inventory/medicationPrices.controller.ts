import { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  medicationPriceCreateSchema,
  medicationPriceUpdateSchema,
  medicationPriceQuerySchema,
  FORBIDDEN_MEDICATION_PRICE_FIELDS,
  type MedicationPriceQueryInput,
} from '../../validations/medicationPrice.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10E.2 — Medication selling-price backend
 *
 * أول سعر بيع في النظام. clinic_services.price لا يُستخدم هنا: ذاك سعر خدمات
 * العيادة، ولا رابط بينه وبين الأدوية، ونسب الطبيب فيه لا تنطبق على دواء.
 *
 * نطاق العيادة: السعر مشتق من صنف المخزون (inventory_items.clinic_id) على
 * الخادم، ولا مقبول أن يحدده العميل. isClinicAccessible عبر clinicScope
 * يمنع أي سعر لعيادة خارج نطاق المستخدم.
 *
 * نموذج التاريخ — إلحاق فقط، لا تعديل مبلغ قائم:
 *   PUT    : إنهاء صلاحية السعر الحالي + إدراج سعر جديد، في معاملة واحدة
 *   DELETE : إنهاء صلاحية فقط، بلا صف جديد وبلا حذف فيزيائي
 * فلا يمكن أبداً إعادة كتابة سعر حُسِب به سابقاً.
 *
 * هذه المرحلة لا تُصدر فاتورة ولا بند فاتورة ولا دفعة، ولا تكتب أي جدول صرف
 * أو حركة مخزون. الفوترة هي Phase 10E.3.
 * ========================================================================== */

/** خطأ نطاقي/منطقي داخل المعاملة — يؤدي دائماً إلى ROLLBACK ثم استجابة. */
class MedicationPriceError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = { message, code, ...extra };
  }
}

const PRICE_COLUMNS = `mp.price_id, mp.clinic_id, mp.inventory_id, mp.unit_price, mp.is_active,
       mp.effective_from, mp.effective_to, mp.created_by_user_id, mp.created_at,
       i.uom, m.medication_id, m.trade_name, m.scientific_name, m.strength, m.dosage_form,
       c.clinic_name`;

const PRICE_FROM = `FROM medication_prices mp
     JOIN inventory_items i ON i.inventory_id = mp.inventory_id
     JOIN medications m ON m.medication_id = i.medication_id
     JOIN clinics c ON c.clinic_id = mp.clinic_id`;

const RETURNING_COLUMNS = `price_id, clinic_id, inventory_id, unit_price, is_active,
       effective_from, effective_to, created_by_user_id, created_at`;

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// موحّد: سعر غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده)
const priceNotFound = (res: Response) =>
  res.status(404).json({ message: 'سعر البيع المطلوب غير موجود' });

const duplicateActivePrice = (res: Response) =>
  res.status(409).json({
    message: 'يوجد سعر بيع نشط لهذا الصنف في نفس العيادة — أنهِ صلاحيته أولاً أو حدّث السعر',
    code: ApiErrorCode.FORBIDDEN,
  });

/** صنف مخزون حيّ ضمن عيادات المستخدم، مع عيادة الصنف نفسها (مصدر نطاق السعر) */
interface ScopedInventoryItem {
  inventoryId: number;
  clinicId: number;
}

/**
 * تحميل صنف المخزون المستهدف مع التحقق من النطاق. الصنف المؤرشف أو خارج نطاق
 * المستخدم = غير موجود، تماماً كغيره في وحدة المخزون.
 */
const loadScopedInventoryItem = async (
  req: AuthenticatedRequest,
  inventoryId: number,
  client: Pick<PoolClient, 'query'> | null = null,
): Promise<ScopedInventoryItem | null> => {
  const scope = buildClinicScope(req, [inventoryId], 'i.clinic_id');
  const runner = client ?? pool;
  const result = await runner.query(
    `SELECT i.inventory_id, i.clinic_id FROM inventory_items i
     WHERE i.inventory_id = $1 AND i.deleted_at IS NULL${scope.clause}`,
    scope.params,
  );
  if (result.rows.length === 0) return null;
  return {
    inventoryId: Number(result.rows[0].inventory_id),
    clinicId: Number(result.rows[0].clinic_id),
  };
};

/** السعر النشط الحالي للصنف، مقفلاً — أساس منع الازدواج عند التحديث */
const lockActivePrice = async (
  client: PoolClient,
  inventoryId: number,
): Promise<{ price_id: number; unit_price: string; effective_from: Date } | null> => {
  const result = await client.query(
    `SELECT price_id, unit_price, effective_from FROM medication_prices
     WHERE inventory_id = $1 AND is_active
     ORDER BY effective_from DESC, price_id DESC
     LIMIT 1
     FOR UPDATE`,
    [inventoryId],
  );
  return result.rows.length === 0 ? null : result.rows[0];
};

/** سجل تدقيق واحد لكل تغيير سعر — داخل نفس المعاملة كالتغيير نفسه */
const writePriceAudit = async (
  client: PoolClient,
  userId: number,
  clinicId: number,
  action: string,
  priceId: number,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, 'MEDICATION_PRICE', $4, $5)`,
    [userId, clinicId, action, String(priceId), JSON.stringify(metadata)],
  );
};

const respondWithError = (res: Response, error: unknown, logLabel: string): Response => {
  if (error instanceof MedicationPriceError) {
    return res.status(error.status).json(error.payload);
  }
  console.error(logLabel, error);
  return res.status(500).json({
    message: 'حدث خطأ في الخادم أثناء معالجة سعر بيع الدواء',
    code: ApiErrorCode.INTERNAL_ERROR,
  });
};

/* ==========================================================================
 * 1. قائمة الأسعار ضمن عيادات المستخدم
 * ========================================================================== */
export const listMedicationPrices = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = medicationPriceQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير استعلام أسعار البيع غير صالحة');
  const query: MedicationPriceQueryInput = parsed.data;

  let params: unknown[] = [];
  const clauses: string[] = [];

  if (query.clinic_id !== undefined) {
    params.push(query.clinic_id);
    clauses.push(` AND mp.clinic_id = $${params.length}`);
  }
  if (query.inventory_id !== undefined) {
    params.push(query.inventory_id);
    clauses.push(` AND mp.inventory_id = $${params.length}`);
  }
  if (query.is_active !== undefined) {
    params.push(query.is_active);
    clauses.push(` AND mp.is_active = $${params.length}`);
  }

  try {
    const scope = buildClinicScope(req, params, 'mp.clinic_id');
    const result = await pool.query(
      `SELECT ${PRICE_COLUMNS} ${PRICE_FROM}
       WHERE 1=1${clauses.join('')}${scope.clause}
       ORDER BY m.trade_name ASC, mp.inventory_id ASC,
                mp.effective_from DESC, mp.price_id DESC`,
      scope.params,
    );

    return res.status(200).json({ medicationPrices: result.rows });
  } catch (error) {
    console.error('List Medication Prices Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب أسعار بيع الأدوية',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/* ==========================================================================
 * 2. تفاصيل سعر واحد — خارج نطاق المستخدم = 404
 * ========================================================================== */
export const getMedicationPrice = async (req: AuthenticatedRequest, res: Response) => {
  const priceId = parsePositiveId(req.params.id);
  if (priceId === null) return validationError(res, 'معرّف سعر البيع غير صالح');

  try {
    const scope = buildClinicScope(req, [priceId], 'mp.clinic_id');
    const result = await pool.query(
      `SELECT ${PRICE_COLUMNS} ${PRICE_FROM} WHERE mp.price_id = $1${scope.clause}`,
      scope.params,
    );

    if (result.rows.length === 0) return priceNotFound(res);
    return res.status(200).json({ medicationPrice: result.rows[0] });
  } catch (error) {
    console.error('Get Medication Price Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب سعر بيع الدواء',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/* ==========================================================================
 * 3. إنشاء سعر بيع لصنف مخزون
 *    عيادة السعر مُشتقّة من صنف المخزون، لا من جسم الطلب.
 * ========================================================================== */
export const createMedicationPrice = async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // أي قيمة مشتقّة في الجسم خطأ صريح قبل أي وصول لقاعدة البيانات
  const forbiddenField = FORBIDDEN_MEDICATION_PRICE_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب سعر البيع — هذه القيم تُشتق من الخادم`);
  }

  const parsed = medicationPriceCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات إنشاء سعر البيع غير صالحة');

  const createdByUserId = req.user?.userId ?? null;
  if (createdByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لإنشاء سعر بيع');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const item = await loadScopedInventoryItem(req, parsed.data.inventory_id, client);
    if (item === null) {
      throw new MedicationPriceError(404, ApiErrorCode.VALIDATION_ERROR, 'صنف المخزون المطلوب غير موجود');
    }

    // القفل يضمن ألا يُنشأ سعران نشطان لصنف واحد بالتزامن
    if ((await lockActivePrice(client, item.inventoryId)) !== null) {
      throw new MedicationPriceError(409, ApiErrorCode.FORBIDDEN, 'يوجد سعر بيع نشط لهذا الصنف');
    }

    const inserted = await client.query(
      `INSERT INTO medication_prices
         (clinic_id, inventory_id, unit_price, is_active, effective_from, created_by_user_id)
       VALUES ($1, $2, $3, TRUE, COALESCE($4::timestamptz, NOW()), $5)
       RETURNING ${RETURNING_COLUMNS}`,
      [
        item.clinicId,
        item.inventoryId,
        parsed.data.unit_price,
        parsed.data.effective_from ?? null,
        createdByUserId,
      ],
    );
    const price = inserted.rows[0];

    await writePriceAudit(
      client,
      createdByUserId,
      item.clinicId,
      'MEDICATION_PRICE_CREATED',
      Number(price.price_id),
      {
        price_id: price.price_id,
        inventory_id: item.inventoryId,
        clinic_id: item.clinicId,
        unit_price: price.unit_price,
        effective_from: price.effective_from,
      },
    );

    await client.query('COMMIT');
    // NOT `client = null`: the finally block releases the client, so nulling it
    // here would skip the release on the one path that actually succeeds.
    // Phase 10E.9: every handler here leaked a connection until this release
    // was added — three or four price operations exhausted the pool and took
    // the whole API down with it. Same shape as medicationCharges.controller.

    return res.status(201).json({
      message: 'تم إنشاء سعر بيع الدواء بنجاح',
      medicationPrice: price,
    });
  } catch (error: any) {
    await client?.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') return duplicateActivePrice(res);
    if (error?.code === '23503') return validationError(res, 'صنف المخزون أو العيادة المحددة غير موجودة');
    return respondWithError(res, error, 'Create Medication Price Error:');
  } finally {
    client?.release();
  }
};

/* ==========================================================================
 * 4. تحديث سعر = إنهاء صلاحية السعر الحالي + إنشاء سعر جديد (معاملة واحدة)
 *    لا يُعدَّل مبلغ على صف قائم أبداً، فيبقى كل سعر تاريخياً كما حُسب به.
 * ========================================================================== */
export const updateMedicationPrice = async (req: AuthenticatedRequest, res: Response) => {
  const priceId = parsePositiveId(req.params.id);
  if (priceId === null) return validationError(res, 'معرّف سعر البيع غير صالح');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const forbiddenField = FORBIDDEN_MEDICATION_PRICE_FIELDS.find((field) => body[field] !== undefined);
  if (forbiddenField !== undefined) {
    return validationError(res, `الحقل ${forbiddenField} غير مقبول في طلب تحديث سعر البيع — هذه القيم تُشتق من الخادم`);
  }

  const parsed = medicationPriceUpdateSchema.safeParse(body);
  if (!parsed.success) return validationError(res, 'بيانات تحديث سعر البيع غير صالحة');

  const updatedByUserId = req.user?.userId ?? null;
  if (updatedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لتحديث سعر البيع');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const scope = buildClinicScope(req, [priceId], 'mp.clinic_id');
    const existing = await client.query(
      `SELECT ${RETURNING_COLUMNS} FROM medication_prices mp
       WHERE mp.price_id = $1${scope.clause}
       FOR UPDATE`,
      scope.params,
    );
    if (existing.rows.length === 0) {
      throw new MedicationPriceError(404, ApiErrorCode.VALIDATION_ERROR, 'سعر البيع المطلوب غير موجود');
    }
    const current = existing.rows[0];
    const inventoryId = Number(current.inventory_id);
    const clinicId = Number(current.clinic_id);

    // التحديث يخص السعر النشط فقط: سعر مُنتهٍ تاريخياً لا يُستأنف
    if (current.is_active !== true) {
      throw new MedicationPriceError(
        409,
        ApiErrorCode.FORBIDDEN,
        'سعر البيع هذا غير نشط — أنشئ سعراً جديداً للصنف بدلاً من تعديل سعر تاريخي',
        { price_id: priceId },
      );
    }

    // إنهاء صلاحية السعر القديم عند بداية نافذة السعر الجديد
    const closed = await client.query(
      `UPDATE medication_prices
       SET is_active = FALSE, effective_to = COALESCE($2::timestamptz, NOW())
       WHERE price_id = $1 AND is_active
       RETURNING ${RETURNING_COLUMNS}`,
      [priceId, parsed.data.effective_from ?? null],
    );
    if (closed.rowCount !== 1) {
      throw new MedicationPriceError(
        409,
        ApiErrorCode.FORBIDDEN,
        'سبق إنهاء صلاحية هذا السعر — أعد المحاولة',
        { price_id: priceId },
      );
    }

    const inserted = await client.query(
      `INSERT INTO medication_prices
         (clinic_id, inventory_id, unit_price, is_active, effective_from, created_by_user_id)
       VALUES ($1, $2, $3, TRUE, COALESCE($4::timestamptz, NOW()), $5)
       RETURNING ${RETURNING_COLUMNS}`,
      [clinicId, inventoryId, parsed.data.unit_price, parsed.data.effective_from ?? null, updatedByUserId],
    );
    const nextPrice = inserted.rows[0];

    await writePriceAudit(
      client,
      updatedByUserId,
      clinicId,
      'MEDICATION_PRICE_SUPERSEDED',
      Number(nextPrice.price_id),
      {
        superseded_price_id: priceId,
        new_price_id: nextPrice.price_id,
        inventory_id: inventoryId,
        clinic_id: clinicId,
        previous_unit_price: current.unit_price,
        unit_price: nextPrice.unit_price,
        effective_to: closed.rows[0].effective_to,
        effective_from: nextPrice.effective_from,
      },
    );

    await client.query('COMMIT');
    // See the create handler: the finally block owns the release.

    return res.status(200).json({
      message: 'تم تحديث سعر بيع الدواء بنجاح',
      medicationPrice: nextPrice,
      supersededPrice: closed.rows[0],
    });
  } catch (error: any) {
    await client?.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') return duplicateActivePrice(res);
    return respondWithError(res, error, 'Update Medication Price Error:');
  } finally {
    client?.release();
  }
};

/* ==========================================================================
 * 5. إنهاء صلاحية سعر بلا إنشاء سعر جديد — لا حذف فيزيائي إطلاقاً
 *    السعر المنتهي يبقى منصوناً لأنه قد يكون أساس فوترة مستقبلية.
 * ========================================================================== */
export const deactivateMedicationPrice = async (req: AuthenticatedRequest, res: Response) => {
  const priceId = parsePositiveId(req.params.id);
  if (priceId === null) return validationError(res, 'معرّف سعر البيع غير صالح');

  const deactivatedByUserId = req.user?.userId ?? null;
  if (deactivatedByUserId === null) {
    return validationError(res, 'المستخدم الموثّق مطلوب لإنهاء صلاحية سعر البيع');
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const scope = buildClinicScope(req, [priceId], 'mp.clinic_id');
    const existing = await client.query(
      `SELECT ${RETURNING_COLUMNS} FROM medication_prices mp
       WHERE mp.price_id = $1${scope.clause}
       FOR UPDATE`,
      scope.params,
    );
    if (existing.rows.length === 0) {
      throw new MedicationPriceError(404, ApiErrorCode.VALIDATION_ERROR, 'سعر البيع المطلوب غير موجود');
    }
    const current = existing.rows[0];

    const closed = await client.query(
      `UPDATE medication_prices
       SET is_active = FALSE, effective_to = COALESCE(effective_to, NOW())
       WHERE price_id = $1 AND is_active
       RETURNING ${RETURNING_COLUMNS}`,
      [priceId],
    );
    if (closed.rowCount !== 1) {
      throw new MedicationPriceError(
        409,
        ApiErrorCode.FORBIDDEN,
        'سعر البيع هذا غير نشط أصلاً',
        { price_id: priceId },
      );
    }

    await writePriceAudit(
      client,
      deactivatedByUserId,
      Number(current.clinic_id),
      'MEDICATION_PRICE_DEACTIVATED',
      priceId,
      {
        price_id: priceId,
        inventory_id: current.inventory_id,
        clinic_id: current.clinic_id,
        unit_price: current.unit_price,
        effective_to: closed.rows[0].effective_to,
      },
    );

    await client.query('COMMIT');
    // See the create handler: the finally block owns the release.

    return res.status(200).json({
      message: 'تم إنهاء صلاحية سعر بيع الدواء',
      medicationPrice: closed.rows[0],
    });
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    return respondWithError(res, error, 'Deactivate Medication Price Error:');
  } finally {
    client?.release();
  }
};