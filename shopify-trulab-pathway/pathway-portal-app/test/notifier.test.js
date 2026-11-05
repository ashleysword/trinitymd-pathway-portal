import test from 'node:test';
import assert from 'node:assert/strict';
import { WebhookNotifier } from '../src/notifier.js';
import { configFromEnvironment } from '../src/runtime.js';

function recorder({ status = 200, fail = false } = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail) throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    return { ok: status < 400, status };
  };
  const logger = { info: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) };
  return { calls, logs, fetchImpl, logger };
}

test('staff events go to the webhook with IDs only', async () => {
  const { calls, fetchImpl, logger } = recorder();
  const notifier = new WebhookNotifier({ url: 'https://hooks.example/staff', consoleUrl: 'https://admin.example/apps/portal', fetchImpl, logger });
  await notifier.notify('message.from_clinic', { audience: 'staff', recordId: 'gid://shopify/Metaobject/77', customerId: 1001 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.example/staff');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['at', 'consoleUrl', 'customerId', 'event', 'recordId']);
  assert.equal(calls[0].body.event, 'message.from_clinic');
  assert.equal(calls[0].body.recordId, '77');
  assert.equal(calls[0].body.customerId, '1001');
  assert.equal(calls[0].body.consoleUrl, 'https://admin.example/apps/portal');
});

test('clinic-audience events stay in the log', async () => {
  const { calls, fetchImpl, logger } = recorder();
  const notifier = new WebhookNotifier({ url: 'https://hooks.example/staff', fetchImpl, logger });
  await notifier.notify('message.from_staff', { audience: 'clinic', recordId: 'gid://shopify/Metaobject/5', customerId: '1001' });
  await notifier.notify('kit.status_changed', { audience: 'clinic', recordId: 'gid://shopify/Metaobject/6', customerId: '1001' });
  assert.equal(calls.length, 0);
});

test('a failing or slow webhook never throws into the request', async () => {
  for (const options of [{ status: 500 }, { fail: true }]) {
    const { calls, logs, fetchImpl, logger } = recorder(options);
    const notifier = new WebhookNotifier({ url: 'https://hooks.example/staff', fetchImpl, logger });
    await notifier.notify('kit.registered', { audience: 'staff', recordId: 'gid://shopify/Metaobject/9' });
    assert.equal(calls.length, 1);
    assert.ok(logs.some((line) => line.includes('staff webhook')));
  }
});

test('unknown events are rejected', async () => {
  const { fetchImpl, logger } = recorder();
  const notifier = new WebhookNotifier({ url: 'https://hooks.example/staff', fetchImpl, logger });
  await assert.rejects(notifier.notify('kit.deleted', { audience: 'staff', recordId: '1' }), /Unknown notification event/);
});

test('runtime config: staff alerts are off by default and need https', () => {
  const base = {
    SHOP_DOMAIN: 'synthetic.myshopify.com', SHOPIFY_API_SECRET: 'secret', SHOPIFY_CLIENT_ID: 'client',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  assert.equal(configFromEnvironment(base).staffNotifyWebhookUrl, '');
  assert.throws(() => configFromEnvironment({ ...base, STAFF_NOTIFY_WEBHOOK_URL: 'http://insecure.example' }), /STAFF_NOTIFY_WEBHOOK_URL/);
  assert.equal(configFromEnvironment({ ...base, STAFF_NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' }).staffNotifyWebhookUrl, 'https://hooks.example/x');
});
