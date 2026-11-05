import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPortalHandler } from '../src/app.js';
import { ClinicPortalService } from '../src/clinic-portal.js';
import { createClinicRoutes } from '../src/clinic-routes.js';
import { MemoryFileStore } from '../src/file-store.js';
import { OutboxNotifier } from '../src/notifier.js';
import { MemoryPortalRepository } from '../src/portal-repository.js';
import { appProxyMessage } from '../src/security.js';
import { createStaffAuthenticator, verifySessionToken } from '../src/staff-auth.js';

const NOW = 1_800_000_000;
const SHOP = 'trinity-test.myshopify.com';
const SECRET = 'test-app-secret';
const CLIENT_ID = 'test-client';

const config = {
  shop: SHOP, appSecret: SECRET, clientId: CLIENT_ID, portalTokenSecret: 'portal-secret', maxProxyAge: 300, clinicTag: 'clinics',
  approvalMode: 'manual', customerTaggingEnabled: false, kitIdPattern: null, kitIdExample: '', staffUserIds: [],
  assetBaseUrl: 'https://portal.example', storefrontUrl: 'https://trinitymd.shop',
};

function signed(pathname, customerId = '1001', extra = {}) {
  const url = new URL(`https://portal.example${pathname}`);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  url.searchParams.set('shop', SHOP);
  url.searchParams.set('logged_in_customer_id', customerId);
  url.searchParams.set('path_prefix', '/apps/pathway-portal');
  url.searchParams.set('timestamp', String(NOW));
  url.searchParams.set('signature', createHmac('sha256', SECRET).update(appProxyMessage(url)).digest('hex'));
  return url;
}

function sessionToken(overrides = {}, secret = SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: CLIENT_ID, sub: '7001', exp: NOW + 60, nbf: NOW - 5, iat: NOW, ...overrides,
  })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}

function fixture({ enabled = true } = {}) {
  const customers = {
    1001: { id: 'gid://shopify/Customer/1001', email: 'dana@example.com', firstName: 'Dana', lastName: 'E', tags: ['clinics'] },
    1002: { id: 'gid://shopify/Customer/1002', email: 'riley@example.com', firstName: 'Riley', lastName: 'A', tags: [] },
  };
  const shopify = {
    async graphql(query, variables) {
      if (query.includes('PortalCustomer')) return { customer: customers[variables.id.split('/').pop()] || null };
      throw new Error(`unexpected ${query}`);
    },
  };
  const service = new ClinicPortalService({
    repository: new MemoryPortalRepository(), shopify, encryptionKey: Buffer.alloc(32, 3), notifier: new OutboxNotifier(), fileStore: new MemoryFileStore(), config,
  });
  const staffAuth = createStaffAuthenticator(config, { nowSeconds: () => NOW });
  const handler = createPortalHandler({
    config,
    shopify,
    assignmentStore: { listAssignments: async () => [], createAssignments: async () => [] },
    logger: { error() {} },
    nowSeconds: () => NOW,
    clinicRoutes: enabled ? (deps) => createClinicRoutes({ ...deps, service, config, staffAuth }) : null,
  });
  return { handler, service };
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('clinic portal routes return 404 when the feature flag is off', async () => {
  const { handler } = fixture({ enabled: false });
  assert.equal((await handler(new Request(signed('/proxy/clinic')))).status, 404);
  assert.equal((await handler(new Request('https://portal.example/staff/api/overview'))).status, 404);
});

test('serves the portal page through the signed proxy with a strict CSP', async () => {
  const { handler } = fixture();
  const response = await handler(new Request(signed('/proxy/clinic', '')));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /script-src https:\/\/portal\.example/);
  assert.match(await response.text(), /data-api-base="\/apps\/pathway-portal\/api\/clinic"/);
});

test('rejects unsigned or tampered proxy requests', async () => {
  const { handler } = fixture();
  const url = signed('/proxy/api/clinic/kits');
  url.searchParams.set('logged_in_customer_id', '1002');
  assert.equal((await handler(new Request(url))).status, 401);
  assert.equal((await handler(new Request('https://portal.example/proxy/api/clinic/kits'))).status, 401);
});

test('session endpoint distinguishes signed-out, applicant, and clinic accounts', async () => {
  const { handler } = fixture();
  assert.equal((await json(await handler(new Request(signed('/proxy/api/clinic/session', ''))))).body.signedIn, false);
  const applicant = (await json(await handler(new Request(signed('/proxy/api/clinic/session', '1002'))))).body;
  assert.equal(applicant.isClinic, false);
  const clinic = (await json(await handler(new Request(signed('/proxy/api/clinic/session', '1001'))))).body;
  assert.equal(clinic.isClinic, true);
  assert.ok(clinic.csrfToken);
});

