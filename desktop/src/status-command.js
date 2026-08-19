// Runs a user-authored command purely for its exit code. Unlike the Launch
// action this is polled, so nothing here may hang, pile up, or grow a buffer.
// Kept free of Electron imports so it runs under `node --test`.
const { spawn } = require('node:child_process');

const MAX_COMMAND_LENGTH = 1024;
const STATUS_COMMAND_TIMEOUT_MS = 5000;

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
    // ponytail: the timeout kills the shell, which is the command itself for
    // the simple `tool --status` case this exists for. A compound command line
    // can leave a grandchild behind, bounded at one per timeout because a key
    // never runs two at once. Upgrade path is a process group on POSIX and
    // taskkill /T on Windows, if a hanging pipeline ever shows up in practice.
    const child = spawn(command, {
      shell: true,
      stdio: 'ignore',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });

    // A command that could not start and one killed for hanging are the same
    // answer here: no exit code, so the key shows its saved appearance.
    child.on('error', () => resolve({ code: null }));
    child.on('close', (code, signal) =>
      resolve({ code: signal ? null : code }),
    );
  });
}

module.exports = {
  MAX_COMMAND_LENGTH,
  STATUS_COMMAND_TIMEOUT_MS,
  runStatusCommand,
};
