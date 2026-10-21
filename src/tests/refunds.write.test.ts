import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { recordRefund } from '../modules/billing/refunds.controller';

/* ==========================================================================
 * Phase 10G.4b — refund write path
 *
 * Four properties carry the phase, and these tests exist to hold each one:
 *
 *   1. THE INVOICE IS NOT TOUCHED. A refund does not reduce invoices.paid_amount.
 *      If it did, "amount paid" would become net cash and a patient who paid in
 *      full and was refunded in full would read UNPAID. There is no UPDATE
 *      invoices anywhere in this path, and the tests prove it by absence.
 *   2. THE LOCK IS THE PAYMENT. Not the invoice. Two refunds of the SAME payment
 *      must serialise; two refunds of DIFFERENT payments of the SAME invoice must
 *      not need to. Locking the invoice would make the second case wait for
 *      nothing, and would couple this path to the payment path's lock.
 *   3. BOTH CAPS ARE LIVE AGGREGATES. The payment cap is what actually arrived;
 *      the credit cap is the entitlement minus what it already discharged.
 *      Neither is read from a cached column, because a stale snapshot must be
 *      able to neither authorise nor block a refund.
 *   4. NOTHING SERVER-DECIDED IS ACCEPTED FROM THE CLIENT. The invoice, the
 *      clinic, the payer and the method are all copied from the payment.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

interface Scenario {
  payment?: {
    payment_id: number; invoice_id: number; clinic_id: number; amount: string;
    payer_type: string; method: string; currency_code: string; voided_at: string | null;
  } | null;
  /** the immutable boundary; null means the marker row is missing */
  cutoverAt?: string | null;
  invoiceCreatedAt?: string | null;
  /** distinct clinic_id values on the invoice's lines */
  invoiceClinics?: number[];
  /** SUM(live refunds) on this payment */
  refundedOnPayment?: string;
  /** a refund already stored under the same idempotency key */
  replay?: QueryRow | null;
  /** simulate the partial unique index losing a race at INSERT time */
  uniqueViolationAtInsert?: boolean;
  // The 044 entitlement. It is MANDATORY for reason = RETURN_CREDIT (049's
  // chk_refunds_return_credit_needs_credit), so the default is a real credit and
  // `credit: null` is reserved for the tests that assert its absence.
  credit?: {
    credit_id: number; invoice_id: number; currency_code: string; refund_due_amount: string;
  } | null;
  /** SUM(live refunds) charged against that credit */
  refundedOnCredit?: string;
  failOn?: string;
}

// The boundary in the past, so every fixture invoice is payment-backed unless a
// test moves it across the line.
const CUTOVER = '2020-01-01T00:00:00.000Z';

const DEFAULT_PAYMENT = {
  payment_id: 500, invoice_id: 700, clinic_id: 3, amount: '100.00',
  payer_type: 'PATIENT', method: 'CASH', currency_code: 'JOD', voided_at: null,
};

const DEFAULT_CREDIT = {
  credit_id: 40, invoice_id: 700, currency_code: 'JOD', refund_due_amount: '30.00',
};

const REFUND_ROW = (params: unknown[]) => ({
  refund_id: 800, payment_id: params[0], invoice_id: params[1], clinic_id: params[2],
  amount: params[3], payer_type: params[4], method: params[5], currency_code: params[6],
  credit_id: params[7], reason: params[8], reason_note: params[9],
  refunded_by_user_id: params[10], idempotency_key: params[11],
  refunded_at: '2026-10-04T10:00:00.000Z', created_at: '2026-10-04T10:00:00.000Z',
  voided_at: null, voided_by_user_id: null, void_reason: null,
});

