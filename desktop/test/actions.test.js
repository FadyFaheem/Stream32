const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createActionRunner,
  linuxInvocation,
  macInvocation,
  windowsInputMessage,
  windowsKeyLine,
} = require('../src/actions');
const { validateHostAction } = require('../src/deck-model');
const { canonicalKeyFromCode } = require('../src/keymap');

function fakeWindowsChild(onWrite) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (line, callback) => {
    const message = JSON.parse(line);

    if (onWrite) {
      onWrite(message, callback, child);
    } else {
      callback?.();
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          `${JSON.stringify({ id: message.id, ok: true })}\n`,
        );
      });
    }

    return true;
  };
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

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
    '91e 38e',
  );
  assert.equal(
    windowsKeyLine({ type: 'hotkey', key: 'L', meta: true }),
    'lock',
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

test('builds structured Windows text and mouse messages', () => {
  const text = 'Quotes "`; 👋\nnext';
  const message = windowsInputMessage({ type: 'text', text });

  assert.equal(message.kind, 'text');
  assert.equal(Buffer.from(message.text, 'base64').toString('utf8'), text);
  assert.equal(JSON.stringify(message).includes(text), false);
  assert.deepEqual(
    windowsInputMessage({
      type: 'mouse',
      operation: 'click',
      button: 'middle',
      clicks: 2,
    }),
    {
      kind: 'mouse',
      operation: 'click',
      button: 'middle',
      clicks: 2,
    },
  );
  assert.deepEqual(
    windowsInputMessage({ type: 'hotkey', key: 'Up', meta: true }),
    {
      kind: 'keys',
      codes: [91, 38],
      extended: [true, true],
    },
  );
  assert.deepEqual(
    windowsInputMessage({ type: 'hotkey', key: 'L', meta: true }),
    { kind: 'lock' },
  );
});

test('writes input to one persistent Windows child without real injection', async () => {
  const lines = [];
  let spawns = 0;
  const child = fakeWindowsChild((message, callback, process) => {
    lines.push(message);
    callback?.();
    queueMicrotask(() => {
      process.stdout.emit(
        'data',
        `${JSON.stringify({ id: message.id, ok: true })}\n`,
      );
    });
  });
  const runner = createActionRunner({
    platform: 'win32',
    spawnProcess(command, args) {
      spawns++;
      assert.equal(command, 'powershell.exe');
      assert.equal(args.includes('-NonInteractive'), true);
      return child;
    },
  });

  await runner.runAction({ type: 'text', text: 'safe; 👋' });
  await runner.runAction({
    type: 'mouse',
    operation: 'move-relative',
    x: -2,
    y: 3,
  });

  assert.equal(spawns, 1);
  assert.equal(
    Buffer.from(lines[0].text, 'base64').toString('utf8'),
    'safe; 👋',
  );
  assert.deepEqual(
    { ...lines[1], id: undefined },
    {
      id: undefined,
    kind: 'mouse',
    operation: 'move-relative',
    x: -2,
    y: 3,
    },
  );
  assert.deepEqual(lines.map((line) => line.id), [1, 2]);
  runner.dispose();
});

test('correlates out-of-order Windows input replies', async () => {
  const messages = [];
  const child = fakeWindowsChild((message, callback) => {
    messages.push(message);
    callback?.();
  });
  const runner = createActionRunner({
    platform: 'win32',
    spawnProcess: () => child,
  });
  const completed = [];
  const first = runner.runAction({ type: 'media', command: 'mute' })
    .then(() => completed.push('first'));
  const second = runner.runAction({ type: 'media', command: 'volume-up' })
    .then(() => completed.push('second'));
  await Promise.resolve();

  child.stdout.emit(
    'data',
    `${JSON.stringify({ id: messages[1].id, ok: true })}\n`,
  );
  await second;
  assert.deepEqual(completed, ['second']);
  child.stdout.emit(
    'data',
    `${JSON.stringify({ id: messages[0].id, ok: true })}\n`,
  );
  await first;
  assert.deepEqual(completed, ['second', 'first']);
  runner.dispose();
});

test('rejects Windows script errors without exposing input text', async () => {
  const secret = 'secret command\n';
  const child = fakeWindowsChild((message, callback, process) => {
    callback?.();
    queueMicrotask(() => {
      process.stdout.emit(
        'data',
        `${JSON.stringify({
          id: message.id,
          ok: false,
          error: 'SendInput was denied',
        })}\n`,
      );
    });
  });
  const runner = createActionRunner({
    platform: 'win32',
    spawnProcess: () => child,
  });

  await assert.rejects(
    runner.runAction({ type: 'text', text: secret }),
    (error) => {
      assert.match(error.message, /SendInput was denied/);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  runner.dispose();
});

test('rejects Windows EPIPE and early child exits', async () => {
  const brokenPipe = fakeWindowsChild((_message, callback) => {
    callback?.(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  });
  const pipeRunner = createActionRunner({
    platform: 'win32',
    spawnProcess: () => brokenPipe,
  });
  await assert.rejects(
    pipeRunner.runAction({ type: 'media', command: 'mute' }),
    /write failed: broken pipe/,
  );
  assert.equal(brokenPipe.killed, true);

  const exited = fakeWindowsChild((_message, callback, process) => {
    callback?.();
    queueMicrotask(() => process.emit('exit', 7));
  });
  const exitRunner = createActionRunner({
    platform: 'win32',
    spawnProcess: () => exited,
  });
  await assert.rejects(
    exitRunner.runAction({ type: 'media', command: 'mute' }),
    /exited before replying \(code 7\)/,
  );
});

test('times out and recycles an unresponsive Windows input child', async () => {
  const child = fakeWindowsChild((_message, callback) => callback?.());
  const runner = createActionRunner({
    platform: 'win32',
    spawnProcess: () => child,
    windowsInputTimeoutMs: 10,
  });

  await assert.rejects(
    runner.runAction({ type: 'media', command: 'mute' }),
    /timed out/,
  );
  assert.equal(child.killed, true);
});

test('passes macOS input only as fixed-program arguments', () => {
  const text = '"; throw new Error("injected")';
  const invocation = macInvocation({ type: 'text', text });
  const scriptIndex = invocation.args.indexOf('-e') + 1;

  assert.equal(invocation.command, 'osascript');
  assert.equal(invocation.args[scriptIndex].includes(text), false);
  assert.equal(
    Buffer.from(invocation.args.at(-1), 'base64').toString('utf8'),
    text,
  );
  assert.deepEqual(
    macInvocation({
      type: 'mouse',
      operation: 'move-relative',
      x: -4,
      y: 7,
    }).args.slice(-3),
    ['move-relative', '-4', '7'],
  );
});

test('builds xdotool argument arrays for text and mouse input', () => {
  assert.deepEqual(linuxInvocation({ type: 'text', text: '--help; echo bad' }), {
    command: 'xdotool',
    args: ['type', '--clearmodifiers', '--delay', '1', '--', '--help; echo bad'],
  });
  assert.deepEqual(linuxInvocation({ type: 'text', text: 'a\n\tb' }), {
    command: 'xdotool',
    args: [
      'type', '--clearmodifiers', '--delay', '1', '--', 'a',
      'key', '--clearmodifiers', 'Return',
      'key', '--clearmodifiers', 'Tab',
      'type', '--clearmodifiers', '--delay', '1', '--', 'b',
    ],
  });
  assert.deepEqual(
    linuxInvocation({
      type: 'mouse',
      operation: 'click',
      button: 'right',
      clicks: 2,
    }),
    {
      command: 'xdotool',
      args: ['click', '--repeat', '2', '3'],
    },
  );
  assert.deepEqual(
    linuxInvocation({
      type: 'mouse',
      operation: 'scroll',
      vertical: -2,
      horizontal: 1,
    }),
    {
      command: 'xdotool',
      args: ['click', '--repeat', '2', '5', 'click', '--repeat', '1', '7'],
    },
  );
});

test('probes Linux input capabilities without executing input', async () => {
  let probes = 0;
  const x11 = createActionRunner({
    environment: { XDG_SESSION_TYPE: 'x11' },
    platform: 'linux',
    probeCommand(command, args) {
      probes++;
      assert.deepEqual([command, args], ['xdotool', ['--version']]);
      return true;
    },
  });
  assert.deepEqual(await x11.getCapabilities(), {
    text: { available: true, reason: 'Requires X11 and xdotool.' },
    mouse: { available: true, reason: 'Requires X11 and xdotool.' },
  });
  await x11.getCapabilities();
  assert.equal(probes, 1);

  const missing = createActionRunner({
    environment: { XDG_SESSION_TYPE: 'x11' },
    platform: 'linux',
    probeCommand: async () => false,
  });
  const missingCapabilities = await missing.getCapabilities();
  assert.equal(missingCapabilities.mouse.available, false);
  assert.match(missingCapabilities.text.reason, /Install xdotool/);

  const wayland = createActionRunner({
    environment: { WAYLAND_DISPLAY: 'wayland-0' },
    onEvent(event, details) {
      assert.equal(event, 'failed');
      assert.equal(details.type, 'text');
      assert.equal(Object.hasOwn(details, 'text'), false);
    },
    platform: 'linux',
    probeCommand() {
      throw new Error('Wayland must not probe xdotool.');
    },
  });
  const capabilities = await wayland.getCapabilities();
  assert.equal(capabilities.text.available, false);
  assert.match(capabilities.mouse.reason, /Wayland/);
  await assert.rejects(
    () => wayland.runAction({ type: 'text', text: 'never injected' }),
    /X11 session/,
  );
});
