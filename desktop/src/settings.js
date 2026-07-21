const { app } = require('electron');
const {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const SETTINGS_FILENAME = 'settings.json';

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function readSettings(settingsPath = getSettingsPath()) {
  try {
    const value = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function writeSettings(settings, settingsPath = getSettingsPath()) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });

  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );

  try {
    renameSync(temporaryPath, settingsPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }

    rmSync(settingsPath, { force: true });
    renameSync(temporaryPath, settingsPath);
  }
}

function updateSettings(patch, settingsPath = getSettingsPath()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Settings patch must be an object.');
  }

  const settings = { ...readSettings(settingsPath), ...patch };
  writeSettings(settings, settingsPath);
  return settings;
}

module.exports = {
  getSettingsPath,
  readSettings,
  updateSettings,
  writeSettings,
};
