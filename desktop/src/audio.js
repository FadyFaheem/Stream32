// Direct audio control: absolute system volume, mute with an explicit state,
// default-output switching, and per-application volume and mute.
//
// This is deliberately separate from the `media` action. Media sends the
// transport and volume virtual keys, which are fast but relative and cannot
// address a device or an application. These operations need the real mixer, so
// each platform reaches for its own audio stack:
//
//   Windows  CoreAudio COM through a PowerShell child, the same shape as the
//            SendInput child in actions.js.
//   macOS    osascript for the system mixer. Switching the default output has
//            no scriptable system API, so it needs SwitchAudioSource.
//   Linux    pactl, which covers every operation including per-application.
//
// Per-application volume has no public API on macOS at all, so the capability
// probe reports it unavailable there rather than failing at press time.

const { spawn } = require('node:child_process');

const { validateAudioAction } = require('./action-model');

const PER_APP_OPERATIONS = new Set(['app-volume', 'app-mute']);
const AUDIO_TIMEOUT_MS = 5000;
const MAX_AUDIO_OUTPUT_BYTES = 256 * 1024;
const MAX_LISTED_ITEMS = 64;

const MAC_SWITCH_AUDIO_HINT =
  'Switching the default output device on macOS needs SwitchAudioSource. ' +
  'Install it with "brew install switchaudio-osx".';
const MAC_PER_APP_UNAVAILABLE =
  'macOS has no public per-application volume API, so Stream32 cannot set it.';
const LINUX_PACTL_HINT =
  'Audio control on Linux needs pactl from PulseAudio or PipeWire.';

