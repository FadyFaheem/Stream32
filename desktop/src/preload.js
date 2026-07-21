const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream32', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  getBoardFirmware: (boardId) =>
    ipcRenderer.invoke('boards:firmware', boardId),
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  listBoards: (force = false) => ipcRenderer.invoke('boards:list', force),
  onBoardDownloadProgress(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Board download listener must be a function.');
    }

    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('boards:download-progress', listener);

    return () =>
      ipcRenderer.removeListener('boards:download-progress', listener);
  },
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
