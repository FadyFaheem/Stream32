const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runStatusCommand } = require('../src/status-command');

// `exit <n>` is one of the few command lines both sh and cmd.exe agree on, so
// these run unchanged on all three platforms the app is packaged for.
test('the exit code is the answer, failures included', async () => {
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

  // Whether the shell died by signal or taskkill's ordinary exit, a killed
  // command has no code to map to an appearance.
  assert.deepEqual(result, { code: null });
  assert.ok(
    Date.now() - started < 30_000,
    'the command outlived its timeout',
  );
});

test('the timeout takes the whole command, not just its shell', async (t) => {
  // `sh -c` forks for anything but the simplest line and cmd.exe forks for
  // everything, so killing the shell alone leaves the real command running.
  const marker = `stream32-probe-${process.pid}`;
  // Backgrounded so the shell is a parent rather than being replaced by the
  // command, which is the shape that leaves a survivor. The marker is an
  // ignored argument, there only to be findable in the process list.
  const sleeper = `node -e "setTimeout(()=>{},60000)" ${marker} & wait`;

  await runStatusCommand(sleeper, { timeoutMs: 250 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const listing = process.platform === 'win32'
    ? execFileSync('tasklist', [], { encoding: 'utf8' })
    : execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });

  // tasklist reports images rather than command lines, so the marker only
  // proves anything on POSIX; there the survivor would be plainly visible.
  if (process.platform === 'win32') {
    t.diagnostic('process tree kill is checked by hand on Windows');
    return;
  }

  const survived = listing.includes(marker);

  if (survived) {
    // Do not leave a minute of stray node behind for the next test file.
    execFileSync('pkill', ['-f', marker], { stdio: 'ignore' });
  }

  assert.ok(!survived, 'the command outlived the shell it was started from');
});

test('a command that cannot be a command is refused before spawning', () => {
  for (const command of ['', '   ', undefined, 42, 'x'.repeat(1025)]) {
    assert.throws(() => runStatusCommand(command), /Status command is invalid/);
  }
});
