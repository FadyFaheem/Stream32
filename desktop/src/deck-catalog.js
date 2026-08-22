// The community gallery: a curated index of shared deck profiles.
//
// It deliberately reuses the plugin catalog's shape rather than introducing a
// server. A GitHub Release holds the index and the profile exports, entries
// carry a SHA-256 and a byte size, and installing one runs the same importer
// used by the Import button. That means:
//
//   no accounts, no captcha, no database, and nothing to moderate at runtime
//   submissions are pull requests, so identity and review come from GitHub
//   a downloaded profile is verified before it is parsed, and validated by the
//   normal deck importer before it reaches decks.json
//
// A shared profile is ordinary data. It cannot carry code, because deck actions
// are a closed set validated on import; the worst a malicious entry can do is
// describe a Launch action, which is exactly what a local profile can already
// do and is visible in the editor before it runs.

const { createHash } = require('node:crypto');
const { readFile, mkdir, stat } = require('node:fs/promises');
const path = require('node:path');

const { writeJsonAtomic } = require('./atomic-json');
const { importProfile } = require('./deck-model');

const CATALOG_SCHEMA_VERSION = 1;
const SHARE_GUIDE_URL =
  'https://github.com/FadyFaheem/Stream32/blob/main/decks/README.md';
const CATALOG_URL =
  'https://github.com/FadyFaheem/Stream32/releases/download/' +
  'decks-current/catalog-v1.json';
const ASSET_BASE_URL =
  'https://github.com/FadyFaheem/Stream32/releases/download/decks-current/';
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_CATALOG_ENTRIES = 256;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NAME_LENGTH = 60;
const MAX_AUTHOR_LENGTH = 60;
const MAX_SUMMARY_LENGTH = 200;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

function requireString(value, field, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new TypeError(`${field} is invalid.`);
  }

  return value;
}

function optionalString(value, field, maximumLength) {
  return value === undefined
    ? undefined
    : requireString(value, field, maximumLength);
}

function validateTags(tags) {
  if (tags === undefined) {
    return [];
  }

  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw new TypeError(`Deck catalog tags must be 0-${MAX_TAGS} entries.`);
  }

  return tags.map((tag) => {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
      throw new TypeError('Deck catalog tag is invalid.');
    }

    return tag;
  });
}

function validateEntry(entry, seenIds, seenAssets) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('Deck catalog entry is invalid.');
  }

  const id = requireString(entry.id, 'Deck catalog id', 64);

  if (!ID_PATTERN.test(id)) {
    throw new TypeError(`Deck catalog id is invalid: ${id}`);
  }

  if (seenIds.has(id)) {
    throw new TypeError(`Deck catalog contains a duplicate id: ${id}`);
  }

  seenIds.add(id);
  const asset = requireString(entry.asset, 'Deck catalog asset', 128);

  if (!ASSET_NAME_PATTERN.test(asset)) {
    throw new TypeError(`Deck catalog asset name is invalid: ${asset}`);
  }

  if (seenAssets.has(asset)) {
    throw new TypeError(`Deck catalog contains a duplicate asset: ${asset}`);
  }

  seenAssets.add(asset);

  if (typeof entry.sha256 !== 'string' || !HASH_PATTERN.test(entry.sha256)) {
    throw new TypeError(`Deck catalog entry ${id} has an invalid sha256.`);
  }

  if (
    !Number.isInteger(entry.bytes) ||
    entry.bytes < 1 ||
    entry.bytes > MAX_PROFILE_BYTES
  ) {
    throw new TypeError(`Deck catalog entry ${id} has an invalid byte size.`);
  }

  const validated = {
    id,
    asset,
    sha256: entry.sha256,
    bytes: entry.bytes,
    name: requireString(entry.name, 'Deck catalog name', MAX_NAME_LENGTH),
    author: requireString(
      entry.author,
      'Deck catalog author',
      MAX_AUTHOR_LENGTH,
    ),
    tags: validateTags(entry.tags),
  };
  const summary = optionalString(
    entry.summary,
    'Deck catalog summary',
    MAX_SUMMARY_LENGTH,
  );
  // Board and key count are advisory: a profile still imports onto a different
  // board, it just may not fill the grid.
  const board = optionalString(entry.board, 'Deck catalog board', 64);

  if (summary !== undefined) {
    validated.summary = summary;
  }

  if (board !== undefined) {
    validated.board = board;
  }

  return validated;
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('Deck catalog must be an object.');
  }

  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new TypeError('Deck catalog has an unsupported schema version.');
  }

  if (
    !Array.isArray(catalog.decks) ||
    catalog.decks.length > MAX_CATALOG_ENTRIES
  ) {
    throw new TypeError(
      `Deck catalog must contain 0-${MAX_CATALOG_ENTRIES} entries.`,
    );
  }

  const seenIds = new Set();
  const seenAssets = new Set();
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    decks: catalog.decks.map((entry) =>
      validateEntry(entry, seenIds, seenAssets)),
  };
}

