const { createHash } = require('node:crypto');
const { readFile, rm, stat } = require('node:fs/promises');
const path = require('node:path');

const { writeJsonAtomic } = require('./atomic-json');
const { validatePluginManifest } = require('./plugin-manifest');
const { MAX_PLUGIN_BYTES, MAX_PLUGINS } = require('./plugins');

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_URL =
  'https://github.com/FadyFaheem/Stream32/releases/download/' +
  'plugins-current/catalog-v1.json';
const ASSET_BASE_URL =
  'https://github.com/FadyFaheem/Stream32/releases/download/plugins-current/';
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_CATALOG_ENTRIES = 64;
const NETWORK_TIMEOUT_MS = 30_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_NAME_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,63}-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?\.json$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function parseVersion(version) {
  const match = SEMVER_PATTERN.exec(version);

  if (!match) {
    throw new TypeError(`Invalid semantic version: ${version}`);
  }

  return {
    core: match.slice(1, 4).map(BigInt),
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);

  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }

  if (!left.prerelease || !right.prerelease) {
    return left.prerelease ? -1 : right.prerelease ? 1 : 0;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];

    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }

    if (leftPart === rightPart) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);

    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    }

    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function requireString(value, field, maximumLength, allowEmpty = false) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength
  ) {
    throw new TypeError(`${field} is invalid.`);
  }

  return value;
}

function validateCatalog(catalog, appVersion, bundledIds = new Set()) {
  parseVersion(appVersion);

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('Plugin catalog must be an object.');
  }

  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new TypeError('Plugin catalog has an unsupported schema version.');
  }

  if (
    !Array.isArray(catalog.plugins) ||
    catalog.plugins.length === 0 ||
    catalog.plugins.length > MAX_CATALOG_ENTRIES
  ) {
    throw new TypeError(
      `Plugin catalog must contain 1-${MAX_CATALOG_ENTRIES} entries.`,
    );
  }

  const ids = new Set();
  const assetNames = new Set();
  const plugins = catalog.plugins.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Plugin catalog entry is invalid.');
    }

    const id = requireString(entry.id, 'Plugin catalog id', 64);
    const version = requireString(entry.version, `${id} version`, 32);
    const minimumDesktopVersion = requireString(
      entry.minimumDesktopVersion,
      `${id} minimumDesktopVersion`,
      32,
    );
    parseVersion(version);
    parseVersion(minimumDesktopVersion);

    if (!ID_PATTERN.test(id) || bundledIds.has(id)) {
      throw new TypeError(`Plugin catalog id is unsafe or bundled: ${id}`);
    }

    const assetName = requireString(
      entry.assetName,
      `${id} assetName`,
      128,
    );

    if (
      !ASSET_NAME_PATTERN.test(assetName) ||
      assetName !== `${id}-${version}.json` ||
      path.basename(assetName) !== assetName
    ) {
      throw new TypeError(`${id} has an unsafe or mismatched asset name.`);
    }

    if (ids.has(id) || assetNames.has(assetName)) {
      throw new TypeError(`Duplicate plugin catalog id or asset: ${id}`);
    }

    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > MAX_PLUGIN_BYTES
    ) {
      throw new TypeError(`${id} manifest size is invalid.`);
    }

    const sha256 = requireString(entry.sha256, `${id} SHA-256`, 64);

    if (!HASH_PATTERN.test(sha256)) {
      throw new TypeError(`${id} SHA-256 is invalid.`);
    }

    ids.add(id);
    assetNames.add(assetName);
    return {
      id,
      name: requireString(entry.name, `${id} name`, 80),
      description: requireString(
        entry.description,
        `${id} description`,
        240,
        true,
      ),
      version,
      assetName,
      size: entry.size,
      sha256,
      minimumDesktopVersion,
      compatible: compareVersions(appVersion, minimumDesktopVersion) >= 0,
    };
  });

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt:
      typeof catalog.generatedAt === 'string' ? catalog.generatedAt : null,
    plugins,
  };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function readLimitedResponse(response, maximumBytes) {
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
  }

  return Buffer.concat(chunks, received);
}

async function fetchWithTimeout(fetcher, url, options, consumeResponse) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

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

