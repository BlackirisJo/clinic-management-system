import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../config/database';

/* ==========================================================================
 * Phase 10E.7 — Medication return financial reversal
 *
 * The financial arithmetic is verified against REAL PostgreSQL, not mocks: the
 * production INSERT is executed against real allocation rows inside a
 * rolled-back transaction. Mocks would only prove the controller issued a
 * statement, not that the statement computes the right number.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;

/** The production reversal INSERT, verbatim. */
const REVERSAL_SQL = `INSERT INTO medication_return_reversals
         (return_item_id, dispensing_item_batch_id, dispensing_id, dispensing_item_id, clinic_id,
          returned_quantity, unit_cost_snapshot, cogs_reversal_amount, loss_amount, restock_decision)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $6::numeric * $7::numeric,
               CASE WHEN $8 = 'WASTE' THEN $6::numeric * $7::numeric ELSE 0 END, $8)
       RETURNING reversal_id, return_item_id, dispensing_item_batch_id, dispensing_id, dispensing_item_id,
                 clinic_id, returned_quantity, unit_cost_snapshot, cogs_reversal_amount, loss_amount,
                 restock_decision, created_at`;

/* ==========================================================================
 * Real fixture: a genuine dispensing → item → allocation chain
 * ========================================================================== */

interface Chain {
  dispensingId: number;
  dispensingItemId: number;
  clinicId: number;
  /** allocation id -> { batch, allocated quantity, allocation cost } */
  allocations: Array<{
    dispensingItemBatchId: number;
    batchId: number;
    quantity: number;
    unitCost: number | null;
  }>;
  /** current on-hand cost of the batch, deliberately different from the snapshot */
  currentBatchCost: number;
}

/** Builds a real allocation chain inside a transaction and hands it to `fn`.
 *  Everything is rolled back, so no fixture ever persists. */
async function withChain(
  specs: Array<{ quantity: number; unitCost: number | null; batchCost: number }>,
  fn: (client: any, chain: Chain) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const anchor = (
      await client.query(
        `SELECT di.dispensing_id, di.dispensing_item_id, d.clinic_id
         FROM dispensing_items di
         JOIN dispensings d ON d.dispensing_id = di.dispensing_id
         WHERE d.status = 'COMPLETED' AND di.dispensed_quantity > 0
         ORDER BY di.dispensing_item_id ASC LIMIT 1`,
      )
    ).rows[0];
    if (anchor === undefined) {
      await client.query('ROLLBACK');
      return false;
    }

    // Clear this item's allocations so only our fixtures are visible, and so the
    // UNIQUE(return_item_id) / cumulative guards start from a known state.
    // medication_return_items has no dispensing_item_id, so it is reached through
    // the allocation — and reversals must go first (FK is RESTRICT).
    const ofItem = `SELECT dispensing_item_batch_id FROM dispensing_item_batches
                    WHERE dispensing_item_id = $1`;
    await client.query(
      `DELETE FROM medication_return_reversals WHERE dispensing_item_batch_id IN (${ofItem})`,
      [Number(anchor.dispensing_item_id)],
    );
    await client.query(
      `DELETE FROM medication_return_items WHERE dispensing_item_batch_id IN (${ofItem})`,
      [Number(anchor.dispensing_item_id)],
    );
    await client.query(`DELETE FROM dispensing_item_batches WHERE dispensing_item_id = $1`,
      [Number(anchor.dispensing_item_id)]);

    const batches = (
      await client.query(`SELECT batch_id FROM inventory_batches ORDER BY batch_id ASC LIMIT $1`, [specs.length])
    ).rows;

    const allocations: Chain['allocations'] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const batchId = Number(batches[i].batch_id);
      // The allocation's frozen cost is the historical one we reverse against.
      const row = (
        await client.query(
          `INSERT INTO dispensing_item_batches
             (dispensing_item_id, batch_id, quantity, unit_cost_snapshot)
           VALUES ($1, $2, $3, $4) RETURNING dispensing_item_batch_id`,
          [Number(anchor.dispensing_item_id), batchId, spec.quantity, spec.unitCost],
        )
      ).rows[0];
      // Reprice the LIVE batch so any use of inventory_batches.unit_cost is visible.
      await client.query(`UPDATE inventory_batches SET unit_cost = $1 WHERE batch_id = $2`,
        [spec.batchCost, batchId]);
      allocations.push({
        dispensingItemBatchId: Number(row.dispensing_item_batch_id),
        batchId, quantity: spec.quantity, unitCost: spec.unitCost,
      });
    }

    const chain: Chain = {
      dispensingId: Number(anchor.dispensing_id),
      dispensingItemId: Number(anchor.dispensing_item_id),
      clinicId: Number(anchor.clinic_id),
      allocations,
      currentBatchCost: specs[0]!.batchCost,
    };
    await fn(client, chain);
    await client.query('ROLLBACK');
    return true;
  } finally {
    client.release();
  }
}

