const { app, net } = require('electron');
const { createHash } = require('node:crypto');
const {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises');
const path = require('node:path');

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_URL =
  'https://github.com/FadyFaheem/Stream32/releases/download/' +
  'boards-current/catalog-v1.json';
const ASSET_BASE_URL =
  'https://github.com/FadyFaheem/Stream32/releases/download/boards-current/';
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;
const SUPPORTED_PROTOCOL_VERSION = 1;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.bin$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SUPPORTED_CHIPS = new Set(['ESP32-S3']);

function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version);

  if (!match) {
    throw new TypeError(`Invalid semantic version: ${version}`);
  }

  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function isVersionAtLeast(version, minimumVersion) {
  const current = parseVersion(version);
  const minimum = parseVersion(minimumVersion);

  for (let index = 0; index < current.core.length; index++) {
    if (current.core[index] !== minimum.core[index]) {
      return current.core[index] > minimum.core[index];
    }
  }

  if (!current.prerelease && !minimum.prerelease) {
    return true;
  }

  if (!current.prerelease) {
    return true;
  }

  if (!minimum.prerelease) {
    return false;
  }

  const length = Math.max(
    current.prerelease.length,
    minimum.prerelease.length,
  );

  for (let index = 0; index < length; index++) {
    const currentPart = current.prerelease[index];
    const minimumPart = minimum.prerelease[index];

    if (currentPart === undefined || minimumPart === undefined) {
      return minimumPart === undefined;
    }

    if (currentPart === minimumPart) {
      continue;
    }

    const currentNumber = /^\d+$/.test(currentPart)
      ? Number(currentPart)
      : null;
    const minimumNumber = /^\d+$/.test(minimumPart)
      ? Number(minimumPart)
      : null;

    if (currentNumber !== null && minimumNumber !== null) {
      return currentNumber > minimumNumber;
    }

    if (currentNumber !== null || minimumNumber !== null) {
      return minimumNumber !== null;
    }

    return currentPart > minimumPart;
  }

  return true;
}

function requireString(value, field, maximumLength = 160) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }

  return value;
}

