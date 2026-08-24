import {
  createPortalToken,
  verifyPortalToken,
  verifyShopifyAppProxy,
} from './security.js';
import { AssignmentValidationError, normalizeAssignmentBatch } from './validation.js';

const JSON_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

async function readJson(request, maxBytes = 65536) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AssignmentValidationError('Request is too large.');
  }

  if (!request.body) return {};
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new AssignmentValidationError('Request is too large.');
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();

  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new AssignmentValidationError('Request body must be valid JSON.');
  }
}

function requestErrorStatus(error) {
  if (error.statusCode) return error.statusCode;
  if (/signature|portal token|signed-in|expired|shop domain|unexpected Shopify store|app proxy/i.test(error.message)) {
    return 401;
  }
  return 500;
}

export function createPortalHandler(options) {
  const {
    assignmentStore,
    config,
    logger = console,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    shopify,
  } = options;
  const clinicAccessCache = options.clinicAccessCache || new Map();

  if (!assignmentStore?.listAssignments || !assignmentStore?.createAssignments) {
    throw new Error('A PATHWAY assignment store is required.');
  }
  if (!shopify?.graphql) throw new Error('A Shopify Admin client is required.');

  async function requireClinicCustomer(customerId) {
    const cached = clinicAccessCache.get(customerId);
    if (cached && cached.expiresAt > Date.now()) return cached.customer;

    const data = await shopify.graphql(
      `query PortalClinicCustomer($id: ID!) { customer(id: $id) { id email tags } }`,
      { id: `gid://shopify/Customer/${customerId}` },
    );
    const customer = data?.customer;
    const tags = (customer?.tags || []).map((tag) => tag.toLowerCase());
    if (!customer || !tags.includes(config.clinicTag)) {
      const error = new Error('Approved clinic access is required.');
      error.statusCode = 403;
      throw error;
    }
    clinicAccessCache.set(customerId, {
      customer,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return customer;
  }

  async function handleAssignments(request, context) {
    if (request.method === 'GET') {
      const assignments = await assignmentStore.listAssignments(context);
      const csrfToken = createPortalToken(context, config.portalTokenSecret);
      return jsonResponse(200, { assignments, csrfToken });
    }

    if (request.method === 'POST') {
      const payload = await readJson(request);
      verifyPortalToken(payload.csrfToken, config.portalTokenSecret, context);
      const assignments = normalizeAssignmentBatch(payload.assignments);
      const created = await assignmentStore.createAssignments(context, assignments);
      return jsonResponse(201, { assignments: created });
    }

    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  return async function portalHandler(request) {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname === '/healthz') {
        await shopify.graphql('query PortalHealth { shop { id } }');
        return jsonResponse(200, { ok: true });
      }
      if (requestUrl.pathname !== '/proxy/api/assignments') {
        return jsonResponse(404, { error: 'Not found.' });
      }

      const context = verifyShopifyAppProxy(requestUrl, config.appSecret, {
        expectedShop: config.shop,
        maxAgeSeconds: config.maxProxyAge,
        nowSeconds: nowSeconds(),
      });
      await requireClinicCustomer(context.customerId);
      return await handleAssignments(request, context);
    } catch (error) {
      if (error instanceof AssignmentValidationError) {
        return jsonResponse(422, { error: error.message, field: error.field });
      }
      const status = requestErrorStatus(error);
      if (status >= 500) logger.error('PATHWAY portal request failed.', error);
      return jsonResponse(status, {
        error: status >= 500 ? 'The secure portal could not complete that request.' : error.message,
      });
    }
  };
}
