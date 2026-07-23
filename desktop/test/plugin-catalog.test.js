const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPluginCatalogService,
  sha256,
  validateCatalog,
} = require('../src/plugin-catalog');
const { MAX_PLUGINS, createPluginService } = require('../src/plugins');

function manifest(version = '1.0.0', overrides = {}) {
  return {
    stream32Plugin: 1,
    id: 'curated-search',
    name: 'Curated Search',
    version,
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

function catalogFor(rawManifest, overrides = {}) {
  const data = Buffer.from(JSON.stringify(rawManifest));

  return {
    data,
    catalog: {
      schemaVersion: 1,
      generatedAt: '2026-07-23T00:00:00.000Z',
      plugins: [
        {
          id: rawManifest.id,
          name: rawManifest.name,
          description: rawManifest.description,
          version: rawManifest.version,
          assetName: `${rawManifest.id}-${rawManifest.version}.json`,
          size: data.length,
          sha256: sha256(data),
          minimumDesktopVersion: '0.8.0',
          ...overrides,
        },
      ],
    },
  };
}

function fixture() {
  const userDataPath = mkdtempSync(
    path.join(os.tmpdir(), 'stream32-curated-plugins-'),
  );
  const bundledDirectory = path.join(userDataPath, 'bundled');
  const userDirectory = path.join(userDataPath, 'plugins');
  mkdirSync(bundledDirectory);
  mkdirSync(userDirectory);
  const baseService = createPluginService({
    bundledDirectory,
    platform: 'win32',
    userDirectory,
  });
  let reloads = 0;
  const pluginService = {
    list: () => baseService.list(),
    load: () => {
      reloads++;
      return baseService.load();
    },
  };

  return {
    pluginService,
    reloads: () => reloads,
    userDataPath,
    userDirectory,
  };
}

function fetcherFor(getCurrent, requested = []) {
  const assetBaseUrl = 'https://github.com/example/plugins/';
  const catalogUrl = 'https://github.com/example/catalog-v1.json';

  return {
    assetBaseUrl,
    catalogUrl,
    async fetcher(url, options = {}) {
      requested.push({ url, headers: options.headers || {} });
      const current = getCurrent();

      if (url === catalogUrl) {
        return new Response(JSON.stringify(current.catalog), {
          headers: { etag: '"plugins-1"' },
        });
      }

      if (url === `${assetBaseUrl}${current.catalog.plugins[0].assetName}`) {
        return new Response(current.data, {
          headers: { 'content-length': current.data.length },
        });
      }

      return new Response('missing', { status: 404 });
    },
  };
}

function fillPluginRegistry(paths, ids) {
  for (const id of ids) {
    writeFileSync(
      path.join(paths.userDirectory, `${id}.json`),
      JSON.stringify(manifest('1.0.0', {
        id,
        name: `Plugin ${id}`,
      })),
    );
  }

  return paths.pluginService.load();
}

test('validates catalog bounds, compatibility, names, and bundled collisions', () => {
  const current = catalogFor(manifest());
  const validated = validateCatalog(current.catalog, '0.8.2');
  assert.equal(validated.plugins[0].compatible, true);

  const incompatible = structuredClone(current.catalog);
  incompatible.plugins[0].minimumDesktopVersion = '2.0.0';
  assert.equal(
    validateCatalog(incompatible, '0.8.2').plugins[0].compatible,
    false,
  );

  const hostile = structuredClone(current.catalog);
  hostile.plugins[0].assetName = '../plugin.json';
  assert.throws(() => validateCatalog(hostile, '0.8.2'), /unsafe|mismatched/);
  assert.throws(
    () => validateCatalog(current.catalog, '0.8.2', new Set(['curated-search'])),
    /bundled/,
  );

  const tooMany = structuredClone(current.catalog);
  tooMany.plugins = Array.from({ length: 65 }, (_value, index) => ({
    ...tooMany.plugins[0],
    id: `plugin-${index}`,
    assetName: `plugin-${index}-1.0.0.json`,
  }));
  assert.throws(() => validateCatalog(tooMany, '0.8.2'), /1-64/);
});

test('uses ETag cache and falls back to validated catalog while offline', async () => {
  const paths = fixture();
  const current = catalogFor(manifest());
  const requested = [];
  const network = fetcherFor(() => current, requested);

  try {
    const first = createPluginCatalogService({
      appVersion: '0.8.2',
      ...network,
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    assert.equal((await first.list()).source, 'network');

    let conditionalHeaders;
    const cached = createPluginCatalogService({
      appVersion: '0.8.2',
      assetBaseUrl: network.assetBaseUrl,
      catalogUrl: network.catalogUrl,
      fetcher: async (_url, options) => {
        conditionalHeaders = options.headers;
        return new Response(null, { status: 304 });
      },
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    const conditional = await cached.list();
    assert.equal(conditional.source, 'cache');
    assert.equal(conditional.warning, null);
    assert.equal(conditionalHeaders['If-None-Match'], '"plugins-1"');

    const offline = createPluginCatalogService({
      appVersion: '0.8.2',
      assetBaseUrl: network.assetBaseUrl,
      catalogUrl: network.catalogUrl,
      fetcher: async () => {
        throw new Error('network unavailable');
      },
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    const fallback = await offline.list();
    assert.equal(fallback.source, 'cache');
    assert.match(fallback.warning, /Offline.*network unavailable/);
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('reports offline without hiding built-in plugins when no cache exists', async () => {
  const paths = fixture();
  const bundled = manifest('1.0.0', { id: 'built-in-search' });
  writeFileSync(
    path.join(paths.userDataPath, 'bundled', 'search.json'),
    JSON.stringify(bundled),
  );
  paths.pluginService.load();

  try {
    const service = createPluginCatalogService({
      appVersion: '0.8.2',
      fetcher: async () => {
        throw new Error('offline');
      },
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    const listing = await service.list();
    assert.equal(listing.source, 'offline');
    assert.match(listing.warning, /Offline/);
    assert.deepEqual(
      listing.builtIn.map((plugin) => plugin.id),
      ['built-in-search'],
    );
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('install, update, and remove atomically reload the plugin registry', async () => {
  const paths = fixture();
  let current = catalogFor(manifest('1.0.0'));
  const network = fetcherFor(() => current);
  const service = createPluginCatalogService({
    appVersion: '0.8.2',
    ...network,
    pluginService: paths.pluginService,
    userDataPath: paths.userDataPath,
  });
  const installedPath = path.join(paths.userDirectory, 'curated-search.json');

  try {
    let listing = await service.install('curated-search');
    assert.equal(listing.plugins[0].installedVersion, '1.0.0');
    assert.equal(
      JSON.parse(readFileSync(installedPath, 'utf8')).version,
      '1.0.0',
    );

    current = catalogFor(manifest('1.1.0'));
    listing = await service.list(true);
    assert.equal(listing.plugins[0].updateAvailable, true);
    listing = await service.update('curated-search');
    assert.equal(listing.plugins[0].installedVersion, '1.1.0');
    assert.equal(
      JSON.parse(readFileSync(installedPath, 'utf8')).version,
      '1.1.0',
    );

    listing = await service.remove('curated-search');
    assert.equal(listing.plugins[0].installedVersion, null);
    assert.equal(paths.reloads(), 3);
    assert.throws(() => readFileSync(installedPath), /ENOENT/);
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('full plugin capacity rejects a later-sorted curated install', async () => {
  const paths = fixture();
  const ids = Array.from(
    { length: MAX_PLUGINS },
    (_value, index) => `plugin-${index.toString().padStart(2, '0')}`,
  );
  const current = catalogFor(manifest('1.0.0', {
    id: 'zzz-curated',
    name: 'Last curated',
  }));
  const network = fetcherFor(() => current);
  const service = createPluginCatalogService({
    appVersion: '0.8.2',
    ...network,
    pluginService: paths.pluginService,
    userDataPath: paths.userDataPath,
  });

  try {
    assert.equal(fillPluginRegistry(paths, ids).plugins.length, MAX_PLUGINS);
    await assert.rejects(
      service.install('zzz-curated'),
      /At most 64 plugins/,
    );
    assert.deepEqual(
      paths.pluginService.list().plugins.map((plugin) => plugin.id),
      ids,
    );
    assert.throws(
      () => readFileSync(path.join(paths.userDirectory, 'zzz-curated.json')),
      /ENOENT/,
    );
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('full capacity rejects an early filename without displacing plugins', async () => {
  const paths = fixture();
  const ids = Array.from(
    { length: MAX_PLUGINS },
    (_value, index) => `plugin-${index.toString().padStart(2, '0')}`,
  );
  const current = catalogFor(manifest('1.0.0', {
    id: 'aaa-curated',
    name: 'First curated',
  }));
  const network = fetcherFor(() => current);
  const service = createPluginCatalogService({
    appVersion: '0.8.2',
    ...network,
    pluginService: paths.pluginService,
    userDataPath: paths.userDataPath,
  });

  try {
    fillPluginRegistry(paths, ids);
    await assert.rejects(
      service.install('aaa-curated'),
      /At most 64 plugins/,
    );
    assert.deepEqual(
      paths.pluginService.list().plugins.map((plugin) => plugin.id),
      ids,
    );
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('updates at full capacity preserve every installed plugin id', async () => {
  const paths = fixture();
  const otherIds = Array.from(
    { length: MAX_PLUGINS - 1 },
    (_value, index) => `plugin-${index.toString().padStart(2, '0')}`,
  );
  fillPluginRegistry(paths, ['curated-search', ...otherIds]);
  const beforeIds = paths.pluginService.list().plugins
    .map((plugin) => plugin.id)
    .sort();
  const current = catalogFor(manifest('1.1.0'));
  const network = fetcherFor(() => current);
  const service = createPluginCatalogService({
    appVersion: '0.8.2',
    ...network,
    pluginService: paths.pluginService,
    userDataPath: paths.userDataPath,
  });

  try {
    const listing = await service.update('curated-search');
    assert.deepEqual(
      paths.pluginService.list().plugins
        .map((plugin) => plugin.id)
        .sort(),
      beforeIds,
    );
    assert.equal(
      listing.plugins[0].installedVersion,
      '1.1.0',
    );
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('partial post-install listings roll back the curated manifest', async () => {
  const paths = fixture();
  fillPluginRegistry(paths, ['keep-plugin']);
  let rejectNextLoad = true;
  const guardedService = {
    list: () => paths.pluginService.list(),
    load() {
      const listing = paths.pluginService.load();

      if (!rejectNextLoad) {
        return listing;
      }

      rejectNextLoad = false;
      return {
        ...listing,
        plugins: listing.plugins.filter(
          (plugin) => plugin.id !== 'keep-plugin',
        ),
        errors: [
          ...listing.errors,
          {
            file: 'curated-search.json',
            message: 'simulated registry rejection',
          },
        ],
      };
    },
  };
  const current = catalogFor(manifest());
  const network = fetcherFor(() => current);
  const service = createPluginCatalogService({
    appVersion: '0.8.2',
    ...network,
    pluginService: guardedService,
    userDataPath: paths.userDataPath,
  });
  const installedPath = path.join(paths.userDirectory, 'curated-search.json');

  try {
    await assert.rejects(
      service.install('curated-search'),
      /registry rejected|installation failed/i,
    );
    assert.throws(() => readFileSync(installedPath), /ENOENT/);
    assert.deepEqual(
      paths.pluginService.list().plugins.map((plugin) => plugin.id),
      ['keep-plugin'],
    );
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});

test('hash, size, and manifest failures leave the installed version intact', async () => {
  const paths = fixture();
  const installedPath = path.join(paths.userDirectory, 'curated-search.json');
  writeFileSync(installedPath, JSON.stringify(manifest('1.0.0')));
  paths.pluginService.load();
  const update = catalogFor(manifest('1.1.0'));
  const previous = readFileSync(installedPath, 'utf8');
  const network = fetcherFor(() => update);

  try {
    const badHash = structuredClone(update);
    badHash.data = Buffer.from(update.data);
    badHash.data[badHash.data.length - 2] ^= 1;
    const hashNetwork = fetcherFor(() => badHash);
    const hashService = createPluginCatalogService({
      appVersion: '0.8.2',
      ...hashNetwork,
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    await assert.rejects(hashService.update('curated-search'), /SHA-256/);
    assert.equal(readFileSync(installedPath, 'utf8'), previous);

    const shortNetwork = {
      ...network,
      fetcher: async (url) =>
        url === network.catalogUrl
          ? new Response(JSON.stringify(update.catalog))
          : new Response(update.data.subarray(1)),
    };
    const sizeService = createPluginCatalogService({
      appVersion: '0.8.2',
      ...shortNetwork,
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    await assert.rejects(sizeService.update('curated-search'), /size/);
    assert.equal(readFileSync(installedPath, 'utf8'), previous);

    const hostileManifest = manifest('1.1.0');
    hostileManifest.actions[0].platforms.win32 = {
      type: 'launch',
      command: 'calc.exe',
    };
    const hostile = catalogFor(hostileManifest);
    const hostileNetwork = fetcherFor(() => hostile);
    const hostileService = createPluginCatalogService({
      appVersion: '0.8.2',
      ...hostileNetwork,
      pluginService: paths.pluginService,
      userDataPath: paths.userDataPath,
    });
    await assert.rejects(hostileService.update('curated-search'), /invalid/);
    assert.equal(readFileSync(installedPath, 'utf8'), previous);
  } finally {
    rmSync(paths.userDataPath, { force: true, recursive: true });
  }
});
