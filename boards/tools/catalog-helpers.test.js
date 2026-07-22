const assert = require('node:assert/strict');
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
