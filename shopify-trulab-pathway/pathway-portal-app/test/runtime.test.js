import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnvironment, createPortalRuntime } from '../src/runtime.js';

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

test('keeps clinic portal v3 off and manual-review by default', () => {
  const config = configFromEnvironment(environment());
  assert.equal(config.clinicPortalEnabled, false);
  assert.equal(config.approvalMode, 'manual');
  assert.equal(config.customerTaggingEnabled, false);
  assert.equal(config.kitIdPattern, null);
});

test('validates clinic portal v3 settings', () => {
  assert.throws(() => configFromEnvironment(environment({ CLINIC_APPROVAL_MODE: 'sometimes' })), /manual or auto/);
  assert.throws(() => configFromEnvironment(environment({ KIT_ID_PATTERN: '(' })), /valid regular expression/);
  const config = configFromEnvironment(environment({ KIT_ID_PATTERN: 'TL[0-9]{8}', STAFF_USER_IDS: ' 1, 2 ,' }));
  assert.equal(config.kitIdPattern.test('TL00001234'), true);
  assert.equal(config.kitIdPattern.test('XTL00001234'), false);
  assert.deepEqual(config.staffUserIds, ['1', '2']);
});

test('requires an asset base before enabling clinic portal v3', () => {
  assert.throws(
    () => createPortalRuntime(environment({ CLINIC_PORTAL_ENABLED: 'true' })),
    /PORTAL_ASSET_BASE_URL is required/,
  );
  const runtime = createPortalRuntime(environment({ CLINIC_PORTAL_ENABLED: 'true', PORTAL_ASSET_BASE_URL: 'https://portal.example' }));
  assert.ok(runtime.service);
});
