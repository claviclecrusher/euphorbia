'use strict';

// Copy a project from the current server to another saved server: download
// the source project as a zip and upload it to the target as a new project,
// using the sign-in session the app already holds for each server.

const { dialog, ipcMain, session } = require('electron');

let ctx = null;
let busy = false;

const PROJECT_ID = /^[0-9a-f]{24}$/;

// Runs in server pages. Adds "Make a copy to other server" to the More menu
// that the project list shows while one project is ticked.
const PAGE_SCRIPT = `(() => {
  if (window.__overleafDesktopCopy || !window.overleafDesktop) return;
  window.__overleafDesktopCopy = true;
  const LABEL = 'Make a copy to other server';

  function selected() {
    const box = document.querySelector('input[type="checkbox"][data-project-id]:checked');
    if (!box) return null;
    const row = box.closest('tr');
    const link = row && row.querySelector('a[href*="/project/"]');
    return { id: box.getAttribute('data-project-id'), name: link ? link.textContent.trim() : '' };
  }

  function add(menu) {
    if (menu.querySelector('[data-overleaf-desktop-copy]')) return;
    const sample = menu.querySelector('.dropdown-item');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = sample ? sample.className.replace(/\\b(active|disabled)\\b/g, '') : 'dropdown-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.textContent = LABEL;
    button.addEventListener('click', () => {
      const project = selected();
      document.body.click(); // closes the dropdown
      if (project) window.overleafDesktop.copyProject(project);
    });
    let node = button;
    if (!sample || (sample.parentElement && sample.parentElement.tagName === 'LI')) {
      node = document.createElement('li');
      node.setAttribute('role', 'none');
      node.appendChild(button);
    }
    node.setAttribute('data-overleaf-desktop-copy', '');
    menu.appendChild(node);
  }

  const scan = () =>
    document.querySelectorAll('[data-testid="project-tools-more-dropdown-menu"]').forEach(add);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})()`;

function init(context) {
  ctx = context;
  ipcMain.handle('project:copy', (event, project) => {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!ctx.isServerUrl(frameUrl)) return;
    if (!project || !PROJECT_ID.test(String(project.id))) return;
    start({ id: String(project.id), name: String(project.name || '').slice(0, 150) });
  });
}

// File menu entry: works from the editor (project in the address) and from
// the project list (ticked project).
async function copyFromWindow() {
  const win = ctx.getMainWindow();
  if (!win) return;
  let project = null;
  try {
    const url = new URL(win.webContents.getURL());
    const m = url.pathname.match(/^\/project\/([0-9a-f]{24})(\/|$)/);
    if (m && ctx.isServerUrl(url.href)) {
      project = { id: m[1], name: '' };
    } else if (ctx.isServerUrl(url.href)) {
      project = await win.webContents.executeJavaScript(
        `(() => {
          const boxes = document.querySelectorAll('input[type="checkbox"][data-project-id]:checked');
          if (boxes.length !== 1) return null;
          const row = boxes[0].closest('tr');
          const link = row && row.querySelector('a[href*="/project/"]');
          return { id: boxes[0].getAttribute('data-project-id'), name: link ? link.textContent.trim() : '' };
        })()`
      );
    }
  } catch {
    project = null;
  }
  if (!project || !PROJECT_ID.test(String(project.id))) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Select a project first',
      detail: 'Open a project, or tick exactly one project in the project list, then try again.',
    });
    return;
  }
  start({ id: project.id, name: String(project.name || '').slice(0, 150) });
}

