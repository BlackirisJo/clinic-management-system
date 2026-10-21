import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { recordFulfilmentDecision } from '../modules/prescriptions/fulfilmentDecisions.controller';
import {
  createPrescription,
  getPrescriptionById,
  getPharmacyQueue,
} from '../modules/prescriptions/prescriptions.controller';

/* ==========================================================================
 * Phase 10F.1 — قرار المريض بشأن التنفيذ
 *
 * العقد الذي تحرسه هذه الاختبارات، جملةً واحدة:
 *
 *   تسجيل قرار = كتابة خمسة أعمدة على بند روشتة + سطر تدقيق. لا شيء غير ذلك.
 *   لا صرف، لا خصم مخزون، لا حركة مخزون، لا فاتورة، لا سطر فاتورة، لا تعديل
 *   مالي، لا بند صرف. مخزون وجرعة ودواء البند لا تُقرأ ولا تُكتب.
 *
 * والاثنتان تركتاهما لـمسار الصرف وحده: DISPENSED_FROM_CLINIC و
 * PARTIALLY_DISPENSED. ادعاء صرف لم يحدث أسوأ من غيابه، فممنوعة من هذا المسار.
 * ========================================================================== */

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_CONNECT = pool.connect.bind(pool);
const ORIGINAL_QUERY = pool.query.bind(pool);

const DOCTOR = {
  userId: 7, roleId: 2, clinicId: 1, roleName: 'DOCTOR',
  permissions: ['VIEW_PATIENTS', 'VIEW_PRESCRIPTIONS', 'CREATE_PRESCRIPTION'], clinicIds: [1],
};

const ITEM_ID = '300';

/** جداول لا يجوز لمسها بأي قراءة أو كتابة من مسار تسجيل القرار */
const MONEY_AND_STOCK_TABLES = [
  'inventory_items',
  'inventory_batches',
  'stock_movements',
  'dispensings',
  'dispensing_items',
  'dispensing_item_batches',
  'invoices',
  'invoice_items',
  'medication_prices',
  'medication_return_items',
  'medication_return_credits',
];

/** أعمدة البند التي لا يملكها مسار القرار إطلاقاً */
const PRESCRIPTION_FACTS = [
  'medication_id',
  'dosage',
  'frequency',
  'duration',
  'prescribed_quantity',
  'repeats_count',
  'timing_instructions',
  'uom',
];

interface Scenario {
  itemFound?: boolean;
  /** الحالة الحالية للبند كما تُقرأ تحت القفل */
  current?: string;
  /** UPDATE محروسة (§i) تُطابق صفر صف */
  updateRowCount?: number;
  failOn?: string;
}

const makeRes = () => {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
  };
  return { res, captured };
};

