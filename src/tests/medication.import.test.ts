import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { pool } from '../config/database';
import { DOSAGE_FORM_CODES } from '../lib/dosageForm';
import { ALL_CSV_COLUMNS } from '../validations/medication.import.validation';
import {
  generateMedicationTemplate,
  validateMedicationImport,
  executeMedicationImport,
} from '../modules/prescriptions/medication.import.controller';

/* ==========================================================================
 * Phase 9D — Medication CSV import (canonical six-column format)
 * Direct controller tests with a mocked pool/connection — no real database.
 * ========================================================================== */

const CANONICAL_COLUMNS = [
  'trade_name', 'scientific_name', 'strength', 'dosage_form', 'default_dosage', 'instructions',
];
const HEADER = CANONICAL_COLUMNS.join(',');

type QueryRow = Record<string, unknown>;
type MockResult = { rows: QueryRow[]; rowCount: number | null };
type QueryCall = { text: string; params: unknown[] };

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

async function withMockedDb(
  queryHandler: (text: string) => MockResult,
  run: (calls: QueryCall[], clientCalls: QueryCall[]) => Promise<void>,
): Promise<void> {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const patched = pool as unknown as { query: unknown; connect: unknown };
  patched.query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return queryHandler(text);
  };
  patched.connect = async () => ({
    query: async (text: string, params: unknown[] = []) => {
      clientCalls.push({ text, params });
      if (text.includes('INSERT INTO medications')) {
        return { rows: [], rowCount: (text.match(/\(\$/g) ?? []).length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  try {
    await run(calls, clientCalls);
  } finally {
    patched.query = ORIGINAL_QUERY;
    patched.connect = ORIGINAL_CONNECT;
  }
}

const makeRes = () => {
  const captured: { status: number; body: any; headers: Record<string, string>; sent: string } = {
    status: 0, body: undefined, headers: {}, sent: '',
  };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.body = payload; return res; },
    setHeader(name: string, value: string) { captured.headers[name] = value; return res; },
    send(payload: string) { captured.sent = payload; return res; },
  };
  return { res, captured };
};

const importReq = (body: string) =>
  ({
    file: { size: Buffer.byteLength(body, 'utf8'), buffer: Buffer.from(body, 'utf8') },
    user: { userId: 1, roleId: 1, clinicId: 1 },
  } as unknown as AuthenticatedRequest);

const csv = (header: string, ...rows: string[]) => [header, ...rows].join('\n') + '\n';

const row = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    trade_name: 'Amoxil', scientific_name: 'Amoxicillin', strength: '500 mg',
    dosage_form: 'CAPSULE', default_dosage: '1 x 3', instructions: 'after food', ...over,
  };
  return CANONICAL_COLUMNS.map((c) => base[c] ?? '').join(',');
};

// لا دواء موجود مسبقاً في الدليل أثناء الفحص
const noExistingMedications = (text: string): MockResult =>
  text.includes('SELECT lower(trade_name)') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 };

/* ==========================================================================
 * 1. TEMPLATE + COLUMN RULES
 * ========================================================================== */

test('TEMPLATE: downloadable template has the six canonical columns in order', () => {
  const { res, captured } = makeRes();
  generateMedicationTemplate({} as AuthenticatedRequest, res);

  assert.equal(captured.status, 200);
  assert.deepEqual([...ALL_CSV_COLUMNS], CANONICAL_COLUMNS, 'ALL_CSV_COLUMNS must stay canonical');

  const lines = captured.sent.replace(/^\uFEFF/, '').trim().split('\n');
  assert.deepEqual(String(lines[0]).split(','), CANONICAL_COLUMNS, 'template header order');

  const example = String(lines[1]).split(',');
  assert.equal(example.length, 6, 'example row must contain six values');
  assert.equal(example[2], '"500 mg"', 'example must carry a strength value');
  assert.equal(example[3], '"TABLET"', 'example must carry a valid code from the 12');
  assert.ok((DOSAGE_FORM_CODES as readonly string[]).includes('TABLET'));

  assert.equal(captured.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.match(String(captured.headers['Content-Disposition']), /medication_template\.csv/);
});

test('COLUMNS: missing strength / dosage_form are rejected by /validate and /import identically', async () => {
  const body = csv('trade_name,scientific_name,default_dosage,instructions', 'Amoxil,Amoxicillin,1 x 3,after food');

  for (const handler of [validateMedicationImport, executeMedicationImport]) {
    const { res, captured } = makeRes();
    await withMockedDb(noExistingMedications, async () => { await handler(importReq(body), res); });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body.missingColumns, ['strength', 'dosage_form']);
  }
});

