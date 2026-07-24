const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  reusePublishedImage,
  selectAffectedProfiles,
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

test('selects only the board whose profile or firmware changed', () => {
  assert.deepEqual(
    selectAffectedProfiles(profiles, [
      'boards/elecrow/firmware/main/main.c',
    ]),
    [elecrow],
  );
  assert.deepEqual(
    selectAffectedProfiles(profiles, ['boards/waveshare/board.json']),
    [waveshare],
  );
});

test('selects every board for shared code, tooling, catalog, or workflows', () => {
  for (const changedPath of [
    'boards/common/components/deck/deck_ui.c',
    'boards/tools/build-catalog.js',
    'boards/catalog.json',
    '.github/workflows/ci-boards.yml',
  ]) {
    assert.deepEqual(selectAffectedProfiles(profiles, [changedPath]), profiles);
  }
});

test('selects no firmware for documentation-only changes', () => {
  assert.deepEqual(
    selectAffectedProfiles(profiles, ['boards/README.md', 'README.md']),
    [],
  );
});

test('fails safe when an unknown board path changes', () => {
  assert.deepEqual(
    selectAffectedProfiles(profiles, ['boards/new-board/firmware/main.c']),
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
