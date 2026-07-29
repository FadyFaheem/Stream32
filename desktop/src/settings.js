const { app } = require('electron');
const path = require('node:path');

const { readJsonRecovering, writeJsonAtomic } = require('./atomic-json');
const { normalizeChannel } = require('./update-channel');

const SETTINGS_FILENAME = 'settings.json';
const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  brightnessPercent: 100,
  idleTimeoutMinutes: 10,
  sleepWhenLocked: true,
});
const DISPLAY_IDLE_TIMEOUTS = new Set([1, 5, 10, 15, 30, 60]);
const DEFAULT_COMPANION_SETTINGS = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 16622,
});
// Hostname or IPv4/IPv6 literal of the machine running Companion.
const COMPANION_HOST_PATTERN = /^[A-Za-z0-9._:-]{1,253}$/;

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Settings must be an object.');
  }

  return value;
}

function readSettings(settingsPath = getSettingsPath()) {
  return readJsonRecovering(settingsPath, {
    fallback: {},
    validate: validateSettings,
  });
}

function writeSettings(settings, settingsPath = getSettingsPath()) {
  writeJsonAtomic(settings, settingsPath);
}

function updateSettings(patch, settingsPath = getSettingsPath()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Settings patch must be an object.');
  }

  const settings = { ...readSettings(settingsPath), ...patch };
  writeSettings(settings, settingsPath);
  return settings;
}

function getDisplaySettings(settingsPath = getSettingsPath()) {
  const settings = readSettings(settingsPath);
  const idleTimeoutMinutes =
    DISPLAY_IDLE_TIMEOUTS.has(settings.displayIdleTimeoutMinutes)
      ? settings.displayIdleTimeoutMinutes
      : DEFAULT_DISPLAY_SETTINGS.idleTimeoutMinutes;

  return {
    brightnessPercent:
      Number.isSafeInteger(settings.displayBrightnessPercent) &&
      settings.displayBrightnessPercent >= 0 &&
      settings.displayBrightnessPercent <= 100
        ? settings.displayBrightnessPercent
        : DEFAULT_DISPLAY_SETTINGS.brightnessPercent,
    idleTimeoutMinutes,
    sleepWhenLocked:
      typeof settings.sleepDisplaysWhenLocked === 'boolean'
        ? settings.sleepDisplaysWhenLocked
        : DEFAULT_DISPLAY_SETTINGS.sleepWhenLocked,
  };
}

function setDisplaySettings(value, settingsPath = getSettingsPath()) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.brightnessPercent) ||
    value.brightnessPercent < 0 ||
    value.brightnessPercent > 100 ||
    !DISPLAY_IDLE_TIMEOUTS.has(value.idleTimeoutMinutes) ||
    typeof value.sleepWhenLocked !== 'boolean'
  ) {
    throw new TypeError('Display settings are invalid.');
  }

  updateSettings(
    {
      displayBrightnessPercent: value.brightnessPercent,
      displayIdleTimeoutMinutes: value.idleTimeoutMinutes,
      sleepDisplaysWhenLocked: value.sleepWhenLocked,
    },
    settingsPath,
  );
  return getDisplaySettings(settingsPath);
}

function getCompanionSettings(settingsPath = getSettingsPath()) {
  const settings = readSettings(settingsPath);

  return {
    enabled: settings.companionEnabled === true,
    host:
      typeof settings.companionHost === 'string' &&
      COMPANION_HOST_PATTERN.test(settings.companionHost)
        ? settings.companionHost
        : DEFAULT_COMPANION_SETTINGS.host,
    port:
      Number.isSafeInteger(settings.companionPort) &&
      settings.companionPort >= 1 &&
      settings.companionPort <= 65535
        ? settings.companionPort
        : DEFAULT_COMPANION_SETTINGS.port,
  };
}

function setCompanionSettings(value, settingsPath = getSettingsPath()) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.host !== 'string' ||
    !COMPANION_HOST_PATTERN.test(value.host) ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  ) {
    throw new TypeError('Companion settings are invalid.');
  }

  updateSettings(
    {
      companionEnabled: value.enabled,
      companionHost: value.host,
      companionPort: value.port,
    },
    settingsPath,
  );
  return getCompanionSettings(settingsPath);
}

function getUpdateSettings(settingsPath = getSettingsPath()) {
  const settings = readSettings(settingsPath);
  const developerMode = settings.developerMode === true;

  return {
    developerMode,
    updateChannel: normalizeChannel(settings.updateChannel, developerMode),
  };
}

function setUpdateSettings(value, settingsPath = getSettingsPath()) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.developerMode !== 'boolean' ||
    typeof value.updateChannel !== 'string'
  ) {
    throw new TypeError('Update settings are invalid.');
  }

  updateSettings(
    {
      developerMode: value.developerMode,
      // Clamped rather than rejected so that leaving developer mode drops a
      // pull request channel instead of failing the write.
      updateChannel: normalizeChannel(
        value.updateChannel,
        value.developerMode,
      ),
    },
    settingsPath,
  );
  return getUpdateSettings(settingsPath);
}

module.exports = {
  DEFAULT_COMPANION_SETTINGS,
  DEFAULT_DISPLAY_SETTINGS,
  getCompanionSettings,
  getDisplaySettings,
  getSettingsPath,
  getUpdateSettings,
  readSettings,
  setCompanionSettings,
  setDisplaySettings,
  setUpdateSettings,
  updateSettings,
  validateSettings,
  writeSettings,
};
