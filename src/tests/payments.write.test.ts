import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { recordPayment } from '../modules/billing/payments.controller';

/* ==========================================================================
 * Phase 10G.2 — Payment write path
 *
 * Three rules carry the whole phase and are what these tests exist to hold:
 *
 *   1. ONE LOCK. The invoice row, and nothing else. invoice_items is read for
 *      the clinic and never locked, because the medication-return path locks it
 *      in a different order and a second order is a deadlock.
 *   2. THE LEDGER IS THE TRUTH. invoices.paid_amount is re-derived from the
 *      live payment rows, never incremented. A cached number that can be
 *      incremented is a number that can drift.
 *   3. MONEY IN IS POSITIVE. There is no signed amount and no refund table, so
 *      a cash-out is not representable here at all.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface Scenario {
  invoice?: {
    invoice_id: number; patient_id: number; net_amount: string;
    paid_amount: string; currency_code: string; created_at: string;
  } | null;
  /** the immutable boundary; null means the row is missing entirely */
  cutoverAt?: string | null;
  /** distinct clinic_id values on the invoice's lines */
  invoiceClinics?: number[];
  /** sum of non-voided payments */
  livePaid?: string;
  /** a payment already stored under the same idempotency key */
  replay?: QueryRow | null;
  /** simulate the partial unique index losing a race at INSERT time */
  uniqueViolationAtInsert?: boolean;
  failOn?: string;
}

// Boundary in the past: every fixture invoice below is payment-backed unless a
// test moves it across the line.
const CUTOVER = '2020-01-01T00:00:00.000Z';

const DEFAULT_INVOICE = {
  invoice_id: 700, patient_id: 254, net_amount: '100.00',
  paid_amount: '0.00', currency_code: 'JOD', created_at: '2026-06-01T09:00:00.000Z',
};

