const {
  MAX_DELAY_MS,
  MAX_MULTI_STEPS,
  MAX_TOTAL_DELAY_MS,
  validateMouseAction,
  validateTextAction,
} = require('./action-model');
const { validateLiveState } = require('./dynamic-state');
const { HOTKEY_KEY_NAMES, MEDIA_COMMANDS } = require('./keymap');
const { validatePluginReference } = require('./plugin-manifest');
const { validateAppMatches } = require('./profile-rules');

const DECK_REGISTRY_VERSION = 2;
const EXPORT_SCHEMA_VERSION = 5;
const IMPORT_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, EXPORT_SCHEMA_VERSION]);
const MAX_DEVICES = 32;
const MAX_PROFILES = 16;
const MAX_PAGES = 8;
const MAX_ROWS = 10;
const MAX_COLS = 10;
// Protocol ceiling: rows x cols per page (one layout line per page).
const MAX_KEYS_PER_PAGE = 40;
const MAX_LABEL_LENGTH = 32;
const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
const MAX_COMMAND_LENGTH = 1024;
const MAX_IMAGE_DATA_URL_LENGTH = 256 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

const DEVICE_ID_PATTERN = /^[a-f0-9]{12}$/;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// "<rows>x<cols>"; bounds mirror MAX_ROWS / MAX_COLS.
const KEY_PX_GRID_PATTERN = /^(10|[1-9])x(10|[1-9])$/;
const URL_PATTERN = /^https?:\/\//i;

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is outside the supported range.`);
  }

  return value;
}

function optionalString(value, field, maximumLength, pattern = null) {
  if (value === undefined) {
    return undefined;
  }

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

function validateLeafAction(action, pageCount) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('Key action must be an object.');
  }

  switch (action.type) {
    case 'text':
      return validateTextAction(action);
    case 'mouse':
      return validateMouseAction(action);
    case 'media':
      if (!MEDIA_COMMANDS.has(action.command)) {
        throw new TypeError('Unknown media command.');
      }

      return { type: 'media', command: action.command };
    case 'url': {
      const url = optionalString(action.url, 'Action URL', MAX_URL_LENGTH);

      if (!url || !URL_PATTERN.test(url)) {
        throw new TypeError('Action URL must use http or https.');
      }

      return { type: 'url', url };
    }
    case 'launch': {
      const command = optionalString(
        action.command,
        'Launch command',
        MAX_COMMAND_LENGTH,
      );

      if (!command) {
        throw new TypeError('Launch command is required.');
      }

      return { type: 'launch', command };
    }
    case 'hotkey': {
      if (!HOTKEY_KEY_NAMES.has(action.key)) {
        throw new TypeError('Unknown hotkey key name.');
      }

      return {
        type: 'hotkey',
        key: action.key,
        alt: Boolean(action.alt),
        ctrl: Boolean(action.ctrl),
        meta: Boolean(action.meta),
        shift: Boolean(action.shift),
      };
    }
    case 'page':
      return {
        type: 'page',
        page: requireInteger(action.page, 'Action page', 0, pageCount - 1),
      };
    case 'profile': {
      const profileId = optionalString(
        action.profileId,
        'Action profile id',
        32,
        PROFILE_ID_PATTERN,
      );

      if (!profileId) {
        throw new TypeError('Action profile id is required.');
      }

      return { type: 'profile', profileId };
    }
    case 'plugin':
      return validatePluginReference(action);
    default:
      throw new TypeError(`Unknown action type: ${action?.type}`);
  }
}

function validateAction(action, pageCount) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('Key action must be an object.');
  }

  if (action.type === 'delay') {
    throw new TypeError('Delay steps are only valid inside multi actions.');
  }

  if (action.type !== 'multi') {
    return validateLeafAction(action, pageCount);
  }

  if (
    !Array.isArray(action.steps) ||
    action.steps.length === 0 ||
    action.steps.length > MAX_MULTI_STEPS
  ) {
    throw new TypeError(`Multi actions need 1-${MAX_MULTI_STEPS} steps.`);
  }

  let totalDelay = 0;
  const steps = action.steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new TypeError(`Step ${index + 1}: Multi action steps must be objects.`);
    }

    if (step.type === 'multi') {
      throw new TypeError(`Step ${index + 1}: Multi actions cannot be nested.`);
    }

    if (step.type === 'delay') {
      if (
        !Number.isInteger(step.ms) ||
        step.ms < 0 ||
        step.ms > MAX_DELAY_MS
      ) {
        throw new TypeError(
          `Step ${index + 1}: Multi action delay must be between 0 and ` +
          `${MAX_DELAY_MS.toLocaleString()} ms.`,
        );
      }

      const ms = step.ms;
      totalDelay += ms;
      return { type: 'delay', ms };
    }

    try {
      return validateLeafAction(step, pageCount);
    } catch (error) {
      throw new TypeError(`Step ${index + 1}: ${error.message}`);
    }
  });

  if (totalDelay > MAX_TOTAL_DELAY_MS) {
    throw new TypeError(
      `Multi action total delay cannot exceed ` +
      `${MAX_TOTAL_DELAY_MS.toLocaleString()} ms.`,
    );
  }

  return { type: 'multi', steps };
}

function validateHostAction(action) {
  if (['page', 'profile', 'multi', 'delay'].includes(action?.type)) {
    throw new TypeError(
      `${action?.type === 'page'
        ? 'Page'
        : action?.type === 'profile'
          ? 'Profile'
          : 'Multi and delay'} actions ` +
      'never reach the main process unexpanded.',
    );
  }

  return validateLeafAction(action, 1);
}

function validateKey(key, keyCount, pageCount) {
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    throw new TypeError('Deck key must be an object.');
  }

  const validated = {
    index: requireInteger(key.index, 'Key index', 0, keyCount - 1),
  };
  const label = optionalString(key.label, 'Key label', MAX_LABEL_LENGTH);
  const color = optionalString(key.color, 'Key color', 7, COLOR_PATTERN);
  const labelColor = optionalString(
    key.labelColor,
    'Key label color',
    7,
    COLOR_PATTERN,
  );

  if (label !== undefined) {
    validated.label = label;
  }

  if (color !== undefined) {
    validated.color = color;
  }

  if (labelColor !== undefined) {
    validated.labelColor = labelColor;
  }

  if (key.image !== undefined) {
    validated.image = optionalString(
      key.image,
      'Key image',
      MAX_IMAGE_DATA_URL_LENGTH,
      IMAGE_DATA_URL_PATTERN,
    );
  }

  if (key.action !== undefined) {
    validated.action = validateAction(key.action, pageCount);
  }

  if (key.liveState !== undefined) {
    validated.liveState = validateLiveState(key.liveState);
  }

  return validated;
}

function validatePage(page, pageCount) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    throw new TypeError('Deck page must be an object.');
  }

  const rows = requireInteger(page.rows, 'Page rows', 1, MAX_ROWS);
  const cols = requireInteger(page.cols, 'Page cols', 1, MAX_COLS);
  const keyCount = requireInteger(
    rows * cols,
    'Page keys per page',
    1,
    MAX_KEYS_PER_PAGE,
  );

  if (!Array.isArray(page.keys) || page.keys.length > keyCount) {
    throw new TypeError('Page keys are invalid.');
  }

  const seen = new Set();
  const keys = page.keys.map((key) => {
    const validated = validateKey(key, keyCount, pageCount);

    if (seen.has(validated.index)) {
      throw new TypeError('Page keys must have unique indexes.');
    }

    seen.add(validated.index);
    return validated;
  });

  return {
    name: optionalString(page.name, 'Page name', MAX_NAME_LENGTH) || 'Page',
    appMatches: validateAppMatches(page.appMatches),
    rows,
    cols,
    keys,
  };
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('Deck profile must be an object.');
  }

  if (
    typeof profile.boardId !== 'string' ||
    !BOARD_ID_PATTERN.test(profile.boardId)
  ) {
    throw new TypeError('Deck profile board id is invalid.');
  }

  if (
    !Array.isArray(profile.pages) ||
    profile.pages.length === 0 ||
    profile.pages.length > MAX_PAGES
  ) {
    throw new TypeError(`Deck profiles need 1-${MAX_PAGES} pages.`);
  }

  const pageCount = profile.pages.length;
  const validated = {
    name: optionalString(profile.name, 'Profile name', MAX_NAME_LENGTH) ||
      'Default',
    boardId: profile.boardId,
    appMatches: validateAppMatches(profile.appMatches),
    activePage: requireInteger(
      profile.activePage ?? 0,
      'Active page',
      0,
      pageCount - 1,
    ),
    defaultPage: requireInteger(
      profile.defaultPage ?? profile.activePage ?? 0,
      'Default page',
      0,
      pageCount - 1,
    ),
    pages: profile.pages.map((page) => validatePage(page, pageCount)),
    keyPx: {},
  };

  if (profile.keyPx !== undefined) {
    if (
      !profile.keyPx ||
      typeof profile.keyPx !== 'object' ||
      Array.isArray(profile.keyPx)
    ) {
      throw new TypeError('Deck keyPx cache is invalid.');
    }

    for (const [grid, px] of Object.entries(profile.keyPx)) {
      if (!KEY_PX_GRID_PATTERN.test(grid)) {
        throw new TypeError('Deck keyPx grid key is invalid.');
      }

      validated.keyPx[grid] = requireInteger(px, 'Deck keyPx', 16, 512);
    }
  }

  return validated;
}

function createDefaultProfile(boardId) {
  return validateProfile({
    name: 'Default',
    boardId,
    activePage: 0,
    defaultPage: 0,
    pages: [{ name: 'Main', rows: 3, cols: 3, keys: [] }],
  });
}

function validateDevice(device) {
  if (
    !device ||
    typeof device !== 'object' ||
    Array.isArray(device) ||
    typeof device.boardId !== 'string' ||
    !BOARD_ID_PATTERN.test(device.boardId) ||
    !device.profiles ||
    typeof device.profiles !== 'object' ||
    Array.isArray(device.profiles)
  ) {
    throw new TypeError('Deck registry device is invalid.');
  }

  const entries = Object.entries(device.profiles);

  if (entries.length === 0 || entries.length > MAX_PROFILES) {
    throw new TypeError(`Devices need 1-${MAX_PROFILES} profiles.`);
  }

  const profiles = {};

  for (const [profileId, profile] of entries) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new TypeError('Deck profile id is invalid.');
    }

    const validated = validateProfile(profile);

    if (validated.boardId !== device.boardId) {
      throw new TypeError('Every profile must match its device board.');
    }

    profiles[profileId] = validated;
  }

  if (
    !PROFILE_ID_PATTERN.test(device.activeProfileId) ||
    !profiles[device.activeProfileId]
  ) {
    throw new TypeError('Active deck profile is invalid.');
  }

  if (
    !PROFILE_ID_PATTERN.test(device.defaultProfileId) ||
    !profiles[device.defaultProfileId]
  ) {
    throw new TypeError('Default deck profile is invalid.');
  }

  return {
    name: optionalString(device.name, 'Device nickname', MAX_NAME_LENGTH) ||
      'Stream32 deck',
    boardId: device.boardId,
    activeProfileId: device.activeProfileId,
    defaultProfileId: device.defaultProfileId,
    profiles,
  };
}

function wrapLegacyProfile(profile) {
  const validated = validateProfile(profile);
  const deviceName =
    optionalString(profile.name, 'Device nickname', MAX_NAME_LENGTH) ||
    'Stream32 deck';

  return validateDevice({
    name: deviceName,
    boardId: validated.boardId,
    activeProfileId: 'default',
    defaultProfileId: 'default',
    profiles: {
      default: { ...validated, name: 'Default' },
    },
  });
}

function validateDeckRegistry(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !raw.devices ||
    typeof raw.devices !== 'object' ||
    Array.isArray(raw.devices)
  ) {
    throw new TypeError('Deck registry is invalid.');
  }

  if (
    raw.version !== undefined &&
    raw.version !== DECK_REGISTRY_VERSION
  ) {
    throw new TypeError('Deck registry has an unsupported version.');
  }

  const entries = Object.entries(raw.devices);

  if (entries.length > MAX_DEVICES) {
    throw new TypeError(`At most ${MAX_DEVICES} devices are supported.`);
  }

  const devices = {};
  const isCurrent = raw.version === DECK_REGISTRY_VERSION;

  for (const [deviceId, device] of entries) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new TypeError('Deck registry device id is invalid.');
    }

    devices[deviceId] = isCurrent
      ? validateDevice(device)
      : wrapLegacyProfile(device);
  }

  return { version: DECK_REGISTRY_VERSION, devices };
}

function validateProfileEnvelope(value) {
  if (!value || !IMPORT_SCHEMA_VERSIONS.has(value.stream32Deck)) {
    throw new TypeError('Deck profile file has an unsupported format.');
  }

  return validateProfile(value.profile);
}

function exportProfile(profile) {
  return `${JSON.stringify(
    {
      stream32Deck: EXPORT_SCHEMA_VERSION,
      profile: validateProfile(profile),
    },
    null,
    2,
  )}\n`;
}

function importProfile(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
    throw new TypeError('Deck profile file is too large or unreadable.');
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError('Deck profile file is not valid JSON.');
  }

  return validateProfileEnvelope(parsed);
}

module.exports = {
  BOARD_ID_PATTERN,
  DECK_REGISTRY_VERSION,
  DEVICE_ID_PATTERN,
  EXPORT_SCHEMA_VERSION,
  MAX_DEVICES,
  MAX_IMPORT_BYTES,
  MAX_NAME_LENGTH,
  MAX_PROFILES,
  PROFILE_ID_PATTERN,
  createDefaultProfile,
  exportProfile,
  importProfile,
  optionalString,
  validateAction,
  validateDeckRegistry,
  validateDevice,
  validateHostAction,
  validateProfile,
  validateProfileEnvelope,
};
