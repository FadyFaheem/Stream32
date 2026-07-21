const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readSettings,
  updateSettings,
  writeSettings,
} = require('../src/settings');

test('settings updates preserve unrelated preferences', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-settings-'));
  const settingsPath = path.join(directory, 'settings.json');

  try {
    writeSettings({ startOnLogin: true }, settingsPath);
    updateSettings(
      {
        serialDevice: {
          productId: '1001',
          serialNumber: 'aabbccddeeff',
          vendorId: '303a',
        },
      },
      settingsPath,
    );

    assert.deepEqual(readSettings(settingsPath), {
      serialDevice: {
        productId: '1001',
        serialNumber: 'aabbccddeeff',
        vendorId: '303a',
      },
      startOnLogin: true,
    });
    assert.match(readFileSync(settingsPath, 'utf8'), /\n$/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('invalid settings files fall back to an empty object', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-settings-'));
  const settingsPath = path.join(directory, 'settings.json');

  try {
    writeSettings([], settingsPath);
    assert.deepEqual(readSettings(settingsPath), {});
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
