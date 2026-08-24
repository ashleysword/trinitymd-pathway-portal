import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  appProxyMessage,
  createPortalToken,
  decryptField,
  encryptField,
  verifyPortalToken,
  verifyShopifyAppProxy,
} from '../src/security.js';

function signedProxyUrl(overrides = {}) {
  const secret = overrides.secret || 'test-secret';
  const now = overrides.now || 1_800_000_000;
  const url = new URL('https://backend.example/proxy/api/assignments');
  url.searchParams.set('shop', 'trinity-test.myshopify.com');
  url.searchParams.set('logged_in_customer_id', '12345');
  url.searchParams.set('path_prefix', '/apps/pathway-portal');
  url.searchParams.set('timestamp', String(now));
  const signature = createHmac('sha256', secret).update(appProxyMessage(url)).digest('hex');
  url.searchParams.set('signature', signature);
  return { url, secret, now };
}

test('verifies a signed Shopify app proxy request', () => {
  const fixture = signedProxyUrl();
  const context = verifyShopifyAppProxy(fixture.url, fixture.secret, {
    expectedShop: 'trinity-test.myshopify.com',
    nowSeconds: fixture.now,
  });
  assert.equal(context.customerId, '12345');
});

test('rejects an expired Shopify app proxy request', () => {
  const fixture = signedProxyUrl();
  assert.throws(() => verifyShopifyAppProxy(fixture.url, fixture.secret, {
    nowSeconds: fixture.now + 301,
  }), /Expired/);
});

test('portal token is bound to the clinic and shop', () => {
  const context = { shop: 'trinity-test.myshopify.com', customerId: '12345' };
  const token = createPortalToken(context, 'portal-secret', 1000);
  assert.equal(verifyPortalToken(token, 'portal-secret', context, 1001).customerId, '12345');
  assert.throws(() => verifyPortalToken(token, 'portal-secret', { ...context, customerId: '99' }, 1001));
});

test('encrypts and decrypts identifying fields with AES-256-GCM', () => {
  const key = randomBytes(32);
  const sealed = encryptField('J. Smith', key);
  assert.notEqual(sealed, 'J. Smith');
  assert.equal(decryptField(sealed, key), 'J. Smith');
});
