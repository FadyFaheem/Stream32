const { app } = require('electron');
const path = require('node:path');

const { readJsonRecovering, writeJsonAtomic } = require('./atomic-json');

const SETTINGS_FILENAME = 'settings.json';
const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  brightnessPercent: 100,
  idleTimeoutMinutes: 10,
  sleepWhenLocked: true,
});
const DISPLAY_IDLE_TIMEOUTS = new Set([1, 5, 10, 15, 30, 60]);

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

module.exports = {
  DEFAULT_DISPLAY_SETTINGS,
  getDisplaySettings,
  getSettingsPath,
  readSettings,
  setDisplaySettings,
  updateSettings,
  validateSettings,
  writeSettings,
};