// One PowerShell child compiles this once and then answers JSON lines, so the
// Add-Type cost is paid at most once per session instead of per key press.
const WINDOWS_AUDIO_SCRIPT = `
$ErrorActionPreference = 'Stop'
$definition = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
  [FieldOffset(0)] public short vt;
  [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  int GetDevice(string id, out IMMDevice device);
  int RegisterEndpointNotificationCallback(IntPtr client);
  int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
  int GetCount(out int count);
  int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int context, IntPtr activationParams,
    [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  int OpenPropertyStore(int access, out IPropertyStore store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKey key);
  int GetValue(ref PropertyKey key, out PropVariant value);
  int SetValue(ref PropertyKey key, ref PropVariant value);
  int Commit();
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, ref Guid context);
  int SetMasterVolumeLevelScalar(float level, ref Guid context);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
  int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  int GetChannelVolumeLevel(uint channel, out float level);
  int GetChannelVolumeLevelScalar(uint channel, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr sessionId, int flags, out IntPtr control);
  int GetSimpleAudioVolume(IntPtr sessionId, int flags, out IntPtr volume);
  int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  int RegisterSessionNotification(IntPtr notification);
  int UnregisterSessionNotification(IntPtr notification);
  int RegisterDuckNotification(string sessionId, IntPtr notification);
  int UnregisterDuckNotification(IntPtr notification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  int GetCount(out int count);
  int GetSession(int index, out IAudioSessionControl session);
}

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
  int GetState(out int state);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  int SetDisplayName(string name, ref Guid context);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  int SetIconPath(string path, ref Guid context);
  int GetGroupingParam(out Guid group);
  int SetGroupingParam(ref Guid group, ref Guid context);
  int RegisterAudioSessionNotification(IntPtr notification);
  int UnregisterAudioSessionNotification(IntPtr notification);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  int GetState(out int state);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  int SetDisplayName(string name, ref Guid context);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  int SetIconPath(string path, ref Guid context);
  int GetGroupingParam(out Guid group);
  int SetGroupingParam(ref Guid group, ref Guid context);
  int RegisterAudioSessionNotification(IntPtr notification);
  int UnregisterAudioSessionNotification(IntPtr notification);
  int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetProcessId(out uint processId);
  int IsSystemSoundsSession();
  int SetDuckingPreference(bool optOut);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  int SetMasterVolume(float level, ref Guid context);
  int GetMasterVolume(out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

// Undocumented but stable since Windows 7, and the only way to move the
// default endpoint without a user gesture in the Sound control panel.
[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
public class CPolicyConfigClient { }

[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  int GetMixFormat(string id, out IntPtr format);
  int GetDeviceFormat(string id, bool preferred, out IntPtr format);
  int ResetDeviceFormat(string id);
  int SetDeviceFormat(string id, IntPtr endpointFormat, IntPtr mixFormat);
  int GetProcessingPeriod(string id, bool preferred, out long defaultPeriod, out long minimumPeriod);
  int SetProcessingPeriod(string id, ref long period);
  int GetShareMode(string id, out IntPtr mode);
  int SetShareMode(string id, IntPtr mode);
  int GetPropertyValue(string id, bool store, ref PropertyKey key, out PropVariant value);
  int SetPropertyValue(string id, bool store, ref PropertyKey key, ref PropVariant value);
  int SetDefaultEndpoint(string id, int role);
  int SetEndpointVisibility(string id, bool visible);
}

public static class Audio {
  const int RENDER = 0;
  const int CONSOLE = 0;
  const int ACTIVE = 1;
  const int LOCAL_SERVER = 23;
  static Guid context = Guid.Empty;
  static PropertyKey FriendlyName = new PropertyKey {
    fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
  };

  static IMMDeviceEnumerator Enumerator() {
    return (IMMDeviceEnumerator)(new MMDeviceEnumerator());
  }

  static void Check(int hr) {
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
  }

  static string NameOf(IMMDevice device) {
    IPropertyStore store;
    Check(device.OpenPropertyStore(0, out store));
    PropVariant value;
    Check(store.GetValue(ref FriendlyName, out value));
    return value.pointerValue == IntPtr.Zero
      ? "Unknown device" : Marshal.PtrToStringUni(value.pointerValue);
  }

  static IAudioEndpointVolume EndpointVolume() {
    IMMDevice device;
    Check(Enumerator().GetDefaultAudioEndpoint(RENDER, CONSOLE, out device));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object instance;
    Check(device.Activate(ref iid, LOCAL_SERVER, IntPtr.Zero, out instance));
    return (IAudioEndpointVolume)instance;
  }

  static IAudioSessionEnumerator Sessions() {
    IMMDevice device;
    Check(Enumerator().GetDefaultAudioEndpoint(RENDER, CONSOLE, out device));
    Guid iid = typeof(IAudioSessionManager2).GUID;
    object instance;
    Check(device.Activate(ref iid, LOCAL_SERVER, IntPtr.Zero, out instance));
    IAudioSessionEnumerator sessions;
    Check(((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions));
    return sessions;
  }

  static string ProcessName(uint processId) {
    try {
      return System.Diagnostics.Process.GetProcessById((int)processId).ProcessName;
    } catch {
      return null;
    }
  }

  public static void SetVolume(int percent) {
    Check(EndpointVolume().SetMasterVolumeLevelScalar(percent / 100f, ref context));
  }

  public static void SetMute(string state) {
    IAudioEndpointVolume volume = EndpointVolume();
    bool mute;
    if (state == "toggle") { Check(volume.GetMute(out mute)); mute = !mute; }
    else mute = state == "on";
    Check(volume.SetMute(mute, ref context));
  }

  public static List<string> Devices() {
    IMMDeviceCollection collection;
    Check(Enumerator().EnumAudioEndpoints(RENDER, ACTIVE, out collection));
    int count;
    Check(collection.GetCount(out count));
    var names = new List<string>();
    for (int i = 0; i < count; i++) {
      IMMDevice device;
      Check(collection.Item(i, out device));
      names.Add(NameOf(device));
    }
    return names;
  }

  public static void SetDefaultDevice(string name) {
    IMMDeviceCollection collection;
    Check(Enumerator().EnumAudioEndpoints(RENDER, ACTIVE, out collection));
    int count;
    Check(collection.GetCount(out count));
    for (int i = 0; i < count; i++) {
      IMMDevice device;
      Check(collection.Item(i, out device));
      if (!string.Equals(NameOf(device), name, StringComparison.OrdinalIgnoreCase))
        continue;
      string id;
      Check(device.GetId(out id));
      var policy = (IPolicyConfig)(new CPolicyConfigClient());
      // Console, Multimedia, and Communications, so one press moves every role.
      for (int role = 0; role < 3; role++) Check(policy.SetDefaultEndpoint(id, role));
      return;
    }
    throw new Exception("No active output device is named " + name + ".");
  }

  public static List<string> Apps() {
    IAudioSessionEnumerator sessions = Sessions();
    int count;
    Check(sessions.GetCount(out count));
    var names = new List<string>();
    for (int i = 0; i < count; i++) {
      IAudioSessionControl session;
      Check(sessions.GetSession(i, out session));
      var session2 = (IAudioSessionControl2)session;
      uint processId;
      // Process 0 is the Windows system-sounds session, which resolves to the
      // "Idle" process and is not something a deck key should address.
      if (session2.GetProcessId(out processId) != 0 || processId == 0) continue;
      string name = ProcessName(processId);
      if (name != null && !names.Contains(name)) names.Add(name);
    }
    return names;
  }

  // Every session belonging to the process is updated, because a browser or a
  // game can hold more than one and setting only the first looks like a no-op.
  public static void SetAppVolume(string app, int percent, string muteState) {
    IAudioSessionEnumerator sessions = Sessions();
    int count;
    Check(sessions.GetCount(out count));
    bool matched = false;
    for (int i = 0; i < count; i++) {
      IAudioSessionControl session;
      Check(sessions.GetSession(i, out session));
      var session2 = (IAudioSessionControl2)session;
      uint processId;
      // Process 0 is the Windows system-sounds session, which resolves to the
      // "Idle" process and is not something a deck key should address.
      if (session2.GetProcessId(out processId) != 0 || processId == 0) continue;
      string name = ProcessName(processId);
      if (name == null || !string.Equals(name, app, StringComparison.OrdinalIgnoreCase))
        continue;
      matched = true;
      var volume = (ISimpleAudioVolume)session;
      if (muteState == null) {
        Check(volume.SetMasterVolume(percent / 100f, ref context));
      } else {
        bool mute;
        if (muteState == "toggle") { Check(volume.GetMute(out mute)); mute = !mute; }
        else mute = muteState == "on";
        Check(volume.SetMute(mute, ref context));
      }
    }
    if (!matched) throw new Exception(app + " is not playing audio right now.");
  }
}
'@
Add-Type -TypeDefinition $definition
while ($line = [Console]::In.ReadLine()) {
  $id = $null
  try {
    $message = $line | ConvertFrom-Json
    $id = [long]$message.id
    $data = $null
    switch ($message.kind) {
      'set-volume' { [Audio]::SetVolume([int]$message.level) }
      'mute' { [Audio]::SetMute([string]$message.state) }
      'set-output-device' { [Audio]::SetDefaultDevice([string]$message.device) }
      'app-volume' { [Audio]::SetAppVolume([string]$message.app, [int]$message.level, $null) }
      'app-mute' { [Audio]::SetAppVolume([string]$message.app, 0, [string]$message.state) }
      'list-devices' { $data = @([Audio]::Devices()) }
      'list-apps' { $data = @([Audio]::Apps()) }
      default { throw "unknown audio kind" }
    }
    $reply = @{ id = $id; ok = $true; data = $data }
  } catch {
    $reply = @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 3))
}
`;

