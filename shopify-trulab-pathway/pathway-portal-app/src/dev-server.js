// Local development server for the clinic portal. Synthetic data only: it never
// contacts Shopify, Netlify, or any email service. It signs requests exactly
// like Shopify's app proxy so the real verification code runs end to end.
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPortalHandler } from './app.js';
import { ClinicPortalService } from './clinic-portal.js';
import { createClinicRoutes } from './clinic-routes.js';
import { MemoryFileStore } from './file-store.js';
import { OutboxNotifier } from './notifier.js';
import { MemoryPortalRepository } from './portal-repository.js';
import { appProxyMessage, encryptField } from './security.js';
import { assignmentHandle, ShopifyAssignmentStore } from './shopify-storage.js';
import { createStaffAuthenticator } from './staff-auth.js';

const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHOP = 'trinity-dev.myshopify.com';
const APP_SECRET = randomBytes(24).toString('hex');
const CLIENT_ID = 'dev-client-id';
const ENCRYPTION_KEY = randomBytes(32);
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));

const PERSONAS = {
  clinic: { id: '1001', firstName: 'Dana', lastName: 'Example', email: 'dana@clinic.example', tags: ['clinics'], label: 'Approved clinic (Dana, Example Wellness)' },
  clinic2: { id: '1003', firstName: 'Sam', lastName: 'Sample', email: 'sam@clinic2.example', tags: ['clinics'], label: 'Second approved clinic (Sam)' },
  applicant: { id: '1002', firstName: 'Riley', lastName: 'Applicant', email: 'riley@newpractice.example', tags: [], label: 'New practice, not yet approved (Riley)' },
  anon: { id: '', label: 'Signed out visitor' },
};

const LEGACY_KIT = 'TL00009999';
const legacyNode = {
  id: 'gid://shopify/Metaobject/500001',
  handle: assignmentHandle(LEGACY_KIT),
  type: '$app:pathway_assignment',
  createdAt: '2026-09-25T15:00:00.000Z',
  updatedAt: '2026-09-25T15:00:00.000Z',
  fields: [
    { key: 'kit_id', value: LEGACY_KIT },
    { key: 'clinic_customer_id', value: '1001' },
    { key: 'client_email_encrypted', value: encryptField('synthetic.client@example.com', ENCRYPTION_KEY) },
    { key: 'client_name_encrypted', value: encryptField('S. Synthetic', ENCRYPTION_KEY) },
    { key: 'status', value: 'processing' },
    { key: 'provider_review_status', value: 'not_started' },
    { key: 'assigned_at', value: '2026-09-25T15:00:00.000Z' },
    { key: 'updated_at', value: '2026-09-25T15:00:00.000Z' },
  ],
};

const customers = new Map(Object.values(PERSONAS).filter((persona) => persona.id).map((persona) => [persona.id, structuredClone(persona)]));

// Answers only the Admin GraphQL operations the portal sends.
const fakeShopify = {
  async graphql(query, variables = {}) {
    const customerId = String(variables.id || variables.customerId || '').split('/').pop();
    const customer = customers.get(customerId);
    if (query.includes('PortalHealth')) return { shop: { id: 'gid://shopify/Shop/1' } };
    if (query.includes('PortalApproveClinic')) {
      customer.tags = [...new Set([...customer.tags, ...variables.tags])];
      return { tagsAdd: { node: { id: variables.id }, userErrors: [] } };
    }
    if (query.includes('PortalAssignmentByHandle')) {
      return { metaobjectByHandle: variables.handle.handle === legacyNode.handle ? legacyNode : null };
    }
    if (query.includes('PortalAssignments')) {
      if (!customer) return { customer: null };
      const refs = customerId === '1001'
        ? { id: 'gid://shopify/Metafield/1', value: JSON.stringify([legacyNode.id]), compareDigest: 'd1', references: { nodes: [legacyNode], pageInfo: { hasNextPage: false } } }
        : null;
      return { customer: { id: `gid://shopify/Customer/${customerId}`, assignmentRefs: refs } };
    }
    if (query.includes('PortalCustomer') || query.includes('PortalReassignTarget')) {
      return { customer: customer ? { id: `gid://shopify/Customer/${customer.id}`, email: customer.email, firstName: customer.firstName, lastName: customer.lastName, tags: customer.tags } : null };
    }
    throw new Error(`Dev server: unhandled GraphQL operation ${query.slice(0, 60)}`);
  },
};

const config = {
  shop: SHOP,
  appSecret: APP_SECRET,
  clientId: CLIENT_ID,
  portalTokenSecret: randomBytes(24).toString('hex'),
  encryptionKey: ENCRYPTION_KEY,
  maxProxyAge: 300,
  clinicTag: 'clinics',
  clinicPortalEnabled: true,
  approvalMode: process.env.CLINIC_APPROVAL_MODE === 'auto' ? 'auto' : 'manual',
  customerTaggingEnabled: true,
  kitIdPattern: /^TL\d{8}$/,
  kitIdExample: 'TL00000000',
  staffUserIds: [],
  assetBaseUrl: ORIGIN,
  storefrontUrl: `${ORIGIN}/dev`,
  devStaffTokenUrl: '/dev/staff-token',
};

