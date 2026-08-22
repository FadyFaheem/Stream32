const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { buildCatalog } = require('./build-catalog');

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

function withIndex(decks, files = {}) {
  const contents = {
    'index.json': JSON.stringify({ schemaVersion: 1, decks }),
    ...files,
  };
  return buildCatalog({
    sourceDirectory: '',
    readAsset(filePath) {
      const name = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
      const body = contents[name];

      if (body === undefined) {
        throw new Error(`missing ${name}`);
      }

      return Buffer.from(body);
    },
  });
}

test('a valid index becomes a catalog with sizes and hashes', () => {
  const { catalog, assets } = withIndex(
    [
      {
        id: 'streaming',
        source: 'profiles/streaming.json',
        name: 'Streaming',
        author: 'someone',
        summary: 'Scene switching.',
        board: 'crowpanel-10',
        tags: ['obs'],
      },
    ],
    { 'profiles/streaming.json': PROFILE },
  );
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.decks[0], {
    id: 'streaming',
    asset: 'streaming.json',
    sha256: createHash('sha256').update(PROFILE).digest('hex'),
    bytes: Buffer.byteLength(PROFILE),
    name: 'Streaming',
    author: 'someone',
    tags: ['obs'],
    summary: 'Scene switching.',
    board: 'crowpanel-10',
  });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, 'streaming.json');
});

test('a profile that does not import fails the build', () => {
  assert.throws(
    () => withIndex(
      [{
        id: 'broken',
        source: 'profiles/broken.json',
        name: 'Broken',
        author: 'someone',
      }],
      { 'profiles/broken.json': '{"stream32Deck":5,"profile":{}}' },
    ),
    /not a valid Stream32 profile export/,
  );
});

test('the index rejects duplicates and paths outside profiles', () => {
  const entry = {
    id: 'streaming',
    source: 'profiles/streaming.json',
    name: 'Streaming',
    author: 'someone',
  };
  assert.throws(
    () => withIndex([entry, entry], { 'profiles/streaming.json': PROFILE }),
    /Duplicate deck id/,
  );
  assert.throws(
    () => withIndex(
      [{ ...entry, source: '../../desktop/package.json' }],
      { 'profiles/streaming.json': PROFILE },
    ),
    /must be a file under decks\/profiles\//,
  );
  assert.throws(
    () => withIndex(
      [{ ...entry, id: 'Not Lowercase' }],
      { 'profiles/streaming.json': PROFILE },
    ),
    /Deck id is invalid/,
  );
  assert.throws(
    () => withIndex(
      [{ ...entry, tags: ['Not Lowercase'] }],
      { 'profiles/streaming.json': PROFILE },
    ),
    /invalid tag/,
  );
});

test('an empty index builds an empty catalog', () => {
  const { catalog, assets } = withIndex([], {});
  assert.deepEqual(catalog, { schemaVersion: 1, decks: [] });
  assert.deepEqual(assets, []);
});
