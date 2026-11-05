import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

function secureHexEqual(left, right) {
  if (!/^[a-f0-9]+$/i.test(left || '') || !/^[a-f0-9]+$/i.test(right || '')) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function appProxyMessage(url) {
  const grouped = new Map();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === 'signature') continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  return [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('');
}

export function verifyShopifyAppProxy(requestUrl, secret, options = {}) {
  if (!secret) throw new Error('Missing Shopify app secret.');
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const provided = url.searchParams.get('signature') || '';
  const calculated = createHmac('sha256', secret).update(appProxyMessage(url)).digest('hex');
  if (!secureHexEqual(provided, calculated)) throw new Error('Invalid Shopify app proxy signature.');

  const shop = (url.searchParams.get('shop') || '').toLowerCase();
  const customerId = url.searchParams.get('logged_in_customer_id') || '';
  const timestamp = Number(url.searchParams.get('timestamp'));
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid shop domain.');
  if (!(options.allowAnonymous && customerId === '') && !/^\d+$/.test(customerId)) {
    throw new Error('A signed-in Shopify customer is required.');
  }
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > maxAgeSeconds) {
    throw new Error('Expired Shopify app proxy request.');
  }
  if (options.expectedShop && shop !== options.expectedShop.toLowerCase()) throw new Error('Unexpected Shopify store.');

  return { shop, customerId, timestamp };
}

function signTokenBody(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function createPortalToken({ shop, customerId, ttlSeconds = 1800 }, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const body = Buffer.from(JSON.stringify({ shop, customerId, exp: nowSeconds + ttlSeconds })).toString('base64url');
  return `${body}.${signTokenBody(body, secret)}`;
}

export function verifyPortalToken(token, secret, expected, nowSeconds = Math.floor(Date.now() / 1000)) {
  const [body, providedSignature, extra] = String(token || '').split('.');
  if (!body || !providedSignature || extra) throw new Error('Invalid portal token.');
  const calculatedSignature = signTokenBody(body, secret);
  const left = Buffer.from(providedSignature);
  const right = Buffer.from(calculatedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Invalid portal token.');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid portal token.');
  }
  if (payload.exp < nowSeconds) throw new Error('Expired portal token.');
  if (payload.shop !== expected.shop || payload.customerId !== expected.customerId) throw new Error('Portal token does not match this clinic.');
  return payload;
}

export function parseEncryptionKey(encodedKey) {
  const key = Buffer.from(String(encodedKey || ''), 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}

export function encryptField(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptField(value, key) {
  const [version, ivText, tagText, encryptedText, extra] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra) throw new Error('Invalid encrypted field.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