const makeHandler = (s: Scenario) => {
  const invoice = s.invoice === undefined ? DEFAULT_INVOICE : s.invoice;
  const clinics = s.invoiceClinics ?? [3];
  const livePaid = s.livePaid ?? '0.00';
  const cutoverAt = s.cutoverAt === undefined ? CUTOVER : s.cutoverAt;
  // What the re-derivation must observe: the live total plus what this write adds.
  let insertedAmount = 0;

  return (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();

    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
    if (/SAVEPOINT/i.test(t)) return { rows: [], rowCount: 0 };

    if (s.failOn && t.includes(s.failOn)) {
      throw Object.assign(new Error(`simulated failure in ${s.failOn}`), { code: 'XX000' });
    }

    if (t.includes('FROM settlement_cutover')) {
      return cutoverAt === null ? { rows: [], rowCount: 0 } : { rows: [{ cutover_at: cutoverAt }], rowCount: 1 };
    }

    if (t.startsWith('SELECT invoice_id, patient_id, net_amount')) {
      return invoice === null ? { rows: [], rowCount: 0 } : { rows: [{ ...invoice }], rowCount: 1 };
    }

    if (t.includes('DISTINCT clinic_id')) {
      const rows: QueryRow[] = clinics.map((clinic_id) => ({ clinic_id }));
      return { rows, rowCount: rows.length };
    }

    if (t.includes('idempotency_key = $2')) {
      return s.replay ? { rows: [s.replay], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (t.includes('AS live_paid')) return { rows: [{ live_paid: livePaid }], rowCount: 1 };

    if (t.startsWith('INSERT INTO payments')) {
      if (s.uniqueViolationAtInsert) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      insertedAmount = Number(params[2]);
      return {
        rows: [{
          payment_id: 900, invoice_id: 700, clinic_id: params[1], amount: params[2],
          payer_type: params[3], method: params[4], currency_code: params[5],
          received_by_user_id: params[6], idempotency_key: params[7], note: params[8],
          received_at: '2026-10-03T10:00:00.000Z', created_at: '2026-10-03T10:00:00.000Z',
          voided_at: null, voided_by_user_id: null, void_reason: null,
        }],
        rowCount: 1,
      };
    }

    if (t.startsWith('UPDATE invoices')) {
      const paid = round2(Number(livePaid) + insertedAmount).toFixed(2);
      return { rows: [{ net_amount: invoice?.net_amount ?? '0', paid_amount: paid }], rowCount: 1 };
    }

    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

    return { rows: [], rowCount: 1 };
  };
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

// ACCOUNTANT carries the finance-writing set the seed really grants it, which
// includes MANAGE_SERVICES and CREATE_EXPENSE — that is what makes it a central
// finance role with scope over every clinic, exactly as createInvoice assumes.
const ACCOUNTANT = {
  userId: 7, roleId: 3, clinicId: 1, roleName: 'ACCOUNTANT',
  permissions: ['MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE', 'RECORD_PAYMENT'],
  clinicIds: [1],
};
// A holder of RECORD_PAYMENT scoped to one clinic: no central finance right, so
// financeClinicScope is that clinic and nothing else.
const CLINIC_SCOPED = {
  userId: 9, roleId: 4, clinicId: 3, roleName: 'ACCOUNTANT',
  permissions: ['RECORD_PAYMENT'], clinicIds: [3],
};
const OTHER_CLINIC = {
  userId: 10, roleId: 4, clinicId: 8, roleName: 'ACCOUNTANT',
  permissions: ['RECORD_PAYMENT'], clinicIds: [8],
};
const SUPER_ADMIN = {
  userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [], clinicIds: [],
};

const VALID_BODY = {
  invoice_id: 700, amount: 40, payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD',
};

const req = (body: Record<string, unknown>, user: unknown = ACCOUNTANT): AuthenticatedRequest =>
  ({ body, params: {}, query: {}, user } as unknown as AuthenticatedRequest);

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
): Promise<QueryCall[]> {
  const calls: QueryCall[] = [];
  const record = (text: string, params: unknown[] = []): MockResult => {
    calls.push({ text, params });
    return handler(text, params);
  };
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => record(text, params);
  (pool as unknown as { connect: unknown }).connect = async () =>
    ({ query: async (t: string, p: unknown[] = []) => record(t, p), release: () => undefined } as any);
  try {
    await run(calls);
  } finally {
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
  }
  return calls;
}

async function pay(scenario: Scenario = {}, body: Record<string, unknown> = VALID_BODY, user: unknown = ACCOUNTANT) {
  const handler = makeHandler(scenario);
  const { res, captured } = makeRes();
  const calls = await withMockedPool(handler, async () => {
    await recordPayment(req(body, user), res);
  });
  const texts = calls.map((c) => c.text.trim());
  return {
    captured,
    calls,
    texts,
    paymentInserts: calls.filter((c) => c.text.trim().startsWith('INSERT INTO payments')),
    invoiceUpdates: calls.filter((c) => c.text.trim().startsWith('UPDATE invoices')),
    audits: calls.filter((c) => c.text.trim().startsWith('INSERT INTO audit_logs')),
    wasCommitted: texts.includes('COMMIT'),
    wasRolledBack: texts.includes('ROLLBACK'),
  };
}

/* ==========================================================================
 * 1. AUTHORIZATION AND SCOPE
 * ======================================================================== */

test('AUTHZ: ACCOUNTANT يسجّل الدفعة', async () => {
  const { captured, wasCommitted } = await pay();
  assert.equal(captured.status, 201);
  assert.equal(wasCommitted, true);
});

test('AUTHZ: مستخدم عيّن على عيادة الفاتورة يسجّل، ومن عيّن على غيرها لا', async () => {
  const allowed = await pay({ invoiceClinics: [3] }, VALID_BODY, CLINIC_SCOPED);
  assert.equal(allowed.captured.status, 201, 'العيادة المسندة هي عيادة الفاتورة');

  const denied = await pay({ invoiceClinics: [3] }, VALID_BODY, OTHER_CLINIC);
  assert.equal(denied.captured.status, 404, 'فاتورة عيادة أخرى غير موجودة بالنسبة إليه');
  assert.equal(denied.paymentInserts.length, 0, 'ولا يُسجَّل شيء');
  assert.equal(denied.wasRolledBack, true);
});

test('AUTHZ: رفض عيادة أخرى لا يكشف وجود الفاتورة', async () => {
  const { captured } = await pay({ invoiceClinics: [3] }, VALID_BODY, OTHER_CLINIC);
  assert.equal(captured.body.message, 'الفاتورة المطلوبة غير موجودة');
});

test('AUTHZ: SUPER_ADMIN يتجاوز الإسناد كما يتجاوز كل شيء', async () => {
  const { captured } = await pay({ invoiceClinics: [3] }, VALID_BODY, SUPER_ADMIN);
  assert.equal(captured.status, 201, 'المدير يتعامل مع كل العيادات');
});

test('AUTHZ: المسار يطلب RECORD_PAYMENT وحدها، ولا يعيد CREATE_INVOICE', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.routes.ts'), 'utf8',
  );
  const line = source.split('\n').find((l) => l.includes("router.post('/payments'"));
  assert.ok(line, 'مسار الدفع موجود');
  assert.match(line!, /requirePermission\('RECORD_PAYMENT'\)/);
  assert.doesNotMatch(line!, /CREATE_INVOICE/);
  assert.match(line!, /validateBody\(paymentSchema\)/);
});

