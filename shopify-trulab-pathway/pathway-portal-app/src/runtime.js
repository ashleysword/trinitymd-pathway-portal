import { createPortalHandler } from './app.js';
import { parseEncryptionKey } from './security.js';
import { ShopifyAdminClient } from './shopify.js';
import { ShopifyAssignmentStore } from './shopify-storage.js';

const requiredEnvironment = [
  'SHOP_DOMAIN',
  'SHOPIFY_API_SECRET',
  'DATA_ENCRYPTION_KEY',
];

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
  const assignmentStore = new ShopifyAssignmentStore({
    client: shopify,
    encryptionKey: config.encryptionKey,
  });
  const handler = createPortalHandler({ config, shopify, assignmentStore });
  return { assignmentStore, config, handler, shopify };
}

let runtime;

export function getPortalRuntime() {
  if (!runtime) runtime = createPortalRuntime();
  return runtime;
}
