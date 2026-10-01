import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/auth.middleware';
import prescriptionsRouter from '../modules/prescriptions/prescriptions.routes';

/* ==========================================================================
 * Pharmacy route contract (Phase 10A regression)
 *
 * The Pharmacy section reported "المسار المطلوب غير موجود على الخادم" — the
 * backend's global ROUTE_NOT_FOUND. Two distinct causes can produce exactly
 * that string, and this suite locks both shut:
 *
 *   1. The queue request the UI actually makes must resolve to a registered
 *      backend route. Here it is GET /api/prescriptions/pharmacy/queue, built
 *      in frontend/src/lib/api.js and composed from the router path plus the
 *      /api/prescriptions mount. This suite derives both sides from the
 *      repository and proves they agree, so the two can never drift apart
 *      silently again.
 *
 *   2. The SPA has no client-side router, so no view may navigate to a URL
 *      path. The queue's "view" action used to do exactly that
 *      (window.open('/prescriptions/:id')), which is served by nothing and
 *      lands on the same global 404.
 * ======================================================================== */

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const API_JS = read('frontend/src/lib/api.js');
const PHARMACY_VIEW = read('frontend/src/views/PharmacyView.jsx');
const LAYOUT_JSX = read('frontend/src/components/Layout.jsx');
const APP_TS = read('src/app.ts');

/** The path the UI sends, read from the source rather than restated here. */
const uiQueuePath = (): string => {
  const match = API_JS.match(/getPharmacyQueue:\s*\(\)\s*=>\s*request\(\s*'([^']+)'(\s*,\s*\{[^}]*\})?\s*\)/);
  assert.ok(match, 'api.prescriptions.getPharmacyQueue exists');
  const method = match[2]?.match(/method:\s*'([^']+)'/)?.[1] ?? 'GET';
  return `${method.toUpperCase()} ${match[1]!}`;
};

/** The path the server exposes, read from the live router object. */
const backendRoutes = (): string[] =>
  (prescriptionsRouter as any).stack
    .filter((layer: any) => layer.route)
    .flatMap((layer: any) =>
      Object.keys(layer.route.methods).map((method: string) => `${method.toUpperCase()} ${layer.route.path}`),
    );

/* ==========================================================================
 * 1-4. THE REQUEST THE UI MAKES RESOLVES
 * ======================================================================== */

test('PHARMACY ROUTE: the request the UI sends is exactly GET /api/prescriptions/pharmacy/queue', () => {
  assert.equal(uiQueuePath(), 'GET /api/prescriptions/pharmacy/queue');
});

test('PHARMACY ROUTE: the prescriptions router registers GET /pharmacy/queue', () => {
  assert.ok(
    backendRoutes().includes('GET /pharmacy/queue'),
    `registered routes: ${backendRoutes().join(', ')}`,
  );
});

test('PHARMACY ROUTE: the router is mounted at /api/prescriptions, so the composed path matches', () => {
  const mount = APP_TS.match(/app\.use\('(\/api\/prescriptions)',\s*prescriptionsRoutes\)/);
  assert.ok(mount, 'prescriptionsRoutes is mounted at /api/prescriptions');

  const composed = `${mount[1]}${'/pharmacy/queue'}`;
  const [method, uiPath] = uiQueuePath().split(' ');
  assert.equal(`${method} ${composed}`, uiQueuePath(), 'the composed backend path is the UI path');
});

test('PHARMACY ROUTE: the queue path is not shadowed by the /:id read route', () => {
  const paths = (prescriptionsRouter as any).stack
    .filter((layer: any) => layer.route && Object.keys(layer.route.methods).includes('get'))
    .map((layer: any) => layer.route.path);

  const queueAt = paths.indexOf('/pharmacy/queue');
  assert.ok(queueAt > 0, 'the queue route is registered');
  assert.ok(!paths.some((p: string) => p === '/pharmacy'), 'there is no single-segment path that could swallow it');
  // Express matches in registration order, so the queue must come before /:id
  const idAt = paths.indexOf('/:id');
  assert.ok(idAt > 0 && queueAt < idAt, `"${paths.join(', ')}" — /pharmacy/queue must precede /:id`);
});

/* ==========================================================================
 * 5-7. NO VIEW MAY NAVIGATE TO A URL PATH
 * ======================================================================== */