test('AUTHZ: FINANCIAL_AUDITOR ممنوع من التسجيل عند الوسيط', () => {
  const auditor = { user: { userId: 5, roleId: 8, clinicId: 1, roleName: 'FINANCIAL_AUDITOR', permissions: ['VIEW_INVOICES'], clinicIds: [1] } } as unknown as AuthenticatedRequest;
  let error: any = null;
  requirePermission('RECORD_PAYMENT')(auditor, { status: () => ({ json: () => undefined }) } as any, (e?: any) => { error = e ?? null; });
  assert.equal(error?.statusCode, 403);
});

test('AUTHZ: CLINIC_SCOPED لا يملك صلاحية إدارية شاملة', () => {
  // الأدوار المالية المركزية (financeClinicScope = null) ترى كل العيادات؛
  // الأدوار المالية المركزية (financeClinicScope = null) ترى كل العيادات؛ والمستخدم
  // المحصور يرى عياداته المسندة فقط. هذا هو الفرق الذي يمنع تسوية فاتورة
  const scopeRequest = req(VALID_BODY, CLINIC_SCOPED);
  assert.equal(scopeRequest.user?.clinicIds?.includes(3), true);
  const outOfScope = req(VALID_BODY, OTHER_CLINIC);
  assert.equal(outOfScope.user?.clinicIds?.includes(3), false);
});

/* ==========================================================================
 * 2. VALIDATION — refused before any database access
 * ======================================================================== */

test('VALIDATION: أي حقل يقرره الخادم في الجسم مرفوض', async () => {
  for (const field of ['clinic_id', 'received_by_user_id', 'received_at', 'paid_amount', 'net_amount', 'status']) {
    const { captured, calls } = await pay({}, { ...VALID_BODY, [field]: 1 });
    assert.equal(captured.status, 400, field);
    assert.equal(calls.length, 0, `${field} is refused before any query`);
  }
});

test('VALIDATION: مبلغ صفر أو سالب أو بدقة زائدة مرفوض', async () => {
  for (const amount of [0, -5, '0.00', '-0.01', 10.005]) {
    const { captured, calls } = await pay({}, { ...VALID_BODY, amount });
    assert.equal(captured.status, 400, `amount ${amount}`);
    assert.equal(calls.length, 0, 'قبل أي وصول لقاعدة البيانات');
  }
});

test('VALIDATION: payer_type و method محصوران بما هو مدعوم', async () => {
  for (const payer_type of ['THIRD_PARTY', 'INSURANCE', 'SPLIT', '']) {
    const { captured } = await pay({}, { ...VALID_BODY, payer_type });
    assert.equal(captured.status, 400, `payer_type ${payer_type || '(empty)'}`);
  }
  for (const method of ['INSURANCE', 'SPLIT', 'WIRE', '']) {
    const { captured } = await pay({}, { ...VALID_BODY, method });
    assert.equal(captured.status, 400, `method ${method || '(empty)'}`);
  }
});

test('VALIDATION: INSURANCE و SPLIT يبقيان مقبولين في إصدار الفاتورة ولم يُمسّا', () => {
  const validation = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'validations', 'business.validation.ts'), 'utf8',
  );
  assert.match(validation, /payment_type: z\.enum\(\['CASH', 'CARD', 'INSURANCE', 'SPLIT'\]\)/);
});

test('VALIDATION: عملة غير ثلاثية الحروف مرفوض', async () => {
  for (const currency_code of ['JO', 'JODX', '12']) {
    const { captured } = await pay({}, { ...VALID_BODY, currency_code });
    assert.equal(captured.status, 400, currency_code);
  }
});

test('VALIDATION: فاتورة غير موجودة 404 بلا كتابة', async () => {
  const { captured, paymentInserts, wasRolledBack } = await pay({ invoice: null });
  assert.equal(captured.status, 404);
  assert.equal(paymentInserts.length, 0);
  assert.equal(wasRolledBack, true);
});