const makeHandler = (s: Scenario) => {
  const payment = s.payment === undefined ? DEFAULT_PAYMENT : s.payment;
  const credit = s.credit === undefined ? DEFAULT_CREDIT : s.credit;
  const clinics = s.invoiceClinics ?? [3];
  const createdAt = s.invoiceCreatedAt === undefined ? '2026-06-01T09:00:00.000Z' : s.invoiceCreatedAt;
  const refundedOnPayment = s.refundedOnPayment ?? '0.00';
  const refundedOnCredit = s.refundedOnCredit ?? '0.00';
  const cutoverAt = s.cutoverAt === undefined ? CUTOVER : s.cutoverAt;
  let insertParams: unknown[] = [];

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

    if (t.startsWith('SELECT payment_id, invoice_id, clinic_id')) {
      return payment === null ? { rows: [], rowCount: 0 } : { rows: [{ ...payment }], rowCount: 1 };
    }

    if (t.startsWith('SELECT created_at FROM invoices')) {
      return createdAt === null ? { rows: [], rowCount: 0 } : { rows: [{ created_at: createdAt }], rowCount: 1 };
    }

    if (t.includes('DISTINCT clinic_id')) {
      const rows: QueryRow[] = clinics.map((clinic_id) => ({ clinic_id }));
      return { rows, rowCount: rows.length };
    }

    if (t.includes('idempotency_key = $2')) {
      return s.replay ? { rows: [s.replay], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (t.startsWith('SELECT credit_id, invoice_id, currency_code')) {
      return credit === null ? { rows: [], rowCount: 0 } : { rows: [{ ...credit }], rowCount: 1 };
    }

    // Two different live aggregates: one per payment, one per credit. Keyed on
    // the WHERE column so the test can tell them apart.
    if (t.includes('AS refunded')) {
      return t.includes('WHERE credit_id = $1')
        ? { rows: [{ refunded: refundedOnCredit }], rowCount: 1 }
        : { rows: [{ refunded: refundedOnPayment }], rowCount: 1 };
    }

    if (t.startsWith('INSERT INTO refunds')) {
      if (s.uniqueViolationAtInsert) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      insertParams = params;
      return { rows: [REFUND_ROW(params)], rowCount: 1 };
    }

    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };

    return { rows: [], rowCount: 1 };
  };
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const ACCOUNTANT = {
  userId: 7, roleId: 3, clinicId: 1, roleName: 'ACCOUNTANT',
  permissions: ['MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE', 'RECORD_PAYMENT', 'RECORD_REFUND'],
  clinicIds: [1],
};
// No central finance right, so financeClinicScope is exactly these clinics.
const CLINIC_SCOPED = {
  userId: 9, roleId: 4, clinicId: 3, roleName: 'ACCOUNTANT',
  permissions: ['RECORD_REFUND'], clinicIds: [3],
};
const OTHER_CLINIC = {
  userId: 10, roleId: 4, clinicId: 8, roleName: 'ACCOUNTANT',
  permissions: ['RECORD_REFUND'], clinicIds: [8],
};
const SUPER_ADMIN = {
  userId: 1, roleId: 1, clinicId: null, roleName: 'SUPER_ADMIN',
  permissions: [], clinicIds: [],
};

const VALID_BODY = { payment_id: 500, amount: 20, currency_code: 'JOD', reason: 'RETURN_CREDIT', credit_id: 40 };

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

async function refund(
  scenario: Scenario = {},
  body: Record<string, unknown> = VALID_BODY,
  user: unknown = ACCOUNTANT,
) {
  const handler = makeHandler(scenario);
  const { res, captured } = makeRes();
  const calls = await withMockedPool(handler, async () => {
    await recordRefund(req(body, user), res);
  });
  const texts = calls.map((c) => c.text.trim());
  return {
    captured,
    calls,
    texts,
    refundInserts: calls.filter((c) => c.text.trim().startsWith('INSERT INTO refunds')),
    audits: calls.filter((c) => c.text.trim().startsWith('INSERT INTO audit_logs')),
    writes: calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.text.trim())),
    wasCommitted: texts.includes('COMMIT'),
    wasRolledBack: texts.includes('ROLLBACK'),
  };
}

/* ==========================================================================
 * 1. AUTHORIZATION AND SCOPE
 * ======================================================================== */

test('AUTHZ: ACCOUNTANT يسجّل استرداداً', async () => {
  const { captured, wasCommitted } = await refund();
  assert.equal(captured.status, 201);
  assert.equal(wasCommitted, true);
});

test('AUTHZ: عيادة أخرى محجوبة ولا يُكشف وجود الدفعة', async () => {
  const allowed = await refund({ invoiceClinics: [3] }, VALID_BODY, CLINIC_SCOPED);
  assert.equal(allowed.captured.status, 201, 'العيادة المسندة هي عيادة الدفعة');

  const denied = await refund({ invoiceClinics: [3] }, VALID_BODY, OTHER_CLINIC);
  assert.equal(denied.captured.status, 404);
  assert.equal(denied.captured.body.message, 'الدفعة المطلوبة غير موجودة');
  assert.equal(denied.refundInserts.length, 0, 'ولا يُسجَّل شيء');
  assert.equal(denied.wasRolledBack, true);
});

test('AUTHZ: SUPER_ADMIN يتجاوز الإسناد', async () => {
  const { captured } = await refund({ invoiceClinics: [3] }, VALID_BODY, SUPER_ADMIN);
  assert.equal(captured.status, 201);
});

test('AUTHZ: FINANCIAL_AUDITOR ممنوع عند الوسيط', () => {
  const auditor = {
    user: { userId: 5, roleId: 8, clinicId: 1, roleName: 'FINANCIAL_AUDITOR', permissions: ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS'], clinicIds: [1] },
  } as unknown as AuthenticatedRequest;
  let error: any = null;
  requirePermission('RECORD_REFUND')(auditor, { status: () => ({ json: () => undefined }) } as any, (e?: any) => { error = e ?? null; });
  assert.equal(error?.statusCode, 403);
});

test('AUTHZ: المسار واحد ومبواب، والمحرّم يُرفض قبل أي وصول لقاعدة البيانات', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.routes.ts'), 'utf8');
  const route = source.split('\n').find((l) => l.includes("router.post('/refunds'"));
  assert.ok(route);
  assert.match(route!, /requirePermission\('RECORD_REFUND'\)/);
  assert.match(route!, /validateBody\(refundSchema\)/);

  // .strict() على المخطط: لا حقل مجهول يمرّ من وسيط التحقق، فحتى لو أُهمل فحص
  // المتحكم لا يزحف حقل يقرره الخادم إلى قاعدة البيانات.
  const validation = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'validations', 'refund.validation.ts'), 'utf8');
  assert.match(validation, /\)\s*\.strict\(\)/, 'المخطط صارم');
});

