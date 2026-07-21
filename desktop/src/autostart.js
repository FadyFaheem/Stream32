const { app } = require('electron');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const AUTOSTART_FILENAME = 'stream32.desktop';
const SETTINGS_FILENAME = 'settings.json';
const START_HIDDEN_ARGUMENT = '--hidden';

function quoteDesktopArgument(value) {
  if (/[\0\r\n]/.test(value)) {
    throw new TypeError('Desktop-entry arguments cannot contain line breaks.');
  }

  const escaped = value
    .replaceAll('%', '%%')
    .replace(/([\\`"$])/g, '\\$1');

  return `"${escaped}"`;
}

function createLinuxDesktopEntry(executablePath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Stream32',
    'Comment=Start Stream32 at login',
    `Exec=${quoteDesktopArgument(executablePath)} ${START_HIDDEN_ARGUMENT}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function getLinuxAutostartPath() {
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');

  return path.join(configHome, 'autostart', AUTOSTART_FILENAME);
}

function getExecutablePath() {
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }

  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }

  return process.execPath;
}

function getLoginItemOptions(openAtLogin) {
  const options = { openAtLogin };

  if (process.platform === 'win32') {
    options.path = getExecutablePath();
    options.args = app.isPackaged
      ? [START_HIDDEN_ARGUMENT]
      : [app.getAppPath(), START_HIDDEN_ARGUMENT];
  } else if (process.platform === 'darwin') {
    options.openAsHidden = true;
  }

  return options;
}

function getLoginItemQuery() {
  if (process.platform !== 'win32') {
    return {};
  }

  const { args, path: executablePath } = getLoginItemOptions(true);
  return { args, path: executablePath };
}

function getStoredPreference() {
  try {
    const settingsPath = path.join(
      app.getPath('userData'),
      SETTINGS_FILENAME,
    );
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

    return settings.startOnLogin === true;
  } catch {
    return false;
  }
}

function storePreference(enabled) {
  const userDataPath = app.getPath('userData');
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, SETTINGS_FILENAME),
    `${JSON.stringify({ startOnLogin: enabled }, null, 2)}\n`,
    'utf8',
  );
}

function getAutoStartEnabled() {
  try {
    if (process.platform === 'linux') {
      return existsSync(getLinuxAutostartPath());
    }

    return app.getLoginItemSettings(getLoginItemQuery()).openAtLogin;
  } catch {
    return getStoredPreference();
  }
}

function setAutoStartEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('Start-on-login state must be a boolean.');
  }

  if (process.platform === 'linux') {
    const autostartPath = getLinuxAutostartPath();

    if (enabled) {
      mkdirSync(path.dirname(autostartPath), { recursive: true });
      writeFileSync(
        autostartPath,
        createLinuxDesktopEntry(getExecutablePath()),
        'utf8',
      );
    } else {
      rmSync(autostartPath, { force: true });
    }
  } else {
    app.setLoginItemSettings(getLoginItemOptions(enabled));
  }

  storePreference(enabled);
  return getAutoStartEnabled();
}

function wasStartedHidden() {
  if (process.argv.includes(START_HIDDEN_ARGUMENT)) {
    return true;
  }

  return (
    process.platform === 'darwin' &&
    app.getLoginItemSettings().wasOpenedAsHidden
  );
}

module.exports = {
  START_HIDDEN_ARGUMENT,
  createLinuxDesktopEntry,
  getAutoStartEnabled,
  quoteDesktopArgument,
  setAutoStartEnabled,
  wasStartedHidden,
};
