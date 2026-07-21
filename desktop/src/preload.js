const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream32', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  onUpdateStatus(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Update listener must be a function.');
    }

    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updater:status', listener);

    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
});
