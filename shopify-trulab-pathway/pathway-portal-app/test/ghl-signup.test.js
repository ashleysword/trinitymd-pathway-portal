import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicPortalService } from '../src/clinic-portal.js';
import { MemoryFileStore } from '../src/file-store.js';
import { createGhlSignupHandler, GHL_SECRET_HEADER, GHL_SIGNUP_PATH, normalizeGhlSignup } from '../src/ghl-signup.js';
import { OutboxNotifier } from '../src/notifier.js';
import { MemoryPortalRepository } from '../src/portal-repository.js';
import { configFromEnvironment } from '../src/runtime.js';

const SECRET = 's'.repeat(40);
const SIGNUP = {
  contactId: 'ghlContact01', email: 'Riley@Example.com', firstName: 'Riley', lastName: 'Applicant',
  phone: '(555) 010-0000', company: 'Synthetic Wellness', businessType: 'Wellness clinic', npi: '1234567893',
};

function fakeShopify(existing = []) {
  const customers = existing.map((customer) => ({ ...customer }));
  const calls = [];
  return {
    calls,
    customers,
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (query.includes('GhlFindCustomer')) {
        const email = variables.query.match(/email:"(.*)"/)[1];
        return { customers: { nodes: customers.filter((customer) => customer.email === email) } };
      }
      if (query.includes('GhlCreateCustomer')) {
        const customer = { id: `gid://shopify/Customer/${2000 + customers.length}`, email: variables.input.email, tags: variables.input.tags };
        customers.push(customer);
        return { customerCreate: { customer, userErrors: [] } };
      }
      if (query.includes('GhlTagCustomer')) {
        const customer = customers.find((node) => node.id === variables.id);
        customer.tags = [...new Set([...customer.tags, ...variables.tags])];
        return { tagsAdd: { node: { id: variables.id }, userErrors: [] } };
      }
      throw new Error('unexpected query');
    },
  };
}

function setup({ existing = [], withService = false, config = {} } = {}) {
  const shopify = fakeShopify(existing);
  const repository = new MemoryPortalRepository();
  const service = withService
    ? new ClinicPortalService({
      repository, shopify, encryptionKey: Buffer.alloc(32, 9), notifier: new OutboxNotifier(), fileStore: new MemoryFileStore(),
      config: { clinicTag: 'clinics' },
    })
    : null;
  const accessChanges = [];
  const logs = [];
  const handler = createGhlSignupHandler({
    config: { clinicTag: 'clinics', ghlSignupEnabled: true, ghlWebhookSecret: SECRET, ghlRequireNpi: false, ...config },
    shopify,
    service,
    logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    onClinicAccessChanged: (id) => accessChanges.push(id),
  });
  return { shopify, repository, service, handler, accessChanges, logs };
}

