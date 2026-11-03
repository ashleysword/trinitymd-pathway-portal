function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

// Standalone page served through the app proxy (text/html, so Shopify does not
// wrap it in the live theme). The proxy keeps it on the storefront origin, which
// is what lets the page call /apps/pathway-portal/api/* with the customer session.
export function renderPortalPage({ assetBase, apiBase, initialView, storefrontUrl }) {
  const base = escapeHtml(assetBase.replace(/\/$/, ''));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Clinic Partner Portal | Trinity BioBlueprint</title>
  <link rel="stylesheet" href="${base}/portal/clinic-portal.css">
</head>
<body>
  <div id="portal-root"
    data-api-base="${escapeHtml(apiBase)}"
    data-initial-view="${escapeHtml(initialView)}"
    data-storefront="${escapeHtml(storefrontUrl)}">
    <noscript>The clinic portal needs JavaScript enabled.</noscript>
  </div>
  <script src="${base}/portal/code128.js" defer></script>
  <script src="${base}/portal/clinic-portal.js" defer></script>
</body>
</html>`;
}

// Staff console shell, loaded inside Shopify admin. App Bridge supplies the
// session token that authorizes every /staff/api request.
export function renderStaffPage({ clientId, devTokenUrl = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="shopify-api-key" content="${escapeHtml(clientId)}">
  <title>Clinic Review | TrinityMD</title>
  ${devTokenUrl ? '' : '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>'}
  <link rel="stylesheet" href="/portal/clinic-portal.css">
  <link rel="stylesheet" href="/admin/admin.css">
</head>
<body>
  <div id="staff-root" data-dev-token-url="${escapeHtml(devTokenUrl)}"><noscript>JavaScript is required.</noscript></div>
  <script src="/admin/admin.js" defer></script>
</body>
</html>`;
}

export function staffPageHeaders(shop) {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self' https://cdn.shopify.com",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' https://*.shopify.com",
      "frame-src 'self' blob:",
      "base-uri 'none'",
      `frame-ancestors https://admin.shopify.com https://${shop}`,
    ].join('; '),
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function portalPageHeaders(assetBase) {
  let assetOrigin = "'self'";
  try {
    assetOrigin = new URL(assetBase).origin;
  } catch {
    // Relative asset base: same origin.
  }
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src ${assetOrigin}`,
      `style-src ${assetOrigin}`,
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "frame-src 'self' blob:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Content-Type': 'text/html; charset=utf-8',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}