/* ==========================================================================
 * 2. VALIDATION — refused before the database
 * ======================================================================== */

test('VALIDATION: كل حقل يقرره الخادم مرفوض، قبل أي استعلام', async () => {
  for (const field of [
    'invoice_id', 'clinic_id', 'payer_type', 'method', 'refunded_by_user_id', 'refunded_at',
    'voided_at', 'voided_by_user_id', 'void_reason', 'paid_amount', 'net_amount', 'status', 'refund_id',
  ]) {
    const { captured, calls } = await refund({}, { ...VALID_BODY, [field]: 1 });
    assert.equal(captured.status, 400, field);
    assert.equal(calls.length, 0, `${field} refused before any query`);
  }
});

test('VALIDATION: مبلغ صفر أو سالب أو بدقة زائدة مرفوض', async () => {
  for (const amount of [0, -5, '0.00', '-0.01', 10.005, NaN, Infinity]) {
    const { captured, calls } = await refund({}, { ...VALID_BODY, amount });
    assert.equal(captured.status, 400, `amount ${amount}`);
    assert.equal(calls.length, 0);
  }
});

test('VALIDATION: سبب غير موجود مرفوض — لا حسوم سماحية ولا إلغاء خدمة', async () => {
  for (const reason of ['GOODWILL', 'SERVICE_CANCELLATION', 'return_credit', '', 'RETURN_CREDITS']) {
    const { captured, calls } = await refund({}, { ...VALID_BODY, reason });
    assert.equal(captured.status, 400, `reason ${reason || '(empty)'}`);
    assert.equal(calls.length, 0);
  }
});

test('VALIDATION: عملة غير ثلاثية الحروف مرفوض', async () => {
  for (const currency_code of ['JO', 'JODX', '12']) {
    const { captured } = await refund({}, { ...VALID_BODY, currency_code });
    assert.equal(captured.status, 400, currency_code);
  }
});

test('VALIDATION: دفعة غير موجودة 404 بلا كتابة', async () => {
  const { captured, refundInserts, wasRolledBack } = await refund({ payment: null });
  assert.equal(captured.status, 404);
  assert.equal(refundInserts.length, 0);
  assert.equal(wasRolledBack, true);
});

/* ==========================================================================
 * 3. WRITE BEHAVIOUR
 * ======================================================================== */

test('WRITE: استرداد ناجح، والفاتورة لا تُمسّ', async () => {
  const { captured, writes, texts } = await refund({ invoiceClinics: [3] }, { ...VALID_BODY, amount: 30 });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.idempotent_replay, false);
  assert.equal(Number(captured.body.refund.amount), 30);
  assert.equal(texts.filter((t) => t.startsWith('UPDATE invoices')).length, 0, 'لا تحديث للفاتورة إطلاقاً');
  assert.equal(writes.filter((c) => /^UPDATE/i.test(c.text.trim())).length, 0, 'لا تحديث لأي جدول');
  assert.deepEqual(
    writes.map((c) => c.text.trim().split(/\s+/).slice(0, 3).join(' ')),
    ['INSERT INTO refunds', 'INSERT INTO audit_logs'],
    'الكتابتان الوحيدتان: سطر الاسترداد وسطر التدقيق',
  );
  assert.equal(captured.body.invoice.paid_amount_unchanged, true);
});

test('WRITE: payer_type و method و clinic_id و invoice_id مشتقّة من الدفعة', async () => {
  const { refundInserts, captured } = await refund({
    invoiceClinics: [3],
    payment: { ...DEFAULT_PAYMENT, clinic_id: 3, payer_type: 'PATIENT', method: 'CARD' },
  }, VALID_BODY);
  const params = refundInserts[0]!.params;
  assert.equal(params[0], 500, 'payment_id من الطلب');
  assert.equal(params[1], 700, 'invoice_id من الدفعة لا من الجسم');
  assert.equal(params[2], 3, 'clinic_id من الدفعة');
  assert.equal(params[4], 'PATIENT', 'payer_type من الدفعة');
  assert.equal(params[5], 'CARD', 'method من الدفعة: ما رجع هو ما دخل');
  assert.equal(params[6], 'JOD', 'currency_code من الدفعة بعد المطابقة');
  assert.equal(params[10], 7, 'refunded_by_user_id من التوكن');
  assert.equal(captured.body.payment.method, 'CARD');
  assert.equal(captured.body.payment.payer_type, 'PATIENT');
});

