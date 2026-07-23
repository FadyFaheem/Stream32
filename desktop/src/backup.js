const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} = require('node:fs');
const path = require('node:path');

const { replacePath, writeJsonAtomic } = require('./atomic-json');
const { validateDeckRegistry } = require('./deck-model');
const { readDecks } = require('./deck-store');
const {
  MAX_PLUGIN_BYTES,
  MAX_PLUGINS,
  pluginFiles,
  readManifest,
} = require('./plugins');
const { validatePluginManifest } = require('./plugin-manifest');
const { readSettings, validateSettings } = require('./settings');

const BACKUP_SCHEMA_VERSION = 1;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MARKER_FILENAME = 'restore-marker.json';
const SAFE_PLUGIN_FILENAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/;
const SAFE_INTERNAL_NAME = /^[A-Za-z0-9.][A-Za-z0-9._-]{0,159}$/;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function requireSafeFilename(filename, field, pattern = SAFE_PLUGIN_FILENAME) {
  if (
    typeof filename !== 'string' ||
    filename.includes('..') ||
    path.basename(filename) !== filename ||
    !pattern.test(filename)
  ) {
    throw new TypeError(`${field} is unsafe.`);
  }

  return filename;
}

function bundledPluginIds(directory) {
  return new Set(
    pluginFiles(directory).map((filePath) => readManifest(filePath).id),
  );
}

function validateBackup(value, { bundledIds = new Set() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Backup must be a JSON object.');
  }

  if (value.stream32Backup !== BACKUP_SCHEMA_VERSION) {
    throw new TypeError('Backup has an unsupported format.');
  }

  const settings = validateSettings(value.settings);
  const decks = validateDeckRegistry(value.decks);

  if (!Array.isArray(value.plugins) || value.plugins.length > MAX_PLUGINS) {
    throw new TypeError(`Backup supports at most ${MAX_PLUGINS} plugins.`);
  }

  const filenames = new Set();
  const pluginIds = new Set();
  const plugins = value.plugins.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Backup plugin entry is invalid.');
    }

    const filename = requireSafeFilename(entry.filename, 'Plugin filename');
    const filenameKey = filename.toLowerCase();

    if (filenames.has(filenameKey)) {
      throw new TypeError('Backup plugin filenames must be unique.');
    }

    const rawManifestText = JSON.stringify(entry.manifest);

    if (byteLength(rawManifestText) > MAX_PLUGIN_BYTES) {
      throw new TypeError('Backup plugin manifest is too large.');
    }

    const manifest = validatePluginManifest(entry.manifest);

    if (pluginIds.has(manifest.id)) {
      throw new TypeError('Backup plugin ids must be unique.');
    }

    if (bundledIds.has(manifest.id)) {
      throw new TypeError(
        `Backup cannot replace bundled plugin ${manifest.id}.`,
      );
    }

    filenames.add(filenameKey);
    pluginIds.add(manifest.id);
    return { filename, manifest };
  });

  if (
    value.createdAt !== undefined &&
    value.createdAt !== null &&
    (typeof value.createdAt !== 'string' ||
      value.createdAt.length > 40 ||
      Number.isNaN(Date.parse(value.createdAt)))
  ) {
    throw new TypeError('Backup creation time is invalid.');
  }

  return {
    stream32Backup: BACKUP_SCHEMA_VERSION,
    createdAt:
      typeof value.createdAt === 'string' ? value.createdAt : null,
    settings,
    decks,
    plugins,
  };
}

function parseBackup(text, options) {
  if (typeof text !== 'string' || byteLength(text) > MAX_BACKUP_BYTES) {
    throw new TypeError('Backup is too large or unreadable.');
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError('Backup is not valid JSON.');
  }

  return validateBackup(parsed, options);
}

function createBackup(
  {
    bundledPluginsDirectory,
    decksPath,
    settingsPath,
    userPluginsDirectory,
    createdAt = new Date().toISOString(),
  },
  {
    bundledIds = bundledPluginsDirectory
      ? bundledPluginIds(bundledPluginsDirectory)
      : new Set(),
  } = {},
) {
  const plugins = pluginFiles(userPluginsDirectory).map((filePath) => ({
    filename: path.basename(filePath),
    manifest: readManifest(filePath),
  }));
  const decks = readDecks(decksPath);

  if (decks.errors?.length) {
    throw new Error(
      'Deck storage contains preserved corrupt data; restore or repair it ' +
      'before exporting a backup.',
    );
  }

  const backup = validateBackup(
    {
      stream32Backup: BACKUP_SCHEMA_VERSION,
      createdAt,
      settings: readSettings(settingsPath),
      decks,
      plugins,
    },
    { bundledIds },
  );
  const text = `${JSON.stringify(backup, null, 2)}\n`;

  if (byteLength(text) > MAX_BACKUP_BYTES) {
    throw new TypeError('Backup exceeds the supported size.');
  }

  return text;
}

