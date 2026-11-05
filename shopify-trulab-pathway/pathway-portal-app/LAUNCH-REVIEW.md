# Launch review: clinic portal v3 + GHL sign-up (PR #1)

**Status, Nov 5: all blockers done; plan approved by the owner (Nov 5).** Production steps still run one at a time, each with its own go-ahead. every clinic step passed on the development store (test log in `MASSY-REPLACEMENT.md`). Production is unchanged. PR #1 stays a draft, Massy stays active, and affiliate work stays on hold. **Nothing in §3 runs until the owner approves this completed plan**, and each production step then needs its own go-ahead.

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
| 2 | Staff notifications | **Done (Nov 5):** code, plan, recipient (the owner's email), and a passing preview test (§2.2) |
| 3 | Real kit-label scan on the dev store | **Done (Nov 5):** `TL26600950` scanned and stored as `scan`. See §2.3 |
| — | Wholesale checkout prices | **Moved into launch** as a stop gate before sign-up opens (§3, step 4) |

### 2.1 Live app deploy diff: two deploys (revised Nov 5, nothing deployed)

**Why two deploys:** `/staff` doesn't exist on production until PR #1 is merged, and it returns 404 while `CLINIC_PORTAL_ENABLED` is off. Moving the app URL first would leave the app's admin page broken. So the storage definitions go first; the URL and embedded switch go last, once `/staff` is reachable.

The live config ("TrinityMD PATHWAY Portal", Trinity Cell Sciences org) was re-pulled read-only on Nov 5 into the local, git-ignored `shopify.app.live.toml`; it was unchanged since Nov 4. Both proposed files are git-ignored, built from it, and accepted by Shopify's validator:

| File | Built as | Diff vs live |
|---|---|---|
| `shopify.app.live-step1.toml` (**app deploy 1**) | live + the 7 portal definitions | **0 lines removed, 147 added**, all inside `[metaobjects.app.portal_application]`, `portal_kit`, `portal_kit_event`, `portal_document`, `portal_thread`, `portal_message`, `portal_audit` |
| `shopify.app.live-step2.toml` (**app deploy 2**) | step 1 + 2 lines | vs step 1: `application_url` `https://trinityportal.netlify.app` → `…/staff`; `embedded` `false` → `true`. Nothing else |

**Unchanged in both:** scopes (`read_customers, read_metaobjects, write_app_proxy, write_content, write_customers, write_metaobjects`), so no merchant re-approval; app proxy `/apps/pathway-portal` → `https://trinityportal.netlify.app/proxy`; redirect URLs; the affiliate page metafields. Deploy 1 also leaves `application_url` and `embedded` unchanged.

**Legacy definitions preserved in both** (checked Nov 5; counts live / step 1 / step 2):

| Definition | Present |
|---|---|
| `metaobjects.app.pathway_assignment` (assignments) | 1 / 1 / 1 |
| `metaobjects.app.pathway_customer_kit` (customer kit registry) | 1 / 1 / 1 |
| `customer.metafields.app.pathway_assignments` | 1 / 1 / 1 |
| `customer.metafields.app.pathway_customer_kits` | 1 / 1 / 1 |
| All `pathway_*` tables, fields included | 17 / 17 / 17 |

**Fixed earlier:** the repo template lacked the live `pathway_customer_kit` and `pathway_customer_kits` definitions; a deploy built from it would have deleted them and the customer kit registry. Commit `41a6b51` added them.

**Rule for each app deploy day:** re-pull the live config right before deploying (`shopify app config link --client-id <live id> --file-name live --force`). Rebuild that deploy's file from it, and check the CLI's printed diff matches the table above **before confirming**. Any removal, or any change outside that deploy's row, is a stop. Afterwards, run `shopify app config use dev`.

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
- **Preview test (Nov 5, owner-approved): pass.** GHL workflow "TEST: Portal staff alerts (dev preview)" (Inbound Webhook → internal notification email to the owner) is published. The preview's `STAFF_NOTIFY_WEBHOOK_URL` points at it (secret setting, deploy previews only). A synthetic GHL sign-up on the preview raised `application.approved`, and GHL's log shows the notification executed. The email holds only the event, IDs and the console link.
- **For production:** create a separate "Portal staff alerts" workflow with its own webhook URL and the final recipients, and set it as production `STAFF_NOTIFY_WEBHOOK_URL` in step 3.

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
  - [x] Duplicate the live theme (`189869457653`) and keep it unpublished as the rollback copy. **Done Nov 5:** "BACKUP pre portal launch Nov 5 - do not edit" `#189987127541`, unpublished; the live theme is unchanged.
  - [x] Screenshot both Massy rules and the GHL workflows. **Done Nov 5:** 9 screenshots in the local, uncommitted `launch-backups/` folder (view only; nothing saved in Massy or GHL).
  - [x] Note the current published production deploy in Netlify. **Done Nov 5:** `6ab56842f362fb00081f509a` (`main` @ `3d55f7c`, published Sep 24). Roll back with Netlify → Deploys → that deploy → Publish deploy.
- [ ] Pick a quiet window, with someone watching Netlify, Shopify and GHL for an hour afterwards.

**Step 1: app deploy 1, storage definitions only** (`shopify app deploy --config live-step1`).
- [x] **Done Nov 5: released as `trinitymd-pathway-portal-4`** (previous active: `-3`, Sep 8). Shopify's printed summary marked only `metaobjects (updated)`; scopes, auth, webhooks, app proxy, application_url, embedded, name, page and customer were unchanged; no extensions, nothing removed. A first attempt failed on a network reset before creating a version, and was retried.
- [x] Before confirming: the printed diff shows only the 7 `portal_*` additions. Any removal, or any change to `application_url`, `embedded`, scopes, proxy or redirects, is a stop.
- [x] Check after (Nov 5): the re-pulled live config has the 7 portal definitions and all 17 `pathway_*` tables; `application_url` is still `https://trinityportal.netlify.app`, `embedded = false`; scopes, proxy and webhooks unchanged (only re-formatted). Production `/healthz` 200; legacy `/proxy/api/assignments` and `/proxy/api/customer-kits` answer 401 unsigned, as before; `/staff` 404 (expected). CLI default is back on the dev config. **Still to check by hand:** an existing clinic loads its assignments and kits in the live hub.
- [ ] Rollback: Dev Dashboard → Versions → release the previous version. The new definitions are empty and unused, and removing them loses nothing.

**Step 2: merge PR #1** (portal and GHL flags still off).
- [x] **Done Nov 5:** PR #1 merged as `579d1db` (merge commit). Netlify published production deploy `6aece2a1479b698e865a8875`. Before merging, production had no `CLINIC_PORTAL_ENABLED`, `GHL_SIGNUP_ENABLED`, `GHL_ALLOW_PRODUCTION_STORE` or `STAFF_NOTIFY_WEBHOOK_URL` values.
- [x] Mark ready, merge to `main`. Netlify publishes, and every new feature stays off until its setting is on.
- [x] Check (Nov 5): `/healthz` 200; legacy `/proxy/api/assignments` and `/proxy/api/customer-kits` 401 unsigned (as before); `/webhooks/ghl/clinic-signup` 404 (GET and POST); `/staff`, `/proxy/clinic`, `/proxy/api/clinic/session` 404; the live clinic hub page loads (200). **Still to check by hand:** an existing clinic sees its assignments and kits in the hub.
- [ ] Rollback: Netlify → publish the pre-merge deploy `6ab56842…`, or revert the merge.

**Step 3a: merge PR #2 first** (draft: "Staff console: show the staff ID when not on the allowlist").
- Why: the allowlist checks the per-store staff ID that Shopify puts in the console's sign-in token. It isn't the ID on Settings → Users. On the dev store, the owner is organization account `249350616` on the Users page but staff ID `135607189688` in the console. The live store has one user (the owner), whose live staff ID can only be seen inside the live admin. PR #2 makes the "not authorized" message show that ID; access stays denied.
- [x] **Done Nov 5 (owner-approved):** PR #2 merged as `24abfc8`, production deploy `6aecf882…`. Check: `/healthz` 200, `/staff` 404.

**Step 3: portal settings** (Netlify, **Production context only**; re-check the `dev-server` and `branch-deploy` values afterwards). **Set Nov 5 (owner-approved)** in the Production context only, then production rebuilt (deploy `6aecfb216db6d254fdc5b8b7`, `24abfc8`). `dev-server`, `branch-deploy` and deploy-preview values checked unchanged:

| Setting | Value | Note |
|---|---|---|
| `CLINIC_PORTAL_ENABLED` | `true` | Turns on the portal and staff routes |
| `PORTAL_ASSET_BASE_URL` | `https://trinityportal.netlify.app` | Required; functions don't get `DEPLOY_PRIME_URL` |
| `STOREFRONT_URL` | `https://trinitymd.shop` | "Order kits" links |
| `KIT_ID_PATTERN` | `TL[0-9]{8}` | New portal registrations only; legacy assignments unaffected |
| `STAFF_USER_IDS` | `0` | **Non-empty placeholder that matches nobody**: the console is closed until step 3c sets the owner's real live staff ID |
| `STAFF_NOTIFY_WEBHOOK_URL` | Production alert workflow's webhook URL (secret setting) | Workflow "Portal staff alerts (production) - DRAFT until launch" is a **draft**; a draft doesn't run, so no email is sent until it's published (with approval) |
| `STAFF_CONSOLE_URL` | `https://admin.shopify.com/store/trinity-cell-sciences/apps/trinitymd-pathway-portal-1` | The live app's admin handle, from the store's app list |
| `GHL_SIGNUP_ENABLED` / `GHL_ALLOW_PRODUCTION_STORE` | **Not set** (off) | Sign-up stays off until step 5 |
| `CLINIC_APPROVAL_MODE` / `CLINIC_CUSTOMER_TAGGING_ENABLED` | **Not set** (manual / off) | GHL is the sign-up path |

**Production staff-alert payload (verified Nov 5):** the app's own `WebhookNotifier` sent one synthetic event to the production workflow's webhook. GHL recorded exactly `event`, `recordId`, `customerId`, `consoleUrl`, `at`. There were no names, emails, patient data or message text. The email template uses only those fields and goes to the owner. GHL also stores standard request headers (the sender's IP, which in production is Netlify's server).

**Step 3 test plan** (after a production deploy):
- [x] T1 (Nov 5): pass. `/healthz` 200; legacy `/proxy/api/assignments` and `/proxy/api/customer-kits` still 401 unsigned; `/webhooks/ghl/clinic-signup` still 404.
- [x] T2 (Nov 5): pass. `/staff` 200, served with `frame-ancestors https://admin.shopify.com https://dbdmy2-ue.myshopify.com`. **Staff data stays behind the authenticated API:** `/staff/api/overview`, `applications`, `kits`, `documents`, `threads` and `audit` all return 401 ("Staff sign-in is required.") to unsigned requests and to a forged token. The signed-in 403-with-ID check needs the console inside the admin, so it runs at step 3c after app deploy 2.
- [x] T3 (Nov 5): pass. The store page returns 200; `clinic-portal.css`, `clinic-portal.js` and `code128.js` load from `trinityportal.netlify.app` (200); signed out, the session API returns `signedIn: false` with the store login link. Direct unsigned `/proxy/clinic` and `/proxy/api/clinic/*` return 401.
- [ ] T4: the existing clinic hub still shows assignments and kits for an existing clinic (owner check). **Pending; required before app deploy 2.**
- [ ] T5 (with step 4's staff-controlled test clinic): registering a kit ID that isn't `TL` + 8 digits is rejected. Acceptance is already proven on the dev store with real label `TL26600950`, so no fake `TL` ID is registered in production.
- [ ] Rollback: `CLINIC_PORTAL_ENABLED=false`, deploy.

**Step 3b: app deploy 2, staff console URL** (only after step 3's `/staff` check passes; `shopify app deploy --config live-step2`).
- [ ] Before confirming: the printed diff shows only `application_url` → `…/staff` and `embedded` → `true`. Anything else is a stop.
- [ ] Check after: opening the app in the live Shopify admin shows the staff console (overview loads; Applications, Kits, Documents, Messages tabs work); legacy hub assignments and customer kits still load.
- [ ] Rollback: Dev Dashboard → Versions → release the step 1 version. The admin app returns to the old URL, and the portal definitions stay.

**Step 3c: staff allowlist** (after step 3b).
- [ ] The owner opens the app in the live admin. The console shows "not authorized … add staff ID N". Copy N.
- [ ] Set production `STAFF_USER_IDS=N` (replacing `0`), deploy, and reopen: the console loads. Add other staff the same way.
- [ ] Publish "Portal staff alerts (production)" (with approval). Check: step 4's test clinic sends one message, and the alert email arrives with IDs only.

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
- [ ] Unpublish the two TEST workflows ("TEST: clinic sign-up -> dev store" and "TEST: Portal staff alerts (dev preview)"). They target the preview and cost a premium action per run.
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
| App config | Dev Dashboard → live app → Versions: release the step 1 version (undoes deploy 2) or the pre-launch version (undoes both) | Old app URL / embedded setting; portal definitions stay with the step 1 version |

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
