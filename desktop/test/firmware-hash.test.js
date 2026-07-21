const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  calculateFirmwareMd5,
} = require('../src/renderer/firmware-hash');

test('calculates esptool-compatible MD5 for a Uint8Array view', () => {
  const backing = Uint8Array.from([99, 1, 2, 3, 99]);
  const image = backing.subarray(1, 4);
  const expected = createHash('md5').update(image).digest('hex');

  assert.equal(calculateFirmwareMd5(image), expected);
});
