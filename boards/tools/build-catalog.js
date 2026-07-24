const { createHash } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const {
  reusePublishedImage,
  selectAffectedProfiles,
} = require('./catalog-helpers');

const boardsDirectory = path.resolve(__dirname, '..');
const sourceCatalogPath = path.join(boardsDirectory, 'catalog.json');
const outputDirectory = path.join(boardsDirectory, 'dist');
const validateOnly = process.argv.includes('--validate-only');
const matrixOnly = process.argv.includes('--matrix');
const changedStdin = process.argv.includes('--changed-stdin');
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROFILE_PATH_PATTERN = /^[a-z0-9][a-z0-9./-]+\.json$/;
const IMAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.bin$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const POST_FLASH_RESETS = new Set(['automatic', 'manual']);
// idfTarget feeds the CI build matrix; bootOffset is where the chip's ROM
// expects the second-stage bootloader, i.e. where the 0xE9 image magic sits
// inside a merged image flashed at 0x0.
const SUPPORTED_CHIPS = new Map([
  ['ESP32-S3', { bootOffset: 0x0, idfTarget: 'esp32s3' }],
  ['ESP32-P4', { bootOffset: 0x2000, idfTarget: 'esp32p4' }],
]);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Could not read ${filePath}: ${error.message}`);
  }
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);

  if (index < 0) {
    return null;
  }

  const value = process.argv[index + 1];

  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a file path.`);
  }

  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string.`);
  }

  return value;
}

function requireInteger(value, field, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${field} is outside the supported range.`);
  }

  return value;
}

