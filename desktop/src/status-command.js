// Runs a user-authored command purely for its exit code. Unlike the Launch
// action this is polled, so nothing here may hang, pile up, grow a buffer, or
// put anything on screen. Kept free of Electron imports so it runs under
// `node --test`.
const { spawn } = require('node:child_process');

const MAX_COMMAND_LENGTH = 1024;
const STATUS_COMMAND_TIMEOUT_MS = 5000;

// Killing the shell does not kill what the shell started: `sh -c` forks for
// anything but the simplest line, and cmd.exe starts even a single command as
// its own child, so on Windows this is the normal case rather than an edge.
// A process group on POSIX and taskkill's tree walk on Windows each take the
// whole command with them.
function killTree(child) {
  if (process.platform === 'win32') {
    const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    kill.on('error', () => {
      // Nothing left to try, and the poll has already given up on this run.
    });
    return;
  }

  try {
    // Negative pid is the group, which detached below made this child lead.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone, which is the outcome being asked for.
  }
}

// A status command answers with its exit code and nothing else, so both pipes
// are ignored: a chatty command cannot fill a buffer nobody drains, and no
// user output ever reaches the log.
function runStatusCommand(
  command,
  { timeoutMs = STATUS_COMMAND_TIMEOUT_MS } = {},
) {
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > MAX_COMMAND_LENGTH
  ) {
    throw new TypeError('Status command is invalid.');
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'ignore',
      // Its own process group, so killTree can reach the whole command. Not on
      // Windows, where detaching would give the child its own console window.
      detached: process.platform !== 'win32',
      // Stream32 is a GUI app, so cmd.exe would otherwise flash a console
      // window on screen every time a key polls.
      windowsHide: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();

    const finish = (result) => {
      clearTimeout(timer);
      resolve(result);
    };

    // A command that could not start and one killed for hanging are the same
    // answer here: no exit code, so the key shows its saved appearance. The
    // flag is what tells them apart from a real code, since taskkill leaves an
    // ordinary non-zero exit rather than a signal.
    child.on('error', () => finish({ code: null }));
    child.on('close', (code, signal) =>
      finish({ code: signal || timedOut ? null : code }),
    );
  });
}

module.exports = {
  MAX_COMMAND_LENGTH,
  STATUS_COMMAND_TIMEOUT_MS,
  runStatusCommand,
};