test('WRITE: لا حقل تاريخ في الإدراج — refunded_at من الخادم', async () => {
  const { refundInserts } = await refund();
  const insert = refundInserts[0]!;
  const columnList = insert.text.slice(insert.text.indexOf('(') + 1, insert.text.indexOf(')'));
  assert.doesNotMatch(columnList, /refunded_at/, 'refunded_at ليس عمود INSERT');
  assert.doesNotMatch(columnList, /created_at/, 'created_at افتراضي من القاعدة');
  assert.doesNotMatch(columnList, /voided_at|voided_by_user_id|void_reason/, 'ولا حقول الإلغاء: الإلغاء مسار منفصل');
  assert.ok(columnList.includes('refunded_by_user_id'), 'الفاعل يُسجَّل نعم');
  assert.ok(insert.params.length === 12, 'اثنا عشر معاملاً: لا أكثر ولا أقل');
});

test('WRITE: الاسترداد الجزئي ثاني يخفض المتبقي على نفس الدفعة', async () => {
  // The entitlement must cover both instalments: 30.00 is the default fixture
  // credit, so this one states a larger one rather than pretending 20.00 fits.
  const wide = { credit: { ...DEFAULT_CREDIT, refund_due_amount: '1000.00' } };
  const first = await refund({ ...wide, refundedOnPayment: '0.00' }, { ...VALID_BODY, amount: 30 });
  assert.equal(first.captured.status, 201);
  assert.equal(first.captured.body.payment.refunded_total, 30);
  assert.equal(first.captured.body.payment.refundable_remaining, 70);

  const second = await refund({ ...wide, refundedOnPayment: '30.00' }, { ...VALID_BODY, amount: 20 });
  assert.equal(second.captured.status, 201, 'استرداد جزئي ثانٍ مشروع');
  assert.equal(second.captured.body.payment.refunded_total, 50);
  assert.equal(second.captured.body.payment.refundable_remaining, 50);
});

test('WRITE: بلوغ نقد الدفعة بالضبط مسموح، والزيادة مرفوضة', async () => {
  const exact = await refund({ refundedOnPayment: '70.00' }, { ...VALID_BODY, amount: 30 });
  assert.equal(exact.captured.status, 201, '100.00 على دفعة 100.00');
  assert.equal(exact.captured.body.payment.refundable_remaining, 0);

  const over = await refund({ refundedOnPayment: '90.00' }, { ...VALID_BODY, amount: 10.01 });
  assert.equal(over.captured.status, 409);
  assert.equal(over.captured.body.code, 'REFUND_EXCEEDS_PAYMENT');
  assert.equal(over.captured.body.refundable_remaining, 10);
  assert.equal(over.refundInserts.length, 0, 'لا مال يتحرك عند الرفض');
  assert.equal(over.wasRolledBack, true);
});

test('WRITE: دفعة ملغاة لا يُردّ منها نقد', async () => {
  const { captured, refundInserts } = await refund({
    payment: { ...DEFAULT_PAYMENT, voided_at: '2026-10-02T09:00:00.000Z' },
  });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, 'PAYMENT_VOIDED');
  assert.equal(captured.body.voided_at, '2026-10-02T09:00:00.000Z');
  assert.equal(refundInserts.length, 0);
});

test('WRITE: عملة مختلفة عن نقد الدفعة مرفوضة — لا مصدر أسعار صرف', async () => {
  const { captured, refundInserts } = await refund({}, { ...VALID_BODY, currency_code: 'USD' });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, 'CURRENCY_MISMATCH');
  assert.equal(captured.body.payment_currency, 'JOD');
  assert.equal(refundInserts.length, 0);
});

test('WRITE: فاتورة ببنود من أكثر من عيادة، أو دفعة عيادتها لا تطابق، تُرفض', async () => {
  const twoClinics = await refund({ invoiceClinics: [3, 8] });
  assert.equal(twoClinics.captured.status, 409);
  assert.equal(twoClinics.captured.body.code, 'CROSS_CLINIC_INVOICE');
  assert.deepEqual(twoClinics.captured.body.invoice_clinic_ids, [3, 8]);
  assert.equal(twoClinics.refundInserts.length, 0);

  const noLines = await refund({ invoiceClinics: [] });
  assert.equal(noLines.captured.status, 409);
  assert.equal(noLines.captured.body.code, 'CROSS_CLINIC_INVOICE');
  assert.equal(noLines.captured.body.reason_detail, 'INVOICE_WITHOUT_LINES');

  const disagree = await refund({ invoiceClinics: [8] });
  assert.equal(disagree.captured.status, 409, 'سلطتان تختلفان في العيادة: لا يُختار إحداهما');
  assert.equal(disagree.captured.body.code, 'CROSS_CLINIC_INVOICE');
  assert.equal(disagree.captured.body.payment_clinic_id, 3);
  assert.deepEqual(disagree.captured.body.invoice_clinic_ids, [8]);
});

