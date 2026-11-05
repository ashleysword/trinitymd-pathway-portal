# Launch review: clinic portal v3 + GHL sign-up (PR #1)

**Status, Nov 4:** every clinic step passed on the development store (test log in `MASSY-REPLACEMENT.md`). Production is unchanged. PR #1 stays a draft, Massy stays active, and affiliate work stays on hold. **Nothing in §3 runs until the owner approves this completed plan**, and each production step then needs its own go-ahead.

## 1. Massy wholesale pricing: what the live rules do

**Live Massy plan:** $59 every 30 days (Growth), from the live admin's app list.

**The two active rules** (read field by field in the live Massy admin, Nov 4; view only, nothing saved):

| Setting | #49525 | #47297 |
|---|---|---|
| Name / title shown at checkout | Testing Kit PGX Volume Discount | Testing Kit Volume Discount |
| Status / priority | Active / 1 | Active / 0 |
| Markets | All markets, none excluded | All markets, none excluded |
| Customers | Customer tag `clinics` | Customer tag `clinics` |
| Products | Trinity Pathway PGX Genetic Test Kit | TruLab Dx PATHWAY Genetic Test |
| Discount basis | Quantity range | Quantity range |
| Calculation method | Entire order | Entire order |
| Range 1 | 1–9: new price $550 per item | 1–9: new price $450 per item |
| Range 2 | 10+: new price $500 per item | 10+: new price $400 per item |
| Start / end | Aug 21, 2026 4:03 PM / none | none / none |

