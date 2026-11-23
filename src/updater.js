'use strict';

const { app, dialog, shell, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/claviclecrusher/overleaf-desktop/releases/latest';

// Installed NSIS builds and AppImages can replace themselves. Portable exes and
// .deb installs cannot, so they only get a notification with a download link.
function canSelfUpdate() {
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}

let manualCheck = false;
let promptOpen = false;

const parentWindow = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

function show(options) {
  const win = parentWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function init() {
  if (!app.isPackaged) return;

  // Test hook: point the updater at a plain HTTP directory instead of GitHub.
  if (process.env.OVERLEAF_DESKTOP_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.OVERLEAF_DESKTOP_UPDATE_URL });
  }

  autoUpdater.autoDownload = canSelfUpdate();
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('update-available', async (info) => {
    if (autoUpdater.autoDownload) {
      if (manualCheck) {
        manualCheck = false;
        show({
          type: 'info',
          message: `새 버전 ${info.version}을 내려받는 중입니다.`,
          detail: '다 받으면 다시 알려드립니다.',
        });
      }
      return;
    }
    manualCheck = false;
    if (promptOpen) return;
    promptOpen = true;
    const { response } = await show({
      type: 'info',
      message: `새 버전 ${info.version}이 있습니다. (현재 ${app.getVersion()})`,
      detail: '이 설치 방식은 자동 업데이트를 지원하지 않습니다. 다운로드 페이지에서 새 버전을 받아 설치하세요.',
      buttons: ['다운로드 페이지 열기', '나중에'],
      defaultId: 0,
      cancelId: 1,
    });
    promptOpen = false;
    if (response === 0) shell.openExternal(RELEASES_URL);
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    show({ type: 'info', message: `최신 버전입니다. (${app.getVersion()})` });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (promptOpen) return;
    promptOpen = true;
    const { response } = await show({
      type: 'info',
      message: `새 버전 ${info.version}이 준비됐습니다.`,
      detail: '지금 재시작하면 바로 적용됩니다. 나중에를 고르면 앱을 종료할 때 적용됩니다.',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
    });
    promptOpen = false;
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.error('update error:', err);
    if (!manualCheck) return;
    manualCheck = false;
    show({
      type: 'error',
      message: '업데이트를 확인하지 못했습니다.',
      detail: String((err && err.message) || err).slice(0, 500),
    });
  });

  check(false);
}

function check(manual) {
  if (!app.isPackaged) {
    if (manual) show({ type: 'info', message: '개발 모드에서는 업데이트를 확인하지 않습니다.' });
    return;
  }
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch(() => {
    /* reported through the error event */
  });
}

module.exports = { init, check };