/* ==========================================================================
 * 3. WRITE BEHAVIOUR
 * ======================================================================== */

test('WRITE: دفعة نقدية ناجحة تُعيد اشتقاق المدفوع من الدفعات', async () => {
  const { captured, invoiceUpdates } = await pay({ livePaid: '0.00' }, { ...VALID_BODY, amount: 40 });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, false);
  assert.equal(invoiceUpdates.length, 1, 'إعادة اشتقاق واحدة بالضبط');
  assert.match(invoiceUpdates[0]!.text, /SET paid_amount = COALESCE\(\(SELECT SUM\(amount\)/);
  assert.doesNotMatch(invoiceUpdates[0]!.text, /paid_amount\s*=\s*paid_amount/i, 'لا جمع على قيمة مقروءة');
});

test('WRITE: بطاقة ائتمانية و payer_type INSURER مساران شرعيان منفصلان', async () => {
  const card = await pay({ livePaid: '0.00' }, { ...VALID_BODY, method: 'CARD', amount: 100 });
  assert.equal(card.captured.status, 201);
  assert.equal(card.captured.body.invoice.paid_amount, 100);
  assert.equal(card.captured.body.invoice.remaining, 0);
  assert.equal(card.captured.body.invoice.status, 'PAID');

  const insurer = await pay({ livePaid: '0.00' }, { ...VALID_BODY, payer_type: 'INSURER', method: 'CASH', amount: 100 });
  assert.equal(insurer.captured.status, 201);
  assert.equal(insurer.captured.body.payment.payer_type, 'INSURER');
  assert.equal(insurer.captured.body.payment.method, 'CASH', 'المدفوع نقداً ليس بالضرورة دفعة مريض');
});

test('WRITE: التسديد الجزئي يعكس الحالة المشتقة القائمة على net و paid', async () => {
  const partial = await pay({ livePaid: '30.00', invoice: { ...DEFAULT_INVOICE, paid_amount: '30.00' } }, { ...VALID_BODY, amount: 20 });
  assert.equal(partial.captured.status, 201);
  assert.equal(partial.captured.body.invoice.status, 'PARTIAL');
  // 30.00 حياً + 20.00 جديدة = 50.00 مخزَّنة: القيمة تُشتق، لا تُقرأ من body.
  assert.equal(partial.captured.body.invoice.paid_amount, 50);
  assert.equal(partial.captured.body.invoice.remaining, 50);
});

test('WRITE: بلوغ المتبقي بالضبط مسموح، والزيادة مرفوضة', async () => {
  const exact = await pay({ livePaid: '60.00', invoice: { ...DEFAULT_INVOICE, paid_amount: '60.00' } }, { ...VALID_BODY, amount: 40 });
  assert.equal(exact.captured.status, 201, '40.00 بالضبط على صافي 100');
  assert.equal(exact.captured.body.invoice.status, 'PAID');

  const over = await pay({ livePaid: '60.00', invoice: { ...DEFAULT_INVOICE, paid_amount: '60.00' } }, { ...VALID_BODY, amount: 40.01 });
  assert.equal(over.captured.status, 409);
  assert.equal(over.captured.body.reason, 'OVERPAYMENT');
  assert.equal(over.paymentInserts.length, 0, 'لا مال يتحرك عند الرفض');
  assert.equal(over.wasRolledBack, true);
});

test('WRITE: عملة مختلفة عن عملة الفاتورة مرفوضة — لا مصدر أسعار صرف', async () => {
  const { captured, paymentInserts } = await pay({}, { ...VALID_BODY, currency_code: 'USD' });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.reason, 'CURRENCY_MISMATCH');
  assert.equal(captured.body.invoice_currency, 'JOD');
  assert.equal(paymentInserts.length, 0);
});

test('WRITE: مدفوع مخزَّن لا يطابق دفعاته لا يُبنى عليه تحصيل جديد', async () => {
  // فاتورة قديمة: paid_amount = 100 بلا أي دفعة. تأكيد بلا سند، فلا يُعاد
  // اشتقاقه فوق أساس مجهول ولا يُبنى فوقه مبلغ جديد.
  const { captured, paymentInserts, invoiceUpdates } = await pay({
    livePaid: '0.00', invoice: { ...DEFAULT_INVOICE, paid_amount: '100.00' },
  }, { ...VALID_BODY, amount: 10 });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.reason, 'SETTLEMENT_OUT_OF_SYNC');
  assert.equal(captured.body.stored_paid_amount, 100);
  assert.equal(captured.body.live_payments_total, 0);
  assert.equal(paymentInserts.length, 0);
  assert.equal(invoiceUpdates.length, 0, 'الذاكرة المخزَّنة لا تُمسّ');
});

