const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isVersionAtLeast,
  isVersionNewer,
} = require('../src/semver');

test('isVersionNewer reports only strictly newer versions', () => {
  assert.equal(isVersionNewer('0.2.9', '0.2.8'), true);
  assert.equal(isVersionNewer('1.0.0', '0.9.9'), true);
  assert.equal(isVersionNewer('0.2.8', '0.2.8'), false);
  assert.equal(isVersionNewer('0.2.7', '0.2.8'), false);
  // A final release outranks its own pre-releases.
  assert.equal(isVersionNewer('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isVersionNewer('1.0.0-rc.1', '1.0.0'), false);
});

test('isVersionAtLeast still allows equal versions', () => {
  assert.equal(isVersionAtLeast('1.2.0', '1.2.0'), true);
  assert.equal(isVersionAtLeast('1.2.0', '1.3.0'), false);
});
