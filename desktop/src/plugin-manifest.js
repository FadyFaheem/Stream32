const { HOTKEY_KEY_NAMES, MEDIA_COMMANDS } = require('./keymap');

const PLUGIN_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const MAX_ACTIONS = 128;
const MAX_FIELDS = 16;
const MAX_SETTING_LENGTH = 512;
const PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const FIELD_TYPES = new Set(['select', 'text', 'toggle']);
const EXECUTION_TYPES = new Set(['hotkey', 'media', 'url']);

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }

  return value;
}

function requireString(value, field, maximumLength, pattern = null) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${field} is invalid.`);
  }

  return value;
}

function optionalString(value, field, maximumLength, pattern = null) {
  return value === undefined
    ? undefined
    : requireString(value, field, maximumLength, pattern);
}

function validateSettingValue(value, field) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string' || value.length > MAX_SETTING_LENGTH) {
    throw new TypeError(`${field} is invalid.`);
  }

  return value;
}

function validatePluginReference(action) {
  requireObject(action, 'Plugin action');

  if (action.type !== 'plugin') {
    throw new TypeError('Plugin action type is invalid.');
  }

  const settings = action.settings === undefined
    ? {}
    : requireObject(action.settings, 'Plugin action settings');
  const validatedSettings = {};
  const entries = Object.entries(settings);

  if (entries.length > MAX_FIELDS) {
    throw new TypeError('Plugin action has too many settings.');
  }

  for (const [id, value] of entries) {
    requireString(id, 'Plugin setting id', 64, ID_PATTERN);
    validatedSettings[id] = validateSettingValue(value, `Plugin setting ${id}`);
  }

  return {
    type: 'plugin',
    pluginId: requireString(action.pluginId, 'Plugin id', 64, ID_PATTERN),
    actionId: requireString(action.actionId, 'Plugin action id', 64, ID_PATTERN),
    settings: validatedSettings,
  };
}

function validateField(raw, actionId) {
  const field = requireObject(raw, `Plugin action ${actionId} field`);
  const id = requireString(field.id, 'Plugin field id', 64, ID_PATTERN);

  if (!FIELD_TYPES.has(field.type)) {
    throw new TypeError(`Plugin field ${id} has an unknown type.`);
  }

  const validated = {
    id,
    type: field.type,
    label: requireString(field.label, `Plugin field ${id} label`, 80),
    required: Boolean(field.required),
  };

  if (field.type === 'text') {
    const maximumLength = field.maxLength ?? 128;

    if (
      !Number.isInteger(maximumLength) ||
      maximumLength < 1 ||
      maximumLength > MAX_SETTING_LENGTH
    ) {
      throw new TypeError(`Plugin field ${id} maxLength is invalid.`);
    }

    validated.maxLength = maximumLength;
    validated.placeholder = optionalString(
      field.placeholder,
      `Plugin field ${id} placeholder`,
      120,
    );
    validated.default = field.default === undefined
      ? ''
      : requireString(
        field.default,
        `Plugin field ${id} default`,
        maximumLength,
      );
  } else if (field.type === 'select') {
    if (
      !Array.isArray(field.options) ||
      field.options.length === 0 ||
      field.options.length > 64
    ) {
      throw new TypeError(`Plugin field ${id} options are invalid.`);
    }

    const values = new Set();
    validated.options = field.options.map((rawOption) => {
      const option = requireObject(rawOption, `Plugin field ${id} option`);
      const value = requireString(
        option.value,
        `Plugin field ${id} option value`,
        80,
      );

      if (values.has(value)) {
        throw new TypeError(`Plugin field ${id} option values must be unique.`);
      }

      values.add(value);
      return {
        value,
        label: requireString(
          option.label,
          `Plugin field ${id} option label`,
          80,
        ),
      };
    });
    validated.default = field.default === undefined
      ? validated.options[0].value
      : requireString(field.default, `Plugin field ${id} default`, 80);

    if (!values.has(validated.default)) {
      throw new TypeError(`Plugin field ${id} default is not an option.`);
    }
  } else {
    if (field.default !== undefined && typeof field.default !== 'boolean') {
      throw new TypeError(`Plugin field ${id} default must be a boolean.`);
    }

    validated.default = Boolean(field.default);
  }

  return validated;
}

function validateReference(value, fields, expectedType, field) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  ) {
    return value;
  }

  const setting = requireString(value.setting, `${field} setting`, 64, ID_PATTERN);
  const definition = fields.get(setting);

  if (!definition || (expectedType && definition.type !== expectedType)) {
    throw new TypeError(`${field} references an incompatible setting.`);
  }

  return { setting };
}

function validateExecution(raw, fields, field) {
  const execution = requireObject(raw, field);

  if (!EXECUTION_TYPES.has(execution.type)) {
    throw new TypeError(`${field} has an unknown capability.`);
  }

  if (execution.type === 'hotkey') {
    const key = validateReference(
      execution.key,
      fields,
      'select',
      `${field} key`,
    );

    if (typeof key === 'string' && !HOTKEY_KEY_NAMES.has(key)) {
      throw new TypeError(`${field} key is unknown.`);
    }

    if (typeof key !== 'string' && !key?.setting) {
      throw new TypeError(`${field} key is invalid.`);
    }

    if (
      key?.setting &&
      fields.get(key.setting).options.some(
        (option) => !HOTKEY_KEY_NAMES.has(option.value),
      )
    ) {
      throw new TypeError(`${field} key setting contains an unknown key.`);
    }

    const validated = { type: 'hotkey', key };

    for (const modifier of ['alt', 'ctrl', 'meta', 'shift']) {
      const value = execution[modifier] ?? false;
      const resolved = validateReference(
        value,
        fields,
        'toggle',
        `${field} ${modifier}`,
      );

      if (typeof resolved !== 'boolean' && !resolved?.setting) {
        throw new TypeError(`${field} ${modifier} is invalid.`);
      }

      validated[modifier] = resolved;
    }

    return validated;
  }

  if (execution.type === 'media') {
    const command = validateReference(
      execution.command,
      fields,
      'select',
      `${field} command`,
    );

    if (typeof command === 'string' && !MEDIA_COMMANDS.has(command)) {
      throw new TypeError(`${field} media command is unknown.`);
    }

    if (typeof command !== 'string' && !command?.setting) {
      throw new TypeError(`${field} media command is invalid.`);
    }

    if (
      command?.setting &&
      fields.get(command.setting).options.some(
        (option) => !MEDIA_COMMANDS.has(option.value),
      )
    ) {
      throw new TypeError(
        `${field} media command setting contains an unknown command.`,
      );
    }

    return { type: 'media', command };
  }

  const url = validateReference(execution.url, fields, null, `${field} URL`);

  if (typeof url !== 'string' && !url?.setting) {
    throw new TypeError(`${field} URL is invalid.`);
  }

  if (url?.setting && fields.get(url.setting).type === 'toggle') {
    throw new TypeError(`${field} URL references an incompatible setting.`);
  }

  if (typeof url === 'string' && !/^https:\/\//i.test(url)) {
    throw new TypeError(`${field} URL must use https.`);
  }

  const query = execution.query === undefined
    ? {}
    : requireObject(execution.query, `${field} query`);
  const validatedQuery = {};

  if (Object.keys(query).length > MAX_FIELDS) {
    throw new TypeError(`${field} has too many query parameters.`);
  }

  for (const [name, value] of Object.entries(query)) {
    requireString(name, `${field} query name`, 80);
    const resolved = validateReference(value, fields, null, `${field} query ${name}`);

    if (typeof resolved !== 'string' && !resolved?.setting) {
      throw new TypeError(`${field} query ${name} is invalid.`);
    }

    validatedQuery[name] = resolved;
  }

  return { type: 'url', url, query: validatedQuery };
}

function validateAppearance(raw, actionId) {
  if (raw === undefined) {
    return undefined;
  }

  const appearance = requireObject(raw, `Plugin action ${actionId} appearance`);
  const validated = {};

  for (const [name, maximumLength] of [['label', 32], ['icon', 64]]) {
    const value = optionalString(
      appearance[name],
      `Plugin action ${actionId} appearance ${name}`,
      maximumLength,
    );

    if (value !== undefined) {
      validated[name] = value;
    }
  }

  for (const name of ['color', 'labelColor']) {
    const value = optionalString(
      appearance[name],
      `Plugin action ${actionId} appearance ${name}`,
      7,
      COLOR_PATTERN,
    );

    if (value !== undefined) {
      validated[name] = value;
    }
  }

  return validated;
}

function validateActionDefinition(raw, pluginId) {
  const action = requireObject(raw, `Plugin ${pluginId} action`);
  const id = requireString(action.id, 'Plugin action id', 64, ID_PATTERN);

  if (!Array.isArray(action.fields) || action.fields.length > MAX_FIELDS) {
    throw new TypeError(`Plugin action ${id} fields are invalid.`);
  }

  const fields = action.fields.map((field) => validateField(field, id));
  const fieldMap = new Map(fields.map((field) => [field.id, field]));

  if (fieldMap.size !== fields.length) {
    throw new TypeError(`Plugin action ${id} field ids must be unique.`);
  }

  const platforms = requireObject(
    action.platforms,
    `Plugin action ${id} platforms`,
  );
  const validatedPlatforms = {};

  for (const [platform, execution] of Object.entries(platforms)) {
    if (!PLATFORMS.has(platform)) {
      throw new TypeError(`Plugin action ${id} platform is unknown.`);
    }

    validatedPlatforms[platform] = validateExecution(
      execution,
      fieldMap,
      `Plugin action ${id} ${platform}`,
    );
  }

  if (Object.keys(validatedPlatforms).length === 0) {
    throw new TypeError(`Plugin action ${id} needs a platform binding.`);
  }

  const keywords = action.keywords === undefined ? [] : action.keywords;

  if (!Array.isArray(keywords) || keywords.length > 24) {
    throw new TypeError(`Plugin action ${id} keywords are invalid.`);
  }

  return {
    id,
    name: requireString(action.name, `Plugin action ${id} name`, 80),
    description: optionalString(
      action.description,
      `Plugin action ${id} description`,
      240,
    ) || '',
    category: optionalString(
      action.category,
      `Plugin action ${id} category`,
      60,
    ) || 'Plugin',
    icon: optionalString(action.icon, `Plugin action ${id} icon`, 64) ||
      'extension',
    keywords: keywords.map((keyword) =>
      requireString(keyword, `Plugin action ${id} keyword`, 40)),
    fields,
    platforms: validatedPlatforms,
    appearance: validateAppearance(action.appearance, id),
  };
}

function validatePluginManifest(raw) {
  const manifest = requireObject(raw, 'Plugin manifest');

  if (manifest.stream32Plugin !== PLUGIN_SCHEMA_VERSION) {
    throw new TypeError('Plugin manifest has an unsupported schema version.');
  }

  const id = requireString(manifest.id, 'Plugin id', 64, ID_PATTERN);

  if (
    !Array.isArray(manifest.actions) ||
    manifest.actions.length === 0 ||
    manifest.actions.length > MAX_ACTIONS
  ) {
    throw new TypeError(`Plugin ${id} actions are invalid.`);
  }

  const actions = manifest.actions.map((action) =>
    validateActionDefinition(action, id));

  if (new Set(actions.map((action) => action.id)).size !== actions.length) {
    throw new TypeError(`Plugin ${id} action ids must be unique.`);
  }

  return {
    stream32Plugin: PLUGIN_SCHEMA_VERSION,
    id,
    name: requireString(manifest.name, `Plugin ${id} name`, 80),
    version: requireString(
      manifest.version,
      `Plugin ${id} version`,
      32,
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    ),
    description: optionalString(
      manifest.description,
      `Plugin ${id} description`,
      240,
    ) || '',
    actions,
  };
}

function normalizeSettings(definition, rawSettings) {
  const raw = rawSettings === undefined
    ? {}
    : requireObject(rawSettings, 'Plugin action settings');
  const fields = new Map(definition.fields.map((field) => [field.id, field]));

  for (const id of Object.keys(raw)) {
    if (!fields.has(id)) {
      throw new TypeError(`Unknown plugin setting: ${id}`);
    }
  }

  const settings = {};

  for (const field of definition.fields) {
    const value = raw[field.id] ?? field.default;

    if (field.type === 'toggle') {
      if (typeof value !== 'boolean') {
        throw new TypeError(`Plugin setting ${field.id} must be a boolean.`);
      }
    } else if (typeof value !== 'string') {
      throw new TypeError(`Plugin setting ${field.id} must be a string.`);
    } else if (field.type === 'text') {
      if (value.length > field.maxLength || (field.required && !value)) {
        throw new TypeError(`Plugin setting ${field.id} is invalid.`);
      }
    } else if (!field.options.some((option) => option.value === value)) {
      throw new TypeError(`Plugin setting ${field.id} is not an option.`);
    }

    settings[field.id] = value;
  }

  return settings;
}

function resolveValue(value, settings) {
  return value && typeof value === 'object'
    ? settings[value.setting]
    : value;
}

function resolveExecution(definition, platform, rawSettings) {
  const execution = definition.platforms[platform];

  if (!execution) {
    throw new Error(`${definition.name} is not supported on this platform.`);
  }

  const settings = normalizeSettings(definition, rawSettings);

  if (execution.type === 'hotkey') {
    const action = {
      type: 'hotkey',
      key: resolveValue(execution.key, settings),
      alt: resolveValue(execution.alt, settings),
      ctrl: resolveValue(execution.ctrl, settings),
      meta: resolveValue(execution.meta, settings),
      shift: resolveValue(execution.shift, settings),
    };

    if (!HOTKEY_KEY_NAMES.has(action.key)) {
      throw new TypeError('Plugin resolved an unknown hotkey.');
    }

    return action;
  }

  if (execution.type === 'media') {
    const command = resolveValue(execution.command, settings);

    if (!MEDIA_COMMANDS.has(command)) {
      throw new TypeError('Plugin resolved an unknown media command.');
    }

    return { type: 'media', command };
  }

  const url = new URL(resolveValue(execution.url, settings));

  if (url.protocol !== 'https:') {
    throw new TypeError('Plugin resolved a URL that does not use https.');
  }

  for (const [name, value] of Object.entries(execution.query)) {
    url.searchParams.set(name, resolveValue(value, settings));
  }

  return { type: 'url', url: url.toString() };
}

module.exports = {
  MAX_SETTING_LENGTH,
  PLUGIN_SCHEMA_VERSION,
  normalizeSettings,
  resolveExecution,
  validatePluginManifest,
  validatePluginReference,
};