test('WRITE: فاتورة بلا بنود أو ببنود من أكثر من عيادة تُرفض صراحةً', async () => {
  const noLines = await pay({ invoiceClinics: [] }, VALID_BODY);
  assert.equal(noLines.captured.status, 409);
  assert.equal(noLines.captured.body.reason, 'INVOICE_WITHOUT_LINES');

  const twoClinics = await pay({ invoiceClinics: [3, 8] }, VALID_BODY);
  assert.equal(twoClinics.captured.status, 409);
  assert.equal(twoClinics.captured.body.reason, 'CROSS_CLINIC_INVOICE');
  assert.deepEqual(twoClinics.captured.body.clinic_ids, [3, 8]);
});

test('WRITE: الدفعة الملغاة لا تدخل المجموع الحي', async () => {
  const { texts } = await pay();
  const liveQuery = texts.find((t) => t.includes('AS live_paid'))!;
  assert.match(liveQuery, /voided_at IS NULL/, 'المجموع الحي = غير الملغى فقط');
  const recompute = texts.find((t) => t.startsWith('UPDATE invoices'))!;
  assert.match(recompute, /voided_at IS NULL/, 'وإعادة الاشتقاق تقرأ غير الملغى أيضاً');
});

test('WRITE: clinic_id يأتي من بنود الفاتورة و received_by من التوكن', async () => {
  const { paymentInserts, captured } = await pay({ invoiceClinics: [3] }, VALID_BODY, CLINIC_SCOPED);
  const params = paymentInserts[0]!.params;
  assert.equal(params[0], 700, 'invoice_id من الطلب');
  assert.equal(params[1], 3, 'clinic_id من بنود الفاتورة لا من الجسم');
  assert.equal(params[6], 9, 'received_by_user_id من المستخدم الموثّق');
  assert.equal(captured.body.payment.clinic_id, 3);
  assert.equal(captured.body.payment.received_by_user_id, 9);
});

test('WRITE: لا حقل تاريخ في جسم الطلب — received_at من الخادم', async () => {
  const { paymentInserts } = await pay();
  const columnList = paymentInserts[0]!.text.slice(
    paymentInserts[0]!.text.indexOf('(') + 1,
    paymentInserts[0]!.text.indexOf(')'),
  );
  assert.doesNotMatch(columnList, /received_at/, 'received_at ليس عمود INSERT — قيمته افتراضية من الخادم');
  assert.doesNotMatch(columnList, /created_at/, 'created_at افتراضي من قاعدة البيانات');
  assert.ok(columnList.includes('received_by_user_id'), 'الفاعل يُسجَّل نعم، والتاريخ لا');
  assert.match(paymentInserts[0]!.text, /received_at/, ' returning ');
});

test('WRITE: تدقيق واحد داخل المعاملة قبل COMMIT', async () => {
  const { audits, texts, captured } = await pay();
  assert.equal(audits.length, 1);
  assert.match(audits[0]!.text, /'PAYMENT_RECORDED', 'PAYMENT'/);
  const auditIndex = texts.findIndex((t) => t.startsWith('INSERT INTO audit_logs'));
  const commitIndex = texts.indexOf('COMMIT');
  assert.ok(auditIndex > -1 && commitIndex > auditIndex, `التدقيق قبل COMMIT (audit=${auditIndex}, commit=${commitIndex})`);
  assert.equal(Number(captured.body.payment.amount), 40, 'المبلغ المسجَّل هو ما طُلب');
});

test('WRITE: خطأ غير متوقع يتراجع ولا يسرّب رسالة قاعدة البيانات', async () => {
  const { captured, wasRolledBack, wasCommitted } = await pay({ failOn: 'INSERT INTO payments' });
  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
  assert.doesNotMatch(String(captured.body.message), /simulated|pg|relation/i);
});

/* ==========================================================================
 * 4. IDEMPOTENCY
 * ======================================================================== */

