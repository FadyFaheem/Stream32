const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { writeJsonAtomic } = require('../src/atomic-json');
const {
  MARKER_FILENAME,
  MAX_BACKUP_BYTES,
  createBackup,
  parseBackup,
  recoverInterruptedRestore,
  restoreBackup,
  writeBackup,
} = require('../src/backup');
const { MAX_PLUGIN_BYTES } = require('../src/plugins');

const DEVICE_ID = 'aabbccddeeff';

function pluginManifest(id = 'user-tools') {
  return {
    stream32Plugin: 1,
    id,
    name: 'User tools',
    version: '1.2.3',
    actions: [
      {
        id: 'play',
        name: 'Play',
        fields: [],
        platforms: {
          win32: { type: 'media', command: 'play-pause' },
        },
      },
    ],
  };
}

function deckRegistry(name = 'Desk') {
  return {
    version: 2,
    devices: {
      [DEVICE_ID]: {
        name,
        boardId: 'test-board',
        activeProfileId: 'studio',
        defaultProfileId: 'default',
        profiles: {
          default: {
            name: 'Default',
            boardId: 'test-board',
            activePage: 0,
            pages: [
              {
                name: 'Main',
                rows: 1,
                cols: 1,
                keys: [{ index: 0, label: 'One' }],
              },
            ],
          },
          studio: {
            name: 'Studio',
            boardId: 'test-board',
            activePage: 0,
            appMatches: {
              win32: {
                kind: 'executable',
                value: 'obs-studio/bin/64bit/obs64.exe',
              },
            },
            pages: [
              {
                name: 'Live',
                rows: 1,
                cols: 2,
                keys: [{ index: 1, label: 'Record' }],
              },
            ],
          },
        },
      },
    },
  };
}

function makePaths(root) {
  return {
    backupsDirectory: path.join(root, 'backups'),
    bundledPluginsDirectory: path.join(root, 'bundled'),
    decksPath: path.join(root, 'decks.json'),
    logsDirectory: path.join(root, 'logs'),
    settingsPath: path.join(root, 'settings.json'),
    userDataDirectory: root,
    userPluginsDirectory: path.join(root, 'plugins'),
  };
}

function seed(paths, { deckName = 'Desk', pluginId = 'user-tools', theme = 'dark' } = {}) {
  mkdirSync(paths.bundledPluginsDirectory, { recursive: true });
  mkdirSync(paths.userPluginsDirectory, { recursive: true });
  writeJsonAtomic({ theme }, paths.settingsPath);
  writeJsonAtomic(deckRegistry(deckName), paths.decksPath);
  writeJsonAtomic(
    pluginManifest(pluginId),
    path.join(paths.userPluginsDirectory, `${pluginId}.json`),
  );
}

