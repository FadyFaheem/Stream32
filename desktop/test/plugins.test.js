const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveExecution,
  validatePluginManifest,
  validatePluginReference,
} = require('../src/plugin-manifest');
const { createPluginService } = require('../src/plugins');

function configurableManifest() {
  return {
    stream32Plugin: 1,
    id: 'search-tools',
    name: 'Search tools',
    version: '1.0.0',
    actions: [
      {
        id: 'search',
        name: 'Search',
        description: 'Search a configured site.',
        category: 'Web',
        icon: 'search',
        keywords: ['query'],
        fields: [
          {
            id: 'query',
            type: 'text',
            label: 'Query',
            required: true,
            maxLength: 80,
          },
          {
            id: 'private',
            type: 'toggle',
            label: 'Private',
            default: false,
          },
        ],
        platforms: {
          win32: {
            type: 'url',
            url: 'https://example.com/search',
            query: { q: { setting: 'query' } },
          },
        },
      },
    ],
  };
}

test('validates and resolves bounded declarative plugin settings', () => {
  const plugin = validatePluginManifest(configurableManifest());
  const action = plugin.actions[0];

  assert.deepEqual(
    resolveExecution(action, 'win32', { query: 'stream deck' }),
    {
      type: 'url',
      url: 'https://example.com/search?q=stream+deck',
    },
  );
  assert.throws(
    () => resolveExecution(action, 'win32', { query: '' }),
    /query is invalid/,
  );
  assert.throws(
    () => resolveExecution(action, 'linux', { query: 'deck' }),
    /not supported/,
  );
});

test('rejects executable capabilities and malformed plugin references', () => {
  const manifest = configurableManifest();
  manifest.actions[0].platforms.win32 = {
    type: 'launch',
    command: 'calc.exe',
  };

  assert.throws(
    () => validatePluginManifest(manifest),
    /unknown capability/,
  );
  assert.throws(
    () => validatePluginReference({
      type: 'plugin',
      pluginId: '../escape',
      actionId: 'search',
    }),
    /Plugin id/,
  );
  assert.throws(
    () => validatePluginReference({
      type: 'plugin',
      pluginId: 'search-tools',
      actionId: 'search',
      settings: { extra: { unsafe: true } },
    }),
    /setting extra/,
  );

  const tooManyActions = configurableManifest();
  const template = tooManyActions.actions[0];
  tooManyActions.actions = Array.from({ length: 129 }, (_value, index) => ({
    ...template,
    id: `search-${index}`,
  }));
  assert.throws(
    () => validatePluginManifest(tooManyActions),
    /actions are invalid/,
  );

  assert.throws(
    () => validatePluginReference({
      type: 'plugin',
      pluginId: 'search-tools',
      actionId: 'search',
      settings: Object.fromEntries(
        Array.from({ length: 17 }, (_value, index) => [`field-${index}`, 'x']),
      ),
    }),
    /too many settings/,
  );
});

test('loads bundled and user manifests without allowing overrides', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stream32-plugins-'));
  const bundled = path.join(root, 'bundled');
  const user = path.join(root, 'user');
  mkdirSync(bundled);
  mkdirSync(user);

  try {
    const teams = readFileSync(
      path.join(__dirname, '..', 'src', 'plugins', 'microsoft-teams.json'),
      'utf8',
    );
    writeFileSync(path.join(bundled, 'teams.json'), teams);
    writeFileSync(path.join(user, 'override.json'), teams);
    writeFileSync(
      path.join(user, 'search.json'),
      JSON.stringify(configurableManifest()),
    );

    const service = createPluginService({
      bundledDirectory: bundled,
      userDirectory: user,
      platform: 'win32',
    });
    const catalog = service.list();

    assert.deepEqual(
      catalog.plugins.map((plugin) => plugin.id),
      ['microsoft-teams', 'search-tools'],
    );
    assert.equal(catalog.errors.length, 1);
    assert.match(catalog.errors[0].message, /already provided/);
    assert.deepEqual(
      service.resolve({
        type: 'plugin',
        pluginId: 'microsoft-teams',
        actionId: 'toggle-mute',
        settings: {},
      }),
      {
        type: 'hotkey',
        key: 'M',
        alt: false,
        ctrl: true,
        meta: false,
        shift: true,
      },
    );

    const linuxService = createPluginService({
      bundledDirectory: bundled,
      userDirectory: user,
      platform: 'linux',
    });
    const linuxTeams = linuxService.list().plugins.find(
      (plugin) => plugin.id === 'microsoft-teams',
    );
    assert.equal(linuxTeams.actions[0].available, false);
    assert.throws(
      () => linuxService.resolve({
        type: 'plugin',
        pluginId: 'microsoft-teams',
        actionId: 'toggle-mute',
        settings: {},
      }),
      /not supported/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
