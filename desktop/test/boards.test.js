const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createBoardService,
  sha256,
  validateCatalog,
} = require('../src/boards');

function catalogFor(image, overrides = {}) {
  const board = {
    id: 'waveshare-esp32-s3-touch-lcd-4-v3',
    name: 'Waveshare ESP32-S3-Touch-LCD-4',
    vendor: 'Waveshare',
    hardwareRevision: '3.0',
    chip: 'ESP32-S3',
    protocolVersion: 1,
    minimumDesktopVersion: '0.1.0',
    usbFilters: [{ usbProductId: 0x1001, usbVendorId: 0x303a }],
    capabilities: ['display', 'touch', 'usb-serial-jtag'],
    recoveryInstructions: ['Hold BOOT while reconnecting USB.'],
    firmware: {
      version: '0.1.0',
      images: [
        {
          assetName:
            'waveshare-esp32-s3-touch-lcd-4-v3-0.1.0.bin',
          offset: 0,
          sha256: sha256(image),
          size: image.length,
        },
      ],
    },
    ...overrides,
  };

  return {
    boards: [board],
    generatedAt: '2026-07-20T00:00:00.000Z',
    schemaVersion: 1,
  };
}

test('validates catalog compatibility and rejects hostile asset names', () => {
  const image = Buffer.from([0xe9, 1, 2, 3]);
  const catalog = validateCatalog(catalogFor(image), '0.1.0');

  assert.equal(catalog.boards[0].compatible, true);
  assert.equal(
    validateCatalog(catalogFor(image), '0.1.0-beta.1').boards[0]
      .compatible,
    false,
  );

  const requiresUpdate = catalogFor(image, {
    minimumDesktopVersion: '2.0.0',
  });
  assert.equal(
    validateCatalog(requiresUpdate, '0.1.0').boards[0].compatible,
    false,
  );

  const hostile = catalogFor(image);
  hostile.boards[0].firmware.images[0].assetName = '../firmware.bin';
  assert.throws(() => validateCatalog(hostile, '0.1.0'), /unsafe/);
});

test('marks boards with unknown chips incompatible without failing the catalog', () => {
  const image = Buffer.from([0xe9, 1, 2, 3]);
  const catalog = catalogFor(image);
  catalog.boards.push({
    ...catalogFor(image, {
      chip: 'ESP32-Z9',
      id: 'future-board',
    }).boards[0],
  });

  const validated = validateCatalog(catalog, '0.1.0');

  assert.equal(validated.boards[0].compatible, true);
  assert.equal(validated.boards[1].compatible, false);
});

