// Clinic wholesale pricing, shared by the Shopify discount Function (runs in
// checkout) and the setup script (validates the config before it is saved).
// Plain JS with no Node APIs, because it is compiled to WebAssembly.
//
// Config shape (stored as a JSON metafield on the automatic discount):
// {
//   "currencyCode": "USD",
//   "rules": [{
//     "name": "PGX kit",
//     "productIds": ["gid://shopify/Product/123"],
//     "message": "Clinic wholesale price",
//     "tiers": [{ "minQuantity": 1, "unitPrice": "550.00" }, { "minQuantity": 10, "unitPrice": "500.00" }]
//   }]
// }
// Quantity is counted across every cart line in the rule (all variants of its
// products), matching Massy's "Entire order" volume calculation.

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

export function validatePricingConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['Config must be a JSON object.'];
  if (!/^[A-Z]{3}$/.test(String(config.currencyCode || ''))) errors.push('currencyCode must be a 3-letter code such as USD.');
  if (!Array.isArray(config.rules) || config.rules.length === 0) errors.push('rules must list at least one product rule.');
  const seenProducts = new Set();
  (config.rules || []).forEach((rule, index) => {
    const label = `rules[${index}]${rule?.name ? ` (${rule.name})` : ''}`;
    if (!Array.isArray(rule?.productIds) || rule.productIds.length === 0) {
      errors.push(`${label}: productIds must list at least one product.`);
    }
    for (const id of rule?.productIds || []) {
      if (!PRODUCT_GID.test(String(id))) errors.push(`${label}: ${id} is not a product ID (gid://shopify/Product/...).`);
      if (seenProducts.has(id)) errors.push(`${label}: ${id} appears in more than one rule.`);
      seenProducts.add(id);
    }
    if (!Array.isArray(rule?.tiers) || rule.tiers.length === 0) {
      errors.push(`${label}: tiers must list at least one price.`);
      return;
    }
    let previous = 0;
    rule.tiers.forEach((tier, tierIndex) => {
      const minQuantity = Number(tier?.minQuantity);
      if (!Number.isInteger(minQuantity) || minQuantity < 1) errors.push(`${label} tier ${tierIndex + 1}: minQuantity must be a whole number of at least 1.`);
      else if (minQuantity <= previous) errors.push(`${label} tier ${tierIndex + 1}: tiers must be in increasing minQuantity order.`);
      else previous = minQuantity;
      if (!MONEY.test(String(tier?.unitPrice ?? ''))) errors.push(`${label} tier ${tierIndex + 1}: unitPrice must be a price like "500.00".`);
    });
  });
  return errors;
}

function cents(amount) {
  return Math.round(Number(amount) * 100);
}

export function tierFor(rule, quantity) {
  let match = null;
  for (const tier of rule.tiers) {
    if (quantity >= Number(tier.minQuantity)) match = tier;
  }
  return match;
}

const NO_DISCOUNT = { operations: [] };

export function wholesaleDiscounts(input) {
  const discountClasses = input?.discount?.discountClasses || [];
  if (!discountClasses.includes('PRODUCT')) return NO_DISCOUNT;
  if (!input?.cart?.buyerIdentity?.customer?.hasAnyTag) return NO_DISCOUNT;

  const config = input.discount.metafield?.jsonValue;
  // A bad config must never break checkout; it just means no wholesale price.
  if (validatePricingConfig(config).length) return NO_DISCOUNT;
  if (input.cart.cost?.subtotalAmount?.currencyCode !== config.currencyCode) return NO_DISCOUNT;

  const ruleForProduct = new Map();
  for (const rule of config.rules) {
    for (const id of rule.productIds) ruleForProduct.set(id, rule);
  }

  const linesByRule = new Map();
  for (const line of input.cart.lines || []) {
    const rule = ruleForProduct.get(line.merchandise?.product?.id);
    if (!rule) continue;
    if (!linesByRule.has(rule)) linesByRule.set(rule, []);
    linesByRule.get(rule).push(line);
  }

  const candidates = [];
  for (const [rule, lines] of linesByRule) {
    const quantity = lines.reduce((total, line) => total + Number(line.quantity || 0), 0);
    const tier = tierFor(rule, quantity);
    if (!tier) continue;
    const target = cents(tier.unitPrice);
    for (const line of lines) {
      const off = cents(line.cost.amountPerQuantity.amount) - target;
      // Never raise a price that is already at or below wholesale.
      if (off <= 0) continue;
      candidates.push({
        message: rule.message || 'Clinic wholesale price',
        targets: [{ cartLine: { id: line.id } }],
        value: { fixedAmount: { amount: (off / 100).toFixed(2), appliesToEachItem: true } },
      });
    }
  }

  if (!candidates.length) return NO_DISCOUNT;
  return { operations: [{ productDiscountsAdd: { candidates, selectionStrategy: 'ALL' } }] };
}
