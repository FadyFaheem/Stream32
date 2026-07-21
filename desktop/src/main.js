const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const { createActionRunner } = require('./actions');
const {
  getAutoStartEnabled,
  setAutoStartEnabled,
  wasStartedHidden,
} = require('./autostart');
const { createDefaultBoardService } = require('./boards');
const {
  MAX_IMPORT_BYTES,
  exportProfile,
  getDecksPath,
  importProfile,
  readDecks,
  saveDeviceProfile,
} = require('./deck-store');
const { configureSerialAccess } = require('./serial');
const { createTray } = require('./tray');
const { createUpdater } = require('./updater');

const actionRunner = createActionRunner();
let boardService = null;
let isQuitting = false;
let mainWindow = null;
let trayController = null;
let updaterController = null;

// Electron otherwise applies Chromium's serial-device blocklist even after
// the user explicitly selects a port. Permission remains limited in serial.js.
app.commandLine.appendSwitch('disable-serial-blocklist');

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'logo.png')
    : path.join(__dirname, '..', '..', 'assets', 'logo.png');
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

  configureSerialAccess(window);
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

  return window;
}

function registerIpcHandlers() {
  ipcMain.handle('autostart:get', () => getAutoStartEnabled());
  ipcMain.handle('autostart:set', (_event, enabled) => {
    const actualState = setAutoStartEnabled(enabled);
    trayController?.refresh();
    return actualState;
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
  ipcMain.handle('deck:list', () => readDecks(getDecksPath()));
  ipcMain.handle('deck:save', (_event, deviceId, profile) => {
    if (typeof deviceId !== 'string') {
      throw new TypeError('Device id must be a string.');
    }

    return saveDeviceProfile(deviceId, profile, getDecksPath());
  });
  ipcMain.handle('deck:export', async (_event, deviceId) => {
    if (typeof deviceId !== 'string') {
      throw new TypeError('Device id must be a string.');
    }

    const profile = readDecks(getDecksPath()).devices[deviceId];

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
  ipcMain.handle('deck:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Stream32 deck profile', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (canceled || filePaths.length === 0) {
      return { profile: null };
    }

    const text = await readFile(filePaths[0], 'utf8');

    if (text.length > MAX_IMPORT_BYTES) {
      throw new Error('Deck profile file is too large.');
    }

    return { profile: importProfile(text) };
  });
  ipcMain.handle('action:run', (_event, action) =>
    actionRunner.runAction(action),
  );
}

function reportBackgroundError(error) {
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

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.stream32.desktop');
    mainWindow = createMainWindow();
    boardService = createDefaultBoardService(sendBoardDownloadProgress);
    registerIpcHandlers();

    updaterController = createUpdater({
      onDownloaded() {
        trayController?.setUpdateReady(true);
      },
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
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  actionRunner.dispose();
});

app.on('window-all-closed', () => {
  // The tray is the app's primary background presence on every platform.
});
