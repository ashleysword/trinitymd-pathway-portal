import test from 'node:test';
import assert from 'node:assert/strict';

await import('../public/portal/code128.js');

const decoder = globalThis.PathwayCode128Decoder;

function code128BRow(value, moduleWidth = 3) {
  const dataValues = [...value].map((character) => character.charCodeAt(0) - 32);
  const values = [104, ...dataValues];
  const checksum = values.slice(1)
    .reduce((sum, item, index) => sum + item * (index + 1), values[0]) % 103;
  const symbols = [...values, checksum, 106];
  const luminance = Array(30).fill(255);
  for (const symbol of symbols) {
    let dark = true;
    for (const run of decoder.patterns[symbol]) {
      luminance.push(...Array(run * moduleWidth).fill(dark ? 0 : 255));
      dark = !dark;
    }
  }
  luminance.push(...Array(30).fill(255));
  return luminance;
}

test('decodes the Code 128 B format used by the photographed PATHWAY labels', () => {
  const syntheticKitId = 'TL00001234';
  assert.equal(decoder.decodeCode128Row(code128BRow(syntheticKitId)), syntheticKitId);
});

test('decodes a label scanned upside down', () => {
  assert.equal(decoder.decodeCode128Row(code128BRow('TL00005678').reverse()), 'TL00005678');
});

test('checks the Code 128 checksum before returning a value', () => {
  assert.equal(decoder.decodeCode128Values([104, 52, 44, 1]), null);
});