function requireInteger(value, field, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${field} is outside the supported range.`);
  }

  return value;
}

function validateUsbFilters(filters, boardId) {
  if (!Array.isArray(filters) || filters.length === 0 || filters.length > 8) {
    throw new TypeError(`${boardId} must define 1-8 USB filters.`);
  }

  return filters.map((filter, index) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new TypeError(`${boardId} USB filter ${index} is invalid.`);
    }

    return {
      usbVendorId: requireInteger(
        filter.usbVendorId,
        `${boardId} usbVendorId`,
        0,
        0xffff,
      ),
      usbProductId: requireInteger(
        filter.usbProductId,
        `${boardId} usbProductId`,
        0,
        0xffff,
      ),
    };
  });
}

function validateStringList(values, field, maximumItems) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > maximumItems
  ) {
    throw new TypeError(`${field} must contain 1-${maximumItems} entries.`);
  }

  return values.map((value, index) =>
    requireString(value, `${field}[${index}]`, 240),
  );
}

const DEFAULT_DECK_LIMITS = { maxCols: 5, maxPages: 8, maxRows: 5 };

function validateDeckLimits(deck, boardId) {
  if (deck === undefined) {
    return { ...DEFAULT_DECK_LIMITS };
  }

  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) {
    throw new TypeError(`${boardId} deck limits are invalid.`);
  }

  return {
    maxCols: requireInteger(
      deck.maxCols ?? DEFAULT_DECK_LIMITS.maxCols,
      `${boardId} deck maxCols`,
      1,
      DEFAULT_DECK_LIMITS.maxCols,
    ),
    maxPages: requireInteger(
      deck.maxPages ?? DEFAULT_DECK_LIMITS.maxPages,
      `${boardId} deck maxPages`,
      1,
      DEFAULT_DECK_LIMITS.maxPages,
    ),
    maxRows: requireInteger(
      deck.maxRows ?? DEFAULT_DECK_LIMITS.maxRows,
      `${boardId} deck maxRows`,
      1,
      DEFAULT_DECK_LIMITS.maxRows,
    ),
  };
}

function validateImages(images, boardId) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 8) {
    throw new TypeError(`${boardId} must define 1-8 firmware images.`);
  }

  const assetNames = new Set();

  return images.map((image, index) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new TypeError(`${boardId} firmware image ${index} is invalid.`);
    }

    const assetName = requireString(
      image.assetName,
      `${boardId} image assetName`,
      128,
    );

    if (!ASSET_NAME_PATTERN.test(assetName) || assetNames.has(assetName)) {
      throw new TypeError(`${boardId} has an unsafe or duplicate asset name.`);
    }

    assetNames.add(assetName);

    const sha256 = requireString(
      image.sha256,
      `${boardId} image sha256`,
      64,
    );

    if (!HASH_PATTERN.test(sha256)) {
      throw new TypeError(`${boardId} image SHA-256 is invalid.`);
    }

    return {
      assetName,
      offset: requireInteger(
        image.offset,
        `${boardId} image offset`,
        0,
        MAX_IMAGE_BYTES,
      ),
      size: requireInteger(
        image.size,
        `${boardId} image size`,
        1,
        MAX_IMAGE_BYTES,
      ),
      sha256,
    };
  });
}

function validateBoard(board, appVersion) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    throw new TypeError('Board profile must be an object.');
  }

  const id = requireString(board.id, 'board id', 64);

  if (!BOARD_ID_PATTERN.test(id)) {
    throw new TypeError(`Board id is invalid: ${id}`);
  }

  const chip = requireString(board.chip, `${id} chip`, 32);

  if (!SUPPORTED_CHIPS.has(chip)) {
    throw new TypeError(`${id} uses an unsupported chip: ${chip}`);
  }

  const minimumDesktopVersion = requireString(
    board.minimumDesktopVersion,
    `${id} minimumDesktopVersion`,
    32,
  );
  parseVersion(minimumDesktopVersion);

  if (
    !board.firmware ||
    typeof board.firmware !== 'object' ||
    Array.isArray(board.firmware)
  ) {
    throw new TypeError(`${id} firmware metadata is invalid.`);
  }

  const firmwareVersion = requireString(
    board.firmware.version,
    `${id} firmware version`,
    32,
  );
  parseVersion(firmwareVersion);

  const protocolVersion = requireInteger(
    board.protocolVersion,
    `${id} protocolVersion`,
    1,
    255,
  );

  return {
    id,
    name: requireString(board.name, `${id} name`),
    vendor: requireString(board.vendor, `${id} vendor`, 80),
    hardwareRevision: requireString(
      board.hardwareRevision,
      `${id} hardwareRevision`,
      40,
    ),
    chip,
    protocolVersion,
    minimumDesktopVersion,
    compatible:
      protocolVersion === SUPPORTED_PROTOCOL_VERSION &&
      isVersionAtLeast(appVersion, minimumDesktopVersion),
    usbFilters: validateUsbFilters(board.usbFilters, id),
    capabilities: validateStringList(
      board.capabilities,
      `${id} capabilities`,
      16,
    ),
    deck: validateDeckLimits(board.deck, id),
    recoveryInstructions: validateStringList(
      board.recoveryInstructions,
      `${id} recoveryInstructions`,
      12,
    ),
    firmware: {
      version: firmwareVersion,
      images: validateImages(board.firmware.images, id),
    },
  };
}

function validateCatalog(catalog, appVersion) {
  parseVersion(appVersion);

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('Board catalog must be an object.');
  }

  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported board catalog schema: ${catalog.schemaVersion}`,
    );
  }

  if (
    !Array.isArray(catalog.boards) ||
    catalog.boards.length === 0 ||
    catalog.boards.length > 128
  ) {
    throw new TypeError('Board catalog must contain 1-128 boards.');
  }

  const ids = new Set();
  const boards = catalog.boards.map((board) => {
    const validated = validateBoard(board, appVersion);

    if (ids.has(validated.id)) {
      throw new TypeError(`Duplicate board id: ${validated.id}`);
    }

    ids.add(validated.id);
    return validated;
  });

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt:
      typeof catalog.generatedAt === 'string' ? catalog.generatedAt : null,
    boards,
  };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function readLimitedResponse(response, maximumBytes, onProgress) {
  const declaredLength = Number(response.headers.get('content-length'));

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new Error('Download exceeds the allowed size.');
  }

  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());

    if (data.length > maximumBytes) {
      throw new Error('Download exceeds the allowed size.');
    }

    onProgress?.(data.length, declaredLength || data.length);
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    received += value.byteLength;

    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error('Download exceeds the allowed size.');
    }

    chunks.push(Buffer.from(value));
    onProgress?.(received, declaredLength || null);
  }

  return Buffer.concat(chunks, received);
}