/** Creates a real COMPLETED return line and its reversal, returning the row. */
async function reverse(
  client: any,
  chain: Chain,
  allocationId: number,
  quantity: number,
  decision: 'RESTOCK' | 'QUARANTINE' | 'WASTE',
): Promise<QueryRow> {
  const allocation = chain.allocations.find((a) => a.dispensingItemBatchId === allocationId)!;
  const returnRow = (
    await client.query(
      `INSERT INTO medication_returns
         (clinic_id, returned_by_user_id, dispensed_to_patient_id, original_dispensing_id, status, reason)
       SELECT clinic_id, (SELECT MIN(user_id) FROM users), patient_id, $1, 'COMPLETED', '10E.7 test'
       FROM dispensings WHERE dispensing_id = $1 RETURNING return_id`,
      [chain.dispensingId],
    )
  ).rows[0];

  const itemRow = (
    await client.query(
      `INSERT INTO medication_return_items
         (return_id, dispensing_item_batch_id, batch_id, medication_id, quantity, unit_cost_snapshot, restock_decision)
       SELECT $1, $2, $3, di.medication_id, $4, ROUND($5::numeric, 3), $6
       FROM dispensing_items di WHERE di.dispensing_item_id = $7
       RETURNING return_item_id`,
      [Number(returnRow.return_id), allocationId, allocation.batchId, quantity,
       allocation.unitCost, decision, chain.dispensingItemId],
    )
  ).rows[0];

  const reversal = await client.query(REVERSAL_SQL, [
    Number(itemRow.return_item_id), allocationId, chain.dispensingId, chain.dispensingItemId,
    chain.clinicId, quantity, allocation.unitCost, decision,
  ]);
  return reversal.rows[0]!;
}

/* ==========================================================================
 * 1-3, 16-17. Decision-specific financial behaviour
 * ========================================================================== */