test('IDEMPOTENCY: إعادة الطلب بنفس المفتاح لا تُنشئ دفعة ثانية', async () => {
  const { captured, paymentInserts, wasCommitted } = await pay(
    { livePaid: '100.00', replay: { payment_id: 900, invoice_id: 700, amount: '100.00', payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD', received_by_user_id: 7, received_at: '2026-10-03T10:00:00.000Z', created_at: '2026-10-03T10:00:00.000Z', voided_at: null, voided_by_user_id: null, void_reason: null } },
    { ...VALID_BODY, amount: 100, idempotency_key: 'req-1' },
  );
  assert.equal(captured.status, 200, 'إعادة الطلب ليست خطأ');
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.payment.payment_id, 900);
  assert.equal(paymentInserts.length, 0, 'لا حركة مال ثانية');
  assert.equal(wasCommitted, false);
});

test('IDEMPOTENCY: فحص التكرار يسبق فحص التجاوز', async () => {
  // الدفعة المسجَّلة نفسها تجعل المجموع مساوياً للصافي، فلو جاء فحص التجاوز
  // أولاً لَرُفض إعادة الطلب الناجح. الترتيب جزء من العقد لا تفصيل.
  const { texts } = await pay(
    { livePaid: '0.00', replay: null },
    { ...VALID_BODY, amount: 40, idempotency_key: 'req-1' },
  );
  const replayIndex = texts.findIndex((t) => t.includes('idempotency_key = $2'));
  const liveIndex = texts.findIndex((t) => t.includes('AS live_paid'));
  assert.ok(replayIndex > -1, 'استعلام المفتاح موجود');
  assert.ok(liveIndex > -1, 'وعند غياب المفتاح يُقرأ المجموع الحي');
  assert.ok(replayIndex < liveIndex, 'المفتاح يُقرأ قبل مجموع المدفوع');
});

test('IDEMPOTENCY: وجود المفتاح يوقف المسار قبل أي حساب للمجموع', async () => {
  const { texts } = await pay(
    { livePaid: '100.00', replay: { payment_id: 900, amount: '100.00' } },
    { ...VALID_BODY, amount: 100, idempotency_key: 'req-1' },
  );
  assert.ok(texts.some((t) => t.includes('idempotency_key = $2')));
  assert.equal(texts.some((t) => t.includes('AS live_paid')), false, 'لا يُقرأ المجموع أصلاً عند إعادة الطلب');
});

test('IDEMPOTENCY: تعارض الفهرس الفريد يُقرأ كإعادة طلب لا كعطل', async () => {
  const { captured, wasRolledBack } = await pay(
    { uniqueViolationAtInsert: true, replay: { payment_id: 900, amount: '40.00' } },
    { ...VALID_BODY, idempotency_key: 'req-1' },
  );
  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.payment.payment_id, 900);
  assert.equal(wasRolledBack, true, 'المعاملة تُلغى فلا يبقى إدراج ناقص');
});

test('IDEMPOTENCY: الفهرس الفريد على (invoice_id, idempotency_key) لم يُضعَف', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '047_payments.sql'), 'utf8',
  );
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_invoice_idempotency\s+ON payments \(invoice_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/);
});

/* ==========================================================================
 * 5. TRANSACTION AND LOCKING
 * ======================================================================== */

test('LOCKING: قفل واحد فقط، على الفاتورة', async () => {
  const { texts, calls } = await pay();
  const locking = calls.filter((c) => /FOR UPDATE/i.test(c.text));
  assert.equal(locking.length, 1, 'قفل واحد لا أكثر');
  assert.match(locking[0]!.text, /FROM invoices\s+WHERE invoice_id = \$1\s+FOR UPDATE/);
  const clinics = calls.find((c) => c.text.includes('DISTINCT clinic_id'))!;
  assert.doesNotMatch(clinics.text, /FOR UPDATE/i, 'بنود الفاتورة تُقرأ ولا تُقفل');
});

