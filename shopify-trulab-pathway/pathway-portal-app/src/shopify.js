export class ShopifyAdminError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ShopifyAdminError';
    this.statusCode = options.statusCode || 502;
    this.httpStatus = options.httpStatus;
    this.graphqlErrors = options.graphqlErrors;
  }
}

function validShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export class ShopifyAdminClient {
  constructor(options) {
    this.shop = String(options.shop || '').toLowerCase();
    this.apiVersion = options.apiVersion || '2026-07';
    this.clientId = options.clientId || '';
    this.clientSecret = options.clientSecret || '';
    this.adminAccessToken = options.adminAccessToken || '';
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.cachedToken = null;
    this.tokenPromise = null;

    if (!validShopDomain(this.shop)) throw new Error('SHOP_DOMAIN must be a valid myshopify.com domain.');
    if (typeof this.fetch !== 'function') throw new Error('A fetch implementation is required.');
    if (!this.adminAccessToken && (!this.clientId || !this.clientSecret)) {
      throw new Error('Set SHOPIFY_CLIENT_ID or provide SHOPIFY_ADMIN_ACCESS_TOKEN for a legacy custom app.');
    }
  }

  async requestClientCredentialsToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const response = await this.fetch(`https://${this.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.access_token) {
      throw new ShopifyAdminError(`Shopify access-token request failed with HTTP ${response.status}.`, {
        httpStatus: response.status,
      });
    }

    const expiresInSeconds = Math.max(60, Number(payload.expires_in) || 86400);
    const refreshSkewSeconds = Math.min(300, Math.max(30, Math.floor(expiresInSeconds * 0.1)));
    this.cachedToken = {
      value: payload.access_token,
      expiresAt: this.now() + (expiresInSeconds - refreshSkewSeconds) * 1000,
    };
    return this.cachedToken.value;
  }

  async accessToken(forceRefresh = false) {
    if (this.adminAccessToken) return this.adminAccessToken;
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return this.cachedToken.value;
    }
    this.cachedToken = null;
    if (!this.tokenPromise) {
      this.tokenPromise = this.requestClientCredentialsToken()
        .finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  async graphql(query, variables = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt > 0);
      const response = await this.fetch(
        `https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
        },
      );

      if (response.status === 401 && !this.adminAccessToken && attempt === 0) {
        this.cachedToken = null;
        this.tokenPromise = null;
        continue;
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new ShopifyAdminError(`Shopify Admin API request failed with HTTP ${response.status}.`, {
          httpStatus: response.status,
        });
      }
      if (payload?.errors?.length) {
        throw new ShopifyAdminError('Shopify Admin API returned a GraphQL error.', {
          graphqlErrors: payload.errors,
        });
      }
      if (!payload || typeof payload.data !== 'object') {
        throw new ShopifyAdminError('Shopify Admin API returned an invalid response.');
      }
      return payload.data;
    }
    throw new ShopifyAdminError('Shopify Admin API authentication failed.', { httpStatus: 401 });
  }
}
