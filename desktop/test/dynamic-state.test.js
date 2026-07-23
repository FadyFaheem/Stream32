const assert = require('node:assert/strict');
const test = require('node:test');

const {
  focusedAppTitle,
  formatClock,
  mergeKeyOverlay,
  millisecondsUntilNextMinute,
  providerNames,
  validateLiveState,
} = require('../src/dynamic-state');

test('live overlays merge without mutating persisted keys', () => {
  const base = {
    index: 2,
    label: 'Muted',
    color: '#112233',
    action: { type: 'media', command: 'mute' },
  };
  const before = structuredClone(base);
  const merged = mergeKeyOverlay(base, {
    label: 'Live',
    color: '#445566',
    state: 'on',
  });

  assert.deepEqual(base, before);
  assert.deepEqual(merged, {
    ...before,
    label: 'Live',
    color: '#445566',
    state: 'on',
  });
});

test('validates bounded first-party live state configurations', () => {
  assert.deepEqual(validateLiveState({
    provider: 'toggle',
    on: { label: 'On', color: '#00aa44', labelColor: '#ffffff' },
  }), {
    provider: 'toggle',
    on: { label: 'On', color: '#00aa44', labelColor: '#ffffff' },
  });
  assert.deepEqual(
    validateLiveState({ provider: 'clock', hour12: true }),
    { provider: 'clock', hour12: true },
  );
  assert.deepEqual(
    validateLiveState({ provider: 'focused-app' }),
    { provider: 'focused-app' },
  );
  assert.throws(
    () => validateLiveState({ provider: 'toggle', on: { label: 'x'.repeat(33) } }),
    /label/,
  );
  assert.throws(
    () => validateLiveState({ provider: 'downloaded-code' }),
    /provider/,
  );
});

test('clock formatting and next-minute scheduling are deterministic', () => {
  const date = new Date(2026, 0, 2, 13, 4, 5, 250);

  assert.match(formatClock(date, false), /13:04/);
  assert.match(formatClock(date, true), /01:04/);
  assert.equal(millisecondsUntilNextMinute(date), 54_750);
});

test('focused app titles are privacy-safe and bounded', () => {
  assert.equal(focusedAppTitle({
    identities: [{
      kind: 'executable',
      value: 'C:\\Program Files\\OBS Studio\\obs64.exe',
    }],
  }), 'obs64');
  assert.equal(focusedAppTitle({
    identities: [{ kind: 'processName', value: 'x'.repeat(80) }],
  }).length, 32);
  assert.equal(focusedAppTitle({ identities: [] }), '');
});

test('diagnostic provider summary excludes dynamic content', () => {
  const registry = {
    devices: {
      a: {
        profiles: {
          p: {
            pages: [{
              keys: [
                { liveState: { provider: 'clock' } },
                {
                  liveState: {
                    provider: 'toggle',
                    on: { label: 'private', image: 'data:image/png;base64,AAAA' },
                  },
                },
              ],
            }],
          },
        },
      },
    },
  };

  assert.deepEqual(providerNames(registry), ['clock', 'toggle']);
});
