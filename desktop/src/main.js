const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  shell,
} = require('electron');
const { mkdir, readFile, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createActionRunner } = require('./actions');
const {
  getAutoStartEnabled,
  setAutoStartEnabled,
  wasStartedHidden,
} = require('./autostart');
const {
  MAX_BACKUP_BYTES,
  bundledPluginIds,
  createBackup,
  recoverInterruptedRestore,
  restoreBackup,
  writeBackup,
} = require('./backup');
const { createDefaultBoardService } = require('./boards');
const {
  MAX_IMPORT_BYTES,
  exportProfile,
  importProfile,
  validateHostAction,
} = require('./deck-model');
const {
  addImportedProfile,
  applyProfileOperation,
  getDecksPath,
  readDecks,
  registerDevice,
  renameDevice,
  saveDeviceProfile,
  saveDeviceProfiles,
} = require('./deck-store');
const { createDiagnosticLogger } = require('./diagnostic-log');
const { createDiagnostics } = require('./diagnostics');
const { createFocusWatcher } = require('./focus-watcher');
const { createPluginCatalogService } = require('./plugin-catalog');
const { createPluginService } = require('./plugins');
const { configureSerialAccess } = require('./serial');
const {
  getDisplaySettings,
  getSettingsPath,
  readSettings,
  setDisplaySettings,
} = require('./settings');
const { createTray } = require('./tray');
const { createUpdater } = require('./updater');

const actionRunner = createActionRunner({
  onEvent(event, details) {
    diagnosticLogger?.info('action:run', {
      type: details.type,
      success: event === 'succeeded',
      error: details.error?.name,
    });
  },
});
let boardService = null;
let curatedPluginService = null;
let isQuitting = false;
let mainWindow = null;
let pluginService = null;
let serialAccess = null;
let trayController = null;
let updaterController = null;
let lockStateTimer = null;
let machineLocked = false;
let diagnosticLogger = null;
let focusWatcher = null;
let rendererLogWindow = { count: 0, startedAt: 0 };

// Electron otherwise applies Chromium's serial-device blocklist even after
// the user explicitly selects a port. Permission remains limited in serial.js.
app.commandLine.appendSwitch('disable-serial-blocklist');

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'logo.png')
    : path.join(__dirname, '..', '..', 'assets', 'logo.png');
}

function isStream32Focus(snapshot) {
  if (snapshot?.processId === process.pid) {
    return true;
  }

  if (snapshot?.platform === 'win32') {
    const ownExecutable =
      app.getPath('exe').replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase();
    return snapshot.identities.some(
      (identity) =>
        identity.kind === 'executable' && identity.value === ownExecutable,
    );
  }

  if (snapshot?.platform === 'darwin') {
    const ownNames = new Set([
      app.getName().toLowerCase(),
      'stream32',
      'com.stream32.desktop',
    ]);
    return snapshot.identities.some((identity) =>
      ownNames.has(identity.value.toLowerCase()));
  }

  if (snapshot?.platform === 'linux') {
    return snapshot.identities.some(
      (identity) =>
        identity.kind === 'processName' &&
        ['stream32', 'stream32-desktop', 'stream32-deskt'].includes(
          identity.value,
        ),
    );
  }

  return false;
}

function getPersistencePaths() {
  const userDataDirectory = app.getPath('userData');

  return {
    backupsDirectory: path.join(userDataDirectory, 'backups'),
    bundledPluginsDirectory: path.join(__dirname, 'plugins'),
    decksPath: getDecksPath(),
    logsDirectory: path.join(userDataDirectory, 'logs'),
    settingsPath: getSettingsPath(),
    userDataDirectory,
    userPluginsDirectory: path.join(userDataDirectory, 'plugins'),
  };
}

function requireMainSender(event, message = 'Request is invalid.') {
  if (event.sender !== mainWindow?.webContents) {
    throw new TypeError(message);
  }
}

function logComponentEvent(component, event, details = {}) {
  if (details.error) {
    diagnosticLogger?.error(`${component}:${event}`, details.error);
  } else {
    diagnosticLogger?.info(`${component}:${event}`, details);
  }
}

function acceptRendererLogLine(kind, line) {
  const now = Date.now();

  if (now - rendererLogWindow.startedAt >= 60_000) {
    rendererLogWindow = { count: 0, startedAt: now };
  }

  if (rendererLogWindow.count >= 240) {
    return false;
  }

  rendererLogWindow.count++;
  diagnosticLogger?.info(`renderer:${kind}`, { message: line });
  return true;
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', status);
  }
}

function sendBoardDownloadProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('boards:download-progress', progress);
  }
}

function sendMachineLockState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('power:lock-state', machineLocked);
  }
}

function sendFocusSnapshot(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus:changed', snapshot);
  }
}

function sendFocusStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus:status', status);
  }
}

function setMachineLocked(locked) {
  if (machineLocked === locked) {
    return;
  }

  machineLocked = locked;
  sendMachineLockState();
}

function reconcileMachineLockState() {
  try {
    const state = powerMonitor.getSystemIdleState(1);

    if (state === 'locked') {
      setMachineLocked(true);
    } else if (state === 'active' || state === 'idle') {
      setMachineLocked(false);
    }
  } catch {
    // Some Linux desktop environments cannot report lock state.
  }
}

function startLockMonitoring() {
  reconcileMachineLockState();
  powerMonitor.on('lock-screen', () => setMachineLocked(true));
  powerMonitor.on('unlock-screen', () => setMachineLocked(false));
  lockStateTimer = setInterval(reconcileMachineLockState, 2000);
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 580,
    show: false,
    title: 'Stream32',
    backgroundColor: '#0b1116',
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  serialAccess = configureSerialAccess(window, {
    onEvent: (event, details) =>
      logComponentEvent('serial', event, details),
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  window.once('ready-to-show', () => {
    if (!wasStartedHidden()) {
      window.show();
    }
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnosticLogger?.info('renderer:gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.on('unresponsive', () => {
    diagnosticLogger?.info('renderer:unresponsive');
  });

  return window;
}

function registerIpcHandlers() {
  ipcMain.handle('autostart:get', () => getAutoStartEnabled());
  ipcMain.handle('autostart:set', (_event, enabled) => {
    const actualState = setAutoStartEnabled(enabled);
    trayController?.refresh();
    return actualState;
  });
  ipcMain.handle('display-settings:get', (event) => {
    if (event.sender !== mainWindow?.webContents) {
      throw new TypeError('Display settings request is invalid.');
    }

    return { ...getDisplaySettings(), machineLocked };
  });
  ipcMain.handle('display-settings:set', (event, settings) => {
    if (event.sender !== mainWindow?.webContents) {
      throw new TypeError('Display settings request is invalid.');
    }

    return setDisplaySettings(settings);
  });
  ipcMain.handle('updater:check', () => updaterController?.checkForUpdates());
  ipcMain.handle('updater:install', installUpdate);
  ipcMain.handle('boards:list', (_event, force = false) => {
    if (typeof force !== 'boolean') {
      throw new TypeError('Board refresh flag must be a boolean.');
    }

    return boardService.getBoards(force);
  });
  ipcMain.handle('boards:firmware', (_event, boardId) => {
    if (typeof boardId !== 'string') {
      throw new TypeError('Board id must be a string.');
    }

    return boardService.getFirmware(boardId);
  });
  ipcMain.handle('plugins:list', (event, force = false) => {
    if (
      event.sender !== mainWindow?.webContents ||
      typeof force !== 'boolean'
    ) {
      throw new TypeError('Plugin list request is invalid.');
    }

    return force ? pluginService.load() : pluginService.list();
  });
  ipcMain.handle('plugins:catalog', (event, force = false) => {
    requireMainSender(event, 'Plugin catalog request is invalid.');

    if (typeof force !== 'boolean') {
      throw new TypeError('Plugin catalog refresh flag must be a boolean.');
    }

    return curatedPluginService.list(force);
  });

  for (const [channel, operation] of [
    ['plugins:install', (id) => curatedPluginService.install(id)],
    ['plugins:update', (id) => curatedPluginService.update(id)],
    ['plugins:remove', (id) => curatedPluginService.remove(id)],
  ]) {
    ipcMain.handle(channel, (event, id) => {
      requireMainSender(event, 'Plugin catalog operation is invalid.');

      if (typeof id !== 'string') {
        throw new TypeError('Plugin id must be a string.');
      }

      return operation(id);
    });
  }
  ipcMain.handle('backup:export', async (event) => {
    requireMainSender(event, 'Backup export request is invalid.');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `stream32-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Stream32 backup', extensions: ['json'] }],
    });

    if (canceled || !filePath) {
      return { saved: false };
    }

    const text = createBackup(getPersistencePaths());
    writeBackup(filePath, text);
    diagnosticLogger?.info('backup:exported');
    return { saved: true };
  });
  ipcMain.handle('backup:restore', async (event) => {
    requireMainSender(event, 'Backup restore request is invalid.');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Stream32 backup', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (canceled || filePaths.length === 0) {
      return { restored: false };
    }

    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Restore and restart'],
      cancelId: 0,
      defaultId: 0,
      message: 'Replace all Stream32 settings, decks, and user plugins?',
      detail:
        'Stream32 will first save a safety backup, then restart after restore.',
    });

    if (confirmation.response !== 1) {
      return { restored: false };
    }

    const fileInfo = await stat(filePaths[0]);

    if (fileInfo.size > MAX_BACKUP_BYTES) {
      throw new TypeError('Backup exceeds the supported size.');
    }

    const paths = getPersistencePaths();
    const text = await readFile(filePaths[0], 'utf8');
    diagnosticLogger?.info('restore:started');
    let result;

    try {
      result = restoreBackup(text, paths, {
        bundledIds: bundledPluginIds(paths.bundledPluginsDirectory),
      });
    } catch (error) {
      diagnosticLogger?.error('restore:failed', error);
      throw error;
    }

    diagnosticLogger?.info('restore:completed', {
      safetyBackupCreated: Boolean(result.safetyPath),
    });
    setImmediate(() => {
      isQuitting = true;
      app.relaunch();
      app.exit(0);
    });
    return { restored: true };
  });
  ipcMain.handle('diagnostics:open-logs', async (event) => {
    requireMainSender(event, 'Open logs request is invalid.');
    const { logsDirectory } = getPersistencePaths();
    await mkdir(logsDirectory, { recursive: true });
    const error = await shell.openPath(logsDirectory);

    if (error) {
      throw new Error(error);
    }

    return true;
  });
  ipcMain.handle('diagnostics:export', async (event) => {
    requireMainSender(event, 'Diagnostics export request is invalid.');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath:
        `stream32-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Stream32 diagnostics', extensions: ['json'] }],
    });

    if (canceled || !filePath) {
      return { saved: false };
    }

    const paths = getPersistencePaths();
    const report = createDiagnostics({
      decks: readDecks(paths.decksPath),
      homeDirectory: os.homedir(),
      pluginCatalog: pluginService.list(),
      settings: readSettings(paths.settingsPath),
      userDataDirectory: paths.userDataDirectory,
      version: app.getVersion(),
    });
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    diagnosticLogger?.info('diagnostics:exported');
    return { saved: true };
  });
  ipcMain.on('diagnostics:renderer-line', (event, kind, line) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !['flash', 'protocol'].includes(kind) ||
      typeof line !== 'string' ||
      line.length === 0 ||
      line.length > 2048
    ) {
      return;
    }

    acceptRendererLogLine(kind, line);
  });
  ipcMain.handle('serial:select-port', (event, requestId, portId) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !Number.isSafeInteger(requestId) ||
      requestId < 1 ||
      typeof portId !== 'string' ||
      portId.length > 256
    ) {
      throw new TypeError('Serial port selection is invalid.');
    }

    return serialAccess?.selectPort(requestId, portId) ?? false;
  });
  ipcMain.handle('deck:list', (event) => {
    requireMainSender(event, 'Deck list request is invalid.');
    return readDecks(getDecksPath());
  });
  ipcMain.handle('deck:register', (event, deviceId, boardId, name) => {
    requireMainSender(event, 'Deck registration request is invalid.');
    return registerDevice(deviceId, boardId, name, getDecksPath());
  });
  ipcMain.handle('deck:save', (event, deviceId, profileId, profile) => {
    requireMainSender(event, 'Deck save request is invalid.');
    return saveDeviceProfile(deviceId, profileId, profile, getDecksPath());
  });
  ipcMain.handle('deck:save-profiles', (event, deviceId, updates) => {
    requireMainSender(event, 'Deck profile save request is invalid.');
    return saveDeviceProfiles(deviceId, updates, getDecksPath());
  });
  ipcMain.handle('deck:rename-device', (event, deviceId, name) => {
    requireMainSender(event, 'Device rename request is invalid.');
    return renameDevice(deviceId, name, getDecksPath());
  });
  ipcMain.handle('deck:profile-operation', (event, deviceId, operation) => {
    requireMainSender(event, 'Profile operation request is invalid.');
    return applyProfileOperation(deviceId, operation, getDecksPath());
  });
  ipcMain.handle('focus:snapshot', (event) => {
    requireMainSender(event, 'Focused app snapshot request is invalid.');
    return focusWatcher?.getSnapshot() ?? null;
  });
  ipcMain.handle('focus:status', (event) => {
    requireMainSender(event, 'Focused app status request is invalid.');
    return focusWatcher?.getStatus() ?? {
      platform: process.platform,
      supported: false,
      running: false,
      state: 'stopped',
      reason: 'Focused-app monitoring has not started.',
    };
  });
  ipcMain.handle('action:capabilities', (event) => {
    requireMainSender(event, 'Action capability request is invalid.');
    return actionRunner.getCapabilities();
  });
  ipcMain.handle('deck:export', async (event, deviceId) => {
    requireMainSender(event, 'Deck export request is invalid.');

    if (typeof deviceId !== 'string') {
      throw new TypeError('Device id must be a string.');
    }

    const device = readDecks(getDecksPath()).devices[deviceId];
    const profile = device?.profiles[device.activeProfileId];

    if (!profile) {
      throw new Error('This device has no saved deck profile.');
    }

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `stream32-deck-${deviceId}.json`,
      filters: [{ name: 'Stream32 deck profile', extensions: ['json'] }],
    });

    if (canceled || !filePath) {
      return { saved: false };
    }

    await writeFile(filePath, exportProfile(profile), 'utf8');
    return { saved: true };
  });
  ipcMain.handle('deck:import', async (event, deviceId) => {
    requireMainSender(event, 'Deck import request is invalid.');

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Stream32 deck profile', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (canceled || filePaths.length === 0) {
      return { device: null };
    }

    const text = await readFile(filePaths[0], 'utf8');

    if (text.length > MAX_IMPORT_BYTES) {
      throw new Error('Deck profile file is too large.');
    }

    return {
      device: addImportedProfile(
        deviceId,
        importProfile(text),
        getDecksPath(),
      ),
    };
  });
  ipcMain.handle('action:run', (event, action) => {
    if (event.sender !== mainWindow?.webContents) {
      throw new TypeError('Action request is invalid.');
    }

    const validated = validateHostAction(action);
    const runnable = validated.type === 'plugin'
      ? pluginService.resolve(validated)
      : validated;
    return actionRunner.runAction(runnable);
  });
}

