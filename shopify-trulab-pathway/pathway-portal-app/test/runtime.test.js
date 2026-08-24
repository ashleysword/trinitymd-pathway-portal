import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnvironment } from '../src/runtime.js';

function environment(overrides = {}) {
  return {
    SHOP_DOMAIN: 'trinity-test.myshopify.com',
    SHOPIFY_CLIENT_ID: 'client-id',
    SHOPIFY_API_SECRET: 'app-secret',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PORTAL_TOKEN_SECRET: 'portal-secret',
    ...overrides,
  };
}

test('loads the same portal configuration for server and serverless hosts', () => {
  const config = configFromEnvironment(environment());
  assert.equal(config.shop, 'trinity-test.myshopify.com');
  assert.equal(config.clinicTag, 'clinics');
  assert.equal(config.maxProxyAge, 300);
  assert.equal(config.encryptionKey.length, 32);
});

test('rejects missing Shopify credentials during cold-start initialization', () => {
  assert.throws(
    () => configFromEnvironment(environment({ SHOPIFY_CLIENT_ID: '' })),
    /Missing SHOPIFY_CLIENT_ID/,
  );
});

test('rejects an unsafe proxy timestamp window', () => {
  assert.throws(
    () => configFromEnvironment(environment({ APP_PROXY_MAX_AGE_SECONDS: '3600' })),
    /between 30 and 900/,
  );
});
