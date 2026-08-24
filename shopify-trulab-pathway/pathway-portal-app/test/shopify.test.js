import test from 'node:test';
import assert from 'node:assert/strict';
import { ShopifyAdminClient } from '../src/shopify.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('obtains and caches a Shopify client-credentials token', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/admin/oauth/access_token')) {
      return jsonResponse({ access_token: 'dynamic-token', expires_in: 86400 });
    }
    assert.equal(options.headers['X-Shopify-Access-Token'], 'dynamic-token');
    return jsonResponse({ data: { shop: { id: 'gid://shopify/Shop/1' } } });
  };
  const client = new ShopifyAdminClient({
    shop: 'trinity-test.myshopify.com',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl,
    now: () => 1_800_000_000_000,
  });

  await client.graphql('query { shop { id } }');
  await client.graphql('query { shop { id } }');
  assert.equal(requests.filter(({ url }) => url.endsWith('/admin/oauth/access_token')).length, 1);
  assert.equal(requests.length, 3);
  assert.match(String(requests[0].options.body), /grant_type=client_credentials/);
});

test('refreshes a dynamic token once after a 401 response', async () => {
  let tokenRequests = 0;
  let graphqlRequests = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/admin/oauth/access_token')) {
      tokenRequests += 1;
      return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: 86400 });
    }
    graphqlRequests += 1;
    if (graphqlRequests === 1) return jsonResponse({ error: 'expired' }, 401);
    assert.equal(options.headers['X-Shopify-Access-Token'], 'token-2');
    return jsonResponse({ data: { shop: { id: 'gid://shopify/Shop/1' } } });
  };
  const client = new ShopifyAdminClient({
    shop: 'trinity-test.myshopify.com',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl,
  });

  await client.graphql('query { shop { id } }');
  assert.equal(tokenRequests, 2);
  assert.equal(graphqlRequests, 2);
});

test('supports a fixed legacy Admin API token without a token exchange', async () => {
  const urls = [];
  const client = new ShopifyAdminClient({
    shop: 'trinity-test.myshopify.com',
    adminAccessToken: 'legacy-token',
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers['X-Shopify-Access-Token'], 'legacy-token');
      return jsonResponse({ data: { shop: { id: 'gid://shopify/Shop/1' } } });
    },
  });

  await client.graphql('query { shop { id } }');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/admin\/api\/2026-07\/graphql\.json$/);
});