test('verifies the ESP32-P4 boot magic at the 0x2000 bootloader offset', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-boards-'));
  // A merged ESP32-P4 image starts with 0xFF padding; the bootloader (and
  // its 0xE9 magic) sits at 0x2000.
  const image = Buffer.alloc(0x2010, 0xff);
  image[0x2000] = 0xe9;
  const catalog = catalogFor(image, {
    chip: 'ESP32-P4',
    id: 'elecrow-p4-test',
  });
  const catalogJson = JSON.stringify(catalog);

  try {
    const service = createBoardService({
      appVersion: '0.1.0',
      assetBaseUrl: 'https://github.com/example/boards/',
      catalogUrl: 'https://github.com/example/catalog.json',
      fetcher: async (url) =>
        url === 'https://github.com/example/catalog.json'
          ? new Response(catalogJson)
          : new Response(image, {
              headers: { 'content-length': image.length },
            }),
      userDataPath: directory,
    });

    const firmware = await service.getFirmware(catalog.boards[0].id);
    assert.deepEqual(Buffer.from(firmware.images[0].data), image);

    // An image without the P4 boot magic must be rejected.
    const badImage = Buffer.alloc(0x2010, 0xff);
    const badCatalog = catalogFor(badImage, {
      chip: 'ESP32-P4',
      id: 'elecrow-p4-test',
    });
    const badJson = JSON.stringify(badCatalog);
    const badDirectory = mkdtempSync(
      path.join(os.tmpdir(), 'stream32-boards-'),
    );

    try {
      const badService = createBoardService({
        appVersion: '0.1.0',
        assetBaseUrl: 'https://github.com/example/boards/',
        catalogUrl: 'https://github.com/example/catalog.json',
        fetcher: async (url) =>
          url === 'https://github.com/example/catalog.json'
            ? new Response(badJson)
            : new Response(badImage, {
                headers: { 'content-length': badImage.length },
              }),
        userDataPath: badDirectory,
      });

      await assert.rejects(
        badService.getFirmware(badCatalog.boards[0].id),
        /not an Espressif boot image/,
      );
    } finally {
      rmSync(badDirectory, { force: true, recursive: true });
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('applies and validates optional per-board deck limits', () => {
  const image = Buffer.from([0xe9, 1, 2, 3]);

  // Without explicit limits the key budget is the default grid product.
  assert.deepEqual(
    validateCatalog(catalogFor(image), '0.1.0').boards[0].deck,
    { maxCols: 5, maxKeys: 25, maxPages: 8, maxRows: 5 },
  );
  assert.deepEqual(
    validateCatalog(
      catalogFor(image, { deck: { maxRows: 4, maxCols: 3, maxPages: 2 } }),
      '0.1.0',
    ).boards[0].deck,
    { maxCols: 3, maxKeys: 12, maxPages: 2, maxRows: 4 },
  );
  // Boards built for the extended layout line advertise a bigger budget,
  // enabling free-form shapes like 9x4 within it.
  assert.deepEqual(
    validateCatalog(
      catalogFor(image, {
        deck: { maxRows: 10, maxCols: 10, maxKeys: 40 },
      }),
      '0.1.0',
    ).boards[0].deck,
    { maxCols: 10, maxKeys: 40, maxPages: 8, maxRows: 10 },
  );
  // Deck shapes this build does not support disable the one board instead
  // of poisoning the whole catalog.
  assert.equal(
    validateCatalog(
      catalogFor(image, { deck: { maxKeys: 41 } }),
      '0.1.0',
    ).boards[0].compatible,
    false,
  );
  assert.equal(
    validateCatalog(
      catalogFor(image, { deck: { maxRows: 99 } }),
      '0.1.0',
    ).boards[0].compatible,
    false,
  );
});

test('downloads from the fixed release base, verifies, and caches firmware', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-boards-'));
  const image = Buffer.from([0xe9, 0xaa, 0xbb, 0xcc, 0xdd]);
  const catalog = catalogFor(image);
  const catalogJson = JSON.stringify(catalog);
  const requestedUrls = [];
  const assetBaseUrl =
    'https://github.com/FadyFaheem/Stream32/releases/download/' +
    'boards-current/';
  const catalogUrl = `${assetBaseUrl}catalog-v1.json`;

  try {
    const service = createBoardService({
      appVersion: '0.1.0',
      assetBaseUrl,
      catalogUrl,
      fetcher: async (url) => {
        requestedUrls.push(url);

        if (url === catalogUrl) {
          return new Response(catalogJson, {
            headers: {
              'content-length': Buffer.byteLength(catalogJson),
              etag: '"catalog-1"',
            },
          });
        }

        if (url.endsWith(catalog.boards[0].firmware.images[0].assetName)) {
          return new Response(image, {
            headers: { 'content-length': image.length },
          });
        }

        return new Response('not found', { status: 404 });
      },
      userDataPath: directory,
    });

    const listed = await service.getBoards();
    const firmware = await service.getFirmware(catalog.boards[0].id);

    assert.equal(listed.source, 'network');
    assert.equal(firmware.images[0].address, 0);
    assert.deepEqual(Buffer.from(firmware.images[0].data), image);
    assert.deepEqual(requestedUrls, [
      catalogUrl,
      `${assetBaseUrl}${catalog.boards[0].firmware.images[0].assetName}`,
    ]);

    const offlineService = createBoardService({
      appVersion: '0.1.0',
      assetBaseUrl,
      catalogUrl,
      fetcher: async () => {
        throw new Error('offline');
      },
      userDataPath: directory,
    });
    const cachedList = await offlineService.getBoards();
    const cachedFirmware = await offlineService.getFirmware(
      catalog.boards[0].id,
    );

    assert.equal(cachedList.source, 'cache');
    assert.match(cachedList.warning, /offline/);
    assert.deepEqual(Buffer.from(cachedFirmware.images[0].data), image);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('rejects firmware whose downloaded hash does not match', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-boards-'));
  const expectedImage = Buffer.from([0xe9, 1, 2, 3]);
  const wrongImage = Buffer.from([0xe9, 4, 5, 6]);
  const catalog = catalogFor(expectedImage);
  const catalogJson = JSON.stringify(catalog);
  let requestCount = 0;

  try {
    const service = createBoardService({
      appVersion: '0.1.0',
      assetBaseUrl: 'https://github.com/example/boards/',
      catalogUrl: 'https://github.com/example/catalog.json',
      fetcher: async () => {
        requestCount++;
        return requestCount === 1
          ? new Response(catalogJson)
          : new Response(wrongImage, {
              headers: { 'content-length': wrongImage.length },
            });
      },
      userDataPath: directory,
    });

    await assert.rejects(
      service.getFirmware(catalog.boards[0].id),
      /SHA-256/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
