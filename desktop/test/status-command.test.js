const assert = require('node:assert/strict');
const test = require('node:test');

const { runStatusCommand } = require('../src/status-command');

// `exit <n>` is one of the few command lines both sh and cmd.exe agree on, so
// these run unchanged on all three platforms the app is packaged for.
test('the exit code is the answer, including the ones that mean failure', async () => {
  assert.deepEqual(await runStatusCommand('exit 0'), { code: 0 });
  assert.deepEqual(await runStatusCommand('exit 2'), { code: 2 });

  // A missing command is a non-zero code rather than a thrown error: the key
  // shows an unmatched state instead of the poll loop having to catch.
  const missing = await runStatusCommand('stream32-no-such-command-exists');
  assert.equal(typeof missing.code, 'number');
  assert.notEqual(missing.code, 0);
});

test('a hanging command is killed and reports no code', async () => {
  const started = Date.now();
  const result = await runStatusCommand(
    'node -e "setTimeout(() => {}, 60000)"',
    { timeoutMs: 250 },
  );

  // Killed by signal, so there is no exit code to map to an appearance.
  assert.deepEqual(result, { code: null });
  assert.ok(
    Date.now() - started < 30_000,
    'the command outlived its timeout',
  );
});

test('a command that cannot be a command is refused before spawning', () => {
  for (const command of ['', '   ', undefined, 42, 'x'.repeat(1025)]) {
    assert.throws(() => runStatusCommand(command), /Status command is invalid/);
  }
});
