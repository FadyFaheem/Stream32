// Pure SemVer helpers shared by the main-process board catalog and the
// renderer Device Manager. Kept free of Node and Electron imports so it can be
// bundled into the browser renderer without pulling in platform modules.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

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

// Strictly newer, so equal versions never advertise an update.
function isVersionNewer(version, baseline) {
  return version !== baseline && isVersionAtLeast(version, baseline);
}

module.exports = {
  VERSION_PATTERN,
  isVersionAtLeast,
  isVersionNewer,
  parseVersion,
};
