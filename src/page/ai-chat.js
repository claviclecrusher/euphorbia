// Runs in the Overleaf page. AI chat panel under File tree / File outline.
//
// - Ctrl+L in the editor adds the selected lines to the message being written,
//   as a one-slot link (file:lines) rather than pasted text; clicking it jumps
//   there. The text is sent to the model along with the message.
// - The model sees the whole project (indexed by the app, see
//   src/project-index.js) and answers in the panel. Changes come back as edit
//   blocks, which are put into the files as edits with diff (Accept / Reject).
// - The conversation is kept per project on this computer.
(() => {
  if (window.__overleafDesktopChat) return;
  window.__overleafDesktopChat = true;

  const PANE = window.__olDesktopPane || 0;
  const m = location.pathname.match(/^\/project\/([0-9a-f]{24})\/?$/);
  if (!PANE || !m) return;
  const projectId = m[1];
  const ai = window.overleafDesktop && window.overleafDesktop.ai;
  if (!ai) return;

  let CM = null; // CodeMirror objects from Overleaf
  let setHighlights = null;
  let highlightLine = null;
  const view = () => {
    try {
      return window.overleaf.unstable.store.get('editor.view');
    } catch {
      return null;
    }
  };
  const storeGet = (k) => {
    try {
      return window.overleaf.unstable.store.get(k);
    } catch {
      return null;
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v || Date.now() > end) return v;
      await sleep(60);
    }
  }

  // ------------------------------------------------------ file tree paths ---

  const entityName = (e) => {
    const n = e && (e.querySelector('.item-name-button span') || e.querySelector('.item-name-button'));
    return n ? n.textContent.trim() : '';
  };

  // Path of a rendered tree entity, from the folders above it.
  function pathOf(entity) {
    const parts = [entityName(entity)];
    let item = entity.closest('li[role="treeitem"]');
    while (item) {
      const list = item.parentElement && item.parentElement.closest('ul[role="tree"]');
      if (!list || list.classList.contains('file-tree-list')) break;
      const li = list.previousElementSibling;
      const folder = li && li.matches('li[role="treeitem"]') && li.querySelector(':scope > [data-file-type="folder"]');
      if (!folder) break;
      parts.unshift(entityName(folder));
      item = li;
    }
    return parts.join('/');
  }

  function currentPath() {
    const id = storeGet('editor.open_doc_id');
    const e = id && document.querySelector(`[data-file-id="${id}"]`);
    return e ? pathOf(e) : storeGet('editor.open_doc_name') || '';
  }

  // Opens a document by project path through the file tree, expanding folders.
  async function openPath(path) {
    if (currentPath() === path && view()) return true;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const want = parts.slice(0, i).join('/');
      const folder = await waitFor(
        () => Array.from(document.querySelectorAll('[data-file-type="folder"]')).find((f) => pathOf(f) === want),
        1500
      );
      if (!folder) return false;
      const li = folder.closest('li[role="treeitem"]');
      if (li && li.getAttribute('aria-expanded') === 'false') {
        const toggle = folder.querySelector('.folder-expand-collapse-button');
        if (toggle) toggle.click();
      }
    }
    const doc = await waitFor(
      () => Array.from(document.querySelectorAll('[data-file-type="doc"]')).find((d) => pathOf(d) === path),
      1500
    );
    if (!doc) return false;
    const id = doc.getAttribute('data-file-id');
    if (storeGet('editor.open_doc_id') !== id) (doc.querySelector('.item-name-button') || doc).click();
    const opened = await waitFor(() => storeGet('editor.open_doc_id') === id && view(), 8000);
    await sleep(150);
    return !!opened;
  }

  async function revealLines(path, startLine, endLine) {
    if (!(await openPath(path))) return false;
    const v = view();
    if (!v) return false;
    const doc = v.state.doc;
    const a = doc.line(Math.min(Math.max(1, startLine), doc.lines));
    const b = doc.line(Math.min(Math.max(1, endLine || startLine), doc.lines));
    v.dispatch({ selection: { anchor: a.from, head: b.to }, scrollIntoView: true });
    v.focus();
    return true;
  }

  // -------------------------------------------------------------- state ---

  // Conversations per project: { convs: [{ id, title, updatedAt, messages }], current }.
  // Each conversation is its own context: only its messages are sent.
  const KEY = `ol-desktop-chat:${projectId}`;
  const MAX_CONVS = 50;
  const newId = () => Math.random().toString(36).slice(2, 10);
  const titleOf = (msgs) => {
    const u = msgs.find((x) => x.role === 'user');
    return u ? u.content.replace(/\s+/g, ' ').slice(0, 60) : 'New chat';
  };
  let convs = [];
  let currentId = null;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(saved) && saved.length) {
      // 0.11 kept a single conversation as a plain array.
      convs = [{ id: newId(), title: titleOf(saved), updatedAt: Date.now(), messages: saved }];
      currentId = convs[0].id;
    } else if (saved && Array.isArray(saved.convs)) {
      convs = saved.convs.filter((c) => c && Array.isArray(c.messages));
      currentId = convs.some((c) => c.id === saved.current) ? saved.current : null;
    }
  } catch {
    /* ignore */
  }
  const currentConv = () => convs.find((c) => c.id === currentId) || null;
  // `messages` is the open conversation's list (a new, unsaved one until the first message).
  let messages = currentConv() ? currentConv().messages : [];
  const save = () => {
    const conv = currentConv();
    if (conv) {
      conv.updatedAt = Date.now();
      conv.messages = messages = messages.slice(-100);
    }
    convs.sort((a, b) => b.updatedAt - a.updatedAt);
    convs = convs.slice(0, MAX_CONVS);
    try {
      localStorage.setItem(KEY, JSON.stringify({ convs, current: currentId }));
    } catch {
      /* ignore */
    }
  };
  function openConv(id) {
    currentId = id;
    const conv = currentConv();
    messages = conv ? conv.messages : [];
    showingList = false;
    try {
      localStorage.setItem(KEY, JSON.stringify({ convs, current: currentId }));
    } catch {
      /* ignore */
    }
  }
  let showingList = false;
  let pendingRefs = [];
  let active = null; // { id, el, text }

  // -------------------------------------------------------------- Ctrl+L ---

  function refFromSelection(v) {
    const { state } = v;
    const sel = state.selection.main;
    const first = state.doc.lineAt(sel.from);
    let last = state.doc.lineAt(sel.to);
    if (sel.to > sel.from && sel.to === last.from && last.number > first.number) last = state.doc.line(last.number - 1);
    return {
      path: currentPath(),
      startLine: first.number,
      endLine: last.number,
      text: state.doc.sliceString(first.from, last.to).slice(0, 20000),
    };
  }

  function addRef(ref) {
    if (!ref || !ref.path) return;
    if (!pendingRefs.some((r) => r.path === ref.path && r.startLine === ref.startLine && r.endLine === ref.endLine)) {
      pendingRefs.push(ref);
    }
    setCollapsed(false);
    renderRefs();
    input.focus();
  }

  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      CM = event.detail.CodeMirror;
      const { keymap, Prec, Decoration, EditorView, StateEffect, StateField } = CM;
      // Search highlights: yellow lines, shown only to this user, never in the source.
      setHighlights = StateEffect.define();
      highlightLine = Decoration.line({ class: 'ol-searched-line' });
      event.detail.extensions.push(
        StateField.define({
          create: () => Decoration.none,
          update(value, tr) {
            let v = value.map(tr.changes);
            for (const e of tr.effects) if (e.is(setHighlights)) v = e.value;
            return v;
          },
          provide: (f) => EditorView.decorations.from(f),
        }),
        EditorView.baseTheme({
          '&light .ol-searched-line, &light .ol-searched-line.cm-activeLine': { background: 'rgba(255, 213, 0, 0.32)' },
          '&dark .ol-searched-line, &dark .ol-searched-line.cm-activeLine': { background: 'rgba(255, 213, 0, 0.22)' },
        })
      );
      event.detail.extensions.push(
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-l',
              preventDefault: true,
              run: (v) => {
                const ref = refFromSelection(v);
                if (PANE === 1) addRef(ref);
                else ai.sendRef(ref);
                return true;
              },
            },
          ])
        )
      );
    } catch (err) {
      console.error('[overleaf-desktop] chat shortcut failed to load', err);
    }
  });

  // File navigation for the edit review buttons in the editor.
  window.__olDesktopNav = { openPath, currentPath };

  if (PANE !== 1) return; // the bottom split pane only forwards Ctrl+L
  ai.onRef(addRef);

  // ------------------------------------------------------------- panel ---

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const panel = el('div', 'ol-chat');
  const handle = el('div', 'ol-chat-handle');
  const header = el('div', 'ol-chat-header');
  const toggle = el('button', 'ol-chat-icon ol-chat-toggle', '▾');
  toggle.title = 'Collapse';
  const title = el('span', 'ol-chat-title', 'AI Chat');
  const model = el('select', 'ol-chat-model');
  model.title = 'Model';
  const reindex = el('button', 'ol-chat-icon', '↻');
  reindex.title = 'Re-read the project now';
  const history = el('button', 'ol-chat-icon', '\u2630');
  history.title = 'Conversations';
  const newChat = el('button', 'ol-chat-icon', '+');
  newChat.title = 'New chat';
  header.append(toggle, title, model, reindex, history, newChat);
  const indexBar = el('div', 'ol-chat-index');
  const list = el('div', 'ol-chat-list');
  const status = el('div', 'ol-chat-status');
  const composer = el('div', 'ol-chat-composer');
  const refsRow = el('div', 'ol-chat-refs');
  const input = el('textarea', 'ol-chat-input');
  input.placeholder = 'Ask about the project or request a change. Ctrl+L adds the selected lines.';
  input.rows = 3;
  const send = el('button', 'ol-chat-send', 'Send');
  // Edit: the model may change the files. Read: it only reads and answers.
  // Search: it marks related places in the project (yellow, only on screen).
  const MODE_KEY = 'ol-desktop-chat-mode';
  const MODES = {
    edit: { label: '\u270e Edit', title: 'Edit mode: the AI may change the files (as edits to accept or reject).' },
    read: { label: '\u{1F441} Read', title: 'Read mode: the AI reads and answers but does not change anything.' },
    search: { label: '\u{1F50D} Search', title: 'Search mode: the AI marks the places related to your passage or question (same notation, experiments, theory, citations, references) in yellow.' },
  };
  const ORDER = ['edit', 'read', 'search'];
  const storedMode = localStorage.getItem(MODE_KEY);
  let mode = storedMode === 'write' ? 'edit' : MODES[storedMode] ? storedMode : 'edit';
  const modeBtn = el('button', 'ol-chat-mode');
  const showMode = () => {
    modeBtn.textContent = MODES[mode].label;
    modeBtn.title = `${MODES[mode].title} Click to switch.`;
    modeBtn.dataset.mode = mode;
  };
  modeBtn.addEventListener('click', () => {
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    localStorage.setItem(MODE_KEY, mode);
    showMode();
  });
  showMode();
  const actions = el('div', 'ol-chat-actions');
  actions.append(modeBtn, send);
  composer.append(refsRow, input, actions);
  panel.append(handle, header, indexBar, list, status, composer);
  for (const b of panel.querySelectorAll('button')) b.type = 'button';

  const HEIGHT_KEY = 'ol-desktop-chat-height';
  let height = Number(localStorage.getItem(HEIGHT_KEY)) || 340;
  let collapsed = localStorage.getItem('ol-desktop-chat-collapsed') === '1';

  function setCollapsed(c) {
    collapsed = c;
    panel.classList.toggle('collapsed', c);
    panel.style.height = c ? '' : `${height}px`;
    toggle.textContent = c ? '▸' : '▾';
    toggle.title = c ? 'Expand' : 'Collapse';
    localStorage.setItem('ol-desktop-chat-collapsed', c ? '1' : '0');
  }
  toggle.addEventListener('click', () => setCollapsed(!collapsed));
  title.addEventListener('click', () => setCollapsed(!collapsed));

  handle.addEventListener('pointerdown', (e) => {
    if (collapsed) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = height;
    const max = (panel.parentElement ? panel.parentElement.getBoundingClientRect().height : 800) - 120;
    const move = (ev) => {
      height = Math.min(max, Math.max(160, startH + (startY - ev.clientY)));
      panel.style.height = `${height}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      localStorage.setItem(HEIGHT_KEY, String(height));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  async function loadModels() {
    const info = await ai.info('chat');
    model.textContent = '';
    if (!info || !info.choices.length) {
      model.hidden = true;
      return false;
    }
    model.hidden = false;
    for (const c of info.choices) model.add(new Option(c.label, c.id, false, c.id === info.selected));
    return true;
  }
  model.addEventListener('change', () => ai.select('chat', model.value));
  model.addEventListener('focus', () => loadModels()); // pick up settings changes

  reindex.addEventListener('click', async () => {
    setStatus('Reading the project…');
    const res = await ai.reindex(projectId);
    setStatus(res && res.ok ? `Indexed ${res.files} file(s), ${Math.round(res.chars / 1000)}k characters.` : (res && res.error) || 'Indexing failed.');
  });

  // A new chat keeps the previous ones; it is saved once its first message is sent.
  newChat.addEventListener('click', () => {
    if (active) return;
    openConv(null);
    pendingRefs = [];
    render();
    renderRefs();
    setStatus('');
    input.focus();
  });

  history.addEventListener('click', () => {
    if (active) return;
    showingList = !showingList;
    render();
  });

  function renderConvList() {
    const head = el('div', 'ol-chat-list-head', convs.length ? 'Conversations' : 'No saved conversations yet.');
    list.appendChild(head);
    for (const c of convs.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      const row = el('div', 'ol-chat-conv' + (c.id === currentId ? ' current' : ''));
      const open = el('button', 'ol-chat-conv-open');
      open.type = 'button';
      open.appendChild(el('span', 'ol-chat-conv-title', c.title || 'Untitled'));
      const d = new Date(c.updatedAt);
      const p2 = (n) => String(n).padStart(2, '0');
      open.appendChild(el('span', 'ol-chat-conv-meta',
        `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} \u00b7 ${c.messages.length} message(s)`));
      open.addEventListener('click', () => {
        openConv(c.id);
        pendingRefs = [];
        render();
        renderRefs();
        setStatus('');
      });
      const del = el('button', 'ol-chat-conv-del', '\u00d7');
      del.type = 'button';
      del.title = 'Delete this conversation';
      del.addEventListener('click', () => {
        if (!window.confirm(`Delete "${c.title || 'Untitled'}"?`)) return;
        convs = convs.filter((x) => x !== c);
        if (currentId === c.id) openConv(null);
        showingList = true;
        save();
        render();
      });
      row.append(open, del);
      list.appendChild(row);
    }
  }

  // Background index status from the app.
  function renderIndex(st) {
    indexBar.textContent = '';
    indexBar.className = 'ol-chat-index';
    if (!st || st.projectId !== projectId) return;
    const units = st.units != null ? `${st.summarized}/${st.units} units summarized` : '';
    if (st.state === 'embedding') {
      indexBar.textContent = 'Indexing meaning for related-part search\u2026';
    } else if (st.state === 'summarizing') {
      indexBar.textContent = `Indexing: ${st.done}/${st.total} with ${st.model}\u2026`;
    } else if (st.state === 'ready') {
      indexBar.textContent = `Index ready \u00b7 ${st.files} files \u00b7 ${units}${st.related ? ' \u00b7 related search on' : ''}`;
    } else if (st.state === 'no-model') {
      indexBar.textContent = `Index without summaries (${st.files} files). `;
      const link = el('button', 'ol-chat-link', 'Choose a summary model');
      link.type = 'button';
      link.addEventListener('click', () => ai.openSettings());
      indexBar.appendChild(link);
    } else if (st.state === 'needs-approval') {
      indexBar.classList.add('ask');
      indexBar.append(
        `Summarizing ${st.estimate.units} parts of this project with ${st.model} needs about ${Math.round(st.estimate.tokens / 1000)}k tokens. `
      );
      const yes = el('button', 'ol-chat-btn', 'Summarize');
      const no = el('button', 'ol-chat-btn secondary', 'Not now');
      yes.type = no.type = 'button';
      yes.addEventListener('click', () => ai.indexApprove(projectId, true));
      no.addEventListener('click', () => ai.indexApprove(projectId, false));
      indexBar.append(yes, no);
    } else if (st.state === 'declined') {
      indexBar.textContent = `Summaries not made; the index shows first sentences. ${units}`;
    } else if (st.state === 'error') {
      indexBar.textContent = `Index: ${st.error}`;
      indexBar.classList.add('error');
    }
  }
  ai.onIndexStatus(renderIndex);
  ai.projectOpen(projectId);
  setInterval(() => ai.projectOpen(projectId), 2 * 60 * 1000);

  function setStatus(text, isError) {
    status.textContent = text || '';
    status.classList.toggle('error', !!isError);
  }

  // ----------------------------------------------------------- render ---

  const EDIT_RE = /<edit\s+file="([^"]+)"\s*>\s*<find>\n?([\s\S]*?)\n?<\/find>\s*<replace>\n?([\s\S]*?)\n?<\/replace>\s*<\/edit>/g;

  const HIGHLIGHT_RE = /<highlight\s+([^>]*?)\/?>(?:\s*<\/highlight>)?/g;
  const attrOf = (s, k) => (s.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';

  // Highlight tags in an answer: [{ path, start, end, kind, note }].
  function parseHighlights(text) {
    const out = [];
    for (const m of String(text).matchAll(HIGHLIGHT_RE)) {
      const lines = attrOf(m[1], 'lines').match(/(\d+)(?:\s*-\s*(\d+))?/);
      const path = attrOf(m[1], 'file');
      if (!path || !lines) continue;
      const start = Number(lines[1]);
      const end = Math.max(start, Number(lines[2] || lines[1]));
      out.push({ path, start, end, kind: attrOf(m[1], 'kind') || 'related', note: attrOf(m[1], 'note') });
    }
    return out;
  }

  function parseEdits(text) {
    const edits = [];
    const clean = text.replace(/```[\w-]*\n(\s*<edit[\s\S]*?<\/edit>\s*)\n?```/g, '$1');
    let last = 0;
    const parts = [];
    let mm;
    EDIT_RE.lastIndex = 0;
    while ((mm = EDIT_RE.exec(clean))) {
      if (mm.index > last) parts.push({ text: clean.slice(last, mm.index) });
      parts.push({ edit: edits.length });
      edits.push({ file: mm[1], find: mm[2], replace: mm[3] });
      last = EDIT_RE.lastIndex;
    }
    if (last < clean.length) parts.push({ text: clean.slice(last) });
    return { parts, edits };
  }

  function chip(ref, removable) {
    const c = el('span', 'ol-chat-ref');
    const name = ref.path.split('/').pop();
    const label = el('button', 'ol-chat-ref-link', `${name}:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}`);
    label.type = 'button';
    label.title = `${ref.path}, lines ${ref.startLine}-${ref.endLine}\n${ref.text.slice(0, 300)}`;
    label.addEventListener('click', () => revealLines(ref.path, ref.startLine, ref.endLine));
    c.appendChild(label);
    if (removable) {
      const x = el('button', 'ol-chat-ref-x', '×');
      x.type = 'button';
      x.title = 'Remove';
      x.addEventListener('click', () => {
        pendingRefs = pendingRefs.filter((r) => r !== ref);
        renderRefs();
      });
      c.appendChild(x);
    }
    return c;
  }

  function renderRefs() {
    refsRow.textContent = '';
    for (const r of pendingRefs) refsRow.appendChild(chip(r, true));
    refsRow.hidden = !pendingRefs.length;
  }

  function textNode(text) {
    const t = el('div', 'ol-chat-text');
    t.textContent = text.replace(/^\n+|\n+$/g, '');
    return t;
  }

  function editCard(edit, state) {
    const card = el('div', 'ol-chat-edit');
    const head = el('div', 'ol-chat-edit-head');
    const name = el('button', 'ol-chat-ref-link', `✎ ${edit.file}${state && state.line ? `:${state.line}` : ''}`);
    name.type = 'button';
    name.addEventListener('click', async () => {
      if (state && state.line) return revealLines(edit.file, state.line, state.line);
      await openPath(edit.file);
      if (state && state.proposalId && window.__olDesktopEdits) setTimeout(() => window.__olDesktopEdits.revealProposal(state.proposalId), 150);
    });
    const st = el('span', 'ol-chat-edit-state');
    if (!state) st.textContent = 'pending';
    else if (state.ok) st.textContent = state.proposalId ? 'suggested (only you see it until you accept)' : 'added for review';
    else st.textContent = state.error || 'not applied';
    st.classList.toggle('ok', !!(state && state.ok));
    st.classList.toggle('error', !!(state && !state.ok));
    head.append(name, st);
    card.appendChild(head);
    // No retry for edits blocked on purpose (read-only mode, .bib files).
    const blocked = /\.bib$/i.test(edit.file) || (state && /read-only/.test(state.error || ''));
    if (state && !state.ok && !blocked) {
      const retry = el('button', 'ol-chat-retry', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => applyOne(edit, state, card));
      head.appendChild(retry);
    }
    return card;
  }

  function renderMessage(msg) {
    const box = el('div', `ol-chat-msg ${msg.role}`);
    if (msg.role === 'user') {
      if (msg.refs && msg.refs.length) {
        const refs = el('div', 'ol-chat-refs');
        for (const r of msg.refs) refs.appendChild(chip(r, false));
        box.appendChild(refs);
      }
      box.appendChild(textNode(msg.content));
      return box;
    }
    if (msg.by) box.appendChild(el('div', 'ol-chat-by', msg.by));
    const hits = Array.isArray(msg.hits) ? msg.hits : parseHighlights(msg.content);
    const legacy = parseEdits(msg.content.replace(HIGHLIGHT_RE, '').replace(/\n{3,}/g, '\n\n'));
    // Answers from v0.15 on carry their edits as checked proposals; older ones as text.
    const parts = Array.isArray(msg.proposals)
      ? [{ text: msg.content }, ...msg.proposals.map((_, i) => ({ edit: i }))]
      : legacy.parts;
    const edits = Array.isArray(msg.proposals) ? msg.proposals : legacy.edits;
    for (const p of parts) {
      if (p.text != null) {
        if (p.text.trim()) box.appendChild(textNode(p.text));
      } else {
        box.appendChild(editCard(edits[p.edit], (msg.edits || [])[p.edit]));
      }
    }
    if (hits.length) {
      const wrap = el('div', 'ol-chat-hits');
      hits.forEach((h, i) => {
        const row = el('div', 'ol-chat-hit');
        const link = el('button', 'ol-chat-ref-link', `${h.path}:${h.start}${h.end !== h.start ? `-${h.end}` : ''}`);
        link.type = 'button';
        link.addEventListener('click', () => {
          showSearched(hits, i);
        });
        row.append(el('span', 'ol-chat-hit-kind', h.kind), link);
        if (h.note) row.appendChild(el('span', 'ol-chat-hit-note', h.note));
        wrap.appendChild(row);
      });
      const again = el('button', 'ol-chat-retry', 'Highlight these again');
      again.type = 'button';
      again.addEventListener('click', () => showSearched(hits, 0));
      wrap.appendChild(again);
      box.appendChild(wrap);
    }
    return box;
  }

  function render() {
    list.textContent = '';
    history.classList.toggle('on', showingList);
    if (showingList) {
      renderConvList();
      return;
    }
    if (!messages.length) {
      list.appendChild(el('div', 'ol-chat-empty', 'Ask about this project or ask for a change. Select lines and press Ctrl+L to point at them.'));
    }
    for (const msg of messages) list.appendChild(renderMessage(msg));
    list.scrollTop = list.scrollHeight;
  }

  // ------------------------------------------------------------ sending ---

  function setBusy(busy) {
    send.textContent = busy ? 'Stop' : 'Send';
    send.classList.toggle('stop', busy);
    model.disabled = busy;
    modeBtn.disabled = busy;
    newChat.disabled = busy;
    history.disabled = busy;
  }

  function submit() {
    if (active) {
      ai.chatCancel(active.id);
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    if (model.hidden || !model.value) {
      setStatus('No AI model is set up yet. Open File > AI Settings.', true);
      return;
    }
    if (!currentConv()) {
      const conv = { id: newId(), title: text.replace(/\s+/g, ' ').slice(0, 60), updatedAt: Date.now(), messages: [] };
      convs.unshift(conv);
      currentId = conv.id;
      messages = conv.messages;
    }
    showingList = false;
    messages.push({ role: 'user', content: text, refs: pendingRefs.slice(), mode });
    pendingRefs = [];
    input.value = '';
    renderRefs();
    save();
    render();
    const v = view();
    const id = Math.random().toString(36).slice(2, 10);
    const bubble = el('div', 'ol-chat-msg assistant streaming');
    const body = el('div', 'ol-chat-text');
    bubble.appendChild(body);
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
    active = { id, el: bubble, body, text: '', conv: currentId, mode };
    setBusy(true);
    ai.chatStart({
      requestId: id,
      choiceId: model.value,
      projectId,
      history: messages.map((mm) => ({ role: mm.role, content: mm.content, refs: mm.refs, mode: mm.mode, proposals: mm.proposals, hits: mm.hits })),
      mode,
      openDoc: v ? { path: currentPath(), text: v.state.doc.toString() } : null,
    });
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  ai.onChatEvent(async (ev) => {
    if (!active || ev.id !== active.id) return;
    if (ev.type === 'status') {
      setStatus(ev.text + (ev.omitted ? ` (${ev.omitted} large file(s) given as outline only)` : ''));
    } else if (ev.type === 'notice') {
      setStatus(ev.text, true);
    } else if (ev.type === 'usage') {
      active.used = ev.used;
      setStatus(`${Math.round(ev.used / 1000)}k tokens so far${ev.cached ? ` (${Math.round(ev.cached / 1000)}k from cache)` : ''}`);
    } else if (ev.type === 'pause') {
      const ask = el('div', 'ol-chat-pause');
      ask.append(
        `This request has used ${Math.round(ev.used / 1000)}k tokens; the next step needs about ${Math.round(ev.next / 1000)}k more (limit ${Math.round(ev.limit / 1000)}k). `
      );
      const go = el('button', 'ol-chat-btn', 'Continue');
      const stop = el('button', 'ol-chat-btn secondary', 'Stop');
      go.type = stop.type = 'button';
      const answer = (yes) => {
        ask.remove();
        ai.chatContinue(ev.id, yes);
      };
      go.addEventListener('click', () => answer(true));
      stop.addEventListener('click', () => answer(false));
      ask.append(go, stop);
      active.el.appendChild(ask);
      list.scrollTop = list.scrollHeight;
      setStatus('Paused: waiting for your answer.');
    } else if (ev.type === 'delta') {
      active.text += ev.text;
      // Edit blocks are shown as cards once complete; while streaming, hide them.
      const cut = active.text.search(/<edit\s/);
      active.body.textContent = cut >= 0 ? `${active.text.slice(0, cut)}\n✎ preparing edits…` : active.text;
      list.scrollTop = list.scrollHeight;
      setStatus('');
    } else if (ev.type === 'error') {
      active.el.remove();
      active = null;
      setBusy(false);
      setStatus(ev.text, true);
      render();
    } else if (ev.type === 'done') {
      const msg = { role: 'assistant', content: ev.text, by: ev.by, edits: [], mode: active.mode, proposals: ev.proposals || [], hits: ev.hits || [] };
      const conv = convs.find((c) => c.id === active.conv);
      if (conv) conv.messages.push(msg);
      active = null;
      setBusy(false);
      save();
      render();
      await applyEdits(msg);
    }
  });

  // ----------------------------------------------------------- searched ---
  //
  // Places marked by a search answer, highlighted in yellow in whichever file
  // is open, with a yellow bar above the editor while the state is on.

  let searched = null; // { hits, at }
  const bar = el('div', 'ol-searched-bar');
  bar.hidden = true;
  const barText = el('span', 'ol-searched-text');
  const barPrev = el('button', '', '\u2039');
  const barPos = el('span', '');
  const barNext = el('button', '', '\u203a');
  const barClose = el('button', 'ol-searched-close', '\u00d7');
  barPrev.type = barNext.type = barClose.type = 'button';
  barPrev.title = 'Previous place';
  barNext.title = 'Next place';
  barClose.title = 'Turn the search highlights off';
  bar.append(barText, barPrev, barPos, barNext, barClose);
  barClose.addEventListener('click', () => clearSearched());
  barPrev.addEventListener('click', () => goSearched(searched.at - 1));
  barNext.addEventListener('click', () => goSearched(searched.at + 1));

  function paintSearched() {
    const v = view();
    if (!v || !setHighlights) return;
    if (!searched) {
      v.dispatch({ effects: setHighlights.of(CM.Decoration.none) });
      return;
    }
    const path = currentPath();
    const doc = v.state.doc;
    const ranges = [];
    for (const h of searched.hits) {
      if (h.path !== path) continue;
      for (let n = Math.max(1, h.start); n <= Math.min(h.end, doc.lines); n++) ranges.push(highlightLine.range(doc.line(n).from));
    }
    ranges.sort((a, b) => a.from - b.from);
    const unique = ranges.filter((r, i) => i === 0 || r.from !== ranges[i - 1].from);
    v.dispatch({ effects: setHighlights.of(CM.Decoration.set(unique)) });
  }

  function renderBar() {
    bar.hidden = !searched;
    if (!searched) return;
    const files = new Set(searched.hits.map((h) => h.path)).size;
    barText.textContent = `\u{1F50D} Searched: ${searched.hits.length} place(s) in ${files} file(s)`;
    barPos.textContent = `${searched.at + 1}/${searched.hits.length}`;
    barPrev.disabled = searched.at <= 0;
    barNext.disabled = searched.at >= searched.hits.length - 1;
  }

  async function goSearched(i) {
    if (!searched || i < 0 || i >= searched.hits.length) return;
    searched.at = i;
    renderBar();
    const h = searched.hits[i];
    await revealLines(h.path, h.start, h.end);
    paintSearched();
  }

  function showSearched(hits, at) {
    searched = { hits, at: 0 };
    renderBar();
    paintSearched();
    goSearched(at || 0);
  }

  function clearSearched() {
    searched = null;
    renderBar();
    paintSearched();
  }

  // Repaint when another file opens.
  window.addEventListener('doc:after-opened', () => setTimeout(paintSearched, 120));

  // The bar sits right above the editor (below the tab strip, if any).
  function attachBar() {
    const editor = document.querySelector('.cm-editor');
    const holder = editor && editor.parentElement;
    const host = holder && holder.parentElement;
    if (!host) return;
    if (bar.parentElement === host && bar.nextElementSibling === holder) return;
    host.insertBefore(bar, holder);
    if (getComputedStyle(host).display !== 'flex') {
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      holder.style.flex = holder.style.flex || '1 1 auto';
      holder.style.minHeight = '0';
    }
  }

  // ----------------------------------------------------------- applying ---

  async function applyOne(edit, state, card) {
    // Bibliography files are read-only for the AI, whatever it writes.
    if (/\.bib$/i.test(edit.file)) {
      Object.assign(state, { ok: false, error: 'not applied (.bib files are read-only for the AI)', line: null, locked: true });
      save();
      if (card) render();
      return false;
    }
    // AI edits become suggestions kept on this computer until accepted.
    const res = window.__olDesktopEdits
      ? window.__olDesktopEdits.addProposal({ file: edit.file, find: edit.find, replace: edit.replace, by: state.by || 'AI' })
      : { ok: false, error: 'Editor not ready.' };
    if (res.ok) state.proposalId = res.id;
    Object.assign(state, { ok: res.ok, error: res.error || null, line: null });
    save();
    if (card) render();
    return res.ok;
  }

  async function applyEdits(msg) {
    if (msg.mode === 'search') {
      const hits = Array.isArray(msg.hits) ? msg.hits : parseHighlights(msg.content);
      if (hits.length) showSearched(hits, 0);
      else setStatus('No related places were marked.');
    }
    const edits = Array.isArray(msg.proposals) ? msg.proposals : parseEdits(msg.content.replace(HIGHLIGHT_RE, '')).edits;
    if (!edits.length) return;
    if (msg.mode === 'read' || msg.mode === 'search') {
      // Read and search modes never touch the files, even if the model wrote edits anyway.
      msg.edits = edits.map(() => ({ ok: false, error: `not applied (${msg.mode} mode, read-only)` }));
      save();
      render();
      return;
    }
    const back = currentPath();
    setStatus(`Adding ${edits.length} edit(s) to the files…`);
    msg.edits = edits.map(() => ({ by: msg.by }));
    let applied = 0;
    for (let i = 0; i < edits.length; i++) {
      if (await applyOne(edits[i], msg.edits[i])) applied++;
    }
    save();
    render();
    // Go back to where the user was, unless all edits are in one other file.
    const files = new Set(edits.map((e) => e.file));
    if (back && !(files.size === 1 && !files.has(back))) await openPath(back);
    setStatus(
      applied === edits.length
        ? `${applied} edit(s) added. Review them with Accept / Reject in the editor.`
        : `${applied} of ${edits.length} edit(s) added; see the notes above.`,
      applied !== edits.length
    );
  }

  // ------------------------------------------------------------ mount ---

  // Below the File tree / File outline group, in the same column.
  function attach() {
    const group = document.querySelector('.file-tree-outline-panel-group');
    const host = group && group.parentElement;
    if (!host) return;
    if (panel.parentElement === host && group.nextElementSibling === panel) return;
    host.classList.add('ol-chat-host');
    group.classList.add('ol-chat-group');
    group.after(panel);
    setCollapsed(collapsed);
    render();
    renderRefs();
    loadModels();
  }

  const style = el('style');
  style.textContent = `
    .ol-chat-host { display: flex !important; flex-direction: column; }
    .ol-chat-host > .ol-chat-group { flex: 1 1 auto; min-height: 80px; }
    .ol-chat { flex: 0 0 auto; display: flex; flex-direction: column; min-height: 0;
      background: var(--bg-dark-primary, #1b222c); color: var(--content-primary-dark, #e7e9ee);
      font: 12px system-ui, "Segoe UI", sans-serif; border-top: 1px solid rgba(255,255,255,.12); }
    .ol-chat.collapsed .ol-chat-list, .ol-chat.collapsed .ol-chat-status, .ol-chat.collapsed .ol-chat-composer,
    .ol-chat.collapsed .ol-chat-model, .ol-chat.collapsed .ol-chat-handle { display: none; }
    .ol-chat-handle { flex: 0 0 4px; cursor: row-resize; }
    .ol-chat-handle:hover { background: #098842; }
    .ol-chat-header { display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 4px; }
    .ol-chat-title { font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .ol-chat-model { flex: 1; min-width: 0; font: inherit; font-size: 11px; color: inherit; background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.18); border-radius: 4px; padding: 1px 2px; }
    .ol-chat-model option { color: #1b222c; }
    .ol-chat-icon { font: inherit; font-size: 13px; line-height: 1; color: inherit; background: none; border: 0; border-radius: 4px;
      padding: 3px 5px; cursor: pointer; opacity: .75; }
    .ol-chat-icon:hover { opacity: 1; background: rgba(255,255,255,.1); }
    .ol-chat-icon.on { opacity: 1; background: rgba(9,136,66,.5); }
    .ol-chat-list-head { font-size: 11px; opacity: .6; padding: 4px 2px; }
    .ol-chat-conv { display: flex; align-items: stretch; border-radius: 6px; margin: 2px 0; }
    .ol-chat-conv:hover { background: rgba(255,255,255,.07); }
    .ol-chat-conv.current { background: rgba(9,136,66,.22); }
    .ol-chat-conv-open { flex: 1; min-width: 0; text-align: left; font: inherit; color: inherit; background: none; border: 0; padding: 5px 6px; cursor: pointer; }
    .ol-chat-conv-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ol-chat-conv-meta { display: block; font-size: 10px; opacity: .55; }
    .ol-chat-conv-del { font: inherit; color: inherit; background: none; border: 0; padding: 0 8px; cursor: pointer; opacity: .5; }
    .ol-chat-conv-del:hover { opacity: 1; }
    .ol-chat-list { flex: 1 1 auto; overflow-y: auto; padding: 4px 6px; min-height: 0; }
    .ol-chat-empty { opacity: .6; padding: 8px 2px; line-height: 1.4; }
    .ol-chat-msg { margin: 6px 0; padding: 6px 8px; border-radius: 6px; line-height: 1.45; }
    .ol-chat-msg.user { background: rgba(9,136,66,.22); }
    .ol-chat-msg.assistant { background: rgba(255,255,255,.06); }
    .ol-chat-msg.streaming { opacity: .9; }
    .ol-chat-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .ol-chat-by { font-size: 10px; opacity: .55; margin-bottom: 2px; }
    .ol-chat-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
    .ol-chat-ref { display: inline-flex; align-items: center; border-radius: 10px; background: rgba(15,111,197,.35); }
    .ol-chat-ref-link { font: inherit; font-size: 11px; color: inherit; background: none; border: 0; padding: 1px 7px; cursor: pointer;
      max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ol-chat-ref-link:hover { text-decoration: underline; }
    .ol-chat-ref-x { font: inherit; color: inherit; background: none; border: 0; padding: 0 5px 0 0; cursor: pointer; opacity: .7; }
    .ol-chat-edit { margin: 4px 0; padding: 4px 6px; border-left: 3px solid #098842; background: rgba(9,136,66,.12); border-radius: 3px; }
    .ol-chat-edit-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .ol-chat-edit .ol-chat-ref-link { padding: 0; max-width: 100%; }
    .ol-chat-edit-state { font-size: 10px; opacity: .75; }
    .ol-chat-edit-state.ok { color: #5fd38d; opacity: 1; }
    .ol-chat-edit-state.error { color: #ff8a80; opacity: 1; }
    .ol-chat-retry { font: inherit; font-size: 10px; color: inherit; background: rgba(255,255,255,.12); border: 0; border-radius: 8px; padding: 1px 6px; cursor: pointer; }
    .ol-chat-index { flex: 0 0 auto; padding: 1px 8px 3px; font-size: 10px; opacity: .65; }
    .ol-chat-index:empty { display: none; }
    .ol-chat-index.ask { opacity: 1; font-size: 11px; background: rgba(255,193,7,.15); padding: 5px 8px; }
    .ol-chat-index.error { color: #ff8a80; opacity: 1; }
    .ol-chat-link { font: inherit; color: #7cc4ff; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
    .ol-chat-btn { font: inherit; font-size: 11px; border: 0; border-radius: 10px; padding: 2px 10px; margin: 3px 4px 0 0; background: #098842; color: #fff; cursor: pointer; }
    .ol-chat-btn.secondary { background: rgba(255,255,255,.18); }
    .ol-chat-pause { margin-top: 6px; padding: 6px; border-radius: 4px; background: rgba(255,193,7,.15); font-size: 11px; }
    .ol-chat.collapsed .ol-chat-index { display: none; }
    .ol-chat-status { flex: 0 0 auto; padding: 2px 8px; font-size: 11px; opacity: .7; }
    .ol-chat-status:empty { display: none; }
    .ol-chat-status.error { color: #ff8a80; opacity: 1; }
    .ol-chat-composer { flex: 0 0 auto; padding: 4px 6px 6px; display: flex; flex-direction: column; gap: 4px; }
    .ol-chat-composer .ol-chat-refs { margin: 0; }
    .ol-chat-input { width: 100%; box-sizing: border-box; resize: none; font: inherit; color: #1b222c; background: #fff;
      border: 1px solid transparent; border-radius: 6px; padding: 5px 7px; }
    .ol-chat-input:focus { outline: none; border-color: #098842; }
    .ol-chat-actions { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
    .ol-chat-mode { font: inherit; font-size: 11px; color: inherit; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
      border-radius: 14px; padding: 2px 0; cursor: pointer; white-space: nowrap; width: 84px; flex: 0 0 84px; text-align: center; overflow: hidden; }
    .ol-chat-mode[data-mode="read"] { background: rgba(15,111,197,.35); border-color: rgba(15,111,197,.7); }
    .ol-chat-mode[data-mode="search"] { background: rgba(255,193,7,.3); border-color: rgba(255,193,7,.8); }
    .ol-chat-hits { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; }
    .ol-chat-hit { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; padding: 3px 6px; border-left: 3px solid #ffc107;
      background: rgba(255,193,7,.1); border-radius: 3px; }
    .ol-chat-hit .ol-chat-ref-link { padding: 0; max-width: 100%; }
    .ol-chat-hit-kind { font-size: 10px; text-transform: uppercase; opacity: .7; }
    .ol-chat-hit-note { font-size: 11px; opacity: .85; width: 100%; }
    .ol-searched-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 3px 10px; background: #ffd500; color: #1b222c;
      font: 12px system-ui, "Segoe UI", sans-serif; }
    .ol-searched-bar[hidden] { display: none; }
    .ol-searched-bar .ol-searched-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ol-searched-bar button { font: inherit; border: 0; background: rgba(0,0,0,.08); border-radius: 4px; padding: 0 7px; cursor: pointer; color: inherit; }
    .ol-searched-bar button:disabled { opacity: .35; cursor: default; }
    .ol-searched-bar .ol-searched-close { background: none; font-size: 15px; line-height: 1; padding: 0 4px; }
    .ol-chat-send { font: inherit; border: 0; border-radius: 14px; padding: 3px 14px; background: #098842; color: #fff; cursor: pointer; }
    .ol-chat-send.stop { background: #b83a33; }
    .ol-chat button:disabled, .ol-chat select:disabled { opacity: .4; cursor: default; }
  `;

  const scan = () => {
    if (!style.isConnected && document.head) document.head.appendChild(style);
    attach();
    attachBar();
  };
  const start = () => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
