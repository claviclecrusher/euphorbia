'use strict';

// Preload for server pages.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Exposes one call; the main process checks where it came from and asks the
// user before doing anything.
const SPLIT_OUT = new Set(['split:move', 'split:taken', 'split:ready', 'split:empty', 'split:primary-empty',
  'split:restore', 'split:rect', 'split:dragging', 'split:compile']);
const SPLIT_IN = new Set(['split:state', 'split:receive', 'split:remove', 'split:give-all']);

contextBridge.exposeInMainWorld('euphorbia', {
  copyProject: (project) => ipcRenderer.invoke('project:copy', project),
  ai: {
    edit: (request) => ipcRenderer.invoke('ai:edit', request),
    cancel: () => ipcRenderer.send('ai:cancel'),
    info: (purpose) => ipcRenderer.invoke('ai:info', purpose),
    select: (purpose, choiceId) => ipcRenderer.send('ai:select', purpose, choiceId),
    openSettings: () => ipcRenderer.send('ai:open-settings'),
    chatStart: (request) => ipcRenderer.send('ai:chat-start', request),
    chatCancel: (requestId) => ipcRenderer.send('ai:chat-cancel', requestId),
    onChatEvent: (callback) => ipcRenderer.on('ai:chat-event', (_e, ev) => callback(ev)),
    reindex: (projectId) => ipcRenderer.invoke('ai:reindex', projectId),
    projectOpen: (projectId) => ipcRenderer.send('ai:project-open', projectId),
    onIndexStatus: (callback) => ipcRenderer.on('ai:index-status', (_e, st) => callback(st)),
    indexApprove: (projectId, allow) => ipcRenderer.send('ai:index-approve', projectId, allow),
    chatContinue: (requestId, go) => ipcRenderer.send('ai:chat-continue', requestId, go),
    listEdits: (projectId) => ipcRenderer.invoke('ai:list-edits', projectId),
    usage: (provider) => ipcRenderer.invoke('ai:usage', provider),
    switchCost: (req) => ipcRenderer.invoke('ai:switch-cost', req),
    sendRef: (ref) => ipcRenderer.send('ai:ref', ref),
    onRef: (callback) => ipcRenderer.on('ai:ref', (_e, ref) => callback(ref)),
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
  console.error('[euphorbia] early script failed', err);
}
