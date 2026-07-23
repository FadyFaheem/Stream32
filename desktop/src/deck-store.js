const { app } = require('electron');
const path = require('node:path');

const {
  BOARD_ID_PATTERN,
  DECK_REGISTRY_VERSION,
  DEVICE_ID_PATTERN,
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
} = require('./deck-model');
const { readJsonRecovering } = require('./atomic-json');
const { validateAppMatch } = require('./profile-rules');
const { readSettings, writeSettings } = require('./settings');

const DECKS_FILENAME = 'decks.json';
const PRESERVED_DEVICES = Symbol('preservedDevices');
const PRESERVED_DEVICE_FIELDS = Symbol('preservedDeviceFields');
const PRESERVED_PROFILES = Symbol('preservedProfiles');

function getDecksPath() {
  return path.join(app.getPath('userData'), DECKS_FILENAME);
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

function salvageDeckRegistry(raw) {
  const registry = {
    version: DECK_REGISTRY_VERSION,
    devices: {},
    errors: [],
  };
  const preservedDevices = {};
  const rawDevices =
    raw?.devices && typeof raw.devices === 'object' && !Array.isArray(raw.devices)
      ? raw.devices
      : {};

  for (const [deviceId, rawDevice] of Object.entries(rawDevices).sort()) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      preservedDevices[deviceId] = structuredClone(rawDevice);
      registry.errors.push({
        deviceId,
        message: `Device ${deviceId} has an invalid id and was preserved.`,
      });
      continue;
    }

    if (
      !rawDevice ||
      typeof rawDevice !== 'object' ||
      Array.isArray(rawDevice) ||
      typeof rawDevice.boardId !== 'string' ||
      !BOARD_ID_PATTERN.test(rawDevice.boardId) ||
      !rawDevice.profiles ||
      typeof rawDevice.profiles !== 'object' ||
      Array.isArray(rawDevice.profiles)
    ) {
      preservedDevices[deviceId] = structuredClone(rawDevice);
      registry.errors.push({
        deviceId,
        message: `Device ${deviceId} is corrupt and was preserved.`,
      });
      continue;
    }

    const profiles = {};
    const preservedProfiles = {};
    const preservedFields = {};

    for (const [profileId, rawProfile] of
      Object.entries(rawDevice.profiles).sort()) {
      try {
        if (!PROFILE_ID_PATTERN.test(profileId)) {
          throw new TypeError('Deck profile id is invalid.');
        }

        const profile = validateProfile(rawProfile);

        if (profile.boardId !== rawDevice.boardId) {
          throw new TypeError('Profile board does not match the device.');
        }

        profiles[profileId] = profile;
      } catch {
        preservedProfiles[profileId] = structuredClone(rawProfile);
        registry.errors.push({
          deviceId,
          profileId,
          message:
            `Profile ${profileId} on device ${deviceId} is corrupt and was preserved.`,
        });
      }
    }

    const validIds = Object.keys(profiles).sort();

    if (validIds.length === 0) {
      preservedDevices[deviceId] = structuredClone(rawDevice);
      registry.errors.push({
        deviceId,
        message:
          `Device ${deviceId} has no valid profiles and was preserved.`,
      });
      continue;
    }

    let defaultProfileId = rawDevice.defaultProfileId;
    let activeProfileId = rawDevice.activeProfileId;

    if (!profiles[defaultProfileId]) {
      preservedFields.defaultProfileId = structuredClone(defaultProfileId);
      defaultProfileId = validIds[0];
      registry.errors.push({
        deviceId,
        message:
          `Device ${deviceId} had an invalid default profile; ` +
          `${defaultProfileId} is used until storage is repaired.`,
      });
    }

    if (!profiles[activeProfileId]) {
      preservedFields.activeProfileId = structuredClone(activeProfileId);
      activeProfileId = defaultProfileId;
      registry.errors.push({
        deviceId,
        message:
          `Device ${deviceId} had an invalid active profile; ` +
          `${activeProfileId} is used until storage is repaired.`,
      });
    }

    let name = 'Stream32 deck';

    try {
      name =
        optionalString(rawDevice.name, 'Device nickname', MAX_NAME_LENGTH) ||
        name;
    } catch {
      preservedFields.name = structuredClone(rawDevice.name);
      registry.errors.push({
        deviceId,
        message:
          `Device ${deviceId} has an invalid nickname that was preserved.`,
      });
    }

    const device = {
      name,
      boardId: rawDevice.boardId,
      activeProfileId,
      defaultProfileId,
      profiles,
    };
    defineHidden(device, PRESERVED_DEVICE_FIELDS, preservedFields);
    defineHidden(device, PRESERVED_PROFILES, preservedProfiles);
    registry.devices[deviceId] = device;
  }

  defineHidden(registry, PRESERVED_DEVICES, preservedDevices);
  return registry;
}

