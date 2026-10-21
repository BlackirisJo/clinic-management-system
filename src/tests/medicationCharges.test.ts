import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { ApiErrorCode } from '../utils/apiErrors';
import { createMedicationCharge, getDispensingCharge } from '../modules/billing/medicationCharges.controller';

/* ==========================================================================
 * Phase 10E.4 — Dispensing → invoice foundation
 *
 * Core rule under test: invoice by DISPENSING, not by prescription. Each
 * successful dispensing produces exactly one charge, priced only from the
 * snapshot frozen at dispensing time.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface ItemSpec {
  dispensing_item_id: number;
  medication_id: number;
  dispensed_quantity: string;
  unit_price_snapshot: string | null;
}

interface Scenario {
  /** dispensing_id -> header row, or null for "not found / out of scope" */
  dispensing?: {
    dispensing_id: number;
    visit_id: number;
    clinic_id: number;
    patient_id: number;
    status: string;
    dispensed_by_user_id: number;
  } | null;
  items?: ItemSpec[];
  /** an invoice charge already exists for this dispensing */
  existingInvoiceId?: number;
  failOn?: string;
  /** simulate the partial unique index losing the race */
  uniqueViolation?: boolean;
  insertLineRowCount?: number;
  /** the settlement boundary row is missing — issuance must fail closed */
  cutoverMissing?: boolean;
}

const DEFAULT_DISPENSING = {
  dispensing_id: 197, visit_id: 286, clinic_id: 1, patient_id: 254,
  status: 'COMPLETED', dispensed_by_user_id: 42,
};

const DEFAULT_ITEMS: ItemSpec[] = [
  { dispensing_item_id: 501, medication_id: 641, dispensed_quantity: '30.000', unit_price_snapshot: '2.50' },
];

