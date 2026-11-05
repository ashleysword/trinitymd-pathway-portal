import { createHmac, timingSafeEqual } from 'node:crypto';

export class StaffAuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = 'StaffAuthError';
    this.statusCode = statusCode;
  }
}

function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new StaffAuthError('Invalid staff session token.');
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Verifies a Shopify admin session token (App Bridge `shopify.idToken()`):
// HS256 with the app client secret, exp/nbf, aud = client ID, iss/dest same shop.
export function verifySessionToken(token, options) {
  const { clientId, clientSecret, expectedShop, nowSeconds = Math.floor(Date.now() / 1000), leewaySeconds = 5 } = options;
  if (!clientId || !clientSecret) throw new StaffAuthError('Staff sign-in is not configured.', 503);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new StaffAuthError('Invalid staff session token.');
  const [headerText, payloadText, signatureText] = parts;
  const header = decodeSegment(headerText);
  if (header.alg !== 'HS256') throw new StaffAuthError('Invalid staff session token.');

  const expected = createHmac('sha256', clientSecret).update(`${headerText}.${payloadText}`).digest();
  const provided = Buffer.from(signatureText, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new StaffAuthError('Invalid staff session token.');
  }

  const payload = decodeSegment(payloadText);
  if (!Number.isFinite(payload.exp) || payload.exp + leewaySeconds < nowSeconds) throw new StaffAuthError('Expired staff session token.');
  if (!Number.isFinite(payload.nbf) || payload.nbf - leewaySeconds > nowSeconds) throw new StaffAuthError('Staff session token is not active yet.');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) throw new StaffAuthError('Staff session token is for a different app.');
  const issHost = hostname(payload.iss);
  const destHost = hostname(payload.dest);
  if (!destHost || issHost !== destHost) throw new StaffAuthError('Invalid staff session token.');
  if (expectedShop && destHost !== expectedShop.toLowerCase()) throw new StaffAuthError('Staff session token is for a different store.');
  if (!/^\d+$/.test(String(payload.sub || ''))) throw new StaffAuthError('A signed-in staff member is required.');

  return { staffId: String(payload.sub), shop: destHost, sessionId: payload.sid || null };
}

export function createStaffAuthenticator(config, { nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  const allowList = new Set(config.staffUserIds || []);
  return async function authenticateStaff(request) {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!match) throw new StaffAuthError('Staff sign-in is required.');
    const staff = verifySessionToken(match[1], {
      clientId: config.clientId,
      clientSecret: config.appSecret,
      expectedShop: config.shop,
      nowSeconds: nowSeconds(),
    });
    if (allowList.size && !allowList.has(staff.staffId)) {
      throw new StaffAuthError('This staff account is not authorized for clinic review.', 403);
    }
    return staff;
  };
}
