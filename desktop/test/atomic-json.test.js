const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  backupPathFor,
  readJsonRecovering,
  writeJsonAtomic,
} = require('../src/atomic-json');

test('recovers a corrupt primary from the previous-good JSON backup', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-atomic-'));
  const filePath = path.join(directory, 'state.json');

  try {
    writeJsonAtomic({ version: 1 }, filePath);
    writeJsonAtomic({ version: 2 }, filePath);
    assert.deepEqual(JSON.parse(readFileSync(backupPathFor(filePath), 'utf8')), {
      version: 1,
    });

    writeFileSync(filePath, '{"broken":');
    assert.deepEqual(
      readJsonRecovering(filePath, {
        validate(value) {
          assert.equal(typeof value.version, 'number');
          return value;
        },
      }),
      { version: 1 },
    );
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
      version: 1,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('uses a fallback only when primary and backup are unusable', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-atomic-'));
  const filePath = path.join(directory, 'state.json');

  try {
    writeFileSync(filePath, 'nope');
    writeFileSync(backupPathFor(filePath), 'also nope');
    assert.deepEqual(readJsonRecovering(filePath, { fallback: {} }), {});
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
