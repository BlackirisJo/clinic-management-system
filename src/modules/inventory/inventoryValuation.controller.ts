import { Response } from 'express';
import { pool } from '../../config/database';
import { ApiErrorCode } from '../../utils/apiErrors';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import {
  inventoryValuationQuerySchema,
  DEFAULT_INVENTORY_VALUATION_LIMIT,
} from '../../validations/inventoryValuation.validation';
import { buildClinicScope } from './clinicScope';

/* ==========================================================================
 * Phase 10E.6 — Inventory valuation (READ-ONLY)
 *
 * What this reports: the financial value of PHYSICAL stock currently held,
 * valued strictly at each batch's own cost basis.
 *
 *     inventory_value = inventory_batches.quantity_on_hand
 *                     × inventory_batches.unit_cost
 *
 * What this deliberately is NOT:
 * - Not a margin or a revenue figure. The selling side is 10E.4/10E.5 and lives
 *   on the dispensing and the invoice, never here.
 * - Not COGS. COGS (dispensing_items.cogs_amount) values stock that has ALREADY
 *   LEFT the clinic; this values stock still ON the shelf. Mixing them would
 *   double-count the same units.
 * - Not a costing method. There is no weighted average, FIFO or LIFO here, and
 *   none is introduced: each batch is valued at its OWN recorded cost, exactly
 *   as it is stored.
 * - Not a write. Nothing in this module mutates stock, cost, or movements.
 *
 * Three distinctions this report is careful to preserve, because collapsing any
 * of them would misstate the stock position:
 *
 *  1. quantity_on_hand vs quantity_reserved. Reserved units are still PHYSICAL
 *     stock, so they stay in the valuation. Only the FEFO/available concept
 *     subtracts them, and that is a different question this report does not ask.
 *  2. Physical presence vs dispensability. An expired, inactive or quarantined
 *     batch is still physically present and is therefore still valued. FEFO
 *     excludes such batches; valuation must not, or the balance would depend on
 *     whether stock happened to be usable. Their state is reported alongside
 *     the value instead of filtering them away.
 *  3. Valued vs unvalued. A batch with NULL unit_cost has NO known cost basis.
 *     It is reported as UNVALUED with a NULL value and is excluded from the
 *     valued total — never counted as zero. Treating it as zero would understate
 *     inventory and quietly destroy the evidence that a cost is missing.
 *
 * Clinic scope is enforced by buildClinicScope from the authenticated session.
 * No clinic identifier is ever read from the request.
 * ========================================================================== */

const validationError = (res: Response, message: string) =>
  res.status(400).json({ message, code: ApiErrorCode.VALIDATION_ERROR });

/**
 * A single set-based statement: the batch rows and the report totals are the
 * same round trip. The totals use window functions, so they are computed over
 * the WHOLE filtered set before LIMIT trims the page — a paged report still
 * reports true totals rather than page totals. One query, no N+1, no per-batch
 * follow-up for cost or quarantine.
 *
 * The active quarantine is joined rather than probed per row: uq_bq_one_active_
 * per_batch guarantees at most one active quarantine per batch, so the join
 * cannot duplicate a row. Released quarantine records are excluded, which is
 * the same "released_at IS NULL" definition the FEFO allocator uses.
 */
const VALUATION_SQL = `SELECT b.batch_id, b.lot_number, b.expiry_date,
       b.quantity_on_hand, b.quantity_reserved, b.unit_cost, b.is_active,
       i.inventory_id, i.medication_id, i.uom,
       m.trade_name, m.strength, m.dosage_form,
       bq.quarantine_id IS NOT NULL AS is_quarantined,
       bq.reason AS quarantine_reason,
       bq.quarantined_at,
       (b.expiry_date < CURRENT_DATE) AS is_expired,
       CASE WHEN b.unit_cost IS NULL THEN NULL
            ELSE b.quantity_on_hand * b.unit_cost END AS inventory_value,
       COUNT(*) OVER () AS filtered_batch_count,
       COUNT(b.unit_cost) OVER () AS valued_batch_count,
       COALESCE(SUM(b.quantity_on_hand * b.unit_cost) OVER (), 0) AS total_inventory_value,
       COUNT(*) FILTER (WHERE b.unit_cost IS NULL) OVER () AS unvalued_batch_count,
       COALESCE(SUM(b.quantity_on_hand) FILTER (WHERE b.unit_cost IS NULL) OVER (), 0)
         AS unvalued_quantity_on_hand,
       COALESCE(SUM(b.quantity_on_hand) OVER (), 0) AS total_quantity_on_hand
FROM inventory_batches b
JOIN inventory_items i ON i.inventory_id = b.inventory_id
JOIN medications m ON m.medication_id = i.medication_id
LEFT JOIN batch_quarantines bq
       ON bq.batch_id = b.batch_id AND bq.released_at IS NULL`;

