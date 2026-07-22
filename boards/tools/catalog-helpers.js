const path = require('node:path');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const BUILD_ALL_PATHS = new Set([
  '.github/workflows/ci-boards.yml',
  '.github/workflows/release-boards.yml',
  'boards/catalog.json',
]);

function normalizeChangedPath(filePath) {
  return String(filePath).trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function selectAffectedProfiles(profiles, changedFiles) {
  const files = changedFiles.map(normalizeChangedPath).filter(Boolean);

  if (
    files.some(
      (filePath) =>
        BUILD_ALL_PATHS.has(filePath) ||
        filePath.startsWith('boards/common/') ||
        filePath.startsWith('boards/tools/'),
    )
  ) {
    return profiles;
  }

  const knownBoardDirectories = new Map(
    profiles.map((profile) => [
      path.posix.dirname(profile.sourcePath),
      profile,
    ]),
  );
  const affected = new Set();

  for (const filePath of files) {
    if (!filePath.startsWith('boards/') || filePath === 'boards/README.md') {
      continue;
    }

    const relativePath = filePath.slice('boards/'.length);
    const boardDirectory = relativePath.split('/')[0];
    const profile = knownBoardDirectories.get(boardDirectory);

    if (!profile) {
      // Unknown board/tooling paths may affect catalog behavior. Build all
      // known boards rather than silently under-testing the change.
      return profiles;
    }

    affected.add(profile);
  }

  return profiles.filter((profile) => affected.has(profile));
}

function reusePublishedImage(profile, previousCatalog) {
  if (
    !previousCatalog ||
    previousCatalog.schemaVersion !== 1 ||
    !Array.isArray(previousCatalog.boards)
  ) {
    throw new Error('A valid previous catalog is required for unchanged firmware.');
  }

  const board = previousCatalog.boards.find((entry) => entry.id === profile.id);

  if (
    !board ||
    board.firmware?.version !== profile.firmware.version ||
    !Array.isArray(board.firmware.images)
  ) {
    throw new Error(
      `Previous catalog has no matching firmware for ${profile.id} ` +
        `${profile.firmware.version}.`,
    );
  }

  const image = board.firmware.images.find(
    (entry) =>
      entry.assetName === profile.firmware.imageName &&
      entry.offset === profile.firmware.offset,
  );

  if (
    !image ||
    !Number.isSafeInteger(image.size) ||
    image.size < 1 ||
    image.size > MAX_IMAGE_BYTES ||
    typeof image.sha256 !== 'string' ||
    !HASH_PATTERN.test(image.sha256)
  ) {
    throw new Error(
      `Previous catalog image metadata does not match ${profile.id}.`,
    );
  }

  return {
    assetName: image.assetName,
    offset: image.offset,
    sha256: image.sha256,
    size: image.size,
  };
}

module.exports = {
  reusePublishedImage,
  selectAffectedProfiles,
};