function post(body, secret = SECRET) {
  return new Request(`https://portal.example${GHL_SIGNUP_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { [GHL_SECRET_HEADER]: secret } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('creates a new Shopify customer already tagged clinics', async () => {
  const { handler, shopify, accessChanges } = setup();
  const response = await handler.handle(post(SIGNUP));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, customerId: '2000', created: true, alreadyClinic: false });
  assert.deepEqual(shopify.customers[0].tags, ['clinics']);
  assert.equal(shopify.customers[0].email, 'riley@example.com');
  const create = shopify.calls.find((call) => call.query.includes('GhlCreateCustomer'));
  assert.equal(create.variables.input.phone, '+15550100000');
  assert.deepEqual(accessChanges, ['2000']);
});

test('tags an existing customer without creating a duplicate, and is safe to repeat', async () => {
  const { handler, shopify } = setup({ existing: [{ id: 'gid://shopify/Customer/1002', email: 'riley@example.com', tags: ['newsletter'] }] });
  const first = await (await handler.handle(post(SIGNUP))).json();
  assert.deepEqual(first, { ok: true, customerId: '1002', created: false, alreadyClinic: false });
  assert.deepEqual(shopify.customers[0].tags, ['newsletter', 'clinics']);
  const second = await (await handler.handle(post(SIGNUP))).json();
  assert.equal(second.alreadyClinic, true);
  assert.equal(shopify.customers.length, 1);
  assert.equal(shopify.calls.filter((call) => call.query.includes('GhlTagCustomer')).length, 1);
});

test('rejects requests without the shared secret and does nothing when disabled', async () => {
  const { handler, shopify } = setup();
  assert.equal((await handler.handle(post(SIGNUP, null))).status, 401);
  assert.equal((await handler.handle(post(SIGNUP, 'x'.repeat(40)))).status, 401);
  assert.equal(shopify.calls.length, 0);
  const off = setup({ config: { ghlSignupEnabled: false } });
  assert.equal((await off.handler.handle(post(SIGNUP))).status, 404);
  assert.equal(off.shopify.calls.length, 0);
});

test('validates email and name before touching Shopify', async () => {
  const { handler, shopify } = setup();
  assert.equal((await handler.handle(post({ ...SIGNUP, email: 'not-an-email' }))).status, 422);
  assert.equal((await handler.handle(post({ ...SIGNUP, lastName: '' }))).status, 422);
  assert.equal((await handler.handle(post('{bad json'))).status, 400);
  assert.equal(shopify.calls.length, 0);
});

test('NPI is optional by default: missing or mistyped NPIs still get tagged', async () => {
  const { handler, service, repository } = setup({ withService: true });
  assert.equal((await handler.handle(post({ ...SIGNUP, npi: '' }))).status, 200);
  assert.equal((await handler.handle(post({ ...SIGNUP, contactId: 'ghlContact02', email: 'sam@example.com', npi: '1234567890' }))).status, 200);
  const stored = await repository.list('applications');
  assert.equal(stored.length, 2);
  assert.ok(stored.every((application) => application.practice.npi === ''));
  assert.equal(normalizeGhlSignup({ ...SIGNUP, npi: '1234567890' }).npi, '');
  assert.equal(normalizeGhlSignup(SIGNUP).npi, '1234567893');
  assert.ok(service);
});

test('GHL_REQUIRE_NPI=true rejects missing or invalid NPIs', async () => {
  const { handler, shopify } = setup({ config: { ghlRequireNpi: true } });
  assert.equal((await handler.handle(post({ ...SIGNUP, npi: '1234567890' }))).status, 422);
  assert.equal((await handler.handle(post({ ...SIGNUP, npi: '' }))).status, 422);
  assert.equal(shopify.calls.length, 0);
  assert.equal((await handler.handle(post(SIGNUP))).status, 200);
});

test('accepts GHL default webhook keys', () => {
  const signup = normalizeGhlSignup({
    contact_id: 'abc123', email: 'dana@example.com', first_name: 'Dana', last_name: 'Clinic', company_name: 'Synthetic Clinic',
    customData: { npi: '1234567893' },
  });
  assert.equal(signup.contactId, 'abc123');
  assert.equal(signup.company, 'Synthetic Clinic');
  assert.equal(signup.npi, '1234567893');
});

test('never logs names or emails', async () => {
  const { handler, logs } = setup();
  await handler.handle(post(SIGNUP));
  const text = JSON.stringify(logs);
  assert.equal(text.includes('riley'), false);
  assert.equal(text.includes('Riley'), false);
});

test('records an approved application for the staff console once per contact', async () => {
  const { handler, service, repository } = setup({ withService: true });
  await handler.handle(post(SIGNUP));
  await handler.handle(post(SIGNUP));
  const applications = await repository.list('applications');
  assert.equal(applications.length, 1);
  const [view] = await service.listApplications();
  assert.equal(view.status, 'approved');
  assert.equal(view.tagStatus, 'applied');
  assert.equal(view.practice.company, 'Synthetic Wellness');
  const detail = await service.getApplication({ staffId: '7001' }, view.id);
  assert.equal(detail.practice.taxId, '');
});

test('runtime config requires a long secret when GHL signup is on', () => {
  const base = {
    SHOP_DOMAIN: 'synthetic.myshopify.com', SHOPIFY_API_SECRET: 'secret', SHOPIFY_CLIENT_ID: 'client',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  assert.equal(configFromEnvironment(base).ghlSignupEnabled, false);
  assert.throws(() => configFromEnvironment({ ...base, GHL_SIGNUP_ENABLED: 'true', GHL_WEBHOOK_SECRET: 'short' }), /GHL_WEBHOOK_SECRET/);
  const on = configFromEnvironment({ ...base, GHL_SIGNUP_ENABLED: 'true', GHL_WEBHOOK_SECRET: SECRET });
  assert.equal(on.ghlSignupEnabled, true);
  assert.equal(on.ghlRequireNpi, false);
  assert.equal(configFromEnvironment({ ...base, GHL_REQUIRE_NPI: 'true' }).ghlRequireNpi, true);
});
