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
  if (window.__euphorbiaChat) return;
  window.__euphorbiaChat = true;

  const PANE = window.__olDesktopPane || 0;
  const m = location.pathname.match(/^\/project\/([0-9a-f]{24})\/?$/);
  if (!PANE || !m) return;
  const projectId = m[1];
  const ai = window.euphorbia && window.euphorbia.ai;
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
    if (typeof linkedRow !== 'undefined') renderLinked();
    try {
      localStorage.setItem(KEY, JSON.stringify({ convs, current: currentId }));
    } catch {
      /* ignore */
    }
  }
  let showingList = false;
  let pendingRefs = [];
  // Other projects this conversation refers to: [{ id, name }] (kept on the
  // conversation; for a new chat until its first message).
  let pendingLinked = [];
  const linkedOf = () => (currentConv() ? currentConv().linked || [] : pendingLinked);
  const setLinked = (list) => {
    if (currentConv()) {
      currentConv().linked = list;
      save();
    } else pendingLinked = list;
    renderLinked();
  };
  let active = null; // { id, el, text }

  // -------------------------------------------------------------- Ctrl+L ---

  // The selected lines as a reference, or null when nothing is selected
  // (Ctrl+L then only opens the AI Chat tab for typing).
  function refFromSelection(v) {
    const { state } = v;
    const sel = state.selection.main;
    if (sel.empty) return null;
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
    if (ref && !ref.path) return;
    if (ref && !pendingRefs.some((r) => r.path === ref.path && r.startLine === ref.startLine && r.endLine === ref.endLine)) {
      pendingRefs.push(ref);
    }
    setCollapsed(false);
    // Ctrl+L / Add to AI Chat brings the AI Chat tab up.
    if (!(aiOn && panelOpen())) railTab.click();
    renderRefs();
    input.focus();
  }

  // Right-click menu: add the selected lines to the chat (as Ctrl+L does).
  // ----------------------------------------------------- find citations ---
  // On the selected block: claims that need a citation and real papers for
  // them (OpenAlex), shown in the AI Chat. The paper's index is the context;
  // the citations are for the block only.
  let citing = null;
  window.__euphorbiaCite = () => {
    if (PANE !== 1) return false;
    const v = view();
    if (!v || citing) return false;
    const ref = refFromSelection(v);
    if (!ref) {
      setStatus('Select the text to find citations for.', true);
      return true;
    }
    if (!(aiOn && panelOpen())) railTab.click();
    if (!currentConv()) {
      const conv = { id: newId(), title: `Find citations: ${ref.path}:${ref.startLine}`, updatedAt: Date.now(), messages: [], linked: pendingLinked };
      pendingLinked = [];
      convs.unshift(conv);
      currentId = conv.id;
      messages = conv.messages;
    }
    messages.push({ role: 'user', content: 'Find citations for the selected text.', refs: [ref], mode: 'read', cite: true });
    save();
    render();
    const d = v.state.doc;
    const first = d.line(ref.startLine);
    const last = d.line(ref.endLine);
    citing = { id: Math.random().toString(36).slice(2, 10), ref };
    setBusy(true);
    setStatus('Finding citations…');
    ai.cite({
      requestId: citing.id,
      projectId,
      choiceId: model.value,
      file: ref.path,
      block: ref.text,
      before: d.sliceString(d.line(Math.max(1, first.number - 30)).from, first.from),
      after: d.sliceString(last.to, d.line(Math.min(d.lines, last.number + 15)).to),
    });
    return true;
  };
  ai.onCiteEvent((ev) => {
    if (!citing || ev.id !== citing.id) return;
    if (ev.type === 'status') return setStatus(ev.text);
    const ref = citing.ref;
    citing = null;
    setBusy(false);
    if (ev.type === 'error') {
      setStatus(ev.text, true);
      return;
    }
    const n = ev.claims.reduce((k, c) => k + c.papers.length, 0);
    const text = ev.claims.length
      ? `${ev.claims.length} statement(s) in ${ref.path}:${ref.startLine}-${ref.endLine} could use a citation; ${n} paper(s) found on OpenAlex.`
      : `Nothing in ${ref.path}:${ref.startLine}-${ref.endLine} seems to need a citation.`;
    messages.push({ role: 'assistant', content: text, by: ev.by, mode: 'read', cites: { file: ref.path, claims: ev.claims, bib: (ev.bibFiles && ev.bibFiles[0]) || (ev.allBib && ev.allBib[0]) || '' } });
    save();
    render();
    setStatus('');
  });

  // Adds \cite{key} after the statement (inside an existing \cite when one
  // follows it) and, for a paper not in the .bib yet, its BibTeX entry.
  async function addCitation(file, quote, paper, bibFile) {
    if (!paper.inBib) {
      if (!bibFile) return 'No .bib file in the project; copy the BibTeX instead.';
      if (!(await openPath(bibFile))) return `Could not open ${bibFile}.`;
      const vb = view();
      if (!vb) return 'The editor is not ready.';
      if (!vb.state.doc.toString().includes(`{${paper.key},`)) {
        const end = vb.state.doc.length;
        vb.dispatch({ changes: { from: end, insert: `${end && !vb.state.doc.toString().endsWith('\n') ? '\n' : ''}\n${paper.bibtex}\n` } });
      }
      paper.inBib = true;
    }
    if (!(await openPath(file))) return `Could not open ${file}.`;
    const v = view();
    const all = v.state.doc.toString();
    const i = all.indexOf(quote);
    if (i < 0) return 'The statement is no longer in the file.';
    let at = i + quote.length;
    const rest = all.slice(at, at + 200);
    const m = /^\s*~?\\cite[pt]?\{([^}]*)\}/.exec(rest);
    if (m) {
      if (m[1].split(',').map((x) => x.trim()).includes(paper.key)) return 'Already cited there.';
      at += m.index + m[0].length - 1;
      v.dispatch({ changes: { from: at, insert: `, ${paper.key}` }, selection: { anchor: at }, scrollIntoView: true });
    } else {
      // before the sentence's closing punctuation when the quote ends there
      if (/[.;:,]$/.test(quote)) at -= 1;
      v.dispatch({ changes: { from: at, insert: `~\\cite{${paper.key}}` }, selection: { anchor: at }, scrollIntoView: true });
    }
    return '';
  }

  function citeCards(msg) {
    const wrap = el('div', 'ol-cite');
    const { file, claims, bib } = msg.cites;
    claims.forEach((c) => {
      const box = el('div', 'ol-cite-claim');
      const q = el('button', 'ol-chat-ref-link ol-cite-quote', `\u201c${c.quote.length > 140 ? c.quote.slice(0, 140) + '\u2026' : c.quote}\u201d`);
      q.type = 'button';
      q.title = c.why;
      q.addEventListener('click', async () => {
        if (!(await openPath(file))) return;
        const v = view();
        const i = v.state.doc.toString().indexOf(c.quote);
        if (i >= 0) { v.dispatch({ selection: { anchor: i, head: i + c.quote.length }, scrollIntoView: true }); v.focus(); }
      });
      box.appendChild(q);
      if (c.why) box.appendChild(el('div', 'ol-cite-why', c.why));
      if (!c.papers.length) box.appendChild(el('div', 'ol-cite-none', 'No fitting paper among the search results.'));
      for (const p of c.papers) {
        const row = el('div', 'ol-cite-paper');
        const t = el('a', 'ol-cite-title', p.title);
        t.href = p.doi ? `https://doi.org/${p.doi}` : p.id;
        t.target = '_blank';
        row.appendChild(t);
        row.appendChild(el('div', 'ol-cite-meta', `${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ' et al.' : ''} \u00b7 ${p.year}${p.venue ? ` \u00b7 ${p.venue}` : ''} \u00b7 cited ${p.cites}`));
        if (p.why) row.appendChild(el('div', 'ol-cite-why', p.why));
        const actions = el('div', 'ol-cite-actions');
        const add = el('button', 'ol-cite-btn', p.inBib ? `Cite (${p.key})` : `Add to ${bib ? bib.split('/').pop() : '.bib'} & cite`);
        add.type = 'button';
        add.title = p.inBib ? `Insert \\cite{${p.key}} after the statement` : `Append its BibTeX entry to ${bib || 'the .bib file'} and insert \\cite{${p.key}} after the statement`;
        add.addEventListener('click', async () => {
          add.disabled = true;
          const err = await addCitation(file, c.quote, p, bib);
          if (err) { setStatus(err, true); add.disabled = false; return; }
          add.textContent = '\u2713 cited';
          save();
        });
        actions.appendChild(add);
        // Google Scholar search for the title, for its own BibTeX ("Cite" there).
        const gs = el('button', 'ol-cite-btn secondary', 'Google Scholar');
        gs.type = 'button';
        gs.title = 'Open this paper in Google Scholar (use its Cite \u2192 BibTeX there)';
        gs.addEventListener('click', () => window.open(`https://scholar.google.com/scholar?q=${encodeURIComponent(`"${p.title}"`)}`, '_blank'));
        actions.appendChild(gs);
        if (p.bibtex) {
          const copy = el('button', 'ol-cite-btn secondary', 'Copy BibTeX');
          copy.type = 'button';
          copy.addEventListener('click', () => { navigator.clipboard.writeText(p.bibtex); copy.textContent = 'Copied'; });
          actions.appendChild(copy);
        }
        row.appendChild(actions);
        box.appendChild(row);
      }
      wrap.appendChild(box);
    });
    return wrap;
  }

  window.__euphorbiaQuote = () => {
    const v = window.overleaf && window.overleaf.unstable && window.overleaf.unstable.store.get('editor.view');
    if (!v) return false;
    const ref = refFromSelection(v);
    if (PANE === 1) addRef(ref);
    else ai.sendRef(ref);
    return true;
  };

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
      console.error('[euphorbia] chat shortcut failed to load', err);
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
  // Switching to a paid model in a conversation that already has messages
  // costs a full, uncached read on the next message: ask first. Runs before
  // the other change listeners and lets them run only when the switch stands.
  let modelValue = '';
  let confirmingSwitch = false;
  model.addEventListener('change', async (e) => {
    if (confirmingSwitch) return;
    const next = model.value;
    const prev = modelValue;
    if (!prev || next === prev || !messages.length || next.startsWith('local:') || next.startsWith('connector:')) {
      modelValue = next;
      return;
    }
    e.stopImmediatePropagation();
    const info = await ai.switchCost({
      projectId,
      choiceId: next,
      historyChars: messages.reduce((n, m) => n + String(m.content || '').length, 0),
    });
    if (info && info.paid) {
      const tokens = info.tokens >= 1000 ? `${Math.round(info.tokens / 1000)}k` : String(info.tokens);
      const cost = info.cost != null ? `, about $${info.cost < 0.01 ? '0.01 or less' : info.cost.toFixed(2)}` : '';
      const ok = window.confirm(
        `Switch to ${info.label}?\n\nThis conversation already has messages. A new model has no cache for them yet, ` +
        `so your next message re-reads the instructions, the project index and the conversation in full ` +
        `(about ${tokens} tokens${cost}). Later messages are cheaper again.\n\n` +
        `To avoid this, start a new chat (+) with the new model.`
      );
      if (!ok) {
        model.value = prev;
        return;
      }
    }
    modelValue = next;
    // Let the regular handlers see the confirmed switch.
    confirmingSwitch = true;
    model.dispatchEvent(new Event('change'));
    confirmingSwitch = false;
  }, true);
  const reindex = el('button', 'ol-chat-icon', '↻');
  reindex.title = 'Re-read the project now';
  const history = el('button', 'ol-chat-icon', '\u2630');
  history.title = 'Conversations';
  const newChat = el('button', 'ol-chat-icon', '+');
  newChat.title = 'New chat';
  const linkBtn = el('button', 'ol-chat-icon ol-chat-link', '\u2197');
  linkBtn.title = 'Refer to other projects in this conversation (read only)';
  const folderBtn = el('button', 'ol-chat-icon ol-chat-link', '\u{1F5C0}');
  folderBtn.title = "Open this project's AI index folder (index.md, summaries)";
  folderBtn.addEventListener('click', () => ai.openIndexFolder(projectId));
  header.append(toggle, title, linkBtn, folderBtn, reindex, history, newChat);
  const linkedRow = el('div', 'ol-chat-linked');
  const linkMenu = el('div', 'ol-chat-linkmenu');
  linkMenu.hidden = true;

  function renderLinked() {
    linkedRow.textContent = '';
    const list = linkedOf();
    linkedRow.hidden = !list.length;
    if (!list.length) return;
    linkedRow.appendChild(el('span', 'ol-chat-linked-label', 'Also reading:'));
    for (const r of list) {
      const chipEl = el('span', 'ol-chat-ref');
      chipEl.appendChild(el('span', 'ol-chat-linked-name', r.name || r.id));
      const x = el('button', 'ol-chat-ref-x', '\u00d7');
      x.type = 'button';
      x.title = 'Stop referring to this project';
      x.addEventListener('click', () => setLinked(linkedOf().filter((y) => y.id !== r.id)));
      chipEl.appendChild(x);
      linkedRow.appendChild(chipEl);
    }
  }

  async function openLinkMenu() {
    linkMenu.textContent = 'Loading projects\u2026';
    linkMenu.hidden = false;
    if (linkMenu.parentElement !== document.body) document.body.appendChild(linkMenu);
    const r = linkBtn.getBoundingClientRect();
    linkMenu.style.top = `${r.bottom + 4}px`;
    linkMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 330))}px`;
    const projects = ((await ai.listProjects()) || []).filter((x) => x.id !== projectId);
    linkMenu.textContent = '';
    linkMenu.appendChild(el('div', 'ol-chat-linkmenu-head', 'Refer to other projects (read only, up to 3)'));
    if (!projects.length) linkMenu.appendChild(el('div', 'ol-chat-linkmenu-empty', 'No other projects on this server.'));
    for (const p of projects) {
      const row = el('label', 'ol-chat-linkmenu-item');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = linkedOf().some((y) => y.id === p.id);
      box.addEventListener('change', () => {
        let list = linkedOf().filter((y) => y.id !== p.id);
        if (box.checked) {
          if (list.length >= 3) {
            box.checked = false;
            return;
          }
          list = [...list, { id: p.id, name: p.name }];
        }
        setLinked(list);
      });
      row.append(box, el('span', '', p.name));
      linkMenu.appendChild(row);
    }
  }
  linkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (linkMenu.hidden) openLinkMenu();
    else linkMenu.hidden = true;
  });
  linkMenu.addEventListener('mousedown', (e) => e.stopPropagation());
  window.addEventListener('mousedown', () => (linkMenu.hidden = true));
  const indexBar = el('div', 'ol-chat-index');
  const list = el('div', 'ol-chat-list');
  const status = el('div', 'ol-chat-status');
  const composer = el('div', 'ol-chat-composer');
  const refsRow = el('div', 'ol-chat-refs');
  const input = el('textarea', 'ol-chat-input');
  input.placeholder = `Ask about the project or request a change. ${/Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+L adds the selected lines.`;
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
  // Model menu on the left of the Mode / Send row, then this month's spending.
  const spend = el('span', 'ol-chat-spend');
  actions.append(model, spend, modeBtn, send);

  const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const fmtCost = (c) => (c < 0.01 && c > 0 ? '<$0.01' : `$${c.toFixed(2)}`);
  // Estimated from the token usage this app saw; other apps using the key are not included.
  async function updateSpend() {
    let provider = (model.value || '').split(':')[0];
    if (provider === 'hybrid') provider = 'claude'; // Auto pays only for Claude API models
    if (!provider) {
      spend.textContent = '';
      return;
    }
    if (provider === 'connector') {
      spend.textContent = 'subscription';
      spend.title = 'Connector: Claude Code on your subscription; no API cost.';
      return;
    }
    if (provider === 'local') {
      spend.textContent = 'free';
      spend.title = 'Local model: no API cost.';
      return;
    }
    const u = await ai.usage(provider);
    if (!u) return;
    const parts = [];
    if (u.cost > 0 || !u.unpricedTokens) parts.push(fmtCost(u.cost));
    if (u.unpricedTokens) parts.push(`${fmtTokens(u.unpricedTokens)} tok`);
    spend.textContent = parts.join(' + ');
    spend.title = [
      `Spent this month (${u.month}) through this app, estimated from token usage:`,
      ...u.models.map((m) => `  ${m.model}: ${m.cost != null ? fmtCost(m.cost) : 'price unknown'} (${fmtTokens(m.tokens)} tokens)`),
      u.models.length ? '' : '  nothing yet',
      'Other apps or computers using the same key are not included.',
    ].filter((l) => l !== '').join('\n');
  }
  model.addEventListener('change', updateSpend);
  // A clipped amount ("$0" for "$0.02") would mislead: show it whole or not at all.
  const fitSpend = () => {
    spend.style.visibility = 'visible';
    if (spend.scrollWidth > spend.clientWidth + 1) spend.style.visibility = 'hidden';
  };
  new ResizeObserver(fitSpend).observe(actions);
  new MutationObserver(fitSpend).observe(spend, { childList: true, characterData: true, subtree: true });
  composer.append(refsRow, input, actions);
  panel.append(handle, header, linkedRow, indexBar, list, status, composer);
  renderLinked();
  for (const b of panel.querySelectorAll('button')) b.type = 'button';

  const HEIGHT_KEY = 'ol-desktop-chat-height';
  let height = Number(localStorage.getItem(HEIGHT_KEY)) || 340;
  let collapsed = localStorage.getItem('ol-desktop-chat-collapsed') === '1';

  function setCollapsed(c) {
    if (panel.classList.contains('in-rail')) c = false; // a tab of its own: never folded
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
    // Model name only (the row is narrow); the provider is in the tooltip.
    for (const c of info.choices) {
      const o = new Option(c.model, c.id, false, c.id === info.selected);
      o.title = c.label;
      model.add(o);
    }
    const showTitle = () => {
      const c = info.choices.find((x) => x.id === model.value);
      model.title = c ? `Model: ${c.label}` : 'Model';
    };
    showTitle();
    model.onchange = showTitle;
    modelValue = model.value;
    updateSpend();
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
    pendingLinked = [];
    render();
    renderRefs();
    renderLinked();
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
    else if (state.ok) st.textContent = state.revised ? 'revised the waiting edit' : 'added for review';
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

  // One line for all edits of an answer that went in (or are still pending):
  // "✎ 3 edits suggested (only you see them until you accept)" and the files,
  // each opening its first edit.
  function editSummary(items) {
    const card = el('div', 'ol-chat-edit');
    const head = el('div', 'ol-chat-edit-head');
    const pending = items.some(({ state }) => !state);
    const n = items.length;
    head.appendChild(el('span', 'ol-chat-edit-count', `\u270e ${n} edit${n === 1 ? '' : 's'}`));
    const st = el('span', 'ol-chat-edit-state');
    st.textContent = pending ? 'pending' : 'added for review';
    st.classList.toggle('ok', !pending);
    head.appendChild(st);
    const files = el('div', 'ol-chat-edit-files');
    const byFile = new Map();
    for (const it of items) {
      if (!byFile.has(it.edit.file)) byFile.set(it.edit.file, []);
      byFile.get(it.edit.file).push(it);
    }
    for (const [file, list] of byFile) {
      const name = file.split('/').pop();
      const b = el('button', 'ol-chat-ref-link', list.length > 1 ? `${name} \u00d7${list.length}` : name);
      b.type = 'button';
      b.title = file;
      b.addEventListener('click', async () => {
        const first = list[0].state;
        if (first && first.line) return revealLines(file, first.line, first.line);
        await openPath(file);
        if (first && first.proposalId && window.__olDesktopEdits) setTimeout(() => window.__olDesktopEdits.revealProposal(first.proposalId), 150);
      });
      files.appendChild(b);
    }
    card.append(head, files);
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
    // Edits that went in (or are pending) are summed up in one line where the
    // first of them was; edits that failed keep their own line with Try again.
    const states = msg.edits || [];
    const good = parts.filter((p) => p.text == null && !(states[p.edit] && !states[p.edit].ok));
    let summarized = false;
    let modeNoted = false;
    for (const p of parts) {
      if (p.text != null) {
        if (p.text.trim()) box.appendChild(textNode(p.text));
      } else if (states[p.edit] && !states[p.edit].ok && /\bmode, read-only\)/.test(states[p.edit].error || '')) {
        // Edits written in Read or Search mode: one line for all of them.
        if (!modeNoted) {
          modeNoted = true;
          const n = parts.filter((q) => q.text == null && states[q.edit] && /\bmode, read-only\)/.test(states[q.edit].error || '')).length;
          const card = el('div', 'ol-chat-edit');
          const st = el('span', 'ol-chat-edit-state error', `\u270e ${n} edit${n === 1 ? '' : 's'} ${states[p.edit].error}`);
          card.appendChild(st);
          box.appendChild(card);
        }
      } else if (states[p.edit] && !states[p.edit].ok) {
        box.appendChild(editCard(edits[p.edit], states[p.edit]));
      } else if (good.length === 1) {
        box.appendChild(editCard(edits[p.edit], states[p.edit]));
      } else if (!summarized) {
        summarized = true;
        box.appendChild(editSummary(good.map((g) => ({ edit: edits[g.edit], state: states[g.edit] }))));
      }
    }
    if (msg.cites) box.appendChild(citeCards(msg));
    // Notes the AI attached: one line with their places.
    const notes = Array.isArray(msg.notes) ? msg.notes : [];
    if (notes.length) {
      const st = msg.noteStates || [];
      const card = el('div', 'ol-chat-edit ol-chat-notes');
      const okN = st.filter((x) => x && x.ok).length;
      card.appendChild(el('span', 'ol-chat-edit-count', `\u{1F4CC} ${notes.length} note${notes.length === 1 ? '' : 's'}`));
      card.appendChild(el('span', 'ol-chat-edit-state' + (st.length && okN < notes.length ? ' error' : ' ok'), st.length ? (okN === notes.length ? ' added' : ` ${okN} added`) : ' pending'));
      const files = el('div', 'ol-chat-edit-files');
      notes.forEach((n, i) => {
        const s1 = st[i];
        const b = el('button', 'ol-chat-ref-link', `${n.file.split('/').pop()}${s1 && s1.line ? `:${s1.line}` : ''}`);
        b.type = 'button';
        b.title = s1 && !s1.ok ? `${n.text}\n(not added: ${s1.error})` : n.text;
        b.addEventListener('click', () => (s1 && s1.line ? revealLines(n.file, s1.line, s1.line) : openPath(n.file)));
        files.appendChild(b);
      });
      card.appendChild(files);
      box.appendChild(card);
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
      const conv = { id: newId(), title: text.replace(/\s+/g, ' ').slice(0, 60), updatedAt: Date.now(), messages: [], linked: pendingLinked };
      pendingLinked = [];
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
      linked: linkedOf(),
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
      updateSpend();
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
    } else if (ev.type === 'reset') {
      // Auto replaced the local draft: the stronger model's answer follows.
      active.text = '';
      active.body.textContent = '';
      setStatus(ev.text);
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
      const msg = { role: 'assistant', content: ev.text, by: ev.by, edits: [], mode: active.mode, proposals: ev.proposals || [], hits: ev.hits || [], notes: ev.notes || [] };
      const conv = convs.find((c) => c.id === active.conv);
      if (conv) conv.messages.push(msg);
      active = null;
      setBusy(false);
      save();
      render();
      await applyEdits(msg);
      await applyNotes(msg);
    }
  });

  // ----------------------------------------------------------- searched ---
  //
  // Places marked by a search answer, highlighted in yellow in whichever file
  // is open, with a yellow bar above the editor while the state is on.

  let searched = null; // { hits, at }
  const bar = el('div', 'ol-searched-bar ol-topbar');
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
    // Bars above the editor (class ol-topbar) form one run right before it.
    let n = bar.parentElement === host ? bar.nextElementSibling : null;
    while (n && n !== holder && n.classList.contains('ol-topbar')) n = n.nextElementSibling;
    if (n === holder) return;
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
      ? await window.__olDesktopEdits.addProposal({ file: edit.file, find: edit.find, replace: edit.replace, by: state.by || 'AI' })
      : { ok: false, error: 'Editor not ready.' };
    Object.assign(state, { ok: res.ok, error: res.error || null, line: res.ok ? res.line : null, revised: !!res.revised });
    save();
    if (card) render();
    return res.ok;
  }

  // Notes the AI attached (add_comment): written into the files as comment
  // lines under the lines they are about.
  async function applyNotes(msg) {
    const notes = Array.isArray(msg.notes) ? msg.notes : [];
    if (!notes.length || !window.__olDesktopEdits || !window.__olDesktopEdits.addNote) return;
    const back = currentPath();
    let ok = 0;
    msg.noteStates = [];
    for (const n of notes) {
      const res = await window.__olDesktopEdits.addNote({ file: n.file, find: n.find, text: n.text, by: msg.by || 'AI' });
      msg.noteStates.push({ ok: res.ok, error: res.error || null, line: res.line || null });
      if (res.ok) ok++;
    }
    save();
    render();
    const files = new Set(notes.map((n) => n.file));
    if (back && !(files.size === 1 && !files.has(back))) await openPath(back);
    setStatus(ok === notes.length ? `${ok} note(s) added.` : `${ok} of ${notes.length} note(s) added.`, ok !== notes.length);
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

  // A tab of its own in Overleaf's left rail (after File tree, Search, Chat).
  // While it is on, the rail panel shows the AI chat over the selected tab's
  // content; clicking any other tab turns it off.
  const RAIL_KEY = 'ol-desktop-ai-tab';
  let aiOn = localStorage.getItem(RAIL_KEY) === '1';
  const pane = el('div', 'ol-ai-pane');
  const railTab = el('button', 'ide-rail-tab-link nav-link ol-ai-rail-tab');
  railTab.type = 'button';
  railTab.title = 'AI Chat';
  railTab.setAttribute('aria-label', 'AI Chat');
  railTab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9L12 2zm7 11l.95 2.55L22.5 16.5l-2.55.95L19 20l-.95-2.55-2.55-.95 2.55-.95L19 13zM6 15l.7 1.8 1.8.7-1.8.7L6 20l-.7-1.8-1.8-.7 1.8-.7L6 15z"/></svg>';

  const railContent = () => document.querySelector('.ide-rail-content');
  const panelOpen = () => {
    const c = railContent();
    return !!(c && c.offsetWidth > 40);
  };
  const nativeActive = () => document.querySelector('.ide-rail-tabs-wrapper .ide-rail-tab-link.active:not(.ol-ai-rail-tab)');

  function showAi(on) {
    aiOn = on;
    localStorage.setItem(RAIL_KEY, on ? '1' : '0');
    const c = railContent();
    if (c) c.classList.toggle('ol-ai-on', on);
    const rail = document.querySelector('.ide-rail');
    if (rail) rail.classList.toggle('ol-ai-on-rail', on);
    railTab.classList.toggle('active', on);
    railTab.classList.toggle('open-rail', on);
    if (on) {
      render();
      renderRefs();
      loadModels();
      setTimeout(() => input.focus(), 50);
    }
  }

  railTab.addEventListener('click', () => {
    if (aiOn && panelOpen()) {
      // Close the panel like Overleaf's tabs do: its active tab toggles it.
      showAi(false);
      const t = nativeActive();
      if (t) t.click();
      return;
    }
    if (!panelOpen()) {
      // Open the panel with Overleaf's own first tab, then cover it.
      const first = document.querySelector('.ide-rail-tabs-wrapper .ide-rail-tab-link:not(.ol-ai-rail-tab)');
      if (first && !first.classList.contains('active')) first.click();
      else if (first) first.click();
    }
    showAi(true);
  });

  function attach() {
    const wrapper = document.querySelector('.ide-rail-tabs-wrapper');
    const content = railContent();
    if (wrapper && railTab.parentElement !== wrapper) {
      // Before the "more options" element at the end of the tab list.
      const tabs = wrapper.querySelectorAll('.ide-rail-tab-link:not(.ol-ai-rail-tab)');
      const lastTab = tabs[tabs.length - 1];
      const after = lastTab ? lastTab.closest('.ide-rail-tabs-wrapper > *') : null;
      if (after) after.after(railTab);
      else wrapper.appendChild(railTab);
      // Another tab turns the AI chat off. A click on the tab that is active
      // underneath would close the panel in Overleaf: just show it instead.
      wrapper.addEventListener('click', (e) => {
        const t = e.target.closest('.ide-rail-tab-link');
        if (!t || t === railTab || !aiOn) return;
        if (t.classList.contains('active') && panelOpen()) {
          e.preventDefault();
          e.stopPropagation();
        }
        showAi(false);
      }, true);
    }
    if (content && pane.parentElement !== content) {
      content.appendChild(pane);
      content.classList.toggle('ol-ai-on', aiOn);
    }
    if (panel.parentElement !== pane) {
      pane.appendChild(panel);
      panel.classList.add('in-rail');
      setCollapsed(false);
      render();
      renderRefs();
      loadModels();
    }
    const rail = document.querySelector('.ide-rail');
    if (rail) rail.classList.toggle('ol-ai-on-rail', aiOn);
    railTab.classList.toggle('active', aiOn);
    railTab.classList.toggle('open-rail', aiOn);
  }

  const style = el('style');
  style.textContent = `
    .ide-rail-content { position: relative; }
    .ol-ai-pane { display: none; position: absolute; inset: 0; z-index: 5; }
    .ide-rail-content.ol-ai-on > .ide-rail-tab-content { visibility: hidden; }
    .ide-rail-content.ol-ai-on > .ol-ai-pane { display: flex; flex-direction: column; }
    .ol-ai-pane > .ol-chat { flex: 1 1 auto; height: auto !important; border-top: 0; }
    .ol-chat.in-rail .ol-chat-handle, .ol-chat.in-rail .ol-chat-toggle { display: none; }
    .ol-chat.in-rail .ol-chat-title { cursor: default; }
    .ol-ai-rail-tab { display: flex; align-items: center; justify-content: center; border: 0; background: none; color: inherit; }
    .ide-rail.ol-ai-on-rail .ide-rail-tab-link.active:not(.ol-ai-rail-tab) { background: transparent !important; }
    .ide-rail.ol-ai-on-rail .ide-rail-tab-link.active:not(.ol-ai-rail-tab)::before { display: none !important; }
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
    .ol-chat-edit-count { font-weight: 600; }
    .ol-cite { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .ol-cite-claim { border-left: 3px solid #e0b100; background: rgba(224,177,0,.08); padding: 4px 6px; border-radius: 3px; }
    .ol-cite-quote { font-style: italic; text-align: left; white-space: normal; padding: 0; }
    .ol-cite-why { font-size: 10.5px; opacity: .7; margin-top: 1px; }
    .ol-cite-none { font-size: 11px; opacity: .6; margin-top: 4px; }
    .ol-cite-paper { margin-top: 6px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,.08); }
    .ol-cite-title { color: #9cc9ff; font-weight: 600; text-decoration: none; }
    .ol-cite-title:hover { text-decoration: underline; }
    .ol-cite-meta { font-size: 10.5px; opacity: .75; }
    .ol-cite-actions { display: flex; gap: 6px; margin-top: 3px; flex-wrap: wrap; }
    .ol-cite-btn { font: inherit; font-size: 11px; border: 0; border-radius: 10px; padding: 1px 9px; background: #098842; color: #fff; cursor: pointer; }
    .ol-cite-btn.secondary { background: rgba(255,255,255,.12); color: inherit; }
    .ol-cite-btn:disabled { opacity: .6; cursor: default; }
    .ol-chat-notes { border-left-color: #e0b100; background: rgba(224,177,0,.12); }
    .ol-chat-link { opacity: .55; }
    .ol-chat-link:hover { opacity: 1; }
    .ol-chat-linked { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 2px 8px 4px; font-size: 11px; }
    .ol-chat-linked[hidden] { display: none; }
    .ol-chat-linked-label { opacity: .65; }
    .ol-chat-linkmenu { position: fixed; z-index: 2147483000; width: 320px; max-height: 320px; overflow-y: auto; background: #fff; color: #1b222c;
      border: 1px solid #c9ced6; border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.25); padding: 4px 0; font: 12px system-ui, "Segoe UI", sans-serif; }
    .ol-chat-linkmenu[hidden] { display: none; }
    .ol-chat-linkmenu-head { padding: 4px 10px 6px; font-weight: 600; border-bottom: 1px solid #e4e7eb; margin-bottom: 2px; }
    .ol-chat-linkmenu-empty { padding: 6px 10px; opacity: .7; }
    .ol-chat-linkmenu-item { display: flex; align-items: center; gap: 8px; padding: 4px 10px; cursor: pointer; margin: 0; font-weight: normal; }
    .ol-chat-linkmenu-item:hover { background: #f1f3f5; }
    .ol-chat-edit-files { display: flex; flex-wrap: wrap; gap: 2px 8px; margin-top: 2px; }
    .ol-chat-edit-files .ol-chat-ref-link { padding: 0; }
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
    .ol-chat-actions { display: flex; flex-wrap: nowrap; justify-content: flex-end; align-items: center; gap: 4px; min-width: 0; }
    .ol-chat-actions .ol-chat-mode, .ol-chat-actions .ol-chat-send { flex-shrink: 0; }
    .ol-chat-actions .ol-chat-model { flex: 1 1 56px; min-width: 56px; max-width: 100%; height: 22px; }
    .ol-chat-actions .ol-chat-send { padding: 3px 10px; }
    .ol-chat-spend { flex: 0 100 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: clip; font-size: 10px; opacity: .65; }
    .ol-chat-spend:empty { display: none; }
    .ol-chat-title { margin-right: auto; }
    .ol-chat-mode { font: inherit; font-size: 11px; color: inherit; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
      border-radius: 14px; padding: 2px 0; cursor: pointer; white-space: nowrap; width: 66px; flex: 0 0 66px; text-align: center; overflow: hidden; }
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
