const assert = require('node:assert/strict');
const test = require('node:test');

const electronModule = require.resolve('electron');
const {
  DECK_REGISTRY_VERSION,
  EXPORT_SCHEMA_VERSION,
  createDefaultProfile,
  exportProfile,
  importProfile,
  validateDeckRegistry,
  validateProfile,
  validateProfileEnvelope,
} = require('../src/deck-model');

const BOARD_ID = 'test-board';
const DEVICE_ID = 'aabbccddeeff';

function profile() {
  return {
    name: 'Studio',
    boardId: BOARD_ID,
    appMatches: {
      win32: { kind: 'executable', value: 'OBS-Studio\\OBS64.EXE' },
    },
    activePage: 1,
    keyPx: { '2x2': 96 },
    pages: [
      {
        name: 'Main',
        rows: 2,
        cols: 2,
        keys: [
          {
            index: 0,
            action: {
              type: 'multi',
              steps: [
                { type: 'text', text: 'Starting\n' },
                { type: 'delay', ms: 25 },
                {
                  type: 'mouse',
                  operation: 'move-relative',
                  x: 1,
                  y: -1,
                },
                { type: 'page', page: 1 },
              ],
            },
            liveState: {
              provider: 'toggle',
              on: { color: '#00ff00' },
            },
          },
        ],
      },
      {
        name: 'Second',
        rows: 1,
        cols: 1,
        keys: [{ index: 0, action: { type: 'page', page: 0 } }],
      },
    ],
  };
}

test('pure deck model validates without loading Electron', () => {
  assert.equal(require.cache[electronModule], undefined);

  const validated = validateProfile(profile());

  assert.equal(validated.activePage, 1);
  assert.equal(validated.keyPx['2x2'], 96);
  assert.equal(validated.pages[0].keys[0].action.steps[0].type, 'text');
  assert.equal(validated.pages[0].keys[0].action.steps[2].type, 'mouse');
  assert.deepEqual(validated.appMatches.win32, {
    kind: 'executable',
    value: 'obs-studio/obs64.exe',
  });
  assert.equal(require.cache[electronModule], undefined);
});

test('model owns current and legacy profile envelopes', () => {
  const exported = exportProfile(profile());
  const envelope = JSON.parse(exported);

  assert.equal(envelope.stream32Deck, EXPORT_SCHEMA_VERSION);
  assert.deepEqual(validateProfileEnvelope(envelope), validateProfile(profile()));

  for (const version of [1, 2, 3, EXPORT_SCHEMA_VERSION]) {
    assert.deepEqual(
      importProfile(JSON.stringify({ ...envelope, stream32Deck: version })),
      validateProfile(profile()),
    );
  }

  assert.throws(
    () => validateProfileEnvelope({ stream32Deck: 99, profile: profile() }),
    /unsupported format/,
  );
});

test('registry validation owns named profiles and legacy migration', () => {
  const named = validateDeckRegistry({
    version: DECK_REGISTRY_VERSION,
    devices: {
      [DEVICE_ID]: {
        name: 'Desk',
        boardId: BOARD_ID,
        activeProfileId: 'studio',
        defaultProfileId: 'default',
        profiles: {
          default: createDefaultProfile(BOARD_ID),
          studio: profile(),
        },
      },
    },
  });

  assert.deepEqual(Object.keys(named.devices[DEVICE_ID].profiles), [
    'default',
    'studio',
  ]);
  assert.equal(named.devices[DEVICE_ID].activeProfileId, 'studio');

  const legacy = validateDeckRegistry({
    devices: { [DEVICE_ID]: profile() },
  });
  assert.equal(legacy.version, DECK_REGISTRY_VERSION);
  assert.equal(legacy.devices[DEVICE_ID].name, 'Studio');
  assert.equal(legacy.devices[DEVICE_ID].profiles.default.name, 'Default');
});