async function writeAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, data);

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  }
}

async function fetchWithTimeout(
  fetcher,
  url,
  options,
  timeoutMs,
  consumeResponse,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      ...options,
      signal: controller.signal,
    });
    return await consumeResponse(response);
  } finally {
    clearTimeout(timeout);
  }
}

function publicBoard(board) {
  return {
    id: board.id,
    name: board.name,
    vendor: board.vendor,
    hardwareRevision: board.hardwareRevision,
    chip: board.chip,
    protocolVersion: board.protocolVersion,
    minimumDesktopVersion: board.minimumDesktopVersion,
    compatible: board.compatible,
    usbFilters: board.usbFilters,
    capabilities: board.capabilities,
    deck: board.deck,
    recoveryInstructions: board.recoveryInstructions,
    firmwareVersion: board.firmware.version,
  };
}

function createBoardService({
  appVersion,
  assetBaseUrl = ASSET_BASE_URL,
  catalogUrl = CATALOG_URL,
  fetcher,
  onDownloadProgress,
  userDataPath,
}) {
  const cacheDirectory = path.join(userDataPath, 'boards');
  const catalogPath = path.join(cacheDirectory, 'catalog-v1.json');
  const etagPath = path.join(cacheDirectory, 'catalog-v1.etag');
  const imageDirectory = path.join(cacheDirectory, 'images');
  let catalogResult = null;
  let catalogRequest = null;
  const imageRequests = new Map();

  async function readCachedCatalog() {
    const text = await readFile(catalogPath, 'utf8');
    return validateCatalog(JSON.parse(text), appVersion);
  }

  async function pruneImageCache(catalog) {
    const activeHashes = new Set(
      catalog.boards.flatMap((board) =>
        board.firmware.images.map((image) => image.sha256),
      ),
    );

    try {
      const entries = await readdir(imageDirectory, {
        withFileTypes: true,
      });

      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith('.bin') &&
              !activeHashes.has(entry.name.slice(0, -4)),
          )
          .map((entry) =>
            rm(path.join(imageDirectory, entry.name), { force: true }),
          ),
      );
    } catch {
      // Cache cleanup must not make a valid catalog unavailable.
    }
  }

  async function getCatalog(force = false) {
    if (catalogResult && !force) {
      return catalogResult;
    }

    if (catalogRequest) {
      return catalogRequest;
    }

    catalogRequest = (async () => {
      let etag = null;

      try {
        etag = (await readFile(etagPath, 'utf8')).trim() || null;
      } catch {
        // The first catalog request has no cache metadata.
      }

      try {
        const headers = { Accept: 'application/json' };

        if (etag) {
          headers['If-None-Match'] = etag;
        }

        const fetched = await fetchWithTimeout(
          fetcher,
          catalogUrl,
          { headers },
          NETWORK_TIMEOUT_MS,
          async (response) => {
            if (response.status === 304) {
              return { notModified: true };
            }

            if (!response.ok) {
              throw new Error(
                `Catalog request failed with HTTP ${response.status}.`,
              );
            }

            return {
              data: await readLimitedResponse(
                response,
                MAX_CATALOG_BYTES,
              ),
              etag: response.headers.get('etag'),
              notModified: false,
            };
          },
        );

        if (fetched.notModified) {
          const catalog = await readCachedCatalog();
          catalogResult = { catalog, source: 'cache', warning: null };
          return catalogResult;
        }

        const { data } = fetched;
        const catalog = validateCatalog(
          JSON.parse(data.toString('utf8')),
          appVersion,
        );

        await writeAtomic(catalogPath, data);
        await pruneImageCache(catalog);

        if (fetched.etag) {
          await writeAtomic(etagPath, `${fetched.etag}\n`);
        }

        catalogResult = { catalog, source: 'network', warning: null };
        return catalogResult;
      } catch (networkError) {
        try {
          const catalog = await readCachedCatalog();
          catalogResult = {
            catalog,
            source: 'cache',
            warning: `Using cached board data: ${networkError.message}`,
          };
          return catalogResult;
        } catch {
          throw new Error(
            `Could not load the Stream32 board catalog: ` +
              networkError.message,
          );
        }
      } finally {
        catalogRequest = null;
      }
    })();

    return catalogRequest;
  }

  async function getBoards(force = false) {
    const result = await getCatalog(force);

    return {
      boards: result.catalog.boards.map(publicBoard),
      source: result.source,
      warning: result.warning,
    };
  }

  async function verifyCachedImage(image) {
    const imagePath = path.join(imageDirectory, `${image.sha256}.bin`);

    try {
      const file = await stat(imagePath);

      if (file.size !== image.size) {
        await rm(imagePath, { force: true });
        return null;
      }

      const data = await readFile(imagePath);

      if (sha256(data) !== image.sha256) {
        await rm(imagePath, { force: true });
        return null;
      }

      if (image.offset === 0 && data[0] !== 0xe9) {
        await rm(imagePath, { force: true });
        return null;
      }

      return { data, imagePath };
    } catch {
      return null;
    }
  }

  async function downloadImage(boardId, image) {
    const cached = await verifyCachedImage(image);

    if (cached) {
      onDownloadProgress?.({
        boardId,
        cached: true,
        received: image.size,
        total: image.size,
      });
      return cached.data;
    }

    if (imageRequests.has(image.sha256)) {
      return imageRequests.get(image.sha256);
    }

    const request = (async () => {
      const url = new URL(encodeURIComponent(image.assetName), assetBaseUrl);
      const data = await fetchWithTimeout(
        fetcher,
        url.toString(),
        {},
        NETWORK_TIMEOUT_MS,
        async (response) => {
          if (!response.ok) {
            throw new Error(
              `Firmware request failed with HTTP ${response.status}.`,
            );
          }

          return readLimitedResponse(
            response,
            image.size,
            (received, total) =>
              onDownloadProgress?.({
                boardId,
                cached: false,
                received,
                total: total || image.size,
              }),
          );
        },
      );

      if (data.length !== image.size) {
        throw new Error('Firmware size does not match the board catalog.');
      }

      if (sha256(data) !== image.sha256) {
        throw new Error('Firmware SHA-256 does not match the board catalog.');
      }

      if (image.offset === 0 && data[0] !== 0xe9) {
        throw new Error('Firmware is not an Espressif boot image.');
      }

      const imagePath = path.join(imageDirectory, `${image.sha256}.bin`);
      await writeAtomic(imagePath, data);
      return data;
    })();

    imageRequests.set(image.sha256, request);

    try {
      return await request;
    } finally {
      imageRequests.delete(image.sha256);
    }
  }

  async function getFirmware(boardId) {
    if (!BOARD_ID_PATTERN.test(boardId)) {
      throw new TypeError('Invalid board id.');
    }

    const result = await getCatalog();
    const board = result.catalog.boards.find((entry) => entry.id === boardId);

    if (!board) {
      throw new Error(`Board is not in the current catalog: ${boardId}`);
    }

    if (!board.compatible) {
      throw new Error(
        `Stream32 ${board.minimumDesktopVersion} or newer is required.`,
      );
    }

    const images = [];

    for (const image of board.firmware.images) {
      const data = await downloadImage(board.id, image);
      images.push({
        address: image.offset,
        data: new Uint8Array(data),
      });
    }

    return {
      board: publicBoard(board),
      images,
    };
  }

  return {
    getBoards,
    getFirmware,
  };
}

function createDefaultBoardService(onDownloadProgress) {
  const isDevelopmentOverride = !app.isPackaged;

  return createBoardService({
    appVersion: app.getVersion(),
    assetBaseUrl:
      (isDevelopmentOverride &&
        process.env.STREAM32_BOARD_ASSET_BASE_URL) ||
      ASSET_BASE_URL,
    catalogUrl:
      (isDevelopmentOverride && process.env.STREAM32_BOARD_CATALOG_URL) ||
      CATALOG_URL,
    fetcher: net.fetch,
    onDownloadProgress,
    userDataPath: app.getPath('userData'),
  });
}

module.exports = {
  ASSET_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  CATALOG_URL,
  createBoardService,
  createDefaultBoardService,
  isVersionAtLeast,
  readLimitedResponse,
  sha256,
  validateCatalog,
};
