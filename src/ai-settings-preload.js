'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiSettings', {
  get: () => ipcRenderer.invoke('ai-settings:get'),
  save: (form) => ipcRenderer.invoke('ai-settings:save', form),
  test: (form, provider) => ipcRenderer.invoke('ai-settings:test', form, provider),
  models: (form, provider) => ipcRenderer.invoke('ai-settings:models', form, provider),
  close: () => ipcRenderer.invoke('ai-settings:close'),
});
