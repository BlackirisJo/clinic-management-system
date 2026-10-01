import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  repeatAuthorizationCreateSchema,
  repeatAuthorizationUpdateSchema,
} from '../../validations/repeatAuthorization.validation';
import { buildClinicScope, parsePositiveId } from '../inventory/clinicScope';

/* ==========================================================================
 * Phase 10C.4C — Repeat authorization CRUD
 *
 * تفويض التكرار قرار سريري: محمي بـ CREATE_PRESCRIPTION (المجموعة Prescriptions،
 * DOCTOR/SUPER_ADMIN/SYSTEM_ADMIN) — لا صلاحية جديدة.
 *
 * لا يُنشأ أي تفويض من repeats_count ولا تُترجم قيمه التاريخية.
 * الإلغاء logical (status = CANCELLED) ولا يحذف السجل.
 * ========================================================================== */

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// موحّد: بند غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده)
const itemNotFound = (res: Response) =>
  res.status(404).json({ message: 'بند الروشتة المطلوب غير موجود' });

/**
 * يحمّل بند الروشتة ضمن نطاق العيادات ويشتق عيادته من الزيارة.
 * يستقبل منفّذ الاستعلام (pool للقراءة فقط، أو client داخل معاملة) حتى تُقرأ
 * العيادة على نفس الاتصال الذي ستُكتب عليه.
 */
const loadPrescriptionItem = async (
  req: AuthenticatedRequest,
  itemId: number,
  run: { query: (text: string, params: unknown[]) => Promise<{ rows: any[] }> },
) => {
  const scope = buildClinicScope(req, [itemId], 'v.clinic_id');
  const result = await run.query(
    `SELECT pi.item_id, pi.prescription_id, pi.prescribed_quantity, pi.uom, v.clinic_id
     FROM prescription_items pi
     JOIN prescriptions p ON p.prescription_id = pi.prescription_id
     JOIN visits v ON v.visit_id = p.visit_id
     WHERE pi.item_id = $1${scope.clause}`,
    scope.params,
  );
  if (result.rows.length === 0) return null;
  return {
    item_id: Number(result.rows[0].item_id),
    prescription_id: Number(result.rows[0].prescription_id),
    clinic_id: Number(result.rows[0].clinic_id),
  };
};

const AUTHORIZATION_COLUMNS = `ra.repeat_auth_id, ra.prescription_item_id, ra.clinic_id, ra.max_cycles,
       ra.status, ra.authorized_by_user_id, ra.authorized_at`;

