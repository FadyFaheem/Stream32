const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runStatusCommand, runStatusJsonCommand } = require('../src/status-command');

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
    assert.throws(() => runStatusJsonCommand(command), /Status command is invalid/);
  }
});

// Inner single quotes keep the payload readable on both sh and cmd.exe, which
// each group the -e argument in double quotes.
test('a JSON command answers with its stdout', async () => {
  assert.deepEqual(
    await runStatusJsonCommand(
      'node -e "process.stdout.write(JSON.stringify({label:\'Hi\'}))"',
    ),
    { output: '{"label":"Hi"}' },
  );

  // A non-zero exit code makes the whole output worthless, whatever it said.
  assert.deepEqual(
    await runStatusJsonCommand(
      'node -e "process.stdout.write(\'{"label":"Hi"}\');process.exit(3)"',
    ),
    { output: null },
  );
});

test('a JSON command that talks past the cap is stopped and reports nothing', async () => {
  // Forty kilobytes from a command that exits 0 proves the overflow guard,
  // not the exit code, is what discards the answer.
  assert.deepEqual(
    await runStatusJsonCommand(
      'node -e "process.stdout.write(\'a\'.repeat(40000))"',
    ),
    { output: null },
  );
});

test('a JSON answer big enough to carry an inline image still arrives', async () => {
  // The cap has room for the largest inline image the schema allows. A real
  // command prints this from a script file rather than an inline -e payload
  // (the command line itself is bounded at 1024 chars), so this writes one.
  const { writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const script = join(tmpdir(), `stream32-json-image-${process.pid}.js`);
  const payload = `{"image":"data:image/webp;base64,${'A'.repeat(20 * 1024)}"}`;
  writeFileSync(script, `process.stdout.write(${JSON.stringify(payload)})`);

  try {
    assert.equal(
      (await runStatusJsonCommand(`node "${script}"`)).output,
      payload,
    );
  } finally {
    rmSync(script, { force: true });
  }
});

test('a hanging JSON command is killed and reports no output', async () => {
  const started = Date.now();
  const result = await runStatusJsonCommand(
    'node -e "setTimeout(() => {}, 60000)"',
    { timeoutMs: 250 },
  );

  assert.deepEqual(result, { output: null });
  assert.ok(
    Date.now() - started < 30_000,
    'the command outlived its timeout',
  );
});