const makeHandler = (s: Scenario) => {
  const dispensing = s.dispensing === undefined ? DEFAULT_DISPENSING : s.dispensing;
  const items = s.items ?? DEFAULT_ITEMS;

  return (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();

    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };

    // Phase 10G.3: the charge reads the settlement boundary before it issues.
    if (t.includes('FROM settlement_cutover')) {
      if (s.cutoverMissing) return { rows: [], rowCount: 0 };
      return { rows: [{ cutover_at: '2020-01-01T00:00:00.000Z' }], rowCount: 1 };
    }

    if (s.failOn && t.includes(s.failOn)) {
      throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
    }

    if (t.startsWith('INSERT INTO invoices')) {
      return {
        rows: [{
          invoice_id: 700, total_amount: '75.00', net_amount: '75.00',
          paid_amount: '0.00', currency_code: 'JOD',
        }],
        rowCount: 1,
      };
    }
    if (t.startsWith('INSERT INTO invoice_items')) {
      if (s.uniqueViolation) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      return { rows: [{ item_id: 900 }], rowCount: s.insertLineRowCount ?? 1 };
    }
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

    if (t.includes('FROM dispensings d')) {
      // Deny-by-default: an empty clinic array means no accessible clinic
      if (params.some((p) => Array.isArray(p) && p.length === 0)) return { rows: [], rowCount: 0 };
      return dispensing === null ? { rows: [], rowCount: 0 } : { rows: [dispensing], rowCount: 1 };
    }

    if (t.includes('FROM dispensing_items di')) {
      const rows: QueryRow[] = items
        .filter((i) => i.dispensed_quantity !== '0' && i.unit_price_snapshot !== null)
        .map((i) => ({ ...i }));
      return { rows, rowCount: rows.length };
    }

    if (t.includes('FROM invoice_items')) {
      if (s.existingInvoiceId === undefined) return { rows: [], rowCount: 0 };
      return { rows: [{ invoice_id: s.existingInvoiceId, line_count: 1 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 1 };
  };
};

const ACCOUNTANT = {
  userId: 7, roleId: 3, clinicId: 1, roleName: 'ACCOUNTANT',
  permissions: ['CREATE_INVOICE', 'VIEW_INVOICES'], clinicIds: [1],
};

const req = (
  body: Record<string, unknown> = {},
  user: unknown = ACCOUNTANT,
  params: Record<string, unknown> = {},
): AuthenticatedRequest =>
  ({ body, params, query: {}, user } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

async function withMockedPool(
  handler: (text: string, params: unknown[]) => MockResult,
  run: (calls: QueryCall[]) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  const record = (text: string, params: unknown[] = []): MockResult => {
    calls.push({ text, params });
    return handler(text, params);
  };

  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) =>
    record(text, params);
  (pool as unknown as { connect: unknown }).connect = async () =>
    ({ query: async (t: string, p: unknown[] = []) => record(t, p), release: () => undefined } as any);

  try {
    await run(calls);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
}

async function chargeCapturing(scenario: Scenario = {}, body: Record<string, unknown> = { dispensing_id: 197 }) {
  const calls: QueryCall[] = [];
  const handler = makeHandler(scenario);
  const { res, captured } = makeRes();

  await withMockedPool(handler, async () => {
    const recording = (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return handler(text, params);
    };
    (pool as unknown as { query: unknown }).query = async (t: string, p: unknown[] = []) => recording(t, p);
    (pool as unknown as { connect: unknown }).connect = async () =>
      ({ query: async (t: string, p: unknown[] = []) => recording(t, p), release: () => undefined } as any);
    await createMedicationCharge(req(body), res);
  });

  return {
    captured,
    calls,
    invoiceInserts: calls.filter((c) => c.text.trim().startsWith('INSERT INTO invoices')),
    lineInserts: calls.filter((c) => c.text.trim().startsWith('INSERT INTO invoice_items')),
    audits: calls.filter((c) => c.text.trim().startsWith('INSERT INTO audit_logs')),
    wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
    wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    writes: calls
      .map((c) => c.text.trim())
      .filter((t) => /^(INSERT|UPDATE|DELETE)/i.test(t))
      .map((t) => t.split(/\s+/).slice(0, 4).join(' ')),
  };
}

/* ==========================================================================
 * 1. ONE CHARGE PER DISPENSING
 * ========================================================================== */

test('CHARGE: a completed dispensing produces exactly one invoice and one line per item', async () => {
  const { captured, invoiceInserts, lineInserts } = await chargeCapturing();

  assert.equal(captured.status, 201);
  assert.equal(invoiceInserts.length, 1, 'exactly one invoice');
  assert.equal(lineInserts.length, 1, 'one line for the one dispensing item');
  assert.equal(captured.body.line_count, 1);
});

test('CHARGE: the invoice line carries the dispensing, item and medication references', async () => {
  const { lineInserts } = await chargeCapturing();
  const insert = lineInserts[0]!;

  assert.match(insert.text, /dispensing_id/, 'dispensing_id is preserved');
  assert.match(insert.text, /dispensing_item_id/, 'dispensing_item_id is preserved');
  assert.match(insert.text, /medication_id/, 'medication_id is preserved');

  assert.equal(insert.params[2], 197, 'dispensing_id');
  assert.equal(insert.params[3], 501, 'dispensing_item_id');
  assert.equal(insert.params[4], 641, 'medication_id');
});

test('CHARGE: identity comes from the dispensing, never from the request', async () => {
  const { invoiceInserts, lineInserts } = await chargeCapturing();

  // patient 254 / visit 286 / clinic 1 all come from the dispensing row
  assert.equal(invoiceInserts[0]!.params[0], 254, 'patient_id from the dispensing');
  assert.equal(invoiceInserts[0]!.params[1], 286, 'visit_id from the dispensing');
  assert.equal(lineInserts[0]!.params[1], 1, 'clinic_id from the dispensing');
});

/* ==========================================================================
 * 2. QUANTITY AND PRICE SOURCES
 * ========================================================================== */

test('PRICE: the line uses the frozen snapshot and never reads current pricing', async () => {
  const { calls, lineInserts } = await chargeCapturing();

  for (const call of calls) {
    assert.ok(
      !/FROM medication_prices/.test(call.text),
      'medication_prices must never be read during invoice creation',
    );
  }

  // unit_price_snapshot 2.50, dispensed 30 -> line_total 75.00
  assert.equal(lineInserts[0]!.params[6], '2.50', 'frozen unit price');
  assert.equal(lineInserts[0]!.params[5], '30.000', 'actual dispensed quantity');
  assert.equal(Number(lineInserts[0]!.params[7]), 75, 'line total from the snapshot');
});

test('PRICE: a fractional dispensed quantity produces a correct line total', async () => {
  const { captured, lineInserts } = await chargeCapturing({
    items: [{ dispensing_item_id: 502, medication_id: 641, dispensed_quantity: '2.500', unit_price_snapshot: '1.75' }],
  });

  assert.equal(captured.status, 201);
  // 2.5 x 1.75 = 4.375 -> 4.38
  assert.equal(lineInserts[0]!.params[7], '4.38', 'fractional quantity is charged exactly');
  assert.equal(captured.body.total_amount, 4.38);
});

test('PRICE: price carries the line total and quantity 1, so existing revenue math still holds', async () => {
  const { lineInserts } = await chargeCapturing();
  const insert = lineInserts[0]!;

  // The legacy columns are reused deliberately: SUM(price * quantity) must
  // equal the medication revenue without any report being rewritten.
  assert.match(insert.text, /line_total, price, quantity,/);
  assert.equal(Number(insert.params[7]), 75, 'price holds the line total (bound as $8)');
  // The column list gained medication_discount_value in 10E.8, so the VALUES
  // tail is asserted instead of the closing paren. price still repeats $8 and
  // quantity is still 1: SUM(price * quantity) is unchanged.
  assert.match(insert.text, /\$8, \$8, 1, 0\)/, 'price = line_total, quantity = 1, discount 0');
  assert.match(insert.text, /service_id, dispensing_id/, 'service_id is explicitly NULL');
});

test('PRICE: a zero selling price yields a zero-value line, not a missing line', async () => {
  const { captured, lineInserts } = await chargeCapturing({
    items: [{ dispensing_item_id: 503, medication_id: 641, dispensed_quantity: '10.000', unit_price_snapshot: '0.00' }],
  });

  assert.equal(captured.status, 201);
  assert.equal(Number(lineInserts[0]!.params[7]), 0, 'a free drug is a real zero-value line');
  assert.equal(captured.body.total_amount, 0);
});

test('PRICE: items without a frozen snapshot are not charged from the current price', async () => {
  const { captured, writes } = await chargeCapturing({
    items: [{ dispensing_item_id: 504, medication_id: 641, dispensed_quantity: '30.000', unit_price_snapshot: null }],
  });

  assert.equal(captured.status, 409, 'a pre-10E.3 row cannot be priced from today’s price');
  assert.equal(captured.body.reason, 'NOTHING_CHARGEABLE');
  assert.deepEqual(writes, [], 'and nothing is written');
});

test('PRICE: a price change after dispensing does not change the charge', async () => {
  // The charge reads only dispensing_items.unit_price_snapshot; a later price
  // row with a different amount is irrelevant because it is never queried.
  const { calls, lineInserts } = await chargeCapturing();

  assert.equal(lineInserts[0]!.params[6], '2.50');
  assert.ok(!calls.some((c) => /medication_prices/.test(c.text)), 'current pricing is never consulted');
});

/* ==========================================================================
 * 3. DUPLICATE PREVENTION
 * ========================================================================== */

test('DUPLICATE: an already-charged dispensing is refused with 409', async () => {
  const { captured, writes } = await chargeCapturing({ existingInvoiceId: 700 });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, ApiErrorCode.FORBIDDEN);
  assert.equal(captured.body.reason, 'ALREADY_INVOICED');
  assert.equal(captured.body.invoice_id, 700, 'the existing invoice is reported');
  assert.deepEqual(writes, [], 'no second invoice, no second line');
});

test('DUPLICATE: the lost unique-index race surfaces as 409, never as 500', async () => {
  const { captured } = await chargeCapturing({ uniqueViolation: true });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.reason, 'ALREADY_INVOICED');
});

