import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const configUrl = new URL('../shopify.app.toml.example', import.meta.url);

test('Shopify app template includes current required auth and webhook sections', async () => {
  const config = await readFile(configUrl, 'utf8');

  assert.match(config, /^\[auth\]$/m);
  assert.match(config, /^redirect_urls\s*=\s*\["https:\/\/[^\"]+\/"\]$/m);
  assert.match(config, /^\[webhooks\]$/m);
  assert.match(config, /^api_version\s*=\s*"\d{4}-\d{2}"$/m);
});

test('Shopify app template defines editable affiliate Page fields', async () => {
  const config = await readFile(configUrl, 'utf8');

  assert.match(config, /^scopes\s*=.*write_content/m);
  assert.match(config, /^\[page\.metafields\.app\.affiliate_name\]$/m);
  assert.match(config, /^\[page\.metafields\.app\.affiliate_logo\]$/m);
  assert.match(config, /^\[page\.metafields\.app\.affiliate_discount_code\]$/m);
  assert.match(config, /^\[page\.metafields\.app\.affiliate_tracking_id\]$/m);
  assert.match(config, /^capabilities\.unique_values\s*=\s*true$/m);
});
