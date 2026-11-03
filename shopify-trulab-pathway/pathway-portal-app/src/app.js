import {
  createPortalToken,
  verifyPortalToken,
  verifyShopifyAppProxy,
} from './security.js';
import {
  AssignmentValidationError,
  normalizeAssignment,
  normalizeAssignmentBatch,
} from './validation.js';

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

export async function readJson(request, maxBytes = 65536) {
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
  const customerAccessCache = options.customerAccessCache || options.clinicAccessCache || new Map();

  if (!assignmentStore?.listAssignments || !assignmentStore?.createAssignments) {
    throw new Error('A PATHWAY assignment store is required.');
  }
  if (!shopify?.graphql) throw new Error('A Shopify Admin client is required.');

  async function requireCustomer(customerId) {
    const cached = customerAccessCache.get(customerId);
    if (cached && cached.expiresAt > Date.now()) return cached.customer;

    const data = await shopify.graphql(
      `query PortalCustomer($id: ID!) { customer(id: $id) { id email firstName lastName tags } }`,
      { id: `gid://shopify/Customer/${customerId}` },
    );
    const customer = data?.customer;
    if (!customer) {
      const error = new Error('The signed-in Shopify customer could not be found.');
      error.statusCode = 404;
      throw error;
    }
    customerAccessCache.set(customerId, {
      customer,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return customer;
  }

  async function requireClinicCustomer(customerId) {
    const customer = await requireCustomer(customerId);
    const tags = (customer.tags || []).map((tag) => tag.toLowerCase());
    if (!tags.includes(config.clinicTag)) {
      const error = new Error('Approved clinic access is required.');
      error.statusCode = 403;
      throw error;
    }
    return customer;
  }

  function customerAssignment(customer, kitId) {
    const firstName = String(customer?.firstName || '').trim();
    const lastName = String(customer?.lastName || '').trim() || 'Customer';
    const firstInitial = firstName ? firstName.slice(0, 1) : 'C';
    return normalizeAssignment({
      kitId,
      clientEmail: customer?.email,
      clientName: `${firstInitial}. ${lastName}`,
    });
  }

  function publicCustomerKit(assignment) {
    return {
      id: assignment.id,
      kitId: assignment.kitId,
      status: assignment.status,
      providerReviewStatus: assignment.providerReviewStatus,
      registeredAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
    };
  }

  const clinicRoutes = options.clinicRoutes
    ? options.clinicRoutes({ loadCustomer: requireCustomer, nowSeconds })
    : null;

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

  async function handleCustomerKits(request, context, customer) {
    if (request.method === 'GET') {
      const assignments = await assignmentStore.listAssignments(context);
      const csrfToken = createPortalToken(context, config.portalTokenSecret);
      return jsonResponse(200, {
        kits: assignments.map(publicCustomerKit),
        csrfToken,
      });
    }

    if (request.method === 'POST') {
      const payload = await readJson(request);
      verifyPortalToken(payload.csrfToken, config.portalTokenSecret, context);
      const assignment = customerAssignment(customer, payload.kitId);
      const [created] = await assignmentStore.createAssignments(context, [assignment]);
      return jsonResponse(201, { kit: publicCustomerKit(created) });
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
      if (clinicRoutes?.handles(requestUrl.pathname)) {
        return await clinicRoutes.handle(request, requestUrl);
      }
      if (options.ghlSignup?.handles(requestUrl.pathname)) {
        return await options.ghlSignup.handle(request);
      }
      const isClinicAssignments = requestUrl.pathname === '/proxy/api/assignments';
      const isCustomerKits = requestUrl.pathname === '/proxy/api/customer-kits';
      if (!isClinicAssignments && !isCustomerKits) {
        return jsonResponse(404, { error: 'Not found.' });
      }

      const context = verifyShopifyAppProxy(requestUrl, config.appSecret, {
        expectedShop: config.shop,
        maxAgeSeconds: config.maxProxyAge,
        nowSeconds: nowSeconds(),
      });
      if (isClinicAssignments) {
        await requireClinicCustomer(context.customerId);
        return await handleAssignments(request, context);
      }
      const customer = await requireCustomer(context.customerId);
      return await handleCustomerKits(request, context, customer);
    } catch (error) {
      if (error instanceof AssignmentValidationError) {
        return jsonResponse(422, { error: error.message, field: error.field });
      }
      const status = requestErrorStatus(error);
      if (status >= 500) logger.error('PATHWAY portal request failed.', error);
      return jsonResponse(status, {
        error: status >= 500 ? 'The secure portal could not complete that request.' : error.message,
        ...(status < 500 && error.code ? { code: error.code } : {}),
      });
    }
  };
}
