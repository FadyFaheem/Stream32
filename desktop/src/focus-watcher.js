const { execFile } = require('node:child_process');
const { readFile } = require('node:fs/promises');

const { validateFocusSnapshot } = require('./profile-rules');

const POLL_INTERVAL_MS = 750;
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024;
const WINDOWS_FOCUS_SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Stream32Focus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$pidValue = 0
$window = [Stream32Focus]::GetForegroundWindow()
[void][Stream32Focus]::GetWindowThreadProcessId($window, [ref]$pidValue)
if ($pidValue -gt 0) {
  $process = Get-Process -Id $pidValue -ErrorAction Stop
  $executablePath = $null
  try { $executablePath = $process.MainModule.FileName } catch {}
  [pscustomobject]@{
    processId = [int]$pidValue
    processName = $process.ProcessName
    executablePath = $executablePath
  } | ConvertTo-Json -Compress
}
`;
const MACOS_FOCUS_SCRIPT = `
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set processName to name of frontProcess
  set processId to unix id of frontProcess
  try
    set bundleId to bundle identifier of frontProcess
  on error
    set bundleId to ""
  end try
end tell
return (processId as text) & linefeed & bundleId & linefeed & processName
`;

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.probeStderr = stderr;
          reject(error);
          return;
        }

        resolve(stdout.trim());
      },
    );
  });
}

function normalizeWindowsPath(value) {
  return value.replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase();
}

async function probeWindows(run = execFileText) {
  const text = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_FOCUS_SCRIPT,
  ]);

  if (!text) {
    return null;
  }

  const result = JSON.parse(text);
  const executable = result.executablePath ||
    `${String(result.processName || '').replace(/\.exe$/i, '')}.exe`;

  if (!Number.isSafeInteger(result.processId) || !executable) {
    throw new Error('Windows did not return a focused application identity.');
  }

  return {
    platform: 'win32',
    processId: result.processId,
    identities: [{
      kind: 'executable',
      value: normalizeWindowsPath(executable),
    }],
  };
}

async function probeMacos(run = execFileText) {
  const text = await run('osascript', ['-e', MACOS_FOCUS_SCRIPT]);
  const [processIdText, bundleId, processName] = text.split(/\r?\n/, 3);
  const processId = Number(processIdText);
  const identities = [];

  if (bundleId) {
    identities.push({ kind: 'bundleId', value: bundleId });
  }

  if (processName) {
    identities.push({ kind: 'processName', value: processName });
  }

  if (!Number.isSafeInteger(processId) || identities.length === 0) {
    throw new Error('macOS did not return a focused application identity.');
  }

  return { platform: 'darwin', processId, identities };
}

async function probeLinux(run = execFileText, read = readFile) {
  const windowId = await run('xdotool', ['getwindowfocus']);
  const [processIdText, wmClass] = await Promise.all([
    run('xdotool', ['getwindowpid', windowId]),
    run('xdotool', ['getwindowclassname', windowId]),
  ]);
  const processId = Number(processIdText);
  let processName = '';

  if (Number.isSafeInteger(processId) && processId > 0) {
    try {
      processName = (await read(`/proc/${processId}/comm`, 'utf8')).trim();
    } catch {
      // WM_CLASS remains a stable X11 identity when /proc is restricted.
    }
  }

  const identities = [];

  if (wmClass) {
    identities.push({ kind: 'wmClass', value: wmClass });
  }

  if (processName) {
    identities.push({ kind: 'processName', value: processName });
  }

  if (!Number.isSafeInteger(processId) || identities.length === 0) {
    throw new Error('X11 did not return a focused application identity.');
  }

  return { platform: 'linux', processId, identities };
}

function platformCapability(platform, environment = process.env) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    return {
      supported: false,
      reason: `Focused-app switching is not supported on ${platform}.`,
    };
  }

  if (
    platform === 'linux' &&
    (
      String(environment.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
      (environment.WAYLAND_DISPLAY && !environment.DISPLAY)
    )
  ) {
    return {
      supported: false,
      reason:
        'Automatic app switching is unavailable on Wayland; manual profile switching still works.',
    };
  }

  return { supported: true, reason: null };
}

function createPlatformProbe(platform) {
  switch (platform) {
    case 'win32':
      return probeWindows;
    case 'darwin':
      return probeMacos;
    case 'linux':
      return probeLinux;
    default:
      return async () => null;
  }
}

function focusIdentityKey(snapshot) {
  return JSON.stringify({
    platform: snapshot.platform,
    identities: snapshot.identities,
  });
}

function focusErrorReason(platform, error) {
  if (platform === 'linux' && error?.code === 'ENOENT') {
    return 'Automatic app switching needs xdotool on X11; manual profile switching still works.';
  }

  if (platform === 'darwin') {
    return (
      'Stream32 cannot read the focused macOS app. Allow Automation access to ' +
      'System Events, or keep switching profiles manually.'
    );
  }

  return `Could not read the focused application: ${error?.message || String(error)}`;
}

class FocusWatcher {
  constructor({
    platform = process.platform,
    environment = process.env,
    probe = createPlatformProbe(platform),
    isOwnSnapshot = (snapshot) => snapshot?.processId === process.pid,
    onChange = () => {},
    onStatus = () => {},
    pollIntervalMs = POLL_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.platform = platform;
    this.capability = platformCapability(platform, environment);
    this.probe = probe;
    this.isOwnSnapshot = isOwnSnapshot;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.running = false;
    this.polling = false;
    this.lastIdentityKey = null;
    this.snapshot = null;
    this.status = {
      platform,
      supported: this.capability.supported,
      running: false,
      state: this.capability.supported ? 'stopped' : 'unsupported',
      reason: this.capability.reason,
      editorFocused: false,
    };
  }

  emitStatus(next) {
    const status = { ...this.status, ...next };

    if (JSON.stringify(status) === JSON.stringify(this.status)) {
      return;
    }

    this.status = status;
    this.onStatus({ ...status });
  }

  start() {
    if (this.running || !this.capability.supported) {
      this.onStatus({ ...this.status });
      return;
    }

    this.running = true;
    this.emitStatus({
      running: true,
      state: 'watching',
      reason: null,
    });
    this.poll();
    this.timer = this.setIntervalFn(() => this.poll(), this.pollIntervalMs);
    this.timer?.unref?.();
  }

  async poll() {
    if (!this.running || this.polling) {
      return;
    }

    this.polling = true;

    try {
      const rawSnapshot = await this.probe();
      const snapshot = rawSnapshot
        ? validateFocusSnapshot(rawSnapshot)
        : null;

      if (!this.running) {
        return;
      }

      const editorFocused = Boolean(snapshot && this.isOwnSnapshot(snapshot));
      this.emitStatus({
        running: true,
        state: 'watching',
        reason: null,
        editorFocused,
      });

      if (editorFocused) {
        this.lastIdentityKey = null;
        return;
      }

      if (!snapshot) {
        return;
      }

      const key = focusIdentityKey(snapshot);
      this.snapshot = snapshot;

      if (key !== this.lastIdentityKey) {
        this.lastIdentityKey = key;
        this.onChange(snapshot);
      }
    } catch (error) {
      if (this.running) {
        this.emitStatus({
          running: true,
          state: 'error',
          reason: focusErrorReason(this.platform, error),
        });
      }
    } finally {
      this.polling = false;
    }
  }

  stop() {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.emitStatus({
      running: false,
      state: 'stopped',
      reason: null,
      editorFocused: false,
    });
  }

  getSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  getStatus() {
    return { ...this.status };
  }
}

function createFocusWatcher(options) {
  return new FocusWatcher(options);
}

module.exports = {
  FocusWatcher,
  POLL_INTERVAL_MS,
  createFocusWatcher,
  focusIdentityKey,
  platformCapability,
  probeLinux,
  probeMacos,
  probeWindows,
};
