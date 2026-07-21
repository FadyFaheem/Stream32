const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const {
  getAutoStartEnabled,
  setAutoStartEnabled,
  wasStartedHidden,
} = require('./autostart');
const { createTray } = require('./tray');
const { createUpdater } = require('./updater');

let isQuitting = false;
let mainWindow = null;
let trayController = null;
let updaterController = null;

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
    width: 880,
    height: 620,
    minWidth: 680,
    minHeight: 500,
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
});

app.on('window-all-closed', () => {
  // The tray is the app's primary background presence on every platform.
});
