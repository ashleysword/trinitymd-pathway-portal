#!/usr/bin/env node
// Creates or updates the "Clinic wholesale pricing" automatic discount that
// runs the clinic-wholesale-pricing Function, and saves the price tiers on it.
//
//   node scripts/wholesale-discount.mjs --config pricing.json            # preview only
//   node scripts/wholesale-discount.mjs --config pricing.json --apply    # write to the store
//
// Reads SHOP_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_API_SECRET from the environment.
// Needs the read_products and write_discounts scopes, and the Function deployed.
//
// INACTIVE: the store is on Shopify Basic, and only Plus stores can run custom
// apps that contain Functions. --apply refuses to run; Massy keeps the pricing.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validatePricingConfig } from '../inactive/clinic-wholesale-pricing/src/pricing.js';
import { ShopifyAdminClient } from '../src/shopify.js';

export const DISCOUNT_TITLE = 'Clinic wholesale pricing';
export const METAFIELD = { namespace: '$app:clinic-wholesale', key: 'pricing-config' };

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

export async function resolveProductHandles(shopify, config) {
  const rules = [];
  for (const rule of config.rules || []) {
    const productIds = [...(rule.productIds || [])];
    for (const handle of rule.productHandles || []) {
      const data = await shopify.graphql(
        `query WholesaleProduct($query: String!) { products(first: 5, query: $query) { nodes { id handle title } } }`,
        { query: `handle:${JSON.stringify(handle)}` },
      );
      const product = (data?.products?.nodes || []).find((node) => node.handle === handle);
      if (!product) throw new Error(`No product with handle "${handle}" (rule "${rule.name || '?'}").`);
      productIds.push(product.id);
    }
    const { productHandles, ...rest } = rule;
    rules.push({ ...rest, productIds });
  }
  return { ...config, rules };
}

export async function findFunctionId(shopify) {
  const data = await shopify.graphql(`query WholesaleFunctions { shopifyFunctions(first: 50) { nodes { id title apiType } } }`);
  const match = (data?.shopifyFunctions?.nodes || []).find((node) => node.title === DISCOUNT_TITLE);
  if (!match) throw new Error('The clinic-wholesale-pricing Function is not deployed to this store yet (run `shopify app deploy`).');
  return match.id;
}

export async function findDiscount(shopify) {
  const data = await shopify.graphql(
    `query WholesaleDiscount($query: String!) { discountNodes(first: 10, query: $query) { nodes { id discount { __typename ... on DiscountAutomaticApp { title status } } } } }`,
    { query: `title:${JSON.stringify(DISCOUNT_TITLE)}` },
  );
  return (data?.discountNodes?.nodes || []).find(
    (node) => node.discount?.__typename === 'DiscountAutomaticApp' && node.discount.title === DISCOUNT_TITLE,
  ) || null;
}

export async function applyWholesaleDiscount(shopify, config, { startsAt = new Date().toISOString() } = {}) {
  const value = JSON.stringify(config);
  const existing = await findDiscount(shopify);
  if (existing) {
    const data = await shopify.graphql(
      `mutation WholesaleSetConfig($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`,
      { metafields: [{ ownerId: existing.id, ...METAFIELD, type: 'json', value }] },
    );
    const errors = data?.metafieldsSet?.userErrors || [];
    if (errors.length) throw new Error(`Shopify rejected the pricing update: ${errors.map((error) => error.message).join('; ')}`);
    return { action: 'updated', discountId: existing.id, status: existing.discount.status };
  }

  const functionId = await findFunctionId(shopify);
  const data = await shopify.graphql(
    `mutation WholesaleCreate($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId status }
        userErrors { field message }
      }
    }`,
    {
      discount: {
        title: DISCOUNT_TITLE,
        functionId,
        startsAt,
        discountClasses: ['PRODUCT'],
        // Massy's rules must be switched off at the same moment; until then the
        // two would compete. Shipping discounts still apply on top.
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
        metafields: [{ ...METAFIELD, type: 'json', value }],
      },
    },
  );
  const errors = data?.discountAutomaticAppCreate?.userErrors || [];
  if (errors.length) throw new Error(`Shopify rejected the discount: ${errors.map((error) => error.message).join('; ')}`);
  const created = data.discountAutomaticAppCreate.automaticAppDiscount;
  return { action: 'created', discountId: created.discountId, status: created.status };
}

async function main(args) {
  if (args.includes('--apply')) {
    throw new Error('Inactive: the store is on Shopify Basic, which cannot run custom-app Functions. See MASSY-REPLACEMENT.md.');
  }
  const path = argument(args, '--config');
  if (!path) throw new Error('Usage: node scripts/wholesale-discount.mjs --config pricing.json [--apply] [--starts-at ISO]');
  const environment = process.env;
  const shopify = new ShopifyAdminClient({
    shop: environment.SHOP_DOMAIN,
    apiVersion: environment.SHOPIFY_API_VERSION || '2026-07',
    clientId: environment.SHOPIFY_CLIENT_ID,
    clientSecret: environment.SHOPIFY_API_SECRET,
    adminAccessToken: environment.SHOPIFY_ADMIN_ACCESS_TOKEN,
  });

  const config = await resolveProductHandles(shopify, JSON.parse(readFileSync(path, 'utf8')));
  const errors = validatePricingConfig(config);
  if (errors.length) throw new Error(`Pricing config is invalid:\n- ${errors.join('\n- ')}`);

  console.log(`Store: ${shopify.shop}`);
  for (const rule of config.rules) {
    const tiers = rule.tiers.map((tier) => `${tier.minQuantity}+ @ ${tier.unitPrice}`).join(', ');
    console.log(`- ${rule.name || rule.productIds.join(', ')}: ${tiers} ${config.currencyCode}`);
  }
  if (!args.includes('--apply')) {
    console.log('\nPreview only. Re-run with --apply to save this to the store.');
    return;
  }
  const result = await applyWholesaleDiscount(shopify, config, { startsAt: argument(args, '--starts-at') || undefined });
  console.log(`\nDiscount ${result.action}: ${result.discountId} (${result.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
