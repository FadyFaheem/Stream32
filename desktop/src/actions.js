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

// Runs inside one persistent PowerShell child. Each stdin line is a
// space-separated press sequence of "<vk>" or "<vk>e" (extended) tokens;
// keys go down in order and up in reverse, like a human chord.
const WINDOWS_KEY_SCRIPT = `
$definition = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);'
Add-Type -Namespace Stream32 -Name Keys -MemberDefinition $definition
while ($line = [Console]::In.ReadLine()) {
  $tokens = $line.Trim().Split(' ') | Where-Object { $_ }
  $codes = @()
  foreach ($token in $tokens) {
    $extended = $token.EndsWith('e')
    $codes += ,@([byte]$token.TrimEnd('e'), $extended)
  }
  foreach ($code in $codes) {
    [Stream32.Keys]::keybd_event($code[0], 0, $(if ($code[1]) { 1 } else { 0 }), [UIntPtr]::Zero)
  }
  [array]::Reverse($codes)
  foreach ($code in $codes) {
    [Stream32.Keys]::keybd_event($code[0], 0, $(if ($code[1]) { 3 } else { 2 }), [UIntPtr]::Zero)
  }
}
`;

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

  const key = KEY_TABLE[action.key];
  const tokens = hotkeyModifiers(action).map((modifier) =>
    vkToken(MODIFIER_VK[modifier], false),
  );

  tokens.push(vkToken(key.vk, Boolean(key.ext)));
  return tokens.join(' ');
}

// ponytail: Linux media/hotkeys shell out to playerctl/pactl/xdotool and are
// best-effort; xdotool needs X11 (no Wayland) and missing tools surface as a
// spawn error in the deck status.
function linuxInvocation(action) {
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

function createActionRunner({ platform = process.platform } = {}) {
  let keyChild = null;

  function windowsKeyChild() {
    if (keyChild && keyChild.exitCode === null && !keyChild.killed) {
      return keyChild;
    }

    keyChild = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_KEY_SCRIPT],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
    );
    keyChild.on('error', () => {
      keyChild = null;
    });
    keyChild.on('exit', () => {
      keyChild = null;
    });
    return keyChild;
  }

  function runDetached({ command, args }) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Missing optional tools (playerctl, xdotool) must not crash the app.
    });
    child.unref();
  }

  function runKeys(action) {
    if (platform === 'win32') {
      windowsKeyChild().stdin.write(`${windowsKeyLine(action)}\n`);
      return;
    }

    runDetached(platform === 'darwin' ? macInvocation(action) : linuxInvocation(action));
  }

  async function runAction(action) {
    switch (action?.type) {
      case 'media':
      case 'hotkey':
        runKeys(action);
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

  function dispose() {
    keyChild?.kill();
    keyChild = null;
  }

  return { dispose, runAction };
}

module.exports = {
  createActionRunner,
  linuxInvocation,
  macInvocation,
  windowsKeyLine,
};
