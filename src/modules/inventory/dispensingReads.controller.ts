import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { canAccessLogs } from '../audit/audit.controller';
import {
  dispensingListQuerySchema,
  DEFAULT_DISPENSING_LIMIT,
  type DispensingListQuery,
} from '../../validations/dispensingRead.validation';
import { buildClinicScope, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10C.5 — Dispensing read & audit API
 *
 * قراءة فقط بالكامل: لا معاملات، لا FOR UPDATE، لا SKIP LOCKED، ولا تعديل
 * لأي حالة. كل القيم التاريخية تُقرأ من سجلات الصرف المحفوظة (اللقطة
 * unit_cost_snapshot / expiry_date_snapshot) لا من المخزون الحالي.
 * ============================================================== */

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

// موحّد: سجل غير موجود أو خارج نطاق عيادات المستخدم (لا يُكشف وجوده)
const dispensingNotFound = (res: Response) =>
  res.status(404).json({ message: 'سجل الصرف المطلوب غير موجود' });

/** حقول العرض الآمنة للمستخدم — الاسم فقط، بلا اسم مستخدم أو بريد. */
const SAFE_USER_NAME = 'u.full_name AS user_name';

const buildListFilters = (query: DispensingListQuery): { clause: string; params: unknown[] } => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    conditions.push(fragment.replace('$?', `$${params.length}`));
  };

  if (query.prescription_id !== undefined) add('d.prescription_id = $?', query.prescription_id);
  if (query.patient_id !== undefined) add('d.patient_id = $?', query.patient_id);
  if (query.status !== undefined) add('d.status = $?', query.status);
  if (query.dispensed_by_user_id !== undefined) add('d.dispensed_by_user_id = $?', query.dispensed_by_user_id);
  if (query.cycle_index !== undefined) {
    // يطابق إن كان للبند أي بند في هذه الدورة
    add('EXISTS (SELECT 1 FROM dispensing_items ci WHERE ci.dispensing_id = d.dispensing_id AND ci.cycle_index = $?)', query.cycle_index);
  }
  if (query.date_from !== undefined) add('d.created_at >= $?::date', query.date_from);
  if (query.date_to !== undefined) add('d.created_at < ($?::date + INTERVAL \'1 day\')', query.date_to);

  return { clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
};