test('WRITE: تدقيق واحد قبل COMMIT، والكود REFUND_RECORDED', async () => {
  const { audits, texts, captured } = await refund();
  assert.equal(audits.length, 1);
  assert.match(audits[0]!.text, /'REFUND_RECORDED', 'REFUND'/);
  const auditIndex = texts.findIndex((t) => t.startsWith('INSERT INTO audit_logs'));
  const commitIndex = texts.indexOf('COMMIT');
  assert.ok(auditIndex > -1 && commitIndex > auditIndex, `التدقيق قبل COMMIT (audit=${auditIndex}, commit=${commitIndex})`);
  const metadata = JSON.parse(audits[0]!.params[3] as string);
  assert.equal(metadata.payment_id, 500);
  assert.equal(metadata.invoice_id, 700);
  assert.equal(metadata.amount, 20);
});

test('WRITE: خطأ غير متوقع يتراجع ولا يسرّب رسالة قاعدة البيانات', async () => {
  const { captured, wasRolledBack, wasCommitted } = await refund({ failOn: 'INSERT INTO refunds' });
  assert.equal(captured.status, 500);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
  assert.doesNotMatch(String(captured.body.message), /simulated|pg|relation/i);
});

/* ==========================================================================
 * 4. THE 044 CREDIT BRIDGE
 * ======================================================================== */

test('CREDIT: ائتمان موجود يُقفل ويُقرأ، والمتبقي يُحسب من السطور الحية', async () => {
  const { captured, calls } = await refund(
    { credit: DEFAULT_CREDIT, refundedOnCredit: '10.00' },
    { ...VALID_BODY, amount: 15, credit_id: 40 },
  );
  assert.equal(captured.status, 201);
  assert.equal(calls.filter((c) => /medication_return_credits[\s\S]*FOR UPDATE/.test(c.text)).length, 1, 'ائتمان واحد مقفل');
  assert.match(calls.find((c) => c.text.includes('medication_return_credits'))!.text, /FOR UPDATE/);
  // 30.00 استحقاق ناقص 10.00 مستردة = 20.00 متبقٍ، والمطلوب 15.00
  assert.equal(captured.body.payment.refundable_remaining, 85);
});

test('CREDIT: استحقاق مستنفد مرفوض، والمبلغ المتبقي معلن', async () => {
  const { captured, refundInserts } = await refund(
    { credit: DEFAULT_CREDIT, refundedOnCredit: '30.00' },
    { ...VALID_BODY, amount: 5, credit_id: 40 },
  );
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, 'NO_REFUND_ENTITLEMENT');
  assert.equal(captured.body.refund_due_amount, 30);
  assert.equal(captured.body.already_refunded, 30);
  assert.equal(captured.body.remaining_entitlement, 0);
  assert.equal(refundInserts.length, 0);
});

test('CREDIT: استحقاق صفر — دواء غير مدفوع أصلاً — لا استرداد منه', async () => {
  // DEFERRED INVARIANT lives next to this one: 044 computed refund_due_amount
  // against a paid_amount of zero, so a credit recorded BEFORE payment yields 0
  // and can never be refunded. That is recorded, not fixed, in this phase.
  const { captured } = await refund(
    { credit: { ...DEFAULT_CREDIT, refund_due_amount: '0.00' } },
    { ...VALID_BODY, amount: 5, credit_id: 40 },
  );
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, 'NO_REFUND_ENTITLEMENT');
  assert.equal(captured.body.remaining_entitlement, 0);
});

test('CREDIT: تجاوز الاستحقاق مسموح إذا سمح نقد الدفعة — القبان مستقلان', async () => {
  // 30.00 استحقاق على دفعة نقدها 100.00: السقف الثاني هو الاستحقاق.
  const overCredit = await refund(
    { credit: DEFAULT_CREDIT, refundedOnCredit: '0.00' },
    { ...VALID_BODY, amount: 40, credit_id: 40 },
  );
  assert.equal(overCredit.captured.status, 409);
  assert.equal(overCredit.captured.body.code, 'NO_REFUND_ENTITLEMENT');

  const withinBoth = await refund(
    { credit: DEFAULT_CREDIT, refundedOnCredit: '0.00' },
    { ...VALID_BODY, amount: 30, credit_id: 40 },
  );
  assert.equal(withinBoth.captured.status, 201, '30.00 على 30.00 استحقاق و100.00 نقد');
});

test('CREDIT: ائتمان من فاتورة أخرى مرفوض — لا تفريغ استحقاق من نقد غيره', async () => {
  const { captured, refundInserts } = await refund(
    { credit: { ...DEFAULT_CREDIT, invoice_id: 999 } },
    { ...VALID_BODY, amount: 5, credit_id: 40 },
  );
  assert.equal(captured.status, 409);
  assert.equal(captured.body.credit_invoice_id, 999);
  assert.equal(captured.body.payment_invoice_id, 700);
  assert.equal(refundInserts.length, 0);
});

