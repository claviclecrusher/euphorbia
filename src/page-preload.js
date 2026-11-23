'use strict';

// Preload for server pages. Exposes one call; the main process checks where
// it came from and asks the user before doing anything.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overleafDesktop', {
  copyProject: (project) => ipcRenderer.invoke('project:copy', project),
});
