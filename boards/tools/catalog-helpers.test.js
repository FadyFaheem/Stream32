const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  reusePublishedImage,
  selectAffectedProfiles,
  selectFirmwareBuildProfiles,
} = require('./catalog-helpers');

const waveshare = {
  id: 'waveshare',
  sourcePath: 'waveshare/board.json',
  firmware: {
    imageName: 'waveshare-1.0.0.bin',
    offset: 0,
    version: '1.0.0',
  },
};
const elecrow = {
  id: 'elecrow',
  sourcePath: 'elecrow/board.json',
  firmware: {
    imageName: 'elecrow-2.0.0.bin',
    offset: 0,
    version: '2.0.0',
  },
};
const profiles = [waveshare, elecrow];

test('board profiles declare their post-flash reset behavior', () => {
  const profile = JSON.parse(
    readFileSync(
      path.join(
        __dirname,
        '..',
        'elecrow-crowpanel-advanced-10-1-esp32-p4',
        'board.json',
      ),
      'utf8',
    ),
  );
  const com6 = {
    displayName: 'USB-SERIAL CH340K',
    portName: 'COM6',
    usbProductId: 0x7522,
    usbVendorId: 0x1a86,
  };

  assert.equal(
    profile.usbFilters.some(
      (filter) =>
        filter.usbVendorId === com6.usbVendorId &&
        filter.usbProductId === com6.usbProductId,
    ),
    true,
  );
  assert.equal(profile.preferredFlashBaud, 921600);
  assert.equal(profile.postFlashReset, 'manual');

  const waveshareProfile = JSON.parse(
    readFileSync(
      path.join(
        __dirname,
        '..',
        'waveshare-esp32-s3-touch-lcd-4-v3',
        'board.json',
      ),
      'utf8',
    ),
  );
  assert.equal(waveshareProfile.postFlashReset, 'automatic');
});

test('maps board-specific firmware changes to that board', () => {
  assert.deepEqual(
    selectAffectedProfiles(profiles, [
      'boards/elecrow/firmware/main/main.c',
    ]),
    [elecrow],
  );
  assert.deepEqual(
    selectAffectedProfiles(profiles, ['boards/waveshare/board.json']),
    [],
  );
});

test('builds only boards whose firmware version changed', () => {
  const previousProfiles = [
    {
      ...waveshare,
      firmware: { ...waveshare.firmware, version: '0.9.0' },
    },
    elecrow,
  ];

  assert.deepEqual(
    selectFirmwareBuildProfiles(
      profiles,
      previousProfiles,
      ['boards/waveshare/board.json'],
    ),
    [waveshare],
  );
});

test('skips firmware builds for tooling and metadata-only changes', () => {
  assert.deepEqual(
    selectFirmwareBuildProfiles(
      profiles,
      profiles,
      [
        '.github/workflows/ci-boards.yml',
        'boards/tools/build-catalog.js',
        'boards/elecrow/board.json',
        'boards/README.md',
      ],
    ),
    [],
  );
});

test('requires version bumps for board-specific and shared firmware changes', () => {
  assert.throws(
    () =>
      selectFirmwareBuildProfiles(
        profiles,
        profiles,
        ['boards/elecrow/firmware/main/main.c'],
      ),
    /elecrow/,
  );
  assert.throws(
    () =>
      selectFirmwareBuildProfiles(
        profiles,
        profiles,
        ['boards/common/components/deck/deck_ui.c'],
      ),
    /waveshare, elecrow/,
  );

  const previousProfiles = profiles.map((profile) => ({
    ...profile,
    firmware: { ...profile.firmware, version: '0.0.1' },
  }));
  assert.deepEqual(
    selectFirmwareBuildProfiles(
      profiles,
      previousProfiles,
      ['boards/common/components/deck/deck_ui.c'],
    ),
    profiles,
  );
});

test('fails safe when an unknown firmware path changes', () => {
  assert.deepEqual(
    selectAffectedProfiles(
      profiles,
      ['boards/new-board/firmware/main/main.c'],
    ),
    profiles,
  );
});

test('reuses only exact, validated previous image metadata', () => {
  const previousCatalog = {
    schemaVersion: 1,
    boards: [
      {
        id: 'elecrow',
        firmware: {
          version: '2.0.0',
          images: [
            {
              assetName: 'elecrow-2.0.0.bin',
              offset: 0,
              sha256: 'a'.repeat(64),
              size: 123456,
            },
          ],
        },
      },
    ],
  };

  assert.deepEqual(reusePublishedImage(elecrow, previousCatalog), {
    assetName: 'elecrow-2.0.0.bin',
    offset: 0,
    sha256: 'a'.repeat(64),
    size: 123456,
  });
  assert.throws(
    () =>
      reusePublishedImage(
        {
          ...elecrow,
          firmware: { ...elecrow.firmware, version: '2.0.1' },
        },
        previousCatalog,
      ),
    /no matching firmware/,
  );
  assert.throws(
    () =>
      reusePublishedImage(elecrow, {
        ...previousCatalog,
        boards: [
          {
            ...previousCatalog.boards[0],
            firmware: {
              ...previousCatalog.boards[0].firmware,
              images: [
                {
                  ...previousCatalog.boards[0].firmware.images[0],
                  sha256: 'unsafe',
                },
              ],
            },
          },
        ],
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      reusePublishedImage(elecrow, {
        ...previousCatalog,
        boards: [
          {
            ...previousCatalog.boards[0],
            firmware: {
              ...previousCatalog.boards[0].firmware,
              images: [
                {
                  ...previousCatalog.boards[0].firmware.images[0],
                  size: 33 * 1024 * 1024,
                },
              ],
            },
          },
        ],
      }),
    /does not match/,
  );
});