test('CREDIT: ائتمان غير موجود 404', async () => {
  const { captured, refundInserts } = await refund({ credit: null }, { ...VALID_BODY, amount: 5, credit_id: 999999 });
  assert.equal(captured.status, 404);
  assert.equal(refundInserts.length, 0);
});

test('CREDIT: استحقاق مريض لا يُفرَّغ من نقد شركة التأمين', async () => {
  // PAYER_MISMATCH has exactly one honest use: 044's refund_due_amount is the
  // PATIENT-facing portion and is 0 for INSURANCE/SPLIT invoices, so an
  // insurer's cash must never be returned against a patient's entitlement.
  const { captured, refundInserts } = await refund(
    { credit: DEFAULT_CREDIT, payment: { ...DEFAULT_PAYMENT, payer_type: 'INSURER' } },
    { ...VALID_BODY, amount: 5, credit_id: 40 },
  );
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, 'PAYER_MISMATCH');
  assert.equal(captured.body.payer_type, 'INSURER');
  assert.equal(refundInserts.length, 0);
});

test('CREDIT: استرداد ائتمان بلا credit_id مرفوض قبل أي وصول لقاعدة البيانات', async () => {
  // 049's chk_refunds_return_credit_needs_credit makes the credit mandatory for
  // this reason. The controller refuses it as a body error instead of letting the
  // insert fail, so the caller learns WHICH field is missing rather than getting a
  // 500 from the database.
  const { credit_id: _dropped, ...withoutCredit } = VALID_BODY;
  const { captured, calls } = await refund({}, withoutCredit);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, 'VALIDATION_ERROR');
  assert.match(captured.body.message, /credit_id/);
  assert.equal(calls.length, 0, 'قبل أي وصول لقاعدة البيانات');
});

test('CREDIT: credit_id لا يشير إلى ائتمان موجود يعطي 404 بلا كتابة', async () => {
  const { captured, refundInserts } = await refund({ credit: null }, VALID_BODY);
  assert.equal(captured.status, 404);
  assert.equal(refundInserts.length, 0);
});

/* ==========================================================================
 * 5. IDEMPOTENCY
 * ======================================================================== */

test('IDEMPOTENCY: إعادة الطلب بنفس المفتاح تعيد نفس الاسترداد بلا صف جديد', async () => {
  const { captured, refundInserts, wasCommitted } = await refund(
    { refundedOnPayment: '20.00', replay: { refund_id: 800, payment_id: 500, amount: '20.00' } },
    { ...VALID_BODY, amount: 20, idempotency_key: 'req-1' },
  );
  assert.equal(captured.status, 200, 'إعادة الطلب ليست خطأ');
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.refund.refund_id, 800);
  assert.equal(refundInserts.length, 0, 'لا حركة مال ثانية');
  assert.equal(wasCommitted, false);
});

test('IDEMPOTENCY: فحص التكرار يسبق السقوف — Idempotency precedes the caps', async () => {
  const { texts } = await refund(
    { refundedOnPayment: '100.00', credit: DEFAULT_CREDIT, refundedOnCredit: '0.00', replay: null },
    { ...VALID_BODY, amount: 20, idempotency_key: 'req-1' },
  );
  const replayIndex = texts.findIndex((t) => t.includes('idempotency_key = $2'));
  const capIndex = texts.findIndex((t) => t.includes('AS refunded'));
  assert.ok(replayIndex > -1, 'استعلام المفتاح موجود');
  assert.ok(replayIndex < capIndex, 'المفتاح يُقرأ قبل أي سقف');
});

test('IDEMPOTENCY: وجود المفتاح يوقف المسار قبل أي قراءة للمجاميع', async () => {
  const { texts } = await refund(
    { refundedOnPayment: '20.00', replay: { refund_id: 800, amount: '20.00' } },
    { ...VALID_BODY, amount: 20, idempotency_key: 'req-1' },
  );
  assert.ok(texts.some((t) => t.includes('idempotency_key = $2')));
  assert.equal(texts.some((t) => t.includes('AS refunded')), false, 'لا يُقرأ أي مجموع عند إعادة الطلب');
});

test('IDEMPOTENCY: تعارض الفهرس الفريد يُقرأ كإعادة طلب لا كعطل', async () => {
  const { captured, wasRolledBack, wasCommitted } = await refund(
    { uniqueViolationAtInsert: true, replay: { refund_id: 800, amount: '20.00' } },
    { ...VALID_BODY, idempotency_key: 'req-1' },
  );
  assert.equal(captured.status, 200);
  assert.equal(captured.body.idempotent_replay, true);
  assert.equal(captured.body.refund.refund_id, 800);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

test('IDEMPOTENCY: الفهرس الجزئي على (payment_id, idempotency_key) هو الضمان', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '049_refunds.sql'), 'utf8',
  );
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_payment_idempotency\s+ON refunds \(payment_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/);
});

