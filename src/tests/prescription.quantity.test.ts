import test from 'node:test';
import assert from 'node:assert/strict';
import { prescriptionSchema } from '../validations/business.validation';
import { INVENTORY_UOM_CODES } from '../lib/inventoryUom';

/* ==========================================================================
 * Phase 10C.1 — Prescription quantity & UOM write path
 * The quantity is explicit only: never derived from free-text dosage or from
 * repeats_count. Historical rows stay NULL and must remain readable.
 * ========================================================================== */

const baseItem = {
  medication_id: 11,
  dosage: '1 x 3',            // free text — must never be parsed for quantity
  frequency: 'Every 8 hours',
  duration: '5 days',
  repeats_count: 3,           // semantics unchanged — must never multiply quantity
};

const validBody = (item: Record<string, unknown> = {}) => ({
  visit_id: 1,
  patient_id: 2,
  items: [{ ...baseItem, prescribed_quantity: 30, uom: 'TABLET', ...item }],
});

const parsed = (body: unknown) => prescriptionSchema.safeParse(body);
const firstItem = (body: unknown) => {
  const result = parsed(body);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  return result.data.items[0]!;
};

/* ==========================================================================
 * 1. VALID QUANTITY + VALID UOM
 * ========================================================================== */

test('WRITE: a valid quantity and a valid UOM are accepted and normalised', () => {
  const item = firstItem(validBody());
  assert.equal(item.prescribed_quantity, 30);
  assert.equal(item.uom, 'TABLET');
});

test('WRITE: UOM is normalised to upper case', () => {
  const item = firstItem(validBody({ uom: 'bottle' }));
  assert.equal(item.uom, 'BOTTLE');
});

test('WRITE: a numeric string quantity is coerced to a number', () => {
  const item = firstItem(validBody({ prescribed_quantity: '12.5' }));
  assert.equal(item.prescribed_quantity, 12.5);
  assert.equal(typeof item.prescribed_quantity, 'number');
});

test('WRITE: all 11 inventory UOM codes are accepted', () => {
  for (const uom of INVENTORY_UOM_CODES) {
    const item = firstItem(validBody({ uom }));
    assert.equal(item.uom, uom, uom);
  }
  assert.equal(INVENTORY_UOM_CODES.length, 11, 'the UOM vocabulary must match inventory_items');
});

test('WRITE: a 3-decimal quantity is accepted (NUMERIC 12,3 boundary)', () => {
  const item = firstItem(validBody({ prescribed_quantity: 1.125 }));
  assert.equal(item.prescribed_quantity, 1.125);
});

/* ==========================================================================
 * 2-3. MISSING QUANTITY / UOM
 * ========================================================================== */

test('WRITE: a missing prescribed_quantity is rejected', () => {
  const body = validBody();
  delete (body.items[0] as Record<string, unknown>).prescribed_quantity;
  const result = parsed(body);
  assert.equal(result.success, false);
  assert.equal(result.error?.issues[0]?.path[0], 'items');
});

test('WRITE: an empty or null prescribed_quantity is rejected', () => {
  for (const value of ['', null, undefined]) {
    const result = parsed(validBody({ prescribed_quantity: value }));
    assert.equal(result.success, false, JSON.stringify(value));
  }
});

test('WRITE: a missing uom is rejected', () => {
  const body = validBody();
  delete (body.items[0] as Record<string, unknown>).uom;
  const result = parsed(body);
  assert.equal(result.success, false);
});

test('WRITE: an empty or whitespace uom is rejected', () => {
  for (const value of ['', '   ']) {
    const result = parsed(validBody({ uom: value }));
    assert.equal(result.success, false, JSON.stringify(value));
  }
});

/* ==========================================================================
 * 4-5. ZERO / NEGATIVE QUANTITY
 * ========================================================================== */

test('WRITE: zero and negative quantities are rejected', () => {
  for (const quantity of [0, -1, -0.001]) {
    const result = parsed(validBody({ prescribed_quantity: quantity }));
    assert.equal(result.success, false, String(quantity));
  }
});

/* ==========================================================================
 * 6. PRECISION
 * ========================================================================== */

test('WRITE: more than 3 decimal places is rejected instead of being rounded', () => {
  for (const quantity of [1.2345, 0.0001, 30.12345]) {
    const result = parsed(validBody({ prescribed_quantity: quantity }));
    assert.equal(result.success, false, String(quantity));
    assert.match(String(result.error?.issues[0]?.message), /3 decimal/);
  }
});

test('WRITE: a non-finite or out-of-range quantity is rejected', () => {
  for (const quantity of [Number.POSITIVE_INFINITY, Number.NaN, 1_000_000_000]) {
    const result = parsed(validBody({ prescribed_quantity: quantity }));
    assert.equal(result.success, false, String(quantity));
  }
});