test('backup round-trips full settings, decks, art-capable profiles, and plugins', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream32-backup-'));
  const paths = makePaths(root);

  try {
    seed(paths);
    const text = createBackup(paths);
    const parsed = parseBackup(text);

    assert.equal(parsed.stream32Backup, 1);
    assert.equal(parsed.settings.theme, 'dark');
    assert.equal(parsed.decks.devices[DEVICE_ID].name, 'Desk');
    assert.equal(
      parsed.decks.devices[DEVICE_ID].profiles.studio.pages[0].keys[0].label,
      'Record',
    );
    assert.equal(
      parsed.decks.devices[DEVICE_ID].activeProfileId,
      'studio',
    );
    assert.equal(
      parsed.decks.devices[DEVICE_ID].defaultProfileId,
      'default',
    );
    assert.deepEqual(
      parsed.decks.devices[DEVICE_ID].profiles.studio.appMatches.win32,
      {
        kind: 'executable',
        value: 'obs-studio/bin/64bit/obs64.exe',
      },
    );
    assert.equal(parsed.plugins[0].manifest.id, 'user-tools');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('backup validation applies the deck model boundary', () => {
  const decks = deckRegistry();
  decks.devices[DEVICE_ID].profiles.default.pages[0].keys[0].action = {
    type: 'unknown',
  };

  assert.throws(
    () => parseBackup(JSON.stringify({
      stream32Backup: 1,
      settings: {},
      decks,
      plugins: [],
    })),
    /Unknown action type/,
  );
});

test('backup refuses to omit preserved corrupt deck profiles', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream32-backup-corrupt-'));
  const paths = makePaths(root);

  try {
    seed(paths);
    const registry = JSON.parse(readFileSync(paths.decksPath, 'utf8'));
    registry.devices[DEVICE_ID].profiles.broken = {
      name: 'Broken',
      boardId: 'test-board',
      pages: 'invalid',
    };
    writeJsonAtomic(registry, paths.decksPath);
    rmSync(`${paths.decksPath}.bak`, { force: true });

    assert.throws(
      () => createBackup(paths),
      /preserved corrupt data/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('rejects oversized, traversing, excessive, and bundled plugin backups', () => {
  const valid = {
    stream32Backup: 1,
    createdAt: new Date(0).toISOString(),
    settings: {},
    decks: { version: 2, devices: {} },
    plugins: [{ filename: 'user.json', manifest: pluginManifest() }],
  };

  assert.throws(
    () =>
      parseBackup(JSON.stringify({
        ...valid,
        plugins: [{ ...valid.plugins[0], filename: '../user.json' }],
      })),
    /unsafe/,
  );
  assert.throws(
    () =>
      parseBackup(JSON.stringify({
        ...valid,
        plugins: Array.from({ length: 65 }, (_value, index) => ({
          filename: `plugin-${index}.json`,
          manifest: pluginManifest(`plugin-${index}`),
        })),
      })),
    /at most 64/,
  );
  assert.throws(
    () =>
      parseBackup(JSON.stringify({
        ...valid,
        plugins: [{
          ...valid.plugins[0],
          manifest: {
            ...valid.plugins[0].manifest,
            ignoredPadding: 'x'.repeat(MAX_PLUGIN_BYTES),
          },
        }],
      })),
    /manifest is too large/,
  );
  assert.throws(
    () => parseBackup(JSON.stringify(valid), {
      bundledIds: new Set(['user-tools']),
    }),
    /bundled plugin/,
  );
  assert.throws(
    () => parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1)),
    /too large/,
  );
});

test('restore validates before mutation and transactionally replaces user data', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream32-restore-'));
  const paths = makePaths(root);

  try {
    seed(paths);
    const originalSettings = readFileSync(paths.settingsPath, 'utf8');
    assert.throws(
      () => restoreBackup('{"stream32Backup":1}', paths),
      /Settings/,
    );
    assert.equal(readFileSync(paths.settingsPath, 'utf8'), originalSettings);
    assert.equal(existsSync(paths.backupsDirectory), false);

    const replacement = {
      stream32Backup: 1,
      createdAt: new Date(0).toISOString(),
      settings: { theme: 'light' },
      decks: deckRegistry('Restored'),
      plugins: [{
        filename: 'restored.json',
        manifest: pluginManifest('restored-tools'),
      }],
    };
    const result = restoreBackup(JSON.stringify(replacement), paths);

    assert.equal(JSON.parse(readFileSync(paths.settingsPath)).theme, 'light');
    assert.equal(
      JSON.parse(readFileSync(paths.decksPath)).devices[DEVICE_ID].name,
      'Restored',
    );
    assert.equal(
      JSON.parse(
        readFileSync(path.join(paths.userPluginsDirectory, 'restored.json')),
      ).id,
      'restored-tools',
    );
    assert.equal(
      existsSync(path.join(paths.userPluginsDirectory, 'user-tools.json')),
      false,
    );
    assert.equal(existsSync(result.safetyPath), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('startup recovery rolls a partial restore back to its safety backup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream32-rollback-'));
  const paths = makePaths(root);

  try {
    seed(paths);
    mkdirSync(paths.backupsDirectory);
    const safetyName = 'pre-restore-test.json';
    writeBackup(
      path.join(paths.backupsDirectory, safetyName),
      createBackup(paths),
    );
    writeJsonAtomic(
      {
        stream32Restore: 1,
        safetyName,
        stageName: 'restore-stage-test',
      },
      path.join(root, MARKER_FILENAME),
      { keepBackup: false },
    );

    seed(paths, {
      deckName: 'Partial',
      pluginId: 'partial-tools',
      theme: 'partial',
    });
    assert.equal(recoverInterruptedRestore(paths), true);
    assert.equal(JSON.parse(readFileSync(paths.settingsPath)).theme, 'dark');
    assert.equal(
      JSON.parse(readFileSync(paths.decksPath)).devices[DEVICE_ID].name,
      'Desk',
    );
    assert.equal(
      existsSync(path.join(paths.userPluginsDirectory, 'user-tools.json')),
      true,
    );
    assert.equal(existsSync(path.join(root, MARKER_FILENAME)), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