/** Strips SQL/JS comments so an assertion about code cannot match prose. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

test('LOCKING: لا يُقفل أي جدول آخر في أي مسار', () => {
  const source = codeOnly(fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'payments.controller.ts'), 'utf8',
  ));
  const locks = source.match(/FOR UPDATE/gi) ?? [];
  assert.equal(locks.length, 1, 'قفل واحد في الملف كله');
  assert.match(source, /FROM invoices[\s\S]{0,80}FOR UPDATE/, 'وهو قفل صف الفاتورة');
  for (const table of ['invoice_items', 'dispensings', 'dispensing_items', 'inventory_batches', 'payments']) {
    assert.doesNotMatch(source, new RegExp(`FOR UPDATE[^\\n]*${table}`), `${table} لا يُقفل أبداً`);
  }
});

test('TRANSACTION: معاملة واحدة، BEGIN قبل أول قراءة و COMMIT بعد آخر كتابة', async () => {
  const { texts } = await pay();
  const begin = texts.indexOf('BEGIN');
  const firstRead = texts.findIndex((t) => t.startsWith('SELECT'));
  const lastWrite = texts.map((t) => /^(INSERT|UPDATE)/i.test(t)).lastIndexOf(true);
  const commit = texts.indexOf('COMMIT');
  assert.equal(begin, 0, 'BEGIN أولاً');
  assert.ok(begin < firstRead, 'قبل أي قراءة');
  assert.ok(lastWrite < commit, 'COMMIT بعد كل الكتابات');
});

test('TRANSACTION: كل مسار رفض داخل المعاملة يُلغى، والرفض قبل المعاملة لا يفتحها', async () => {
  const inTransaction: Array<{ scenario: Scenario; body: Record<string, unknown>; user: unknown }> = [
    { scenario: { invoice: null }, body: VALID_BODY, user: ACCOUNTANT },
    { scenario: { invoiceClinics: [] }, body: VALID_BODY, user: ACCOUNTANT },
    { scenario: { invoiceClinics: [3, 8] }, body: VALID_BODY, user: ACCOUNTANT },
    { scenario: { invoiceClinics: [3] }, body: VALID_BODY, user: OTHER_CLINIC },
    { scenario: { invoiceClinics: [3] }, body: { ...VALID_BODY, currency_code: 'USD' }, user: ACCOUNTANT },
    { scenario: { livePaid: '60.00', invoice: { ...DEFAULT_INVOICE, paid_amount: '60.00' } }, body: { ...VALID_BODY, amount: 50 }, user: ACCOUNTANT },
    { scenario: { livePaid: '0.00', invoice: { ...DEFAULT_INVOICE, paid_amount: '100.00' } }, body: { ...VALID_BODY, amount: 5 }, user: ACCOUNTANT },
  ];
  for (const { scenario, body, user } of inTransaction) {
    const { captured, wasRolledBack, wasCommitted, calls } = await pay(scenario, body, user);
    assert.notEqual(captured.status, 201, JSON.stringify(scenario));
    assert.equal(wasRolledBack, true, `ROLLBACK for ${JSON.stringify(scenario)}`);
    assert.equal(wasCommitted, false, JSON.stringify(scenario));
    assert.equal(calls.filter((c) => /^(INSERT|UPDATE)/i.test(c.text.trim())).length, 0, 'لا كتابة قبل الرفض');
  }

  // رفض التحقق يحدث قبل أي وصول لقاعدة البيانات، فلا معاملة تُفتح أصلاً.
  const beforeDb = await pay({}, { ...VALID_BODY, amount: -1 });
  assert.equal(beforeDb.captured.status, 400);
  assert.equal(beforeDb.calls.length, 0);
  assert.equal(beforeDb.wasRolledBack, false);
});

/* ==========================================================================
 * 7. THE CUTOVER BOUNDARY (Phase 10G.3)
 * ======================================================================== */

test('CUTOVER: فاتورة صدرت قبل العتبة تُرفض ولا يُسجَّل عليها شيء', async () => {
  const legacy = await pay({
    invoice: { ...DEFAULT_INVOICE, created_at: '2019-05-01T10:00:00.000Z' },
  });
  assert.equal(legacy.captured.status, 409);
  assert.equal(legacy.captured.body.code, 'LEGACY_INVOICE_READ_ONLY');
  assert.equal(legacy.captured.body.reason, 'LEGACY_INVOICE_READ_ONLY');
  assert.equal(legacy.paymentInserts.length, 0, 'لا حركة مال على تسوية تاريخية');
  assert.equal(legacy.invoiceUpdates.length, 0, 'ولا يُمس المدفوع المؤكد');
  assert.equal(legacy.wasRolledBack, true);
});

test('CUTOVER: التصنيف بالوقت وحده — فاتورة بدفعات قديمة تبقى مقفلة', async () => {
  // A pre-cutover invoice WITH payment rows would be the wrong inference: it is
  // still legacy, because created_at is the only classification input.
  const legacyWithRows = await pay({
    invoice: { ...DEFAULT_INVOICE, created_at: '2019-05-01T10:00:00.000Z', paid_amount: '40.00' },
    livePaid: '40.00',
  });
  assert.equal(legacyWithRows.captured.status, 409);
  assert.equal(legacyWithRows.captured.body.code, 'LEGACY_INVOICE_READ_ONLY');
});

