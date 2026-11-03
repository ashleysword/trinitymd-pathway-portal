import { createPortalHandler } from './app.js';
import { ClinicPortalService } from './clinic-portal.js';
import { createClinicRoutes } from './clinic-routes.js';
import { NetlifyBlobFileStore } from './file-store.js';
import { LogNotifier } from './notifier.js';
import { ShopifyPortalRepository } from './portal-repository.js';
import { parseEncryptionKey } from './security.js';
import { ShopifyAdminClient } from './shopify.js';
import { ShopifyAssignmentStore } from './shopify-storage.js';
import { createStaffAuthenticator } from './staff-auth.js';

const requiredEnvironment = [
  'SHOP_DOMAIN',
  'SHOPIFY_API_SECRET',
  'DATA_ENCRYPTION_KEY',
];

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

export function configFromEnvironment(environment = process.env) {
  for (const name of requiredEnvironment) {
    if (!environment[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
  if (!environment.SHOPIFY_CLIENT_ID && !environment.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error('Missing SHOPIFY_CLIENT_ID (or SHOPIFY_ADMIN_ACCESS_TOKEN for a legacy custom app).');
  }

  const maxProxyAge = Number(environment.APP_PROXY_MAX_AGE_SECONDS || 300);
  if (!Number.isFinite(maxProxyAge) || maxProxyAge < 30 || maxProxyAge > 900) {
    throw new Error('APP_PROXY_MAX_AGE_SECONDS must be between 30 and 900.');
  }

  const approvalMode = (environment.CLINIC_APPROVAL_MODE || 'manual').toLowerCase();
  if (!['manual', 'auto'].includes(approvalMode)) throw new Error('CLINIC_APPROVAL_MODE must be manual or auto.');

  let kitIdPattern = null;
  if (environment.KIT_ID_PATTERN) {
    try {
      kitIdPattern = new RegExp(`^(?:${environment.KIT_ID_PATTERN})$`);
    } catch {
      throw new Error('KIT_ID_PATTERN must be a valid regular expression.');
    }
  }

  return {
    port: Number(environment.PORT || 3000),
    shop: environment.SHOP_DOMAIN.toLowerCase(),
    apiVersion: environment.SHOPIFY_API_VERSION || '2026-07',
    appSecret: environment.SHOPIFY_API_SECRET,
    clientId: environment.SHOPIFY_CLIENT_ID || '',
    adminToken: environment.SHOPIFY_ADMIN_ACCESS_TOKEN || '',
    portalTokenSecret: environment.PORTAL_TOKEN_SECRET || environment.SHOPIFY_API_SECRET,
    encryptionKey: parseEncryptionKey(environment.DATA_ENCRYPTION_KEY),
    maxProxyAge,
    clinicTag: (environment.CLINIC_TAG || 'clinics').toLowerCase(),
    // Clinic portal v3. Off unless explicitly enabled, so merging this code
    // changes nothing in production until the owner turns it on.
    clinicPortalEnabled: flag(environment.CLINIC_PORTAL_ENABLED),
    approvalMode,
    customerTaggingEnabled: flag(environment.CLINIC_CUSTOMER_TAGGING_ENABLED),
    kitIdPattern,
    kitIdExample: environment.KIT_ID_EXAMPLE || '',
    staffUserIds: String(environment.STAFF_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
    assetBaseUrl: environment.PORTAL_ASSET_BASE_URL || environment.DEPLOY_PRIME_URL || environment.URL || '',
    storefrontUrl: (environment.STOREFRONT_URL || 'https://trinitymd.shop').replace(/\/$/, ''),
  };
}

export function createPortalRuntime(environment = process.env) {
  const config = configFromEnvironment(environment);
  const shopify = new ShopifyAdminClient({
    shop: config.shop,
    apiVersion: config.apiVersion,
    clientId: config.clientId,
    clientSecret: config.appSecret,
    adminAccessToken: config.adminToken,
  });
  const customerAccessCache = new Map();
  let service = null;
  const assignmentStore = new ShopifyAssignmentStore({
    client: shopify,
    encryptionKey: config.encryptionKey,
    externalKitLookup: config.clinicPortalEnabled ? (kitId) => service.isKitRegistered(kitId) : null,
  });

  let clinicRoutes = null;
  if (config.clinicPortalEnabled) {
    if (!config.assetBaseUrl) throw new Error('PORTAL_ASSET_BASE_URL is required when CLINIC_PORTAL_ENABLED is on.');
    service = new ClinicPortalService({
      repository: new ShopifyPortalRepository({ client: shopify }),
      shopify,
      legacyStore: assignmentStore,
      encryptionKey: config.encryptionKey,
      notifier: new LogNotifier(),
      fileStore: new NetlifyBlobFileStore(),
      config,
      onClinicAccessChanged: (customerId) => customerAccessCache.delete(String(customerId)),
    });
    const staffAuth = createStaffAuthenticator(config);
    clinicRoutes = (deps) => createClinicRoutes({ ...deps, service, config, staffAuth });
  }

  const handler = createPortalHandler({ config, shopify, assignmentStore, customerAccessCache, clinicRoutes });
  return { assignmentStore, config, handler, service, shopify };
}

let runtime;

export function getPortalRuntime() {
  if (!runtime) runtime = createPortalRuntime();
  return runtime;
}
