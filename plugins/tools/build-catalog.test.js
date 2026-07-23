const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildCatalog } = require('./build-catalog');

function manifest(overrides = {}) {
  return {
    stream32Plugin: 1,
    id: 'test-search',
    name: 'Test Search',
    version: '1.2.3',
    description: 'Search safely.',
    actions: [
      {
        id: 'search',
        name: 'Search',
        fields: [],
        platforms: {
          win32: {
            type: 'url',
            url: 'https://example.com/search',
            query: {},
          },
        },
      },
    ],
    ...overrides,
  };
}

function fixture(rawManifest = manifest()) {
  const rootDirectory = mkdtempSync(
    path.join(os.tmpdir(), 'stream32-plugin-catalog-'),
  );
  const bundledDirectory = path.join(rootDirectory, 'bundled');
  const outputDirectory = path.join(rootDirectory, 'dist');
  const manifestsDirectory = path.join(rootDirectory, 'manifests');
  mkdirSync(bundledDirectory);
  mkdirSync(manifestsDirectory);
  writeFileSync(
    path.join(rootDirectory, 'catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        {
          manifest: `manifests/${rawManifest.id}-${rawManifest.version}.json`,
          minimumDesktopVersion: '0.8.0',
        },
      ],
    }),
  );
  writeFileSync(
    path.join(
      manifestsDirectory,
      `${rawManifest.id}-${rawManifest.version}.json`,
    ),
    JSON.stringify(rawManifest),
  );
  return { bundledDirectory, outputDirectory, rootDirectory };
}

test('builds bounded versioned JSON assets with catalog integrity metadata', () => {
  const paths = fixture();

  try {
    const { catalog } = buildCatalog(paths);
    const entry = catalog.plugins[0];
    const asset = readFileSync(
      path.join(paths.outputDirectory, 'assets', entry.assetName),
    );

    assert.equal(entry.id, 'test-search');
    assert.equal(entry.version, '1.2.3');
    assert.equal(entry.assetName, 'test-search-1.2.3.json');
    assert.equal(entry.size, asset.length);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(asset), manifest());
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(paths.outputDirectory, 'catalog-v1.json'),
          'utf8',
        ),
      ).schemaVersion,
      1,
    );
  } finally {
    rmSync(paths.rootDirectory, { force: true, recursive: true });
  }
});

test('rejects executable manifests, mismatched assets, and bundled collisions', () => {
  const executable = manifest();
  executable.actions[0].platforms.win32 = {
    type: 'launch',
    command: 'calc.exe',
  };
  const executablePaths = fixture(executable);

  try {
    assert.throws(() => buildCatalog(executablePaths), /unknown capability/);
  } finally {
    rmSync(executablePaths.rootDirectory, { force: true, recursive: true });
  }

  const mismatchedPaths = fixture();

  try {
    const sourcePath = path.join(mismatchedPaths.rootDirectory, 'catalog.json');
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    source.plugins[0].manifest = 'manifests/wrong-name-1.2.3.json';
    writeFileSync(sourcePath, JSON.stringify(source));
    writeFileSync(
      path.join(
        mismatchedPaths.rootDirectory,
        'manifests',
        'wrong-name-1.2.3.json',
      ),
      JSON.stringify(manifest()),
    );
    assert.throws(() => buildCatalog(mismatchedPaths), /must be named/);
  } finally {
    rmSync(mismatchedPaths.rootDirectory, {
      force: true,
      recursive: true,
    });
  }

  const collision = manifest({ id: 'bundled-plugin' });
  const collisionPaths = fixture(collision);

  try {
    writeFileSync(
      path.join(collisionPaths.bundledDirectory, 'bundled.json'),
      JSON.stringify(collision),
    );
    assert.throws(() => buildCatalog(collisionPaths), /collides with bundled/);
  } finally {
    rmSync(collisionPaths.rootDirectory, { force: true, recursive: true });
  }
});
