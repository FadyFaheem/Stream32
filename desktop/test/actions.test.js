const assert = require('node:assert/strict');
const test = require('node:test');

const {
  linuxInvocation,
  macInvocation,
  windowsKeyLine,
} = require('../src/actions');
const { validateHostAction } = require('../src/deck-store');
const { canonicalKeyFromCode } = require('../src/keymap');

test('maps media commands to extended Windows virtual keys', () => {
  assert.equal(
    windowsKeyLine({ type: 'media', command: 'play-pause' }),
    '179e',
  );
  assert.equal(windowsKeyLine({ type: 'media', command: 'mute' }), '173e');
});

test('maps hotkeys to ordered Windows key sequences', () => {
  assert.equal(
    windowsKeyLine({
      type: 'hotkey',
      key: 'F5',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    }),
    '17 16 116',
  );
  assert.equal(
    windowsKeyLine({ type: 'hotkey', key: 'Up', meta: true }),
    '91 38e',
  );
});

test('maps actions to Linux and macOS invocations', () => {
  assert.deepEqual(linuxInvocation({ type: 'media', command: 'volume-up' }), {
    command: 'pactl',
    args: ['set-sink-volume', '@DEFAULT_SINK@', '+5%'],
  });
  assert.deepEqual(linuxInvocation({ type: 'media', command: 'next' }), {
    command: 'playerctl',
    args: ['next'],
  });
  assert.deepEqual(
    linuxInvocation({ type: 'hotkey', key: 'A', ctrl: true, shift: true }),
    { command: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+shift+a'] },
  );

  assert.deepEqual(macInvocation({ type: 'hotkey', key: 'A', meta: true }), {
    command: 'osascript',
    args: [
      '-e',
      'tell application "System Events" to keystroke "a" using {command down}',
    ],
  });
  assert.deepEqual(macInvocation({ type: 'hotkey', key: 'F5', ctrl: true }), {
    command: 'osascript',
    args: [
      '-e',
      'tell application "System Events" to key code 96 using {control down}',
    ],
  });
  assert.throws(
    () => macInvocation({ type: 'media', command: 'play-pause' }),
    /not supported on macOS/,
  );
});

test('canonicalizes KeyboardEvent codes for hotkey capture', () => {
  assert.equal(canonicalKeyFromCode('KeyA'), 'A');
  assert.equal(canonicalKeyFromCode('Digit7'), '7');
  assert.equal(canonicalKeyFromCode('F11'), 'F11');
  assert.equal(canonicalKeyFromCode('ArrowLeft'), 'Left');
  assert.equal(canonicalKeyFromCode('Comma'), 'Comma');
  assert.equal(canonicalKeyFromCode('ControlLeft'), null);
  assert.equal(canonicalKeyFromCode('MetaRight'), null);
});

test('validates renderer actions before privileged execution', () => {
  assert.deepEqual(
    validateHostAction({ type: 'hotkey', key: 'M', ctrl: true }),
    {
      type: 'hotkey',
      key: 'M',
      alt: false,
      ctrl: true,
      meta: false,
      shift: false,
    },
  );
  assert.throws(
    () => validateHostAction({ type: 'hotkey', key: 'NotAKey' }),
    /Unknown hotkey/,
  );
  assert.throws(
    () => validateHostAction({ type: 'page', page: 0 }),
    /never reach/,
  );
});
