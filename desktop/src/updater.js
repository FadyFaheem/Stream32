const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const DEVELOPMENT_STATUS = {
  message: 'Updates are checked in packaged builds.',
  state: 'development',
};

function createUpdater({ onDownloaded, onEvent = () => {}, sendStatus }) {
  let downloaded = false;

  function report(state, message) {
    sendStatus({ message, state });
    onEvent(state);
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    report('checking', 'Checking for updates…');
  });

  autoUpdater.on('update-available', (info) => {
    report('available', `Downloading Stream32 ${info.version}…`);
    onEvent('available-version', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    report('current', 'Stream32 is up to date.');
  });

  autoUpdater.on('download-progress', ({ percent }) => {
    report('downloading', `Downloading update… ${Math.round(percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    report('downloaded', `Stream32 ${info.version} is ready to install.`);
    onEvent('downloaded-version', { version: info.version });
    onDownloaded();
  });

  autoUpdater.on('error', (error) => {
    report('error', `Update check failed: ${error.message}`);
    onEvent('error-detail', { error });
  });

  async function checkForUpdates() {
    if (!app.isPackaged) {
      sendStatus(DEVELOPMENT_STATUS);
      return null;
    }

    return autoUpdater.checkForUpdatesAndNotify({
      title: 'Stream32 update ready',
      body: 'Choose Restart to update in Stream32 or from the tray menu.',
    });
  }

  function installUpdate() {
    if (downloaded) {
      autoUpdater.quitAndInstall();
    }
  }

  return {
    checkForUpdates,
    installUpdate,
  };
}

module.exports = { createUpdater };
