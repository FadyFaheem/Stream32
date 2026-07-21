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
