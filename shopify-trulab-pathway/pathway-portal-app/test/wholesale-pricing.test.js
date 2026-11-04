import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cartLinesDiscountsGenerateRun } from '../inactive/clinic-wholesale-pricing/src/index.js';
import { validatePricingConfig } from '../inactive/clinic-wholesale-pricing/src/pricing.js';
import { applyWholesaleDiscount, resolveProductHandles } from '../scripts/wholesale-discount.mjs';

const PGX = 'gid://shopify/Product/111';
const PATHWAY = 'gid://shopify/Product/222';
const OTHER = 'gid://shopify/Product/999';
const CONFIG = {
  currencyCode: 'USD',
  rules: [
    { name: 'PGX', productIds: [PGX], tiers: [{ minQuantity: 1, unitPrice: '550.00' }, { minQuantity: 10, unitPrice: '500.00' }] },
    { name: 'PATHWAY', productIds: [PATHWAY], message: 'Clinic price', tiers: [{ minQuantity: 1, unitPrice: '450.00' }, { minQuantity: 10, unitPrice: '400.00' }] },
  ],
};

function line(id, productId, quantity, price) {
  return { id, quantity, cost: { amountPerQuantity: { amount: price } }, merchandise: { product: { id: productId } } };
}

function input(lines, { clinic = true, config = CONFIG, currency = 'USD', classes = ['PRODUCT'] } = {}) {
  return {
    cart: {
      buyerIdentity: { customer: clinic === null ? null : { hasAnyTag: clinic } },
      cost: { subtotalAmount: { currencyCode: currency } },
      lines,
    },
    discount: { discountClasses: classes, metafield: config === null ? null : { jsonValue: config } },
  };
}

function discounts(result) {
  const candidates = result.operations[0]?.productDiscountsAdd.candidates || [];
  return Object.fromEntries(candidates.map((candidate) => [candidate.targets[0].cartLine.id, candidate.value.fixedAmount.amount]));
}

test('brings each kit down to the wholesale unit price for tagged clinics', () => {
  const result = cartLinesDiscountsGenerateRun(input([line('a', PGX, 2, '699.00'), line('b', PATHWAY, 1, '599.00')]));
  assert.deepEqual(discounts(result), { a: '149.00', b: '149.00' });
  const candidate = result.operations[0].productDiscountsAdd.candidates[1];
  assert.equal(candidate.message, 'Clinic price');
  assert.equal(candidate.value.fixedAmount.appliesToEachItem, true);
  assert.equal(result.operations[0].productDiscountsAdd.selectionStrategy, 'ALL');
});

test('uses the higher tier once the quantity across all lines of a product reaches it', () => {
  // 6 + 4 variants of the same product = 10 units -> $500 tier.
  const result = cartLinesDiscountsGenerateRun(input([line('a', PGX, 6, '699.00'), line('b', PGX, 4, '650.00'), line('c', PATHWAY, 9, '599.00')]));
  assert.deepEqual(discounts(result), { a: '199.00', b: '150.00', c: '149.00' });
});

test('gives no discount to customers without the tag, or to guests', () => {
  assert.deepEqual(cartLinesDiscountsGenerateRun(input([line('a', PGX, 1, '699.00')], { clinic: false })), { operations: [] });
  assert.deepEqual(cartLinesDiscountsGenerateRun(input([line('a', PGX, 1, '699.00')], { clinic: null })), { operations: [] });
});

test('leaves other products and already-cheaper lines alone', () => {
  const result = cartLinesDiscountsGenerateRun(input([line('a', OTHER, 3, '100.00'), line('b', PGX, 1, '540.00')]));
  assert.deepEqual(result, { operations: [] });
});

test('fails safe: bad config, other currency, or non-product discount class means full price', () => {
  const lines = [line('a', PGX, 1, '699.00')];
  assert.deepEqual(cartLinesDiscountsGenerateRun(input(lines, { config: null })), { operations: [] });
  assert.deepEqual(cartLinesDiscountsGenerateRun(input(lines, { config: { currencyCode: 'USD', rules: [] } })), { operations: [] });
  assert.deepEqual(cartLinesDiscountsGenerateRun(input(lines, { currency: 'CAD' })), { operations: [] });
  assert.deepEqual(cartLinesDiscountsGenerateRun(input(lines, { classes: ['ORDER'] })), { operations: [] });
});

test('avoids floating-point drift in cent amounts', () => {
  const config = { currencyCode: 'USD', rules: [{ productIds: [PGX], tiers: [{ minQuantity: 1, unitPrice: '0.10' }] }] };
  assert.deepEqual(discounts(cartLinesDiscountsGenerateRun(input([line('a', PGX, 1, '0.30')], { config }))), { a: '0.20' });
});

