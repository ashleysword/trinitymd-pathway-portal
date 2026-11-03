# Replacing Massy: GHL sign-up + built-in wholesale pricing

Massy does two jobs today. This replaces both:

| Massy today | Replacement |
|---|---|
| Partner Registration Form #2694. It auto-approves and adds the `clinics` tag. | A **GoHighLevel form**. A GHL workflow posts each submission to `/webhooks/ghl/clinic-signup`, and the app adds the `clinics` tag right away (owner decision: instant, no staff review). |
| Two active volume rules for customers tagged `clinics` | The **clinic-wholesale-pricing** Shopify discount Function (the store is on Plus). It sets a wholesale unit price by quantity at checkout for logged-in customers tagged `clinics`. |

The tag stays `clinics`, so existing clinics keep their pricing and hub access with no re-tagging.

## Sign-up flow
1. The clinic fills in the GHL form. EIN, permit and attachment can stay in GHL; the app never receives them.
2. The GHL workflow sends the form fields with a shared secret header.
3. The app validates email, name and NPI (check digit; required unless `GHL_REQUIRE_NPI=false`). It then finds the Shopify customer by email, or creates one, and adds `clinics`. It's safe to repeat: a second submission changes nothing.
4. If the clinic portal is on, an approved application with source `ghl` also appears in the staff console.
5. No emails are sent by the app. New customers sign in at `/account/login`. With new customer accounts (email code) this works immediately. With classic accounts, staff must send an account invite from the customer page.

Anyone who completes the form gets wholesale pricing. That matches Massy today. The NPI check is the only automatic guard.

## Setting up the GHL workflow
Automation → Workflows → new workflow:
- **Trigger:** *Form Submitted*, filtered to the clinic sign-up form.
- **Action:** *Custom Webhook* (a premium GHL action).
  - Method `POST`; URL `https://<netlify-site>/webhooks/ghl/clinic-signup`. Use the deploy-preview URL and a dev store first.
  - Headers: `x-trinity-webhook-secret: <GHL_WEBHOOK_SECRET>` and `Content-Type: application/json`.
  - Raw JSON body. Change the custom-field keys to match the form:
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
- **Responses:** `200` means tagged (`created`/`alreadyClinic` tell you which). `401` means wrong secret; `422` means bad form data (shown in the GHL execution log); `5xx` is safe to retry.
- **Form redirect:** send clinics to `/pages/clinic-application-received` (Massy's current redirect) or straight to `/account/login`.

Netlify env vars: `GHL_SIGNUP_ENABLED=true` and `GHL_WEBHOOK_SECRET` (32+ random characters, stored only in Netlify and GHL).

## Setting up the wholesale pricing
Prices live in a JSON metafield on the discount, so changing prices never needs a code deploy. The format is `extensions/clinic-wholesale-pricing/pricing.example.json`. It is pre-filled with **the current Massy prices**; replace them with the new ranges:

```json
{ "name": "PGX kit", "productHandles": ["<product-handle>"],
  "tiers": [ { "minQuantity": 1, "unitPrice": "550.00" }, { "minQuantity": 10, "unitPrice": "500.00" } ] }
```

- Each tier is the price **per kit** from that quantity up. Quantity counts every variant of the product in the cart, like Massy's "Entire order" calculation.
- A line already priced at or below wholesale is left alone. Other products are untouched.
- Only carts in the config's `currencyCode` (USD) get the price. Any config error means full price, never a broken checkout.
- Customers must be logged in at checkout; guests never get wholesale.

Apply it (preview first, then `--apply`):
```
npm run wholesale-discount -- --config pricing.json
npm run wholesale-discount -- --config pricing.json --apply
```
The first `--apply` creates the automatic discount "Clinic wholesale pricing". Later runs only update its prices. It combines with shipping discounts, but not with other product or order discounts.

## Cutover (needs owner approval at each production step)
1. **Dev store:** add the scopes `read_products` and `write_discounts` (already in `shopify.app.toml.example`), then `shopify app deploy`, which also builds the Function. Run the script and test checkout as a tagged customer, an untagged customer, and a guest, at 1, 9 and 10 kits.
2. **Netlify preview:** point the GHL workflow at the preview URL with a dev-store config, and submit a test form.
3. **Production:**
   - Deploy the app config (new scopes, then merchant re-approval, then the Function).
   - Create the discount with `--apply --starts-at <cutover time>`.
   - **At that same time, deactivate the two Massy volume rules (#49525, #47297).** Otherwise clinics see both discounts competing.
4. Point `/pages/register` at the GHL form (theme change in an unpublished copy first) and switch off Massy form #2694.
5. Watch a few real clinic orders, then uninstall Massy. Check that **SP Hide Price & B2B Lock** still shows clinics their prices; it is separate from Massy and is not changed here.

**Rollback:** deactivate the "Clinic wholesale pricing" discount, reactivate the Massy rules, and set `GHL_SIGNUP_ENABLED=false`. Tags added by GHL stay on the customers, which is the same state Massy would have left.