async function readLimitedResponse(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
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

async function fetchWithTimeout(fetcher, url, consumeResponse) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  try {
    const response = await fetcher(url, { signal: controller.signal });
    return await consumeResponse(response);
  } finally {
    clearTimeout(timeout);
  }
}

function createDeckCatalogService({
  assetBaseUrl = ASSET_BASE_URL,
  catalogUrl = CATALOG_URL,
  fetcher,
  userDataPath,
  writeCatalog = writeJsonAtomic,
}) {
  const cacheDirectory = path.join(userDataPath, 'deck-catalog');
  const catalogPath = path.join(cacheDirectory, 'catalog-v1.json');
  let cached = null;

  async function readCachedCatalog() {
    const file = await stat(catalogPath);

    if (file.size < 1 || file.size > MAX_CATALOG_BYTES) {
      throw new Error('Cached deck catalog exceeds the supported size.');
    }

    return validateCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
  }

  // A refresh that fails falls back to the last good catalog, so the gallery
  // still lists something offline instead of emptying itself.
  async function list(force = false) {
    if (cached && !force) {
      return { ...cached, stale: false };
    }

    try {
      const body = await fetchWithTimeout(
        fetcher,
        catalogUrl,
        async (response) => {
          if (!response.ok) {
            throw new Error(
              `The deck catalog could not be downloaded (HTTP ${response.status}).`,
            );
          }

          return readLimitedResponse(response, MAX_CATALOG_BYTES);
        },
      );
      const catalog = validateCatalog(JSON.parse(body.toString('utf8')));
      cached = catalog;
      await mkdir(cacheDirectory, { recursive: true });
      await writeCatalog(catalog, catalogPath);
      return { ...catalog, stale: false };
    } catch (error) {
      try {
        cached = await readCachedCatalog();
        return { ...cached, stale: true, reason: error.message };
      } catch {
        throw error;
      }
    }
  }

  // The hash is checked before the bytes are parsed, so a tampered or truncated
  // asset never reaches the importer.
  async function download(id) {
    const catalog = cached || (await list());
    const entry = catalog.decks.find((deck) => deck.id === id);

    if (!entry) {
      throw new Error('That shared deck is not in the catalog.');
    }

    const body = await fetchWithTimeout(
      fetcher,
      new URL(entry.asset, assetBaseUrl).toString(),
      async (response) => {
        if (!response.ok) {
          throw new Error(
            `${entry.name} could not be downloaded (HTTP ${response.status}).`,
          );
        }

        return readLimitedResponse(response, entry.bytes);
      },
    );

    if (body.length !== entry.bytes) {
      throw new Error(`${entry.name} does not match its published size.`);
    }

    const digest = createHash('sha256').update(body).digest('hex');

    if (digest !== entry.sha256) {
      throw new Error(`${entry.name} does not match its published checksum.`);
    }

    return { entry, profile: importProfile(body.toString('utf8')) };
  }

  return { download, list };
}

module.exports = {
  ASSET_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  CATALOG_URL,
  MAX_CATALOG_ENTRIES,
  MAX_PROFILE_BYTES,
  SHARE_GUIDE_URL,
  createDeckCatalogService,
  validateCatalog,
};
