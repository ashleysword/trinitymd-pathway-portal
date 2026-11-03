# Clinic Portal v3 — audit, decisions, and rollout plan

Branch: `dev/clinic-portal-v3` (local, based on production commit `3d55f7c`). Nothing here has been deployed, pushed, or connected to the live store. All testing used synthetic data.

## 1. Audit of what is live today

**Production baseline.** Netlify `trinityportal` publishes `main` at `3d55f7c` ("Add customer kit registration portal"). The handoff's `02_portal_registration_24SEP2026` folder is byte-identical to that commit's `pathway-portal-app`, so there was only one candidate baseline.

**Request path.** Storefront `https://trinitymd.shop/apps/pathway-portal/*` → Shopify app proxy → Netlify function at `/proxy/*`. The function verifies the proxy HMAC (`signature`, SHA-256 over sorted params), requires `logged_in_customer_id`, checks a 300 s timestamp window, and pins the shop domain. Writes also need a short-lived, customer-bound HMAC token (`csrfToken`) issued by a prior GET. Admin API access uses client-credentials tokens (`SHOPIFY_CLIENT_ID` + secret).

**Endpoints.**
| Route | Who | Behavior |
|---|---|---|
| `/proxy/api/assignments` GET/POST | customers tagged `clinics` (re-checked, 5-min cache) | List / batch-create up to 25 kit assignments with client email + "J. Smith" name |
| `/proxy/api/customer-kits` GET/POST | any signed-in customer | Patient self-registers a kit; stored against their own customer ID |
| `/healthz` | public | Admin API reachability |

**App-owned data.** One `$app:pathway_assignment` metaobject per kit. Handle = SHA-256 of the kit ID, which makes kit IDs globally unique. Fields: `kit_id`, `clinic_customer_id`, AES-256-GCM-encrypted `client_email_encrypted` and `client_name_encrypted`, `status` (`assigned…cancelled`), `provider_review_status`, and timestamps. Each owner has a private `$app.pathway_assignments` list metafield, capped at 1,024 refs and updated with `compareDigest`. **The encrypted contact data stays untouched. v3 does not read it into any new surface and does not add any new client/patient fields.**

**Clinic access.** The theme hub (`trulab-clinic-hub.liquid`) and the API both gate on the `clinics` customer tag. Massy's `Partner Registration Form` (#2694) currently **auto-approves** and applies `clinics`. The two active Massy volume rules key on that tag. Clinic pricing therefore follows the tag. v3 never removes the tag and never changes Massy rules.

**Kit label format.** The deployed code accepts any `[A-Z0-9._-]{4,64}`. The earlier (undeployed) customer portal in `06_…` documents labels as **Code 128 B, "TL" + 8 digits** and includes a decoder for that format. v3 reuses that decoder but keeps the permissive server rule by default. A strict `KIT_ID_PATTERN` stays opt-in until real labels are checked.

**Pre-existing test failures.** At `3d55f7c`, 3 of the 35 tests in `affiliate-theme.test.js` fail. They read `sections/trulab-affiliate-landing.liquid` and `templates/page.pathway-affiliate.json`, which were never committed to this repo; they exist only in handoff folders 04/09. Netlify runs only `npm run check`, so production builds don't notice. I left these tests alone (affiliate work is deferred).

## 2. What v3 adds (all behind `CLINIC_PORTAL_ENABLED`, default **off**)

With the flag off, the function behaves exactly like production. Every new route returns 404, and the legacy assignment store doesn't change. The flag-off behavior is covered by tests.