/** يحاكي pool.query و pool.connect معاً — القرار يحتاج الاثنين (معاملة واحدة). */
async function withMocks(scenario: Scenario, run: (calls: QueryCall[]) => Promise<void>) {
  const calls: QueryCall[] = [];
  const current = scenario.current ?? 'PENDING';

  const handler = (text: string, params: unknown[] = []): MockResult => {
    const t = text.trim();
    calls.push({ text, params });
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (scenario.failOn && t.includes(scenario.failOn)) {
      throw Object.assign(new Error('simulated failure'), { code: 'XX000' });
    }
    if (t.includes('FROM prescription_items pi')) {
      if (params.some((p) => Array.isArray(p) && p.length === 0)) return { rows: [], rowCount: 0 };
      if (scenario.itemFound === false) return { rows: [], rowCount: 0 };
      return { rows: [{ item_id: 300, prescription_id: 100, fulfilment_status: current, clinic_id: 1 }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE prescription_items')) {
      const rows = scenario.updateRowCount === 0 ? [] : [{ item_id: 300, prescription_id: 100 }];
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => handler(text, params),
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => handler(text, params);
  try {
    await run(calls);
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

async function decide(
  scenario: Scenario = {},
  body: Record<string, unknown> = { fulfilment_status: 'PATIENT_DECLINED' },
  itemId: string = ITEM_ID,
  user: unknown = DOCTOR,
) {
  let outcome = { captured: { status: 0, body: undefined as any }, calls: [] as QueryCall[] };
  await withMocks(scenario, async (calls) => {
    const { res, captured } = makeRes();
    const req = { body, params: { id: itemId }, query: {}, user } as unknown as AuthenticatedRequest;
    await recordFulfilmentDecision(req, res);
    outcome = { captured, calls };
  });
  const { calls } = outcome;
  const writes = calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.text.trim()));
  return {
    captured: outcome.captured,
    calls,
    writes,
    setList: (sql: string) => sql.slice(sql.indexOf('SET'), sql.indexOf(' WHERE ')),
    update: calls.find((c) => c.text.trim().startsWith('UPDATE prescription_items')),
    audit: calls.find((c) => c.text.trim().startsWith('INSERT INTO audit_logs')),
    wasRolledBack: calls.some((c) => c.text === 'ROLLBACK'),
    wasCommitted: calls.some((c) => c.text === 'COMMIT'),
    auditMetadata: () => {
      const audit = calls.find((c) => c.text.trim().startsWith('INSERT INTO audit_logs'));
      return audit ? JSON.parse(String(audit.params[3])) : undefined;
    },
  };
}

const DECISION_STATUSES = ['PATIENT_DECLINED', 'EXTERNAL_PHARMACY', 'CANCELLED'] as const;

/* ==========================================================================
 * A. القرار يكتب أعمدة القرار فقط + التدقيق
 * ========================================================================== */

for (const status of DECISION_STATUSES) {
  test(`DECISION ${status}: يكتب أعمدة القرار الخمسة والتدقيق فقط`, async () => {
    const r = await decide({}, { fulfilment_status: status });

    assert.equal(r.captured.status, 200);
    assert.equal(r.writes.length, 2, 'تحديث بند واحد + سطر تدقيق واحد، لا شيء ثالث');

    assert.ok(r.update, 'UPDATE على بند الروشتة');
    const set = r.setList(r.update!.text).replace(/\s+/g, ' ');
    for (const column of ['fulfilment_status', 'decision_note', 'decided_by_user_id', 'decided_at', 'source']) {
      assert.ok(set.includes(column), `${column} يُكتب`);
    }
    for (const column of PRESCRIPTION_FACTS) {
      assert.ok(!set.includes(column), `${column} لا يُلمس — الروشتة ليست صرفاً`);
    }

    assert.ok(r.audit, 'القرار مُدقَّق');
    assert.equal(r.audit!.params[0], DOCTOR.userId, 'المُسجِّل من الجلسة');
    assert.equal(r.audit!.params[1], 1, 'العيادة مشتقّة من الزيارة');
    assert.equal(r.wasCommitted, true);
  });

  test(`DECISION ${status}: صفر أثر على المخزون والمال والصرف`, async () => {
    const r = await decide({}, { fulfilment_status: status });

    const issued = r.calls.map((c) => c.text).join('\n');
    for (const table of MONEY_AND_STOCK_TABLES) {
      assert.ok(!new RegExp(`\\b${table}\\b`, 'i').test(issued), `${table} لا يُقرأ ولا يُكتب إطلاقاً`);
    }
    const dataWrites = r.writes.filter((c) => !c.text.trim().startsWith('INSERT INTO audit_logs'));
    assert.deepEqual(
      dataWrites.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(' ')),
      ['UPDATE prescription_items'],
      'الكتابة الوحيدة على البيانات هي بند الروشتة',
    );
  });

  test(`DECISION ${status}: السجل يذكر صفر أثر مخزوني وصفر أثر مالي`, async () => {
    const r = await decide({}, { fulfilment_status: status });
    const metadata = r.auditMetadata();
    assert.equal(metadata.inventory_effect, 'NONE');
    assert.equal(metadata.financial_effect, 'NONE');
    assert.equal(metadata.fulfilment_status, status);
  });
}

test('DECISION: PENDING من PENDING مسموح ولا يمحو شيئاً لم يُسجَّل', async () => {
  const r = await decide({ current: 'PENDING' }, { fulfilment_status: 'PENDING' });
  assert.equal(r.captured.status, 200);
  assert.equal(r.wasCommitted, true);
});

test('DECISION: الملاحظة تُحفظ والمصدر يُشتق من الحالة لا من العميل', async () => {
  const declined = await decide({}, { fulfilment_status: 'PATIENT_DECLINED', decision_note: 'رفض العلاج' });
  assert.equal(declined.update!.params[1], 'رفض العلاج');
  assert.equal(declined.update!.params[3], 'CLINIC', 'قرار داخلي ⇒ مصدر العيادة');

  const external = await decide({}, { fulfilment_status: 'EXTERNAL_PHARMACY' });
  assert.equal(external.update!.params[3], 'EXTERNAL', 'خارجي مشتق من الحالة نفسها');
});

test('DECISION: decided_at ساعة الخادم (NOW()) ولا يأتي من العميل', async () => {
  const r = await decide({}, { fulfilment_status: 'CANCELLED' });
  // cast صريح على $1: نفس الباراميتر يُسنَد إلى عمود VARCHAR ويُقارن بثابت نصّي،
  // وبلا cast يرفض PostgreSQL الاستعلام (42P08) قبل أي كتابة.
  assert.match(r.update!.text, /decided_at = CASE WHEN \$1::varchar\(24\) = 'PENDING' THEN NULL ELSE NOW\(\) END/);
});

/* ==========================================================================
 * B.Statuses مملوكة لمسار الصرف — لا تُصنع هنا
 * ========================================================================== */

test('OWNERSHIP: DISPENSED_FROM_CLINIC و PARTIALLY_DISPENSED مرفوضة قبل أي وصول', async () => {
  for (const status of ['DISPENSED_FROM_CLINIC', 'PARTIALLY_DISPENSED']) {
    const r = await decide({}, { fulfilment_status: status });
    assert.equal(r.captured.status, 400, status);
    assert.equal(r.calls.length, 0, `${status}: لا استعلام أصلاً`);
  }
});

test('OWNERSHIP: بند صُرف فعلاً لا يُعاد بناؤه بقرار جديد', async () => {
  for (const current of ['DISPENSED_FROM_CLINIC', 'PARTIALLY_DISPENSED']) {
    const r = await decide({ current }, { fulfilment_status: 'PENDING', reset_to_pending: true });
    assert.equal(r.captured.status, 409, current);
    assert.equal(r.writes.length, 0, `${current}: لا كتابة حتى مع التأكيد`);
    assert.match(String(r.captured.body.reason), /DISPENSING_OWNED_STATUS/);
  }
});

/* ==========================================================================
 * C. قرار مسجَّل لا يُتجاوز بصمت
 * ========================================================================== */

test('TRANSITION: الرجوع إلى PENDING يتطلب تأكيداً صريحاً', async () => {
  for (const current of ['EXTERNAL_PHARMACY', 'PATIENT_DECLINED', 'CANCELLED']) {
    const r = await decide({ current }, { fulfilment_status: 'PENDING' });
    assert.equal(r.captured.status, 409, current);
    assert.equal(r.captured.body.reason, 'RESET_REQUIRES_CONFIRMATION');
    assert.equal(r.writes.length, 0, `${current}: لا يُطمس القرار ولا يُكتب أي أثر`);
    assert.equal(r.wasRolledBack, true);
    assert.equal(r.wasCommitted, false);
  }
});

test('TRANSITION: التأكيد الصريح يسمح بالرجوع ويمحو هوية القرار وتوقيته', async () => {
  const r = await decide(
    { current: 'PATIENT_DECLINED' },
    { fulfilment_status: 'PENDING', reset_to_pending: true, decision_note: 'سيحاول مرة أخرى' },
  );

  assert.equal(r.captured.status, 200);
  assert.equal(r.update!.params[0], 'PENDING');
  assert.equal(r.update!.params[2], null, 'PENDING بلا مُسجِّل — لم يُتَّخذ قرار');
  assert.match(r.update!.text, /CASE WHEN \$1::varchar\(24\) = 'PENDING' THEN NULL ELSE NOW\(\) END/);
  assert.equal(r.auditMetadata().reset_to_pending, true);
  assert.equal(r.auditMetadata().previous_fulfilment_status, 'PATIENT_DECLINED', 'التاريخ محفوظ في التدقيق');
});

test('TRANSITION: تغيير قرار مسجَّل إلى قرار آخر مسموح ومنفَّذ', async () => {
  const r = await decide({ current: 'EXTERNAL_PHARMACY' }, { fulfilment_status: 'PATIENT_DECLINED' });
  assert.equal(r.captured.status, 200);
  assert.equal(r.update!.params[0], 'PATIENT_DECLINED');
  assert.equal(r.auditMetadata().previous_fulfilment_status, 'EXTERNAL_PHARMACY');
});

test('TRANSITION: UPDATE المحروسة بصفر صف = 409 لا افتراض نجاح', async () => {
  const r = await decide({ updateRowCount: 0 }, { fulfilment_status: 'CANCELLED' });
  assert.equal(r.captured.status, 409);
  assert.equal(r.captured.body.reason, 'STALE_FULFILMENT_STATUS');
  assert.equal(r.audit, undefined, 'لا تدقيق لشيء لم يُكتب');
  assert.equal(r.wasCommitted, false);
});

/* ==========================================================================
 * D. التحقق قبل أي وصول + العزل بين العيادات
 * ========================================================================== */

test('VALIDATION: حقول الصرف والمال والموقع تُرفض كلها', async () => {
  for (const field of ['dispensing_id', 'dispensing_item_id', 'invoice_id', 'quantity', 'unit_price', 'prescription_id', 'clinic_id', 'decided_by_user_id', 'decided_at', 'patient_id']) {
    const r = await decide({}, { fulfilment_status: 'CANCELLED', [field]: 1 });
    assert.equal(r.captured.status, 400, field);
    assert.equal(r.calls.length, 0, `${field}: رفض قبل أي وصول`);
  }
});

test('VALIDATION: جسم ناقص أو status غير معروف أو source غير معروف يُرفض', async () => {
  for (const body of [{}, { fulfilment_status: 'MAYBE' }, { fulfilment_status: 'CANCELLED', source: 'ANYWHERE' }, { fulfilment_status: 'CANCELLED', decision_note: 'x'.repeat(501) }]) {
    const r = await decide({}, body as Record<string, unknown>);
    assert.equal(r.captured.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(r.calls.length, 0);
  }
});

test('VALIDATION: معرّف بند غير صالح يُرفض قبل أي وصول', async () => {
  for (const id of ['abc', '0', '-1', '']) {
    const r = await decide({}, { fulfilment_status: 'CANCELLED' }, id);
    assert.equal(r.captured.status, 400, id);
    assert.equal(r.calls.length, 0);
  }
});

test('SCOPE: بند عيادة أخرى = 404 بلا أي كتابة', async () => {
  const r = await decide({}, { fulfilment_status: 'PATIENT_DECLINED' }, ITEM_ID, { ...DOCTOR, clinicIds: [] });
  assert.equal(r.captured.status, 404);
  assert.equal(r.writes.length, 0);
  assert.equal(r.wasRolledBack, true);
});

test('SCOPE: بند غير موجود = 404 بلا أي كتابة', async () => {
  const r = await decide({ itemFound: false }, { fulfilment_status: 'PATIENT_DECLINED' });
  assert.equal(r.captured.status, 404);
  assert.equal(r.writes.length, 0);
});

test('SCOPE: العيادة تُقفل في UPDATE نفسه — لا كتابة خارج نطاقها', async () => {
  const r = await decide({}, { fulfilment_status: 'CANCELLED' });
  assert.match(r.update!.text, /v\.clinic_id = \$7/);
  assert.deepEqual(r.update!.params.slice(4), [300, 'PENDING', 1], 'البند، الحالة المقروءة، والعيادة المشتقّة');
});

test('ATOMICITY: فشل التدقيق يُسقط القرار كله', async () => {
  const r = await decide({ failOn: 'INSERT INTO audit_logs' }, { fulfilment_status: 'CANCELLED' });
  assert.equal(r.captured.status, 500);
  assert.equal(r.wasRolledBack, true);
  assert.equal(r.wasCommitted, false);
});

test('ATOMICITY: البند مقفل FOR UPDATE قبل القراءة والكتابة', async () => {
  const r = await decide({}, { fulfilment_status: 'CANCELLED' });
  const lockIndex = r.calls.findIndex((c) => c.text.includes('FOR UPDATE OF pi'));
  const updateIndex = r.calls.findIndex((c) => c.text.trim().startsWith('UPDATE prescription_items'));
  assert.ok(lockIndex >= 0, 'قفل البند');
  assert.ok(updateIndex > lockIndex, 'الكتابة بعد القفل لا قبله');
});

/* ==========================================================================
 * E. الرجوع إلى ما قبل ذلك — الروشتة والطابور يظلان بلا أثر مخزون/مالي
 * ========================================================================== */

/** نفس المحاكاة، لكن لجسم الروشتة والطابور */
async function callOnPool(
  operation: (req: AuthenticatedRequest, res: any) => Promise<unknown>,
  scenario: Record<string, (t: string) => MockResult>,
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
  user: unknown = DOCTOR,
) {
  const calls: QueryCall[] = [];
  const handler = (text: string, paramsIn: unknown[] = []): MockResult => {
    const t = text.trim();
    calls.push({ text, params: paramsIn });
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    for (const [needle, respond] of Object.entries(scenario)) {
      if (t.includes(needle)) return respond(t);
    }
    return { rows: [], rowCount: 1 };
  };
  const client = {
    query: async (text: string, paramsIn: unknown[] = []) => handler(text, paramsIn),
    release: () => undefined,
  };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  (pool as unknown as { query: unknown }).query = async (text: string, paramsIn: unknown[] = []) => handler(text, paramsIn);
  try {
    const { res, captured } = makeRes();
    const req = { body, params, query: {}, user } as unknown as AuthenticatedRequest;
    await operation(req, res);
    return { captured, calls };
  } finally {
    (pool as unknown as { connect: unknown }).connect = ORIGINAL_CONNECT;
    (pool as unknown as { query: unknown }).query = ORIGINAL_QUERY;
  }
}

test('REGRESSION: إنشاء روشتة يبقى بلا أثر مخزون أو مالي', async () => {
  const r = await callOnPool(
    createPrescription,
    {
      'FROM visits WHERE': () => ({ rows: [{ ok: 1 }], rowCount: 1 }),
      'INSERT INTO prescriptions': () => ({ rows: [{ prescription_id: 100 }], rowCount: 1 }),
      'INSERT INTO prescription_items': () => ({ rows: [], rowCount: 1 }),
    },
    {
      visit_id: 5, patient_id: 9,
      items: [{ medication_id: 3, dosage: '1', frequency: '3', duration: '5', prescribed_quantity: 30, uom: 'TABLET' }],
    },
  );

  assert.equal(r.captured.status, 201);
  const issued = r.calls.map((c) => c.text).join('\n');
  for (const table of MONEY_AND_STOCK_TABLES) {
    assert.ok(!new RegExp(`\\b${table}\\b`, 'i').test(issued), `${table} لا يُلمس بإنشاء الروشتة`);
  }
  const writes = r.calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.text.trim()));
  assert.deepEqual(
    writes.map((c) => c.text.trim().split(/\s+/).slice(0, 3).join(' ')),
    ['INSERT INTO prescriptions', 'INSERT INTO prescription_items'],
    'كتابتان فقط: الروشتة وبنودها',
  );
});

test('REGRESSION: طابور الصيدلية يبقى قراءة فقط', async () => {
  const r = await callOnPool(getPharmacyQueue, { 'json_agg': () => ({ rows: [{ prescription_id: 100 }], rowCount: 1 }) });

  assert.equal(r.captured.status, 200);
  assert.equal(
    r.calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.text.trim())).length,
    0,
    'الطابور لا يكتب ولا يقرر شيئاً',
  );
  const issued = r.calls.map((c) => c.text).join('\n');
  for (const table of MONEY_AND_STOCK_TABLES) {
    assert.ok(!new RegExp(`\\b${table}\\b`, 'i').test(issued), `${table} لا يظهر في الطابور`);
  }
});

