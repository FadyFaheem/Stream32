const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createDeckCatalogService,
  validateCatalog,
} = require('../src/deck-catalog');
const { searchCatalog } = require('../src/renderer/community');

const PROFILE = `${JSON.stringify({
  stream32Deck: 5,
  profile: {
    id: 'shared',
    boardId: 'crowpanel-10',
    name: 'Streaming',
    defaultPage: 0,
    activePage: 0,
    appMatches: {},
    pages: [
      {
        name: 'Main',
        appMatches: {},
        rows: 2,
        cols: 2,
        keys: [{ index: 0, label: 'Go', action: { type: 'sleep' } }],
      },
    ],
  },
}, null, 2)}\n`;

function entryFor(body, overrides = {}) {
  return {
    id: 'streaming',
    asset: 'streaming.json',
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: Buffer.byteLength(body),
    name: 'Streaming',
    author: 'someone',
    summary: 'A scene switcher.',
    board: 'crowpanel-10',
    tags: ['obs', 'streaming'],
    ...overrides,
  };
}

function catalogFor(entry) {
  return { schemaVersion: 1, decks: [entry] };
}

function fetcherFor(catalog, body) {
  return async (url) => {
    if (String(url).endsWith('catalog-v1.json')) {
      return {
        ok: true,
        headers: new Map([['content-length', null]]),
        arrayBuffer: async () => Buffer.from(JSON.stringify(catalog)),
      };
    }

    return {
      ok: true,
      headers: new Map([['content-length', null]]),
      arrayBuffer: async () => Buffer.from(body),
    };
  };
}

async function serviceFor(catalog, body) {
  return createDeckCatalogService({
    fetcher: fetcherFor(catalog, body),
    userDataPath: await mkdtemp(path.join(os.tmpdir(), 'stream32-catalog-')),
  });
}

test('a catalog entry is normalized and duplicates are rejected', () => {
  const catalog = validateCatalog(catalogFor(entryFor(PROFILE)));
  assert.equal(catalog.decks[0].name, 'Streaming');
  assert.deepEqual(catalog.decks[0].tags, ['obs', 'streaming']);
  assert.throws(
    () => validateCatalog({
      schemaVersion: 1,
      decks: [entryFor(PROFILE), entryFor(PROFILE, { asset: 'other.json' })],
    }),
    /duplicate id/,
  );
  assert.throws(
    () => validateCatalog({ schemaVersion: 2, decks: [] }),
    /unsupported schema version/,
  );
});

test('a catalog entry rejects a bad hash, size, or asset name', () => {
  for (const overrides of [
    { sha256: 'nothex' },
    { bytes: 0 },
    { asset: '../escape.json' },
    { asset: 'nested/path.json' },
    { tags: ['Not Lowercase'] },
    { author: '' },
  ]) {
    assert.throws(
      () => validateCatalog(catalogFor(entryFor(PROFILE, overrides))),
      TypeError,
    );
  }
});

test('an empty catalog is valid so the gallery can launch with nothing in it', () => {
  assert.deepEqual(validateCatalog({ schemaVersion: 1, decks: [] }), {
    schemaVersion: 1,
    decks: [],
  });
});

test('a verified download is imported as a profile', async () => {
  const service = await serviceFor(catalogFor(entryFor(PROFILE)), PROFILE);
  const listing = await service.list(false);
  assert.equal(listing.decks.length, 1);
  const { entry, profile } = await service.download('streaming');
  assert.equal(entry.id, 'streaming');
  assert.equal(profile.name, 'Streaming');
  assert.equal(profile.pages.length, 1);
});

test('a download whose bytes do not match its checksum is refused', async () => {
  const tampered = PROFILE.replace('Streaming', 'Tampered!');
  const service = await serviceFor(catalogFor(entryFor(PROFILE)), tampered);
  await service.list(false);
  await assert.rejects(
    service.download('streaming'),
    /does not match its published/,
  );
});

test('an unknown id is refused before any download', async () => {
  const service = await serviceFor(catalogFor(entryFor(PROFILE)), PROFILE);
  await service.list(false);
  await assert.rejects(service.download('nope'), /not in the catalog/);
});

test('a failed refresh falls back to the cached catalog and says so', async () => {
  const catalog = catalogFor(entryFor(PROFILE));
  let online = true;
  const service = createDeckCatalogService({
    async fetcher(url) {
      if (!online) {
        throw new Error('offline');
      }

      return fetcherFor(catalog, PROFILE)(url);
    },
    userDataPath: await mkdtemp(path.join(os.tmpdir(), 'stream32-catalog-')),
  });
  await service.list(false);
  online = false;
  const stale = await service.list(true);
  assert.equal(stale.stale, true);
  assert.equal(stale.decks.length, 1);
  assert.match(stale.reason, /offline/);
});

test('search matches name, author, board, and tags', () => {
  const decks = validateCatalog({
    schemaVersion: 1,
    decks: [
      entryFor(PROFILE),
      entryFor(PROFILE, {
        id: 'editing',
        asset: 'editing.json',
        name: 'Editing',
        author: 'someone-else',
        board: 'waveshare-4',
        tags: ['premiere'],
        summary: 'Timeline shortcuts.',
      }),
    ],
  }).decks;
  assert.deepEqual(searchCatalog(decks, '').length, 2);
  assert.deepEqual(searchCatalog(decks, 'obs').map((d) => d.id), ['streaming']);
  assert.deepEqual(
    searchCatalog(decks, 'waveshare').map((d) => d.id),
    ['editing'],
  );
  assert.deepEqual(
    searchCatalog(decks, 'someone-else premiere').map((d) => d.id),
    ['editing'],
  );
  assert.deepEqual(searchCatalog(decks, 'nothing').length, 0);
});
