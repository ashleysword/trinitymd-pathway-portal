import test from 'node:test';
import assert from 'node:assert/strict';
import pathwayPortal, { config } from '../netlify/functions/pathway-portal.mjs';

test('publishes the Shopify proxy and health-check routes as one Netlify Function', () => {
  assert.equal(typeof pathwayPortal, 'function');
  assert.deepEqual(config.path, ['/proxy/api/assignments', '/healthz']);
});