/** 1. قائمة سجلات الصرف — خفيفة، بلا تحميل التخصيصات. */
export const listDispensings = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = dispensingListQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return validationError(res, 'معايير تصفية سجلات الصرف غير صالحة');
  const query = parsed.data;

  const limit = query.limit ?? DEFAULT_DISPENSING_LIMIT;
  const offset = query.offset ?? 0;
  const filters = buildListFilters(query);

  try {
    const scope = buildClinicScope(req, filters.params, 'd.clinic_id');
    const next = scope.params.length + 1;
    const result = await pool.query(
      `SELECT d.dispensing_id, d.prescription_id, d.patient_id, d.clinic_id, d.status,
              d.notes, d.created_at, d.voided_at,
              pt.full_name AS patient_name,
              ${SAFE_USER_NAME},
              c.clinic_name,
              (SELECT COUNT(*)::int FROM dispensing_items di WHERE di.dispensing_id = d.dispensing_id) AS item_count,
              (SELECT MIN(di.cycle_index) FROM dispensing_items di WHERE di.dispensing_id = d.dispensing_id) AS cycle_index_min,
              (SELECT MAX(di.cycle_index) FROM dispensing_items di WHERE di.dispensing_id = d.dispensing_id) AS cycle_index_max
       FROM dispensings d
       JOIN patients pt ON pt.patient_id = d.patient_id
       JOIN users u ON u.user_id = d.dispensed_by_user_id
       JOIN clinics c ON c.clinic_id = d.clinic_id
       WHERE 1=1${filters.clause}${scope.clause}
       ORDER BY d.created_at DESC, d.dispensing_id DESC
       LIMIT $${next} OFFSET $${next + 1}`,
      [...scope.params, limit, offset],
    );

    return res.status(200).json({
      dispensings: result.rows,
      pagination: { limit, offset, returned: result.rows.length },
    });
  } catch (error) {
    console.error('List Dispensings Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب سجلات الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/** يتحقق من وجود السجل ضمن النطاق — يُستخدم قبل كل مسار تفصيلي. */
const loadScopedDispensing = async (req: AuthenticatedRequest, dispensingId: number) => {
  const scope = buildClinicScope(req, [dispensingId], 'd.clinic_id');
  const result = await pool.query(
    `SELECT d.dispensing_id, d.clinic_id, d.status FROM dispensings d
     WHERE d.dispensing_id = $1${scope.clause}`,
    scope.params,
  );
  return result.rows.length > 0;
};

/** 2. تفاصيل سجل صرف كامل — من السجلات المحفوظة فقط. */
export const getDispensing = async (req: AuthenticatedRequest, res: Response) => {
  const dispensingId = parsePositiveId(req.params.id);
  if (dispensingId === null) return validationError(res, 'معرّف سجل الصرف غير صالح');

  try {
    const scope = buildClinicScope(req, [dispensingId], 'd.clinic_id');
    const header = await pool.query(
      `SELECT d.dispensing_id, d.prescription_id, d.visit_id, d.patient_id, d.clinic_id,
              d.status, d.notes, d.created_at, d.voided_at, d.voided_by_user_id, d.void_reason,
              pt.full_name AS patient_name,
              pt.gender AS patient_gender,
              du.full_name AS dispensed_by_name,
              vu.full_name AS voided_by_name,
              c.clinic_name
       FROM dispensings d
       JOIN patients pt ON pt.patient_id = d.patient_id
       JOIN users du ON du.user_id = d.dispensed_by_user_id
       LEFT JOIN users vu ON vu.user_id = d.voided_by_user_id
       JOIN clinics c ON c.clinic_id = d.clinic_id
       WHERE d.dispensing_id = $1${scope.clause}`,
      scope.params,
    );
    if (header.rows.length === 0) return dispensingNotFound(res);

    // بنود الصرف وتخصيصاتها في استعلام واحد بلا N+1
    const items = await pool.query(
      `SELECT di.dispensing_item_id, di.prescription_item_id, di.medication_id, di.inventory_item_id,
              di.prescribed_quantity, di.dispensed_quantity, di.remaining_quantity, di.uom, di.cycle_index,
              m.trade_name, m.scientific_name, m.strength, m.dosage_form,
              dib.dispensing_item_batch_id, dib.batch_id, dib.quantity AS allocated_quantity,
              dib.unit_cost_snapshot, dib.expiry_date_snapshot, dib.lot_number
       FROM dispensing_items di
       JOIN medications m ON m.medication_id = di.medication_id
       LEFT JOIN dispensing_item_batches dib ON dib.dispensing_item_id = di.dispensing_item_id
       WHERE di.dispensing_id = $1
       ORDER BY di.dispensing_item_id ASC, dib.expiry_date_snapshot ASC NULLS LAST, dib.batch_id ASC`,
      [dispensingId],
    );

    const grouped = new Map<number, Record<string, unknown>>();
    for (const row of items.rows) {
      const key = Number(row.dispensing_item_id);
      if (!grouped.has(key)) {
        grouped.set(key, {
          dispensing_item_id: key,
          prescription_item_id: row.prescription_item_id,
          medication_id: row.medication_id,
          inventory_item_id: row.inventory_item_id,
          medication: {
            trade_name: row.trade_name,
            scientific_name: row.scientific_name,
            strength: row.strength,
            dosage_form: row.dosage_form,
          },
          prescribed_quantity: row.prescribed_quantity,
          dispensed_quantity: row.dispensed_quantity,
          remaining_quantity: row.remaining_quantity,
          uom: row.uom,
          cycle_index: row.cycle_index,
          batches: [],
        });
      }
      if (row.dispensing_item_batch_id === null || row.dispensing_item_batch_id === undefined) continue;
      (grouped.get(key)!.batches as unknown[]).push({
        batch_id: row.batch_id,
        lot_number: row.lot_number,
        expiry_date_snapshot: row.expiry_date_snapshot,
        allocated_quantity: row.allocated_quantity,
        unit_cost_snapshot: row.unit_cost_snapshot,
      });
    }

    return res.status(200).json({ dispensing: { ...header.rows[0], items: [...grouped.values()] } });
  } catch (error) {
    console.error('Get Dispensing Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب تفاصيل الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/** 3. حركات المخزون المرتبطة بسجل الصرف — قراءة فقط، بلا نسخ أو تعديل. */
export const getDispensingMovements = async (req: AuthenticatedRequest, res: Response) => {
  const dispensingId = parsePositiveId(req.params.id);
  if (dispensingId === null) return validationError(res, 'معرّف سجل الصرف غير صالح');

  try {
    if (!(await loadScopedDispensing(req, dispensingId))) return dispensingNotFound(res);

    const scope = buildClinicScope(req, [String(dispensingId)], 'i.clinic_id');
    const result = await pool.query(
      `SELECT sm.movement_id, sm.batch_id, sm.movement_type, sm.quantity,
              sm.reference_type, sm.reference_id, sm.notes, sm.created_at,
              sm.performed_by_user_id, b.lot_number, b.expiry_date AS batch_expiry_date
       FROM stock_movements sm
       JOIN inventory_batches b ON b.batch_id = sm.batch_id
       JOIN inventory_items i ON i.inventory_id = b.inventory_id
       WHERE sm.reference_id = $1
         AND sm.reference_type IN ('DISPENSING', 'DISPENSING_VOID')${scope.clause}
       ORDER BY sm.created_at ASC, sm.movement_id ASC`,
      scope.params,
    );

    return res.status(200).json({
      dispensing_id: dispensingId,
      movements: result.rows,
      returned: result.rows.length,
    });
  } catch (error) {
    console.error('Get Dispensing Movements Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب حركات الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};

/** 4. سجل التدقيق المرتبط — محصور بنفس قاعدة سجلات النظام الحالية. */
export const getDispensingAudit = async (req: AuthenticatedRequest, res: Response) => {
  const dispensingId = parsePositiveId(req.params.id);
  if (dispensingId === null) return validationError(res, 'معرّف سجل الصرف غير صالح');

  // سجلات النظام مقصورة عمداً — القاعدة نفسها المستخدمة في وحدة التدقيق
  if (!canAccessLogs(req)) {
    return res.status(403).json({ message: 'غير مصرّح', code: ApiErrorCode.FORBIDDEN });
  }

  try {
    if (!(await loadScopedDispensing(req, dispensingId))) return dispensingNotFound(res);

    const scope = buildClinicScope(req, [String(dispensingId)], 'd.clinic_id');
    const result = await pool.query(
      `SELECT a.audit_id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at,
              a.clinic_id, u.full_name AS user_name
       FROM audit_logs a
       JOIN dispensings d ON d.dispensing_id = a.resource_id::int
       LEFT JOIN users u ON u.user_id = a.user_id
       WHERE a.resource_type = 'DISPENSING'
         AND a.resource_id = $1${scope.clause}
       ORDER BY a.created_at ASC, a.audit_id ASC`,
      scope.params,
    );

    return res.status(200).json({
      dispensing_id: dispensingId,
      audit_logs: result.rows,
      returned: result.rows.length,
    });
  } catch (error) {
    console.error('Get Dispensing Audit Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب سجل تدقيق الصرف',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};
