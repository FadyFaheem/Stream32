const { app, net } = require('electron');
const { autoUpdater } = require('electron-updater');

const { getUpdateSettings } = require('./settings');
const { listPullRequestChannels, resolveChannel } = require('./update-channel');

const DEVELOPMENT_STATUS = {
  message: 'Updates are checked in packaged builds.',
  state: 'development',
};
const RELEASES_URL =
  'https://api.github.com/repos/FadyFaheem/Stream32/releases?per_page=30';
const RELEASES_TIMEOUT_MS = 15_000;

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

    const { allowDowngrade, allowPrerelease, channel } = resolveChannel(
      getUpdateSettings().updateChannel,
      app.getVersion(),
    );

    autoUpdater.allowPrerelease = allowPrerelease;
    autoUpdater.channel = channel;
    // Assigning `channel` force-enables downgrades, so apply the decision
    // resolveChannel made afterwards rather than before.
    autoUpdater.allowDowngrade = allowDowngrade;

    // ponytail: a build already downloaded from the previous channel stays
    // installable until this check replaces it. Retracting it early means
    // threading a "no longer ready" signal through the tray and the renderer's
    // one-way updateReady flag.
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

  async function listPullRequestBuilds() {
    const response = await net.fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(RELEASES_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub returned ${response.status} while listing preview builds.`,
      );
    }

    return listPullRequestChannels(await response.json());
  }

  return {
    checkForUpdates,
    installUpdate,
    listPullRequestBuilds,
  };
}

module.exports = { createUpdater };
