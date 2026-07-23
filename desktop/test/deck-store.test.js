const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DECK_REGISTRY_VERSION,
  MAX_DEVICES,
  MAX_PROFILES,
  createDefaultProfile,
  exportProfile,
  importProfile,
  validateAction,
  validateDeckRegistry,
  validateDevice,
  validateHostAction,
  validateProfile,
} = require('../src/deck-model');
const {
  addImportedProfile,
  applyProfileOperation,
  readDecks,
  registerDevice,
  renameDevice,
  saveDeviceProfile,
  saveDeviceProfiles,
} = require('../src/deck-store');
const { readSettings, writeSettings } = require('../src/settings');

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
            labelColor: '#0b1116',
            image: TINY_PNG,
            action: { type: 'launch', command: 'obs' },
          },
          {
            index: 1,
            action: {
              type: 'plugin',
              pluginId: 'microsoft-teams',
              actionId: 'toggle-mute',
              settings: {},
            },
          },
          { index: 8, action: { type: 'page', page: 1 } },
          {
            index: 2,
            action: {
              type: 'multi',
              steps: [
                { type: 'page', page: 1 },
                { type: 'delay', ms: 250 },
                {
                  type: 'plugin',
                  pluginId: 'missing-plugin',
                  actionId: 'preserved-action',
                  settings: { value: 'kept' },
                },
              ],
            },
          },
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
  assert.equal(validated.pages[0].keys[0].labelColor, '#0b1116');
  assert.deepEqual(validated.pages[0].keys[1].action, {
    type: 'plugin',
    pluginId: 'microsoft-teams',
    actionId: 'toggle-mute',
    settings: {},
  });
  assert.deepEqual(validated.pages[1].keys[1].action, {
    type: 'hotkey',
    key: 'F5',
    alt: false,
    ctrl: true,
    meta: false,
    shift: true,
  });
  assert.deepEqual(
    validated.pages[0].keys.find((key) => key.index === 2).action,
    sampleProfile().pages[0].keys.find((key) => key.index === 2).action,
  );
});

test('validates bounded Multi Actions without nesting or top-level delays', () => {
  const action = {
    type: 'multi',
    steps: [
      { type: 'media', command: 'mute' },
      { type: 'delay', ms: 30_000 },
      { type: 'page', page: 1 },
      { type: 'delay', ms: 0 },
    ],
  };

  assert.deepEqual(validateAction(action, 2), action);
  assert.throws(
    () => validateAction({
      type: 'multi',
      steps: Array.from(
        { length: 17 },
        () => ({ type: 'media', command: 'mute' }),
      ),
    }, 2),
    /1-16 steps/,
  );
  assert.throws(
    () => validateAction({
      type: 'multi',
      steps: [{ type: 'delay', ms: 30_001 }],
    }, 2),
    /delay/,
  );
  assert.throws(
    () => validateAction({
      type: 'multi',
      steps: Array.from(
        { length: 5 },
        () => ({ type: 'delay', ms: 30_000 }),
      ),
    }, 2),
    /total delay/,
  );
  assert.throws(
    () => validateAction({
      type: 'multi',
      steps: [{ type: 'multi', steps: [] }],
    }, 2),
    /cannot be nested/,
  );
  assert.throws(
    () => validateAction({ type: 'delay', ms: 1 }, 2),
    /only valid inside/,
  );
  assert.throws(
    () => validateHostAction(action),
    /never reach.*unexpanded/,
  );
  assert.throws(
    () => validateHostAction({ type: 'delay', ms: 1 }),
    /never reach.*unexpanded/,
  );
});

test('accepts bounded text and mouse actions as host and Multi leaves', () => {
  const text = { type: 'text', text: 'Hello 👋\n' };
  const mouse = {
    type: 'mouse',
    operation: 'scroll',
    vertical: -2,
    horizontal: 1,
  };

  assert.deepEqual(validateHostAction(text), text);
  assert.deepEqual(validateHostAction(mouse), mouse);
  assert.deepEqual(
    validateAction({ type: 'multi', steps: [text, mouse] }, 1),
    { type: 'multi', steps: [text, mouse] },
  );
  assert.throws(
    () => validateHostAction({ type: 'text', text: 'bad\u0000text' }),
    /control character/,
  );
  assert.throws(
    () => validateHostAction({
      type: 'mouse',
      operation: 'move-relative',
      x: 10001,
      y: 0,
    }),
    /supported range/,
  );
});

