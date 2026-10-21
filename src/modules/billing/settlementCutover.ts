import type { PoolClient } from 'pg';
import { ApiErrorCode } from '../../utils/apiErrors';

/* ==========================================================================
 * Phase 10G.3 — The settlement boundary
 *
 * One row, one rule, one source of truth. Every path that decides whether an
 * invoice is settled by history or by a payment ledger asks THIS module, so the
 * two invoice-creation paths and the payment path cannot drift apart on what
 * "legacy" means.
 *
 *   created_at <  cutover_at  ->  LEGACY          (assertion, read-only)
 *   created_at >= cutover_at  ->  PAYMENT-BACKED  (ledger, re-derived)
 *
 * The comparison is on created_at alone. It is never "does it have payment
 * rows": a freshly issued payment-backed invoice has none yet, and a legacy
 * invoice never will. Classifying by payment existence would freeze the first
 * and rewrite the second.
 *
 * A missing marker is not an answer. It means the database is not in a state this
 * code may write money against, so both callers fail closed with
 * SETTLEMENT_CUTOVER_MISSING rather than picking a side silently.
 * ========================================================================== */

export const SETTLEMENT_CLASSES = ['LEGACY', 'PAYMENT_BACKED'] as const;
export type SettlementClass = (typeof SETTLEMENT_CLASSES)[number];

const SELECT_CUTOVER = `SELECT cutover_at FROM settlement_cutover WHERE singleton = TRUE`;

/** Thrown when the boundary is missing — callers map this to a 503. */
export class SettlementCutoverMissingError extends Error {
  readonly code = ApiErrorCode.SETTLEMENT_CUTOVER_MISSING;

  constructor() {
    super('عتبة التسوية غير مفعّلة في قاعدة البيانات — لم تُنفَّذ 048');
    this.name = 'SettlementCutoverMissingError';
  }
}

/**
 * The one place the boundary is read. One row, enforced by 047's singleton
 * CHECK and its immutability trigger.
 */
export const readCutoverAt = async (client: PoolClient): Promise<Date> => {
  const result = await client.query(SELECT_CUTOVER);
  const row = result.rows[0];
  if (!row) throw new SettlementCutoverMissingError();
  return new Date(row.cutover_at);
};

/**
 * Classification by timestamp. `at` is the invoice's created_at for an existing
 * invoice, or the issuing moment for one that does not exist yet.
 */
export const classifyByCreatedAt = (at: Date, cutoverAt: Date): SettlementClass =>
  at.getTime() < cutoverAt.getTime() ? 'LEGACY' : 'PAYMENT_BACKED';

/**
 * The boundary, decided by the database clock.
 *
 * One query returns BOTH the moment and the classification, so the decision and
 * the rule live in the same clock domain: `cutover_at` is a TIMESTAMPTZ written
 * by 048 (server clock) and `CURRENT_TIMESTAMP` is the server clock at the moment
 * of this read. Nothing here ever touches the application's wall clock.
 *
 * This exists because `isPostCutoverNow` below compares `new Date()` — the app
 * host clock — against a database value, and a host clock behind the database
 * clock would write `paid_amount = net_amount` onto invoices whose `created_at`
 * (server clock) is already past the boundary. That invoice is then classified
 * PAYMENT_BACKED and is permanently unsettleable. The fix is to let the
 * database decide, which this function does.
 */
export const readCutoverState = async (client: PoolClient): Promise<{ cutoverAt: Date; postCutoverNow: boolean }> => {
  const result = await client.query(
    `SELECT cutover_at, (CURRENT_TIMESTAMP >= cutover_at) AS post_cutover_now
     FROM settlement_cutover
     WHERE singleton = TRUE`,
  );
  const row = result.rows[0];
  if (!row) throw new SettlementCutoverMissingError();
  return { cutoverAt: new Date(row.cutover_at), postCutoverNow: Boolean(row.post_cutover_now) };
};

/**
 * The boundary rule, expressed as a pure comparison. Kept for the rule-level
 * tests: it documents the semantics (`created_at >= cutover_at` is
 * PAYMENT_BACKED, the tie goes forward). It is NOT used to make the issuance
 * decision — that is `readCutoverState`, which evaluates the same comparison
 * inside the database.
 */
export const isPostCutoverNow = (cutoverAt: Date, now: Date = new Date()): boolean =>
  now.getTime() >= cutoverAt.getTime();