The custom pricing rule "Wholesale Pricing after 10" (#47279) is a draft and plays no part.

**How "Entire order" counts** (Massy's own "Show use case" text on the rule page): "If the total quantity of all items in the customer's order meets a discount range, the selected products or variants will receive the corresponding discount." Its example: a rule on products A and B, with a cart of 2 A1 + 6 A2 + 4 B1 + **3 C**, counts **15**, product C included. So the quantity tier is set by **every item in the cart, including products outside the rule**. Each kit then gets its own rule's price for that tier.

That makes the mixed carts predictable:

| Cart | Total items | PGX price | TruLab price | Subtotal |
|---|---:|---:|---:|---:|
| 5 PGX + 5 TruLab | 10 | $500 | $400 | **$4,500.00** |
| 9 PGX + 1 TruLab | 10 | $500 | $400 | **$4,900.00** |

A side effect worth knowing: 9 PGX plus any one other product also reaches the 10+ price. This is how the live store prices clinics today; this launch doesn't change it. A future B2B replacement would need to match it, and Shopify B2B counts each variant separately (see `MASSY-REPLACEMENT.md`).

**Why not a dev-store test:** Shopify requires the organization owner to verify their identity before any third-party app can be installed on a development store. This blocked Massy on `trinity-pathway-dev` and on a new `trinity-massy-test` store. The owner chose to check on the live store instead, **before** sign-up opens (§3, step 4), without paying.

## 2. Launch blockers: status

| # | Blocker | Status |
|---|---|---|
| 1 | Live app deploy diff | **Done.** See §2.1 |
| 2 | Staff notifications | **Done (code + plan).** See §2.2. Owner picks recipients |
| 3 | Real kit-label scan on the dev store | **Done (Nov 5):** `TL26600950` scanned and stored as `scan`. See §2.3 |
| — | Wholesale checkout prices | **Moved into launch** as a stop gate before sign-up opens (§3, step 4) |

### 2.1 Live app deploy diff (done Nov 4, nothing deployed)

The live app's config ("TrinityMD PATHWAY Portal", Trinity Cell Sciences org) was pulled read-only into a local, git-ignored `shopify.app.live.toml`. The proposed deploy is `shopify.app.live-proposed.toml`: the live file plus the portal changes. Shopify's validator accepts it.

**Diff, proposed vs live:**
- `application_url`: `https://trinityportal.netlify.app` → `https://trinityportal.netlify.app/staff`
- `embedded`: `false` → `true` (the staff console runs inside Shopify admin; decision 10)
- **Added:** 7 metaobject definitions: `portal_application`, `portal_kit`, `portal_kit_event`, `portal_document`, `portal_thread`, `portal_message`, `portal_audit`
- **Unchanged:** scopes (`read_customers, read_metaobjects, write_app_proxy, write_content, write_customers, write_metaobjects`), so **no merchant re-approval**; app proxy `/apps/pathway-portal` → `https://trinityportal.netlify.app/proxy`; redirect URLs; the affiliate page metafields; and the existing `pathway_assignment` and `pathway_customer_kit` metaobjects and `pathway_assignments` / `pathway_customer_kits` customer metafields.
- **Removed:** nothing.

**Fixed while checking:** the repo's `shopify.app.toml.example` was missing the live `pathway_customer_kit` metaobject and `pathway_customer_kits` customer metafield. A deploy built from the old template would have **deleted** them, along with the existing customer kit registry behind `/proxy/api/customer-kits`. Commit `41a6b51` adds them, and the template now matches the live definitions.

**Rule for launch day:** re-pull the live config right before deploying (`shopify app config link --client-id <live id> --file-name live`). Rebuild the proposed file from it, and confirm the CLI's printed diff shows **only** the items above. Any removal is a stop. Afterwards, run `shopify app config use dev` so the default config is the dev app again.

### 2.2 Staff notification plan (done Nov 4: code in PR, off by default)

**Problem:** the app sends no email, so staff wouldn't know about a new sign-up, kit or clinic message without opening the console.

**Plan:**
- **Who:** the owner picks the staff list (open decision 7).
- **What:** the portal POSTs staff events to `STAFF_NOTIFY_WEBHOOK_URL`, and a GHL workflow with an **Inbound Webhook** trigger sends an internal email (or SMS) to that list. GHL is already in use, and staff get the message in the inbox they already watch.
- **Events sent:**
  - `application.approved` (a new GHL clinic sign-up was tagged)
  - `kit.registered`
  - `message.from_clinic`
  - `application.submitted`, if the portal's own apply form is used
- **Payload:** the event name, numeric record and customer IDs, a link to the staff console (`STAFF_CONSOLE_URL`), and a timestamp. **Never** message text, names, emails or kit IDs.
- **Clinic-facing events** (staff reply, kit status change) stay log-only; clinics see unread badges in the portal.
- **Failures:** a slow or failing webhook is logged and never fails the clinic's action (3-second timeout). Tests cover this (`test/notifier.test.js`).
- **Cost:** GHL Inbound Webhook is a premium trigger, charged per run, like the sign-up webhook.
- **Before launch:** create the GHL "Portal staff alerts" workflow (draft) and point the **preview's** `STAFF_NOTIFY_WEBHOOK_URL` at it. Register a test kit on the dev store and confirm the email arrives. This needs owner approval, because it sends real email to the staff list.

### 2.3 Real kit-label scan (done Nov 5)

Result: the owner scanned a physical kit with "Scan with camera" on their phone. It was stored as `TL26600950` (10 characters), source `scan`. The format is `TL` + 8 digits, so set `KIT_ID_PATTERN=TL[0-9]{8}` in production; the owner confirms the printed label matches. Earlier synthetic `DEVTEST-` kits wouldn't match that pattern; production has none.

Original plan:

The phone test used made-up Code 128 labels. Before launch, scan **one physical kit label** on the dev store's portal (`/apps/pathway-portal/clinic`, "Scan with camera"). Then:
- check the stored Kit ID matches the printed ID, and that it was saved as `scan`;
- record the label's format (decision 5, e.g. `TL` + 8 digits) and decide on `KIT_ID_PATTERN`.

A real kit ID is not patient information, so it's fine on the dev store.

## 3. Production launch checklist (owner approval at every step)

**Before starting**
- [ ] Owner approves this completed plan (all of §2 done).
- [ ] Back up:
  - [ ] Duplicate the live theme (`189869457653`) and keep it unpublished as the rollback copy.
  - [ ] Screenshot both Massy rules and the GHL workflows.
  - [ ] Note the current published production deploy in Netlify.
- [ ] Pick a quiet window, with someone watching Netlify, Shopify and GHL for an hour afterwards.

**Step 1: live app config.** Follow §2.1's launch-day rule, then `shopify app deploy --config live-proposed`.
- [ ] The printed diff shows only the 2 changes and the 7 additions. Any removal is a stop.
- [ ] Check: the legacy clinic hub's kit assignments and customer kits still load. The app opens the staff console in the live admin.

**Step 2: merge PR #1.**
- [ ] Mark ready, merge to `main`. Netlify publishes, and every new feature stays off until its setting is on.
- [ ] Check: `https://trinityportal.netlify.app/healthz` → 200; legacy hub assignments and customer kits work; `/webhooks/ghl/clinic-signup` → 404.

**Step 3: portal settings** (Netlify, **Production context only**; re-check the `dev-server` and `branch-deploy` values afterwards).

| Setting | Value |
|---|---|
| `CLINIC_PORTAL_ENABLED` | `true` |
| `PORTAL_ASSET_BASE_URL` | `https://trinityportal.netlify.app` (required; functions don't get `DEPLOY_PRIME_URL`) |
| `STOREFRONT_URL` | `https://trinitymd.shop` |
| `STAFF_USER_IDS` | Staff user IDs allowed in the console (empty = any staff with app access) |
| `STAFF_NOTIFY_WEBHOOK_URL` / `STAFF_CONSOLE_URL` | The production GHL alert workflow URL / the live admin app link (§2.2) |
| `KIT_ID_PATTERN` | `TL[0-9]{8}` (§2.3) |
| `CLINIC_APPROVAL_MODE` / `CLINIC_CUSTOMER_TAGGING_ENABLED` | Leave `manual` / off (GHL is the sign-up path) |
| `GHL_SIGNUP_ENABLED` | **Leave off** until step 4 passes |

- [ ] Trigger a production deploy. Check `/apps/pathway-portal/clinic` loads for an existing clinic account and the staff console opens.

**Step 4: Massy wholesale price gate** (live store; **before** the GHL workflow is published and **before** registration opens).
- [ ] In the live admin, create (or reuse) a **staff-controlled customer**: a staff-owned email, made-up clinic name, no patient data. Add the tag `clinics` by hand. Don't use the GHL form; it isn't live yet.
- [ ] Sign in as that customer on `trinitymd.shop`. For each cart, go to checkout, read the prices, and **stop before payment**. Clear the cart between cases.

| # | Cart | Expected per kit | Expected subtotal |
|---|---|---:|---:|
| L1 | 1 PGX | $550.00 | $550.00 |
| L2 | 9 PGX | $550.00 | $4,950.00 |
| L3 | 10 PGX | $500.00 | $5,000.00 |
| L4 | 1 TruLab | $450.00 | $450.00 |
| L5 | 9 TruLab | $450.00 | $4,050.00 |
| L6 | 10 TruLab | $400.00 | $4,000.00 |
| L7 | 5 PGX + 5 TruLab | $500.00 PGX / $400.00 TruLab | $4,500.00 |
| L8 | 9 PGX + 1 TruLab | $500.00 PGX / $400.00 TruLab | $4,900.00 |
| L9 | Same customer **after staff remove `clinics`**, 10 PGX | Retail | Retail × 10 |
| L10 | Signed out (guest), 10 PGX | Retail | Retail × 10 |

- [ ] **Launch stop:** any result that differs from this table, L7 and L8 included, stops the launch. Don't publish the GHL workflow, don't open registration, record what was seen, and investigate first. Massy isn't changed by this launch, so a difference means the rules, tag or account behave differently than recorded in §1.
- [ ] Afterwards: the `clinics` tag is removed (L9 does this). Keep or delete the test customer. No order is placed.

**Step 5: open GHL sign-up** (only after step 4 passes).
- [ ] Netlify Production: `GHL_SIGNUP_ENABLED=true`, a **new** random `GHL_WEBHOOK_SECRET` (32+ characters), `GHL_ALLOW_PRODUCTION_STORE=true`. Deploy.
- [ ] GHL production workflow "Clinic sign-up -> tag clinics in Shopify (Massy replacement)":
  - [ ] Change the URL from the preview to `https://trinityportal.netlify.app/webhooks/ghl/clinic-signup` and paste the production secret.
  - [ ] Set the form redirect (`/pages/clinic-application-received` or `/account/login`).
  - [ ] **Publish** it.
- [ ] Unpublish the TEST workflow, which targets the preview and costs a premium action per run.
- [ ] Check: one submission of the real form with a staff-controlled email → GHL log 200 → customer tagged `clinics` → staff alert email received. Then remove the tag.

**Step 6: theme (registration opens).** Work in an unpublished copy first.
- [ ] On `/pages/register`, add the GHL embed (Custom Liquid; code in `MASSY-REPLACEMENT.md`) above, or in place of, the Massy registration block.
- [ ] In `trulab-clinic-hub`, add a link to `/apps/pathway-portal/clinic` ("Open clinic portal"); the hub doesn't link to the portal today.
- [ ] Preview as a clinic and as a guest, then publish.
- [ ] Massy registration form #2694: leave it on until GHL sign-ups are confirmed, then switch it off (a separate decision). **Massy pricing rules stay on.**

**Step 7: watch (first week)**
- [ ] First real GHL sign-ups are tagged and see Massy prices; first clinic orders carry wholesale prices.
- [ ] Staff alerts arrive; Netlify usage (Free plan, 300 credits a month); function errors in Netlify logs; GHL execution logs.

## 4. Rollback (each part is independent; Massy pricing is never touched)

| Part | Roll back by | Effect |
|---|---|---|
| GHL sign-up | Unpublish the workflow; `GHL_SIGNUP_ENABLED=false`, deploy | Webhook 404; tags already added stay |
| Theme | Republish the backup theme | Massy registration and the old hub return |
| Staff alerts | Clear `STAFF_NOTIFY_WEBHOOK_URL`, deploy; or unpublish the GHL alert workflow | Events go back to log-only |
| Portal | `CLINIC_PORTAL_ENABLED=false`, deploy | Portal and staff routes 404; legacy hub unaffected; records stay, unused |
| Code | Netlify → publish the pre-merge production deploy, or revert the merge | Previous code runs |
| App config | Dev Dashboard → live app → Versions → release the previous version | Old app URL / embedded setting; added definitions can stay (unused) |

## 5. Other issues (not blocking)
- **Netlify Free plan cap:** over 300 credits a month pauses production, including the live hub. Check usage; consider a paid plan once clinics use the portal daily.
- **Kit reference can hold a patient name:** the guard can't catch plain names (owner accepted). Mention it in clinic onboarding.
- **Search lag in other lists:** kits, messages and documents are fixed. Other lists (applications after a sign-up, the staff inbox) may lag a few seconds; a refresh fixes it.
- **Open owner decisions:**
  - attachments (3)
  - kit statuses (4)
  - multi-user practices (6)
  - message retention (8)
  - legacy kit migration (9)
  - importing the 7 Massy submissions
- **3 old affiliate test failures** on `main` (affiliate work on hold); not portal-related.
- **B2B pricing replacement** is out of scope for this launch. It now also has to match "Entire order" counting (§1).
- **Unused dev store `trinity-massy-test`** (Go North Industries) can be deleted.

**Checked and fine:** the live store uses new customer accounts, so GHL-created clinics can sign in with an emailed code immediately.