test('clinic-only routes require the clinic tag and a customer-bound write token', async () => {
  const { handler } = fixture();
  assert.equal((await handler(new Request(signed('/proxy/api/clinic/kits', '1002')))).status, 403);
  assert.equal((await handler(new Request(signed('/proxy/api/clinic/kits', '')))).status, 401);

  const { csrfToken } = (await json(await handler(new Request(signed('/proxy/api/clinic/session', '1001'))))).body;
  const post = (body, customer = '1001') => handler(new Request(signed('/proxy/api/clinic/kits', customer), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal((await post({ kitId: 'KIT-0001' })).status, 401);
  const created = await json(await post({ kitId: 'KIT-0001', csrfToken }));
  assert.equal(created.status, 201);
  assert.equal(created.body.kit.kitId, 'KIT-0001');
  assert.equal((await post({ kitId: 'KIT-0001', csrfToken })).status, 200);
  const list = await json(await handler(new Request(signed('/proxy/api/clinic/kits'))));
  assert.equal(list.body.kits.length, 1);
  const detail = await json(await handler(new Request(signed('/proxy/api/clinic/kits/KIT-0001'))));
  assert.equal(detail.body.timeline.length, 1);
});

test('applicants submit applications through the proxy and get validation feedback', async () => {
  const { handler } = fixture();
  const { csrfToken } = (await json(await handler(new Request(signed('/proxy/api/clinic/session', '1002'))))).body;
  const submit = (body) => handler(new Request(signed('/proxy/api/clinic/applications', '1002'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, csrfToken }),
  }));
  const invalid = await json(await submit({ npi: '1' }));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.field, 'npi');
  const ok = await json(await submit({
    firstName: 'Riley', lastName: 'A', contactEmail: 'riley@example.com', company: 'Synthetic', businessType: 'Pharmacy',
    npi: '1234567893', taxId: '123456789', attestation: true, requestId: 'route-request-1',
  }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.application.status, 'pending');
});

test('staff API requires a valid Shopify session token', async () => {
  const { handler } = fixture();
  const call = (token) => handler(new Request('https://portal.example/staff/api/overview', { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
  assert.equal((await call()).status, 401);
  assert.equal((await call(sessionToken({}, 'wrong-secret'))).status, 401);
  assert.equal((await call(sessionToken({ aud: 'other-app' }))).status, 401);
  assert.equal((await call(sessionToken({ exp: NOW - 120 }))).status, 401);
  const ok = await json(await call(sessionToken()));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.staffId, '7001');
});

test('session token verification checks issuer, destination, store, and subject', () => {
  const options = { clientId: CLIENT_ID, clientSecret: SECRET, expectedShop: SHOP, nowSeconds: NOW };
  assert.equal(verifySessionToken(sessionToken(), options).staffId, '7001');
  assert.throws(() => verifySessionToken(sessionToken({ dest: 'https://other.myshopify.com' }), options));
  assert.throws(() => verifySessionToken(sessionToken({ iss: 'https://other.myshopify.com/admin' }), options));
  assert.throws(() => verifySessionToken(sessionToken({ sub: '' }), options));
  assert.throws(() => verifySessionToken(sessionToken({ nbf: NOW + 120 }), options));
  assert.throws(() => verifySessionToken('a.b', options));
});

test('staff allow list restricts which admin users can review', async () => {
  const auth = createStaffAuthenticator({ ...config, staffUserIds: ['42'] }, { nowSeconds: () => NOW });
  const request = new Request('https://x', { headers: { Authorization: `Bearer ${sessionToken()}` } });
  await assert.rejects(auth(request), (error) => error.statusCode === 403 && /staff ID 7001 to STAFF_USER_IDS/.test(error.message));
  const allowed = createStaffAuthenticator({ ...config, staffUserIds: ["0", JSON.parse(Buffer.from(sessionToken().split(".")[1], "base64url")).sub] }, { nowSeconds: () => NOW });
  assert.ok((await allowed(request)).staffId);
});

test('clinics can save their own reference on a kit, with a write token', async () => {
  const { handler } = fixture();
  const { csrfToken } = (await json(await handler(new Request(signed('/proxy/api/clinic/session', '1001'))))).body;
  const send = (pathname, body, customer = '1001') => handler(new Request(signed(pathname, customer), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  await send('/proxy/api/clinic/kits', { kitId: 'KIT-0002', csrfToken });
  assert.equal((await send('/proxy/api/clinic/kits/KIT-0002/reference', { clinicReference: 'Batch 7' })).status, 401, 'needs the write token');
  const saved = await json(await send('/proxy/api/clinic/kits/KIT-0002/reference', { clinicReference: 'Batch 7', csrfToken }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.kit.clinicReference, 'Batch 7');
  const list = await json(await handler(new Request(signed('/proxy/api/clinic/kits'))));
  assert.equal(list.body.kits[0].clinicReference, 'Batch 7');
  assert.equal((await handler(new Request(signed('/proxy/api/clinic/kits/KIT-0002/reference')))).status, 405);
});