function validateStringList(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${field} must be a non-empty array.`);
  }

  return values.map((value, index) =>
    requireString(value, `${field}[${index}]`),
  );
}

function validateProfile(source, profilePath) {
  const id = requireString(source.id, `${profilePath} id`);

  if (!BOARD_ID_PATTERN.test(id)) {
    fail(`${profilePath} has an invalid board id.`);
  }

  if (source.schemaVersion !== 1) {
    fail(`${profilePath} uses an unsupported schema.`);
  }

  if (
    !Array.isArray(source.usbFilters) ||
    source.usbFilters.length === 0
  ) {
    fail(`${profilePath} must define USB filters.`);
  }

  const usbFilters = source.usbFilters.map((filter, index) => ({
    usbVendorId: requireInteger(
      filter.usbVendorId,
      `${profilePath} usbVendorId ${index}`,
      0,
      0xffff,
    ),
    usbProductId: requireInteger(
      filter.usbProductId,
      `${profilePath} usbProductId ${index}`,
      0,
      0xffff,
    ),
  }));

  if (!source.firmware || typeof source.firmware !== 'object') {
    fail(`${profilePath} firmware metadata is missing.`);
  }

  const version = requireString(
    source.firmware.version,
    `${profilePath} firmware version`,
  );

  if (!VERSION_PATTERN.test(version)) {
    fail(`${profilePath} firmware version is invalid.`);
  }

  const minimumDesktopVersion = requireString(
    source.minimumDesktopVersion,
    `${profilePath} minimumDesktopVersion`,
  );

  if (!VERSION_PATTERN.test(minimumDesktopVersion)) {
    fail(`${profilePath} minimum desktop version is invalid.`);
  }

  const chip = requireString(source.chip, `${profilePath} chip`);
  if (!SUPPORTED_CHIPS.has(chip)) {
    fail(`${profilePath} uses a chip unsupported by catalog schema 1.`);
  }

  const protocolVersion = requireInteger(
    source.protocolVersion,
    `${profilePath} protocolVersion`,
    1,
    255,
  );

  if (protocolVersion !== 1) {
    fail(`${profilePath} uses a protocol unsupported by catalog schema 1.`);
  }

  const preferredFlashBaud = requireInteger(
    source.preferredFlashBaud ?? 460800,
    `${profilePath} preferredFlashBaud`,
    115200,
    2000000,
  );
  const postFlashReset = source.postFlashReset ?? 'automatic';

  if (!POST_FLASH_RESETS.has(postFlashReset)) {
    fail(`${profilePath} postFlashReset must be automatic or manual.`);
  }

  const projectPath = requireString(
    source.firmware.projectPath,
    `${profilePath} projectPath`,
  );

  if (
    path.isAbsolute(projectPath) ||
    projectPath.split(/[\\/]/).includes('..')
  ) {
    fail(`${profilePath} firmware project path is unsafe.`);
  }

  const imageName = requireString(
    source.firmware.imageName,
    `${profilePath} imageName`,
  );

  if (!IMAGE_NAME_PATTERN.test(imageName)) {
    fail(`${profilePath} image name is unsafe.`);
  }

  const profileDirectory = path.dirname(profilePath);
  const firmwareDirectory = path.join(profileDirectory, projectPath);
  const cmakePath = path.join(firmwareDirectory, 'CMakeLists.txt');

  if (!existsSync(cmakePath)) {
    fail(`${profilePath} firmware CMakeLists.txt is missing.`);
  }

  const cmake = readFileSync(cmakePath, 'utf8');
  if (!cmake.includes(`set(PROJECT_VER "${version}")`)) {
    fail(`${profilePath} firmware version does not match CMakeLists.txt.`);
  }

  let deck;

  if (source.deck !== undefined) {
    if (
      !source.deck ||
      typeof source.deck !== 'object' ||
      Array.isArray(source.deck)
    ) {
      fail(`${profilePath} deck limits are invalid.`);
    }

    // Caps mirror the protocol ceiling: grids up to 10 in either
    // direction, bounded by maxKeys per page. Budgets above 30 keys
    // require firmware built for the extended (8 KB) layout line; the
    // baseline 4096-byte line fits 30 fully decorated keys.
    const maxRows = requireInteger(
      source.deck.maxRows ?? 5,
      `${profilePath} deck maxRows`,
      1,
      10,
    );
    const maxCols = requireInteger(
      source.deck.maxCols ?? 5,
      `${profilePath} deck maxCols`,
      1,
      10,
    );

    deck = {
      maxRows,
      maxCols,
      maxKeys: requireInteger(
        source.deck.maxKeys ?? Math.min(maxRows * maxCols, 30),
        `${profilePath} deck maxKeys`,
        1,
        40,
      ),
      maxPages: requireInteger(
        source.deck.maxPages ?? 8,
        `${profilePath} deck maxPages`,
        1,
        8,
      ),
    };
  }

  return {
    id,
    name: requireString(source.name, `${profilePath} name`),
    vendor: requireString(source.vendor, `${profilePath} vendor`),
    hardwareRevision: requireString(
      source.hardwareRevision,
      `${profilePath} hardwareRevision`,
    ),
    chip,
    protocolVersion,
    minimumDesktopVersion,
    preferredFlashBaud,
    postFlashReset,
    usbFilters,
    ...(deck ? { deck } : {}),
    firmware: {
      imageName,
      offset: requireInteger(
        source.firmware.offset,
        `${profilePath} firmware offset`,
        0,
        32 * 1024 * 1024,
      ),
      projectPath,
      version,
    },
    capabilities: validateStringList(
      source.capabilities,
      `${profilePath} capabilities`,
    ),
    recoveryInstructions: validateStringList(
      source.recoveryInstructions,
      `${profilePath} recoveryInstructions`,
    ),
  };
}

const sourceCatalog = readJson(sourceCatalogPath);

if (
  sourceCatalog.schemaVersion !== 1 ||
  !Array.isArray(sourceCatalog.boards) ||
  sourceCatalog.boards.length === 0
) {
  fail('boards/catalog.json is invalid or empty.');
}

const ids = new Set();
const imageNames = new Set();
const profiles = sourceCatalog.boards.map((relativeProfilePath) => {
  if (
    typeof relativeProfilePath !== 'string' ||
    !PROFILE_PATH_PATTERN.test(relativeProfilePath) ||
    relativeProfilePath.split('/').includes('..')
  ) {
    fail(`Unsafe board profile path: ${relativeProfilePath}`);
  }

  const profilePath = path.join(boardsDirectory, relativeProfilePath);
  const profile = validateProfile(readJson(profilePath), profilePath);

  if (ids.has(profile.id)) {
    fail(`Duplicate board id: ${profile.id}`);
  }

  if (imageNames.has(profile.firmware.imageName)) {
    fail(`Duplicate firmware image name: ${profile.firmware.imageName}`);
  }

  ids.add(profile.id);
  imageNames.add(profile.firmware.imageName);
  return { ...profile, sourcePath: relativeProfilePath };
});

if (matrixOnly) {
  const matrixProfiles = changedStdin
    ? selectAffectedProfiles(
        profiles,
        readFileSync(0, 'utf8').split(/\r?\n/),
      )
    : profiles;

  console.log(
    JSON.stringify({
      include: matrixProfiles.map((profile) => ({
        id: profile.id,
        path: path.posix.join(
          'boards',
          path.posix.dirname(profile.sourcePath),
          profile.firmware.projectPath,
        ),
        target: SUPPORTED_CHIPS.get(profile.chip).idfTarget,
      })),
    }),
  );
  process.exit(0);
}

if (validateOnly) {
  console.log(`Validated ${profiles.length} board profile(s).`);
  process.exit(0);
}

const previousCatalogPath = argumentValue('--previous-catalog');
const previousCatalog = previousCatalogPath
  ? readJson(path.resolve(previousCatalogPath))
  : null;

const boards = profiles.map((profile) => {
  const imagePath = path.join(outputDirectory, profile.firmware.imageName);
  let imageMetadata;

  if (existsSync(imagePath)) {
    const image = readFileSync(imagePath);
    const size = statSync(imagePath).size;
    const hash = createHash('sha256').update(image).digest('hex');
    const { bootOffset } = SUPPORTED_CHIPS.get(profile.chip);

    if (image[bootOffset] !== 0xe9) {
      fail(`${imagePath} is not an Espressif boot image.`);
    }

    imageMetadata = {
      assetName: profile.firmware.imageName,
      offset: profile.firmware.offset,
      size,
      sha256: hash,
    };
  } else {
    try {
      imageMetadata = reusePublishedImage(profile, previousCatalog);
    } catch (error) {
      fail(`Built firmware image is missing: ${imagePath}. ${error.message}`);
    }
  }

  return {
    id: profile.id,
    name: profile.name,
    vendor: profile.vendor,
    hardwareRevision: profile.hardwareRevision,
    chip: profile.chip,
    protocolVersion: profile.protocolVersion,
    minimumDesktopVersion: profile.minimumDesktopVersion,
    preferredFlashBaud: profile.preferredFlashBaud,
    postFlashReset: profile.postFlashReset,
    usbFilters: profile.usbFilters,
    ...(profile.deck ? { deck: profile.deck } : {}),
    capabilities: profile.capabilities,
    recoveryInstructions: profile.recoveryInstructions,
    firmware: {
      version: profile.firmware.version,
      images: [imageMetadata],
    },
  };
});

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  path.join(outputDirectory, 'catalog-v1.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      boards,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`Built catalog-v1.json with ${boards.length} board profile(s).`);
