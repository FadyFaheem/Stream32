const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getDisplaySettings,
  readSettings,
  setDisplaySettings,
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

test('display settings have safe defaults and persist validated changes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-settings-'));
  const settingsPath = path.join(directory, 'settings.json');

  try {
    assert.deepEqual(getDisplaySettings(settingsPath), {
      brightnessPercent: 100,
      idleTimeoutMinutes: 10,
      sleepWhenLocked: true,
    });
    assert.deepEqual(
      setDisplaySettings(
        {
          brightnessPercent: 42,
          idleTimeoutMinutes: 30,
          sleepWhenLocked: false,
        },
        settingsPath,
      ),
      {
        brightnessPercent: 42,
        idleTimeoutMinutes: 30,
        sleepWhenLocked: false,
      },
    );
    assert.deepEqual(readSettings(settingsPath), {
      displayBrightnessPercent: 42,
      displayIdleTimeoutMinutes: 30,
      sleepDisplaysWhenLocked: false,
    });
    assert.throws(
      () =>
        setDisplaySettings(
          {
            brightnessPercent: 101,
            idleTimeoutMinutes: 30,
            sleepWhenLocked: true,
          },
          settingsPath,
        ),
      /invalid/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
