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

  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(
    process.platform === 'darwin'
      ? image.resize({ height: 18, width: 18 })
      : image.resize({ height: 24, width: 24 }),
  );

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
