'use strict';

// Split editor: a second Overleaf page for the same project, shown in an
// embedded view below the main window's editor. Overleaf edits one document per
// page, so the bottom pane is a full second page of the project with everything
// but its editor hidden; both pages stay in sync through the server.
//
// The main page reserves the area (a placeholder under its editor) and reports
// its rectangle; this module keeps the view on top of it. Tabs move between the
// two pages through here.

const { WebContentsView, ipcMain } = require('electron');

let ctx = null;
let view = null; // the bottom pane
let ready = false;
let pending = []; // tabs waiting for the bottom pane to finish loading
let rect = null;
let hiddenForDrag = false;

const mainContents = () => {
  const win = ctx.getMainWindow();
  return win && !win.isDestroyed() ? win.webContents : null;
};
const paneContents = () => (view && !view.webContents.isDestroyed() ? view.webContents : null);

// 1 = main page, 2 = bottom pane, 0 = any other window (no tabs there).
function roleOf(contents) {
  if (paneContents() && contents === paneContents()) return 2;
  if (mainContents() && contents === mainContents()) return 1;
  return 0;
}

const projectPath = (url) => {
  try {
    const u = new URL(url);
    return /^\/project\/[0-9a-f]{24}\/?$/.test(u.pathname) ? u.origin + u.pathname.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
};

function send(contents, channel, payload) {
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

function applyBounds() {
  if (!view) return;
  const main = mainContents();
  if (!rect || hiddenForDrag || !main) {
    view.setVisible(false);
    return;
  }
  const zoom = main.getZoomFactor();
  view.setBounds({
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.max(0, Math.round(rect.width * zoom)),
    height: Math.max(0, Math.round(rect.height * zoom)),
  });
  view.setVisible(true);
}

function open() {
  const win = ctx.getMainWindow();
  const main = mainContents();
  const url = main && projectPath(main.getURL());
  if (!win || !url) return false;
  if (view) return true;
  view = new WebContentsView({ webPreferences: ctx.webPreferences });
  view.setVisible(false);
  ready = false;
  win.contentView.addChildView(view);
  ctx.attachCommonHandlers(win, view.webContents);
  // The bottom pane only ever shows this project.
  view.webContents.on('did-navigate', (_e, navUrl) => {
    if (projectPath(navUrl) !== url) close();
  });
  // A clean exit is the initial blank page's process being swapped out when
  // the project page loads; only real crashes end the split.
  view.webContents.on('render-process-gone', (_e, details) => {
    if (details && details.reason === 'clean-exit') return;
    console.error('[split] bottom pane renderer gone:', details && details.reason);
    close();
  });
  view.webContents.loadURL(url).catch(() => {});
  send(main, 'split:state', { open: true });
  return true;
}

function close() {
  if (!view) return;
  const win = ctx.getMainWindow();
  const old = view;
  view = null;
  ready = false;
  pending = [];
  rect = null;
  if (win && !win.isDestroyed()) win.contentView.removeChildView(old);
  if (!old.webContents.isDestroyed()) old.webContents.close();
  send(mainContents(), 'split:state', { open: false });
}

function deliver(tab) {
  if (ready) send(paneContents(), 'split:receive', tab);
  else pending.push(tab);
}

function validTab(tab) {
  return (
    tab &&
    /^[0-9a-f]{24}$/.test(String(tab.id)) &&
    typeof tab.name === 'string' &&
    Array.isArray(tab.folders) &&
    tab.folders.every((f) => /^[0-9a-f]{24}$/.test(String(f)))
  );
}

function cleanTab(tab) {
  const path = typeof tab.path === 'string' ? tab.path.slice(0, 500) : tab.name.slice(0, 200);
  return { id: String(tab.id), name: tab.name.slice(0, 200), folders: tab.folders.map(String), path };
}

function init(context) {
  ctx = context;

  // A tab leaves the sending page for the other one.
  ipcMain.on('split:move', (event, tab) => {
    const role = roleOf(event.sender);
    if (!role || !validTab(tab)) return;
    if (role === 1) {
      if (open()) deliver(cleanTab(tab));
    } else {
      send(mainContents(), 'split:receive', cleanTab(tab));
    }
  });

  // A tab dropped onto a page from the other one: the receiving page adds it
  // itself, the source page drops it.
  ipcMain.on('split:taken', (event, id) => {
    const role = roleOf(event.sender);
    if (!role || !/^[0-9a-f]{24}$/.test(String(id))) return;
    send(role === 1 ? paneContents() : mainContents(), 'split:remove', String(id));
  });

  ipcMain.on('split:ready', (event) => {
    if (roleOf(event.sender) !== 2) return;
    ready = true;
    for (const tab of pending) send(paneContents(), 'split:receive', tab);
    pending = [];
  });

  // The bottom pane has no tabs left: back to a single editor.
  ipcMain.on('split:empty', (event) => {
    if (roleOf(event.sender) === 2) close();
  });

  // The main page has no tabs left while split: bring the bottom tabs up.
  ipcMain.on('split:primary-empty', (event) => {
    if (roleOf(event.sender) === 1 && paneContents()) send(paneContents(), 'split:give-all');
  });

  // The main page found bottom-pane tabs from last time.
  ipcMain.on('split:restore', (event) => {
    if (roleOf(event.sender) === 1) open();
  });

  ipcMain.on('split:rect', (event, r) => {
    if (roleOf(event.sender) !== 1) return;
    const ok = r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]));
    rect = ok && r.width > 0 && r.height > 0 ? r : null;
    applyBounds();
  });

  // While the divider is dragged the view is hidden so the main page keeps
  // receiving the pointer.
  ipcMain.on('split:dragging', (event, on) => {
    if (roleOf(event.sender) !== 1) return;
    hiddenForDrag = !!on;
    applyBounds();
  });

  // Compile shortcuts in the bottom pane compile in the main page, whose PDF
  // is the one on screen.
  ipcMain.on('split:compile', (event) => {
    if (roleOf(event.sender) !== 2) return;
    const main = mainContents();
    if (main) main.executeJavaScript("window.dispatchEvent(new CustomEvent('pdf:recompile'))").catch(() => {});
  });
}

// Called for every new page load of the main window.
function onMainNavigate() {
  close();
}

module.exports = { init, roleOf, close, onMainNavigate };