test('accepts free-form grids within the key budget', () => {
  // Landscape 9x4 and its portrait mirror both validate.
  const wide = sampleProfile();
  wide.keyPx = { '4x9': 104 };
  wide.pages[0].rows = 4;
  wide.pages[0].cols = 9;

  const validated = validateProfile(wide);
  assert.equal(validated.pages[0].cols, 9);
  assert.equal(validated.keyPx['4x9'], 104);

  const tall = sampleProfile();
  tall.pages[0].rows = 9;
  tall.pages[0].cols = 4;
  assert.equal(validateProfile(tall).pages[0].rows, 9);

  // Axis cap and the per-page key budget both hold.
  const tooWide = sampleProfile();
  tooWide.pages[0].cols = 11;
  assert.throws(() => validateProfile(tooWide), /Page cols/);

  const overBudget = sampleProfile();
  overBudget.pages[0].rows = 10;
  overBudget.pages[0].cols = 5;
  assert.throws(() => validateProfile(overBudget), /keys per page/);

  const badGridKey = sampleProfile();
  badGridKey.keyPx = { '11x1': 110 };
  assert.throws(() => validateProfile(badGridKey), /grid key/);
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

  const badLabelColor = sampleProfile();
  badLabelColor.pages[0].keys[0].labelColor = 'white';
  assert.throws(() => validateProfile(badLabelColor), /Key label color/);

  const duplicateKeys = sampleProfile();
  duplicateKeys.pages[0].keys = [{ index: 0 }, { index: 0 }];
  assert.throws(() => validateProfile(duplicateKeys), /unique indexes/);

  const badLiveState = sampleProfile();
  badLiveState.pages[0].keys[0].liveState = {
    provider: 'toggle',
    on: { color: 'green' },
  };
  assert.throws(() => validateProfile(badLiveState), /Toggle on color/);
});