function windowsAudioMessage(action) {
  const { type: _type, operation, ...rest } = action;
  return { kind: operation, ...rest };
}

function macAudioInvocation(action) {
  switch (action.operation) {
    case 'set-volume':
      return {
        command: 'osascript',
        args: ['-e', `set volume output volume ${action.level}`],
      };
    case 'mute':
      return {
        command: 'osascript',
        args: [
          '-e',
          action.state === 'toggle'
            ? 'set volume output muted (not (output muted of (get volume settings)))'
            : `set volume output muted ${action.state === 'on'}`,
        ],
      };
    case 'set-output-device':
      return {
        command: 'SwitchAudioSource',
        args: ['-t', 'output', '-s', action.device],
      };
    default:
      throw new Error(MAC_PER_APP_UNAVAILABLE);
  }
}

function linuxAudioInvocation(action) {
  switch (action.operation) {
    case 'set-volume':
      return {
        command: 'pactl',
        args: ['set-sink-volume', '@DEFAULT_SINK@', `${action.level}%`],
      };
    case 'mute':
      return {
        command: 'pactl',
        args: [
          'set-sink-mute',
          '@DEFAULT_SINK@',
          action.state === 'toggle' ? 'toggle' : action.state === 'on' ? '1' : '0',
        ],
      };
    case 'set-output-device':
      return {
        command: 'pactl',
        args: ['set-default-sink', action.device],
      };
    default:
      throw new TypeError(`Unknown audio operation: ${action.operation}`);
  }
}

// PulseAudio addresses a playing application by sink-input index, and those
// indexes change every time the stream restarts, so the name has to be resolved
// immediately before the volume is set.
function linuxSinkInputInvocation(action, index) {
  return action.operation === 'app-volume'
    ? {
      command: 'pactl',
      args: ['set-sink-input-volume', String(index), `${action.level}%`],
    }
    : {
      command: 'pactl',
      args: [
        'set-sink-input-mute',
        String(index),
        action.state === 'toggle' ? 'toggle' : action.state === 'on' ? '1' : '0',
      ],
    };
}

function sinkInputName(properties) {
  return (
    properties?.['application.name'] ||
    properties?.['application.process.binary'] ||
    ''
  );
}

