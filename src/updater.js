'use strict';

const { app, dialog, shell, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/claviclecrusher/euphorbia/releases/latest';

// Installed NSIS builds and AppImages can replace themselves. Portable exes and
// .deb installs cannot, so they only get a notification with a download link.
function canSelfUpdate() {
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}

// File > Check for Updates: download, install and restart without asking.
// The check at startup downloads in the background and asks before restarting.
let manualCheck = false;
let installWhenReady = false;
let downloaded = null; // info of an update already downloaded
let promptOpen = false;

const parentWindow = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

function show(options) {
  const win = parentWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

// Download progress on the taskbar / dock icon instead of a dialog.
function progress(value) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setProgressBar(value);
}

// Silent install, then relaunch: the Windows installer runs without its wizard
// and reuses the existing install location.
function installNow() {
  progress(-1);
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

function init() {
  if (!app.isPackaged) return;

  // Test hook: point the updater at a plain HTTP directory instead of GitHub.
  if (process.env.EUPHORBIA_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.EUPHORBIA_UPDATE_URL });
  }

  autoUpdater.autoDownload = canSelfUpdate();
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('update-available', async (info) => {
    if (autoUpdater.autoDownload) {
      if (manualCheck) {
        manualCheck = false;
        installWhenReady = true;
        progress(2); // indeterminate until progress arrives
      }
      return;
    }
    manualCheck = false;
    if (promptOpen) return;
    promptOpen = true;
    const { response } = await show({
      type: 'info',
      message: `Version ${info.version} is available. (You have ${app.getVersion()}.)`,
      detail: 'This kind of install cannot update itself. Download the new version from the releases page.',
      buttons: ['Open Download Page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    promptOpen = false;
    if (response === 0) shell.openExternal(RELEASES_URL);
  });

  autoUpdater.on('download-progress', (p) => {
    if (installWhenReady && p && p.percent != null) progress(Math.max(0.01, p.percent / 100));
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    show({ type: 'info', message: `You are up to date. (v${app.getVersion()})` });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloaded = info;
    if (installWhenReady) return installNow();
    if (promptOpen) return;
    promptOpen = true;
    const { response } = await show({
      type: 'info',
      message: `Version ${info.version} is ready to install.`,
      detail: 'Restart now to apply it, or choose Later to apply it when you quit the app (or use File > Check for Updates).',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    promptOpen = false;
    if (response === 0) installNow();
  });

  autoUpdater.on('error', (err) => {
    console.error('update error:', err);
    progress(-1);
    installWhenReady = false;
    if (!manualCheck) return;
    manualCheck = false;
    show({
      type: 'error',
      message: 'Could not check for updates.',
      detail: String((err && err.message) || err).slice(0, 500),
    });
  });

  check(false);
}

function check(manual) {
  if (!app.isPackaged) {
    if (manual) show({ type: 'info', message: 'Updates are not checked in development mode.' });
    return;
  }
  // Already downloaded in the background: install it right away.
  if (manual && downloaded && canSelfUpdate()) return installNow();
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch(() => {
    /* reported through the error event */
  });
}

module.exports = { init, check };