test('COLUMNS: unknown columns are rejected identically by /validate and /import', async () => {
  const body = csv(`${HEADER},legacy_code`, `${row()},X1`);

  for (const handler of [validateMedicationImport, executeMedicationImport]) {
    const { res, captured } = makeRes();
    let clientCalls: QueryCall[] = [];
    await withMockedDb(noExistingMedications, async (_calls, calls) => {
      clientCalls = calls;
      await handler(importReq(body), res);
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body.unknownColumns, ['legacy_code']);
    assert.equal(clientCalls.length, 0, 'no transaction/INSERT starts for a file with unknown columns');
  }
});

test('MIGRATION 027 defines strength + dosage_form additively', () => {
  const file = path.join(process.cwd(), 'src/database/migrations/027_medication_strength_dosage_form.sql');
  assert.equal(fs.existsSync(file), true, 'migration 027 must exist');
  const sql = fs.readFileSync(file, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS strength/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS dosage_form/i);
  assert.equal(/DROP\s+COLUMN/i.test(sql), false, 'migration must not drop existing columns');
});

/* ==========================================================================
 * 2. ROW VALIDATION (/validate)
 * ========================================================================== */

test('VALIDATE: a valid six-column row is accepted with strength + dosage_form', async () => {
  const { res, captured } = makeRes();
  await withMockedDb(noExistingMedications, async (calls) => {
    await validateMedicationImport(importReq(csv(HEADER, row())), res);
    assert.equal(calls.length, 1, 'only the existing-names lookup is queried');
  });

  assert.equal(captured.status, 200);
  assert.equal(captured.body.preview.validNew, 1);
  assert.equal(captured.body.preview.invalid, 0);
  assert.equal(captured.body.preview.validRows[0].strength, '500 mg');
  assert.equal(captured.body.preview.validRows[0].dosage_form, 'CAPSULE');
});

test('VALIDATE: all 12 dosage-form codes are accepted and normalised to upper case', async () => {
  for (const code of DOSAGE_FORM_CODES) {
    const { res, captured } = makeRes();
    await withMockedDb(noExistingMedications, async () => {
      await validateMedicationImport(importReq(csv(HEADER, row({ dosage_form: code.toLowerCase() }))), res);
    });
    assert.equal(captured.status, 200, `${code} must be accepted`);
    assert.equal(captured.body.preview.validNew, 1, `${code} must produce one valid row`);
    assert.equal(captured.body.preview.validRows[0].dosage_form, code, `${code} must be normalised`);
  }
});

test('VALIDATE: invalid dosage_form is rejected with the allowed-codes message', async () => {
  const { res, captured } = makeRes();
  await withMockedDb(noExistingMedications, async () => {
    await validateMedicationImport(importReq(csv(HEADER, row({ dosage_form: 'PILLS' }))), res);
  });

  assert.equal(captured.status, 200);
  assert.equal(captured.body.preview.validNew, 0);
  assert.equal(captured.body.preview.invalid, 1);
  assert.match(String(captured.body.preview.invalidRows[0].error), /TABLET/);
  assert.equal(captured.body.preview.invalidRows[0].raw.dosage_form, 'PILLS');
});

test('VALIDATE: empty strength and empty dosage_form cells are rejected', async () => {
  const cases: [string, RegExp][] = [
    [row({ strength: '' }), /قوة الدواء/],
    [row({ dosage_form: '' }), /شكل الدواء/],
  ];

  for (const [line, expected] of cases) {
    const { res, captured } = makeRes();
    await withMockedDb(noExistingMedications, async () => {
      await validateMedicationImport(importReq(csv(HEADER, line)), res);
    });
    assert.equal(captured.status, 200, 'an empty cell is a row-level rejection, not a file-level one');
    assert.equal(captured.body.preview.validNew, 0);
    assert.equal(captured.body.preview.invalid, 1);
    assert.match(String(captured.body.preview.invalidRows[0].error), expected);
  }
});

/* ==========================================================================
 * 3. IMPORT EXECUTION (/import)
 * ========================================================================== */

test('IMPORT: batch INSERT uses six parameters per row in canonical order', async () => {
  const { res, captured } = makeRes();
  let clientCalls: QueryCall[] = [];
  const second = row({
    trade_name: 'Zithromax', scientific_name: 'Azithromycin', strength: '250 mg',
    dosage_form: 'SYRUP', default_dosage: '', instructions: '',
  });

  await withMockedDb(noExistingMedications, async (_calls, calls) => {
    clientCalls = calls;
    await executeMedicationImport(importReq(csv(HEADER, row(), second)), res);
  });

  assert.equal(captured.status, 201);
  assert.equal(captured.body.result.added, 2);

  const insert = clientCalls.find((c) => c.text.includes('INSERT INTO medications'));
  assert.ok(insert, 'INSERT must be executed');
  assert.match(insert.text, /trade_name, scientific_name, strength, dosage_form, default_dosage, instructions/);
  assert.match(insert.text, /\(\$1, \$2, \$3, \$4, \$5, \$6\), \(\$7, \$8, \$9, \$10, \$11, \$12\)/);
  assert.equal(insert.params.length, 12, 'six parameters per imported row');
  assert.deepEqual(insert.params.slice(0, 6), ['Amoxil', 'Amoxicillin', '500 mg', 'CAPSULE', '1 x 3', 'after food']);
  assert.deepEqual(insert.params.slice(6, 12), ['Zithromax', 'Azithromycin', '250 mg', 'SYRUP', null, null]);

  assert.equal(clientCalls.some((c) => c.text === 'BEGIN'), true);
  assert.equal(clientCalls.some((c) => c.text === 'COMMIT'), true);
  assert.equal(clientCalls.some((c) => c.text.includes('MEDICATIONS_IMPORTED')), true, 'audit log entry is written');
});

test('IMPORT: invalid dosage_form rows fail while valid rows are still imported', async () => {
  const { res, captured } = makeRes();
  let clientCalls: QueryCall[] = [];

  await withMockedDb(noExistingMedications, async (_calls, calls) => {
    clientCalls = calls;
    await executeMedicationImport(
      importReq(csv(HEADER, row(), row({ trade_name: 'BadDrug', dosage_form: 'PILLS' }))),
      res,
    );
  });

  assert.equal(captured.status, 201);
  assert.equal(captured.body.result.totalRows, 2);
  assert.equal(captured.body.result.added, 1);
  assert.equal(captured.body.result.failed, 1);

  const insert = clientCalls.find((c) => c.text.includes('INSERT INTO medications'));
  assert.ok(insert, 'only the valid row is inserted');
  assert.equal(insert.params.length, 6);
  assert.equal(insert.params[0], 'Amoxil');
});
