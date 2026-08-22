const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { validateAudioAction } = require('../src/action-model');
const {
  createAudioController,
  findSinkInputs,
  linuxAudioInvocation,
  linuxSinkInputInvocation,
  macAudioInvocation,
  matchesApp,
  windowsAudioMessage,
} = require('../src/audio');
const { validateAction } = require('../src/deck-model');

function fakeChild({ stdout = '', code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (error) {
      child.emit('error', error);
      return;
    }

    if (stdout) {
      child.stdout.emit('data', stdout);
    }

    child.emit('exit', code);
  });
  return child;
}

test('audio actions keep only the fields their operation uses', () => {
  assert.deepEqual(
    validateAudioAction({ type: 'audio', operation: 'set-volume', level: 40 }),
    { type: 'audio', operation: 'set-volume', level: 40 },
  );
  assert.deepEqual(
    validateAudioAction({
      type: 'audio',
      operation: 'app-mute',
      app: '  Spotify  ',
      state: 'toggle',
      level: 90,
    }),
    { type: 'audio', operation: 'app-mute', app: 'Spotify', state: 'toggle' },
  );
});

test('audio actions reject out-of-range and missing targets', () => {
  const rejected = [
    { type: 'audio', operation: 'set-volume', level: 101 },
    { type: 'audio', operation: 'set-volume', level: 12.5 },
    { type: 'audio', operation: 'set-volume' },
    { type: 'audio', operation: 'mute', state: 'quiet' },
    { type: 'audio', operation: 'set-output-device', device: '   ' },
    { type: 'audio', operation: 'app-volume', app: 'chrome' },
    { type: 'audio', operation: 'nope' },
  ];

  for (const action of rejected) {
    assert.throws(() => validateAudioAction(action), TypeError);
  }
});

test('the deck model accepts audio actions as keys and Multi steps', () => {
  const action = {
    type: 'multi',
    steps: [
      { type: 'audio', operation: 'set-output-device', device: 'Headphones' },
      { type: 'delay', ms: 100 },
      { type: 'audio', operation: 'app-volume', app: 'chrome.exe', level: 20 },
    ],
  };
  assert.deepEqual(validateAction(action, 1), action);
  assert.throws(
    () => validateAction(
      { type: 'multi', steps: [{ type: 'audio', operation: 'mute' }] },
      1,
    ),
    /Step 1: Audio mute state/,
  );
});

test('Windows audio messages carry the operation as the message kind', () => {
  assert.deepEqual(
    windowsAudioMessage({
      type: 'audio',
      operation: 'app-volume',
      app: 'chrome',
      level: 30,
    }),
    { kind: 'app-volume', app: 'chrome', level: 30 },
  );
});

test('Linux audio maps to pactl, including an explicit mute state', () => {
  assert.deepEqual(
    linuxAudioInvocation({ operation: 'set-volume', level: 35 }),
    { command: 'pactl', args: ['set-sink-volume', '@DEFAULT_SINK@', '35%'] },
  );
  assert.deepEqual(
    linuxAudioInvocation({ operation: 'mute', state: 'off' }),
    { command: 'pactl', args: ['set-sink-mute', '@DEFAULT_SINK@', '0'] },
  );
  assert.deepEqual(
    linuxAudioInvocation({ operation: 'mute', state: 'toggle' }),
    { command: 'pactl', args: ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'] },
  );
  assert.deepEqual(
    linuxSinkInputInvocation({ operation: 'app-volume', level: 10 }, 7),
    { command: 'pactl', args: ['set-sink-input-volume', '7', '10%'] },
  );
});

test('macOS audio uses osascript and reports the per-app gap', () => {
  assert.deepEqual(
    macAudioInvocation({ operation: 'set-volume', level: 20 }),
    { command: 'osascript', args: ['-e', 'set volume output volume 20'] },
  );
  assert.deepEqual(
    macAudioInvocation({ operation: 'mute', state: 'on' }),
    { command: 'osascript', args: ['-e', 'set volume output muted true'] },
  );
  assert.throws(
    () => macAudioInvocation({ operation: 'app-volume', app: 'Music' }),
    /no public per-application volume API/,
  );
});

test('an application name matches a pactl display name or a process name', () => {
  assert.equal(matchesApp('Firefox', 'firefox'), true);
  assert.equal(matchesApp('firefox', 'firefox.exe'), true);
  assert.equal(matchesApp('chrome.exe', 'Chrome'), true);
  assert.equal(matchesApp('Spotify', 'chrome'), false);
  assert.deepEqual(
    findSinkInputs(
      [
        { index: 3, properties: { 'application.name': 'Firefox' } },
        { index: 5, properties: { 'application.process.binary': 'firefox' } },
        { index: 8, properties: { 'application.name': 'Spotify' } },
      ],
      'firefox',
    ),
    [3, 5],
  );
});

test('macOS reports the missing device switcher without failing volume', async () => {
  const controller = createAudioController({
    platform: 'darwin',
    spawnProcess: () => fakeChild({
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    }),
  });
  const capabilities = await controller.getCapabilities();
  assert.equal(capabilities.system.available, true);
  assert.equal(capabilities.device.available, false);
  assert.match(capabilities.device.reason, /SwitchAudioSource/);
  assert.equal(capabilities.perApp.available, false);
});

test('a Linux per-app change resolves the sink input before setting it', async () => {
  const calls = [];
  const controller = createAudioController({
    platform: 'linux',
    spawnProcess(command, args) {
      calls.push([command, ...args]);

      if (args.includes('--version')) {
        return fakeChild();
      }

      if (args.includes('sink-inputs')) {
        return fakeChild({
          stdout: JSON.stringify([
            { index: 11, properties: { 'application.name': 'Chromium' } },
          ]),
        });
      }

      return fakeChild();
    },
  });
  await controller.apply({
    type: 'audio',
    operation: 'app-mute',
    app: 'chromium',
    state: 'on',
  });
  assert.deepEqual(calls.at(-1), ['pactl', 'set-sink-input-mute', '11', '1']);
});

test('a Linux per-app change explains a silent application', async () => {
  const controller = createAudioController({
    platform: 'linux',
    spawnProcess: (command, args) =>
      fakeChild({ stdout: args.includes('sink-inputs') ? '[]' : '' }),
  });
  await assert.rejects(
    controller.apply({
      type: 'audio',
      operation: 'app-volume',
      app: 'obs',
      level: 50,
    }),
    /obs is not playing audio right now/,
  );
});