export const getInventoryValuation = async (req: AuthenticatedRequest, res: Response) => {
  const parsed = inventoryValuationQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    return validationError(res, 'معايير تقييم المخزون غير صالحة');
  }
  const { batch_id, inventory_id, medication_id, limit, offset } = parsed.data;

  // Clinic scope first, then the caller's filters. buildClinicScope appends its
  // own bind, so every filter must be pushed onto scope.params in order.
  const scope = buildClinicScope(req, [], 'i.clinic_id');
  const params = [...scope.params];
  const where: string[] = [];

  if (batch_id !== undefined) {
    params.push(batch_id);
    where.push(`b.batch_id = $${params.length}`);
  }
  if (inventory_id !== undefined) {
    params.push(inventory_id);
    where.push(`i.inventory_id = $${params.length}`);
  }
  if (medication_id !== undefined) {
    params.push(medication_id);
    where.push(`i.medication_id = $${params.length}`);
  }

  // No WHERE on is_active, expiry, quarantine or quantity: every physical batch
  // is reported, with its state exposed as a column instead of a filter.
  const clause = [...(scope.clause === '' ? [] : [scope.clause]), ...where].join('');

  const safeLimit = limit ?? DEFAULT_INVENTORY_VALUATION_LIMIT;
  const safeOffset = offset ?? 0;
  params.push(safeLimit, safeOffset);

  try {
    const result = await pool.query(
      `${VALUATION_SQL}
       ${clause === '' ? '' : `WHERE 1 = 1${clause}`}
       ORDER BY b.batch_id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    // pg returns NUMERIC as text so the exact server-side value survives the
    // trip. No Number() here: converting to a double would reintroduce the
    // binary rounding this report exists to avoid. Rounding, if ever wanted, is
    // a presentation decision for the caller.
    const batches = result.rows.map((row) => ({
      batch_id: Number(row.batch_id),
      lot_number: row.lot_number,
      expiry_date: row.expiry_date,
      inventory_id: Number(row.inventory_id),
      medication_id: Number(row.medication_id),
      trade_name: row.trade_name,
      strength: row.strength,
      dosage_form: row.dosage_form,
      uom: row.uom,
      quantity_on_hand: row.quantity_on_hand,
      quantity_reserved: row.quantity_reserved,
      unit_cost: row.unit_cost,
      // Explicit status so a caller never has to infer "unvalued" from a NULL.
      valuation_status: row.unit_cost === null ? 'UNVALUED' : 'VALUED',
      inventory_value: row.inventory_value,
      is_active: row.is_active,
      is_expired: row.is_expired,
      is_quarantined: row.is_quarantined,
      quarantine_reason: row.quarantine_reason,
      quarantined_at: row.quarantined_at,
    }));

    // Totals come from the same single row-set: with no rows at all, the window
    // columns do not exist, so the empty report is spelled out explicitly.
    const head = result.rows[0];

    return res.status(200).json({
      valuation: {
        filters: {
          batch_id: batch_id ?? null,
          inventory_id: inventory_id ?? null,
          medication_id: medication_id ?? null,
        },
        totals: {
          batch_count: head === undefined ? 0 : Number(head.filtered_batch_count),
          total_quantity_on_hand: head === undefined ? '0' : head.total_quantity_on_hand,
          valued_batch_count: head === undefined ? 0 : Number(head.valued_batch_count),
          // Sum over valued batches only. Unvalued stock is counted separately
          // so the total can never be read as "this is everything we hold".
          total_inventory_value: head === undefined ? '0' : head.total_inventory_value,
          unvalued_batch_count: head === undefined ? 0 : Number(head.unvalued_batch_count),
          unvalued_quantity_on_hand: head === undefined ? '0' : head.unvalued_quantity_on_hand,
        },
        pagination: { limit: safeLimit, offset: safeOffset, returned: batches.length },
        batches,
      },
    });
  } catch (error) {
    console.error('Inventory Valuation Error:', error);
    return res.status(500).json({
      message: 'حدث خطأ في الخادم أثناء جلب تقييم المخزون',
      code: ApiErrorCode.INTERNAL_ERROR,
    });
  }
};
