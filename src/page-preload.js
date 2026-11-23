'use strict';

// Preload for server pages.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Exposes one call; the main process checks where it came from and asks the
// user before doing anything.
const SPLIT_OUT = new Set(['split:move', 'split:taken', 'split:ready', 'split:empty', 'split:primary-empty',
  'split:restore', 'split:rect', 'split:dragging', 'split:compile']);
const SPLIT_IN = new Set(['split:state', 'split:receive', 'split:remove', 'split:give-all']);

contextBridge.exposeInMainWorld('overleafDesktop', {
  copyProject: (project) => ipcRenderer.invoke('project:copy', project),
  ai: {
    edit: (request) => ipcRenderer.invoke('ai:edit', request),
    cancel: () => ipcRenderer.send('ai:cancel'),
    info: () => ipcRenderer.invoke('ai:info'),
    openSettings: () => ipcRenderer.send('ai:open-settings'),
  },
  split: {
    send: (channel, payload) => {
      if (SPLIT_OUT.has(channel)) ipcRenderer.send(channel, payload);
    },
    on: (channel, callback) => {
      if (SPLIT_IN.has(channel)) ipcRenderer.on(channel, (_event, payload) => callback(payload));
    },
  },
});

// Editor additions have to be in place before Overleaf creates its editor, so
// they are injected into the page's own world right now rather than on load.
try {
  const script = ipcRenderer.sendSync('page:early-script');
  if (script) webFrame.executeJavaScript(script);
} catch (err) {
  console.error('[overleaf-desktop] early script failed', err);
}
