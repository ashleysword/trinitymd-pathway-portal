import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPortalHandler } from '../src/app.js';
import { appProxyMessage } from '../src/security.js';

const NOW_SECONDS = 1_800_000_000;
const SHOP = 'trinity-test.myshopify.com';
const APP_SECRET = 'test-app-secret';

function signedRequestUrl(pathname = '/proxy/api/assignments') {
  const url = new URL(`https://pathway-portal.example${pathname}`);
  url.searchParams.set('shop', SHOP);
  url.searchParams.set('logged_in_customer_id', '12345');
  url.searchParams.set('path_prefix', '/apps/pathway-portal');
  url.searchParams.set('timestamp', String(NOW_SECONDS));
  url.searchParams.set(
    'signature',
    createHmac('sha256', APP_SECRET).update(appProxyMessage(url)).digest('hex'),
  );
  return url;
}

function fixture(overrides = {}) {
  const calls = { created: [], graphql: [], listed: [] };
  const shopify = {
    async graphql(query, variables) {
      calls.graphql.push({ query, variables });
      if (query.includes('PortalHealth')) return { shop: { id: 'gid://shopify/Shop/1' } };
      return {
        customer: {
          id: 'gid://shopify/Customer/12345',
          email: overrides.email || 'clinic@example.com',
          firstName: overrides.firstName || 'Jamie',
          lastName: overrides.lastName || 'Smith',
          tags: overrides.tags || ['clinics'],
        },
      };
    },
  };
  const assignmentStore = {
    async listAssignments(context) {
      calls.listed.push(context);
      return overrides.assignments || [];
    },
    async createAssignments(context, assignments) {
      calls.created.push({ assignments, context });
      return assignments.map((assignment, index) => ({
        id: `gid://shopify/Metaobject/${index + 1}`,
        ...assignment,
        status: 'assigned',
        providerReviewStatus: 'not_started',
      }));
    },
  };
  const handler = createPortalHandler({
    assignmentStore,
    config: {
      appSecret: APP_SECRET,
      clinicTag: 'clinics',
      maxProxyAge: 300,
      portalTokenSecret: 'test-portal-secret',
      shop: SHOP,
    },
    logger: { error() {} },
    nowSeconds: () => NOW_SECONDS,
    shopify,
  });
  return { calls, handler };
}

test('returns assignments and a clinic-bound write token for a signed GET', async () => {
  const existing = [{ id: 'gid://shopify/Metaobject/8', kitId: 'KIT-0008' }];
  const { calls, handler } = fixture({ assignments: existing });
  const response = await handler(new Request(signedRequestUrl()));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.deepEqual(payload.assignments, existing);
  assert.match(payload.csrfToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(calls.listed[0].customerId, '12345');
});

test('creates a normalized assignment after validating the write token', async () => {
  const { calls, handler } = fixture();
  const getResponse = await handler(new Request(signedRequestUrl()));
  const { csrfToken } = await getResponse.json();
  const response = await handler(new Request(signedRequestUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csrfToken,
      assignments: [{
        kitId: ' kit-1001 ',
        clientEmail: 'CLIENT@EXAMPLE.COM',
        clientName: 'j smith',
      }],
    }),
  }));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(calls.created[0].assignments, [{
    kitId: 'KIT-1001',
    clientEmail: 'client@example.com',
    clientName: 'J. smith',
  }]);
  assert.equal(payload.assignments[0].status, 'assigned');
});

test('rejects an unsigned proxy request before accessing Shopify', async () => {
  const { calls, handler } = fixture();
  const response = await handler(new Request('https://pathway-portal.example/proxy/api/assignments'));
  assert.equal(response.status, 401);
  assert.equal(calls.graphql.length, 0);
});

test('rejects a signed-in customer without the clinic tag', async () => {
  const { handler } = fixture({ tags: ['retail'] });
  const response = await handler(new Request(signedRequestUrl()));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Approved clinic access is required.' });
});

test('returns only the signed-in customer kit fields and a write token', async () => {
  const existing = [{
    id: 'gid://shopify/Metaobject/18',
    kitId: 'KIT-0018',
    clientEmail: 'retail@example.com',
    clientName: 'R. Customer',
    status: 'assigned',
    providerReviewStatus: 'not_started',
    createdAt: '2026-09-24T12:00:00.000Z',
    updatedAt: '2026-09-24T12:00:00.000Z',
  }];
  const { handler } = fixture({ assignments: existing, tags: ['retail'] });
  const response = await handler(new Request(signedRequestUrl('/proxy/api/customer-kits')));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.kits, [{
    id: 'gid://shopify/Metaobject/18',
    kitId: 'KIT-0018',
    status: 'assigned',
    providerReviewStatus: 'not_started',
    registeredAt: '2026-09-24T12:00:00.000Z',
    updatedAt: '2026-09-24T12:00:00.000Z',
  }]);
  assert.equal(Object.hasOwn(payload.kits[0], 'clientEmail'), false);
  assert.match(payload.csrfToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('registers a customer kit using identity loaded from Shopify', async () => {
  const { calls, handler } = fixture({
    email: 'RETAIL@EXAMPLE.COM',
    firstName: 'riley',
    lastName: 'jones',
    tags: ['retail'],
  });
  const getResponse = await handler(new Request(signedRequestUrl('/proxy/api/customer-kits')));
  const { csrfToken } = await getResponse.json();
  const response = await handler(new Request(signedRequestUrl('/proxy/api/customer-kits'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, kitId: ' ptw-9001 ' }),
  }));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(calls.created[0].assignments, [{
    kitId: 'PTW-9001',
    clientEmail: 'retail@example.com',
    clientName: 'R. jones',
  }]);
  assert.equal(payload.kit.kitId, 'PTW-9001');
  assert.equal(Object.hasOwn(payload.kit, 'clientEmail'), false);
});

test('rejects oversized JSON before processing an assignment', async () => {
  const { calls, handler } = fixture();
  const response = await handler(new Request(signedRequestUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(70000) }),
  }));
  assert.equal(response.status, 422);
  assert.equal(calls.created.length, 0);
});

test('health check confirms Shopify connectivity without exposing shop data', async () => {
  const { handler } = fixture();
  const response = await handler(new Request('https://pathway-portal.example/healthz'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
