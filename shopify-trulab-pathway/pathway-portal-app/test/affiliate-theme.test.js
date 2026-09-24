import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sectionUrl = new URL('../../sections/trulab-affiliate-landing.liquid', import.meta.url);
const templateUrl = new URL('../../templates/page.pathway-affiliate.json', import.meta.url);

test('affiliate template renders app-owned Page fields and PATHWAY product', async () => {
  const [section, templateText] = await Promise.all([
    readFile(sectionUrl, 'utf8'),
    readFile(templateUrl, 'utf8'),
  ]);
  const template = JSON.parse(templateText);

  assert.equal(template.sections.main.type, 'trulab-affiliate-landing');
  assert.equal(template.sections.main.settings.product, 'trulab-dx-pathway-genetic-test');
  assert.match(section, /page\.metafields\['app--414644109313'\]/);
  assert.match(section, /affiliate_metafields\.affiliate_name\.value/);
  assert.match(section, /affiliate_metafields\.affiliate_discount_code\.value/);
  assert.match(section, /affiliate_metafields\.affiliate_tracking_id\.value/);
  assert.match(section, /data-product-price/);
});

test('affiliate attribution follows the cart and PATHWAY line item', async () => {
  const section = await readFile(sectionUrl, 'utf8');

  assert.match(section, /properties\[_affiliate_id\]/);
  assert.match(section, /properties\[_affiliate_name\]/);
  assert.match(section, /properties\[_affiliate_code\]/);
  assert.match(section, /properties\[_affiliate_page\]/);
  assert.match(section, /'__affiliate_id'/);
  assert.match(section, /'__affiliate_name'/);
  assert.match(section, /'__affiliate_code'/);
  assert.match(section, /'__affiliate_page'/);
});

test('affiliate discount auto-apply is loop-safe and disabled in the theme editor', async () => {
  const section = await readFile(sectionUrl, 'utf8');

  assert.match(section, /Shopify\.designMode/);
  assert.match(section, /sessionStorage\.getItem/);
  assert.match(section, /window\.location\.replace\('\/discount\/'/);
  assert.match(section, /searchParams\.set\(markerName, markerValue\)/);
});
