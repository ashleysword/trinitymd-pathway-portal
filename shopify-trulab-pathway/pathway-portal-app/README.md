# TrinityMD PATHWAY Portal API

This lightweight service stores PATHWAY kit assignments in Shopify app-owned metaobjects. The storefront calls it through a signed Shopify app proxy. Every request is tied to the logged-in Shopify customer. Clinic assignment requests separately verify that the customer still has the `clinics` tag, while customer registration requests derive identity only from the authenticated Shopify account.

The package is ready for **Netlify Functions** and can run on Netlify's Free plan for a low-traffic clinic portal. The same code can still run as a conventional Node/Docker service if the hosting platform changes later.

## Stored assignment fields

- PATHWAY kit ID
- Client email address, encrypted before Shopify storage
- Client first initial plus full last name, encrypted before Shopify storage
- Clinic Shopify customer ID
- Assignment status and provider-review status
- Created and updated timestamps supplied by both the record and Shopify

The portal deliberately does not collect date of birth, diagnosis, genetic findings, report content, medications, or treatment information.

## Recommended Netlify setup

Follow `NETLIFY-DEPLOYMENT.md` for the complete click-by-click setup. In summary:

1. Put the contents of this `pathway-portal-app` folder in a private GitHub repository.
2. In Netlify, select **Add new project → Import an existing project**, connect GitHub, and select that repository.
3. Netlify reads `netlify.toml`, runs `npm run check`, publishes `public/`, and deploys `netlify/functions/pathway-portal.mjs` at `/proxy/api/assignments`, `/proxy/api/customer-kits`, and `/healthz`.
4. Add the variables from `.env.example` under **Project configuration → Environment variables**. `PORT` is not needed on Netlify.
5. Use the resulting base URL, such as `https://your-pathway-portal.netlify.app`, as `application_url` in `shopify.app.toml`. Do not append `/proxy` and do not add a trailing slash.
6. Run `shopify app config validate` and `shopify app deploy`, then test `/healthz`, the clinic portal with a tagged clinic, and customer kit registration with a regular customer account.

The function initializes its Shopify client only when invoked. Warm function instances reuse the access token and short clinic-access cache; cold starts securely obtain a fresh Shopify token. Persistent assignment data remains in Shopify rather than Netlify.

## Shopify app setup

1. Create a Shopify app in the Dev Dashboard for the TrinityMD organization and store.
2. Copy `shopify.app.toml.example` to `shopify.app.toml`, fill in the client ID, HTTPS application URL, and matching HTTPS `[auth]` redirect URL, then run `shopify app config validate` and `shopify app deploy`. The template includes the current required `[auth]` and `[webhooks]` sections. Deployment creates the private app-owned metaobject and customer-metafield definitions and requests the needed scopes.
3. Confirm the app proxy forwards storefront path `/apps/pathway-portal` to backend path `/proxy`.
4. Copy `.env.example` into the host's secret manager. Generate `DATA_ENCRYPTION_KEY` with `openssl rand -base64 32`; generate a different high-entropy value for `PORTAL_TOKEN_SECRET`.
5. Deploy through Netlify, or deploy the optional Docker service and run `npm start`. No PostgreSQL database is required.
6. Run `npm test`, open `/healthz`, and test with one approved clinic account and one regular customer account before publishing the connected Shopify theme.

For a Dev Dashboard app, the service exchanges `SHOPIFY_CLIENT_ID` and `SHOPIFY_API_SECRET` for an Admin API token and refreshes it automatically before expiration. Client-credentials authentication requires the app and store to be owned by the same Shopify organization. A legacy `SHOPIFY_ADMIN_ACCESS_TOKEN` is still supported as a fallback; when it is set, `SHOPIFY_CLIENT_ID` can be omitted.

The clinic hub theme setting `Assignment API path` should remain `/apps/pathway-portal/api/assignments` unless the app proxy is customized in Shopify. The customer portal uses `/apps/pathway-portal/api/customer-kits`.

## Security and privacy checklist

- Keep Shopify secrets, Admin API tokens, and encryption keys only in the host's secret manager.
- Limit app scopes to those in `shopify.app.toml.example`, protect the deployment account with MFA, and review Shopify staff permissions.
- Enable service access logs and monitoring without logging request bodies, client identifiers, app-proxy query strings, or decrypted values.
- Document retention, deletion, app-uninstall, and encryption-key rotation procedures. Export required records before uninstalling the app because Shopify doesn't guarantee retention of app-owned metaobjects after uninstall.
- Do not add client names, emails, genetic results, or diagnosis information to Shopify theme code, browser storage, analytics events, URLs, or ordinary email notifications.
- Obtain privacy/compliance review before production use. This code supplies technical controls but does not by itself make the overall workflow compliant.

Each assignment is one `$app:pathway_assignment` metaobject. The owning Shopify customer has one private `$app.pathway_assignments` reference list, capped by Shopify at 1,024 active references. The service verifies ownership again while decoding every record. Kit IDs use deterministic hashed handles to prevent global duplicates, and customer-reference updates use `compareDigest` optimistic concurrency plus rollback to prevent partial batches.

Shopify's app-proxy documentation explains that signed proxy requests include the logged-in customer ID and that request methods and bodies are forwarded. The API validates the SHA-256 HMAC signature, applies a short timestamp window, verifies the clinic tag for clinic-only operations, and uses a customer-bound expiring token for writes. Customer registration responses omit the stored encrypted customer email and name.
