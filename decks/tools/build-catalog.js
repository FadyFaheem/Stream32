// Builds the community deck catalog published to the `decks-current` release.
//
// The index in decks/index.json names each shared profile and its export file.
// This tool validates every export with the same importer the desktop app uses,
// then stamps each entry with the byte size and SHA-256 the client verifies
// before it will parse a download. Nothing here trusts the index: a submitted
// profile that does not import is a build failure, not a runtime surprise.

const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const { importProfile } = require('../../desktop/src/deck-model');

const CATALOG_SCHEMA_VERSION = 1;
const MAX_CATALOG_ENTRIES = 256;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

function fail(message) {
  throw new Error(message);
}

function requireString(value, field, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    fail(`${field} is invalid.`);
  }

  return value;
}

function buildCatalog({
  sourceDirectory = path.resolve(__dirname, '..'),
  readAsset = (filePath) => readFileSync(filePath),
} = {}) {
  const index = JSON.parse(
    readAsset(path.join(sourceDirectory, 'index.json')).toString('utf8'),
  );

  if (index?.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    fail('decks/index.json has an unsupported schema version.');
  }

  if (!Array.isArray(index.decks) || index.decks.length > MAX_CATALOG_ENTRIES) {
    fail(`decks/index.json must list 0-${MAX_CATALOG_ENTRIES} decks.`);
  }

  const seenIds = new Set();
  const seenAssets = new Set();
  const decks = index.decks.map((entry) => {
    const id = requireString(entry?.id, 'Deck id', 64);

    if (!ID_PATTERN.test(id)) {
      fail(`Deck id is invalid: ${id}`);
    }

    if (seenIds.has(id)) {
      fail(`Duplicate deck id: ${id}`);
    }

    seenIds.add(id);
    const asset = `${id}.json`;

    if (!ASSET_NAME_PATTERN.test(asset)) {
      fail(`Deck asset name is invalid: ${asset}`);
    }

    if (seenAssets.has(asset)) {
      fail(`Duplicate deck asset: ${asset}`);
    }

    seenAssets.add(asset);
    const source = requireString(entry?.source, `Deck ${id} source`, 256);

    if (!/^profiles\/[a-z0-9][a-z0-9.-]{0,126}\.json$/.test(source)) {
      fail(`Deck ${id} source must be a file under decks/profiles/.`);
    }

    const body = readAsset(path.join(sourceDirectory, source));

    if (body.length < 1 || body.length > MAX_PROFILE_BYTES) {
      fail(`Deck ${id} is empty or larger than ${MAX_PROFILE_BYTES} bytes.`);
    }

    // The gate that matters: a submitted profile must import cleanly, so a
    // broken or hostile export never reaches the published catalog.
    try {
      importProfile(body.toString('utf8'));
    } catch (error) {
      fail(`Deck ${id} is not a valid Stream32 profile export: ${error.message}`);
    }

    const tags = entry?.tags ?? [];

    if (!Array.isArray(tags) || tags.length > 8) {
      fail(`Deck ${id} may declare at most 8 tags.`);
    }

    for (const tag of tags) {
      if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
        fail(`Deck ${id} has an invalid tag: ${tag}`);
      }
    }

    const built = {
      id,
      asset,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
      name: requireString(entry?.name, `Deck ${id} name`, 60),
      author: requireString(entry?.author, `Deck ${id} author`, 60),
      tags,
    };

    if (entry?.summary !== undefined) {
      built.summary = requireString(entry.summary, `Deck ${id} summary`, 200);
    }

    if (entry?.board !== undefined) {
      built.board = requireString(entry.board, `Deck ${id} board`, 64);
    }

    return { entry: built, body, source };
  });

  return {
    catalog: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      decks: decks.map(({ entry }) => entry),
    },
    assets: decks.map(({ entry, body }) => ({ name: entry.asset, body })),
  };
}

function main(argv) {
  const validateOnly = argv.includes('--validate-only');
  const { catalog, assets } = buildCatalog();

  if (validateOnly) {
    process.stdout.write(
      `decks/index.json is valid (${catalog.decks.length} deck` +
      `${catalog.decks.length === 1 ? '' : 's'}).\n`,
    );
    return;
  }

  const outputDirectory = path.resolve(__dirname, '..', 'dist');
  const assetDirectory = path.join(outputDirectory, 'assets');
  mkdirSync(assetDirectory, { recursive: true });

  for (const asset of assets) {
    writeFileSync(path.join(assetDirectory, asset.name), asset.body);
  }

  writeFileSync(
    path.join(outputDirectory, 'catalog-v1.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  process.stdout.write(
    `Wrote ${assets.length + 1} file${assets.length === 0 ? '' : 's'} to ` +
    `${outputDirectory}\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MAX_CATALOG_ENTRIES, MAX_PROFILE_BYTES, buildCatalog };