test('PROJECTION: قراءة الروشتة تعرض حالة التنفيذ', async () => {
  const r = await callOnPool(
    getPrescriptionById,
    {
      'FROM prescriptions p': () => ({
        rows: [{ prescription_id: 100, patient_id: 9, visit_clinic_id: 1, patient_clinic_id: 1 }], rowCount: 1,
      }),
      'FROM prescription_items pi': () => ({ rows: [], rowCount: 0 }),
    },
    {},
    { id: '100' },
  );

  assert.equal(r.captured.status, 200);
  const itemsSql = r.calls.find((c) => c.text.includes('FROM prescription_items pi'))!.text;
  for (const column of ['fulfilment_status', 'decision_note', 'decided_at']) {
    assert.ok(itemsSql.includes(`pi.${column}`), `${column} معروض في قراءة الروشتة`);
  }
});

test('PROJECTION: الطابور يعرض حالة التنفيذ ولا يكتبها', async () => {
  const r = await callOnPool(getPharmacyQueue, { 'json_agg': () => ({ rows: [], rowCount: 0 }) });
  const sql = r.calls[0]!.text;
  for (const column of ['fulfilment_status', 'decision_note', 'decided_at', 'source']) {
    assert.ok(sql.includes(`'${column}', pi.${column}`), `${column} معروض في الطابور`);
  }
});

