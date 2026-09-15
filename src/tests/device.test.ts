import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceLabel } from '../utils/device';

test('labels common desktop browsers', () => {
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    'Chrome — Windows'
  );
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'),
    'Edge — Windows'
  );
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'),
    'Safari — macOS'
  );
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'),
    'Firefox — Linux'
  );
});

test('labels mobile devices', () => {
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'Safari — iPhone'
  );
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'),
    'Chrome — Android'
  );
  assert.equal(
    parseDeviceLabel('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'Safari — iPad'
  );
});

test('falls back gracefully for missing or exotic user agents', () => {
  assert.equal(parseDeviceLabel(null), 'جهاز غير معروف');
  assert.equal(parseDeviceLabel(undefined), 'جهاز غير معروف');
  assert.equal(parseDeviceLabel(''), 'جهاز غير معروف');
  assert.equal(parseDeviceLabel('SomeWeirdClient/1.0'), 'متصفح غير معروف — نظام غير معروف');
});