test('DUPLICATE: the pre-insert check runs and the refusal happens before any invoice exists', async () => {
  const { calls, writes } = await chargeCapturing({ existingInvoiceId: 700 });

  const checkIndex = calls.findIndex((c) => c.text.includes('FROM invoice_items'));
  assert.ok(checkIndex >= 0, 'the existing-charge check runs');

  const invoiceIndex = calls.findIndex((c) => c.text.trim().startsWith('INSERT INTO invoices'));
  assert.equal(invoiceIndex, -1, 'the refusal happens before the invoice is ever created');
  assert.deepEqual(writes, []);
});

test('DUPLICATE: the dispensing row is locked, so the check cannot race', async () => {
  const { calls } = await chargeCapturing();

  const lock = calls.find((c) => c.text.includes('FROM dispensings d'))!;
  assert.ok(lock, 'the dispensing is locked');
  assert.match(lock.text, /FOR UPDATE/, 'FOR UPDATE, so a concurrent charge waits');
  assert.ok(!/SKIP LOCKED/i.test(lock.text), 'no SKIP LOCKED');
});

/* ==========================================================================
 * 4. PARTIAL / REPEAT DISPENSING
 * ========================================================================== */

test('PARTIAL: a partial dispensing is charged on its own quantities', async () => {
  const { captured, lineInserts } = await chargeCapturing({
    dispensing: { ...DEFAULT_DISPENSING, status: 'PARTIAL' },
    items: [{ dispensing_item_id: 511, medication_id: 641, dispensed_quantity: '10.000', unit_price_snapshot: '2.50' }],
  });

  assert.equal(captured.status, 201);
  assert.equal(lineInserts[0]!.params[5], '10.000');
  assert.equal(captured.body.total_amount, 25);
});

