// Runs in the Overleaf page. Editor tabs and the split editor.
//
// Tabs: every document opened in a project gets a tab above the editor; click
// to switch, × or middle click to close, drag to reorder. Tabs are remembered
// per project and per pane in localStorage.
//
// Split: the editor can be split top/bottom. The bottom pane is a second page
// of the same project (see src/split.js) showing only its editor. A tab can be
// sent to the other pane with its ⇅ button, its context menu, or by dragging it
// there. When the bottom pane has no tabs left the editor is a single pane again.
//
// Overleaf keeps one document open per page, so switching a tab opens that
// document through the file tree, as if it had been clicked there. Collapsed
// folders unmount their children, so each tab remembers the folders above its
// document and expands them first when needed.
(() => {
  if (window.__overleafDesktopTabs) return;
  window.__overleafDesktopTabs = true;

  const PANE = window.__olDesktopPane || 0; // 1 main page, 2 bottom pane, 0 other windows
  if (!PANE) return;
  const m = location.pathname.match(/^\/project\/([0-9a-f]{24})\/?$/);
  if (!m) return;
  const projectId = m[1];
  const bridge = window.overleafDesktop && window.overleafDesktop.split;
  const KEY = (pane) => `ol-desktop-tabs:${projectId}${pane === 2 ? ':2' : ''}`;
  const RATIO_KEY = `ol-desktop-split-ratio:${projectId}`;
  const DRAG_TYPE = 'application/x-ol-desktop-tab';

  // ------------------------------------------------------------- state ---

  function load(pane) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY(pane)) || 'null');
      const list = Array.isArray(saved) ? saved : saved && Array.isArray(saved.tabs) ? saved.tabs : [];
      return {
        tabs: list.filter((t) => t && /^[0-9a-f]{24}$/.test(t.id)),
        active: saved && saved.active ? String(saved.active) : null,
      };
    } catch {
      return { tabs: [], active: null };
    }
  }

  const initial = load(PANE);
  let tabs = initial.tabs; // [{ id, name, folders: [folderId, ...] }]
  let activeId = PANE === 2 ? initial.active : null;
  let splitOpen = false;

  const save = () => {
    try {
      localStorage.setItem(KEY(PANE), JSON.stringify({ tabs, active: activeId }));
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v || Date.now() > end) return v;
      await sleep(50);
    }
  }

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

  // --------------------------------------------------------- opening ---

  // Documents the bottom pane opened itself (Overleaf's initial document)
  // are not turned into tabs there; it only shows what was sent to it.
  let expecting = null;

  function onOpened(docId) {
    if (!docId) return;
    if (PANE === 2 && !tabs.some((t) => t.id === docId) && expecting !== docId) return;
    expecting = null;
    const name = storeGet('editor.open_doc_name') || (tabs.find((t) => t.id === docId) || {}).name || 'document';
    const folders = treeEntity(docId) ? foldersOf(docId) : null;
    // Folder path for the tooltip (Overleaf's own file-name row is hidden).
    const path = folders
      ? folders.map((f) => (treeEntity(f) ? treeEntity(f).textContent.replace(/chevron_right|expand_more|more_vert/g, '').trim() : '')).concat(name).join(' / ')
      : null;
    const existing = tabs.find((t) => t.id === docId);
    if (existing) {
      existing.name = name;
      if (path) existing.path = path;
      if (folders) existing.folders = folders;
    } else {
      const at = tabs.findIndex((t) => t.id === activeId);
      const tab = { id: docId, name, folders: folders || [], path: path || name };
      if (at < 0) tabs.push(tab);
      else tabs.splice(at + 1, 0, tab);
    }
    activeId = docId;
    save();
    render();
  }
  window.addEventListener('doc:after-opened', (e) => onOpened(e.detail && e.detail.docId));

  async function openTab(tab) {
    if (tab.id === storeGet('editor.open_doc_id')) {
      if (activeId !== tab.id) onOpened(tab.id);
      return;
    }
    expecting = tab.id;
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
      expecting = null;
      removeTab(tab.id);
      return;
    }
    button.click();
  }

  // Removes a tab; if it was showing, the neighbour opens. A pane left
  // without tabs hands over to the other one.
  function removeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    const wasActive = id === activeId;
    if (wasActive) activeId = null;
    save();
    render();
    if (!tabs.length) {
      if (PANE === 2) bridge.send('split:empty');
      else if (splitOpen) bridge.send('split:primary-empty');
      return;
    }
    if (wasActive) openTab(tabs[Math.min(i, tabs.length - 1)]);
  }

  function addTab(tab, open) {
    if (!tabs.some((t) => t.id === tab.id)) {
      const at = tabs.findIndex((t) => t.id === activeId);
      if (at < 0) tabs.push(tab);
      else tabs.splice(at + 1, 0, tab);
      save();
      render();
    }
    if (open) openTab(tabs.find((t) => t.id === tab.id));
  }

  // Sends a tab to the other pane (opening the split when needed).
  function moveTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !bridge) return;
    bridge.send('split:move', { id: tab.id, name: tab.name, folders: tab.folders || [], path: tab.path || tab.name });
    removeTab(id);
  }

  if (bridge) {
    bridge.on('split:receive', (tab) => addTab(tab, true));
    bridge.on('split:remove', (id) => removeTab(id));
    bridge.on('split:give-all', () => {
      for (const tab of tabs.slice()) bridge.send('split:move', tab);
      tabs = [];
      activeId = null;
      save();
      render();
      bridge.send('split:empty');
    });
  }

  // --------------------------------------------------------- tab strip ---

  const strip = document.createElement('div');
  strip.className = 'ol-desktop-tabs-strip';
  strip.setAttribute('role', 'tablist');

  const otherPaneLabel = () => (PANE === 2 ? 'Move to top pane' : splitOpen ? 'Move to bottom pane' : 'Split down');
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
      el.title = tab.path || tab.name;
      el.draggable = true;
      el.dataset.id = tab.id;

      const label = document.createElement('span');
      label.className = 'ol-desktop-tab-label';
      label.textContent = tab.name;
      if (counts[tab.name] > 1 && tab.folders && tab.folders.length) {
        const folder = treeEntity(tab.folders[tab.folders.length - 1]);
        if (folder) {
          const hint = document.createElement('span');
          hint.className = 'ol-desktop-tab-hint';
          hint.textContent = ` — ${folder.textContent.replace(/chevron_right|expand_more|more_vert/g, '').trim()}`;
          label.appendChild(hint);
        }
      }
      el.appendChild(label);

      if (bridge) {
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'ol-desktop-tab-btn ol-desktop-tab-move';
        move.textContent = '⇅';
        move.title = otherPaneLabel();
        move.addEventListener('click', (e) => {
          e.stopPropagation();
          moveTab(tab.id);
        });
        el.appendChild(move);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ol-desktop-tab-btn';
      close.textContent = '×';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTab(tab.id);
      });
      el.appendChild(close);

      el.addEventListener('click', () => openTab(tab));
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          removeTab(tab.id);
        }
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, tab);
      });
      el.addEventListener('dragstart', (e) => {
        dragId = tab.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ pane: PANE, tab }));
        if (PANE === 1 && !splitOpen && bridge) showDropZone(true);
      });
      el.addEventListener('dragend', () => {
        dragId = null;
        showDropZone(false);
      });
      el.addEventListener('dragover', (e) => {
        if (isTabDrag(e)) e.preventDefault();
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const before = tabs.findIndex((t) => t.id === tab.id);
        handleDrop(e, before);
      });
      strip.appendChild(el);
    }
    const active = strip.querySelector('.ol-desktop-tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const isTabDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(DRAG_TYPE);

  // Drop on this pane: reorder within the pane, or take a tab from the other one.
  function handleDrop(e, beforeIndex) {
    let data = null;
    try {
      data = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
    } catch {
      return;
    }
    if (!data || !data.tab) return;
    if (data.pane === PANE) {
      const from = tabs.findIndex((t) => t.id === data.tab.id);
      if (from < 0) return;
      const [moved] = tabs.splice(from, 1);
      const to = beforeIndex < 0 ? tabs.length : Math.min(beforeIndex, tabs.length);
      tabs.splice(to, 0, moved);
      save();
      render();
      return;
    }
    if (!bridge) return;
    bridge.send('split:taken', data.tab.id);
    addTab({ id: data.tab.id, name: String(data.tab.name), folders: data.tab.folders || [], path: String(data.tab.path || data.tab.name) }, true);
  }

  strip.addEventListener('dragover', (e) => {
    if (isTabDrag(e)) e.preventDefault();
  });
  strip.addEventListener('drop', (e) => {
    e.preventDefault();
    handleDrop(e, -1);
  });

  // ----------------------------------------------------- context menu ---

  const menu = document.createElement('div');
  menu.className = 'ol-desktop-tab-menu';
  menu.hidden = true;
  const hideMenu = () => {
    menu.hidden = true;
  };
  window.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) hideMenu();
  });
  window.addEventListener('blur', hideMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });

  function showMenu(x, y, tab) {
    menu.textContent = '';
    const item = (label, fn, enabled = true) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.disabled = !enabled;
      b.addEventListener('click', () => {
        hideMenu();
        fn();
      });
      menu.appendChild(b);
    };
    if (bridge) item(otherPaneLabel(), () => moveTab(tab.id));
    item('Close', () => removeTab(tab.id));
    item('Close Others', () => {
      for (const t of tabs.slice()) if (t.id !== tab.id) removeTab(t.id);
    }, tabs.length > 1);
    if (!menu.isConnected) document.body.appendChild(menu);
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  }

  // ------------------------------------------------ main page layout ---

  // In the main page the editor column is: strip, editor, [divider, slot].
  // The slot is where the bottom pane's view is placed by the main process.
  const divider = document.createElement('div');
  divider.className = 'ol-desktop-split-divider';
  const slot = document.createElement('div');
  slot.className = 'ol-desktop-split-slot';
  const dropZone = document.createElement('div');
  dropZone.className = 'ol-desktop-split-dropzone';
  dropZone.textContent = 'Drop here to split';
  dropZone.hidden = true;

  let ratio = Number(localStorage.getItem(RATIO_KEY)) || 0.5;
  ratio = Math.min(0.85, Math.max(0.15, ratio));
  let holder = null;

  function applyRatio() {
    if (!holder) return;
    holder.style.flex = splitOpen ? `${ratio} 1 0` : '';
    slot.style.flex = `${1 - ratio} 1 0`;
  }

  function reportRect() {
    if (!bridge || PANE !== 1) return;
    if (!splitOpen || !slot.isConnected) {
      bridge.send('split:rect', null);
      return;
    }
    const r = slot.getBoundingClientRect();
    const shown = r.width > 0 && r.height > 0 && slot.offsetParent !== null;
    bridge.send('split:rect', shown ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
  }

  const observer = new ResizeObserver(() => reportRect());
  window.addEventListener('resize', reportRect);

  function setSplit(open) {
    splitOpen = open;
    divider.hidden = !open;
    slot.hidden = !open;
    applyRatio();
    render();
    requestAnimationFrame(reportRect);
  }

  function showDropZone(on) {
    dropZone.hidden = !on;
  }
  dropZone.addEventListener('dragover', (e) => {
    if (isTabDrag(e)) e.preventDefault();
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    showDropZone(false);
    let data = null;
    try {
      data = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
    } catch {
      return;
    }
    if (data && data.pane === PANE && data.tab) moveTab(data.tab.id);
  });

  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const panel = divider.parentElement;
    if (!panel) return;
    bridge.send('split:dragging', true);
    divider.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const top = holder.getBoundingClientRect().top;
      const bottom = slot.getBoundingClientRect().bottom;
      ratio = Math.min(0.85, Math.max(0.15, (ev.clientY - top) / (bottom - top)));
      applyRatio();
    };
    const onUp = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      localStorage.setItem(RATIO_KEY, String(ratio));
      bridge.send('split:dragging', false);
      requestAnimationFrame(reportRect);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
    divider.addEventListener('pointercancel', onUp);
  });

  if (bridge && PANE === 1) bridge.on('split:state', (s) => setSplit(!!(s && s.open)));

  // Keep the strip (and, in the main page, the split parts) around the
  // editor. Overleaf may re-render the panel, so this re-attaches whenever
  // something goes missing.
  function attach() {
    const editor = document.querySelector('.cm-editor');
    const h = editor && editor.parentElement;
    const panel = h && h.parentElement;
    if (!panel) return;
    if (strip.parentElement === panel && strip.nextElementSibling === h &&
        (PANE !== 1 || (slot.parentElement === panel && h.nextElementSibling === divider))) return;
    holder = h;
    panel.insertBefore(strip, h);
    panel.classList.add('ol-desktop-tabs-host');
    h.classList.add('ol-desktop-tabs-editor');
    if (PANE === 1) {
      h.after(divider, slot);
      h.style.position = h.style.position || 'relative';
      h.appendChild(dropZone);
      divider.hidden = !splitOpen;
      slot.hidden = !splitOpen;
      observer.disconnect();
      observer.observe(slot);
      observer.observe(panel);
      applyRatio();
      requestAnimationFrame(reportRect);
    }
    render();
  }

  // ------------------------------------------------------ bottom pane ---

  if (PANE === 2) {
    // Compile shortcuts compile in the main page, whose PDF is on screen.
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod || e.shiftKey || e.altKey) return;
        if (e.key === 'Enter' || e.key === 's' || e.key === 'S' || (e.ctrlKey && e.key === '.')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          bridge.send('split:compile');
        }
      },
      true
    );
  }

  // Once the editor and file tree exist: the main page reopens a split left
  // from last time, the bottom pane announces itself and shows its tab.
  let started = false;
  function onEditorReady() {
    if (started) return;
    if (!document.querySelector('.cm-editor') || !document.querySelector('[data-file-id]') || !storeGet('editor.open_doc_id')) return;
    started = true;
    if (PANE === 1) {
      if (bridge && load(2).tabs.length) bridge.send('split:restore');
    } else {
      bridge.send('split:ready');
      const tab = tabs.find((t) => t.id === activeId) || tabs[0];
      if (tab) openTab(tab);
    }
  }

  // ----------------------------------------------------------- style ---

  const style = document.createElement('style');
  style.textContent = `
    .ol-desktop-tabs-host { display: flex !important; flex-direction: column; }
    .ol-desktop-tabs-editor { flex: 1 1 auto; min-height: 0; }
    /* The tab strip names the open file, so Overleaf's file-name row is hidden. */
    .ol-desktop-tabs-host .ol-cm-breadcrumbs { display: none !important; }
    .ol-desktop-tabs-strip { flex: 0 0 auto; display: flex; overflow-x: auto; overflow-y: hidden; min-height: 26px;
      background: var(--bg-dark-secondary, #2f3a4c); scrollbar-width: thin; }
    .ol-desktop-tab { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; max-width: 240px;
      padding: 4px 4px 4px 12px; font: 13px system-ui, "Segoe UI", sans-serif; cursor: pointer;
      color: rgba(255,255,255,.7); border-right: 1px solid rgba(0,0,0,.25); user-select: none; }
    .ol-desktop-tab:hover { color: #fff; background: rgba(255,255,255,.06); }
    .ol-desktop-tab.active { color: #1b222c; background: #fff; box-shadow: inset 0 2px 0 #098842; }
    .ol-desktop-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 2px; }
    .ol-desktop-tab-hint { opacity: .6; }
    .ol-desktop-tab-btn { font: inherit; line-height: 1; border: 0; background: none; color: inherit;
      padding: 1px 4px; border-radius: 3px; opacity: .55; cursor: pointer; }
    .ol-desktop-tab-btn:hover { opacity: 1; background: rgba(128,128,128,.25); }
    .ol-desktop-tab-move { display: none; }
    .ol-desktop-tab:hover .ol-desktop-tab-move, .ol-desktop-tab.active .ol-desktop-tab-move { display: inline-block; }
    .ol-desktop-split-divider { flex: 0 0 5px; cursor: row-resize; background: var(--bg-dark-secondary, #2f3a4c); }
    .ol-desktop-split-divider:hover { background: #098842; }
    .ol-desktop-split-slot { min-height: 0; background: #fff; }
    .ol-desktop-split-divider[hidden], .ol-desktop-split-slot[hidden] { display: none !important; }
    .ol-desktop-split-dropzone { position: absolute; left: 0; right: 0; bottom: 0; height: 50%; z-index: 20;
      display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif;
      color: #098842; background: rgba(9,136,66,.10); border: 2px dashed #098842; }
    .ol-desktop-split-dropzone[hidden] { display: none; }
    .ol-desktop-tab-menu { position: fixed; z-index: 2147483600; min-width: 170px; padding: 4px 0;
      background: #fff; color: #1b222c; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      font: 13px system-ui, "Segoe UI", sans-serif; }
    .ol-desktop-tab-menu[hidden] { display: none; }
    .ol-desktop-tab-menu button { display: block; width: 100%; text-align: left; padding: 6px 14px;
      border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
    .ol-desktop-tab-menu button:hover:not(:disabled) { background: #eef6f1; }
    .ol-desktop-tab-menu button:disabled { opacity: .4; cursor: default; }
    /* Bottom pane: only the editor column is shown, filling the view. */
    html.ol-desktop-pane2 body { visibility: hidden; }
    html.ol-desktop-pane2 .ol-desktop-tabs-host { visibility: visible; position: fixed !important;
      inset: 0; z-index: 2147483000; background: #fff; }
    html.ol-desktop-pane2 .ol-desktop-tab-menu { visibility: visible; }
  `;

  const scan = () => {
    if (!style.isConnected && document.head) document.head.appendChild(style);
    // Overleaf may rewrite <html>'s classes, so this is re-applied on each scan.
    if (PANE === 2 && !document.documentElement.classList.contains('ol-desktop-pane2')) {
      document.documentElement.classList.add('ol-desktop-pane2');
    }
    attach();
    onEditorReady();
  };
  const start = () => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
