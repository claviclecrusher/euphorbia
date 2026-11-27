'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, net, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const updater = require('./updater');
const projectCopy = require('./project-copy');
const split = require('./split');
const ai = require('./ai');

// ---------------------------------------------------------------- config ---
//
// config.servers: [{ name, url }]   saved servers
// config.current: url               the one the main window shows

// The app was called "Overleaf Desktop" before 0.21: move its data folder
// (servers, AI settings, conversations, index) to the new name once.
(() => {
  try {
    const now = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'Overleaf Desktop');
    if (fs.existsSync(old) && !fs.existsSync(path.join(now, 'config.json'))) {
      try {
        if (fs.existsSync(now)) fs.rmSync(now, { recursive: true, force: true });
        fs.renameSync(old, now);
      } catch {
        app.setPath('userData', old); // in use or not movable: keep using it
      }
    }
  } catch {
    /* first run */
  }
})();

// Window icon. Windows takes it from the exe (icon.ico: the round small icon
// at 64 px and below, the full icon above); Linux uses the round small icon,
// which is what title bars, docks and task lists show.
const APP_ICON = process.platform === 'win32' ? undefined : path.join(__dirname, 'icon-small.png');

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    /* first run */
  }
  if (!Array.isArray(c.servers)) c.servers = [];
  c.servers = c.servers.filter((s) => s && typeof s.url === 'string');
  // 0.1/0.2 stored a single `serverUrl`.
  if (c.serverUrl) {
    if (!c.servers.some((s) => s.url === c.serverUrl)) {
      c.servers.push({ name: defaultName(c.serverUrl), url: c.serverUrl });
    }
    if (!c.current) c.current = c.serverUrl;
    delete c.serverUrl;
  }
  if (!c.servers.some((s) => s.url === c.current)) {
    c.current = c.servers.length ? c.servers[0].url : null;
  }
  return c;
}

function saveConfig(patch) {
  config = { ...config, ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('config save failed:', err);
  }
}

let config = { servers: [], current: null };
let mainWindow = null;
let setupWindow = null;

// `--server=http://host` or EUPHORBIA_SERVER selects a server for this run only.
function cliServer() {
  const arg = process.argv.find((a) => a.startsWith('--server='));
  return (arg && arg.slice('--server='.length)) || process.env.EUPHORBIA_SERVER || null;
}

// ------------------------------------------------------------------- urls ---

function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https addresses are supported.');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function defaultName(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const bareHost = (hostname) => hostname.replace(/^www\./, '');

// Hosts a server serves its own content from besides its main address.
// overleaf.com delivers compile output and downloads from a separate domain.
const COMPANION_DOMAINS = {
  'overleaf.com': ['overleafusercontent.com'],
};

function inDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

// True for pages that belong to the current server.
function isServerUrl(url) {
  try {
    const u = new URL(url);
    const s = new URL(config.current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.origin === s.origin) return true;
    if (bareHost(u.hostname) === bareHost(s.hostname) && u.port === s.port) return true;
    const companions = COMPANION_DOMAINS[bareHost(s.hostname)] || [];
    return companions.some((d) => inDomain(u.hostname, d));
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      shell.openExternal(url);
    }
  } catch {
    /* ignore malformed urls */
  }
}