function createPluginCatalogService({
  appVersion,
  assetBaseUrl = ASSET_BASE_URL,
  bundledIds = new Set(),
  catalogUrl = CATALOG_URL,
  fetcher,
  onEvent = () => {},
  pluginService,
  userDataPath,
  writeManifest = writeJsonAtomic,
}) {
  const cacheDirectory = path.join(userDataPath, 'plugin-catalog');
  const catalogPath = path.join(cacheDirectory, 'catalog-v1.json');
  const etagPath = path.join(cacheDirectory, 'catalog-v1.etag.json');
  const userPluginsDirectory = path.join(userDataPath, 'plugins');
  let catalogResult = null;
  let catalogRequest = null;

  function validateId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new TypeError('Plugin id is invalid.');
    }

    return id;
  }

  async function readCachedCatalog() {
    const file = await stat(catalogPath);

    if (file.size < 1 || file.size > MAX_CATALOG_BYTES) {
      throw new Error('Cached plugin catalog exceeds the supported size.');
    }

    return validateCatalog(
      JSON.parse(await readFile(catalogPath, 'utf8')),
      appVersion,
      bundledIds,
    );
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
        const metadata = JSON.parse(await readFile(etagPath, 'utf8'));
        etag = typeof metadata.etag === 'string' ? metadata.etag : null;
      } catch {
        // The first request has no cache metadata.
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
              data: await readLimitedResponse(response, MAX_CATALOG_BYTES),
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

        const rawCatalog = JSON.parse(fetched.data.toString('utf8'));
        const catalog = validateCatalog(rawCatalog, appVersion, bundledIds);
        writeJsonAtomic(rawCatalog, catalogPath, { keepBackup: false });

        if (fetched.etag) {
          try {
            writeJsonAtomic(
              { etag: fetched.etag },
              etagPath,
              { keepBackup: false },
            );
          } catch {
            // A catalog remains usable without conditional request metadata.
          }
        }

        catalogResult = { catalog, source: 'network', warning: null };
        return catalogResult;
      } catch (networkError) {
        try {
          const catalog = await readCachedCatalog();
          catalogResult = {
            catalog,
            source: 'cache',
            warning: `Offline: using cached plugin data (${networkError.message})`,
          };
          return catalogResult;
        } catch {
          throw new Error(
            `Could not load the Stream32 plugin catalog: ${networkError.message}`,
          );
        }
      } finally {
        catalogRequest = null;
      }
    })();

    return catalogRequest;
  }

  function publicListing(result) {
    const registry = pluginService.list();
    const installedById = new Map(
      registry.plugins.map((plugin) => [plugin.id, plugin]),
    );

    return {
      plugins: result.catalog.plugins.map((plugin) => {
        const installed = installedById.get(plugin.id);
        return {
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          version: plugin.version,
          minimumDesktopVersion: plugin.minimumDesktopVersion,
          compatible: plugin.compatible,
          installedVersion: installed?.version || null,
          updateAvailable: Boolean(
            installed &&
              compareVersions(plugin.version, installed.version) > 0,
          ),
        };
      }),
      builtIn: registry.plugins
        .filter((plugin) => plugin.source === 'bundled')
        .map(({ id, name, version, description }) => ({
          id,
          name,
          version,
          description,
        })),
      userInstalled: registry.plugins
        .filter((plugin) => plugin.source === 'user')
        .map(({ id, name, version, description }) => ({
          id,
          name,
          version,
          description,
        })),
      errors: registry.errors,
      source: result.source,
      warning: result.warning,
      userDirectory: registry.userDirectory,
    };
  }

  async function list(force = false) {
    try {
      return publicListing(await getCatalog(force));
    } catch (error) {
      return publicListing({
        catalog: { plugins: [] },
        source: 'offline',
        warning: `Offline: ${error.message}`,
      });
    }
  }

  function errorKey(error) {
    return `${error.file}\u0000${error.message}`;
  }

  function verifyReload(before, after, id, version) {
    const beforeIds = new Set(before.plugins.map((plugin) => plugin.id));
    const afterById = new Map(
      after.plugins.map((plugin) => [plugin.id, plugin]),
    );
    const previousErrors = new Set(before.errors.map(errorKey));
    const installed = afterById.get(id);
    const missingIds = [...beforeIds].filter(
      (pluginId) => !afterById.has(pluginId),
    );
    const newErrors = after.errors.filter(
      (error) => !previousErrors.has(errorKey(error)),
    );

    if (
      installed?.source !== 'user' ||
      installed.version !== version ||
      missingIds.length > 0 ||
      newErrors.length > 0
    ) {
      throw new Error(
        'Plugin registry rejected the curated manifest or omitted an ' +
        'existing plugin.',
      );
    }
  }

  async function install(id) {
    validateId(id);
    const result = await getCatalog();
    const entry = result.catalog.plugins.find((plugin) => plugin.id === id);

    if (!entry) {
      throw new Error(`Plugin is not in the curated catalog: ${id}`);
    }

    if (!entry.compatible) {
      throw new Error(
        `Stream32 ${entry.minimumDesktopVersion} or newer is required.`,
      );
    }

    if (bundledIds.has(id)) {
      throw new Error(`Bundled plugin ${id} cannot be replaced.`);
    }

    const before = pluginService.list();
    const existing = before.plugins.find(
      (plugin) => plugin.id === id,
    );
    const destination = path.join(userPluginsDirectory, `${id}.json`);
    let previousManifest = null;

    if (existing?.source === 'bundled') {
      throw new Error(`Bundled plugin ${id} cannot be replaced.`);
    }

    if (!existing && before.plugins.length >= MAX_PLUGINS) {
      throw new Error(
        `At most ${MAX_PLUGINS} plugins are supported; remove one before installing ${id}.`,
      );
    }

    if (existing?.source === 'user') {
      try {
        const current = validatePluginManifest(
          JSON.parse(await readFile(destination, 'utf8')),
        );

        if (current.id !== id) {
          throw new Error('mismatch');
        }

        previousManifest = current;
      } catch {
        throw new Error(
          `${id} was installed manually under another filename; remove it ` +
            'from the user plugin directory before using curated updates.',
        );
      }
    } else {
      try {
        const current = validatePluginManifest(
          JSON.parse(await readFile(destination, 'utf8')),
        );

        if (current.id !== id) {
          throw new Error('mismatch');
        }

        previousManifest = current;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new Error(
            `Cannot replace the existing ${id}.json user plugin file.`,
          );
        }
      }
    }

    const url = new URL(encodeURIComponent(entry.assetName), assetBaseUrl);
    const data = await fetchWithTimeout(
      fetcher,
      url.toString(),
      {},
      async (response) => {
        if (!response.ok) {
          throw new Error(
            `Plugin request failed with HTTP ${response.status}.`,
          );
        }

        return readLimitedResponse(response, entry.size);
      },
    );

    if (data.length !== entry.size) {
      throw new Error('Plugin size does not match the catalog.');
    }

    if (sha256(data) !== entry.sha256) {
      throw new Error('Plugin SHA-256 does not match the catalog.');
    }

    let manifest;

    try {
      manifest = validatePluginManifest(JSON.parse(data.toString('utf8')));
    } catch (error) {
      throw new Error(`Downloaded plugin manifest is invalid: ${error.message}`);
    }

    if (manifest.id !== entry.id || manifest.version !== entry.version) {
      throw new Error('Downloaded plugin identity does not match the catalog.');
    }

    writeManifest(manifest, destination);

    try {
      verifyReload(
        before,
        pluginService.load(),
        manifest.id,
        manifest.version,
      );
    } catch (error) {
      if (previousManifest) {
        writeManifest(previousManifest, destination);
      } else {
        await rm(destination, { force: true });
      }

      await rm(`${destination}.bak`, { force: true });

      try {
        pluginService.load();
      } catch (rollbackError) {
        throw new Error(
          'Plugin installation failed and the registry could not be reloaded ' +
          'after rollback.',
          { cause: rollbackError },
        );
      }

      throw new Error(`Plugin installation failed: ${error.message}`, {
        cause: error,
      });
    }
    onEvent('installed', { pluginId: id, version: manifest.version });
    return publicListing(result);
  }

  async function remove(id) {
    validateId(id);

    if (bundledIds.has(id)) {
      throw new Error(`Bundled plugin ${id} cannot be removed.`);
    }

    const destination = path.join(userPluginsDirectory, `${id}.json`);
    let manifest;

    try {
      manifest = validatePluginManifest(
        JSON.parse(await readFile(destination, 'utf8')),
      );
    } catch {
      throw new Error(`Curated plugin is not installed: ${id}`);
    }

    if (manifest.id !== id) {
      throw new Error('Installed plugin identity is invalid.');
    }

    await rm(destination);

    try {
      pluginService.load();
    } catch (error) {
      writeManifest(manifest, destination);
      pluginService.load();
      throw error;
    }

    await rm(`${destination}.bak`, { force: true });
    onEvent('removed', { pluginId: id, version: manifest.version });
    return publicListing(await getCatalog());
  }

  async function update(id) {
    validateId(id);
    const installed = pluginService.list().plugins.find(
      (plugin) => plugin.id === id && plugin.source === 'user',
    );
    const result = await getCatalog();
    const entry = result.catalog.plugins.find((plugin) => plugin.id === id);

    if (
      !installed ||
      !entry ||
      compareVersions(entry.version, installed.version) <= 0
    ) {
      throw new Error(`No curated update is available for ${id}.`);
    }

    return install(id);
  }

  return { install, list, remove, update };
}

module.exports = {
  ASSET_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  CATALOG_URL,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ENTRIES,
  compareVersions,
  createPluginCatalogService,
  readLimitedResponse,
  sha256,
  validateCatalog,
};
