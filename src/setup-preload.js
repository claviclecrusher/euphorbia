'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  save: (server) => ipcRenderer.invoke('setup:save', server),
});