test('PHARMACY ROUTE: no view navigates by URL path — the SPA has no client-side router', () => {
  // The shell switches views by state (App.jsx), so a window.open to a path
  // leaves the app and hits the backend's global 404 handler.
  assert.ok(!/<Route\s|BrowserRouter|createBrowserRouter|useNavigate/.test(read('frontend/src/App.jsx')),
    'this assertion depends on there being no client-side router');
  assert.doesNotMatch(PHARMACY_VIEW, /window\.open\(`?\/|window\.location|history\.pushState/,
    'the pharmacy view must not leave the SPA by URL');
  assert.match(PHARMACY_VIEW, /onNavigate\?\.\('prescriptions'\)/,
    'the view action navigates through the existing onNavigate convention');
});

test('PHARMACY ROUTE: the navigation target is a real registered section', () => {
  assert.match(PHARMACY_VIEW, /function PharmacyView\(\{\s*onNavigate\s*\}\)/,
    'the view receives onNavigate from the shell');
  assert.match(read('frontend/src/App.jsx'), /<ActiveView\s+onNavigate=\{setActive\}/,
    'App.jsx supplies onNavigate to every view');
  const ids = [...LAYOUT_JSX.matchAll(/id:\s*'([^']+)',\s*label:/g)].map((m) => m[1]!);
  assert.ok(ids.includes('prescriptions'), `"${ids.join(', ')}" — prescriptions is a nav section`);
  // The shell silently falls back when a section is not permitted, so a
  // pharmacist clicking through lands back on a permitted section, never a 404.
  assert.match(read('frontend/src/App.jsx'), /allowed\.some\(\(item\)\s*=>\s*item\.id === active\)/);
});

/* ==========================================================================
 * 8-10. AUTHORIZATION IS UNCHANGED
 * ======================================================================== */

test('PHARMACY AUTH: the queue route still requires VIEW_PHARMACY_QUEUE behind authentication', async () => {
  const fs2 = await import('node:fs');
  const compiled = fs2.readFileSync(path.join(ROOT, 'dist/modules/prescriptions/prescriptions.routes.js'), 'utf8');
  assert.match(compiled, /router\.use\(auth_middleware_1\.authenticateJWT\)/, 'the whole router stays authenticated');
  assert.match(compiled, /router\.get\('\/pharmacy\/queue', \(0, auth_middleware_1\.requirePermission\)\('VIEW_PHARMACY_QUEUE'\)/);

  const refused = (permissions: string[]) => {
    const request = {
      user: { userId: 9, roleId: 4, clinicId: 1, roleName: 'PHARMACIST', permissions },
    } as unknown as AuthenticatedRequest;
    let error: any = null;
    requirePermission('VIEW_PHARMACY_QUEUE')(request, {} as any, (err?: unknown) => { error = err ?? null; });
    return error !== null;
  };

  assert.equal(refused(['VIEW_PHARMACY_QUEUE']), false, 'a pharmacist holding the right is allowed');
  assert.equal(refused(['VIEW_PRESCRIPTIONS']), true, 'VIEW_PRESCRIPTIONS alone is not the queue right');
  assert.equal(refused(['MANAGE_MEDICATIONS']), true, 'medication management is not the queue right');
  assert.equal(refused([]), true, 'no right means denied');
});

test('PHARMACY AUTH: admins keep their existing bypass and the role grant is intact', () => {
  const admins: Array<[string, string[]]> = [
    ['SUPER_ADMIN', []],
    ['SYSTEM_ADMIN', []],
  ];
  for (const [roleName, permissions] of admins) {
    const request = {
      user: { userId: 1, roleId: 1, clinicId: null, roleName, permissions },
    } as unknown as AuthenticatedRequest;
    let error: any = null;
    requirePermission('VIEW_PHARMACY_QUEUE')(request, {} as any, (err?: unknown) => { error = err ?? null; });
    assert.equal(error, null, `${roleName} keeps the administrative bypass`);
  }

  const migration = read('src/database/migrations/028_pharmacist_role_pharmacy_permissions.sql');
  assert.match(migration, /'VIEW_PRESCRIPTIONS', 'Pharmacy'/);
  assert.match(migration, /'VIEW_PHARMACY_QUEUE', 'Pharmacy'/);
  assert.match(migration, /WHERE r\.role_name = 'PHARMACIST'[\s\S]*'VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE'/,
    'PHARMACIST still receives both pharmacy permissions');

  assert.match(LAYOUT_JSX, /\{ id: 'pharmacy', label: 'navigation\.pharmacy', icon: '[^']+', permission: 'VIEW_PHARMACY_QUEUE' \}/,
    'the pharmacy section is gated by the same permission, unchanged');
});
