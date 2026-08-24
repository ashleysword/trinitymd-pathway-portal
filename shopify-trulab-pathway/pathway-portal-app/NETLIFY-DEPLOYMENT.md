# Deploy the TrinityMD PATHWAY portal on Netlify

This is the recommended low-cost deployment path. Assignment records remain in Shopify app-owned metaobjects; Netlify runs only the authenticated API function.

## 1. Prepare the private GitHub repository

The easiest setup is a repository whose top level contains the contents of `pathway-portal-app`:

- `netlify.toml`
- `package.json`
- `netlify/`
- `public/`
- `src/`
- `test/`

Do not upload `.env` or `shopify.app.toml` with real credentials. The supplied `.env.example` and `shopify.app.toml.example` are safe templates only.

If the repository contains the entire `shopify-trulab-pathway` package instead, set Netlify's **Base directory** to `shopify-trulab-pathway/pathway-portal-app`.

## 2. Import the repository into Netlify

1. Sign in at `https://app.netlify.com/`.
2. Select **Add new project → Import an existing project**.
3. Select **GitHub**, authorize access if prompted, and select the private portal repository.
4. If the repository contains only the portal app, leave **Base directory** blank. If it contains the complete package, use the base directory noted above.
5. Netlify should detect these values from `netlify.toml`:
   - Build command: `npm run check`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
6. Select **Deploy**. If the new project begins in a private preview state, select **Publish** when the first deployment succeeds.

## 3. Add environment variables

Open **Project configuration → Environment variables** and add:

| Variable | Value |
| --- | --- |
| `SHOP_DOMAIN` | The store's permanent `your-store.myshopify.com` domain, not `trinitymd.shop` |
| `SHOPIFY_API_VERSION` | `2026-07` |
| `SHOPIFY_CLIENT_ID` | Client ID from the Shopify Dev Dashboard app |
| `SHOPIFY_API_SECRET` | Client secret from the same Shopify app |
| `PORTAL_TOKEN_SECRET` | A separate random 32-byte Base64 value |
| `DATA_ENCRYPTION_KEY` | A second, different random 32-byte Base64 value |
| `APP_PROXY_MAX_AGE_SECONDS` | `300` |
| `CLINIC_TAG` | `clinics` |

Do not add `PORT`; Netlify supplies the function runtime. Do not add `SHOPIFY_ADMIN_ACCESS_TOKEN` for a new Dev Dashboard app.

When Netlify offers **Contains secret values**, enable it for:

- `SHOPIFY_API_SECRET`
- `PORTAL_TOKEN_SECRET`
- `DATA_ENCRYPTION_KEY`

Never paste these three values into Shopify theme code, GitHub, email, or chat.

### Generate the two random values on Windows

Open PowerShell and run this command twice. Use the first result for `PORTAL_TOKEN_SECRET` and the second result for `DATA_ENCRYPTION_KEY`:

```powershell
[Convert]::ToBase64String(
  [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
```

After saving the variables, open **Deploys → Trigger deploy → Deploy site** once.

## 4. Copy the Netlify URL

Netlify supplies an HTTPS URL similar to:

```text
https://trinitymd-pathway-portal.netlify.app
```

Open it in a browser. It should display **The secure clinic portal service is online.**

Then open:

```text
https://trinitymd-pathway-portal.netlify.app/healthz
```

After the Shopify credentials and app access are correct, it should return:

```json
{"ok":true}
```

## 5. Connect the Shopify app proxy

In the local `pathway-portal-app` directory:

1. Copy `shopify.app.toml.example` to `shopify.app.toml` if that has not already been done.
2. Set `client_id` to the Shopify app's Client ID. Do not use the Client secret.
3. Set `application_url` to the Netlify base URL only:

```toml
client_id = "YOUR_ACTUAL_CLIENT_ID"
application_url = "https://trinitymd-pathway-portal.netlify.app"
```

Do not append `/proxy`, do not use Markdown brackets, and do not add a trailing slash.

Run from Command Prompt:

```cmd
shopify app config validate
shopify app deploy
```

The included app-proxy configuration maps:

```text
/apps/pathway-portal/api/assignments
```

to:

```text
https://YOUR-NETLIFY-SITE.netlify.app/proxy/api/assignments
```

Opening the backend assignment URL directly should return an invalid-signature message. That is expected because valid requests must come through Shopify's signed storefront app proxy.

## 6. Final test

1. Confirm the Shopify test customer has the exact tag `clinics`.
2. Sign in as that customer.
3. Open `/pages/clinic-portal` on the storefront.
4. Confirm the assignment table loads.
5. Assign one test Kit ID with a test email and a first-initial/last-name value.
6. Refresh the page and confirm the saved assignment remains visible.

If `/healthz` fails, review **Logs → Functions → pathway-portal** in Netlify. Do not post or share log lines containing credentials or client identifiers.
