# TruLab Dx PATHWAY Shopify landing page

This package contains the Shopify Online Store 2.0 landing-page section and page template for Trinity Cell Sciences.

Files:

- `sections/trulab-pathway-landing.liquid`
- `sections/trulab-clinic-register.liquid`
- `sections/trulab-clinic-login.liquid`
- `sections/trulab-clinic-ordering.liquid`
- `sections/trulab-clinic-hub.liquid`
- `sections/main-login.liquid`
- `templates/page.trulab-pathway.json`
- `templates/page.register.json`
- `templates/page.clinic-login.json`
- `templates/page.clinic-ordering.json`
- `templates/page.clinic-portal.json`
- `templates/customers/login.json`
- `assets/pathway-logo.png`
- `layout-patch/theme-header-condition.liquid`

The page is configured for the product handle `trulab-dx-pathway-genetic-test`. The clinic registration page includes a Shopify app-block slot for the store's Massy B2B Registration Form, plus a direct-link fallback. The `/pages/clinic-application-received` confirmation page uses the same `page.register` template and displays a dedicated application-received state.

The consumer landing section includes its own Trinity Cell Sciences navigation bar with links to Benefits, The report, How it works, For clinics, and the purchase offer. The dedicated clinic page uses the existing `/pages/register` handle and hosts the Massy Registration Form app block while adding clinic-focused PATHWAY content and matching navigation. In Shopify's theme editor, open this page, add the **Massy Registration Form** app block inside **PATHWAY Clinic Page**, paste the form URL handle, and ensure the Massy app embed is enabled. The confirmation page shares the `register` template, so it also uses the clinic header without the theme's standard header. To remove the theme's normal header from these PATHWAY pages, replace the regular `{% sections 'header-group' %}` line in `layout/theme.liquid` with the contents of `layout-patch/theme-header-condition.liquid`.

The dedicated `/pages/clinic-login` gateway gives clinic partners a branded entry experience while preserving Shopify's new customer-account authentication. Its secure sign-in button returns approved clinics to the protected clinic ordering portal after verification. Regular customer account links remain unchanged.

The protected `/pages/clinic-ordering` portal uses the approved-customer tag `clinics`. Approved clinics see only the PATHWAY kit, account-specific price markup, quantity controls, and ordering actions. Other visitors see login and registration options. Approved clinics are redirected away from the consumer PATHWAY, clinic registration, and clinic login pages to this ordering portal.

The `/pages/clinic-portal` hub also requires the `clinics` customer tag. It shows the signed-in clinic's Shopify order and fulfillment status, accepts batches of up to 25 kit assignments, displays the clinic's saved assignment history, and includes links for patient and clinic education. Each assignment collects the PATHWAY kit ID, client email address, and only the client's first initial plus full last name. The form explicitly excludes full first names, dates of birth, diagnoses, genetic results, medications, and treatment information. The two optimized PDFs are bundled in `assets/`; their URLs can still be overridden in the theme editor. Create a Shopify page with handle `clinic-portal` and assign the `page.clinic-portal` template.

Persistent assignment storage is supplied by the deployable service in `pathway-portal-app/`. It now includes a native Netlify Function, `netlify.toml`, a safe service-status page, Netlify-specific tests, and a complete `NETLIFY-DEPLOYMENT.md` guide. The original Node/Docker adapter remains available. The storefront communicates with either host through the same signed Shopify app proxy. Each kit assignment is stored as a private app-owned Shopify metaobject and referenced only from its clinic customer's private app-owned metafield. The service verifies the logged-in customer still has the `clinics` tag, verifies record ownership on every read, encrypts client email/name fields before Shopify storage, prevents duplicate kit IDs, and safely rolls back failed batches. No PostgreSQL database is required. Until this service is deployed and the app proxy is connected, the assignment form remains disabled and clearly reports that secure records are not connected; it does not fall back to email or browser storage.

For customers tagged `clinics`, storefront account links are rerouted to `/pages/clinic-portal`. The portal no longer links into Shopify's hosted order-history pages. Shopify's hosted customer-account order page itself remains available if a clinic manually opens its direct URL; conditionally removing that native page for only one customer tag requires a customer-account app extension.

Both PATHWAY sections include lightweight IntersectionObserver-based scroll reveals, staggered card entrances, subtle hover and hero effects, smooth in-page navigation, and reduced-motion support.

The consumer **How It Works** and clinic **From Registration to Patient Results** steps remain static and use a teal-to-lime connecting line on desktop for a clear four-step process flow.

The theme section name is `TruLab PATHWAY`, which stays below Shopify's 25-character schema-name limit.
