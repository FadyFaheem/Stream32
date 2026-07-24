const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appMatchEquals,
  parseManualAppMatch,
  preferredRuleForSnapshot,
  selectProfileForSnapshot,
  validateAppMatch,
  validateAppMatches,
} = require('../src/profile-rules');

test('validates and normalizes bounded platform app identities', () => {
  assert.deepEqual(
    validateAppMatch('win32', {
      kind: 'executable',
      value: ' OBS-Studio\\Bin\\64bit\\OBS64.EXE ',
    }),
    {
      kind: 'executable',
      value: 'obs-studio/bin/64bit/obs64.exe',
    },
  );
  assert.deepEqual(
    validateAppMatch('darwin', {
      kind: 'bundleId',
      value: 'COM.Apple.Safari',
    }),
    { kind: 'bundleId', value: 'com.apple.safari' },
  );
  assert.deepEqual(
    parseManualAppMatch('linux', 'process:OBS'),
    { kind: 'processName', value: 'obs' },
  );
  assert.throws(
    () => validateAppMatch('win32', {
      kind: 'executable',
      value: '*.exe',
    }),
    /executable/,
  );
  assert.throws(
    () => validateAppMatch('darwin', {
      kind: 'bundleId',
      value: 'not a bundle',
    }),
    /bundle id/,
  );
  assert.throws(
    () => validateAppMatches({
      freebsd: { kind: 'processName', value: 'obs' },
    }),
    /platform/,
  );
  assert.throws(
    () => validateAppMatch('linux', {
      kind: 'processName',
      value: 'x'.repeat(261),
    }),
    /invalid/,
  );
});

test('matches stable identities without regex or partial basename matches', () => {
  const snapshot = {
    platform: 'win32',
    processId: 10,
    identities: [{
      kind: 'executable',
      value: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    }],
  };

  assert.equal(
    appMatchEquals(
      { kind: 'executable', value: 'obs64.exe' },
      snapshot,
    ),
    true,
  );
  assert.equal(
    appMatchEquals(
      { kind: 'executable', value: 'bin/64bit/obs64.exe' },
      snapshot,
    ),
    true,
  );
  assert.equal(
    appMatchEquals(
      { kind: 'executable', value: 'bs64.exe' },
      snapshot,
    ),
    false,
  );
  assert.deepEqual(preferredRuleForSnapshot(snapshot), {
    kind: 'executable',
    value: 'obs64.exe',
  });
});

test('selects the first deterministic match and otherwise stays active', () => {
  const device = {
    activeProfileId: 'z-profile',
    defaultProfileId: 'default',
    profiles: {
      'z-profile': {
        appMatches: {
          linux: { kind: 'wmClass', value: 'obs' },
        },
      },
      default: {},
      'a-profile': {
        appMatches: {
          linux: { kind: 'wmClass', value: 'obs' },
        },
      },
    },
  };
  const obs = {
    platform: 'linux',
    processId: 12,
    identities: [{ kind: 'wmClass', value: 'OBS' }],
  };
  const terminal = {
    platform: 'linux',
    processId: 13,
    identities: [{ kind: 'wmClass', value: 'Alacritty' }],
  };

  assert.equal(selectProfileForSnapshot(device, obs), 'a-profile');
  assert.equal(selectProfileForSnapshot(device, terminal), 'z-profile');
});

test('profiles without rules remain on the active profile', () => {
  const device = {
    activeProfileId: 'other',
    defaultProfileId: 'legacy',
    profiles: {
      legacy: { name: 'Legacy' },
      other: { name: 'Other' },
    },
  };

  assert.equal(
    selectProfileForSnapshot(device, {
      platform: 'darwin',
      processId: 9,
      identities: [{ kind: 'bundleId', value: 'com.apple.Safari' }],
    }),
    'other',
  );
});
