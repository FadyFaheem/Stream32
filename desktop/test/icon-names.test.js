const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const { parseIconNames } = require('../tools/generate-icon-names');

test('parses icon names from the typings union', () => {
  const typings = `type MaterialSymbols = [
  "123",
  "volume_up",
  "play_arrow",
  "volume_up",
];
export default MaterialSymbols;
`;

  assert.deepEqual(parseIconNames(typings), [
    '123',
    'volume_up',
    'play_arrow',
  ]);
});

test('the installed package yields a full icon set', () => {
  const names = parseIconNames(
    readFileSync(require.resolve('material-symbols/index.d.ts'), 'utf8'),
  );

  assert.ok(names.length > 1000, `only ${names.length} icons parsed`);
  assert.ok(names.includes('volume_up'));
  assert.ok(names.includes('play_arrow'));
});