function readDecks(decksPath) {
  const raw = readSettings(decksPath);
  const isCurrent = raw.version === DECK_REGISTRY_VERSION;

  if (raw.version !== undefined && !isCurrent) {
    throw new TypeError('Deck registry has an unsupported version.');
  }

  if (!raw.devices && raw.version === undefined) {
    return { version: DECK_REGISTRY_VERSION, devices: {}, errors: [] };
  }

  try {
    const registry = validateDeckRegistry(raw);

    if (!isCurrent) {
      writeSettings(registry, decksPath);
    }

    return { ...registry, errors: [] };
  } catch (primaryError) {
    if (isCurrent) {
      const salvaged = salvageDeckRegistry(raw);

      if (Object.keys(salvaged.devices).length > 0) {
        return salvaged;
      }
    }

    try {
      const recovered = readJsonRecovering(decksPath, {
        validate: validateDeckRegistry,
      });
      return { ...recovered, errors: [] };
    } catch {
      if (!isCurrent) {
        throw primaryError;
      }
    }
  }

  return salvageDeckRegistry(raw);
}

function requireDevice(registry, deviceId) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError('Device id is invalid.');
  }

  const device = registry.devices[deviceId];

  if (!device) {
    throw new Error('This device has no saved deck profiles.');
  }

  return device;
}

function profileEntryCount(device) {
  return (
    Object.keys(device.profiles).length +
    Object.keys(device[PRESERVED_PROFILES] || {}).length
  );
}

function uniqueProfileName(device, requestedName) {
  const base = optionalString(
    requestedName,
    'Profile name',
    MAX_NAME_LENGTH,
  ) || 'Profile';
  const names = new Set([
    ...Object.values(device.profiles)
      .map((profile) => profile.name.toLowerCase()),
    ...Object.values(device[PRESERVED_PROFILES] || {})
      .map((profile) =>
        typeof profile?.name === 'string' ? profile.name.toLowerCase() : null)
      .filter(Boolean),
  ]);

  if (!names.has(base.toLowerCase())) {
    return base;
  }

  for (let suffix = 2; suffix <= MAX_PROFILES + 1; suffix++) {
    const ending = ` ${suffix}`;
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - ending.length)}${ending}`;

    if (!names.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  throw new Error('Could not create a unique profile name.');
}

function profileIdBase(name) {
  const id = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return PROFILE_ID_PATTERN.test(id) ? id : 'profile';
}

function uniqueProfileId(device, name) {
  const base = profileIdBase(name);
  const preserved = device[PRESERVED_PROFILES] || {};

  if (!device.profiles[base] && !Object.hasOwn(preserved, base)) {
    return base;
  }

  for (let suffix = 2; suffix <= MAX_PROFILES + 1; suffix++) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 32 - ending.length)}${ending}`;

    if (!device.profiles[candidate] && !Object.hasOwn(preserved, candidate)) {
      return candidate;
    }
  }

  throw new Error('Could not create a unique profile id.');
}

function writeRegistry(registry, decksPath) {
  const validated = validateDeckRegistry(registry);
  const serialized = structuredClone(validated);

  for (const [deviceId, device] of Object.entries(registry.devices)) {
    const preservedFields = device[PRESERVED_DEVICE_FIELDS];
    const preservedProfiles = device[PRESERVED_PROFILES];

    if (preservedFields && Object.keys(preservedFields).length > 0) {
      Object.assign(
        serialized.devices[deviceId],
        structuredClone(preservedFields),
      );
    }

    if (preservedProfiles && Object.keys(preservedProfiles).length > 0) {
      Object.assign(
        serialized.devices[deviceId].profiles,
        structuredClone(preservedProfiles),
      );
    }
  }

  Object.assign(
    serialized.devices,
    structuredClone(registry[PRESERVED_DEVICES] || {}),
  );
  writeSettings(serialized, decksPath);
  return validated;
}

