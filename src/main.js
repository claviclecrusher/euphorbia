'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const updater = require('./updater');

// ---------------------------------------------------------------- config ---
//
// config.servers: [{ name, url }]   saved servers
// config.current: url               the one the main window shows

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

// `--server=http://host` or OVERLEAF_URL selects a server for this run only.
function cliServer() {
  const arg = process.argv.find((a) => a.startsWith('--server='));
  return (arg && arg.slice('--server='.length)) || process.env.OVERLEAF_URL || null;
}

// ------------------------------------------------------------------- urls ---

function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('주소를 입력하세요.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('http 또는 https 주소만 사용할 수 있습니다.');
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

// Server pages from which a sign-in may leave for an identity provider
// (Google, ORCID, institutional SSO, SAML/OIDC).
const AUTH_PATH = /^\/(login|register|sso-login|institutional-login|auth|saml|oidc|oauth|user\/(settings|sessions|reconfirm|emails))(\/|$)/;

function isAuthPage(url) {
  try {
    return isServerUrl(url) && AUTH_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isWebUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
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
    if (!res.ok) throw new Error(`서버 응답 오류 (HTTP ${res.status})`);
    const body = await res.text();
    if (!/ol-|overleaf|sharelatex/i.test(body)) {
      throw new Error('Overleaf 서버가 아닌 것 같습니다.');
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
    if (err.name === 'AbortError') throw new Error('서버 응답 시간이 초과되었습니다.');
    if (/^net::/.test(err.message || '')) throw new Error(`서버에 연결할 수 없습니다. (${err.message})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- windows ---

const webPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: true,
};

function attachCommonHandlers(win) {
  const wc = win.webContents;

  // Server pages opened in a "new tab" (detached PDF, project in new tab)
  // become app windows; so do sign-in popups. Everything else goes to the
  // system browser.
  wc.setWindowOpenHandler(({ url }) => {
    const signInPopup = isWebUrl(url) && (isAuthPage(wc.getURL()) || !isServerUrl(wc.getURL()));
    if (isServerUrl(url) || url === 'about:blank' || signInPopup) {
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

  // Same-window navigation stays in the app when it is part of the server or
  // of a sign-in round trip: leaving from a login page, or moving on from an
  // identity provider's page we are already on. Any other link that leaves
  // the server opens in the system browser.
  wc.on('will-navigate', (event, url) => {
    if (isServerUrl(url)) return;
    const from = wc.getURL();
    const signIn = isWebUrl(url) && (isAuthPage(from) || (isWebUrl(from) && !isServerUrl(from)));
    if (signIn) return;
    event.preventDefault();
    openExternal(url);
  });

  wc.on('context-menu', (_e, params) => {
    const items = [];
    for (const word of params.dictionarySuggestions || []) {
      items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    }
    if (items.length) items.push({ type: 'separator' });
    if (params.linkURL) {
      items.push(
        { label: '링크를 브라우저에서 열기', click: () => openExternal(params.linkURL) },
        { label: '링크 주소 복사', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      items.push(
        { label: '실행 취소', role: 'undo' },
        { label: '다시 실행', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut', enabled: params.editFlags.canCut },
        { label: '복사', role: 'copy', enabled: params.editFlags.canCopy },
        { label: '붙여넣기', role: 'paste', enabled: params.editFlags.canPaste },
        { label: '모두 선택', role: 'selectAll' }
      );
    } else if (params.selectionText) {
      items.push({ label: '복사', role: 'copy' });
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
    title: 'Overleaf Desktop',
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

  mainWindow.webContents.on(
    'did-fail-load',
    async (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
      const win = mainWindow;
      if (!win) return;
      win.show();
      const others = config.servers.filter((s) => s.url !== config.current);
      const buttons = ['다시 시도', '서버 추가…', '종료'];
      if (others.length) buttons.splice(1, 0, `${others[0].name}(으)로 전환`);
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        title: '연결 실패',
        message: '서버에 연결할 수 없습니다.',
        detail: `${validatedURL}\n${errorDescription} (${errorCode})`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });
      const choice = buttons[response];
      if (choice === '다시 시도') loadServer();
      else if (choice === '서버 추가…') showSetup();
      else if (choice === '종료') app.quit();
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
    message: `"${server.name}" 서버를 목록에서 지울까요?`,
    detail: `${server.url}\n서버의 프로젝트에는 영향이 없습니다.`,
    buttons: ['지우기', '취소'],
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
    width: 520,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: '서버 추가',
    autoHideMenuBar: true,
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'setup-preload.js') },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (!mainWindow) app.quit();
  });
}

// -------------------------------------------------------------------- ipc ---

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
      label: '파일',
      submenu: [
        { label: '프로젝트 목록', accelerator: 'CmdOrCtrl+Shift+H', click: loadServer },
        {
          label: '이 서버의 로그인 정보 지우기',
          enabled: !!config.current,
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'question',
              message: '현재 서버에 저장된 로그인 정보(쿠키)를 지울까요?',
              buttons: ['지우기', '취소'],
              cancelId: 1,
            });
            if (response === 0) {
              await session.defaultSession.clearStorageData({ origin: new URL(config.current).origin });
              loadServer();
            }
          },
        },
        { type: 'separator' },
        { label: `업데이트 확인… (현재 ${app.getVersion()})`, click: () => updater.check(true) },
        { type: 'separator' },
        { label: '종료', role: 'quit' },
      ],
    },
    {
      label: '서버',
      submenu: [
        ...serverItems,
        ...(serverItems.length ? [{ type: 'separator' }] : []),
        { label: '서버 추가…', click: showSetup },
        { label: '현재 서버 삭제…', enabled: !!config.current, click: removeCurrentServer },
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', role: 'undo' },
        { label: '다시 실행', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut' },
        { label: '복사', role: 'copy' },
        { label: '붙여넣기', role: 'paste' },
        { label: '모두 선택', role: 'selectAll' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '새로 고침', accelerator: 'F5', click: () => focused()?.webContents.reload() },
        {
          label: '강력 새로 고침',
          accelerator: 'Shift+F5',
          click: () => focused()?.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        { label: '뒤로', accelerator: 'Alt+Left', click: () => focused()?.webContents.goBack() },
        { label: '앞으로', accelerator: 'Alt+Right', click: () => focused()?.webContents.goForward() },
        { type: 'separator' },
        { label: '확대', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: '축소', role: 'zoomOut' },
        { label: '원래 크기', role: 'resetZoom' },
        { type: 'separator' },
        { label: '전체 화면', role: 'togglefullscreen' },
        { label: '개발자 도구', role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------------------------------------------------------------- app ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Present as plain Chrome. Google sign-in and reCAPTCHA reject user agents
  // that advertise an embedded browser.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s(Electron|overleaf-desktop|OverleafDesktop)\/\S+/gi, '');

  app.on('second-instance', () => {
    const win = mainWindow || setupWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    config = loadConfig();

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

    buildMenu();
    if (config.current) createMainWindow();
    else showSetup();
    updater.init();
  });

  app.on('window-all-closed', () => app.quit());
}
