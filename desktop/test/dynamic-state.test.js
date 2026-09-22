const assert = require('node:assert/strict');
const test = require('node:test');

const {
  focusedAppTitle,
  formatClock,
  mergeKeyOverlay,
  millisecondsUntilNextMinute,
  providerNames,
  statusAppearanceFor,
  validateLiveState,
  validateStatusJson,
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

test('status command states are bounded and their exit codes unique', () => {
  const config = validateLiveState({
    provider: 'status-command',
    command: 'audio-output.sh --status',
    intervalSeconds: 3,
    states: [
      { code: 0, label: 'Speakers', color: '#2f8f5b' },
      { code: 1, label: 'Headset' },
    ],
  });

  assert.deepEqual(config, {
    provider: 'status-command',
    command: 'audio-output.sh --status',
    intervalSeconds: 3,
    states: [
      { code: 0, label: 'Speakers', color: '#2f8f5b' },
      { code: 1, label: 'Headset' },
    ],
  });

  const base = {
    provider: 'status-command',
    command: 'x',
    intervalSeconds: 3,
    states: [{ code: 0 }],
  };

  // A second state on the same code could never be shown, so it is a mistake
  // rather than a preference.
  assert.throws(
    () => validateLiveState({ ...base, states: [{ code: 1 }, { code: 1 }] }),
    /exit code/,
  );
  // Windows exit codes are 32-bit, and its useful ones are not small: 9009 is
  // "command not found" and 3010 is "reboot required".
  assert.deepEqual(
    validateLiveState({ ...base, states: [{ code: 9009, label: 'Missing' }] })
      .states,
    [{ code: 9009, label: 'Missing' }],
  );
  assert.throws(
    () => validateLiveState({ ...base, states: [{ code: 2_147_483_648 }] }),
    /exit code/,
  );
  assert.throws(
    () => validateLiveState({ ...base, states: [{ code: -1 }] }),
    /exit code/,
  );
  assert.throws(() => validateLiveState({ ...base, states: [] }), /states/);
  assert.throws(() => validateLiveState({ ...base, command: '' }), /command/);
  assert.throws(
    () => validateLiveState({ ...base, intervalSeconds: 0 }),
    /interval/,
  );
  assert.throws(
    () => validateLiveState({ ...base, intervalSeconds: 1.5 }),
    /interval/,
  );
});

test('an exit code with no state leaves the saved key showing', () => {
  const config = validateLiveState({
    provider: 'status-command',
    command: 'x',
    intervalSeconds: 3,
    states: [{ code: 2, label: 'HDMI' }],
  });

  assert.deepEqual(statusAppearanceFor(config, 2), { label: 'HDMI' });
  // Unmatched, never run, and killed for hanging all arrive here.
  assert.equal(statusAppearanceFor(config, 1), null);
  assert.equal(statusAppearanceFor(config, null), null);
  assert.equal(statusAppearanceFor(config, undefined), null);
  assert.equal(statusAppearanceFor({ provider: 'clock' }, 0), null);
});

test('a JSON status answer is kept only when it is exactly the schema', () => {
  assert.deepEqual(validateStatusJson({
    key_color: '#2f8f5b',
    text_color: '#ffffff',
    label: 'HDMI',
    icon: 'volume_up',
  }), {
    color: '#2f8f5b',
    labelColor: '#ffffff',
    label: 'HDMI',
    icon: 'volume_up',
  });

  // Every field is optional, so a label alone is a whole answer.
  assert.deepEqual(validateStatusJson({ label: 'Ready' }), { label: 'Ready' });
  assert.deepEqual(validateStatusJson({}), {});
  assert.deepEqual(validateStatusJson({ icon: 'play_circle' }), {
    icon: 'play_circle',
  });
});

test('an image answer is a slot name or a bounded data URL', () => {
  // A slot name: format-checked here, resolved against the key later.
  assert.deepEqual(validateStatusJson({ image: 'logo' }), { image: 'logo' });
  assert.deepEqual(
    validateStatusJson({ image: 'brand-mark_2' }),
    { image: 'brand-mark_2' },
  );

  // A data URL the answer carries itself, bounded tighter than key artwork.
  const url = `data:image/webp;base64,${'A'.repeat(1024)}`;
  assert.deepEqual(validateStatusJson({ image: url }), { image: url });

  const oversized = `data:image/webp;base64,${'A'.repeat(24 * 1024 + 1)}`;
  for (const rejected of [
    oversized,
    'data:image/svg+xml;base64,PHN2Zw==',
    'data:image/webp;base64,not base64!!',
    'Not A Name',
    '',
  ]) {
    assert.throws(() => validateStatusJson({ image: rejected }), /image/);
  }
});

test('a JSON status answer outside the schema is rejected whole', () => {
  const base = { label: 'Ready' };

  // An unknown field could carry anything, so it is a mistake rather than a
  // preference: the caller treats a rejection like no answer at all.
  assert.throws(() => validateStatusJson({ ...base, stdout: 'hi' }), /field/);
  assert.throws(() => validateStatusJson({ key_colour: '#2f8f5b' }), /field/);
  assert.throws(() => validateStatusJson({ key_color: 'green' }), /color/);
  assert.throws(() => validateStatusJson({ text_color: '#2F8F5B' }), /color/);
  assert.throws(() => validateStatusJson({ label: '' }), /label/);
  assert.throws(() => validateStatusJson({ label: 'x'.repeat(33) }), /label/);
  assert.throws(() => validateStatusJson({ icon: 'Not A Name' }), /icon/);
  assert.throws(() => validateStatusJson({ icon: 'x'.repeat(65) }), /icon/);
  assert.throws(() => validateStatusJson(null), /invalid/);
  assert.throws(() => validateStatusJson('{"label":"Hi"}'), /invalid/);
  assert.throws(() => validateStatusJson([{ label: 'Hi' }]), /invalid/);
});

test('JSON status configurations share the polled-command bounds', () => {
  assert.deepEqual(validateLiveState({
    provider: 'status-json',
    command: 'my-status.sh',
    intervalSeconds: 5,
  }), {
    provider: 'status-json',
    command: 'my-status.sh',
    intervalSeconds: 5,
  });

  const base = { provider: 'status-json', command: 'x', intervalSeconds: 3 };

  assert.throws(() => validateLiveState({ ...base, command: '' }), /command/);
  assert.throws(
    () => validateLiveState({ ...base, command: 'x'.repeat(1025) }),
    /command/,
  );
  assert.throws(
    () => validateLiveState({ ...base, intervalSeconds: 0 }),
    /interval/,
  );
  assert.throws(
    () => validateLiveState({ ...base, intervalSeconds: 3601 }),
    /interval/,
  );
});

test('image slots are bounded, named, and dropped while still pending', () => {
  const url = (letter) => `data:image/png;base64,${letter.repeat(8)}`;

  assert.deepEqual(validateLiveState({
    provider: 'status-json',
    command: 'x',
    intervalSeconds: 3,
    images: { logo: url('A'), badge: url('B') },
  }), {
    provider: 'status-json',
    command: 'x',
    intervalSeconds: 3,
    images: { logo: url('A'), badge: url('B') },
  });

  const base = { provider: 'status-json', command: 'x', intervalSeconds: 3 };

  // The editor adds a placeholder row before artwork is chosen; the saved
  // profile never carries one, and a map of nothing pending at all is not
  // saved either.
  assert.deepEqual(
    validateLiveState({
      ...base,
      images: { logo: url('A'), pending: '' },
    }),
    {
      provider: 'status-json',
      command: 'x',
      intervalSeconds: 3,
      images: { logo: url('A') },
    },
  );
  assert.equal(
    validateLiveState({ ...base, images: { pending: '' } }).images,
    undefined,
  );

  // As many slots as the exit-code provider has states.
  const eight = Object.fromEntries(
    Array.from({ length: 8 }, (unused, index) => [`i${index}`, url('A')]),
  );
  assert.throws(
    () => validateLiveState({ ...base, images: { ...eight, one_more: url('A') } }),
    /images/,
  );

  for (const invalid of [
    { 'Not A Name': url('A') },
    { logo: 'green' },
    { logo: 42 },
    'nope',
    [{ logo: url('A') }],
  ]) {
    assert.throws(
      () => validateLiveState({ ...base, images: invalid }),
      /image/,
    );
  }
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
