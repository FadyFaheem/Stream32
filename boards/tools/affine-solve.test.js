const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPONENT = path.join(
  ROOT,
  'boards',
  'common',
  'components',
  'stream32_deck',
);

function findCompiler() {
  for (const compiler of ['cc', 'gcc', 'clang']) {
    const probe = spawnSync(compiler, ['--version'], { stdio: 'ignore' });

    if (probe.status === 0) {
      return compiler;
    }
  }

  return null;
}

// The solve is the one piece of arithmetic in the firmware whose failure mode
// is silent: a wrong transform just makes touch feel slightly off. Compiling
// it for the host is the only way to actually exercise it.
test('the touch calibration solve recovers known panel wirings', (t) => {
  const compiler = findCompiler();

  if (!compiler) {
    t.skip('No host C compiler available.');
    return;
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-affine-'));
  const binary = path.join(
    directory,
    process.platform === 'win32' ? 'selfcheck.exe' : 'selfcheck',
  );

  try {
    execFileSync(
      compiler,
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        `-I${COMPONENT}`,
        path.join(COMPONENT, 'deck_affine.c'),
        path.join(__dirname, 'affine-selfcheck.c'),
        '-o',
        binary,
        '-lm',
      ],
      { stdio: 'pipe' },
    );

    const output = execFileSync(binary, { encoding: 'utf8' });

    // Named so a regression names the wiring it broke rather than just
    // reporting a non-zero exit.
    for (const expected of [
      'ok plain panel',
      'ok swapped axes',
      'ok mirrored axes',
      'ok skewed glass',
      'ok collinear taps rejected',
      'ok repeated tap rejected',
    ]) {
      assert.match(output, new RegExp(`^${expected}$`, 'm'));
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
