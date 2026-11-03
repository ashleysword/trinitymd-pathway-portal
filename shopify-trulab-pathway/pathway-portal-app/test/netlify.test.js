import test from 'node:test';
import assert from 'node:assert/strict';
import pathwayPortal, { config } from '../netlify/functions/pathway-portal.mjs';

test('publishes the clinic, customer, and health-check routes as one Netlify Function', () => {
  assert.equal(typeof pathwayPortal, 'function');
  assert.deepEqual(config.path.slice(0, 3), ['/proxy/api/assignments', '/proxy/api/customer-kits', '/healthz']);
});

test('publishes the clinic portal v3 proxy and staff routes', () => {
  for (const path of ['/proxy/clinic', '/proxy/apply', '/proxy/api/clinic/*', '/staff/api/*']) {
    assert.ok(config.path.includes(path), `${path} should be routed to the function`);
  }
});