function writeBackup(filePath, text) {
  writeJsonAtomic(parseBackup(text), filePath, { keepBackup: false });
}

function stageBackup(backup, stageDirectory) {
  rmSync(stageDirectory, { force: true, recursive: true });
  mkdirSync(stageDirectory, { recursive: true });
  writeJsonAtomic(backup.settings, path.join(stageDirectory, 'settings.json'), {
    keepBackup: false,
  });
  writeJsonAtomic(backup.decks, path.join(stageDirectory, 'decks.json'), {
    keepBackup: false,
  });

  const pluginsDirectory = path.join(stageDirectory, 'plugins');
  mkdirSync(pluginsDirectory);

  for (const plugin of backup.plugins) {
    writeJsonAtomic(
      plugin.manifest,
      path.join(pluginsDirectory, plugin.filename),
      { keepBackup: false },
    );
  }
}

function promoteStage(stageDirectory, paths) {
  replacePath(
    path.join(stageDirectory, 'settings.json'),
    paths.settingsPath,
  );
  replacePath(path.join(stageDirectory, 'decks.json'), paths.decksPath);
  replacePath(
    path.join(stageDirectory, 'plugins'),
    paths.userPluginsDirectory,
  );
}

function readMarker(markerPath) {
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));

  if (
    marker?.stream32Restore !== 1 ||
    typeof marker.stageName !== 'string' ||
    typeof marker.safetyName !== 'string'
  ) {
    throw new TypeError('Restore marker is invalid.');
  }

  requireSafeFilename(marker.stageName, 'Restore stage', SAFE_INTERNAL_NAME);
  requireSafeFilename(marker.safetyName, 'Safety backup', SAFE_INTERNAL_NAME);
  return marker;
}

function recoveryPaths(paths, marker) {
  return {
    safetyPath: path.join(paths.backupsDirectory, marker.safetyName),
    stagePath: path.join(paths.userDataDirectory, marker.stageName),
  };
}

function recoverInterruptedRestore(paths, { bundledIds = new Set() } = {}) {
  const markerPath = path.join(paths.userDataDirectory, MARKER_FILENAME);

  if (!existsSync(markerPath)) {
    return false;
  }

  const marker = readMarker(markerPath);
  const { safetyPath, stagePath } = recoveryPaths(paths, marker);
  const safety = parseBackup(readFileSync(safetyPath, 'utf8'), { bundledIds });
  const rollbackStage =
    path.join(paths.userDataDirectory, `.restore-rollback-${Date.now()}`);
  stageBackup(safety, rollbackStage);
  promoteStage(rollbackStage, paths);
  rmSync(markerPath, { force: true });
  rmSync(stagePath, { force: true, recursive: true });
  rmSync(rollbackStage, { force: true, recursive: true });
  return true;
}

function restoreBackup(text, paths, { bundledIds = new Set() } = {}) {
  const backup = parseBackup(text, { bundledIds });
  mkdirSync(paths.backupsDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyName = `pre-restore-${timestamp}.json`;
  const safetyPath = path.join(paths.backupsDirectory, safetyName);
  const current = createBackup(paths, { bundledIds });
  writeBackup(safetyPath, current);

  const stageName =
    `.restore-stage-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagePath = path.join(paths.userDataDirectory, stageName);
  const markerPath = path.join(paths.userDataDirectory, MARKER_FILENAME);
  stageBackup(backup, stagePath);
  writeJsonAtomic(
    {
      stream32Restore: 1,
      safetyName,
      stageName,
    },
    markerPath,
    { keepBackup: false },
  );

  try {
    promoteStage(stagePath, paths);
    rmSync(markerPath, { force: true });
    rmSync(stagePath, { force: true, recursive: true });
    return { safetyPath };
  } catch (error) {
    try {
      recoverInterruptedRestore(paths, { bundledIds });
    } catch {
      throw new Error(
        'Restore failed; Stream32 will retry the safety rollback on startup.',
        { cause: error },
      );
    }

    throw new Error('Restore failed and was rolled back.', { cause: error });
  }
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  MARKER_FILENAME,
  MAX_BACKUP_BYTES,
  bundledPluginIds,
  createBackup,
  parseBackup,
  recoverInterruptedRestore,
  restoreBackup,
  validateBackup,
  writeBackup,
};