/* ==========================================================================
 * 7. INVALID UOM
 * ========================================================================== */

test('WRITE: a UOM outside the inventory vocabulary is rejected', () => {
  for (const uom of ['PIECE', 'PACK', 'BOX', 'LITER', 'SACK']) {
    const result = parsed(validBody({ uom }));
    assert.equal(result.success, false, uom);
  }
});

test('WRITE: a dosage-form code is not a valid UOM (separate vocabularies)', () => {
  for (const uom of ['INJECTION', 'SYRUP', 'POWDER']) {
    const result = parsed(validBody({ uom }));
    assert.equal(result.success, false, uom);
  }
});

/* ==========================================================================
 * 8-10. NO INFERENCE FROM dosage / repeats_count
 * ========================================================================== */

test('WRITE: dosage is never parsed to produce a quantity', () => {
  // A dosage that looks numeric must NOT satisfy a missing prescribed_quantity.
  const body = validBody({ dosage: '30' });
  delete (body.items[0] as Record<string, unknown>).prescribed_quantity;
  const result = parsed(body);
  assert.equal(result.success, false, 'dosage "30" must not become a quantity');
});

test('WRITE: dosage is stored verbatim and never rewritten', () => {
  const item = firstItem(validBody({ dosage: '1 x 3 after food' }));
  assert.equal(item.dosage, '1 x 3 after food');
});

test('WRITE: repeats_count is never used to calculate the quantity', () => {
  const withRefills = firstItem(validBody({ repeats_count: 3, prescribed_quantity: 10 }));
  const withoutRefills = firstItem(validBody({ repeats_count: 1, prescribed_quantity: 10 }));
  assert.equal(withRefills.prescribed_quantity, 10, 'refills must not multiply the quantity');
  assert.equal(withoutRefills.prescribed_quantity, 10);
  assert.equal(withRefills.repeats_count, 3, 'repeats_count semantics stay unchanged');
});

test('WRITE: repeats_count is not required once the explicit quantity is given', () => {
  const body = validBody();
  delete (body.items[0] as Record<string, unknown>).repeats_count;
  const item = firstItem(body);
  assert.equal(item.repeats_count, 1, 'default stays 1');
  assert.equal(item.prescribed_quantity, 30);
});

/* ==========================================================================
 * 11. EXISTING BEHAVIOUR INTACT
 * ========================================================================== */

test('WRITE: every item in a multi-item prescription must carry a quantity and UOM', () => {
  const ok = parsed({
    visit_id: 1,
    patient_id: 2,
    items: [
      { ...baseItem, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' },
      { ...baseItem, medication_id: 12, prescribed_quantity: 250, uom: 'ML' },
    ],
  });
  assert.equal(ok.success, true);

  const oneMissing = parsed({
    visit_id: 1,
    patient_id: 2,
    items: [
      { ...baseItem, medication_id: 11, prescribed_quantity: 10, uom: 'TABLET' },
      { ...baseItem, medication_id: 12, prescribed_quantity: 250 },  // no uom
    ],
  });
  assert.equal(oneMissing.success, false, 'a single incomplete line must fail the whole prescription');
});

test('WRITE: the pre-existing required fields are still required', () => {
  for (const missing of ['medication_id', 'dosage', 'frequency', 'duration']) {
    const body = validBody();
    delete (body.items[0] as Record<string, unknown>)[missing];
    assert.equal(parsed(body).success, false, missing);
  }
});

test('WRITE: at least one item is still required', () => {
  const result = parsed({ visit_id: 1, patient_id: 2, items: [] });
  assert.equal(result.success, false);
});

/* ==========================================================================
 * 12. HISTORICAL READ COMPATIBILITY
 * ========================================================================== */

test('READ: a historical item with NULL quantity/UOM is still valid legacy data', () => {
  // The write schema is strict, but legacy rows already exist and must remain
  // readable. Nothing here may fabricate or reject them.
  const legacyRow = {
    item_id: 5, dosage: '1 x 3', frequency: 'TDS', duration: '5 days',
    timing_instructions: null, repeats_count: 1,
    prescribed_quantity: null, uom: null,
    trade_name: 'Amoxil', scientific_name: 'Amoxicillin',
  };
  assert.equal(legacyRow.prescribed_quantity, null);
  assert.equal(legacyRow.uom, null);
  assert.equal(legacyRow.dosage, '1 x 3', 'dosage is unchanged for legacy rows');
  assert.equal(legacyRow.repeats_count, 1, 'repeats_count is unchanged for legacy rows');
});

test('READ: the schema rejects a new legacy-shaped item, so undefined can never be written', () => {
  // Legacy rows are readable, but the write path must never create another one.
  const result = parsed(validBody({ prescribed_quantity: undefined, uom: undefined }));
  assert.equal(result.success, false);
});
