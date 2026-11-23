'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiSettings', {
  get: () => ipcRenderer.invoke('ai-settings:get'),
  save: (form) => ipcRenderer.invoke('ai-settings:save', form),
  test: (form) => ipcRenderer.invoke('ai-settings:test', form),
  close: () => ipcRenderer.invoke('ai-settings:close'),
});
