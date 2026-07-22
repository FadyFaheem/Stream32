const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream32', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  exportDeck: (deviceId) => ipcRenderer.invoke('deck:export', deviceId),
  getBoardFirmware: (boardId) =>
    ipcRenderer.invoke('boards:firmware', boardId),
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  importDeck: () => ipcRenderer.invoke('deck:import'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  listBoards: (force = false) => ipcRenderer.invoke('boards:list', force),
  listDecks: () => ipcRenderer.invoke('deck:list'),
  runAction: (action) => ipcRenderer.invoke('action:run', action),
  saveDeck: (deviceId, profile) =>
    ipcRenderer.invoke('deck:save', deviceId, profile),
  selectSerialPort: (requestId, portId) =>
    ipcRenderer.invoke('serial:select-port', requestId, portId),
  onBoardDownloadProgress(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Board download listener must be a function.');
    }

    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('boards:download-progress', listener);

    return () =>
      ipcRenderer.removeListener('boards:download-progress', listener);
  },
  onSerialPortList(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Serial port list listener must be a function.');
    }

    const listener = (_event, request) => callback(request);
    ipcRenderer.on('serial:port-list', listener);

    return () => ipcRenderer.removeListener('serial:port-list', listener);
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