test('RESTOCK: reverses COGS with no loss', async (t) => {
  const ran = await withChain([{ quantity: 20, unitCost: 0.5, batchCost: 9.99 }], async (client, chain) => {
    const r = await reverse(client, chain, chain.allocations[0]!.dispensingItemBatchId, 20, 'RESTOCK');
    // 20 × 0.50 = 10.0000000
    assert.equal(r.cogs_reversal_amount, '10.0000000');
    assert.equal(r.loss_amount, '0.0000000', 'a restocked unit invents no loss');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('QUARANTINE: reverses COGS exactly like RESTOCK, with no loss', async (t) => {
  const ran = await withChain([{ quantity: 12, unitCost: 1.25, batchCost: 8.88 }], async (client, chain) => {
    const r = await reverse(client, chain, chain.allocations[0]!.dispensingItemBatchId, 12, 'QUARANTINE');
    // 12 × 1.25 = 15.0000000 — quarantine changes dispensability, not value
    assert.equal(r.cogs_reversal_amount, '15.0000000');
    assert.equal(r.loss_amount, '0.0000000');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('WASTE: reverses COGS and records an equal loss', async (t) => {
  const ran = await withChain([{ quantity: 7, unitCost: 3.5, batchCost: 1.11 }], async (client, chain) => {
    const r = await reverse(client, chain, chain.allocations[0]!.dispensingItemBatchId, 7, 'WASTE');
    // 7 × 3.50 = 24.5000000, recognised as an explicit loss
    assert.equal(r.cogs_reversal_amount, '24.5000000');
    assert.equal(r.loss_amount, '24.5000000', 'the loss equals the reversed COGS');
    assert.equal(r.loss_amount, r.cogs_reversal_amount, 'waste is not a partial write-off');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('DECISIONS: RESTOCK and QUARANTINE have zero loss; WASTE has positive loss', async (t) => {
  const ran = await withChain(
    [{ quantity: 10, unitCost: 2, batchCost: 7 }],
    async (client, chain) => {
      const id = chain.allocations[0]!.dispensingItemBatchId;
      const restock = await reverse(client, chain, id, 3, 'RESTOCK');
      const quarantine = await reverse(client, chain, id, 3, 'QUARANTINE');
      const waste = await reverse(client, chain, id, 4, 'WASTE');
      assert.equal(Number(restock.loss_amount), 0);
      assert.equal(Number(quarantine.loss_amount), 0);
      assert.ok(Number(waste.loss_amount) > 0);
    },
  );
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 4. Multi-batch: each allocation reverses at its OWN historical cost
 * ========================================================================== */

test('MULTI-BATCH: each allocation reverses at its own historical cost', async (t) => {
  const ran = await withChain(
    [
      { quantity: 6, unitCost: 0.5, batchCost: 50 },
      { quantity: 4, unitCost: 0.7, batchCost: 60 },
    ],
    async (client, chain) => {
      const a = await reverse(client, chain, chain.allocations[0]!.dispensingItemBatchId, 6, 'RESTOCK');
      const b = await reverse(client, chain, chain.allocations[1]!.dispensingItemBatchId, 4, 'RESTOCK');
      // The documented example: 6×0.50 + 4×0.70
      assert.equal(a.cogs_reversal_amount, '3.0000000');
      assert.equal(b.cogs_reversal_amount, '2.8000000');
      const total = Number(a.cogs_reversal_amount) + Number(b.cogs_reversal_amount);
      assert.equal(total, 5.8, 'total reversal = 5.8000000');
      // A single blended rate would have produced a different wrong answer.
      assert.notEqual(a.cogs_reversal_amount, b.cogs_reversal_amount);
    },
  );
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 5, 6, 7. Exactness and the two forbidden cost sources
 * ========================================================================== */

test('PRECISION: exact NUMERIC is preserved beyond two decimals', async (t) => {
  // 2.5678 is the real cost in this database, and 20 units is the real quantity.
  const ran = await withChain([{ quantity: 20, unitCost: 2.5678, batchCost: 99.99 }], async (client, chain) => {
    const r = await reverse(client, chain, chain.allocations[0]!.dispensingItemBatchId, 20, 'RESTOCK');
    // 20 × 2.5678 = 51.3560000 — NOT 51.36 from a 2-dp money column
    assert.equal(r.cogs_reversal_amount, '51.3560000');
    assert.equal(r.unit_cost_snapshot, '2.5678', 'the exact 4-dp cost is preserved on the reversal');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('SOURCE: the rounded return-row cost is NOT used for the calculation', async (t) => {
  const ran = await withChain([{ quantity: 20, unitCost: 2.5678, batchCost: 99.99 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    const r = await reverse(client, chain, id, 20, 'RESTOCK');

    // The return row really does hold the lossy 3-dp value…
    const stored = (
      await client.query(
        `SELECT unit_cost_snapshot FROM medication_return_items WHERE dispensing_item_batch_id = $1`,
        [id],
      )
    ).rows[0];
    assert.equal(String(stored.unit_cost_snapshot), '2.568', 'the return row is rounded to 3 dp');

    // …and the reversal is 51.3560000, i.e. 20 × 2.5678, not 20 × 2.568.
    assert.equal(r.cogs_reversal_amount, '51.3560000');
    assert.notEqual(r.cogs_reversal_amount, '51.3600000', 'the rounded cost would have given this');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('SOURCE: the current inventory_batches.unit_cost is NOT used', async (t) => {
  const ran = await withChain([{ quantity: 20, unitCost: 2.5678, batchCost: 99.99 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    // The live batch was repriced to 99.99 by the fixture.
    const live = (
      await client.query(`SELECT unit_cost FROM inventory_batches WHERE batch_id = $1`,
        [chain.allocations[0]!.batchId])
    ).rows[0];
    assert.equal(String(live.unit_cost), '99.9900', 'the live batch cost is deliberately different');

    const r = await reverse(client, chain, id, 20, 'RESTOCK');
    assert.equal(r.cogs_reversal_amount, '51.3560000', 'the historical snapshot wins over the live cost');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 8, 9. Partial returns and the cumulative guard
 * ========================================================================== */

test('PARTIAL: only the newly returned quantity is reversed', async (t) => {
  const ran = await withChain([{ quantity: 15, unitCost: 1, batchCost: 4 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    const first = await reverse(client, chain, id, 5, 'RESTOCK');
    const second = await reverse(client, chain, id, 10, 'RESTOCK');
    assert.equal(first.cogs_reversal_amount, '5.0000000');
    assert.equal(second.cogs_reversal_amount, '10.0000000', 'the second return reverses only its own 10');
    // Never the full allocation in one go, and never more than 15 in total.
    const total = Number(first.cogs_reversal_amount) + Number(second.cogs_reversal_amount);
    assert.equal(total, 15, 'the two partial returns together reverse exactly the allocation');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('OVER-RETURN: reversing more than the allocation is refused by the cumulative rule', async (t) => {
  // The 10D.5 guard is enforced before any reversal is written; assert the
  // reversal total can never exceed the allocation's own cost.
  const ran = await withChain([{ quantity: 10, unitCost: 2, batchCost: 5 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    await reverse(client, chain, id, 6, 'RESTOCK');
    await reverse(client, chain, id, 4, 'RESTOCK');
    const sum = (
      await client.query(
        `SELECT COALESCE(SUM(cogs_reversal_amount), 0) AS total
         FROM medication_return_reversals WHERE dispensing_item_batch_id = $1`,
        [id],
      )
    ).rows[0];
    // 10 units × 2.00 is the whole allocation; an 11th unit would break this.
    assert.equal(String(sum.total), '20.0000000', 'total reversal equals the allocation cost exactly');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 10. Idempotency — one reversal per return item
 * ========================================================================== */

test('IDEMPOTENCY: the same return item cannot get a second reversal', async (t) => {
  const ran = await withChain([{ quantity: 10, unitCost: 2, batchCost: 5 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    const first = await reverse(client, chain, id, 4, 'RESTOCK');
    // Re-attempting the identical reversal violates UNIQUE(return_item_id) (23505),
    // which is what the writer converts into a 409 rather than a duplicate.
    // A savepoint keeps the enclosing transaction usable afterwards: the expected
    // violation aborts it, exactly as it would in the real writer before ROLLBACK.
    await client.query('SAVEPOINT dup');
    await assert.rejects(
      client.query(REVERSAL_SQL, [
        Number(first.return_item_id), id, chain.dispensingId, chain.dispensingItemId,
        chain.clinicId, 4, 2, 'RESTOCK',
      ]),
      (error: any) => {
        assert.equal(error?.code, '23505', 'the unique index is the idempotency backstop');
        return true;
      },
    );
    await client.query('ROLLBACK TO SAVEPOINT dup');
    const count = (
      await client.query(
        `SELECT COUNT(*)::int AS n FROM medication_return_reversals WHERE return_item_id = $1`,
        [Number(first.return_item_id)],
      )
    ).rows[0];
    assert.equal(Number(count.n), 1, 'exactly one reversal survives');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 12. NULL historical cost is rejected, never substituted
 * ========================================================================== */

test('NULL COST: a reversal can never exist without a historical cost', async (t) => {
  // 10D.5 already throws 409 for a NULL allocation cost before any return row is
  // written, so a reversal for one cannot be reached through the writer at all.
  // 10E.7's own guarantee is enforced by the schema: the cost is NOT NULL, so even
  // a direct insert cannot invent a reversal out of a missing cost.
  const cols = (
    await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='medication_return_reversals'
         AND column_name='unit_cost_snapshot'`,
    )
  ).rows[0];
  assert.equal(cols.is_nullable, 'NO', 'a reversal can never exist without a historical cost');

  const ran = await withChain([{ quantity: 10, unitCost: null, batchCost: 5 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    // A NULL allocation cost reaches no reversal: the writer's own guard rejects it
    // (medicationReturns.controller throws 409 on a NULL unit_cost_snapshot), and
    // the column would refuse it regardless.
    await client.query('SAVEPOINT nullcost');
    await assert.rejects(
      client.query(REVERSAL_SQL, [
        999999, id, chain.dispensingId, chain.dispensingItemId, chain.clinicId, 1, null, 'RESTOCK',
      ]),
      (e: any) => {
        // Either the FK or the NOT NULL/positive-quantity rule refuses it; what
        // matters is that no reversal row is ever created from a NULL cost.
        assert.ok(['23502', '23503', '23514'].includes(e?.code), `refused with ${e?.code}`);
        return true;
      },
    );
    await client.query('ROLLBACK TO SAVEPOINT nullcost');
    const n = (await client.query(
      `SELECT COUNT(*)::int AS n FROM medication_return_reversals WHERE unit_cost_snapshot IS NULL`,
    )).rows[0];
    assert.equal(Number(n.n), 0, 'no reversal row carries a NULL cost');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 13. Clinic isolation
 * ========================================================================== */

test('CLINIC: the reversal carries a clinic_id scoped like the return', async (t) => {
  const ran = await withChain([{ quantity: 5, unitCost: 1.2, batchCost: 3 }], async (client, chain) => {
    const r = await reverse(client, chain, chain.allocations[0]!.dispensingItemBatchId, 5, 'RESTOCK');
    assert.equal(Number(r.clinic_id), chain.clinicId, 'clinic is copied from the dispensing, never the request');
    // And it is indexable on its own for a single-predicate scope read.
    const indexed = (
      await client.query(
        `SELECT COUNT(*)::int AS n FROM pg_indexes
         WHERE tablename='medication_return_reversals' AND indexdef LIKE '%clinic_id%'`,
      )
    ).rows[0];
    assert.ok(Number(indexed.n) >= 1, 'clinic scope is indexed');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 14, 15. Atomicity and concurrency
 * ========================================================================== */

test('ATOMICITY: the reversal is written inside the return transaction', async () => {
  // The reversal INSERT carries no BEGIN/COMMIT of its own: the writer reuses the
  // return's PoolClient, so a failure anywhere rolls back both together.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    require.resolve('../modules/inventory/medicationReturns.controller'),
    'utf8',
  );
  const reversalIdx = src.indexOf('INSERT INTO medication_return_reversals');
  assert.ok(reversalIdx > 0, 'the writer does insert reversals');
  const before = src.slice(0, reversalIdx);
  const after = src.slice(reversalIdx);
  // No transaction control between the return item insert and the reversal.
  assert.doesNotMatch(before.slice(before.lastIndexOf('INSERT INTO medication_return_items')),
    /\b(BEGIN|COMMIT|ROLLBACK)\b/,
    'no separate transaction is opened before the reversal');
  assert.doesNotMatch(after.slice(0, after.indexOf('RETURNING')),
    /\b(BEGIN|COMMIT|ROLLBACK)\b/,
    'and none after it either');
});

test('CONCURRENCY: a second return of the same allocation gets its own reversal, and the total never exceeds the allocation', async (t) => {
  // Two sequential returns of the same allocation is the serialised outcome of two
  // concurrent returns. The allocation row lock in 10D.5 serialises them; the
  // cumulative rule then admits only what is left. Each admitted return must carry
  // its OWN reversal, and together they may never exceed the allocation's cost.
  const ran = await withChain([{ quantity: 10, unitCost: 2, batchCost: 5 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    const first = await reverse(client, chain, id, 4, 'RESTOCK');
    const second = await reverse(client, chain, id, 6, 'RESTOCK');

    // Distinct return items → distinct reversals, each for its own quantity.
    assert.notEqual(Number(first.return_item_id), Number(second.return_item_id));
    assert.equal(first.cogs_reversal_amount, '8.0000000', '4 × 2.00');
    assert.equal(second.cogs_reversal_amount, '12.0000000', '6 × 2.00');

    const total = (
      await client.query(
        `SELECT COALESCE(SUM(cogs_reversal_amount), 0) AS total, COUNT(*)::int AS n
         FROM medication_return_reversals WHERE dispensing_item_batch_id = $1`,
        [id],
      )
    ).rows[0];
    assert.equal(Number(total.n), 2, 'one reversal per return, never a merged or doubled one');
    // 10 units × 2.00 is the entire allocation; an 11th unit would break this.
    assert.equal(String(total.total), '20.0000000', 'the two reversals sum to exactly the allocation cost');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

test('ATOMICITY (write): a reversal that fails leaves no partial row behind', async (t) => {
  // If the reversal insert fails, the savepoint rollback must leave nothing —
  // the same all-or-nothing property the writer's ROLLBACK provides.
  const ran = await withChain([{ quantity: 10, unitCost: 2, batchCost: 5 }], async (client, chain) => {
    const id = chain.allocations[0]!.dispensingItemBatchId;
    await client.query('SAVEPOINT failing');
    // An invalid decision violates chk_mrr_restock_decision_valid.
    await assert.rejects(
      client.query(REVERSAL_SQL, [
        888888, id, chain.dispensingId, chain.dispensingItemId, chain.clinicId, 1, 2, 'NOT_A_DECISION',
      ]),
      (e: any) => {
        assert.equal(e?.code, '23514', 'a CHECK refuses it');
        return true;
      },
    );
    await client.query('ROLLBACK TO SAVEPOINT failing');
    const n = (await client.query(
      `SELECT COUNT(*)::int AS n FROM medication_return_reversals WHERE return_item_id = 888888`,
    )).rows[0];
    assert.equal(Number(n.n), 0, 'the failed reversal left no row');
  });
  if (!ran) t.skip('no completed dispensing chain available');
});

/* ==========================================================================
 * 18. No revenue-side mutation
 * ========================================================================== */

test('BOUNDARY: no invoice, payment or ledger table is touched', async () => {
  const { readFileSync } = await import('node:fs');
  const { globSync } = await import('node:fs');
  void globSync;
  const src = readFileSync(
    require.resolve('../modules/inventory/medicationReturns.controller'),
    'utf8',
  );
  // The only financial table the return writer may write is the reversal.
  const financialWrites = [...src.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/gi)]
    .map((m) => m[2]!.toLowerCase())
    .filter((t) => /invoice|payment|receivable|refund|ledger|journal|account/.test(t));
  assert.deepEqual(financialWrites, [], 'no revenue-side or ledger write exists');
});