function registerDevice(deviceId, boardId, name, decksPath) {
  const registry = readDecks(decksPath);

  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError('Device id is invalid.');
  }

  if (registry.devices[deviceId]) {
    if (registry.devices[deviceId].boardId !== boardId) {
      throw new Error('The connected board does not match its saved profiles.');
    }

    return registry.devices[deviceId];
  }

  if (
    Object.keys(registry.devices).length +
      Object.keys(registry[PRESERVED_DEVICES] || {}).length >=
    MAX_DEVICES
  ) {
    throw new Error(`At most ${MAX_DEVICES} devices are supported.`);
  }

  const profile = createDefaultProfile(boardId);
  registry.devices[deviceId] = validateDevice({
    name,
    boardId,
    activeProfileId: 'default',
    defaultProfileId: 'default',
    profiles: { default: profile },
  });
  writeRegistry(registry, decksPath);
  return registry.devices[deviceId];
}

function saveDeviceProfile(deviceId, profileId, profile, decksPath) {
  return saveDeviceProfiles(
    deviceId,
    [{ profileId, profile }],
    decksPath,
  )[profileId];
}

function saveDeviceProfiles(deviceId, updates, decksPath) {
  if (
    !Array.isArray(updates) ||
    updates.length === 0 ||
    updates.length > MAX_PROFILES
  ) {
    throw new TypeError('Profile updates are invalid.');
  }

  const registry = readDecks(decksPath);
  const device = requireDevice(registry, deviceId);
  const validatedProfiles = {};
  const seen = new Set();

  for (const update of updates) {
    if (
      !update ||
      typeof update !== 'object' ||
      Array.isArray(update) ||
      !PROFILE_ID_PATTERN.test(update.profileId) ||
      !device.profiles[update.profileId] ||
      seen.has(update.profileId)
    ) {
      throw new TypeError('Profile update is invalid.');
    }

    const validated = validateProfile({
      ...update.profile,
      name: device.profiles[update.profileId].name,
    });

    if (validated.boardId !== device.boardId) {
      throw new TypeError('Profile board does not match the device.');
    }

    seen.add(update.profileId);
    validatedProfiles[update.profileId] = validated;
  }

  Object.assign(device.profiles, validatedProfiles);
  writeRegistry(registry, decksPath);
  return validatedProfiles;
}

function renameDevice(deviceId, name, decksPath) {
  const registry = readDecks(decksPath);
  const device = requireDevice(registry, deviceId);
  device.name = optionalString(name, 'Device nickname', MAX_NAME_LENGTH) ||
    'Stream32 deck';
  delete device[PRESERVED_DEVICE_FIELDS]?.name;
  writeRegistry(registry, decksPath);
  return device;
}