function matchesApp(name, app) {
  const candidate = String(name).toLowerCase();
  const wanted = app.toLowerCase();
  // A pactl name is a display name ("Firefox") while a Windows session is a
  // process name ("firefox"), so a saved key stays portable across platforms.
  return (
    candidate === wanted ||
    candidate === wanted.replace(/\.exe$/, '') ||
    candidate.replace(/\.exe$/, '') === wanted.replace(/\.exe$/, '')
  );
}

function findSinkInputs(sinkInputs, app) {
  if (!Array.isArray(sinkInputs)) {
    return [];
  }

  return sinkInputs
    .filter((input) => matchesApp(sinkInputName(input?.properties), app))
    .map((input) => input.index)
    .filter((index) => Number.isInteger(index));
}

function createAudioController({
  platform = process.platform,
  spawnProcess,
  timeoutMs = AUDIO_TIMEOUT_MS,
} = {}) {
  const spawnChild = spawnProcess || spawn;
  let capabilityPromise = null;
  let audioChild = null;
  let nextRequestId = 1;
  const requests = new Map();

  function runCapture({ command, args }) {
    return new Promise((resolve, reject) => {
      const child = spawnChild(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill?.();
        reject(new Error(`${command} timed out.`));
      }, timeoutMs);
      const finish = (error, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      child.stdout?.on('data', (chunk) => {
        stdout = `${stdout}${chunk}`;

        if (stdout.length > MAX_AUDIO_OUTPUT_BYTES) {
          child.kill?.();
          finish(new Error(`${command} produced too much output.`));
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4096);
      });
      child.once('error', (error) => {
        finish(
          error?.code === 'ENOENT'
            ? new Error(
              command === 'pactl'
                ? LINUX_PACTL_HINT
                : command === 'SwitchAudioSource'
                  ? MAC_SWITCH_AUDIO_HINT
                  : `${command} is not installed.`,
            )
            : error,
        );
      });
      child.once('exit', (code) => {
        if (code === 0) {
          finish(null, stdout);
          return;
        }

        const detail = stderr.trim().split('\n').pop();
        finish(
          new Error(
            detail ? `${command} failed: ${detail}` : `${command} failed.`,
          ),
        );
      });
    });
  }

  function failWindowsChild(child, error, kill = false) {
    if (audioChild === child) {
      audioChild = null;
    }

    for (const [id, request] of requests) {
      if (request.child !== child) {
        continue;
      }

      requests.delete(id);
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
        new Error('Audio process returned an invalid response.'),
        true,
      );
      return;
    }

    if (!Number.isSafeInteger(reply?.id) || typeof reply.ok !== 'boolean') {
      failWindowsChild(
        child,
        new Error('Audio process returned an invalid response.'),
        true,
      );
      return;
    }

    const request = requests.get(reply.id);

    if (!request || request.child !== child) {
      return;
    }

    requests.delete(reply.id);
    clearTimeout(request.timer);

    if (reply.ok) {
      request.resolve(reply.data ?? null);
    } else {
      const detail =
        typeof reply.error === 'string' && reply.error.length <= 512
          ? `: ${reply.error}`
          : '';
      request.reject(new Error(`Audio control failed${detail}`));
    }
  }

  function windowsAudioChild() {
    if (audioChild && audioChild.exitCode === null && !audioChild.killed) {
      return audioChild;
    }

    const child = spawnChild(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_AUDIO_SCRIPT],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    let output = '';
    audioChild = child;
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      let newline = output.indexOf('\n');

      while (newline >= 0) {
        const line = output.slice(0, newline).replace(/\r$/, '');
        output = output.slice(newline + 1);

        if (line) {
          handleWindowsReply(child, line);
        }

        newline = output.indexOf('\n');
      }

      if (output.length > MAX_AUDIO_OUTPUT_BYTES) {
        failWindowsChild(
          child,
          new Error('Audio process response exceeded the limit.'),
          true,
        );
        output = '';
      }
    });
    child.on('error', (error) => {
      failWindowsChild(child, new Error(`Audio process failed: ${error.message}`));
    });
    child.on('exit', (code) => {
      failWindowsChild(
        child,
        new Error(
          'Audio process exited before replying' +
          `${Number.isInteger(code) ? ` (code ${code})` : ''}.`,
        ),
      );
    });
    return child;
  }

  function requestWindows(message) {
    const child = windowsAudioChild();
    const id = nextRequestId++;

    if (nextRequestId > Number.MAX_SAFE_INTEGER) {
      nextRequestId = 1;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!requests.has(id)) {
          return;
        }

        failWindowsChild(child, new Error('Audio control timed out.'), true);
      }, timeoutMs);
      requests.set(id, { child, reject, resolve, timer });

      try {
        child.stdin.write(`${JSON.stringify({ id, ...message })}\n`, (error) => {
          if (error) {
            failWindowsChild(
              child,
              new Error(`Audio process write failed: ${error.message}`),
              true,
            );
          }
        });
      } catch (error) {
        failWindowsChild(
          child,
          new Error(`Audio process write failed: ${error.message}`),
          true,
        );
      }
    });
  }

  async function pactlJson(kind) {
    const output = await runCapture({
      command: 'pactl',
      args: ['-f', 'json', 'list', kind],
    });

    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`pactl returned an unreadable ${kind} list.`);
    }
  }

  async function getCapabilities() {
    capabilityPromise ||= (async () => {
      if (platform === 'win32') {
        return {
          system: { available: true, reason: '' },
          device: { available: true, reason: '' },
          perApp: { available: true, reason: '' },
        };
      }

      if (platform === 'darwin') {
        let switcher = true;

        try {
          await runCapture({ command: 'SwitchAudioSource', args: ['-c'] });
        } catch {
          switcher = false;
        }

        return {
          system: { available: true, reason: '' },
          device: {
            available: switcher,
            reason: switcher ? '' : MAC_SWITCH_AUDIO_HINT,
          },
          perApp: { available: false, reason: MAC_PER_APP_UNAVAILABLE },
        };
      }

      let pactl = true;

      try {
        await runCapture({ command: 'pactl', args: ['--version'] });
      } catch {
        pactl = false;
      }

      const reason = pactl ? '' : LINUX_PACTL_HINT;
      return {
        system: { available: pactl, reason },
        device: { available: pactl, reason },
        perApp: { available: pactl, reason },
      };
    })();
    return capabilityPromise;
  }

  async function requireCapability(operation) {
    const capabilities = await getCapabilities();
    const capability = PER_APP_OPERATIONS.has(operation)
      ? capabilities.perApp
      : operation === 'set-output-device'
        ? capabilities.device
        : capabilities.system;

    if (!capability.available) {
      throw new Error(capability.reason);
    }
  }

  async function listOutputDevices() {
    await requireCapability('set-output-device');

    if (platform === 'win32') {
      const devices = await requestWindows({ kind: 'list-devices' });
      return (devices || []).slice(0, MAX_LISTED_ITEMS);
    }

    if (platform === 'darwin') {
      const output = await runCapture({
        command: 'SwitchAudioSource',
        args: ['-a', '-t', 'output'],
      });
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_LISTED_ITEMS);
    }

    const sinks = await pactlJson('sinks');
    return (Array.isArray(sinks) ? sinks : [])
      .map((sink) => sink?.name)
      .filter((name) => typeof name === 'string' && name)
      .slice(0, MAX_LISTED_ITEMS);
  }

  // Only applications currently holding an audio session can be listed, which
  // is why the editor offers this as a suggestion rather than a closed list.
  async function listApps() {
    await requireCapability('app-volume');

    if (platform === 'win32') {
      const apps = await requestWindows({ kind: 'list-apps' });
      return (apps || []).slice(0, MAX_LISTED_ITEMS);
    }

    const inputs = await pactlJson('sink-inputs');
    const names = new Set();

    for (const input of Array.isArray(inputs) ? inputs : []) {
      const name = sinkInputName(input?.properties);

      if (name) {
        names.add(name);
      }
    }

    return [...names].slice(0, MAX_LISTED_ITEMS);
  }

  async function apply(rawAction) {
    const action = validateAudioAction(rawAction);
    await requireCapability(action.operation);

    if (platform === 'win32') {
      await requestWindows(windowsAudioMessage(action));
      return;
    }

    if (platform === 'darwin') {
      await runCapture(macAudioInvocation(action));
      return;
    }

    if (!PER_APP_OPERATIONS.has(action.operation)) {
      await runCapture(linuxAudioInvocation(action));
      return;
    }

    const inputs = await pactlJson('sink-inputs');
    const indexes = findSinkInputs(inputs, action.app);

    if (indexes.length === 0) {
      throw new Error(`${action.app} is not playing audio right now.`);
    }

    for (const index of indexes) {
      await runCapture(linuxSinkInputInvocation(action, index));
    }
  }

  function dispose() {
    if (audioChild) {
      failWindowsChild(
        audioChild,
        new Error('Audio process was stopped.'),
        true,
      );
    }

    audioChild = null;
  }

  return { apply, dispose, getCapabilities, listApps, listOutputDevices };
}

module.exports = {
  createAudioController,
  findSinkInputs,
  linuxAudioInvocation,
  linuxSinkInputInvocation,
  macAudioInvocation,
  matchesApp,
  windowsAudioMessage,
};