async function start(project) {
  const win = ctx.getMainWindow();
  if (!win || busy) return;
  const config = ctx.getConfig();
  const source = config.servers.find((s) => s.url === config.current);
  const others = config.servers.filter((s) => s.url !== config.current);
  if (!source) return;

  if (!others.length) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'No other server to copy to',
      detail: 'Add another server from the Server menu and sign in to it first.',
    });
    return;
  }

  const label = project.name ? `"${project.name}"` : 'this project';
  const shown = others.slice(0, 4);
  const buttons = [...shown.map((s) => (others.length === 1 ? `Copy to ${s.name}` : s.name)), 'Cancel'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: others.length === 1 ? `Copy ${label} to ${shown[0].name}?` : `Copy ${label} to which server?`,
    detail:
      `From: ${source.name} (${source.url})\n\n` +
      'The files are copied into a new project. History, comments, tracked changes and ' +
      'collaborators are not copied.',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response >= shown.length) return;
  const target = shown[response];

  busy = true;
  win.setProgressBar(2); // indeterminate
  let result;
  try {
    result = await copy(project, source, target);
  } catch (err) {
    result = { error: err };
  } finally {
    busy = false;
    if (!win.isDestroyed()) win.setProgressBar(-1);
  }
  if (win.isDestroyed()) return;

  if (result.error) {
    const notSignedIn = result.error.code === 'NOT_SIGNED_IN';
    const { response: r } = await dialog.showMessageBox(win, {
      type: 'error',
      message: notSignedIn ? `You are not signed in to ${target.name}` : 'The project could not be copied',
      detail: notSignedIn
        ? `Switch to ${target.name}, sign in, then come back and try again.`
        : String(result.error.message || result.error).slice(0, 500),
      buttons: notSignedIn ? [`Switch to ${target.name}`, 'Cancel'] : ['OK'],
      cancelId: notSignedIn ? 1 : 0,
    });
    if (notSignedIn && r === 0) ctx.switchServer(target.url);
    return;
  }

  const { response: r } = await dialog.showMessageBox(win, {
    type: 'info',
    message: `Copied to ${target.name}`,
    detail: `"${result.name}" is now a new project on ${target.name}.`,
    buttons: [`Open on ${target.name}`, 'Stay Here'],
    defaultId: 1,
    cancelId: 1,
  });
  if (r === 0) {
    ctx.switchServer(target.url);
    const w = ctx.getMainWindow();
    if (w) w.loadURL(`${target.url}/project/${result.projectId}`).catch(() => {});
  }
}

function fetchWithSession(url, options = {}) {
  return session.defaultSession.fetch(url, { credentials: 'include', ...options });
}

function fail(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

async function copy(project, source, target) {
  // The target session is checked first so a large download is not wasted.
  const who = await fetchWithSession(`${target.url}/user/personal_info`, {
    headers: { Accept: 'application/json' },
  });
  if (!who.ok || !/json/i.test(who.headers.get('content-type') || '')) {
    throw fail('not signed in', 'NOT_SIGNED_IN');
  }

  const zip = await fetchWithSession(`${source.url}/project/${project.id}/download/zip`);
  const zipType = zip.headers.get('content-type') || '';
  if (!zip.ok || !/zip|octet-stream/i.test(zipType)) {
    throw fail(`Could not download the project from ${source.name} (HTTP ${zip.status}).`);
  }
  const data = await zip.arrayBuffer();

  let name = project.name;
  if (!name) {
    const disposition = zip.headers.get('content-disposition') || '';
    const m = disposition.match(/filename\*=UTF-8''([^;]+)/i) || disposition.match(/filename="?([^";]+)"?/i);
    if (m) {
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = m[1];
      }
    }
  }
  name = (name || 'Copied project').replace(/\.zip$/i, '').slice(0, 150);

  const csrf = await csrfToken(target);

  const form = new FormData();
  form.append('name', `${name}.zip`);
  form.append('qqfile', new Blob([data], { type: 'application/zip' }), `${name}.zip`);
  const up = await fetchWithSession(`${target.url}/project/new/upload`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' },
    body: form,
  });
  let body = null;
  try {
    body = await up.json();
  } catch {
    /* not JSON */
  }
  if (!up.ok || !body || !body.success || !body.project_id) {
    const reason = (body && body.error) || `HTTP ${up.status}`;
    throw fail(`${target.name} did not accept the project: ${reason}`);
  }
  return { projectId: String(body.project_id), name };
}

async function csrfToken(server) {
  const res = await fetchWithSession(`${server.url}/dev/csrf`);
  const text = res.ok ? (await res.text()).trim() : '';
  if (/^[\w-]{20,}$/.test(text)) return text;
  // Fallback: every page carries the token in a meta tag.
  const page = await fetchWithSession(`${server.url}/project`);
  const m = (await page.text()).match(/<meta name="ol-csrfToken" content="([^"]+)"/);
  if (!m) throw fail(`Could not get a security token from ${server.name}.`);
  return m[1];
}

module.exports = { init, copyFromWindow, PAGE_SCRIPT };
