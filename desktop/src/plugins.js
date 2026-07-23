const { app } = require('electron');
const {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} = require('node:fs');
const path = require('node:path');

const {
  normalizeSettings,
  resolveExecution,
  validatePluginManifest,
  validatePluginReference,
} = require('./plugin-manifest');

const MAX_PLUGIN_BYTES = 256 * 1024;
const MAX_PLUGINS = 64;

function pluginFiles(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function readManifest(filePath) {
  if (statSync(filePath).size > MAX_PLUGIN_BYTES) {
    throw new TypeError('Plugin manifest is too large.');
  }

  return validatePluginManifest(JSON.parse(readFileSync(filePath, 'utf8')));
}

function publicPlugin(plugin, platform) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    source: plugin.source,
    actions: plugin.actions.map((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      category: action.category,
      icon: action.icon,
      keywords: action.keywords,
      fields: action.fields,
      appearance: action.appearance,
      available: Boolean(action.platforms[platform]),
    })),
  };
}

function createPluginService({
  bundledDirectory,
  onEvent = () => {},
  userDirectory,
  platform = process.platform,
} = {}) {
  const bundledPath = bundledDirectory || path.join(__dirname, 'plugins');
  const userPath = userDirectory || path.join(app.getPath('userData'), 'plugins');
  let registry = new Map();
  let errors = [];

  function load() {
    mkdirSync(userPath, { recursive: true });
    const nextRegistry = new Map();
    const nextErrors = [];
    const sources = [
      ['bundled', bundledPath],
      ['user', userPath],
    ];

    for (const [source, directory] of sources) {
      for (const filePath of pluginFiles(directory)) {
        if (nextRegistry.size >= MAX_PLUGINS) {
          nextErrors.push({
            file: path.basename(filePath),
            message: `At most ${MAX_PLUGINS} plugins are supported.`,
          });
          continue;
        }

        try {
          const plugin = readManifest(filePath);

          if (nextRegistry.has(plugin.id)) {
            throw new TypeError(
              source === 'user'
                ? `Plugin id ${plugin.id} is already provided by Stream32.`
                : `Duplicate plugin id: ${plugin.id}`,
            );
          }

          Object.defineProperty(plugin, 'source', {
            configurable: false,
            enumerable: false,
            value: source,
            writable: false,
          });
          nextRegistry.set(plugin.id, plugin);
        } catch (error) {
          nextErrors.push({
            file: path.basename(filePath),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    registry = nextRegistry;
    errors = nextErrors;
    onEvent('loaded', {
      errors: errors.length,
      plugins: registry.size,
    });
    return list();
  }

  function list() {
    return {
      plugins: [...registry.values()].map((plugin) =>
        publicPlugin(plugin, platform)),
      errors: [...errors],
      userDirectory: userPath,
    };
  }

  function resolve(action) {
    const reference = validatePluginReference(action);
    const plugin = registry.get(reference.pluginId);

    if (!plugin) {
      throw new Error(`Plugin ${reference.pluginId} is not installed.`);
    }

    const definition = plugin.actions.find(
      (candidate) => candidate.id === reference.actionId,
    );

    if (!definition) {
      throw new Error(
        `Plugin action ${reference.pluginId}/${reference.actionId} is unavailable.`,
      );
    }

    const settings = normalizeSettings(definition, reference.settings);
    onEvent('resolved', {
      pluginId: plugin.id,
      version: plugin.version,
    });
    return resolveExecution(definition, platform, settings);
  }

  load();
  return { list, load, resolve };
}

module.exports = {
  MAX_PLUGIN_BYTES,
  MAX_PLUGINS,
  createPluginService,
  pluginFiles,
  readManifest,
};
