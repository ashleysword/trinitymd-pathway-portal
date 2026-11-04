# GHL clinic sign-up, with Massy keeping wholesale pricing

**Decision (Nov 4):** the store stays on **Shopify Basic**; it is not moving to Plus. That changes the earlier plan:

- **Massy stays.** It keeps the existing wholesale prices, and it is not deactivated or uninstalled.
- **The custom discount Function is inactive.** Only Plus stores can run custom apps that contain Shopify Functions ([Shopify docs](https://shopify.dev/docs/apps/build/functions)). The code is kept in `inactive/clinic-wholesale-pricing`, outside `extensions/`, so `shopify app deploy` cannot deploy it, and `scripts/wholesale-discount.mjs --apply` refuses to run. Its scopes (`read_products`, `write_discounts`) are removed from `shopify.app.toml.example`.
- **First launch** is the clinic portal plus GHL sign-up. Massy's volume rules key on the `clinics` tag, so a clinic tagged by GHL gets Massy's prices exactly as a Massy sign-up does today.
- **Native B2B pricing** on Basic is assessed below. It is a possible later replacement for Massy's two rules, but **no pricing cutover is made until the plan below is approved.**

| Job | First launch | Later (only if approved) |
|---|---|---|
| Clinic sign-up | GHL form → webhook tags `clinics` | The same webhook also creates a B2B company and contact |
| Wholesale prices | **Massy** volume rules #49525 and #47297 (unchanged) | Shopify B2B catalog with quantity price breaks |
| Massy registration form #2694 | Stays on until the owner approves switching `/pages/register` to GHL | Off |

Current Massy prices (unchanged):

| Product (handle) | 1–9 kits | 10+ kits |
|---|---:|---:|
| `trinity-pathway-pgx-genetic-test-kit` (Massy #49525) | $550 each | $500 each |
| `trulab-dx-pathway-genetic-test` (Massy #47297) | $450 each | $400 each |

## Sign-up flow
1. The clinic fills in the GHL form. EIN, permit and attachment can stay in GHL; the app never receives them.
2. The GHL workflow sends the form fields with a shared secret header.
3. **The app refuses to write to a store that isn't a development store** (403 `PRODUCTION_STORE_BLOCKED`). It asks Shopify for `shop.plan.partnerDevelopment` once, after the secret matches; any error counts as "not a dev store". Only production sets `GHL_ALLOW_PRODUCTION_STORE=true`, and only at cutover with owner approval.
4. The app checks email and name. NPI is optional (owner decision, Nov 3): a missing NPI is fine, and a mistyped one is dropped rather than blocking the sign-up. Set `GHL_REQUIRE_NPI=true` to require a valid NPI.
5. It finds the Shopify customer by email, or creates one, and adds `clinics`. It is safe to repeat: a second submission changes nothing.
6. If the clinic portal is on, an approved application with source `ghl` also appears in the staff console.
7. The app sends no emails. New customers sign in at `/account/login`. With new customer accounts (email code) this works immediately. With classic accounts, staff must send an account invite from the customer page.

Anyone who completes the form gets wholesale pricing, with no automatic check. That matches Massy today. Staff can review sign-ups in GHL (or the staff console) and remove the tag from anyone who should not have it.

## The GHL form
The form already exists in the **Trinity Cell Sciences** sub-account: **"Wholesale Discount"** (`otZ1eSlI0QkvV2rwshs0`, created Oct 19). It has the same fields as the Massy form, including the attachment upload. To embed it on the registration page, paste this into a Custom Liquid / custom HTML block. Do this only in an unpublished theme copy; publishing needs owner approval.

```html
<iframe
  src="https://go.trinitymd.shop/widget/form/otZ1eSlI0QkvV2rwshs0"
  style="width:100%;height:100%;border:none;border-radius:8px"
  id="inline-otZ1eSlI0QkvV2rwshs0"
  data-layout="{'id':'INLINE'}"
  data-trigger-type="alwaysShow"
  data-trigger-value=""
  data-activation-type="alwaysActivated"
  data-activation-value=""
  data-deactivation-type="neverDeactivate"
  data-deactivation-value=""
  data-form-name="Wholesale Discount"
  data-height="1409"
  data-layout-iframe-id="inline-otZ1eSlI0QkvV2rwshs0"
  data-form-id="otZ1eSlI0QkvV2rwshs0"
  data-cookie-consent="true"
  data-cookie-consent-provider="auto"
  title="Wholesale Discount">
</iframe>
<script src="https://go.trinitymd.shop/js/form_embed.js"></script>
```

## The GHL workflow
**Built Nov 4, still a draft (not published):** "Clinic sign-up -> tag clinics in Shopify (Massy replacement)" in the Trinity Cell Sciences sub-account. Its secret header holds the placeholder `PASTE-SECRET-HERE`, so it cannot tag anyone. It points at the PR #1 deploy preview. **Do not paste the real secret or publish it** until the dev-store test below has passed.

The workflow is set up as follows (Automation → Workflows):
- **Trigger:** *Form Submitted*, filtered to the Wholesale Discount form.
- **Action:** *Custom Webhook* (a premium GHL action, charged per run).
  - Method `POST`; URL `https://<netlify-site>/webhooks/ghl/clinic-signup`.
  - Headers: `x-trinity-webhook-secret: <GHL_WEBHOOK_SECRET>` and `Content-Type: application/json`.
  - Raw JSON body:
    ```json
    {
      "contactId": "{{contact.id}}",
      "email": "{{contact.email}}",
      "firstName": "{{contact.first_name}}",
      "lastName": "{{contact.last_name}}",
      "phone": "{{contact.phone}}",
      "company": "{{contact.company_name}}",
      "website": "{{contact.website}}",
      "businessType": "{{contact.business_type}}",
      "npi": "{{contact.npi_number}}"
    }
    ```
- **Responses:** `200` means tagged (`created`/`alreadyClinic` tell you which). `401` means wrong secret; `403` means the store isn't a dev store; `422` means bad form data (shown in the GHL execution log); `5xx` is safe to retry.
- **Form redirect:** send clinics to `/pages/clinic-application-received` (Massy's current redirect) or straight to `/account/login`.

## Testing on a development store (required before the real secret goes into GHL)
**Set up Nov 4:** dev store **trinity-pathway-dev** (its full address is in Netlify as `SHOP_DOMAIN`, which is marked secret, so it is kept out of the repo; Basic plan, new customer accounts, Shopify test data) and the dev app **"Trinity Bio Portal (dev)"**, both in the **Trinity Cell Sciences** organization alongside the live "TrinityMD PATHWAY Portal" app. The dev app is installed on the dev store only. Its config is `shopify.app.dev.toml` (not committed), built from `shopify.app.toml.example` with the preview URLs. The deploy-preview context now uses the dev store, the dev app's ID and secret, and its own encryption key, token secret and webhook secret; production is unchanged. Never create or tag test customers in production.

Before Nov 4 (kept for the record):
- The Netlify `dev` context's `*.myshopify.com` domain is the **live store's own myshopify address**: its storefront redirects to the live domain. So `netlify dev` also talks to the live store.
- `SHOPIFY_CLIENT_ID` is one value for every context, so there is no separate dev copy of the app.
- The `dev` context has no `SHOPIFY_API_SECRET`.
- The deploy preview shares production's `DATA_ENCRYPTION_KEY` and `PORTAL_TOKEN_SECRET`.

1. Create a Shopify development store (Partner Dashboard → Stores → Add store → development store, or the Dev Dashboard). Turn on new customer accounts.
2. Create a separate dev copy of the app in the same Partner org:
   1. Run `shopify app config link`, choose "create new app", and name it e.g. "PATHWAY Portal (dev)". This writes a `shopify.app.dev.toml` based on `shopify.app.toml.example`.
   2. Set `application_url` and the app proxy URL to the PR preview: `https://deploy-preview-1--trinityportal.netlify.app`, proxy subpath `pathway-portal`.
   3. Keep the scopes from the example: `read_customers,write_customers,read_metaobjects,write_metaobjects,write_app_proxy,write_content`.
   4. Run `shopify app deploy --config dev`, which also deploys the metaobject definitions. Install the app on the dev store only.
3. Put the dev store's theme in place: `shopify theme push --store <dev-store>`, so the clinic hub, login and ordering sections exist there.
4. Point the deploy-preview context at the dev store and dev app:
   - `SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_API_SECRET` for the dev app. Enter the secret in the Netlify UI so it never passes through chat.
   - New `DATA_ENCRYPTION_KEY` and `PORTAL_TOKEN_SECRET` for previews.
   - `CLINIC_PORTAL_ENABLED=true`, `STAFF_USER_IDS` for a dev-store staff account, and a **new** `GHL_WEBHOOK_SECRET`.
   - Then set `GHL_SIGNUP_ENABLED=true`. Leave `GHL_ALLOW_PRODUCTION_STORE` unset.
5. Add the two kit products to the dev store with the same handles. Install Massy there with the two volume rules only if you want to test checkout prices.
6. In GHL, make a **test copy of the form** ("Wholesale Discount (TEST)") and a **separate test workflow** triggered only by that test form, using the new secret. This keeps real clinic submissions on the live form from reaching the dev store. Never touch the production workflow. Submit with a synthetic name and a test email you control. Check that the GHL log shows `200` and the dev-store customer has `clinics`.
7. Check: the customer can log in and sees the clinic hub and portal (kit scan and manual entry, documents, messaging), and Massy's 1, 9 and 10 kit prices apply at checkout. Also check that a repeat submission changes nothing, and that a wrong secret returns `401`.

### Dev-store test log
| Date | Step | Result |
|---|---|---|
| Nov 4 | Steps 1–2: dev store and dev app created, app deployed and installed on the dev store only | Done |
| Nov 4 | Step 3: `trulab-*` sections and clinic page templates pushed to the dev store's theme; clinic pages created there | Done |
| Nov 4 | Step 4: preview settings point at the dev store; preview build `/healthz` returns 200 with the dev app's credentials | Done |
| Nov 4 | Step 4: `GHL_SIGNUP_ENABLED=true` for deploy previews only | Done |
| Nov 4 | Webhook called directly (no GHL) with 3 synthetic clinics: wrong secret → 401; new clinic → 200, customer created with `clinics` on the dev store; bad email → 422 | Pass |
| Nov 4 | Immediate repeat submission → 502 `CREATE_FAILED` (customer search lags behind writes). Fixed in `03846cf` (direct email lookup); retested → 200 `alreadyClinic: true` | Fixed |
| Nov 4 | Step 5: the two kit products added in the dev store admin (made-up retail prices, inventory not tracked). Massy not installed on the dev store | Done |
| Nov 4 | Step 6: GHL "Wholesale Discount (TEST - dev store only)" form and a separate "TEST: clinic sign-up -> dev store" workflow (trigger: TEST form only). Owner pasted the preview secret and submitted with their own email | Pass: customer created on the dev store, tagged `clinics` |
| Nov 4 | Staff console (embedded in the dev store admin) lists the 4 sign-ups as approved applications | Pass |
| Nov 4 | Bugs found: application detail said "not found" (Shopify returns app metaobject types as `app--<id>--portal_*`; also affected documents and threads); every NPI/EIN-less sign-up flagged as a duplicate; GHL sends empty fields as the text "null". Fixed in `b6293ea`; detail view and duplicate flags rechecked on the preview | Fixed |
| Nov 4 | Clinic login on the dev store (new customer accounts, email code) and the clinic hub at `/pages/clinic-portal`: locked before login, unlocked after | Pass |
| Nov 4 | Portal at `/apps/pathway-portal/clinic` was blank: its CSS/JS loaded from the production URL. Netlify functions don't get `DEPLOY_PRIME_URL` at runtime, so `assetBaseUrl` fell back to `URL`. Set `PORTAL_ASSET_BASE_URL` for deploy previews; production must also set it explicitly when the portal is turned on | Fixed (setting) |
| Nov 4 | Portal loads ("Welcome, Test."). Manual kit entry: DEVTEST-0001/0002/0003 registered; repeat (lowercase) → "already registered" | Pass |
| Nov 4 | New kit missing from the list right after registering (Shopify search lag). Fixed in `297a8b5`; retested: shows at once | Fixed |
| Nov 4 | "Order kits" linked to the live store. Set `STOREFRONT_URL` for deploy previews | Fixed (setting) |
| Nov 4 | Messaging: PHI guard blocks a DOB message; clinic → staff message, staff reply → clinic with unread badge; staff inbox read marker | Pass |
| Nov 4 | Staff reply missing from the staff thread right after sending (search lag). Fixed in `297a8b5` (thread keeps its newest message) | Fixed |
| Nov 4 | New: per-kit clinic reference (owner request; free text up to 60 characters with the PHI guard), `b0b0721`. Saved, persisted after reload, searchable; DOB text rejected and not stored; audit records the change without the text | Pass |
| — | Camera scan: not testable in an automated browser (no camera); the Code 128 fallback decoder has unit tests. Needs a phone check | Not run |
| — | Documents: staff upload → clinic download (the upload needs a person to pick the file) | Waiting for owner |

## Can native B2B on Basic replace Massy's two rules?
**Probably, for these two products, but not as a drop-in.** Basic can now set wholesale prices with quantity breaks. But B2B prices go to **company locations**, not tagged customers, and breaks count **per variant**, not across the whole order as Massy does. Sources: [B2B features by plan](https://help.shopify.com/en/manual/b2b/getting-started/plan-features), [volume pricing](https://help.shopify.com/en/manual/b2b/catalogs/quantity-pricing), [considerations](https://help.shopify.com/en/manual/b2b/getting-started/considerations) (read Nov 4, 2026).

| Massy behaviour today | Shopify B2B on Basic | Verdict |
|---|---|---|
| $550 / $450 each from 1 kit | Catalog fixed price per product | Yes |
| $500 / $400 each from 10 kits | Quantity price breaks (up to 10 per product) are on all plans | Yes |
| Quantity counted across the whole order | Breaks count **per variant**: each variant must reach 10 | Same only if each kit has one variant. **Check both products' variants.** |
| Applies to any customer tagged `clinics` | Applies only to customers who are **contacts of a company location** in a B2B market that has the catalog | Needs sign-up and migration changes |
| One price list | Up to 3 active catalog assignments to B2B markets; **no direct company catalogs** (Plus only) | One catalog in one "Clinics" B2B market fits |
| Works with classic or new accounts | **Legacy customer accounts can't place B2B orders** | Store must use new customer accounts. **Check the current setting.** |
| Price shown on the clinic ordering page | Basic/Grow lack "contextual storefront" and "contextual checkout" (Advanced+) | Unclear what the theme shows a B2B buyer on Basic. **Must test.** |
| Massy and other discounts | Shopify doesn't say whether Massy's discounts also apply to B2B orders | Must test, so prices aren't discounted twice |

### What would have to change
**Sign-up (webhook).**
- Besides tagging, create a company (practice name), a company location (address from the form, which the form would need to collect), and add the customer as its contact.
- Get the location into the "Clinics" B2B market. How a location joins a market on Basic, and whether the API can do it, is still to be confirmed on a dev store.
- The app needs the `read_companies` and `write_companies` scopes, which means a merchant re-approval.
- Keep adding `clinics`: the theme and portal gate on it.
- The repeat-safe behaviour must cover companies too (find by contact before creating).

**Customer migration.**
- Every existing `clinics` customer needs a company, location and contact. Massy has 7 submissions; the tagged-customer count still needs checking.
- Do it with a dry-run script that lists what it would create, then `--apply` with owner approval. Write no PHI; practice name and business address only.
- New customer accounts must be on first.

**Theme.**
- `trulab-clinic-hub`, `-login`, `-ordering`, `-register`, `trulab-pathway-landing` and `layout/theme.liquid` gate on `customer.tags contains 'clinics'`. They can keep doing so; the tag stays.
- `trulab-clinic-ordering` shows `clinic_variant.price` and has Massy-specific styles (`[class*="massy-"]`). Check it shows the B2B catalog price, or label it "price shown at checkout".
- Check that SP Hide Price & B2B Lock works with B2B buyers.
- All theme work happens in an unpublished copy.

**Checkout tests (on a dev store set up like Basic):**

| Buyer | Cart | Expected |
|---|---|---|
| B2B clinic contact | 1 PGX, 9 PGX, 10 PGX | $550, $550, $500 each |
| B2B clinic contact | 1, 9, 10 TruLab DX Pathway | $450, $450, $400 each |
| B2B clinic contact | 10 kits split across variants (if any) | Record the result: no break expected |
| B2B clinic contact | Mixed PGX + Pathway | Each product priced by its own quantity |
| Tagged `clinics`, no company | 10 PGX | Massy price while Massy is on; retail after cutover |
| Retail customer, and guest | 10 PGX | Retail price |
| B2B clinic contact with Massy still on | 10 PGX | One wholesale price, not B2B **and** Massy |

Development stores may have Plus-level features turned on, so assign the catalog through a B2B market only (never directly to a company). Otherwise the test proves something Basic can't do.

## Migration plan for B2B pricing (proposal, needs approval before any step)
1. **Answer the open checks** on the dev store: variants per kit, customer account type, how locations join a market (and the API for it), what the theme shows a B2B buyer on Basic, and whether Massy's discounts stack on B2B orders.
2. **Build on the dev store:** a "Clinics" B2B market, one catalog with the fixed prices and 10+ breaks above, webhook changes behind a new flag (`GHL_CREATE_B2B_COMPANY`, off by default), and the migration script (dry run first).
3. **Run the checkout tests** above. Stop here if any wholesale price differs from Massy's.
4. **Production, with approval at each step:**
   1. Turn on new customer accounts, if they aren't already.
   2. Create the catalog and B2B market, but don't activate them yet.
   3. Run the migration script dry-run, then `--apply`.
   4. Deploy the webhook change with `GHL_CREATE_B2B_COMPANY=true`.
5. **Cutover window (approval):** activate the B2B market and catalog. At the same time, deactivate (don't delete) Massy rules #49525 and #47297. Place one test order as a staff-controlled clinic account, then watch the first real clinic orders.
6. **After two clean weeks (approval):** only then consider uninstalling Massy.

**Rollback** at any point after step 5:
1. Reactivate Massy rules #49525 and #47297.
2. Deactivate the B2B market or catalog.
3. Set `GHL_CREATE_B2B_COMPANY=false`.

Companies and contacts can stay; they do nothing without an active catalog. Tags are never removed. Before step 5, rollback is just leaving the market inactive.

## First-launch steps (Massy unchanged; owner approval at each production step)
1. Pass the dev-store test above.
2. Merge PR #1. Netlify publishes `main` to production, but the portal and sign-up stay off until their env vars are set.
3. Production env vars: `GHL_SIGNUP_ENABLED=true`, a new `GHL_WEBHOOK_SECRET`, and `GHL_ALLOW_PRODUCTION_STORE=true`.
4. In GHL, set the production URL and the secret on the workflow, then publish it.
5. Embed the GHL form on `/pages/register` in an unpublished theme copy, review, then publish.
6. Switching off Massy form #2694 is a separate decision; the Massy volume rules stay on either way.

**Rollback:** set `GHL_SIGNUP_ENABLED=false` and unpublish the GHL workflow. Tags already added stay, the same as Massy would leave them. Massy pricing is never touched.
