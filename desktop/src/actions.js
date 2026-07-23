const { shell } = require('electron');
const { spawn } = require('node:child_process');

const {
  KEY_TABLE,
  MEDIA_VK,
  MODIFIER_MAC,
  MODIFIER_VK,
  MODIFIER_X,
} = require('./keymap');

const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'meta'];
const URL_PATTERN = /^https?:\/\//i;
const WINDOWS_INPUT_TIMEOUT_MS = 5000;
const WINDOWS_REPLY_MAX_LENGTH = 4096;
const MAC_ACCESSIBILITY_ERROR =
  'Stream32 needs Accessibility permission to control keyboard and mouse input. ' +
  'Enable Stream32 in System Settings > Privacy & Security > Accessibility.';

// Runs inside one persistent PowerShell child. Each stdin line is one JSON
// message. Text is UTF-8/base64 so user content is never PowerShell syntax.
const WINDOWS_KEY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$definition = @'
using System;
using System.Runtime.InteropServices;
public static class Input {
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags;
    public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public UIntPtr dwExtraInfo;
  }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool LockWorkStation();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var input = new INPUT(); input.type = 1;
    input.U.ki.wVk = vk; input.U.ki.wScan = scan; input.U.ki.dwFlags = flags;
    return input;
  }
  static INPUT Mouse(int x, int y, uint data, uint flags) {
    var input = new INPUT(); input.type = 0;
    input.U.mi.dx = x; input.U.mi.dy = y; input.U.mi.mouseData = data;
    input.U.mi.dwFlags = flags; return input;
  }
  public static void Chord(int[] codes, bool[] extended) {
    var inputs = new INPUT[codes.Length * 2];
    for (int i = 0; i < codes.Length; i++)
      inputs[i] = Key((ushort)codes[i], 0, extended[i] ? 1u : 0u);
    for (int i = 0; i < codes.Length; i++) {
      int source = codes.Length - 1 - i;
      inputs[codes.Length + i] = Key((ushort)codes[source], 0, extended[source] ? 3u : 2u);
    }
    Send(inputs);
  }
  public static void Text(string text) {
    var inputs = new INPUT[text.Length * 2];
    for (int i = 0; i < text.Length; i++) {
      ushort vk = text[i] == '\\n' ? (ushort)13 : text[i] == '\\t' ? (ushort)9 : (ushort)0;
      inputs[i * 2] = vk == 0 ? Key(0, text[i], 4) : Key(vk, 0, 0);
      inputs[i * 2 + 1] = vk == 0 ? Key(0, text[i], 6) : Key(vk, 0, 2);
    }
    Send(inputs);
  }
  public static void Click(string button, int clicks) {
    uint down = button == "left" ? 2u : button == "right" ? 8u : 32u;
    uint up = button == "left" ? 4u : button == "right" ? 16u : 64u;
    var inputs = new INPUT[clicks * 2];
    for (int i = 0; i < clicks; i++) {
      inputs[i * 2] = Mouse(0, 0, 0, down);
      inputs[i * 2 + 1] = Mouse(0, 0, 0, up);
    }
    Send(inputs);
  }
  public static void MoveAbsolute(int x, int y) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = Math.Max(2, GetSystemMetrics(78)), height = Math.Max(2, GetSystemMetrics(79));
    int nx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
    int ny = (int)Math.Round((y - top) * 65535.0 / (height - 1));
    Send(new [] { Mouse(nx, ny, 0, 0xC001) });
  }
  public static void MoveRelative(int x, int y) { Send(new [] { Mouse(x, y, 0, 1) }); }
  public static void Scroll(int vertical, int horizontal) {
    var inputs = new System.Collections.Generic.List<INPUT>();
    if (vertical != 0) inputs.Add(Mouse(0, 0, unchecked((uint)(vertical * 120)), 0x0800));
    if (horizontal != 0) inputs.Add(Mouse(0, 0, unchecked((uint)(horizontal * 120)), 0x1000));
    Send(inputs.ToArray());
  }
}
'@
Add-Type -TypeDefinition $definition
while ($line = [Console]::In.ReadLine()) {
  $id = $null
  try {
    $message = $line | ConvertFrom-Json
    $id = [long]$message.id
    switch ($message.kind) {
      'lock' {
        if (-not [Input]::LockWorkStation()) {
          throw [System.ComponentModel.Win32Exception]::new(
            [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
      }
      'keys' {
        [Input]::Chord([int[]]$message.codes, [bool[]]$message.extended)
      }
      'text' {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($message.text))
        [Input]::Text($text)
      }
      'mouse' {
        switch ($message.operation) {
          'click' { [Input]::Click([string]$message.button, [int]$message.clicks) }
          'move-absolute' { [Input]::MoveAbsolute([int]$message.x, [int]$message.y) }
          'move-relative' { [Input]::MoveRelative([int]$message.x, [int]$message.y) }
          'scroll' { [Input]::Scroll([int]$message.vertical, [int]$message.horizontal) }
          default { throw "unknown mouse operation" }
        }
      }
      default { throw "unknown input kind" }
    }
    $reply = @{ id = $id; ok = $true }
  } catch {
    $reply = @{
      id = $id
      ok = $false
      error = [string]$_.Exception.Message
    }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
}
`;

const MAC_TEXT_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('ApplicationServices');
function run(argv) {
  if (!$.AXIsProcessTrusted()) throw new Error('accessibility permission required');
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  const events = Application('System Events');
  let chunk = '';
  for (const character of text) {
    if (character !== '\\n' && character !== '\\t') {
      chunk += character;
      continue;
    }
    if (chunk) events.keystroke(chunk);
    events.keyCode(character === '\\n' ? 36 : 48);
    chunk = '';
  }
  if (chunk) events.keystroke(chunk);
}`;

const MAC_MOUSE_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
function point(x, y) { return $.CGPointMake(Number(x), Number(y)); }
function post(type, location, button) {
  const event = $.CGEventCreateMouseEvent(null, type, location, button);
  $.CGEventPost(0, event);
}
function currentPoint() {
  const event = $.CGEventCreate(null);
  return $.CGEventGetLocation(event);
}
function run(argv) {
  if (!$.AXIsProcessTrusted()) throw new Error('accessibility permission required');
  const operation = argv[0];
  if (operation === 'move-absolute' || operation === 'move-relative') {
    const current = currentPoint();
    const location = operation === 'move-absolute'
      ? point(argv[1], argv[2])
      : point(Number(current.x) + Number(argv[1]), Number(current.y) + Number(argv[2]));
    post(5, location, 0);
    return;
  }
  if (operation === 'click') {
    const types = argv[1] === 'left' ? [1, 2, 0]
      : argv[1] === 'right' ? [3, 4, 1] : [25, 26, 2];
    const location = currentPoint();
    for (let i = 0; i < Number(argv[2]); i++) {
      post(types[0], location, types[2]); post(types[1], location, types[2]);
    }
    return;
  }
  const event = $.CGEventCreateScrollWheelEvent(
    null, 1, 2, Number(argv[1]), Number(argv[2]));
  $.CGEventPost(0, event);
}`;

function vkToken(vk, extended) {
  return `${vk}${extended ? 'e' : ''}`;
}

function hotkeyModifiers(action) {
  return MODIFIER_ORDER.filter((modifier) => action[modifier]);
}

// Windows: one stdin line for the persistent key-injection child.
function windowsKeyLine(action) {
  if (action.type === 'media') {
    return vkToken(MEDIA_VK[action.command], true);
  }

  if (
    action.key === 'L' &&
    action.meta &&
    !action.alt &&
    !action.ctrl &&
    !action.shift
  ) {
    return 'lock';
  }

  const key = KEY_TABLE[action.key];
  const tokens = hotkeyModifiers(action).map((modifier) =>
    vkToken(MODIFIER_VK[modifier], modifier === 'meta'),
  );

  tokens.push(vkToken(key.vk, Boolean(key.ext)));
  return tokens.join(' ');
}

function windowsInputMessage(action) {
  if (action.type === 'text') {
    return {
      kind: 'text',
      text: Buffer.from(action.text, 'utf8').toString('base64'),
    };
  }

  if (action.type === 'mouse') {
    const { type: _type, ...message } = action;
    return { kind: 'mouse', ...message };
  }

  const line = windowsKeyLine(action);

  if (line === 'lock') {
    return { kind: 'lock' };
  }

  const tokens = line.split(' ');
  return {
    kind: 'keys',
    codes: tokens.map((token) => Number(token.replace(/e$/, ''))),
    extended: tokens.map((token) => token.endsWith('e')),
  };
}

// ponytail: Linux media/hotkeys shell out to playerctl/pactl/xdotool and are
// best-effort; xdotool needs X11 (no Wayland) and missing tools surface as a
// spawn error in the deck status.
function linuxInvocation(action) {
  if (action.type === 'text') {
    const args = [];

    for (const part of action.text.split(/([\n\t])/u)) {
      if (part === '\n' || part === '\t') {
        args.push(
          'key',
          '--clearmodifiers',
          part === '\n' ? 'Return' : 'Tab',
        );
      } else if (part) {
        args.push('type', '--clearmodifiers', '--delay', '1', '--', part);
      }
    }

    return {
      command: 'xdotool',
      args,
    };
  }

  if (action.type === 'mouse') {
    switch (action.operation) {
      case 'click': {
        const button = { left: '1', middle: '2', right: '3' }[action.button];
        return {
          command: 'xdotool',
          args: ['click', '--repeat', String(action.clicks), button],
        };
      }
      case 'move-absolute':
        return {
          command: 'xdotool',
          args: ['mousemove', '--sync', String(action.x), String(action.y)],
        };
      case 'move-relative':
        return {
          command: 'xdotool',
          args: [
            'mousemove_relative',
            '--sync',
            '--',
            String(action.x),
            String(action.y),
          ],
        };
      case 'scroll': {
        const args = [];
        const appendClicks = (delta, positive, negative) => {
          if (delta) {
            args.push(
              'click',
              '--repeat',
              String(Math.abs(delta)),
              delta > 0 ? positive : negative,
            );
          }
        };
        appendClicks(action.vertical, '4', '5');
        appendClicks(action.horizontal, '7', '6');
        return { command: 'xdotool', args };
      }
      default:
        throw new TypeError(`Unknown mouse operation: ${action.operation}`);
    }
  }

  if (action.type === 'media') {
    switch (action.command) {
      case 'mute':
        return { command: 'pactl', args: ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'] };
      case 'volume-up':
        return { command: 'pactl', args: ['set-sink-volume', '@DEFAULT_SINK@', '+5%'] };
      case 'volume-down':
        return { command: 'pactl', args: ['set-sink-volume', '@DEFAULT_SINK@', '-5%'] };
      case 'play-pause':
      case 'next':
      case 'previous':
        return { command: 'playerctl', args: [action.command] };
      default:
        throw new TypeError(`Unknown media command: ${action.command}`);
    }
  }

  const combo = [
    ...hotkeyModifiers(action).map((modifier) => MODIFIER_X[modifier]),
    KEY_TABLE[action.key].x,
  ].join('+');
  return { command: 'xdotool', args: ['key', '--clearmodifiers', combo] };
}

// ponytail: macOS transport keys have no scriptable system control without a
// helper app, so only volume works; hotkeys need the Accessibility permission.
function macInvocation(action) {
  if (action.type === 'text') {
    return {
      command: 'osascript',
      args: [
        '-l',
        'JavaScript',
        '-e',
        MAC_TEXT_SCRIPT,
        '--',
        Buffer.from(action.text, 'utf8').toString('base64'),
      ],
    };
  }

  if (action.type === 'mouse') {
    const args = [action.operation];

    switch (action.operation) {
      case 'click':
        args.push(action.button, String(action.clicks));
        break;
      case 'move-absolute':
      case 'move-relative':
        args.push(String(action.x), String(action.y));
        break;
      case 'scroll':
        args.push(String(action.vertical), String(action.horizontal));
        break;
      default:
        throw new TypeError(`Unknown mouse operation: ${action.operation}`);
    }

    return {
      command: 'osascript',
      args: ['-l', 'JavaScript', '-e', MAC_MOUSE_SCRIPT, '--', ...args],
    };
  }

  if (action.type === 'media') {
    switch (action.command) {
      case 'mute':
        return {
          command: 'osascript',
          args: [
            '-e',
            'set volume output muted (not (output muted of (get volume settings)))',
          ],
        };
      case 'volume-up':
      case 'volume-down': {
        const delta = action.command === 'volume-up' ? 6 : -6;
        return {
          command: 'osascript',
          args: [
            '-e',
            `set volume output volume ((output volume of (get volume settings)) + ${delta})`,
          ],
        };
      }
      case 'play-pause':
      case 'next':
      case 'previous':
        throw new Error('Media transport keys are not supported on macOS.');
      default:
        throw new TypeError(`Unknown media command: ${action.command}`);
    }
  }

  const key = KEY_TABLE[action.key];
  const modifiers = hotkeyModifiers(action).map(
    (modifier) => MODIFIER_MAC[modifier],
  );
  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
  const stroke = key.char
    ? `keystroke "${key.char}"${using}`
    : `key code ${key.mac}${using}`;
  return {
    command: 'osascript',
    args: ['-e', `tell application "System Events" to ${stroke}`],
  };
}

function createActionRunner({
  environment = process.env,
  onEvent = () => {},
  platform = process.platform,
  probeCommand,
  spawnProcess = spawn,
  windowsInputTimeoutMs = WINDOWS_INPUT_TIMEOUT_MS,
} = {}) {
  let keyChild = null;
  let capabilityPromise = null;
  let nextWindowsRequestId = 1;
  const windowsRequests = new Map();

  function defaultProbeCommand(command, args) {
    return new Promise((resolve) => {
      const child = spawnProcess(command, args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    });
  }

  async function getCapabilities() {
    if (platform === 'win32') {
      return {
        text: { available: true, reason: '' },
        mouse: { available: true, reason: '' },
      };
    }

    if (platform === 'darwin') {
      return {
        text: {
          available: true,
          reason: 'Requires macOS Accessibility permission.',
        },
        mouse: {
          available: true,
          reason: 'Requires macOS Accessibility permission.',
        },
      };
    }

    capabilityPromise ||= (async () => {
      if (
        environment.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
        environment.WAYLAND_DISPLAY
      ) {
        const reason =
          'Type Text and Mouse require an X11 session; generic Wayland input is not supported.';
        return {
          text: { available: false, reason },
          mouse: { available: false, reason },
        };
      }

      const probe = probeCommand || defaultProbeCommand;
      const available = await probe('xdotool', ['--version']);
      const reason = available
        ? 'Requires X11 and xdotool.'
        : 'Install xdotool to use Type Text and Mouse actions on X11.';
      return {
        text: { available, reason },
        mouse: { available, reason },
      };
    })();
    return capabilityPromise;
  }

  function failWindowsChild(child, error, kill = false) {
    if (keyChild === child) {
      keyChild = null;
    }

    for (const [id, request] of windowsRequests) {
      if (request.child !== child) {
        continue;
      }

      windowsRequests.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }

    if (kill && !child.killed) {
      child.kill?.();
    }
  }

  function handleWindowsReply(child, line) {
    let reply;

    try {
      reply = JSON.parse(line);
    } catch {
      failWindowsChild(
        child,
        new Error('Windows input process returned an invalid response.'),
        true,
      );
      return;
    }

    if (
      !Number.isSafeInteger(reply?.id) ||
      typeof reply.ok !== 'boolean'
    ) {
      failWindowsChild(
        child,
        new Error('Windows input process returned an invalid response.'),
        true,
      );
      return;
    }

    const request = windowsRequests.get(reply.id);

    if (!request || request.child !== child) {
      return;
    }

    windowsRequests.delete(reply.id);
    clearTimeout(request.timer);

    if (reply.ok) {
      request.resolve();
    } else {
      const detail =
        typeof reply.error === 'string' && reply.error.length <= 512
          ? `: ${reply.error}`
          : '';
      request.reject(new Error(`Windows input failed${detail}`));
    }
  }

  function windowsKeyChild() {
    if (keyChild && keyChild.exitCode === null && !keyChild.killed) {
      return keyChild;
    }

    const child = spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_KEY_SCRIPT],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    let output = '';
    keyChild = child;
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      let newline = output.indexOf('\n');

      while (newline >= 0) {
        const line = output.slice(0, newline).replace(/\r$/, '');
        output = output.slice(newline + 1);

        if (line.length > WINDOWS_REPLY_MAX_LENGTH) {
          failWindowsChild(
            child,
            new Error('Windows input process response exceeded the limit.'),
            true,
          );
          output = '';
          return;
        } else if (line) {
          handleWindowsReply(child, line);
        }

        newline = output.indexOf('\n');
      }

      if (output.length > WINDOWS_REPLY_MAX_LENGTH) {
        failWindowsChild(
          child,
          new Error('Windows input process response exceeded the limit.'),
          true,
        );
        output = '';
      }
    });
    child.stdout?.on('error', () => {
      failWindowsChild(
        child,
        new Error('Windows input process output failed.'),
        true,
      );
    });
    child.stdin?.on?.('error', (error) => {
      failWindowsChild(
        child,
        new Error(`Windows input process write failed: ${error.message}`),
        true,
      );
    });
    child.on('error', (error) => {
      failWindowsChild(
        child,
        new Error(`Windows input process failed: ${error.message}`),
      );
    });
    child.on('exit', (code) => {
      failWindowsChild(
        child,
        new Error(
          `Windows input process exited before replying` +
          `${Number.isInteger(code) ? ` (code ${code})` : ''}.`,
        ),
      );
    });
    return child;
  }

  function runWindowsInput(action) {
    const child = windowsKeyChild();
    const id = nextWindowsRequestId++;

    if (nextWindowsRequestId > Number.MAX_SAFE_INTEGER) {
      nextWindowsRequestId = 1;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!windowsRequests.has(id)) {
          return;
        }

        failWindowsChild(
          child,
          new Error('Windows input process timed out.'),
          true,
        );
      }, windowsInputTimeoutMs);
      windowsRequests.set(id, { child, reject, resolve, timer });

      try {
        child.stdin.write(
          `${JSON.stringify({ id, ...windowsInputMessage(action) })}\n`,
          (error) => {
            if (error) {
              failWindowsChild(
                child,
                new Error(
                  `Windows input process write failed: ${error.message}`,
                ),
                true,
              );
            }
          },
        );
      } catch (error) {
        failWindowsChild(
          child,
          new Error(`Windows input process write failed: ${error.message}`),
          true,
        );
      }
    });
  }

  function runDetached({ command, args }) {
    const child = spawnProcess(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // Missing optional tools (playerctl, xdotool) must not crash the app.
    });
    child.unref();
  }

  function runKeys(action) {
    if (platform === 'win32') {
      return runWindowsInput(action);
    }

    runDetached(platform === 'darwin' ? macInvocation(action) : linuxInvocation(action));
  }

  function runChecked({ command, args }, failureMessage) {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4096);
      });
      child.once('error', (error) => {
        reject(
          error?.code === 'ENOENT'
            ? new Error(`${command} is not installed.`)
            : new Error(failureMessage),
        );
      });
      child.once('exit', (code) => {
        if (code === 0) {
          resolve();
        } else if (
          platform === 'darwin' &&
          /not authorized|accessibility|assistive access|-1743/i.test(stderr)
        ) {
          reject(new Error(MAC_ACCESSIBILITY_ERROR));
        } else {
          reject(
            new Error(
              platform === 'darwin'
                ? `${failureMessage} ${MAC_ACCESSIBILITY_ERROR}`
                : failureMessage,
            ),
          );
        }
      });
    });
  }

  async function executeAction(action) {
    switch (action?.type) {
      case 'media':
      case 'hotkey':
        await runKeys(action);
        return;
      case 'text':
      case 'mouse':
        if (platform === 'win32') {
          await runKeys(action);
          return;
        }

        {
          const capabilities = await getCapabilities();
          const capability = capabilities[action.type];

          if (!capability.available) {
            throw new Error(capability.reason);
          }

          await runChecked(
            platform === 'darwin'
              ? macInvocation(action)
              : linuxInvocation(action),
            action.type === 'text'
              ? 'Type Text input failed.'
              : 'Mouse input failed.',
          );
        }
        return;
      case 'url':
        if (typeof action.url !== 'string' || !URL_PATTERN.test(action.url)) {
          throw new TypeError('Action URL must use http or https.');
        }

        await shell.openExternal(action.url);
        return;
      case 'launch':
        if (typeof action.command !== 'string' || !action.command.trim()) {
          throw new TypeError('Launch command is required.');
        }

        {
          const child = spawn(action.command, {
            detached: true,
            shell: true,
            stdio: 'ignore',
          });
          child.on('error', () => {
            // The command line is user-authored; failures are theirs to fix.
          });
          child.unref();
        }

        return;
      case 'page':
        // Page switches are resolved renderer-side against the device session.
        throw new TypeError('Page actions never reach the main process.');
      default:
        throw new TypeError(`Unknown action type: ${action?.type}`);
    }
  }

  async function runAction(action) {
    try {
      await executeAction(action);
      onEvent('succeeded', { type: action?.type });
    } catch (error) {
      onEvent('failed', { type: action?.type, error });
      throw error;
    }
  }

  function dispose() {
    if (keyChild) {
      failWindowsChild(
        keyChild,
        new Error('Windows input process was stopped.'),
        true,
      );
    }

    keyChild = null;
  }

  return { dispose, getCapabilities, runAction };
}

module.exports = {
  createActionRunner,
  linuxInvocation,
  macInvocation,
  windowsInputMessage,
  windowsKeyLine,
};
