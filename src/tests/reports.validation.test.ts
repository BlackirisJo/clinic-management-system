import test from 'node:test';
import assert from 'node:assert/strict';
import { reportQuerySchema } from '../modules/reports/reports.validation';

test('applies defaults to a valid report query', () => {
  const result = reportQuerySchema.safeParse({ date_from: '2026-01-01', date_to: '2026-12-31' });
  assert.equal(result.success, true);
  if (result.success) assert.deepEqual(result.data, { date_from: '2026-01-01', date_to: '2026-12-31', page: 1, limit: 50 });
});

test('rejects reversed report periods and excessive limits', () => {
  assert.equal(reportQuerySchema.safeParse({ date_from: '2026-12-31', date_to: '2026-01-01' }).success, false);
  assert.equal(reportQuerySchema.safeParse({ limit: 101 }).success, false);
});