/* ==========================================================================
 * 6. LOCKING AND TRANSACTION
 * ======================================================================== */

test('LOCKING: القفل على الدفعة، لا على الفاتورة', async () => {
  const { calls } = await refund({ credit: DEFAULT_CREDIT }, { ...VALID_BODY, amount: 10, credit_id: 40 });
  const locking = calls.filter((c) => /FOR UPDATE/i.test(c.text));
  assert.equal(locking.length, 2, 'قفلان فقط: الدفعة ثم الائتمان');
  assert.match(locking[0]!.text, /FROM payments\s+WHERE payment_id = \$1\s+FOR UPDATE/);
  assert.match(locking[1]!.text, /FROM medication_return_credits\s+WHERE credit_id = \$1\s+FOR UPDATE/);
  // Order matters: payment then credit, always. Two refunds naming both rows
  // would otherwise be able to invert and deadlock.
  assert.ok(locking[0]!.text.includes('payments') && locking[1]!.text.includes('medication_return_credits'));

  const invoiceRead = calls.find((c) => c.text.startsWith('SELECT created_at FROM invoices'))!;
  assert.doesNotMatch(invoiceRead.text, /FOR UPDATE/i, 'الفاتورة تُقرأ ولا تُقفل');
  const lines = calls.find((c) => c.text.includes('DISTINCT clinic_id'))!;
  assert.doesNotMatch(lines.text, /FOR UPDATE/i, 'ولا بنودها');
});

test('LOCKING: الملف كله لا يقفل إلا الدفعة والائتمان', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'refunds.controller.ts'), 'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const locks = source.match(/FOR UPDATE/gi) ?? [];
  assert.equal(locks.length, 2, 'قفلان في الملف كله');
  assert.match(source, /FROM payments[\s\S]{0,90}FOR UPDATE/);
  assert.match(source, /FROM medication_return_credits[\s\S]{0,90}FOR UPDATE/);
  for (const table of ['invoices', 'invoice_items', 'medication_return_reversals', 'dispensing_items', 'dispensings']) {
    assert.doesNotMatch(source, new RegExp(`FROM ${table}[\\s\\S]{0,90}FOR UPDATE`), `${table} لا يُقفل أبداً`);
  }
});

test('TRANSACTION: BEGIN أولاً، والعتبة قبل القفل، وCOMMIT بعد كل كتابة', async () => {
  const { calls, texts } = await refund();
  assert.equal(texts[0], 'BEGIN');
  const cutoverIndex = calls.findIndex((c) => c.text.includes('FROM settlement_cutover'));
  const lockIndex = calls.findIndex((c) => /FOR UPDATE/i.test(c.text));
  assert.ok(cutoverIndex > -1 && cutoverIndex < lockIndex, 'العتبة قبل القفل: لا نقفل دفعة لنرفضها بعدها');
  const lastWrite = texts.map((t) => /^(INSERT|UPDATE)/i.test(t)).lastIndexOf(true);
  assert.ok(lastWrite < texts.indexOf('COMMIT'), 'COMMIT بعد كل الكتابات');
});

test('TRANSACTION: كل مسار رفض يُلغى ولا يكتب شيئاً', async () => {
  const inTransaction: Array<{ scenario: Scenario; body: Record<string, unknown>; user: unknown }> = [
    { scenario: { payment: null }, body: VALID_BODY, user: ACCOUNTANT },
    { scenario: { payment: { ...DEFAULT_PAYMENT, voided_at: '2026-10-02T09:00:00.000Z' } }, body: VALID_BODY, user: ACCOUNTANT },
    { scenario: { invoiceCreatedAt: '2019-05-01T10:00:00.000Z' }, body: VALID_BODY, user: ACCOUNTANT },
    { scenario: { invoiceClinics: [3, 8] }, body: VALID_BODY, user: CLINIC_SCOPED },
    { scenario: { invoiceClinics: [8] }, body: VALID_BODY, user: CLINIC_SCOPED },
    { scenario: { invoiceClinics: [3] }, body: VALID_BODY, user: OTHER_CLINIC },
    { scenario: { credit: { ...DEFAULT_CREDIT, invoice_id: 999 } }, body: { ...VALID_BODY, credit_id: 40 }, user: ACCOUNTANT },
    { scenario: { credit: DEFAULT_CREDIT, refundedOnCredit: '30.00' }, body: { ...VALID_BODY, credit_id: 40, amount: 5 }, user: ACCOUNTANT },
  ];
  for (const { scenario, body, user } of inTransaction) {
    const { captured, writes, wasRolledBack, wasCommitted } = await refund(scenario, body, user);
    assert.notEqual(captured.status, 201, JSON.stringify(scenario));
    assert.equal(writes.length, 0, `no write before the refusal: ${JSON.stringify(scenario)}`);
    assert.equal(wasRolledBack, true, JSON.stringify(scenario));
    assert.equal(wasCommitted, false, JSON.stringify(scenario));
  }
});

