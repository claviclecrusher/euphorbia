'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  get: () => ipcRenderer.invoke('setup:get'),
  save: (url) => ipcRenderer.invoke('setup:save', url),
});