const repository = new MemoryPortalRepository();
const notifier = new OutboxNotifier();
const fileStore = new MemoryFileStore();
const customerAccessCache = new Map();
let service;
const legacyStore = new ShopifyAssignmentStore({ client: fakeShopify, encryptionKey: ENCRYPTION_KEY, externalKitLookup: (kitId) => service.isKitRegistered(kitId) });
service = new ClinicPortalService({
  repository, shopify: fakeShopify, legacyStore, encryptionKey: ENCRYPTION_KEY, notifier, fileStore, config,
  onClinicAccessChanged: (customerId) => customerAccessCache.delete(String(customerId)),
});
const handler = createPortalHandler({
  config,
  shopify: fakeShopify,
  assignmentStore: legacyStore,
  customerAccessCache,
  clinicRoutes: (deps) => createClinicRoutes({ ...deps, service, config, staffAuth: createStaffAuthenticator(config) }),
});

async function seed() {
  const staff = { staffId: '7001' };
  for (const [file, title, audience, category, description] of [
    ['PATHWAY-Patient-Overview.pdf', 'Patient Overview', 'public', 'Patient education', 'Introduction to sample collection and the personalized report.'],
    ['PATHWAY-Clinic-Overview.pdf', 'Clinic Overview', 'clinic', 'Clinic education', 'Provider-facing workflow and reporting overview.'],
  ]) {
    const bytes = await readFile(join(ASSETS_DIR, file));
    await service.createDocument(staff, {
      title, audience, category, description, version: '1.0', publishedDate: '2026-08-20', status: 'published',
      file: { filename: file, contentType: 'application/pdf', base64: bytes.toString('base64') },
    });
  }
  await service.registerKit({ id: '1001', tags: ['clinics'] }, { kitId: 'TL00001234', source: 'scan' });
  await service.updateKitStatus(staff, 'TL00001234', { status: 'kit_received', note: 'Received at the lab.' });
}

function signedProxyUrl(pathname, search, customerId) {
  const url = new URL(`${ORIGIN}${pathname}`);
  for (const [key, value] of new URLSearchParams(search)) url.searchParams.append(key, value);
  url.searchParams.set('shop', SHOP);
  url.searchParams.set('logged_in_customer_id', customerId);
  url.searchParams.set('path_prefix', '/apps/pathway-portal');
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('signature', createHmac('sha256', APP_SECRET).update(appProxyMessage(url)).digest('hex'));
  return url;
}

function staffToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: CLIENT_ID, sub: '7001', exp: now + 60, nbf: now - 1, iat: now, jti: randomBytes(8).toString('hex'), sid: 'dev',
  })).toString('base64url');
  const signature = createHmac('sha256', APP_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function persona(request) {
  const match = /(?:^|;\s*)dev_as=([a-z0-9]+)/.exec(request.headers.cookie || '');
  return PERSONAS[match?.[1]] ? match[1] : 'clinic';
}

function devHome(current) {
  const links = Object.entries(PERSONAS).map(([key, value]) => `<li><a href="/dev/as/${key}">${value.label}</a>${key === current ? ' <strong>(current)</strong>' : ''}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clinic portal dev</title><link rel="stylesheet" href="/portal/clinic-portal.css"></head>
<body><main class="shell"><div class="card stack"><p class="eyebrow">Local development · synthetic data</p><h1>Clinic portal preview</h1>
<p>Pick who you are browsing as, then open the storefront pages. Requests are signed like Shopify's app proxy.</p><ul>${links}</ul>
<div class="button-row"><a class="button" href="/apps/pathway-portal/clinic">Clinic portal</a><a class="button button--ghost" href="/apps/pathway-portal/apply">Application page</a><a class="button button--ghost" href="/staff">Staff console</a><a class="button button--ghost" href="/dev/outbox">Notification outbox</a></div>
<p class="muted">Legacy kit ${LEGACY_KIT} belongs to Dana. Seeded portal kit TL00001234 also belongs to Dana.</p></div></main></body></html>`;
}

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.pdf': 'application/pdf' };

async function serveStatic(pathname, response) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (safe.includes('..')) return false;
  try {
    const body = await readFile(join(PUBLIC_DIR, safe));
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(safe)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

async function forward(webRequest, response) {
  const result = await handler(webRequest);
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
}

function webRequest(request, url) {
  const init = { method: request.method, headers: request.headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, ORIGIN);
    if (url.pathname === '/' || url.pathname === '/dev' || url.pathname.startsWith('/dev/account/')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(devHome(persona(request)));
      return;
    }
    const as = /^\/dev\/as\/([a-z0-9]+)$/.exec(url.pathname);
    if (as && PERSONAS[as[1]]) {
      response.writeHead(302, { 'Set-Cookie': `dev_as=${as[1]}; Path=/; SameSite=Lax`, Location: '/dev' });
      response.end();
      return;
    }
    if (url.pathname === '/dev/staff-token') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ token: staffToken() }));
      return;
    }
    if (url.pathname === '/dev/outbox') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(notifier.outbox, null, 2));
      return;
    }
    if (url.pathname.startsWith('/apps/pathway-portal/')) {
      const backendPath = url.pathname.replace('/apps/pathway-portal/', '/proxy/');
      const signed = signedProxyUrl(backendPath, url.search, PERSONAS[persona(request)].id);
      await forward(webRequest(request, signed), response);
      return;
    }
    if (url.pathname === '/staff' || url.pathname.startsWith('/staff/api/')) {
      await forward(webRequest(request, url), response);
      return;
    }
    if (await serveStatic(url.pathname, response)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  } catch (error) {
    console.error('Dev server error', error);
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end('Dev server error');
  }
});

await seed();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Clinic portal dev server (synthetic data) at ${ORIGIN}/dev`);
});