function reportBackgroundError(error) {
  diagnosticLogger?.error('background:error', error);
  sendUpdateStatus({
    message: error instanceof Error ? error.message : String(error),
    state: 'error',
  });
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function installUpdate() {
  isQuitting = true;
  updaterController?.installUpdate();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

process.on('uncaughtExceptionMonitor', (error) => {
  diagnosticLogger?.error('main:uncaught-exception', error);
});
process.on('unhandledRejection', (reason) => {
  diagnosticLogger?.error('main:unhandled-rejection', reason);
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.stream32.desktop');
    const paths = getPersistencePaths();
    diagnosticLogger = createDiagnosticLogger({
      directory: paths.logsDirectory,
      homeDirectory: os.homedir(),
      userDataDirectory: paths.userDataDirectory,
    });
    diagnosticLogger.info('application:startup', {
      arch: process.arch,
      platform: process.platform,
      version: app.getVersion(),
    });

    if (
      recoverInterruptedRestore(paths, {
        bundledIds: bundledPluginIds(paths.bundledPluginsDirectory),
      })
    ) {
      diagnosticLogger.info('restore:rolled-back-on-startup');
    }

    mainWindow = createMainWindow();
    startLockMonitoring();
    boardService = createDefaultBoardService(sendBoardDownloadProgress);
    pluginService = createPluginService({
      bundledDirectory: paths.bundledPluginsDirectory,
      onEvent: (event, details) =>
        logComponentEvent('plugins', event, details),
      userDirectory: paths.userPluginsDirectory,
    });
    curatedPluginService = createPluginCatalogService({
      appVersion: app.getVersion(),
      bundledIds: bundledPluginIds(paths.bundledPluginsDirectory),
      fetcher: net.fetch,
      onEvent: (event, details) =>
        logComponentEvent('plugin-catalog', event, details),
      pluginService,
      userDataPath: paths.userDataDirectory,
    });
    registerIpcHandlers();
    focusWatcher = createFocusWatcher({
      isOwnSnapshot: isStream32Focus,
      onChange: sendFocusSnapshot,
      onStatus(status) {
        sendFocusStatus(status);

        if (status.state === 'error' || status.state === 'unsupported') {
          logComponentEvent('focus', status.state, {
            message: status.reason,
            platform: status.platform,
          });
        }
      },
    });
    focusWatcher.start();

    updaterController = createUpdater({
      onDownloaded() {
        trayController?.setUpdateReady(true);
      },
      onEvent: (event, details) =>
        logComponentEvent('updater', event, details),
      sendStatus: sendUpdateStatus,
    });

    trayController = createTray({
      checkForUpdates: updaterController.checkForUpdates,
      getAutoStartEnabled,
      iconPath: getIconPath(),
      installUpdate,
      onError: reportBackgroundError,
      quit: quitApp,
      setAutoStartEnabled,
      showWindow,
    });

    setTimeout(() => {
      updaterController.checkForUpdates().catch(reportBackgroundError);
    }, 3000);

    app.on('activate', showWindow);
  }).catch((error) => {
    diagnosticLogger?.error('application:startup-failed', error);
    dialog.showErrorBox(
      'Stream32 could not start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(lockStateTimer);
  focusWatcher?.stop();
  actionRunner.dispose();
});

app.on('window-all-closed', () => {
  // The tray is the app's primary background presence on every platform.
});
