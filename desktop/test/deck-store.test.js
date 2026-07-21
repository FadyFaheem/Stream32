const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_DEVICES,
  createDefaultProfile,
  exportProfile,
  importProfile,
  readDecks,
  saveDeviceProfile,
  validateProfile,
} = require('../src/deck-store');

const BOARD_ID = 'waveshare-esp32-s3-touch-lcd-4-v3';
const DEVICE_ID = 'aabbccddeeff';
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sampleProfile() {
  return {
    name: 'Desk deck',
    boardId: BOARD_ID,
    activePage: 1,
    keyPx: { '3x3': 150 },
    pages: [
      {
        name: 'Main',
        rows: 3,
        cols: 3,
        keys: [
          {
            index: 0,
            label: 'OBS',
            color: '#ff5533',
            image: TINY_PNG,
            action: { type: 'launch', command: 'obs' },
          },
          { index: 8, action: { type: 'page', page: 1 } },
        ],
      },
      {
        name: 'Media',
        rows: 2,
        cols: 2,
        keys: [
          { index: 0, action: { type: 'media', command: 'play-pause' } },
          {
            index: 1,
            action: { type: 'hotkey', key: 'F5', ctrl: true, shift: true },
          },
          { index: 2, action: { type: 'url', url: 'https://stream32.dev' } },
          { index: 3, action: { type: 'page', page: 0 } },
        ],
      },
    ],
  };
}

test('validates a full multi-page profile', () => {
  const validated = validateProfile(sampleProfile());

  assert.equal(validated.pages.length, 2);
  assert.equal(validated.activePage, 1);
  assert.equal(validated.keyPx['3x3'], 150);
  assert.deepEqual(validated.pages[1].keys[1].action, {
    type: 'hotkey',
    key: 'F5',
    alt: false,
    ctrl: true,
    meta: false,
    shift: true,
  });
});

test('rejects invalid profiles', () => {
  assert.throws(
    () => validateProfile({ boardId: BOARD_ID, pages: [] }),
    /1-8 pages/,
  );

  const badAction = sampleProfile();
  badAction.pages[0].keys[0].action = { type: 'sql-injection' };
  assert.throws(() => validateProfile(badAction), /Unknown action type/);

  const badPageTarget = sampleProfile();
  badPageTarget.pages[0].keys[1].action = { type: 'page', page: 7 };
  assert.throws(() => validateProfile(badPageTarget), /Action page/);

  const badUrl = sampleProfile();
  badUrl.pages[1].keys[2].action = { type: 'url', url: 'file:///etc/passwd' };
  assert.throws(() => validateProfile(badUrl), /http or https/);

  const badImage = sampleProfile();
  badImage.pages[0].keys[0].image = 'data:text/html;base64,PGh0bWw+';
  assert.throws(() => validateProfile(badImage), /Key image/);

  const duplicateKeys = sampleProfile();
  duplicateKeys.pages[0].keys = [{ index: 0 }, { index: 0 }];
  assert.throws(() => validateProfile(duplicateKeys), /unique indexes/);
});

test('persists, reloads, and caps the registry', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    saveDeviceProfile(DEVICE_ID, sampleProfile(), decksPath);
    const registry = readDecks(decksPath);

    assert.deepEqual(Object.keys(registry.devices), [DEVICE_ID]);
    assert.equal(registry.devices[DEVICE_ID].name, 'Desk deck');

    assert.throws(
      () => saveDeviceProfile('nope', sampleProfile(), decksPath),
      /Device id/,
    );

    for (let index = 1; index < MAX_DEVICES; index++) {
      saveDeviceProfile(
        `aabbccddee${index.toString(16).padStart(2, '0')}`,
        createDefaultProfile(BOARD_ID),
        decksPath,
      );
    }

    assert.throws(
      () =>
        saveDeviceProfile(
          'ffffffffffff',
          createDefaultProfile(BOARD_ID),
          decksPath,
        ),
      /devices are supported/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('drops corrupt registry entries instead of failing', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    saveDeviceProfile(DEVICE_ID, sampleProfile(), decksPath);

    const { writeSettings, readSettings } = require('../src/settings');
    const raw = readSettings(decksPath);
    raw.devices['000000000001'] = { boardId: BOARD_ID, pages: 'garbage' };
    raw.devices['not a device id'] = createDefaultProfile(BOARD_ID);
    writeSettings(raw, decksPath);

    assert.deepEqual(Object.keys(readDecks(decksPath).devices), [DEVICE_ID]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('round-trips export and import and rejects malformed files', () => {
  const exported = exportProfile(sampleProfile());
  const imported = importProfile(exported);

  assert.deepEqual(imported, validateProfile(sampleProfile()));
  assert.throws(() => importProfile('not json'), /not valid JSON/);
  assert.throws(
    () => importProfile('{"stream32Deck":99,"profile":{}}'),
    /unsupported format/,
  );
  assert.throws(
    () => importProfile(JSON.stringify({ stream32Deck: 1, profile: {} })),
    /board id/,
  );
});