test('CUTOVER: فاتورة صدرت عند العتبة بالضبط تُعدّ مدفوعة المصدر', async () => {
  const atBoundary = await pay({
    invoice: { ...DEFAULT_INVOICE, created_at: CUTOVER },
  });
  assert.equal(atBoundary.captured.status, 201, 'created_at = cutover_at يعني بعد العتبة');
});

test('CUTOVER: غياب العتبة لا يعني لا legacies ولا بعد العتبة — يُفشل صريحاً', async () => {
  const { captured, paymentInserts, wasRolledBack, wasCommitted } = await pay({ cutoverAt: null });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.code, 'SETTLEMENT_CUTOVER_MISSING');
  assert.equal(paymentInserts.length, 0);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('CUTOVER: العتبة تُقرأ قبل قفل الفاتورة', async () => {
  const { calls } = await pay();
  const cutoverIndex = calls.findIndex((c) => c.text.includes('FROM settlement_cutover'));
  const lockIndex = calls.findIndex((c) => /FOR UPDATE/i.test(c.text));
  assert.ok(cutoverIndex > -1, 'العتبة تُقرأ');
  assert.ok(lockIndex > -1, 'والقفل موجود');
  assert.ok(cutoverIndex < lockIndex, 'قبل القفل: لا نقفل فاتورة لنرفضها بعدها');
});

/* ==========================================================================
 * 6. INVARIANTS — what this phase must not touch
 * ======================================================================== */

test('INVARIANT: لا يوجد مسار استرداد ولا جدول تخصيص ولا صرف في هذه الشاشة', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'payments.controller.ts'), 'utf8',
  );
  for (const forbidden of ['refund', 'allocation', 'gl_account', 'journal', 'dispensing', 'prescription', 'inventory']) {
    assert.doesNotMatch(source, new RegExp(`INSERT INTO ${forbidden}`, 'i'), `لا كتابة في ${forbidden}`);
    assert.doesNotMatch(source, new RegExp(`UPDATE ${forbidden}`, 'i'), `لا تحديث لـ ${forbidden}`);
  }
  assert.doesNotMatch(source, /INSERT INTO invoice_items/i, 'بنود الفاتورة لا تُكتب');
  assert.doesNotMatch(source, /DELETE FROM/i, 'لا حذف في مسار التسجيل');
});

test('INVARIANT: العتبة تُقرأ ولا تُكتب — لا يسكبها هذا المسار', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'payments.controller.ts'), 'utf8',
  );
  assert.match(source, /readCutoverAt/, 'العتبة تُقرأ قبل القفل');
  assert.doesNotMatch(source, /INSERT INTO settlement_cutover/i, 'ولا تُكتب أبداً');
  assert.doesNotMatch(source, /UPDATE settlement_cutover/i);
  assert.doesNotMatch(source, /DELETE FROM settlement_cutover/i);
});

test('INVARIANT: إصدار الفاتورة غير محصّل بعد العتبة', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.controller.ts'), 'utf8',
  );
  assert.match(controller, /issuedPaidAmount = paymentBacked \? 0 : netAmount/);
  assert.doesNotMatch(controller, /discount, netAmount, netAmount, payment_type/);
  const charge = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'medicationCharges.controller.ts'), 'utf8',
  );
  assert.match(charge, /\$4, 0, \$4, 0, 'CASH', \$5\)/, 'رسوم الدواء تبقى غير محصّلة');
});

test('INVARIANT: التقارير ولوحة المعلومات بلا تغيير', () => {
  const reports = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'reports', 'reports.controller.ts'), 'utf8',
  );
  assert.doesNotMatch(reports, /payments/i, 'التقارير لا تقرأ الدفعات بعد');
  const overview = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'views', 'OverviewView.jsx'), 'utf8',
  );
  assert.doesNotMatch(overview, /payment/i, 'ولا الواجهة');
});

test('INVARIANT: الشاشة تلمس الجداول المالية وحدها', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'payments.controller.ts'), 'utf8',
  );
  const tables = [...source.matchAll(/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/g)].map((m) => m[1]!);
  const allowed = new Set(['invoices', 'invoice_items', 'payments', 'audit_logs']);
  for (const table of tables) {
    assert.ok(allowed.has(table), `جدول غير متوقع: ${table}`);
  }
});
