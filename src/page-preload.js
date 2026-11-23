'use strict';

// Preload for server pages.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Exposes one call; the main process checks where it came from and asks the
// user before doing anything.
contextBridge.exposeInMainWorld('overleafDesktop', {
  copyProject: (project) => ipcRenderer.invoke('project:copy', project),
});

// Editor additions have to be in place before Overleaf creates its editor, so
// they are injected into the page's own world right now rather than on load.
try {
  const script = ipcRenderer.sendSync('page:early-script');
  if (script) webFrame.executeJavaScript(script);
} catch (err) {
  console.error('[overleaf-desktop] early script failed', err);
}
