const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream32', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  exportDeck: (deviceId) => ipcRenderer.invoke('deck:export', deviceId),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  getBoardFirmware: (boardId) =>
    ipcRenderer.invoke('boards:firmware', boardId),
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  getActionCapabilities: () => ipcRenderer.invoke('action:capabilities'),
  getDisplaySettings: () => ipcRenderer.invoke('display-settings:get'),
  getFocusSnapshot: () => ipcRenderer.invoke('focus:snapshot'),
  getFocusStatus: () => ipcRenderer.invoke('focus:status'),
  importDeck: (deviceId) => ipcRenderer.invoke('deck:import', deviceId),
  installPlugin: (pluginId) =>
    ipcRenderer.invoke('plugins:install', pluginId),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  listBoards: (force = false) => ipcRenderer.invoke('boards:list', force),
  listDecks: () => ipcRenderer.invoke('deck:list'),
  listPluginCatalog: (force = false) =>
    ipcRenderer.invoke('plugins:catalog', force),
  listPlugins: (force = false) => ipcRenderer.invoke('plugins:list', force),
  logDiagnosticLine: (kind, line) =>
    ipcRenderer.send('diagnostics:renderer-line', kind, line),
  openLogs: () => ipcRenderer.invoke('diagnostics:open-logs'),
  removePlugin: (pluginId) =>
    ipcRenderer.invoke('plugins:remove', pluginId),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  runAction: (action) => ipcRenderer.invoke('action:run', action),
  registerDeck: (deviceId, boardId, name) =>
    ipcRenderer.invoke('deck:register', deviceId, boardId, name),
  renameDeck: (deviceId, name) =>
    ipcRenderer.invoke('deck:rename-device', deviceId, name),
  runProfileOperation: (deviceId, operation) =>
    ipcRenderer.invoke('deck:profile-operation', deviceId, operation),
  saveDeck: (deviceId, profileId, profile) =>
    ipcRenderer.invoke('deck:save', deviceId, profileId, profile),
  saveDeckProfiles: (deviceId, updates) =>
    ipcRenderer.invoke('deck:save-profiles', deviceId, updates),
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
  onMachineLockState(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Machine lock listener must be a function.');
    }

    const listener = (_event, locked) => callback(locked);
    ipcRenderer.on('power:lock-state', listener);

    return () => ipcRenderer.removeListener('power:lock-state', listener);
  },
  onFocusChange(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Focused app listener must be a function.');
    }

    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('focus:changed', listener);

    return () => ipcRenderer.removeListener('focus:changed', listener);
  },
  onFocusStatus(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Focused app status listener must be a function.');
    }

    const listener = (_event, status) => callback(status);
    ipcRenderer.on('focus:status', listener);

    return () => ipcRenderer.removeListener('focus:status', listener);
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
  setDisplaySettings: (settings) =>
    ipcRenderer.invoke('display-settings:set', settings),
  updatePlugin: (pluginId) =>
    ipcRenderer.invoke('plugins:update', pluginId),
});