test('REPEAT: two dispensings of one prescription each produce their own charge', async () => {
  // Keyed on dispensing_id, so a repeat cannot collapse into the first charge.
  const first = await chargeCapturing({
    dispensing: { ...DEFAULT_DISPENSING, dispensing_id: 197 },
    items: [{ dispensing_item_id: 501, medication_id: 641, dispensed_quantity: '10.000', unit_price_snapshot: '2.50' }],
  });
  const second = await chargeCapturing({
    dispensing: { ...DEFAULT_DISPENSING, dispensing_id: 198 },
    items: [{ dispensing_item_id: 502, medication_id: 641, dispensed_quantity: '20.000', unit_price_snapshot: '2.50' }],
  });

  assert.equal(first.captured.status, 201);
  assert.equal(second.captured.status, 201);
  assert.equal(first.lineInserts[0]!.params[2], 197, 'first charge points at dispensing 197');
  assert.equal(second.lineInserts[0]!.params[2], 198, 'second charge points at dispensing 198');
  assert.notEqual(
    first.lineInserts[0]!.params[3], second.lineInserts[0]!.params[3],
    'distinct dispensing_item_ids, so neither collides with the other',
  );
});

test('VOIDED: a voided dispensing is never invoiced', async () => {
  const { captured, writes } = await chargeCapturing({
    dispensing: { ...DEFAULT_DISPENSING, status: 'VOIDED' },
  });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.status, 'VOIDED');
  assert.deepEqual(writes, []);
});

/* ==========================================================================
 * 5. CLIENT FORGERY
 * ========================================================================== */

