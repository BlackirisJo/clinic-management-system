import { pool } from '../../config/database';
import type { PoolClient } from 'pg';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../middlewares/error.middleware';
import { ApiErrorCode } from '../../utils/apiErrors';
import { buildClinicScope, parsePositiveId } from './clinicScope';

/* ==========================================================================
 * Phase 10B.4A-2 — FEFO selector (earliest valid expiry first)
 *
 * Helper قابل لإعادة الاستخدام لـ Phase 10C.
 * قراءة فقط بالكامل: لا تحديث، لا حجز، لا إنشاء حركة، ولا قفل FOR UPDATE.
 * الفحص يتم داخل الاستعلام فلا تُعاد أي دفعة غير مؤهلة.
 * ========================================================================== */

export const DEFAULT_FEFO_LIMIT = 10;
export const MAX_FEFO_LIMIT = 100;

export interface FefoBatch {
  batch_id: number;
  inventory_id: number;
  lot_number: string;
  /** تاريخ الانتهاء بصيغة YYYY-MM-DD */
  expiry_date: string;
  quantity_on_hand: number;
}

const normaliseLimit = (limit?: number): number => {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) return DEFAULT_FEFO_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return DEFAULT_FEFO_LIMIT;
  return Math.min(floored, MAX_FEFO_LIMIT);
};

// pg يعيد عمود DATE ككائن Date — نوحّده على نص YYYY-MM-DD باستخدام مكوّناته المحلية
const toIsoDate = (value: unknown): string => {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value);
};

/**
 * الدفعات المؤهلة للصرف لعنصر مخزون معيّن، مرتبة FEFO:
 * الأقرب انتهاءً بين الصالح FIRST ثم batch_id ككاسر تعادل حتمي.
 * صنف مخزون خارج نطاق عيادات المستخدم أو بلا دفعات مؤهلة => قائمة فارغة (لا خطأ).
 */
export const selectFefoBatches = async (
  req: AuthenticatedRequest,
  inventoryId: number,
  limit?: number,
): Promise<FefoBatch[]> => {
  const id = parsePositiveId(inventoryId);
  if (id === null) return [];

  const safeLimit = normaliseLimit(limit);
  const scope = buildClinicScope(req, [id], 'i.clinic_id');
  const result = await pool.query(
    `SELECT b.batch_id, b.inventory_id, b.lot_number, b.expiry_date, b.quantity_on_hand
     FROM inventory_batches b
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     WHERE b.inventory_id = $1
       AND b.is_active = TRUE
       AND i.deleted_at IS NULL
       AND b.quantity_on_hand > 0
       AND b.expiry_date >= CURRENT_DATE
       AND NOT EXISTS (
             SELECT 1 FROM batch_quarantines bq
             WHERE bq.batch_id = b.batch_id AND bq.released_at IS NULL
           )${scope.clause}
     ORDER BY b.expiry_date ASC, b.batch_id ASC
     LIMIT $${scope.params.length + 1}`,
    [...scope.params, safeLimit],
  );

  return result.rows.map((row) => ({
    batch_id: Number(row.batch_id),
    inventory_id: Number(row.inventory_id),
    lot_number: String(row.lot_number),
    expiry_date: toIsoDate(row.expiry_date),
    quantity_on_hand: Number(row.quantity_on_hand),
  }));
};

/* ==========================================================================
 * Phase 10C.2 — Locked FEFO allocator (dispatch transaction)
 *
 * نسخة مقفلة من الاختيار أعلاه، تعمل على نفس PoolClient الخاص بمعاملة الصرف
 * forthcoming: BEGIN → هذه الدالة → التحقق/الخصم → حركة المخزون → COMMIT.
 *
 *Concurrency: يستخدم FOR UPDATE بلا SKIP LOCKED عمداً. صرف دواء يجب أن يحترم
 * FEFO صارماً: إن كان صف أقرب-صلاحية مقفلاً بمعاملة صرف أخرى، تُنتظر المعاملة
 * ثم تُعاد قراءة الصف، ولا يُتخطّى أبداً لمجرد أن قفله مؤقت. هذا يحافظ على ترتيب
 * FEFO الحقيقي تحت التزامن.
 *
 * هذه الدالة لا تلتزم ولا تتراجع عن المعاملة الخارجية، ولا تعدّل أي بيانات:
 * تقفل وتحسب فقط. الخصم وإنشاء الحركة مسؤولية طبقة الصرف.
 * ========================================================================== */

export interface FefoAllocation {
  batch_id: number;
  inventory_id: number;
  lot_number: string;
  expiry_date: string;
  /** الرصيد المقروء بعد القفل (لا يُعتمد على نتيجة الاستعلام غير المقفل) */
  quantity_on_hand: number;
  /** تكلفة الوحدة المقروءة بعد القفل — تُستخدم لتجميد unit_cost_snapshot عند الصرف */
  unit_cost: number | null;
  /** الكمية المخصصة من هذه الدفعة */
  allocation: number;
}

