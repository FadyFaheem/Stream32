const { createHash } = require('node:crypto');
const {
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const { validatePluginManifest } = require('../../desktop/src/plugin-manifest');

const CATALOG_SCHEMA_VERSION = 1;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_CATALOG_ENTRIES = 64;
const MAX_MANIFEST_BYTES = 256 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_NAME_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,63}-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?\.json$/;
const SOURCE_PATH_PATTERN =
  /^manifests\/[a-z0-9][a-z0-9.-]{0,126}\.json$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?$/;

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

function requireSemver(value, field) {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    fail(`${field} must be a valid semantic version.`);
  }

  return value;
}

function bundledIds(directory) {
  return new Set(
    readdirSync(directory)
      .filter((filename) => filename.endsWith('.json'))
      .map((filename) =>
        validatePluginManifest(
          readJson(path.join(directory, filename)),
        ).id),
  );
}

function buildCatalog({
  bundledDirectory = path.resolve(
    __dirname,
    '..',
    '..',
    'desktop',
    'src',
    'plugins',
  ),
  outputDirectory = path.resolve(__dirname, '..', 'dist'),
  rootDirectory = path.resolve(__dirname, '..'),
  validateOnly = false,
} = {}) {
  const source = readJson(path.join(rootDirectory, 'catalog.json'));

  if (
    source?.schemaVersion !== CATALOG_SCHEMA_VERSION ||
    !Array.isArray(source.plugins) ||
    source.plugins.length === 0 ||
    source.plugins.length > MAX_CATALOG_ENTRIES
  ) {
    fail(`Plugin source catalog must contain 1-${MAX_CATALOG_ENTRIES} entries.`);
  }

  const knownBundledIds = bundledIds(bundledDirectory);
  const ids = new Set();
  const assetNames = new Set();
  const manifestDirectory = realpathSync(path.join(rootDirectory, 'manifests'));
  const assets = [];
  const plugins = source.plugins.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`Plugin source entry ${index} is invalid.`);
    }

    const sourcePath = entry.manifest;

    if (
      typeof sourcePath !== 'string' ||
      !SOURCE_PATH_PATTERN.test(sourcePath) ||
      sourcePath.split('/').includes('..')
    ) {
      fail(`Plugin source entry ${index} has an unsafe manifest path.`);
    }

    const manifestPath = realpathSync(path.join(rootDirectory, sourcePath));
    const relativeRealPath = path.relative(manifestDirectory, manifestPath);

    if (
      relativeRealPath.startsWith('..') ||
      path.isAbsolute(relativeRealPath)
    ) {
      fail(`Plugin source entry ${index} escapes the manifests directory.`);
    }

    const data = readFileSync(manifestPath);

    if (data.length === 0 || data.length > MAX_MANIFEST_BYTES) {
      fail(`Plugin manifest ${sourcePath} exceeds the supported size.`);
    }

    let manifest;

    try {
      manifest = validatePluginManifest(JSON.parse(data.toString('utf8')));
    } catch (error) {
      fail(`Plugin manifest ${sourcePath} is invalid: ${error.message}`);
    }

    requireSemver(manifest.version, `${manifest.id} version`);

    if (!ID_PATTERN.test(manifest.id)) {
      fail(`Plugin ${manifest.id} has an unstable id.`);
    }

    if (knownBundledIds.has(manifest.id)) {
      fail(`Curated plugin id collides with bundled plugin ${manifest.id}.`);
    }

    const assetName = path.posix.basename(sourcePath);
    const expectedAssetName = `${manifest.id}-${manifest.version}.json`;

    if (
      !ASSET_NAME_PATTERN.test(assetName) ||
      assetName !== expectedAssetName
    ) {
      fail(
        `Plugin ${manifest.id} asset must be named ${expectedAssetName}.`,
      );
    }

    if (ids.has(manifest.id) || assetNames.has(assetName)) {
      fail(`Duplicate curated plugin id or asset: ${manifest.id}.`);
    }

    ids.add(manifest.id);
    assetNames.add(assetName);
    assets.push({ assetName, data });

    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      assetName,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      minimumDesktopVersion: requireSemver(
        entry.minimumDesktopVersion,
        `${manifest.id} minimumDesktopVersion`,
      ),
    };
  });
  const catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    plugins,
  };
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;

  if (Buffer.byteLength(catalogText) > MAX_CATALOG_BYTES) {
    fail('Generated plugin catalog exceeds the supported size.');
  }

  if (!validateOnly) {
    mkdirSync(outputDirectory, { recursive: true });
    const assetDirectory = path.join(outputDirectory, 'assets');
    mkdirSync(assetDirectory, { recursive: true });

    for (const asset of assets) {
      writeFileSync(path.join(assetDirectory, asset.assetName), asset.data);
    }

    writeFileSync(
      path.join(outputDirectory, 'catalog-v1.json'),
      catalogText,
      'utf8',
    );
  }

  return { assets, catalog };
}

if (require.main === module) {
  const validateOnly = process.argv.includes('--validate-only');
  const { catalog } = buildCatalog({ validateOnly });
  console.log(
    `${validateOnly ? 'Validated' : 'Built'} ${catalog.plugins.length} ` +
      `curated plugin(s).`,
  );
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ENTRIES,
  MAX_MANIFEST_BYTES,
  buildCatalog,
};
