const { Menu, Tray, nativeImage } = require('electron');

function createTray({
  checkForUpdates,
  getAutoStartEnabled,
  iconPath,
  installUpdate,
  onError,
  quit,
  setAutoStartEnabled,
  showWindow,
}) {
  let updateReady = false;

  // Windows takes the path so the shell picks the rendition matching the
  // tray's current scaling; resizing a loaded image would throw those away
  // and hand it a blurred copy of the largest one.
  const trayIcon = () => {
    if (process.platform === 'win32') {
      return iconPath;
    }

    const image = nativeImage.createFromPath(iconPath);
    const side = process.platform === 'darwin' ? 18 : 24;

    return image.resize({ height: side, width: side });
  };
  const tray = new Tray(trayIcon());

  function rebuildMenu() {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Show Stream32',
        click: showWindow,
      },
      { type: 'separator' },
      {
        label: 'Start on login',
        type: 'checkbox',
        checked: getAutoStartEnabled(),
        click(menuItem) {
          try {
            setAutoStartEnabled(menuItem.checked);
          } catch (error) {
            onError(error);
          } finally {
            rebuildMenu();
          }
        },
      },
      {
        label: 'Check for updates',
        click() {
          checkForUpdates().catch(onError);
        },
      },
      {
        label: 'Restart to update',
        visible: updateReady,
        click: installUpdate,
      },
      { type: 'separator' },
      {
        label: 'Quit Stream32',
        click: quit,
      },
    ]);

    tray.setContextMenu(menu);
  }

  tray.setToolTip('Stream32');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  rebuildMenu();

  return {
    destroy() {
      tray.destroy();
    },
    refresh: rebuildMenu,
    setUpdateReady(ready) {
      updateReady = ready;
      rebuildMenu();
    },
  };
}

module.exports = { createTray };