function applyProfileOperation(deviceId, operation, decksPath) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('Profile operation is invalid.');
  }

  const registry = readDecks(decksPath);
  const device = requireDevice(registry, deviceId);

  switch (operation.type) {
    case 'select': {
      if (
        !PROFILE_ID_PATTERN.test(operation.profileId) ||
        !device.profiles[operation.profileId]
      ) {
        throw new TypeError('Profile id is invalid.');
      }

      device.activeProfileId = operation.profileId;
      delete device[PRESERVED_DEVICE_FIELDS]?.activeProfileId;
      break;
    }
    case 'set-default': {
      if (
        !PROFILE_ID_PATTERN.test(operation.profileId) ||
        !device.profiles[operation.profileId]
      ) {
        throw new TypeError('Profile id is invalid.');
      }

      device.defaultProfileId = operation.profileId;
      delete device[PRESERVED_DEVICE_FIELDS]?.defaultProfileId;
      break;
    }
    case 'set-app-match': {
      if (
        !PROFILE_ID_PATTERN.test(operation.profileId) ||
        !device.profiles[operation.profileId]
      ) {
        throw new TypeError('Profile id is invalid.');
      }

      const profile = device.profiles[operation.profileId];

      if (operation.rule === null) {
        if (!['win32', 'darwin', 'linux'].includes(operation.platform)) {
          throw new TypeError('App match platform is invalid.');
        }

        delete profile.appMatches[operation.platform];
      } else {
        profile.appMatches[operation.platform] = validateAppMatch(
          operation.platform,
          operation.rule,
        );
      }
      break;
    }
    case 'create': {
      if (profileEntryCount(device) >= MAX_PROFILES) {
        throw new Error(`At most ${MAX_PROFILES} profiles are supported.`);
      }

      const name = uniqueProfileName(device, operation.name);
      const profileId = uniqueProfileId(device, name);
      device.profiles[profileId] = {
        ...createDefaultProfile(device.boardId),
        name,
      };
      device.activeProfileId = profileId;
      delete device[PRESERVED_DEVICE_FIELDS]?.activeProfileId;
      break;
    }
    case 'duplicate': {
      if (profileEntryCount(device) >= MAX_PROFILES) {
        throw new Error(`At most ${MAX_PROFILES} profiles are supported.`);
      }

      if (
        !PROFILE_ID_PATTERN.test(operation.profileId) ||
        !device.profiles[operation.profileId]
      ) {
        throw new TypeError('Profile id is invalid.');
      }

      const source = device.profiles[operation.profileId];
      const name = uniqueProfileName(
        device,
        `${source.name.slice(0, MAX_NAME_LENGTH - 5)} copy`,
      );
      const profileId = uniqueProfileId(device, name);
      device.profiles[profileId] = validateProfile({
        ...structuredClone(source),
        name,
      });
      device.activeProfileId = profileId;
      delete device[PRESERVED_DEVICE_FIELDS]?.activeProfileId;
      break;
    }
    case 'rename': {
      if (
        !PROFILE_ID_PATTERN.test(operation.profileId) ||
        !device.profiles[operation.profileId]
      ) {
        throw new TypeError('Profile id is invalid.');
      }

      const otherNames = new Set(
        Object.entries(device.profiles)
          .filter(([profileId]) => profileId !== operation.profileId)
          .map(([, profile]) => profile.name.toLowerCase()),
      );
      const name = optionalString(
        operation.name,
        'Profile name',
        MAX_NAME_LENGTH,
      );

      if (!name) {
        throw new TypeError('Profile name is required.');
      }

      if (otherNames.has(name.toLowerCase())) {
        throw new Error('Profile names must be unique per device.');
      }

      device.profiles[operation.profileId].name = name;
      break;
    }
    case 'delete': {
      if (
        !PROFILE_ID_PATTERN.test(operation.profileId) ||
        !device.profiles[operation.profileId]
      ) {
        throw new TypeError('Profile id is invalid.');
      }

      const remaining = Object.keys(device.profiles)
        .filter((profileId) => profileId !== operation.profileId)
        .sort();

      if (remaining.length === 0) {
        throw new Error('The last profile cannot be deleted.');
      }

      const wasActive = device.activeProfileId === operation.profileId;
      const wasDefault = device.defaultProfileId === operation.profileId;
      delete device.profiles[operation.profileId];

      if (wasDefault) {
        device.defaultProfileId = remaining[0];
      }

      if (wasActive) {
        device.activeProfileId = device.defaultProfileId;
        delete device[PRESERVED_DEVICE_FIELDS]?.activeProfileId;
      }
      break;
    }
    default:
      throw new TypeError(`Unknown profile operation: ${operation.type}`);
  }

  writeRegistry(registry, decksPath);
  return device;
}

function addImportedProfile(deviceId, profile, decksPath) {
  const registry = readDecks(decksPath);
  const device = requireDevice(registry, deviceId);

  if (profileEntryCount(device) >= MAX_PROFILES) {
    throw new Error(`At most ${MAX_PROFILES} profiles are supported.`);
  }

  const imported = validateProfile(profile);

  if (imported.boardId !== device.boardId) {
    throw new TypeError('Imported profile is for a different board.');
  }

  const name = uniqueProfileName(device, imported.name);
  const profileId = uniqueProfileId(device, name);
  device.profiles[profileId] = { ...imported, name };
  device.activeProfileId = profileId;
  delete device[PRESERVED_DEVICE_FIELDS]?.activeProfileId;
  writeRegistry(registry, decksPath);
  return device;
}

module.exports = {
  DECK_REGISTRY_VERSION,
  MAX_DEVICES,
  MAX_IMPORT_BYTES,
  MAX_PROFILES,
  addImportedProfile,
  applyProfileOperation,
  createDefaultProfile,
  exportProfile,
  getDecksPath,
  importProfile,
  readDecks,
  registerDevice,
  renameDevice,
  saveDeviceProfile,
  saveDeviceProfiles,
  validateAction,
  validateDeckRegistry,
  validateDevice,
  validateHostAction,
  validateProfile,
};