/** قراءة التفويض الحالي لبند (قد لا يوجد = max_cycles ضمني 1). */
export const getRepeatAuthorization = async (req: AuthenticatedRequest, res: Response) => {
  const itemId = parsePositiveId(req.params.itemId);
  if (itemId === null) return validationError(res, 'معرّف بند الروشتة غير صالح');

  try {
    const item = await loadPrescriptionItem(req, itemId, pool);
    if (item === null) return itemNotFound(res);

    const result = await pool.query(
      `SELECT ${AUTHORIZATION_COLUMNS} FROM prescription_repeat_authorizations ra
       WHERE ra.prescription_item_id = $1 AND ra.clinic_id = $2`,
      [itemId, item.clinic_id],
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        authorization: {
          prescription_item_id: itemId,
          max_cycles: 1,
          status: 'NONE',
          implicit: true,
        },
      });
    }
    return res.status(200).json({ authorization: { ...result.rows[0], implicit: false } });
  } catch (error) {
    console.error('Get Repeat Authorization Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب تفويض التكرار',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/** إنشاء (أو إعادة تفعيل) تفويض تكرار. max_cycles يشمل الصرف الابتدائي. */
export const createRepeatAuthorization = async (req: AuthenticatedRequest, res: Response) => {
  const itemId = parsePositiveId(req.params.itemId);
  if (itemId === null) return validationError(res, 'معرّف بند الروشتة غير صالح');

  const parsed = repeatAuthorizationCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, 'بيانات تفويض التكرار غير صالحة');

  // هوية المُفوِّض من الجلسة حصراً
  const userId = req.user?.userId;
  if (userId === undefined || userId === null) {
    return res.status(401).json({ message: 'المستخدم غير موثق', code: ApiErrorCode.UNAUTHENTICATED });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await loadPrescriptionItem(req, itemId, client);
    if (item === null) {
      await client.query('ROLLBACK');
      return itemNotFound(res);
    }

    // قفل الصف إن وجد: يمنع سباق إنشاء/تعديل متزامن على نفس البند
    const existing = await client.query(
      `SELECT repeat_auth_id FROM prescription_repeat_authorizations
       WHERE prescription_item_id = $1 FOR UPDATE`,
      [itemId],
    );

    let saved;
    if (existing.rows.length > 0) {
      const updated = await client.query(
        `UPDATE prescription_repeat_authorizations
         SET max_cycles = $1, status = 'ACTIVE', authorized_by_user_id = $2, authorized_at = NOW()
         WHERE prescription_item_id = $3
         RETURNING ${AUTHORIZATION_COLUMNS}`,
        [parsed.data.max_cycles, userId, itemId],
      );
      saved = updated.rows[0];
    } else {
      const inserted = await client.query(
        `INSERT INTO prescription_repeat_authorizations
           (prescription_item_id, clinic_id, max_cycles, status, authorized_by_user_id)
         VALUES ($1, $2, $3, 'ACTIVE', $4)
         RETURNING ${AUTHORIZATION_COLUMNS}`,
        [itemId, item.clinic_id, parsed.data.max_cycles, userId],
      );
      saved = inserted.rows[0];
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'REPEAT_AUTHORIZED', 'PRESCRIPTION_REPEAT_AUTHORIZATION', $3, $4)`,
      [
        userId,
        item.clinic_id,
        String(itemId),
        JSON.stringify({
          prescription_item_id: itemId,
          prescription_id: item.prescription_id,
          max_cycles: parsed.data.max_cycles,
          previous_max_cycles: existing.rows.length ? undefined : null,
          status: 'ACTIVE',
          authorized_by_user_id: userId,
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(201).json({ authorization: saved });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'يوجد تفويض تكرار لهذا البند', code: ApiErrorCode.FORBIDDEN });
    }
    console.error('Create Repeat Authorization Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إنشاء تفويض التكرار',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client.release();
  }
};

/** تحديث الحد المسموح (لا تغيير العيادة ولا البند). */
export const updateRepeatAuthorization = async (req: AuthenticatedRequest, res: Response) => {
  const itemId = parsePositiveId(req.params.itemId);
  if (itemId === null) return validationError(res, 'معرّف بند الروشتة غير صالح');

  const parsed = repeatAuthorizationUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success || parsed.data.max_cycles === undefined) {
    return validationError(res, 'بيانات تحديث تفويض التكرار غير صالحة');
  }
  const userId = req.user?.userId;
  if (userId === undefined || userId === null) {
    return res.status(401).json({ message: 'المستخدم غير موثق', code: ApiErrorCode.UNAUTHENTICATED });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await loadPrescriptionItem(req, itemId, client);
    if (item === null) {
      await client.query('ROLLBACK');
      return itemNotFound(res);
    }

    const updated = await client.query(
      `UPDATE prescription_repeat_authorizations
       SET max_cycles = $1, authorized_by_user_id = $2, authorized_at = NOW()
       WHERE prescription_item_id = $3 AND clinic_id = $4
       RETURNING ${AUTHORIZATION_COLUMNS}`,
      [parsed.data.max_cycles, userId, itemId, item.clinic_id],
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return itemNotFound(res);
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'REPEAT_AUTHORIZATION_UPDATED', 'PRESCRIPTION_REPEAT_AUTHORIZATION', $3, $4)`,
      [
        userId,
        item.clinic_id,
        String(itemId),
        JSON.stringify({
          prescription_item_id: itemId,
          prescription_id: item.prescription_id,
          max_cycles: parsed.data.max_cycles,
          authorized_by_user_id: userId,
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(200).json({ authorization: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Update Repeat Authorization Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء تحديث تفويض التكرار',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client.release();
  }
};

/** إلغاء التفويض منطقياً (status = CANCELLED). لا حذف — السجل تدقيقي. */
export const cancelRepeatAuthorization = async (req: AuthenticatedRequest, res: Response) => {
  const itemId = parsePositiveId(req.params.itemId);
  if (itemId === null) return validationError(res, 'معرّف بند الروشتة غير صالح');

  const userId = req.user?.userId;
  if (userId === undefined || userId === null) {
    return res.status(401).json({ message: 'المستخدم غير موثق', code: ApiErrorCode.UNAUTHENTICATED });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await loadPrescriptionItem(req, itemId, client);
    if (item === null) {
      await client.query('ROLLBACK');
      return itemNotFound(res);
    }

    const cancelled = await client.query(
      `UPDATE prescription_repeat_authorizations
       SET status = 'CANCELLED', authorized_by_user_id = $1, authorized_at = NOW()
       WHERE prescription_item_id = $2 AND clinic_id = $3 AND status = 'ACTIVE'
       RETURNING ${AUTHORIZATION_COLUMNS}`,
      [userId, itemId, item.clinic_id],
    );
    if (cancelled.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'لا يوجد تفويض نشط لإلغائه', code: ApiErrorCode.FORBIDDEN });
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'REPEAT_AUTHORIZATION_CANCELLED', 'PRESCRIPTION_REPEAT_AUTHORIZATION', $3, $4)`,
      [
        userId,
        item.clinic_id,
        String(itemId),
        JSON.stringify({
          prescription_item_id: itemId,
          prescription_id: item.prescription_id,
          status: 'CANCELLED',
          cancelled_by_user_id: userId,
        }),
      ],
    );

    await client.query('COMMIT');
    return res.status(200).json({ authorization: cancelled.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Cancel Repeat Authorization Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء إلغاء تفويض التكرار',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  } finally {
    client.release();
  }
};