test('migrates legacy profiles without losing device or board identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    writeSettings({ devices: { [DEVICE_ID]: sampleProfile() } }, decksPath);
    const registry = readDecks(decksPath);
    const device = registry.devices[DEVICE_ID];

    assert.equal(registry.version, DECK_REGISTRY_VERSION);
    assert.deepEqual(Object.keys(registry.devices), [DEVICE_ID]);
    assert.equal(device.name, 'Desk deck');
    assert.equal(device.boardId, BOARD_ID);
    assert.equal(device.activeProfileId, 'default');
    assert.equal(device.defaultProfileId, 'default');
    assert.equal(device.profiles.default.name, 'Default');
    assert.equal(
      device.profiles.default.pages[0].keys.find((key) => key.index === 2)
        .action.steps[2].pluginId,
      'missing-plugin',
    );
    assert.deepEqual(
      device.profiles.default.pages,
      validateProfile(sampleProfile()).pages,
    );
    assert.equal(readSettings(decksPath).version, DECK_REGISTRY_VERSION);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('persists active profiles and caps devices and profiles', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk deck', decksPath);
    const edited = sampleProfile();
    edited.name = 'Ignored renderer rename';
    const saved = saveDeviceProfile(
      DEVICE_ID,
      'default',
      edited,
      decksPath,
    );

    assert.equal(saved.name, 'Default');
    assert.equal(readDecks(decksPath).devices[DEVICE_ID].name, 'Desk deck');
    const beforeBatch = readDecks(decksPath).devices[DEVICE_ID].profiles.default;
    const changed = structuredClone(beforeBatch);
    changed.pages[0].keys[0].label = 'Should not save';
    assert.throws(
      () => saveDeviceProfiles(
        DEVICE_ID,
        [
          { profileId: 'default', profile: changed },
          { profileId: 'missing', profile: changed },
        ],
        decksPath,
      ),
      /Profile update/,
    );
    assert.deepEqual(
      readDecks(decksPath).devices[DEVICE_ID].profiles.default,
      beforeBatch,
    );

    assert.throws(
      () => registerDevice('nope', BOARD_ID, 'Bad', decksPath),
      /Device id/,
    );

    for (let index = 1; index < MAX_DEVICES; index++) {
      registerDevice(
        `aabbccddee${index.toString(16).padStart(2, '0')}`,
        BOARD_ID,
        'Deck',
        decksPath,
      );
    }

    assert.throws(
      () =>
        registerDevice(
          'ffffffffffff',
          BOARD_ID,
          'One too many',
          decksPath,
        ),
      /devices are supported/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('validates registry profile caps and active/default references', () => {
  const profiles = Object.fromEntries(
    Array.from({ length: MAX_PROFILES }, (_value, index) => [
      `profile-${index + 1}`,
      { ...createDefaultProfile(BOARD_ID), name: `Profile ${index + 1}` },
    ]),
  );
  const device = {
    name: 'Desk',
    boardId: BOARD_ID,
    activeProfileId: 'profile-1',
    defaultProfileId: 'profile-1',
    profiles,
  };

  assert.equal(Object.keys(validateDevice(device).profiles).length, MAX_PROFILES);
  assert.throws(
    () => validateDevice({
      ...device,
      profiles: {
        ...profiles,
        overflow: createDefaultProfile(BOARD_ID),
      },
    }),
    /1-16 profiles/,
  );
  assert.throws(
    () => validateDevice({ ...device, activeProfileId: 'missing' }),
    /Active deck profile/,
  );
  assert.throws(
    () => validateDevice({ ...device, defaultProfileId: 'missing' }),
    /Default deck profile/,
  );
  assert.equal(
    validateDeckRegistry({
      version: DECK_REGISTRY_VERSION,
      devices: { [DEVICE_ID]: device },
    }).version,
    DECK_REGISTRY_VERSION,
  );
});

test('creates, duplicates, renames, selects, and deletes with fallbacks', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk', decksPath);
    let device = applyProfileOperation(
      DEVICE_ID,
      { type: 'create', name: 'Gaming' },
      decksPath,
    );
    const gamingId = device.activeProfileId;
    assert.match(gamingId, /^[a-z0-9][a-z0-9-]{0,31}$/);
    assert.equal(device.profiles[gamingId].name, 'Gaming');

    device.profiles[gamingId].pages[0].keys.push({ index: 0, label: 'Game' });
    saveDeviceProfile(
      DEVICE_ID,
      gamingId,
      device.profiles[gamingId],
      decksPath,
    );
    device = applyProfileOperation(
      DEVICE_ID,
      { type: 'duplicate', profileId: gamingId },
      decksPath,
    );
    const copyId = device.activeProfileId;
    assert.notEqual(copyId, gamingId);
    assert.equal(device.profiles[copyId].name, 'Gaming copy');
    assert.equal(device.profiles[copyId].pages[0].keys[0].label, 'Game');
    device.profiles[copyId].pages[0].keys[0].label = 'Changed locally';
    assert.equal(device.profiles[gamingId].pages[0].keys[0].label, 'Game');

    device = applyProfileOperation(
      DEVICE_ID,
      { type: 'rename', profileId: copyId, name: 'Streaming' },
      decksPath,
    );
    assert.equal(device.profiles[copyId].name, 'Streaming');
    assert.equal(device.profiles[gamingId].name, 'Gaming');
    assert.throws(
      () => applyProfileOperation(
        DEVICE_ID,
        { type: 'rename', profileId: copyId, name: 'Gaming' },
        decksPath,
      ),
      /unique/,
    );

    device = applyProfileOperation(
      DEVICE_ID,
      { type: 'select', profileId: gamingId },
      decksPath,
    );
    assert.equal(device.activeProfileId, gamingId);
    device = applyProfileOperation(
      DEVICE_ID,
      { type: 'delete', profileId: 'default' },
      decksPath,
    );
    assert.equal(device.defaultProfileId, [copyId, gamingId].sort()[0]);
    device = applyProfileOperation(
      DEVICE_ID,
      { type: 'delete', profileId: gamingId },
      decksPath,
    );
    assert.equal(device.activeProfileId, copyId);
    assert.throws(
      () => applyProfileOperation(
        DEVICE_ID,
        { type: 'delete', profileId: copyId },
        decksPath,
      ),
      /last profile/,
    );

    device = renameDevice(DEVICE_ID, 'Control surface', decksPath);
    assert.equal(device.name, 'Control surface');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('persists one validated app match per platform and one device default', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk', decksPath);
    let device = applyProfileOperation(
      DEVICE_ID,
      { type: 'create', name: 'OBS' },
      decksPath,
    );
    const profileId = device.activeProfileId;
    device = applyProfileOperation(
      DEVICE_ID,
      {
        type: 'set-app-match',
        profileId,
        platform: 'win32',
        rule: { kind: 'executable', value: 'OBS-Studio\\OBS64.EXE' },
      },
      decksPath,
    );

    assert.deepEqual(device.profiles[profileId].appMatches.win32, {
      kind: 'executable',
      value: 'obs-studio/obs64.exe',
    });
    device = applyProfileOperation(
      DEVICE_ID,
      { type: 'set-default', profileId },
      decksPath,
    );
    assert.equal(device.defaultProfileId, profileId);
    assert.throws(
      () => applyProfileOperation(
        DEVICE_ID,
        {
          type: 'set-app-match',
          profileId,
          platform: 'win32',
          rule: { kind: 'processName', value: 'obs' },
        },
        decksPath,
      ),
      /identity kind/,
    );
    device = applyProfileOperation(
      DEVICE_ID,
      {
        type: 'set-app-match',
        profileId,
        platform: 'win32',
        rule: null,
      },
      decksPath,
    );
    assert.deepEqual(device.profiles[profileId].appMatches, {});
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('imports a compatible file as a new selected profile', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk', decksPath);
    const imported = sampleProfile();
    imported.name = 'Imported';
    let device = addImportedProfile(DEVICE_ID, imported, decksPath);

    assert.equal(Object.keys(device.profiles).length, 2);
    assert.equal(device.profiles[device.activeProfileId].name, 'Imported');
    device = addImportedProfile(DEVICE_ID, imported, decksPath);
    assert.equal(device.profiles[device.activeProfileId].name, 'Imported 2');

    const wrongBoard = sampleProfile();
    wrongBoard.boardId = 'different-board';
    assert.throws(
      () => addImportedProfile(DEVICE_ID, wrongBoard, decksPath),
      /different board/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('recovers a semantically corrupt registry from previous-good storage', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk', decksPath);
    const raw = readSettings(decksPath);
    raw.devices[DEVICE_ID] = { boardId: BOARD_ID, profiles: 'garbage' };
    writeSettings(raw, decksPath);

    const recovered = readDecks(decksPath);
    assert.deepEqual(Object.keys(recovered.devices), [DEVICE_ID]);
    assert.deepEqual(recovered.errors, []);
    assert.deepEqual(Object.keys(readSettings(decksPath).devices), [DEVICE_ID]);
    assert.equal(
      readSettings(decksPath).devices[DEVICE_ID].profiles.default.name,
      'Default',
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('salvages valid devices while preserving corrupt device entries', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk', decksPath);
    const raw = readSettings(decksPath);
    raw.devices['invalid-device'] = {
      boardId: BOARD_ID,
      profiles: 'not-an-object',
    };
    writeSettings(raw, decksPath);

    const salvaged = readDecks(decksPath);
    assert.deepEqual(Object.keys(salvaged.devices), [DEVICE_ID]);
    assert.match(salvaged.errors[0].message, /invalid id.*preserved/);

    const edited = structuredClone(
      salvaged.devices[DEVICE_ID].profiles.default,
    );
    edited.pages[0].keys.push({ index: 0, label: 'Still writable' });
    saveDeviceProfile(DEVICE_ID, 'default', edited, decksPath);

    const savedRaw = readSettings(decksPath);
    assert.deepEqual(
      savedRaw.devices['invalid-device'],
      raw.devices['invalid-device'],
    );
    assert.equal(
      savedRaw.devices[DEVICE_ID].profiles.default.pages[0].keys[0].label,
      'Still writable',
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('preserves corrupt named profiles across valid reads and saves', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stream32-decks-'));
  const decksPath = path.join(directory, 'decks.json');

  try {
    registerDevice(DEVICE_ID, BOARD_ID, 'Desk', decksPath);
    applyProfileOperation(
      DEVICE_ID,
      { type: 'create', name: 'Studio' },
      decksPath,
    );
    const raw = readSettings(decksPath);
    raw.devices[DEVICE_ID].profiles.broken = {
      name: 'Broken',
      boardId: BOARD_ID,
      pages: 'not-an-array',
    };
    raw.devices[DEVICE_ID].activeProfileId = 'broken';
    writeSettings(raw, decksPath);

    const first = readDecks(decksPath);
    assert.deepEqual(
      Object.keys(first.devices[DEVICE_ID].profiles).sort(),
      ['default', 'studio'],
    );
    assert.deepEqual(first.errors, [
      {
        deviceId: DEVICE_ID,
        profileId: 'broken',
        message:
          `Profile broken on device ${DEVICE_ID} is corrupt and was preserved.`,
      },
      {
        deviceId: DEVICE_ID,
        message:
          `Device ${DEVICE_ID} had an invalid active profile; ` +
          'default is used until storage is repaired.',
      },
    ]);
    assert.deepEqual(readDecks(decksPath).errors, first.errors);

    const edited = structuredClone(
      first.devices[DEVICE_ID].profiles.default,
    );
    edited.pages[0].keys.push({ index: 0, label: 'Saved safely' });
    saveDeviceProfile(DEVICE_ID, 'default', edited, decksPath);

    const savedRaw = readSettings(decksPath);
    assert.equal(
      savedRaw.devices[DEVICE_ID].profiles.default.pages[0].keys[0].label,
      'Saved safely',
    );
    assert.deepEqual(
      savedRaw.devices[DEVICE_ID].profiles.broken,
      raw.devices[DEVICE_ID].profiles.broken,
    );
    assert.equal(savedRaw.devices[DEVICE_ID].activeProfileId, 'broken');
    assert.deepEqual(readDecks(decksPath).errors, first.errors);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('round-trips export and import and rejects malformed files', () => {
  const exported = exportProfile(sampleProfile());
  const imported = importProfile(exported);

  assert.equal(JSON.parse(exported).stream32Deck, 4);
  assert.deepEqual(imported, validateProfile(sampleProfile()));
  for (const version of [1, 2, 3]) {
    const legacy = JSON.parse(exported);
    legacy.stream32Deck = version;
    assert.deepEqual(importProfile(JSON.stringify(legacy)), imported);
  }
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
