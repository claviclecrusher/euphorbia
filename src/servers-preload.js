'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('servers', {
  get: () => ipcRenderer.invoke('servers:get'),
  save: (items) => ipcRenderer.invoke('servers:save', items),
});
