'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const updater = require('./updater');

// ---------------------------------------------------------------- config ---

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
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

let config = {};
let mainWindow = null;
let setupWindow = null;

// `--server=http://host` or OVERLEAF_URL override the stored address.
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

function serverOrigin() {
  try {
    return new URL(config.serverUrl).origin;
  } catch {
    return null;
  }
}

function isServerUrl(url) {
  try {
    return new URL(url).origin === serverOrigin();
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

// Checks that the address answers like an Overleaf instance.
async function probeServer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await net.fetch(url + '/login', { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`서버 응답 오류 (HTTP ${res.status})`);
    const body = await res.text();
    if (!/ol-|overleaf|sharelatex/i.test(body)) {
      throw new Error('Overleaf 서버가 아닌 것 같습니다.');
    }
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

  // Links leaving the server go to the system browser; server pages opened in
  // a "new tab" (detached PDF, project in new tab) become app windows.
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

  wc.on('will-navigate', (event, url) => {
    if (!isServerUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
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
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        title: '연결 실패',
        message: 'Overleaf 서버에 연결할 수 없습니다.',
        detail: `${validatedURL}\n${errorDescription} (${errorCode})`,
        buttons: ['다시 시도', '서버 주소 변경', '종료'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) loadServer();
      else if (response === 1) showSetup();
      else app.quit();
    }
  );

  loadServer();
}

function loadServer() {
  if (mainWindow && config.serverUrl) {
    mainWindow.loadURL(config.serverUrl + '/project').catch(() => {
      /* reported through did-fail-load */
    });
  }
}

function showSetup() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: '서버 설정',
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

ipcMain.handle('setup:get', (event) => (fromSetup(event) ? config.serverUrl || '' : ''));

ipcMain.handle('setup:save', async (event, input) => {
  if (!fromSetup(event)) return { ok: false, error: 'forbidden' };
  let url;
  try {
    url = normalizeServerUrl(input);
    await probeServer(url);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  saveConfig({ serverUrl: url });
  if (mainWindow) loadServer();
  else createMainWindow();
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
  const template = [
    {
      label: '파일',
      submenu: [
        { label: '프로젝트 목록', accelerator: 'CmdOrCtrl+Shift+H', click: loadServer },
        { label: '서버 주소 변경…', click: showSetup },
        {
          label: '로그인 정보 지우기',
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'question',
              message: '저장된 로그인 정보(쿠키)를 지울까요?',
              buttons: ['지우기', '취소'],
              cancelId: 1,
            });
            if (response === 0) {
              await session.defaultSession.clearStorageData();
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
        config.serverUrl = normalizeServerUrl(override);
      } catch (err) {
        console.error('invalid server override:', err.message);
      }
    }

    // The app only ever talks to the Overleaf server; refuse device permissions
    // other than clipboard access, which the editor uses.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    });

    buildMenu();
    if (config.serverUrl) createMainWindow();
    else showSetup();
    updater.init();
  });

  app.on('window-all-closed', () => app.quit());
}