test('config validation explains every problem', () => {
  assert.deepEqual(validatePricingConfig(CONFIG), []);
  const errors = validatePricingConfig({
    currencyCode: 'usd',
    rules: [
      { name: 'A', productIds: ['123', PGX], tiers: [{ minQuantity: 10, unitPrice: '500' }, { minQuantity: 5, unitPrice: '$1' }] },
      { name: 'B', productIds: [PGX], tiers: [] },
    ],
  });
  assert.equal(errors.length, 6);
  assert.match(errors.join('\n'), /currencyCode/);
  assert.match(errors.join('\n'), /not a product ID/);
  assert.match(errors.join('\n'), /increasing minQuantity/);
  assert.match(errors.join('\n'), /unitPrice/);
  assert.match(errors.join('\n'), /more than one rule/);
});

for (const file of ['pricing.example.json', 'pricing.json']) {
  test(`${file} is valid once handles become IDs`, () => {
    const config = JSON.parse(readFileSync(new URL(`../inactive/clinic-wholesale-pricing/${file}`, import.meta.url)));
    const withIds = { ...config, rules: config.rules.map(({ productHandles, ...rule }, index) => ({ ...rule, productIds: [`gid://shopify/Product/${index + 1}`] })) };
    assert.deepEqual(validatePricingConfig(withIds), []);
  });
}

test('pricing.json carries the live Massy volume prices', () => {
  const config = JSON.parse(readFileSync(new URL('../inactive/clinic-wholesale-pricing/pricing.json', import.meta.url)));
  const prices = Object.fromEntries(config.rules.map((rule) => [rule.productHandles[0], rule.tiers.map((tier) => [tier.minQuantity, tier.unitPrice])]));
  assert.deepEqual(prices, {
    'trinity-pathway-pgx-genetic-test-kit': [[1, '550.00'], [10, '500.00']],
    'trulab-dx-pathway-genetic-test': [[1, '450.00'], [10, '400.00']],
  });
});

test('setup script resolves handles, creates the discount once, then only updates its prices', async () => {
  const calls = [];
  let discount = null;
  const shopify = {
    async graphql(query, variables) {
      calls.push(query.match(/(query|mutation) (\w+)/)[2]);
      if (query.includes('WholesaleProduct')) return { products: { nodes: [{ id: PGX, handle: 'pgx-kit' }] } };
      if (query.includes('WholesaleDiscount')) return { discountNodes: { nodes: discount ? [discount] : [] } };
      if (query.includes('WholesaleFunctions')) return { shopifyFunctions: { nodes: [{ id: 'fn-1', title: 'Clinic wholesale pricing' }] } };
      if (query.includes('WholesaleCreate')) {
        assert.equal(variables.discount.functionId, 'fn-1');
        assert.deepEqual(variables.discount.discountClasses, ['PRODUCT']);
        assert.equal(variables.discount.metafields[0].namespace, '$app:clinic-wholesale');
        discount = { id: 'gid://shopify/DiscountAutomaticNode/5', discount: { __typename: 'DiscountAutomaticApp', title: 'Clinic wholesale pricing', status: 'ACTIVE' } };
        return { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: discount.id, status: 'ACTIVE' }, userErrors: [] } };
      }
      if (query.includes('WholesaleSetConfig')) {
        assert.equal(variables.metafields[0].ownerId, discount.id);
        return { metafieldsSet: { metafields: [{ id: 'm1' }], userErrors: [] } };
      }
      throw new Error('unexpected query');
    },
  };
  const config = await resolveProductHandles(shopify, {
    currencyCode: 'USD',
    rules: [{ name: 'PGX', productHandles: ['pgx-kit'], tiers: [{ minQuantity: 1, unitPrice: '550.00' }] }],
  });
  assert.deepEqual(config.rules[0].productIds, [PGX]);
  assert.equal('productHandles' in config.rules[0], false);
  assert.equal((await applyWholesaleDiscount(shopify, config)).action, 'created');
  assert.equal((await applyWholesaleDiscount(shopify, config)).action, 'updated');
  assert.deepEqual(calls, ['WholesaleProduct', 'WholesaleDiscount', 'WholesaleFunctions', 'WholesaleCreate', 'WholesaleDiscount', 'WholesaleSetConfig']);
});

test('setup script refuses --apply while the Function is inactive (store is on Basic)', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/wholesale-discount.mjs', import.meta.url)), '--config', 'pricing.json', '--apply'], {
    env: {}, encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Inactive: the store is on Shopify Basic/);
});

test('the Function is outside extensions/, so shopify app deploy cannot pick it up', () => {
  assert.equal(existsSync(new URL('../extensions/clinic-wholesale-pricing', import.meta.url)), false);
  const toml = readFileSync(new URL('../shopify.app.toml.example', import.meta.url), 'utf8');
  assert.doesNotMatch(toml, /write_discounts/);
});