/* ==========================================================================
 * 7. THE CUTOVER BOUNDARY
 * ======================================================================== */

test('CUTOVER: فاتورة صدرت قبل العتبة تُرفض ولا يتحرك مال', async () => {
  const { captured, writes, wasRolledBack } = await refund({ invoiceCreatedAt: '2019-05-01T10:00:00.000Z' });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, 'LEGACY_INVOICE_READ_ONLY');
  assert.equal(captured.body.invoice_id, 700);
  assert.equal(writes.length, 0);
  assert.equal(wasRolledBack, true);
});

test('CUTOVER: التصنيف بالوقت وحده، والعتبة بالضبط تعني بعد العتبة', async () => {
  const atBoundary = await refund({ invoiceCreatedAt: CUTOVER });
  assert.equal(atBoundary.captured.status, 201, 'created_at = cutover_at يعني بعد العتبة');
});

test('CUTOVER: غياب العتبة لا يُقرأ كـ legacy ولا كـ بعدها — يُفشل صريحاً', async () => {
  const { captured, refundInserts, wasRolledBack, wasCommitted } = await refund({ cutoverAt: null });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.code, 'SETTLEMENT_CUTOVER_MISSING');
  assert.equal(refundInserts.length, 0);
  assert.equal(wasRolledBack, true);
  assert.equal(wasCommitted, false);
});

/* ==========================================================================
 * 8. INVARIANTS — what this phase must not do
 * ======================================================================== */

/** Strips comments so an assertion about code cannot match the prose explaining it. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

const refundSource = () => codeOnly(fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'refunds.controller.ts'), 'utf8',
));

test('INVARIANT: المسار يلمس الجداول المالية وحدها', () => {
  const tables = [...refundSource().matchAll(/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/g)].map((m) => m[1]!);
  // invoice_items is READ, unlocked, to resolve the invoice's clinics — and
  // never written, which the next assertion holds separately.
  const allowed = new Set(['payments', 'invoices', 'invoice_items', 'refunds', 'medication_return_credits', 'settlement_cutover', 'audit_logs']);
  for (const table of tables) {
    assert.ok(allowed.has(table), `جدول غير متوقع: ${table}`);
  }
});

test('INVARIANT: لا إعادة اشتقاق لـ paid_amount ولا قراءة له أساساً للحساب', () => {
  const source = refundSource();
  // paid_amount is never SELECTed as a column: a refund is judged against live
  // refund rows and the payment's own amount. Reading the invoice's cached mirror
  // would reintroduce the single-source ambiguity this table exists to avoid.
  // The one occurrence allowed is the response flag that TELLS the caller the
  // invoice was left alone.
  assert.doesNotMatch(source, /\bpaid_amount\b(?!_unchanged)/);
  assert.doesNotMatch(source, /SUM\(amount\)\s+FROM\s+payments/i, 'ولا يُعاد اشتقاق شيء من الدفعات');
  assert.match(source, /paid_amount_unchanged: true/, 'والرد يعلن ذلك صراحةً');
});

test('INVARIANT: Entitlements and balances come from live aggregates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'refunds.controller.ts'), 'utf8');
  // Both sums are voided_at IS NULL filtered, and both read the refunds table.
  const sums = [...source.matchAll(/SELECT COALESCE\(SUM\(amount\), 0\)::numeric AS refunded[\s\S]*?;/g)].map((m) => m[0]);
  assert.equal(sums.length, 2, 'مقروآن حيّان: واحد للدفعة وواحد للائتمان');
  for (const sum of sums) {
    assert.match(sum, /voided_at IS NULL/, 'المجموع الحي = غير الملغى فقط');
  }
  // refund_due_amount is read as the entitlement's ORIGINAL size, and the
  // remainder is always recomputed from the live refunds.
  assert.match(source, /credit\.refundDue - alreadyRefunded/);
});

test('INVARIANT: reports, KPIs and the UI are still untouched', () => {
  const reports = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'reports', 'reports.controller.ts'), 'utf8');
  assert.doesNotMatch(reports, /refund/i, 'لا تقرير يقرأ الاسترداد بعد');
  assert.doesNotMatch(reports, /\bpayments\b/i, 'ولا الدفعات');
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.controller.ts'), 'utf8'),
    /refund/i,
    'KPIs بلا تغيير',
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'views', 'OverviewView.jsx'), 'utf8'),
    /refund/i,
    'ولا واجهة',
  );
});

test('INVARIANT: لا مسار إلغاء استرداد ولا إلغاء دفعة ولا إلغاء فاتورة', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'billing', 'billing.routes.ts'), 'utf8');
  // The refund route itself is the only refund route; no verb voids or cancels.
  assert.equal(source.split('\n').filter((l) => /router\.(post|put|patch|delete)\(.*(void|cancel)/i.test(l)).length, 0);
  assert.doesNotMatch(source, /voidRefund|voidPayment|cancelInvoice|refund\/:/i);
});