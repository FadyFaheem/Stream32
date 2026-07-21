const { app } = require('electron');
const path = require('node:path');

const { HOTKEY_KEY_NAMES, MEDIA_COMMANDS } = require('./keymap');
const { readSettings, writeSettings } = require('./settings');

const DECKS_FILENAME = 'decks.json';
const EXPORT_SCHEMA_VERSION = 1;
const MAX_DEVICES = 32;
const MAX_PAGES = 8;
const MAX_ROWS = 5;
const MAX_COLS = 5;
const MAX_LABEL_LENGTH = 32;
const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
const MAX_COMMAND_LENGTH = 1024;
const MAX_IMAGE_DATA_URL_LENGTH = 256 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

const DEVICE_ID_PATTERN = /^[a-f0-9]{12}$/;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const KEY_PX_GRID_PATTERN = /^[1-5]x[1-5]$/;
const URL_PATTERN = /^https?:\/\//i;

function getDecksPath() {
  return path.join(app.getPath('userData'), DECKS_FILENAME);
}

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

function validateAction(action, pageCount) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('Key action must be an object.');
  }

  switch (action.type) {
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
    default:
      throw new TypeError(`Unknown action type: ${action?.type}`);
  }
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

  if (label !== undefined) {
    validated.label = label;
  }

  if (color !== undefined) {
    validated.color = color;
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

  return validated;
}

function validatePage(page, pageCount) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    throw new TypeError('Deck page must be an object.');
  }

  const rows = requireInteger(page.rows, 'Page rows', 1, MAX_ROWS);
  const cols = requireInteger(page.cols, 'Page cols', 1, MAX_COLS);
  const keyCount = rows * cols;

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
    name: optionalString(profile.name, 'Device name', MAX_NAME_LENGTH) ||
      'Stream32 deck',
    boardId: profile.boardId,
    activePage: requireInteger(
      profile.activePage ?? 0,
      'Active page',
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
    boardId,
    activePage: 0,
    pages: [{ name: 'Main', rows: 3, cols: 3, keys: [] }],
  });
}

function readDecks(decksPath) {
  const raw = readSettings(decksPath);
  const devices = {};

  if (raw.devices && typeof raw.devices === 'object') {
    for (const [deviceId, profile] of Object.entries(raw.devices)) {
      if (!DEVICE_ID_PATTERN.test(deviceId)) {
        continue;
      }

      try {
        devices[deviceId] = validateProfile(profile);
      } catch {
        // A single corrupt profile must not take down the whole registry.
      }
    }
  }

  return { devices };
}

function saveDeviceProfile(deviceId, profile, decksPath) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError('Device id is invalid.');
  }

  const validated = validateProfile(profile);
  const registry = readDecks(decksPath);

  if (
    !registry.devices[deviceId] &&
    Object.keys(registry.devices).length >= MAX_DEVICES
  ) {
    throw new Error(`At most ${MAX_DEVICES} devices are supported.`);
  }

  registry.devices[deviceId] = validated;
  writeSettings(registry, decksPath);
  return validated;
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

  if (!parsed || parsed.stream32Deck !== EXPORT_SCHEMA_VERSION) {
    throw new TypeError('Deck profile file has an unsupported format.');
  }

  return validateProfile(parsed.profile);
}

module.exports = {
  MAX_DEVICES,
  MAX_IMPORT_BYTES,
  createDefaultProfile,
  exportProfile,
  getDecksPath,
  importProfile,
  readDecks,
  saveDeviceProfile,
  validateProfile,
};