| Area | Implementation |
|---|---|
| **Application** | `/apps/pathway-portal/apply` (standalone page served through the proxy, so the live theme isn't touched). Requires a signed-in Shopify customer, which ties the application to the right account. Fields: name, business email, phone, practice name, business type, website, NPI (Luhn-checked), "NPI matches contact", Tax ID/EIN (9 digits), optional reseller permit, attestation. EIN and permit are AES-GCM encrypted and shown masked (last 4) in lists. Full values appear only in the staff detail view, and each view is written to the audit log. Duplicates: one pending/approved application per customer; the same `requestId` returns the existing record; matching NPI or EIN (compared by keyed HMAC fingerprint) is flagged to staff. |
| **Staff review** | `/staff` console for Shopify admin (App Bridge session token, HS256 checked against the app secret with `aud`/`iss`/`dest`/`exp`/`nbf`; optional `STAFF_USER_IDS` allow list). Pending/approved/rejected filter, notes, timestamped history, stale-edit protection. Approving adds `clinics` with `tagsAdd` **only** when `CLINIC_CUSTOMER_TAGGING_ENABLED=true`; otherwise the console shows "add tag manually". No revoke/untag path exists. |
| **Kit intake** | Camera scan (`BarcodeDetector` for Code 128/QR/DataMatrix, falling back to the Code 128 decoder; frames never leave the device) plus manual entry. The server normalizes and validates the ID, checks **both** registries (new `portal_kit` handle and legacy `pathway_assignment` handle), and is idempotent for the same clinic. A kit owned by another clinic gets a 409 that doesn't reveal the owner. The legacy assignment path now also refuses kit IDs already registered in v3. |
| **Kit tracking** | Clinic: searchable, filterable list with a per-kit timeline. Earlier-portal kits are listed read-only, without client name/email. Staff: list/filter/search, CSV export (formula-injection-safe), status changes following a transition table (cancel/reopen need a note), reassignment that requires a reason and an approved receiving clinic. Every change creates a timeline event and an audit entry. |
| **Documents** | Staff upload PDF/PNG/JPEG (≤4 MB, PDF magic-byte check) as drafts with version and date, then publish or archive. Audience is `public` or `clinic`, enforced on the server for both list and download. Bytes go to private Netlify Blobs, not Shopify Files (whose CDN URLs are public). |
| **Messaging** | Clinic-scoped threads (topic, optional own kit), staff inbox with unread filter, read markers on both sides, close/reopen, idempotent posts, 20 messages/hour per clinic. Messages that contain SSN patterns, "DOB/date of birth", or diagnosis/genotype words are rejected, and both UIs warn against entering PHI. No attachments. Clinics never see staff user IDs. |
| **Notifications** | Event name + record ID only (no content). Production logs them; **no emails are sent**. The dev server keeps an outbox. |
| **Storage** | 7 app-owned metaobject types (`$app:portal_*`), each with filterable `owner`/`status`/`lookup_key` plus a JSON `payload`. Definitions are in `shopify.app.toml.example`. |

## 3. Decisions the owner needs to make

1. **Approval policy.** Massy auto-approves today. Should v3 keep that (`CLINIC_APPROVAL_MODE=auto`) or require staff review (`manual`, the code default)? Until v3 replaces it, the Massy form stays live and keeps auto-approving.
2. **Retiring Massy registration.** Once v3 is approved, point `/pages/register` at `/apps/pathway-portal/apply` and disable the Massy form. Keep the Massy *pricing* rules either way, because they key on the same `clinics` tag. Also: should the existing 7 Massy submissions be imported for the record?
3. **Attachments.** Massy collects an "Attachment". v3 doesn't, because no need for one was established. If a document is required (for example a reseller certificate), say which one, plus its retention policy.
4. **Kit statuses and owners.** The proposed staff-only flow is `registered → kit_received → processing → report_ready → complete`, with `cancelled` from any pre-report stage. Confirm the real lab stages, and whether lab partners (not just staff) should update them.
5. **Kit label format.** Confirm against physical labels whether every kit is `TL` + 8 digits, and whether the barcode payload is the bare ID. Then set `KIT_ID_PATTERN`.
6. **Multiple users per practice.** v3 keeps today's model: one Shopify customer = one clinic. Multi-user needs a practice entity plus roles; this is deferred.
7. **Notifications.** Pick a channel (Shopify Flow, or a transactional email provider with no PHI) and the staff recipients.
8. **Message retention.** How long to keep threads and audit entries, and who can export them.
9. **Legacy kits.** Should earlier-portal assignments be migrated into `portal_kit` records so staff can update their status? The migration must keep the encrypted client fields in place and should drop them only if you decide to.
10. **Staff console hosting.** It needs the app to be `embedded = true`, with `application_url` pointing at `/staff`. This is an app-config deploy and needs approval.

## 4. Implementation and data-migration plan

1. **Validate the active app config** (Dev Dashboard): client ID, proxy target `…/proxy`, scopes. The v3 needs are `read/write_customers` (for `tagsAdd`) and `read/write_metaobjects`, all already requested. Historical TOMLs are not authoritative.
2. **Dev store first.** Create a development store plus a dev copy of the app. Deploy the v3 metaobject definitions (`shopify app deploy` with the updated TOML), then run `shopify app config validate`. Check that `capabilities.admin_filterable` is accepted and that `fields.owner:"…"` filters work.
3. **Netlify preview.** Push the branch and open a PR. Previews only build for PRs, and branch deploys are limited to `main`. Scope the preview's env vars to the **dev** store and app. Set `CLINIC_PORTAL_ENABLED=true` only in the deploy-preview context. Confirm why `SHOPIFY_API_SECRET` has 4 contexts rather than 5, and settle Node 22 (`netlify.toml`) vs 24.x (dashboard) in the preview log.
4. **Things to verify in the preview, beyond what the local tests cover:** binary PDF pass-through via app proxy; camera scanning on iOS Safari (no `BarcodeDetector`, so it uses the fallback decoder) and Android Chrome; real labels; App Bridge token in the admin iframe; metaobject list latency at realistic volumes.
5. **No data migration is needed to launch.** v3 adds new types and only *reads* legacy records. The optional legacy import (decision 9) would be a one-off staff-run script that copies kit ID/clinic/status into `portal_kit` with a `migrated` event and leaves originals untouched.
6. **Production enablement** (after approval): deploy the app config (new definitions only), set env vars in production, merge to `main`, then flip `CLINIC_PORTAL_ENABLED=true`. Link `/pages/clinic-portal` and `/pages/register` to the new pages in an **unpublished** copy of the live theme (`189869457653`, exported fresh) and publish only after review.

## 5. Preview and rollback

- **Kill switch:** set `CLINIC_PORTAL_ENABLED=false` and redeploy. New routes go away, and legacy routes are untouched throughout.
- **Code rollback:** Netlify "Publish deploy" on `6ab56842f362fb00081f509a` (the current production deploy) restores the exact current function.
- **Data:** v3 never edits or deletes `pathway_assignment` records, Massy settings, discounts, or tags (other than *adding* `clinics` on an approval when tagging is enabled). Its new metaobjects can stay in place, unused, after a rollback.
- **Theme:** only link changes in a duplicated theme. Rollback means republishing the previous theme.
- **Known limitation:** metaobject updates have no compare-and-swap. Two simultaneous edits to the same thread/kit can lose a read marker or counter. Writes that matter are guarded with expected-state checks and idempotent handles.

## 6. Local development and tests

```
npm install
npm test          # 72 tests: 69 pass; the 3 pre-existing affiliate-theme failures are described above
npm run dev       # http://127.0.0.1:8787/dev — synthetic data, simulated signed app proxy, real staff JWT checks
```

The dev server never contacts Shopify, Netlify, or email. Personas: approved clinic, second clinic, unapproved applicant, signed-out visitor.

Checked end to end in a browser against the dev server: application validation, submit, retry, duplicate; staff approve/reject rules, notes, audit; the approved applicant gaining access; kit register, idempotency, format rejection, legacy-kit detection, cross-clinic 409/404, forged-token 401; clinic-only document 403 for signed-out visitors; messaging with PHI rejection, staff reply, unread badge; kit status transitions and CSV export; 375 px layout with no horizontal scroll.