// Checks that the address answers like an Overleaf instance and returns the
// address to store (following redirects such as http -> https or -> www).
async function probeServer(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url + '/login', { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`The server answered with an error (HTTP ${res.status}).`);
    const body = await res.text();
    if (!/ol-|overleaf|sharelatex/i.test(body)) {
      throw new Error('This does not look like an Overleaf server.');
    }
    try {
      const finalUrl = new URL(res.url);
      const asked = new URL(url);
      if (asked.pathname === '/' && bareHost(finalUrl.hostname) === bareHost(asked.hostname)) {
        return finalUrl.origin;
      }
    } catch {
      /* no final URL reported; keep the address as typed */
    }
    return url;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The server took too long to respond.');
    if (/^net::/.test(err.message || '')) throw new Error(`Could not connect to the server. (${err.message})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- windows ---

// Only email and password sign-in works inside the app, so the buttons for
// Google, ORCID, institutional SSO and the "OR" divider next to them are hidden.
// The app's icons in Overleaf's pages: the full icon on the project loading
// screen (a grey copy with a coloured copy rising over it as the project loads),
// the round icon on the editor's home button (top left).
const BRAND_CSS = (() => {
  try {
    const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
    const round = fs.readFileSync(path.join(__dirname, 'icon-small.svg'), 'utf8');
    const url = (text) => `url("data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}")`;
    return `
      .loading-screen .loading-screen-brand { background-image: ${url(svg.replace(/#2f5d3a/g, '#c5cbc3'))} !important; padding-top: 100% !important; }
      .loading-screen .loading-screen-brand::after { background-image: ${url(svg)} !important; }
      .ide-redesign-toolbar .toolbar-ol-logo { background-image: ${url(round.replace(/#2f5d3a/g, "#4fa35e"))} !important; }
    `;
  } catch {
    return '';
  }
})();

// The same CSS added from the preload, before the page is parsed: the loading
// screen is in the server's HTML, so CSS added at dom-ready came after its
// first paint (Overleaf's logo flashed before the app's).
const BRAND_EARLY = `(() => {
  const css = ${JSON.stringify(BRAND_CSS)};
  const add = () => {
    if (document.getElementById('euphorbia-brand')) return true;
    const root = document.head || document.documentElement;
    if (!root) return false;
    const style = document.createElement('style');
    style.id = 'euphorbia-brand';
    style.textContent = css;
    root.appendChild(style);
    return true;
  };
  if (css && !add()) {
    const mo = new MutationObserver(() => { if (add()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
})();
`;

const HIDE_SSO_CSS = `
  .form-group:has(> a.btn img.btn-social-icon),
  .form-group:has(> a.btn[href*="/auth/"]),
  .form-group:has(> a.btn[href*="/saml/"]),
  .form-group:has(> a.btn[href*="/oidc/"]),
  .form-group:has(> a.btn[href*="sso-login"]),
  a.btn[href^="/auth/"], a.btn[href*="/saml/"], a.btn[href*="/oidc/"], a.btn[href*="sso-login"],
  .ciam-login-register-or-text-container,
  .login-register-or-text-container,
  .login-register-other-links { display: none !important; }
`;

const webPreferences = {
  preload: path.join(__dirname, 'page-preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: true,
};

// `contents` is given for views embedded in `win` (the split editor pane).
function attachCommonHandlers(win, contents) {
  const wc = contents || win.webContents;

  // Server pages opened in a "new tab" (detached PDF, project in new tab)
  // become app windows. Everything else goes to the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isServerUrl(url) || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          autoHideMenuBar: true,
          webPreferences,
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => attachCommonHandlers(child));

  // The app window only ever shows the server. Links and redirects that leave
  // it (including third-party sign-in such as Google or ORCID, which the app
  // does not support) open in the system browser.
  const keepOnServer = (event, url) => {
    if (isServerUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  };
  wc.on('will-navigate', keepOnServer);
  wc.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) keepOnServer(event, url);
  });

  // Page tweaks: hide sign-in methods the app cannot complete, and add the
  // cross-server copy entry to the project list.
  wc.on('dom-ready', () => {
    if (BRAND_CSS && isServerUrl(wc.getURL())) wc.insertCSS(BRAND_CSS).catch(() => {});
  });
  wc.on('did-finish-load', () => {
    if (!isServerUrl(wc.getURL())) return;
    wc.insertCSS(HIDE_SSO_CSS).catch(() => {});
    wc.executeJavaScript(projectCopy.PAGE_SCRIPT).catch(() => {});
  });

  wc.on('context-menu', async (_e, params) => {
    const items = [];
    // In the code editor: Euphorbia's actions for the selection or cursor.
    let inEditor = { editor: false, pdf: false };
    if (params.isEditable && isServerUrl(wc.getURL())) {
      try {
        inEditor = await wc.executeJavaScript(
          `({ editor: !!(document.activeElement && document.activeElement.closest('.cm-editor') && window.__euphorbiaActions), pdf: !!(window.__euphorbiaActions && window.__euphorbiaActions.canGotoPdf()) })`
        );
      } catch {
        /* not the editor */
      }
    }
    if (inEditor.editor) {
      const act = (code) => () => wc.executeJavaScript(code).catch(() => {});
      const sel = !!params.selectionText;
      items.push(
        { label: 'Candidates', accelerator: 'CmdOrCtrl+Shift+I', registerAccelerator: false, enabled: sel, click: act('window.__euphorbiaActions.candidates()') },
        { label: 'Edit with Diff', accelerator: 'CmdOrCtrl+Shift+K', registerAccelerator: false, enabled: sel, click: act('window.__euphorbiaActions.diffEdit()') },
        { label: 'AI Edit…', accelerator: 'CmdOrCtrl+K', registerAccelerator: false, enabled: sel, click: act('window.__euphorbiaActions.aiEdit()') },
        { label: 'Add to AI Assistant', accelerator: 'CmdOrCtrl+L', registerAccelerator: false, click: act('window.__euphorbiaQuote && window.__euphorbiaQuote()') },
        { label: 'Add Note', accelerator: 'CmdOrCtrl+Shift+J', registerAccelerator: false, click: act('window.__euphorbiaActions.note()') },
        { label: 'Grammar Check', accelerator: 'CmdOrCtrl+Shift+G', registerAccelerator: false, click: act('window.__euphorbiaGrammarToggle && window.__euphorbiaGrammarToggle()') },
        { label: 'Find Citations…', accelerator: 'CmdOrCtrl+Shift+E', registerAccelerator: false, enabled: sel, click: act('window.__euphorbiaActions.cite()') },
        { type: 'separator' },
        { label: 'Go to Code Location in PDF', accelerator: 'CmdOrCtrl+Shift+P', registerAccelerator: false, enabled: inEditor.pdf, click: act('window.__euphorbiaActions.gotoPdf()') }
      );
    }
    for (const word of params.dictionarySuggestions || []) {
      items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    }
    if (items.length) items.push({ type: 'separator' });
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in Browser', click: () => openExternal(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      items.push(
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll' }
      );
    } else if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' });
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createMainWindow() {
  const b = config.bounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1400,
    height: b.height || 900,
    x: b.x,
    y: b.y,
    minWidth: 700,
    minHeight: 500,
    title: 'Euphorbia',
    icon: APP_ICON,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences,
  });
  if (config.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const remember = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    saveConfig(maximized ? { maximized } : { maximized, bounds: mainWindow.getNormalBounds() });
  };
  mainWindow.on('close', remember);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  attachCommonHandlers(mainWindow);
  mainWindow.webContents.on('did-navigate', () => split.onMainNavigate());

  mainWindow.webContents.on(
    'did-fail-load',
    async (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
      const win = mainWindow;
      if (!win) return;
      win.show();
      const others = config.servers.filter((s) => s.url !== config.current);
      const buttons = ['Retry', 'Add Server…', 'Quit'];
      if (others.length) buttons.splice(1, 0, `Switch to ${others[0].name}`);
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Connection Failed',
        message: 'Could not connect to the server.',
        detail: `${validatedURL}\n${errorDescription} (${errorCode})`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });
      const choice = buttons[response];
      if (choice === 'Retry') loadServer();
      else if (choice === 'Add Server…') showSetup();
      else if (choice === 'Quit') app.quit();
      else switchServer(others[0].url);
    }
  );

  loadServer();
}

function loadServer() {
  if (mainWindow && config.current) {
    mainWindow.loadURL(config.current + '/project').catch(() => {
      /* reported through did-fail-load */
    });
  }
}

function switchServer(url) {
  if (!config.servers.some((s) => s.url === url)) return;
  saveConfig({ current: url });
  // Windows spawned from the previous server (detached PDFs etc.) go away.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== mainWindow && win !== setupWindow) win.destroy();
  }
  buildMenu();
  if (mainWindow) loadServer();
  else createMainWindow();
}

async function removeCurrentServer() {
  const server = config.servers.find((s) => s.url === config.current);
  if (!server || !mainWindow) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    message: `Remove "${server.name}" from the server list?`,
    detail: `${server.url}\nProjects on the server are not affected.`,
    buttons: ['Remove', 'Cancel'],
    cancelId: 1,
  });
  if (response !== 0) return;
  const servers = config.servers.filter((s) => s.url !== server.url);
  if (servers.length) {
    saveConfig({ servers });
    switchServer(servers[0].url);
  } else {
    saveConfig({ servers, current: null });
    buildMenu();
    const win = mainWindow;
    mainWindow = null;
    showSetup();
    win.destroy();
  }
}

function showSetup() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 520,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: 'Add Server',
    autoHideMenuBar: true,
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'setup-preload.js') },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (!mainWindow && process.platform !== 'darwin') app.quit();
  });
}

let serversWindow = null;

function showServers() {
  if (serversWindow) {
    serversWindow.focus();
    return;
  }
  serversWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 680,
    height: 480,
    minWidth: 520,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: 'Edit Servers',
    autoHideMenuBar: true,
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'servers-preload.js') },
  });
  serversWindow.setMenuBarVisibility(false);
  serversWindow.loadFile(path.join(__dirname, 'servers.html'));
  serversWindow.on('closed', () => {
    serversWindow = null;
  });
}

const fromServersWindow = (event) => serversWindow && event.sender === serversWindow.webContents;

ipcMain.handle('servers:get', (event) => (fromServersWindow(event) ? { servers: config.servers, current: config.current } : null));

// items: [{ orig, name, url }] in the new order. Changed addresses are checked
// like a new server; removed ones drop out of the list.
ipcMain.handle('servers:save', async (event, items) => {
  if (!fromServersWindow(event) || !Array.isArray(items) || !items.length) return { ok: false, error: 'Nothing to save.' };
  const next = [];
  let current = config.current;
  for (const it of items.slice(0, 50)) {
    const orig = String((it && it.orig) || '');
    const typed = String((it && it.url) || '').trim();
    let url = orig;
    if (typed !== orig) {
      try {
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
        url = null;
        if (typed && !hasScheme) {
          try {
            url = await probeServer(normalizeServerUrl('https://' + typed), 5000);
          } catch {
            /* try http below */
          }
        }
        if (!url) url = await probeServer(normalizeServerUrl(typed));
      } catch (err) {
        return { ok: false, error: `${typed || '(empty address)'}: ${err.message || err}` };
      }
    }
    if (next.some((x) => x.url === url)) return { ok: false, error: `${url} is in the list twice.` };
    const name = String((it && it.name) || '').trim().slice(0, 40) || defaultName(url);
    next.push({ name, url });
    if (orig === config.current) current = url;
  }
  if (!next.some((x) => x.url === current)) current = next[0].url;
  const switching = current !== config.current;
  saveConfig({ servers: next });
  if (switching) switchServer(current);
  else buildMenu();
  const win = serversWindow;
  if (win) setImmediate(() => win.destroy());
  return { ok: true };
});

// -------------------------------------------------------------------- ipc ---

// Scripts the page preload injects before the page's own scripts run.
const EARLY_PAGE_SCRIPT = ['candidates.js', 'shortcut-help.js', 'editor-tabs.js', 'ai-chat.js', 'grammar.js', 'identifier.js']
  .map((f) => fs.readFileSync(path.join(__dirname, 'page', f), 'utf8'))
  .join('\n;\n');

ipcMain.on('page:early-script', (event) => {
  event.returnValue = `window.__olDesktopPane = ${split.roleOf(event.sender)};\n` + BRAND_EARLY + EARLY_PAGE_SCRIPT;
});

function fromSetup(event) {
  return setupWindow && event.sender === setupWindow.webContents;
}

ipcMain.handle('setup:save', async (event, input) => {
  if (!fromSetup(event)) return { ok: false, error: 'forbidden' };
  let url;
  try {
    const typed = String((input && input.url) || '').trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
    // An address typed without a scheme is tried over https first.
    if (typed && !hasScheme) {
      try {
        url = await probeServer(normalizeServerUrl('https://' + typed), 5000);
      } catch {
        /* fall back to http below */
      }
    }
    if (!url) url = await probeServer(normalizeServerUrl(typed));
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  const name = String((input && input.name) || '').trim().slice(0, 40) || defaultName(url);
  const servers = config.servers.filter((s) => s.url !== url);
  servers.push({ name, url });
  saveConfig({ servers });
  switchServer(url);
  const win = setupWindow;
  if (win) {
    setupWindow = null;
    win.removeAllListeners('closed');
    setImmediate(() => win.destroy());
  }
  return { ok: true };
});

// ------------------------------------------------------------------- menu ---

// Window colours: 'system' follows the OS; 'light' / 'dark' force one. This
// sets the window frame and menus, and what pages see as their colour scheme.
function windowTheme() {
  return ['system', 'light', 'dark'].includes(config.windowTheme) ? config.windowTheme : 'system';
}

function setWindowTheme(value) {
  saveConfig({ windowTheme: value });
  nativeTheme.themeSource = value;
  buildMenu();
}

function buildMenu() {
  const focused = () => BrowserWindow.getFocusedWindow();
  const serverItems = config.servers.map((s, i) => ({
    label: `${s.name}  —  ${s.url}`,
    type: 'radio',
    checked: s.url === config.current,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => {
      if (s.url !== config.current) switchServer(s.url);
      else buildMenu();
    },
  }));
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Projects', accelerator: 'CmdOrCtrl+Shift+H', click: loadServer },
        {
          label: 'Copy Project to Another Server…',
          enabled: !!config.current,
          click: () => projectCopy.copyFromWindow(),
        },
        {
          label: 'Clear Sign-in Data for This Server',
          enabled: !!config.current,
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'question',
              message: 'Clear the saved sign-in data (cookies) for the current server?',
              buttons: ['Clear', 'Cancel'],
              cancelId: 1,
            });
            if (response === 0) {
              await session.defaultSession.clearStorageData({ origin: new URL(config.current).origin });
              loadServer();
            }
          },
        },
        { type: 'separator' },
        { label: 'AI Settings…', click: () => ai.showSettings() },
        { label: `Check for Updates… (v${app.getVersion()})`, click: () => updater.check(true) },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' },
      ],
    },
    {
      label: 'Server',
      submenu: [
        ...serverItems,
        ...(serverItems.length ? [{ type: 'separator' }] : []),
        { label: 'Add Server…', click: showSetup },
        { label: 'Edit Servers…', click: showServers },
        { label: 'Remove Current Server…', enabled: !!config.current, click: removeCurrentServer },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'F5', click: () => focused()?.webContents.reload() },
        {
          label: 'Force Reload',
          accelerator: 'Shift+F5',
          click: () => focused()?.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Alt+Left', click: () => focused()?.webContents.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => focused()?.webContents.goForward() },
        { type: 'separator' },
        { label: 'Zoom In', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: 'Zoom Out', role: 'zoomOut' },
        { label: 'Actual Size', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' },
        {
          label: 'Window Theme',
          submenu: [
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ].map(([value, label]) => ({
            label,
            type: 'radio',
            checked: windowTheme() === value,
            click: () => setWindowTheme(value),
          })),
        },
        { label: 'Developer Tools', role: 'toggleDevTools', accelerator: 'F12' },
      ],
    },
  ];
  if (process.platform === 'darwin') {
    // macOS: the app menu (About, Hide, Quit) comes first; Quit lives there.
    const file = template.find((m) => m.label === 'File');
    if (file) file.submenu = file.submenu.filter((i) => i.role !== 'quit');
    while (file && file.submenu.length && file.submenu[file.submenu.length - 1].type === 'separator') file.submenu.pop();
    template.unshift({ role: 'appMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------------------------------------------------------------- app ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Present as plain Chrome. Google sign-in and reCAPTCHA reject user agents
  // that advertise an embedded browser.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s(Electron|euphorbia)\/\S+/gi, '');

  app.on('second-instance', () => {
    const win = mainWindow || setupWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    config = loadConfig();
    nativeTheme.themeSource = windowTheme();

    const override = cliServer();
    if (override) {
      try {
        const url = normalizeServerUrl(override);
        if (!config.servers.some((s) => s.url === url)) {
          config.servers.push({ name: defaultName(url), url });
        }
        config.current = url;
      } catch (err) {
        console.error('invalid server override:', err.message);
      }
    }

    // Refuse device permissions other than clipboard access, which the editor uses.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    });

    ai.init({
      getConfig: () => config,
      saveConfig,
      getMainWindow: () => mainWindow,
      isServerUrl,
    });

    split.init({
      getMainWindow: () => mainWindow,
      attachCommonHandlers,
      webPreferences,
    });

    projectCopy.init({
      getConfig: () => config,
      getMainWindow: () => mainWindow,
      isServerUrl,
      switchServer,
    });

    buildMenu();
    if (config.current) createMainWindow();
    else showSetup();
    updater.init();
  });

  // macOS keeps the app running with no windows; the Dock icon opens one again.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length) return;
    if (config.current) createMainWindow();
    else showSetup();
  });
}