/* ==========================================================================
 * F. مسار الصرف وحده يملك حالتين
 * ========================================================================== */

test('OWNERSHIP: مسار الصرف يزامن حالتيه ولا يلمس أعمدة قرار المريض', () => {
  const source = fs.readFileSync(
    require.resolve('../modules/inventory/dispensings.controller'),
    'utf8',
  );

  assert.match(source, /DISPENSED_FROM_CLINIC/, 'الصرافة تكتب DISPENSED_FROM_CLINIC');
  assert.match(source, /PARTIALLY_DISPENSED/, 'الصرافة تكتب PARTIALLY_DISPENSED');
  // قرار المريض يُقرأ للحماية فقط، ولا يُعاد بناؤه من الصرف
  assert.match(
    source,
    /SET fulfilment_status = v\.fulfilment_status, source = 'CLINIC'/,
    'المزامنة تكتب الحالة والمصدر فقط',
  );
  assert.ok(
    !/UPDATE prescription_items[\s\S]{0,400}decision_note/.test(source),
    'decision_note لا يُكتب من مسار الصرف',
  );
  assert.ok(
    !/UPDATE prescription_items[\s\S]{0,400}decided_by_user_id/.test(source),
    'decided_by_user_id لا يُكتب من مسار الصرف',
  );
});

test('OWNERSHIP: مسار القرار لا يستورد منطق الصرف ولا جداوله', () => {
  const source = fs.readFileSync(
    require.resolve('../modules/prescriptions/fulfilmentDecisions.controller'),
    'utf8',
  );

  for (const forbidden of ['fefo', 'inventory', 'stock', 'dispensing', 'invoice', 'audit_logs (ممنوعة)']) {
    if (forbidden === 'audit_logs (ممنوعة)') continue;
    const hits = source.match(new RegExp(`FROM\\s+${forbidden}|INTO\\s+${forbidden}|UPDATE\\s+${forbidden}`, 'gi'));
    assert.equal(hits, null, `${forbidden} لا يُقرأ ولا يُكتب من مسار القرار`);
  }
  assert.ok(!/allocateFefo|createDispensing/.test(source), 'لا منطق صرف مُستورد');
});
