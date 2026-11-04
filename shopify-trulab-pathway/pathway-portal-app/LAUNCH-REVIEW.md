# Launch review: clinic portal v3 + GHL sign-up (PR #1)

**Status, Nov 4:** every clinic step passed on the development store (see the test log in `MASSY-REPLACEMENT.md`). Nothing has been changed in production. PR #1 stays a draft; Massy stays active; affiliate work stays on hold. Launch needs the blockers in §4 cleared and owner approval at each production step in §2.

## 1. Testing the two Massy rules on the dev store

**Cost: none.** Massy's App Store listing says its Free plan includes "all app features on dev stores" ([listing](https://apps.shopify.com/massy-b2b-wholesale-pricing-discount), read Nov 4). Dev-store checkout uses Shopify's test payment gateway (enabled by the store's test data), so no real money moves. For reference, the paid plans are Essential $29/mo, Growth $59/mo and Plus $129/mo, each with a 14-day trial. The Free plan allows only **one** volume discount rule, so the live store, with two active rules, must already be on a paid plan. Check Massy's billing page in the live admin. The listing doesn't restrict Massy to Shopify Plus; it says it can edit Shopify Functions, and public-app Functions run on Basic.

**Live store Massy plan:** $59 every 30 days (Growth), seen in the live admin's app list, Nov 4.

**Rules to copy from the live store** (read field by field in the live Massy admin on Nov 4; read-only, nothing saved):

| Setting | #49525 | #47297 |
|---|---|---|
| Name / discount title shown at checkout | Testing Kit PGX Volume Discount | Testing Kit Volume Discount |
| Status / priority | Active / 1 | Active / 0 |
| Order tags | none | none |
| Apply to markets / exclude | All markets / none | All markets / none |
| Apply to customers | Customer tags: `clinics` | Customer tags: `clinics` |
| Apply to products | Specific products: Trinity Pathway PGX Genetic Test Kit | Specific products: TruLab Dx PATHWAY Genetic Test |
| Discount settings | Quantity range | Quantity range |
| Calculation method | **Entire order**: "This calculates the total quantity of all items in the customer's order." | Entire order (same) |
| Range 1 | 1 to 9, New price, $550 per item | 1 to 9, New price, $450 per item |
| Range 2 | 10 and up, New price, $500 per item | 10 and up, New price, $400 per item |
| Start / end date | Start Aug 21, 2026 4:03 PM / no end | none / none |

**Finding:** going by Massy's own description of "Entire order", the 10+ price is reached by the **total quantity of all items in the order**, not per product. If that's how it behaves, a clinic buying 5 PGX + 5 TruLab (or 9 PGX plus any one other item) gets the 10+ price. Cases C1 and C2 below confirm it. This matters for any B2B replacement, which counts each variant separately.

**Dev-store test status (Nov 4): blocked.** Shopify requires the owner of the organization that owns a development store to verify their identity before third-party apps can be installed on it ("Identity verification required" on the install screen for `trinity-pathway-dev`). The owner couldn't complete it. A new dev store in Go North Industries (`trinity-massy-test`, Basic, test data) hit the same check, so it applies to every development store this account owns.

**Decision (Nov 4): check prices at launch instead.** One staff-owned test clinic on the live store builds carts **without paying** (launch step 4b below). The setup steps and the full case table below remain the plan if a verified dev store becomes available later.

The custom pricing rule "Wholesale Pricing after 10" (#47279) is a draft, so don't copy it.

**Setup (dev store only, needs your OK to install the app there):**
1. In the `trinity-pathway-dev` admin, install Massy from the App Store and pick **Free** (all features on dev stores).
2. Turn on Massy's app embed in the dev store's theme, if it asks.
3. Recreate both rules exactly as above. Open each live rule and copy every field rather than working from this table, especially the price type (fixed price per kit, not an amount or percent off), "Entire order", priority, and the customer tag.
4. Confirm the two dev products (made-up retail $699 and $599, inventory not tracked) are the rules' products.
5. Make a dev discount code `DEVTEST10` (10% off) for case E1.
6. Shop as your signed-in test clinic (tagged `clinics`). Use a second test customer without the tag for case D1, and a signed-out browser for D2. Pay with Shopify's test card.

**Checkout cases and expected prices** (wholesale prices are the same on the live store; retail prices on the dev store are made up):

| # | Shopper | Cart | Expected price per kit | Expected subtotal |
|---|---|---|---:|---:|
| A1 | Clinic | 1 PGX | $550.00 | $550.00 |
| A2 | Clinic | 9 PGX | $550.00 | $4,950.00 |
| A3 | Clinic | 10 PGX | $500.00 | $5,000.00 |
| A4 | Clinic | 15 PGX | $500.00 | $7,500.00 |
| B1 | Clinic | 1 TruLab | $450.00 | $450.00 |
| B2 | Clinic | 9 TruLab | $450.00 | $4,050.00 |
| B3 | Clinic | 10 TruLab | $400.00 | $4,000.00 |
| C1 | Clinic | 5 PGX + 5 TruLab | **Record which:** per product $550 / $450, or whole cart $500 / $400 | $5,000.00 or $4,500.00 |
| C2 | Clinic | 9 PGX + 1 TruLab | **Record which:** $550 / $450, or $500 / $400 | $5,400.00 or $4,900.00 |
| C3 | Clinic | 10 PGX + 10 TruLab | $500.00 / $400.00 | $9,000.00 |
| D1 | Signed in, **not** tagged | 10 PGX | Retail ($699.00 on dev) | $6,990.00 |
| D2 | Guest (signed out) | 10 PGX | Retail ($699.00 on dev) | $6,990.00 |
| D3 | Clinic | 10 PGX, then change to 9 at checkout | Moves from $500.00 to $550.00 | $4,950.00 |
| D4 | Clinic, after staff remove the `clinics` tag | 10 PGX | Retail | $6,990.00 |
| E1 | Clinic | 10 PGX + code `DEVTEST10` | **Record:** whether the code is refused, replaces the wholesale price, or stacks | — |
| E2 | Clinic | 10 PGX, complete with the test card | Order shows $500.00 per kit and Massy's discount | $5,000.00 + shipping/tax |

C1, C2 and E1 have no single expected answer: they show what Massy's "Entire order" setting and discount combining do today. Write the answers into this file. They decide whether native B2B pricing (which counts each variant separately) can match current behaviour.

## 2. Production launch checklist (owner approval at every step)

**Before starting**
- [ ] Clear every **launch blocker** in §4.
- [ ] Back up: duplicate the live theme (theme `189869457653`) and keep it unpublished as the rollback copy. Screenshot both Massy rules and the GHL workflows. Note the current production deploy in Netlify (Deploys → the published one) so you can roll back to it.
- [ ] Pick a quiet launch window, with someone watching Netlify, Shopify and GHL for an hour afterwards.

**Step 1: live app config (TrinityMD PATHWAY Portal, Trinity Cell Sciences org)**
- [ ] Link the **live** app into a local, uncommitted `shopify.app.toml` (`shopify app config link`, choose the existing live app, never "create new"). Compare it with `shopify.app.toml.example`: scopes, app proxy (`/apps/pathway-portal` → `https://trinityportal.netlify.app/proxy`), and the 8 metaobject definitions.
- [ ] Set `embedded = true` and `application_url = "https://trinityportal.netlify.app/staff"` (decision 10), keeping the proxy and scopes. Run `shopify app deploy` and **read the diff it prints** before confirming. Same scopes means no merchant re-approval; if scopes change, the store owner must approve.
- [ ] Check: the legacy clinic hub's kit assignments still load; the app opens the staff console in the live admin (it shows "manual review · tagging off" until step 3).

**Step 2: merge PR #1**
- [ ] Mark the PR ready, merge to `main`. Netlify publishes it, and every new feature stays off until its setting is on.
- [ ] Check: `https://trinityportal.netlify.app/healthz` → 200; the legacy hub's assignments and customer-kits work; `/webhooks/ghl/clinic-signup` → 404 (still off).

**Step 3: portal settings (Netlify, Production context only)**

Set each value for **Production only**. Lesson from the preview: changing one context of a variable set for "all" contexts can drop another context's value, so re-check `dev-server` and `branch-deploy` afterwards.

| Setting | Value |
|---|---|
| `CLINIC_PORTAL_ENABLED` | `true` |
| `PORTAL_ASSET_BASE_URL` | `https://trinityportal.netlify.app` (required; functions don't get `DEPLOY_PRIME_URL`) |
| `STOREFRONT_URL` | `https://trinitymd.shop` (the default; set it anyway, explicitly) |
| `STAFF_USER_IDS` | Shopify staff user IDs allowed in the console (empty means any staff with app access) |
| `CLINIC_APPROVAL_MODE` / `CLINIC_CUSTOMER_TAGGING_ENABLED` | Only for the portal's own `/apply` form. With GHL as the sign-up path, leave `manual` / off unless you decide otherwise |
| `KIT_ID_PATTERN` | Set after checking real labels (decision 5), or leave unset to accept any ID |

- [ ] Trigger a production deploy so the settings take effect.
- [ ] Check with a staff-owned test clinic account on the live store (tagged `clinics`, made-up details): `/apps/pathway-portal/clinic` loads; register one obviously fake kit ID; send one message; staff reply; then archive or note the test records.

**Step 4: GHL sign-up**
- [ ] Netlify Production: `GHL_SIGNUP_ENABLED=true`, a **new** random `GHL_WEBHOOK_SECRET` (32+ characters), `GHL_ALLOW_PRODUCTION_STORE=true`. Deploy.
- [ ] GHL production workflow "Clinic sign-up -> tag clinics in Shopify (Massy replacement)": change the URL from the preview to `https://trinityportal.netlify.app/webhooks/ghl/clinic-signup`, paste the production secret, set the form redirect (decision pending: `/pages/clinic-application-received` or `/account/login`), then **publish**.
- [ ] Unpublish the TEST workflow (it targets the preview / dev store and costs a premium action per run).
- [ ] Check: one internal submission of the real form with a staff-controlled email and made-up clinic details → GHL log shows 200 → the customer is tagged `clinics` in Shopify. Keep the tag on for step 4b.

**Step 4b: wholesale price check on the live store (owner decision, Nov 4; no purchase)**

The staff test clinic from step 4, signed in on the live storefront, builds each cart and reads the prices at checkout, **stopping before payment**. Each kit's wholesale price must match the live Massy rules exactly. Record the results in §1. Clear the cart between cases.

| # | Cart | Expected price per kit | Expected subtotal |
|---|---|---:|---:|
| L1 | 1 PGX | $550.00 | $550.00 |
| L2 | 9 PGX | $550.00 | $4,950.00 |
| L3 | 10 PGX | $500.00 | $5,000.00 |
| L4 | 1 TruLab | $450.00 | $450.00 |
| L5 | 9 TruLab | $450.00 | $4,050.00 |
| L6 | 10 TruLab | $400.00 | $4,000.00 |
| L7 | 5 PGX + 5 TruLab | **Record:** $500 / $400 if "Entire order" counts the whole cart (as Massy describes it), else $550 / $450 | $4,500.00 or $5,000.00 |
| L8 | 9 PGX + 1 TruLab | **Record:** $500 / $400 or $550 / $450 | $4,900.00 or $5,400.00 |
| L9 | Same test customer **after staff remove the `clinics` tag**, 10 PGX | Retail price | Retail × 10 |
| L10 | Signed out (guest), 10 PGX | Retail price | Retail × 10 |

- [ ] If L1–L6 don't match, or L9/L10 show wholesale prices: **unpublish the GHL workflow and set `GHL_SIGNUP_ENABLED=false`** before any real clinic signs up, and investigate. Massy itself is unchanged by this launch, so a mismatch would mean the tag or account setup is wrong, not the pricing rules.
- [ ] Afterwards: remove the `clinics` tag from the test customer (L9 does this). Keep or delete the test customer, as you prefer. No order is placed.

**Step 5: theme (unpublished copy first)**
- [ ] In a duplicate of the live theme, on `/pages/register`, add the GHL embed (Custom Liquid; code in `MASSY-REPLACEMENT.md`) in place of, or above, the Massy registration app block.
- [ ] In `trulab-clinic-hub`, add a link to `/apps/pathway-portal/clinic` ("Open clinic portal"). The hub doesn't link to the new portal today.
- [ ] Preview the copy as a clinic and as a guest, then publish it.
- [ ] Massy registration form #2694: leave it on until GHL sign-ups are confirmed working, then switch it off (a separate decision). **Massy's pricing rules stay on.**

**Step 6: watch (first week)**
- [ ] First real GHL sign-ups are tagged and see Massy prices; first clinic orders carry wholesale prices.
- [ ] Netlify usage (Free plan, 300 credits a month); function errors in Netlify logs; GHL execution logs.

## 3. Rollback (each part is independent; Massy pricing is never touched)

| Part | Roll back by | Effect |
|---|---|---|
| GHL sign-up | Unpublish the GHL workflow; set `GHL_SIGNUP_ENABLED=false` and deploy | Webhook returns 404. Tags already added stay (remove them by hand if needed) |
| Theme | Republish the previous theme (the untouched backup) | Massy registration and the old hub come back |
| Portal | `CLINIC_PORTAL_ENABLED=false` and deploy | Portal and staff API routes return 404; the legacy hub is unaffected; portal records stay in Shopify, unused |
| Code | Netlify → Deploys → publish the pre-merge production deploy (instant), or revert the merge on `main` | Production runs the previous code |
| App config | Dev Dashboard → the live app → Versions → release the previous version | Restores the old app URL, embedded setting and definitions |

## 4. Remaining issues

**Launch blockers (fix or decide before step 1)**
1. **Live app config hasn't been reviewed.** The real `shopify.app.toml` isn't in the repo, so the diff for step 1 (`embedded`, `application_url`, new metaobject definitions) hasn't been seen. A wrong deploy could break the legacy hub's proxy. Do the link-and-diff review before approving step 1.
2. **Wholesale checkout prices: accepted, checked at launch** (owner decision, Nov 4). A dev-store test isn't possible without Shopify identity verification. The GHL path uses the same `clinics` tag Massy reads, so prices should be unaffected; launch step 4b confirms it before real clinics sign up, and has a stop rule if it fails.
3. **No staff notifications** (decision 7). The app sends no emails: staff only see new sign-ups, kits and clinic messages by opening the console. Pick a channel, or accept manual checking for launch.
4. **Real kit labels not tested** (decision 5). The phone scan used made-up Code 128 labels. Scan one real kit label on the dev store before launch, then decide on `KIT_ID_PATTERN`.

**Should fix soon after launch (not blocking)**
5. **Netlify Free plan cap.** Going over 300 credits a month pauses production, including the live hub. Check usage, and consider a paid plan once clinics use the portal daily.
6. **Kit reference can hold a patient name.** The PHI guard can't catch plain names (owner accepted, Nov 4). Remind clinics in onboarding.
7. **Search lag in other lists.** Kits, messages and documents are fixed. Other lists (applications after a sign-up, the staff inbox) may lag a few seconds after a change; a refresh fixes it.
8. **Open owner decisions:** attachments (3), kit statuses (4), multi-user practices (6), message retention (8), legacy kit migration (9), and whether to import the 7 Massy submissions.
9. **3 failing affiliate tests** existed on `main` before this work (theme files never committed). Affiliate work is on hold; they don't affect the portal.

**Not blocking first launch (Massy keeps pricing)**
10. **B2B pricing replacement.** Waits for the five dev-store checks in `MASSY-REPLACEMENT.md` and §1's answers for C1, C2 and E1.

**Checked and fine:** the live store uses new customer accounts, so GHL-created clinics can sign in with an emailed code straight away.
