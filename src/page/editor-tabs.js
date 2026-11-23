// Runs in the Overleaf page. Adds a tab strip above the editor: every document
// opened in a project gets a tab; clicking a tab switches to it, × (or a
// middle click) closes it. Tabs are remembered per project in localStorage.
//
// Overleaf keeps one document open at a time, so switching a tab opens that
// document through the file tree, exactly as if it had been clicked there.
// Collapsed folders unmount their children, so each tab remembers the folders
// above its document and expands them first when needed.
(() => {
  if (window.__overleafDesktopTabs) return;
  window.__overleafDesktopTabs = true;

  const m = location.pathname.match(/^\/project\/([0-9a-f]{24})\/?$/);
  if (!m) return;
  const projectId = m[1];
  const KEY = `ol-desktop-tabs:${projectId}`;

  // tabs: [{ id, name, folders: [folderId, ...] }]
  let tabs = [];
  let activeId = null;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) tabs = saved.filter((t) => t && /^[0-9a-f]{24}$/.test(t.id));
  } catch {
    /* ignore */
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(tabs));
    } catch {
      /* ignore */
    }
  };

  const store = () => window.overleaf && window.overleaf.unstable && window.overleaf.unstable.store;
  const storeGet = (k) => {
    try {
      return store().get(k);
    } catch {
      return null;
    }
  };

  const treeEntity = (id) => document.querySelector(`[data-file-id="${id}"]`);

  // Folder ids above a rendered tree entity, outermost first. A folder's
  // children are rendered as a nested list right after the folder's <li>.
  function foldersOf(id) {
    const out = [];
    const entity = treeEntity(id);
    let item = entity && entity.closest('li[role="treeitem"]');
    while (item) {
      const list = item.parentElement && item.parentElement.closest('ul[role="tree"]');
      if (!list || list.classList.contains('file-tree-list')) break;
      const li = list.previousElementSibling;
      const folder = li && li.matches('li[role="treeitem"]') && li.querySelector(':scope > [data-file-type="folder"]');
      if (!folder) break;
      out.unshift(folder.getAttribute('data-file-id'));
      item = li;
    }
    return out;
  }

  // ------------------------------------------------------------ opening ---

  function onOpened(docId) {
    if (!docId) return;
    const name = storeGet('editor.open_doc_name') || (tabs.find((t) => t.id === docId) || {}).name || 'document';
    const folders = treeEntity(docId) ? foldersOf(docId) : null;
    const existing = tabs.find((t) => t.id === docId);
    if (existing) {
      existing.name = name;
      if (folders) existing.folders = folders;
    } else {
      // New tabs go right after the active one.
      const at = tabs.findIndex((t) => t.id === activeId);
      const tab = { id: docId, name, folders: folders || [] };
      if (at < 0) tabs.push(tab);
      else tabs.splice(at + 1, 0, tab);
    }
    activeId = docId;
    save();
    render();
  }

  window.addEventListener('doc:after-opened', (e) => onOpened(e.detail && e.detail.docId));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v || Date.now() > end) return v;
      await sleep(50);
    }
  }

  async function openTab(tab) {
    if (tab.id === storeGet('editor.open_doc_id')) return;
    for (const folderId of tab.folders || []) {
      const folder = await waitFor(() => treeEntity(folderId), 1000);
      if (!folder) break;
      const li = folder.closest('li[role="treeitem"]');
      if (li && li.getAttribute('aria-expanded') === 'false') {
        const toggle = folder.querySelector('.folder-expand-collapse-button');
        if (toggle) toggle.click();
      }
    }
    const entity = await waitFor(() => treeEntity(tab.id), 1500);
    const button = entity && (entity.querySelector('.item-name-button') || entity.querySelector('button'));
    if (!button) {
      // The document is gone (deleted or moved out of reach): drop its tab.
      closeTab(tab.id);
      return;
    }
    button.click();
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    save();
    if (id === activeId && tabs.length) {
      openTab(tabs[Math.min(i, tabs.length - 1)]);
    }
    render();
  }

  // ------------------------------------------------------------- strip ---

  const strip = document.createElement('div');
  strip.className = 'ol-desktop-tabs-strip';
  strip.setAttribute('role', 'tablist');

  let dragId = null;

  function render() {
    strip.textContent = '';
    const counts = {};
    for (const t of tabs) counts[t.name] = (counts[t.name] || 0) + 1;
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = 'ol-desktop-tab' + (tab.id === activeId ? ' active' : '');
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(tab.id === activeId));
      el.title = tab.name;
      el.draggable = true;

      const label = document.createElement('span');
      label.className = 'ol-desktop-tab-label';
      label.textContent = tab.name;
      if (counts[tab.name] > 1 && tab.folders && tab.folders.length) {
        const hint = document.createElement('span');
        hint.className = 'ol-desktop-tab-hint';
        const folder = treeEntity(tab.folders[tab.folders.length - 1]);
        hint.textContent = folder ? ` — ${folder.textContent.replace(/chevron_right|expand_more|more_vert/g, '').trim()}` : '';
        label.appendChild(hint);
      }
      el.appendChild(label);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ol-desktop-tab-close';
      close.textContent = '×';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      el.appendChild(close);

      el.addEventListener('click', () => openTab(tab));
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      });
      el.addEventListener('dragstart', (e) => {
        dragId = tab.id;
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragover', (e) => {
        if (dragId) e.preventDefault();
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = tabs.findIndex((t) => t.id === dragId);
        const to = tabs.findIndex((t) => t.id === tab.id);
        dragId = null;
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        save();
        render();
      });
      strip.appendChild(el);
    }
    const active = strip.querySelector('.ol-desktop-tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Keep the strip directly above the editor. Overleaf may re-render the
  // panel, so this re-attaches it whenever it goes missing.
  function attach() {
    const editor = document.querySelector('.cm-editor');
    const holder = editor && editor.parentElement;
    const panel = holder && holder.parentElement;
    if (!panel) return;
    if (strip.parentElement === panel && strip.nextElementSibling === holder) return;
    panel.insertBefore(strip, holder);
    panel.classList.add('ol-desktop-tabs-host');
    holder.classList.add('ol-desktop-tabs-editor');
    render();
  }

  const style = document.createElement('style');
  style.textContent = `
    .ol-desktop-tabs-host { display: flex !important; flex-direction: column; }
    .ol-desktop-tabs-editor { flex: 1 1 auto; min-height: 0; }
    .ol-desktop-tabs-strip { flex: 0 0 auto; display: flex; overflow-x: auto; overflow-y: hidden;
      background: var(--bg-dark-secondary, #2f3a4c); scrollbar-width: thin; }
    .ol-desktop-tabs-strip:empty { display: none; }
    .ol-desktop-tab { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; max-width: 220px;
      padding: 4px 6px 4px 12px; font: 13px system-ui, "Segoe UI", sans-serif; cursor: pointer;
      color: rgba(255,255,255,.7); border-right: 1px solid rgba(0,0,0,.25); user-select: none; }
    .ol-desktop-tab:hover { color: #fff; background: rgba(255,255,255,.06); }
    .ol-desktop-tab.active { color: #1b222c; background: #fff; box-shadow: inset 0 2px 0 #098842; }
    .ol-desktop-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ol-desktop-tab-hint { opacity: .6; }
    .ol-desktop-tab-close { font: inherit; line-height: 1; border: 0; background: none; color: inherit;
      padding: 0 4px; border-radius: 3px; opacity: .55; cursor: pointer; }
    .ol-desktop-tab-close:hover { opacity: 1; background: rgba(128,128,128,.25); }
  `;

  const scan = () => {
    if (!style.isConnected && document.head) document.head.appendChild(style);
    attach();
  };
  const start = () => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
