import { jsonResponse, readJson } from './app.js';
import { BUSINESS_TYPES, MESSAGE_CATEGORIES } from './clinic-validation.js';
import { PortalRequestError } from './clinic-portal.js';
import { portalPageHeaders, renderPortalPage, renderStaffPage, staffPageHeaders } from './portal-page.js';
import { KIT_TRANSITIONS } from './clinic-portal.js';
import { createPortalToken, verifyPortalToken, verifyShopifyAppProxy } from './security.js';

const DOCUMENT_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;

function forbiddenClinic() {
  return new PortalRequestError('Approved clinic access is required.', 403, 'CLINIC_REQUIRED');
}

function signInRequired() {
  return new PortalRequestError('Sign in to your TrinityMD account to continue.', 401, 'SIGN_IN_REQUIRED');
}

function methodNotAllowed() {
  return jsonResponse(405, { error: 'Method not allowed.' });
}

function fileResponse({ bytes, contentType, filename }, { attachment = false } = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Disposition': `${attachment ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'; sandbox",
      'Content-Type': contentType,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function match(pathname, pattern) {
  const result = pattern.exec(pathname);
  return result ? result.slice(1).map((part) => (part === undefined ? undefined : decodeURIComponent(part))) : null;
}

export function createClinicRoutes({ service, config, loadCustomer, staffAuth, nowSeconds }) {
  async function proxyContext(request, url) {
    const proxy = verifyShopifyAppProxy(url, config.appSecret, {
      expectedShop: config.shop,
      maxAgeSeconds: config.maxProxyAge,
      nowSeconds: nowSeconds(),
      allowAnonymous: true,
    });
    const customer = proxy.customerId ? await loadCustomer(proxy.customerId) : null;
    const clinicCustomer = customer ? { ...customer, id: proxy.customerId } : null;
    return {
      proxy,
      customer: clinicCustomer,
      isClinic: Boolean(clinicCustomer && service.isClinic(clinicCustomer)),
      pathPrefix: /^\/apps\/[a-z0-9-]+$/i.test(url.searchParams.get('path_prefix') || '')
        ? url.searchParams.get('path_prefix')
        : '/apps/pathway-portal',
    };
  }

  async function writePayload(request, context, maxBytes) {
    if (!context.customer) throw signInRequired();
    const payload = await readJson(request, maxBytes);
    verifyPortalToken(payload.csrfToken, config.portalTokenSecret, context.proxy);
    return payload;
  }

  function requireClinic(context) {
    if (!context.customer) throw signInRequired();
    if (!context.isClinic) throw forbiddenClinic();
    return context.customer;
  }

  async function handleProxy(request, url) {
    const path = url.pathname;
    const context = await proxyContext(request, url);

    if (path === '/proxy/clinic' || path === '/proxy/apply') {
      if (request.method !== 'GET') return methodNotAllowed();
      const html = renderPortalPage({
        assetBase: config.assetBaseUrl,
        apiBase: `${context.pathPrefix}/api/clinic`,
        initialView: path === '/proxy/apply' ? 'apply' : 'portal',
        storefrontUrl: config.storefrontUrl,
      });
      return new Response(html, { status: 200, headers: portalPageHeaders(config.assetBaseUrl) });
    }

    if (path === '/proxy/api/clinic/session') {
      if (request.method !== 'GET') return methodNotAllowed();
      if (!context.customer) {
        return jsonResponse(200, { signedIn: false, loginUrl: `${config.storefrontUrl}/account/login?return_url=${encodeURIComponent(`${context.pathPrefix}/clinic`)}` });
      }
      return jsonResponse(200, {
        signedIn: true,
        isClinic: context.isClinic,
        customer: { firstName: context.customer.firstName || '', email: context.customer.email || '' },
        application: await service.getMyApplication(context.customer),
        csrfToken: createPortalToken(context.proxy, config.portalTokenSecret),
        options: {
          businessTypes: BUSINESS_TYPES,
          messageCategories: MESSAGE_CATEGORIES,
          kitIdExample: config.kitIdExample,
          logoutUrl: `${config.storefrontUrl}/account/logout`,
          orderingUrl: `${config.storefrontUrl}/pages/clinic-ordering`,
        },
      });
    }

    if (path === '/proxy/api/clinic/applications') {
      if (request.method !== 'POST') return methodNotAllowed();
      const payload = await writePayload(request, context);
      const result = await service.submitApplication(context.customer, payload);
      return jsonResponse(result.created ? 201 : 200, result);
    }

    if (path === '/proxy/api/clinic/documents') {
      if (request.method !== 'GET') return methodNotAllowed();
      return jsonResponse(200, { documents: await service.listDocuments({ isClinic: context.isClinic }) });
    }
    let params = match(path, /^\/proxy\/api\/clinic\/documents\/([^/]+)\/file$/);
    if (params) {
      if (request.method !== 'GET') return methodNotAllowed();
      const file = await service.openDocument({ isClinic: context.isClinic }, `gid://shopify/Metaobject/${params[0]}`);
      return fileResponse(file, { attachment: url.searchParams.get('download') === '1' });
    }

    if (path === '/proxy/api/clinic/kits') {
      const customer = requireClinic(context);
      if (request.method === 'GET') return jsonResponse(200, { kits: await service.listClinicKits(customer) });
      if (request.method === 'POST') {
        const payload = await writePayload(request, context);
        const result = await service.registerKit(customer, payload);
        return jsonResponse(result.created ? 201 : 200, result);
      }
      return methodNotAllowed();
    }
    params = match(path, /^\/proxy\/api\/clinic\/kits\/([^/]+)\/reference$/);
    if (params) {
      const customer = requireClinic(context);
      if (request.method !== 'POST') return methodNotAllowed();
      return jsonResponse(200, await service.setKitReference(customer, params[0], await writePayload(request, context)));
    }
    params = match(path, /^\/proxy\/api\/clinic\/kits\/([^/]+)$/);
    if (params) {
      const customer = requireClinic(context);
      if (request.method !== 'GET') return methodNotAllowed();
      return jsonResponse(200, await service.getClinicKit(customer, params[0]));
    }

    if (path === '/proxy/api/clinic/threads') {
      const customer = requireClinic(context);
      if (request.method === 'GET') return jsonResponse(200, { threads: await service.listThreads(customer) });
      if (request.method === 'POST') {
        const payload = await writePayload(request, context);
        return jsonResponse(201, { thread: await service.createThread(customer, payload) });
      }
      return methodNotAllowed();
    }
    params = match(path, /^\/proxy\/api\/clinic\/threads\/(\d+)$/);
    if (params) {
      const customer = requireClinic(context);
      if (request.method !== 'GET') return methodNotAllowed();
      return jsonResponse(200, await service.readThread(`gid://shopify/Metaobject/${params[0]}`, 'clinic', customer));
    }
    params = match(path, /^\/proxy\/api\/clinic\/threads\/(\d+)\/messages$/);
    if (params) {
      const customer = requireClinic(context);
      if (request.method !== 'POST') return methodNotAllowed();
      const payload = await writePayload(request, context);
      return jsonResponse(201, { thread: await service.postMessage('clinic', customer.id, `gid://shopify/Metaobject/${params[0]}`, payload, customer) });
    }

    return jsonResponse(404, { error: 'Not found.' });
  }

  async function handleStaff(request, url) {
    if (url.pathname === '/staff') {
      if (request.method !== 'GET') return methodNotAllowed();
      return new Response(renderStaffPage({ clientId: config.clientId, devTokenUrl: config.devStaffTokenUrl || '' }), {
        status: 200,
        headers: staffPageHeaders(config.shop),
      });
    }
    const staff = await staffAuth(request);
    const path = url.pathname;
    const { method } = request;
    const query = url.searchParams;

    if (path === '/staff/api/overview' && method === 'GET') {
      const [applications, kits, threads] = await Promise.all([
        service.listApplications({ status: 'pending' }),
        service.listAllKits(),
        service.listAllThreads({ unreadOnly: true }),
      ]);
      return jsonResponse(200, {
        staffId: staff.staffId,
        pendingApplications: applications.length,
        kits: kits.length,
        unreadThreads: threads.length,
        approvalMode: config.approvalMode,
        customerTaggingEnabled: config.customerTaggingEnabled,
        kitTransitions: KIT_TRANSITIONS,
      });
    }

    if (path === '/staff/api/applications' && method === 'GET') {
      return jsonResponse(200, { applications: await service.listApplications({ status: query.get('status') || undefined }) });
    }
    let params = match(path, /^\/staff\/api\/applications\/(\d+)(?:\/(review|notes))?$/);
    if (params) {
      const id = `gid://shopify/Metaobject/${params[0]}`;
      if (!params[1] && method === 'GET') return jsonResponse(200, { application: await service.getApplication(staff, id) });
      if (params[1] === 'review' && method === 'POST') return jsonResponse(200, { application: await service.reviewApplication(staff, id, await readJson(request)) });
      if (params[1] === 'notes' && method === 'POST') return jsonResponse(200, { application: await service.addApplicationNote(staff, id, await readJson(request)) });
      return methodNotAllowed();
    }

    const kitFilter = { status: query.get('status') || undefined, clinicCustomerId: query.get('clinic') || undefined, query: query.get('q') || undefined };
    if (path === '/staff/api/kits' && method === 'GET') return jsonResponse(200, { kits: await service.listAllKits(kitFilter) });
    if (path === '/staff/api/kits/export.csv' && method === 'GET') {
      return new Response(await service.exportKitsCsv(kitFilter), {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Disposition': 'attachment; filename="clinic-kits.csv"',
          'Content-Type': 'text/csv; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    params = match(path, /^\/staff\/api\/kits\/([^/]+)(?:\/(status|reassign))?$/);
    if (params) {
      if (!params[1] && method === 'GET') return jsonResponse(200, await service.getStaffKit(params[0]));
      if (params[1] === 'status' && method === 'POST') return jsonResponse(200, await service.updateKitStatus(staff, params[0], await readJson(request)));
      if (params[1] === 'reassign' && method === 'POST') return jsonResponse(200, await service.reassignKit(staff, params[0], await readJson(request)));
      return methodNotAllowed();
    }

    if (path === '/staff/api/documents') {
      if (method === 'GET') return jsonResponse(200, { documents: await service.listAllDocuments() });
      if (method === 'POST') {
        const document = await service.createDocument(staff, await readJson(request, DOCUMENT_UPLOAD_MAX_BYTES));
        return jsonResponse(201, { document: service.publicDocument(document) });
      }
      return methodNotAllowed();
    }
    params = match(path, /^\/staff\/api\/documents\/(\d+)(\/file)?$/);
    if (params) {
      const id = `gid://shopify/Metaobject/${params[0]}`;
      if (params[1] && method === 'GET') return fileResponse(await service.openDocument({ staff: true }, id));
      if (!params[1] && method === 'PATCH') {
        const document = await service.updateDocument(staff, id, await readJson(request, DOCUMENT_UPLOAD_MAX_BYTES));
        return jsonResponse(200, { document: { ...service.publicDocument(document), status: document.status } });
      }
      return methodNotAllowed();
    }

    if (path === '/staff/api/threads' && method === 'GET') {
      return jsonResponse(200, { threads: await service.listAllThreads({ unreadOnly: query.get('unread') === '1', status: query.get('status') || undefined }) });
    }
    params = match(path, /^\/staff\/api\/threads\/(\d+)(?:\/(messages|status))?$/);
    if (params) {
      const id = `gid://shopify/Metaobject/${params[0]}`;
      if (!params[1] && method === 'GET') return jsonResponse(200, await service.readThread(id, 'staff'));
      if (params[1] === 'messages' && method === 'POST') return jsonResponse(201, { thread: await service.postMessage('staff', staff.staffId, id, await readJson(request)) });
      if (params[1] === 'status' && method === 'POST') return jsonResponse(200, { thread: await service.setThreadStatus(staff, id, (await readJson(request)).status) });
      return methodNotAllowed();
    }

    if (path === '/staff/api/audit' && method === 'GET') return jsonResponse(200, { entries: await service.listAudit() });

    return jsonResponse(404, { error: 'Not found.' });
  }

  return {
    handles(pathname) {
      return pathname === '/proxy/clinic' || pathname === '/proxy/apply'
        || pathname.startsWith('/proxy/api/clinic/') || pathname === '/staff' || pathname.startsWith('/staff/api/');
    },
    async handle(request, url) {
      return url.pathname.startsWith('/staff') ? handleStaff(request, url) : handleProxy(request, url);
    },
  };
}