test('FORGERY: a client-supplied identity, price or quantity is rejected before any DB access', async () => {
  let connectCalled = false;
  (pool as unknown as { connect: unknown }).connect = async () => {
    connectCalled = true;
    throw new Error('must not reach the database');
  };

  const forgeries: Record<string, unknown>[] = [
    { clinic_id: 2 },
    { patient_id: 999 },
    { visit_id: 999 },
    { medication_id: 999 },
    { quantity: 1 },
    { price: 0.01 },
    { unit_price_snapshot: 0.01 },
    { dispensed_quantity: '9999' },
    { line_total: 0.01 },
    { total_amount: 0.01 },
    { net_amount: 0.01 },
    { paid_amount: 9999 },
    { invoice_id: 1 },
    { service_id: 1 },
    { items: [] },
    { prescription_id: 204 },
    { inventory_item_id: 641 },
  ];

  try {
    for (const forgery of forgeries) {
      const { res, captured } = makeRes();
      await createMedicationCharge(req({ dispensing_id: 197, ...forgery }), res);
      assert.equal(
        captured.status, 400,
        `${Object.keys(forgery)[0]} must be refused`,
      );
    }
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(connectCalled, false, 'forgery never reaches the database');
});

test('FORGERY: a hostile body cannot redirect the price or the clinic', async () => {
  const { invoiceInserts, lineInserts } = await chargeCapturing({}, {
    dispensing_id: 197,
  });

  assert.equal(invoiceInserts[0]!.params[0], 254);
  assert.equal(lineInserts[0]!.params[1], 1);
});

test('FORGERY: an invalid dispensing_id is rejected as a validation error', async () => {
  for (const id of [0, -1, 'abc']) {
    const { res, captured } = makeRes();
    await createMedicationCharge(req({ dispensing_id: id }), res);
    assert.equal(captured.status, 400);
  }
});

/* ==========================================================================
 * 6. SCOPE AND ELIGIBILITY
 * ========================================================================== */

test('SCOPE: a dispensing outside the user clinics is reported as not found', async () => {
  const { captured, writes } = await chargeCapturing({ dispensing: null });

  assert.equal(captured.status, 404);
  assert.deepEqual(writes, [], 'nothing is written for an out-of-scope dispensing');
});

test('SCOPE: the dispensing lookup is scoped in SQL, not filtered afterwards', async () => {
  const { calls } = await chargeCapturing();

  const lock = calls.find((c) => c.text.includes('FROM dispensings d'))!;
  assert.match(lock.text, /d\.clinic_id = ANY\(\$2::int\[\]\)/, 'scope enforced in the query');
  assert.deepEqual(lock.params[1], [1]);
});

test('SCOPE: a dispensing with nothing chargeable is refused, not zero-invoiced', async () => {
  const { captured, writes } = await chargeCapturing({ items: [] });

  assert.equal(captured.status, 409);
  assert.equal(captured.body.reason, 'NOTHING_CHARGEABLE');
  assert.deepEqual(writes, []);
});

/* ==========================================================================
 * 7. TRANSACTION INTEGRITY
 * ========================================================================== */

test('TRANSACTION: the whole charge is one transaction', async () => {
  const { calls, wasCommitted } = await chargeCapturing();

  const begin = calls.findIndex((c) => c.text === 'BEGIN');
  const lock = calls.findIndex((c) => c.text.includes('FROM dispensings d'));
  const invoice = calls.findIndex((c) => c.text.trim().startsWith('INSERT INTO invoices'));
  const line = calls.findIndex((c) => c.text.trim().startsWith('INSERT INTO invoice_items'));
  const audit = calls.findIndex((c) => c.text.trim().startsWith('INSERT INTO audit_logs'));
  const commit = calls.findIndex((c) => c.text === 'COMMIT');

  assert.equal(wasCommitted, true);
  assert.ok(begin < lock && lock < invoice && invoice < line && line < audit && audit < commit,
    'lock → invoice → lines → audit → commit, all inside one transaction');
});

test('TRANSACTION: a mid-charge failure leaves nothing behind', async () => {
  const { captured, wasRolledBack, wasCommitted, invoiceInserts, lineInserts } =
    await chargeCapturing({ failOn: 'INSERT INTO invoice_items' });

  assert.notEqual(captured.status, 201);
  assert.equal(invoiceInserts.length, 1, 'the invoice insert was issued...');
  assert.equal(lineInserts.length, 1, '...and then the line insert failed');
  assert.equal(wasRolledBack, true, 'rolled back');
  assert.equal(wasCommitted, false, 'not committed');
});

/* ==========================================================================
 * 8. NO PAYMENTS, SERVICES UNTOUCHED
 * ========================================================================== */

test('PAYMENT: the charge is issued unpaid and creates no payment', async () => {
  const { captured, invoiceInserts, calls } = await chargeCapturing();

  assert.equal(captured.body.paid_amount, 0);
  const invoiceInsert = invoiceInserts[0]!;
  // net = total, paid = 0, discount = 0 — hardcoded, never client-driven
  assert.match(invoiceInsert.text, /\$4, 0, \$4, 0, 'CASH'/);
  assert.equal(Number(invoiceInsert.params[3]), 75, 'total = net, paid = 0');

  for (const call of calls) {
    assert.ok(!/INSERT INTO payments/i.test(call.text), 'no payment row');
    assert.ok(!/refund/i.test(call.text), 'no refund');
  }
});

test('CUTOVER: a missing settlement marker refuses the charge instead of issuing it', async () => {
  const { captured, invoiceInserts, lineInserts, calls, writes, wasRolledBack, wasCommitted } =
    await chargeCapturing({ cutoverMissing: true });

  // The marker is the gate, not the amount: this charge is born unpaid either way,
  // so what the missing row proves is that the database is not settlement-ready.
  // Failing closed is the point — issuance must not silently continue.
  assert.equal(captured.status, 503);
  assert.equal(captured.body.code, ApiErrorCode.SETTLEMENT_CUTOVER_MISSING);
  assert.deepEqual(writes, [], 'nothing is written without a settlement boundary');
  assert.equal(invoiceInserts.length, 0);
  assert.equal(lineInserts.length, 0);
  assert.ok(!calls.some((c) => /INSERT INTO payments/i.test(c.text)), 'and no payment either');
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('CUTOVER: the boundary is read before the invoice is written', async () => {
  const { calls } = await chargeCapturing();
  const cutoverIndex = calls.findIndex((c) => c.text.includes('FROM settlement_cutover'));
  const invoiceIndex = calls.findIndex((c) => c.text.trim().startsWith('INSERT INTO invoices'));
  assert.ok(cutoverIndex > -1, 'the boundary is read');
  assert.ok(invoiceIndex > cutoverIndex, 'before any invoice exists');
});

test('SERVICES: a medication line never references clinic_services', async () => {
  const { lineInserts } = await chargeCapturing();

  for (const line of lineInserts) {
    assert.ok(!line.params.includes(1) || line.params[5] !== 1, 'service_id is not bound');
    assert.match(line.text, /service_id, dispensing_id/, 'service_id is explicitly NULL');
  }
});

test('SERVICES: the existing clinic-service invoice path is untouched', async () => {
  // The medication line insert must not write clinic_services, and must not
  // carry a doctor share: a drug has no doctor_percentage in this model.
  const { calls } = await chargeCapturing();

  for (const call of calls) {
    assert.ok(!/clinic_services/i.test(call.text), 'clinic_services is never read or written');
  }
  const line = calls.find((c) => c.text.trim().startsWith('INSERT INTO invoice_items'))!;
  assert.ok(!/doctor_share/i.test(line.text), 'no doctor share on a medication line');
});

test('AUDIT: exactly one DISPENSING_INVOICED audit row is written', async () => {
  const { audits } = await chargeCapturing();

  assert.equal(audits.length, 1);
  assert.match(audits[0]!.text, /'DISPENSING_INVOICED'/);
  assert.equal(audits[0]!.params[1], 1, 'audit clinic is the dispensing clinic');
  assert.equal(Number(audits[0]!.params[2]), 700, 'audit resource_id is the new invoice id');

  const metadata = JSON.parse(audits[0]!.params[3] as string);
  assert.equal(metadata.dispensing_id, 197);
  assert.equal(metadata.clinic_id, 1);
  assert.equal(metadata.total_amount, 75);
});

/* ==========================================================================
 * 9. READ ENDPOINT
 * ========================================================================== */

test('READ: an uncharged dispensing reports invoiced = false', async () => {
  const { res, captured } = makeRes();
  await withMockedPool(makeHandler({}), async () => {
    await getDispensingCharge(req({}, ACCOUNTANT, { id: '197' }), res);
  });

  assert.equal(captured.status, 200);
  assert.equal(captured.body.invoiced, false);
});

test('READ: a charged dispensing reports its invoice', async () => {
  const handler = makeHandler({ existingInvoiceId: 700 });
  const { res, captured } = makeRes();

  await withMockedPool(handler, async () => {
    (pool as unknown as { query: unknown }).query = async () => ({
      rows: [{ invoice_id: 700, total_amount: '75.00', net_amount: '75.00', paid_amount: '0.00', created_at: '2026-01-01', line_count: 1 }],
      rowCount: 1,
    });
    await getDispensingCharge(req({}, ACCOUNTANT, { id: '197' }), res);
  });

  assert.equal(captured.status, 200);
  assert.equal(captured.body.invoiced, true);
  assert.equal(captured.body.invoice.invoice_id, 700);
});

test('READ: an out-of-scope dispensing is a 404', async () => {
  const { res, captured } = makeRes();

  await withMockedPool(makeHandler({ dispensing: null }), async () => {
    await getDispensingCharge(req({}, ACCOUNTANT, { id: '197' }), res);
  });

  assert.equal(captured.status, 404);
});

/* ==========================================================================
 * 10. AUTHORIZATION — no new permission, CREATE_INVOICE reused
 * ========================================================================== */

test('AUTHORIZATION: the charge uses the existing CREATE_INVOICE permission', () => {
  const runMiddleware = (permission: string, roleName: string, permissions: string[]) => {
    const r = { user: { userId: 7, roleId: 3, clinicId: 1, roleName, permissions } } as unknown as AuthenticatedRequest;
    let error: any = null;
    let nextCalled = false;
    requirePermission(permission)(r, { status: () => ({ json: () => {} }) } as any, (err?: any) => {
      if (err) error = err;
      else nextCalled = true;
    });
    return { error, nextCalled };
  };

  // Dispensing a drug is not authority to bill for it
  const denied = runMiddleware('CREATE_INVOICE', 'PHARMACIST', ['DISPENSE_MEDICATIONS', 'VIEW_INVOICES']);
  assert.equal(denied.nextCalled, false, 'a pharmacist cannot issue invoices');
  assert.equal(denied.error?.code, ApiErrorCode.FORBIDDEN);

  const allowed = runMiddleware('CREATE_INVOICE', 'ACCOUNTANT', ['CREATE_INVOICE']);
  assert.equal(allowed.nextCalled, true);

  const allowedAdmin = runMiddleware('CREATE_INVOICE', 'SYSTEM_ADMIN', []);
  assert.equal(allowedAdmin.nextCalled, true, 'admins bypass the permission check');
});

test('UNAUTHENTICATED: without a session user no charge is attempted', async () => {
  let connectCalled = false;
  (pool as unknown as { connect: unknown }).connect = async () => {
    connectCalled = true;
    throw new Error('must not reach the database');
  };

  const { res, captured } = makeRes();
  try {
    await createMedicationCharge(req({ dispensing_id: 197 }, { clinicId: 1, roleName: 'ACCOUNTANT' }), res);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }

  assert.equal(connectCalled, false);
  assert.equal(captured.status, 400);
});