export type FefoAllocationFailureReason = 'INSUFFICIENT_STOCK' | 'NO_ELIGIBLE_BATCH';

export type FefoAllocationResult =
  | { ok: true; allocations: FefoAllocation[]; allocated_quantity: number }
  | {
      ok: false;
      reason: FefoAllocationFailureReason;
      requested_quantity: number;
      available_quantity: number;
    };

// حدود NUMERIC(12,3) ومنع التقريب الصامت
const MAX_FEFO_QUANTITY = 999_999_999.999;
const SCALE = 1000;

const round3 = (value: number): number => Number(value.toFixed(3));

const assertAllocatableQuantity = (quantity: unknown): number => {
  const value = Number(quantity);
  if (!Number.isFinite(value)) {
    throw new AppError('الكمية المطلوبة غير صالحة', 400, ApiErrorCode.VALIDATION_ERROR);
  }
  if (value <= 0) {
    throw new AppError('الكمية المطلوبة يجب أن تكون أكبر من صفر', 400, ApiErrorCode.VALIDATION_ERROR);
  }
  if (value > MAX_FEFO_QUANTITY) {
    throw new AppError('الكمية المطلوبة تتجاوز الحد المسموح', 400, ApiErrorCode.VALIDATION_ERROR);
  }
  if (Math.abs(value * SCALE - Math.round(value * SCALE)) >= 1e-6) {
    throw new AppError('الكمية المطلوبة لا تقبل أكثر من 3 خانات عشرية', 400, ApiErrorCode.VALIDATION_ERROR);
  }
  return value;
};

/**
 * يوزّع الكمية المطلوبة على دفعات صالحة بترتيب FEFO داخل معاملة قائمة.
 *
 * لا يخصم شيئاً ولا ينشئ حركات: يعيد خطة تخصيص فقط. عند نقص المخزون تُعاد
 * نتيجة خطأ نطاقية دون أي تعديل، وتترك القرار لطبقة الصرف.
 */
export const allocateFefoBatches = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  inventoryId: number,
  quantity: number,
): Promise<FefoAllocationResult> => {
  const id = parsePositiveId(inventoryId);
  if (id === null) {
    throw new AppError('معرّف صنف المخزون غير صالح', 400, ApiErrorCode.VALIDATION_ERROR);
  }
  const requested = assertAllocatableQuantity(quantity);

  const scope = buildClinicScope(req, [id], 'i.clinic_id');
  // بلا LIMIT: نحتاج مجموع كل الدفعات المؤهلة للحكم على كفاية المخزون،
  // وحدّ النتائج قد يُنتج حكم INSUFFICIENT_STOCK خاطئاً.
  const result = await client.query(
    `SELECT b.batch_id, b.inventory_id, b.lot_number, b.expiry_date, b.quantity_on_hand, b.unit_cost
     FROM inventory_batches b
     JOIN inventory_items i ON i.inventory_id = b.inventory_id
     WHERE b.inventory_id = $1
       AND b.is_active = TRUE
       AND i.deleted_at IS NULL
       AND b.quantity_on_hand > 0
       AND b.expiry_date >= CURRENT_DATE
       AND NOT EXISTS (
             SELECT 1 FROM batch_quarantines bq
             WHERE bq.batch_id = b.batch_id AND bq.released_at IS NULL
           )${scope.clause}
     ORDER BY b.expiry_date ASC, b.batch_id ASC
     FOR UPDATE OF b`,
    scope.params,
  );

  const candidates = result.rows.map((row) => ({
    batch_id: Number(row.batch_id),
    inventory_id: Number(row.inventory_id),
    lot_number: String(row.lot_number),
    expiry_date: toIsoDate(row.expiry_date),
    quantity_on_hand: Number(row.quantity_on_hand),
    unit_cost: row.unit_cost === null || row.unit_cost === undefined ? null : Number(row.unit_cost),
  }));

  const available = round3(candidates.reduce((sum, row) => sum + row.quantity_on_hand, 0));
  if (candidates.length === 0) {
    return { ok: false, reason: 'NO_ELIGIBLE_BATCH', requested_quantity: requested, available_quantity: 0 };
  }

  const allocations: FefoAllocation[] = [];
  let remaining = requested;

  for (const row of candidates) {
    if (remaining <= 0) break;
    const take = round3(Math.min(row.quantity_on_hand, remaining));
    if (take <= 0) continue;
    allocations.push({ ...row, allocation: take });
    remaining = round3(remaining - take);
  }

  if (remaining > 0) {
    return { ok: false, reason: 'INSUFFICIENT_STOCK', requested_quantity: requested, available_quantity: available };
  }

  return { ok: true, allocations, allocated_quantity: round3(requested - remaining) };
};
