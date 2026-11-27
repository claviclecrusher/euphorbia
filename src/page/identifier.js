// Runs in the Overleaf page. Identifier: the toolbar button colours the text
// of the open file by who last wrote it, from the project history (no AI).
// A bar above the editor lists the people with their colours and × to turn
// it off. Text not yet in the history (just typed) is shown as "you, unsaved".
//
// Data: /project/:id/updates (to find the latest version and who created the
// file) and one /project/:id/diff from the file's first version to the latest:
// unchanged text belongs to the file's creator, inserted text to whoever
// inserted it. Only the open file is kept, and only while the view is on.
(() => {
  if (window.__euphorbiaIdentifier) return;
  window.__euphorbiaIdentifier = true;
  const PANE = window.__olDesktopPane || 0;
  const pm = location.pathname.match(/^\/project\/([0-9a-f]{24})\/?$/);
  if (PANE !== 1 || !pm) return;
  const projectId = pm[1];

  let CM = null;
  let setMarks = null;
  let on = false;
  let people = []; // [{ id, name, color }]
  let busy = false;
  let timer = null;

  const view = () => { try { return window.overleaf.unstable.store.get('editor.view'); } catch { return null; } };
  const storeGet = (k) => { try { return window.overleaf.unstable.store.get(k); } catch { return null; } };
  const entityName = (e) => { const n = e && (e.querySelector('.item-name-button span') || e.querySelector('.item-name-button')); return n ? n.textContent.trim() : ''; };
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

  const PALETTE = ['#2f80ed', '#eb5757', '#27ae60', '#f2994a', '#9b51e0', '#00a3a3', '#c2185b', '#8d6e63', '#7cb342', '#5c6bc0'];
  const colourOf = (id) => {
    let p = people.find((x) => x.id === id);
    return p ? p.color : '#888';
  };
  function person(u) {
    const id = (u && (u.id || u.email)) || 'unknown';
    let p = people.find((x) => x.id === id);
    if (!p) {
      const name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Someone' : 'Someone';
      p = { id, name, color: PALETTE[people.length % PALETTE.length] };
      people.push(p);
    }
    return p;
  }
  const UNSAVED = { id: '__unsaved', name: 'you, not in the history yet', color: '#9aa0a6' };

  // Who wrote each part of `path` in the latest history version:
  // { text, spans: [{ from, to, who, at }] }.
  async function attribution(path) {
    let before = null;
    let latest = null;
    let creator = null;
    let addV = 0;
    for (let page = 0; page < 20 && !creator; page++) {
      const r = await fetch(`/project/${projectId}/updates?min_count=50${before ? `&before=${before}` : ''}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`history: ${r.status}`);
      const d = await r.json();
      const ups = d.updates || [];
      if (!ups.length) break;
      if (latest == null) latest = ups[0].toV;
      for (const u of ups) {
        const add = (u.project_ops || []).find((o) => o.add && o.add.pathname === path);
        if (add) {
          creator = { user: (u.meta.users || [])[0], at: u.meta.start_ts };
          addV = add.atV;
        }
      }
      if (!d.nextBeforeTimestamp) break;
      before = d.nextBeforeTimestamp;
    }
    if (latest == null) return null;
    const r = await fetch(`/project/${projectId}/diff?pathname=${encodeURIComponent(path)}&from=${addV}&to=${latest}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`history diff: ${r.status}`);
    const d = await r.json();
    let text = '';
    const spans = [];
    const base = creator ? person(creator.user) : person(null);
    for (const part of d.diff || []) {
      if (part.d != null) continue; // deleted text is gone
      const s = part.u != null ? part.u : part.i;
      if (s == null) continue;
      const who = part.i != null ? person((part.meta && part.meta.users || [])[0]) : base;
      const at = part.i != null ? part.meta && part.meta.end_ts : creator && creator.at;
      spans.push({ from: text.length, to: text.length + s.length, who, at });
      text += s;
    }
    return { text, spans };
  }

  // Map the history text onto the editor's text: equal prefix and suffix
  // keep their colours; the middle (edits not in the history yet) is "unsaved".
  function place(doc, att) {
    const cur = doc.toString();
    const old = att.text;
    let a = 0;
    while (a < cur.length && a < old.length && cur[a] === old[a]) a++;
    let b = 0;
    while (b < cur.length - a && b < old.length - a && cur[cur.length - 1 - b] === old[old.length - 1 - b]) b++;
    const out = [];
    for (const s of att.spans) {
      if (s.from < a) out.push({ from: s.from, to: Math.min(s.to, a), who: s.who, at: s.at });
      if (s.to > old.length - b) out.push({ from: Math.max(s.from, old.length - b) + (cur.length - old.length), to: s.to + (cur.length - old.length), who: s.who, at: s.at });
    }
    if (cur.length - b > a) out.push({ from: a, to: cur.length - b, who: UNSAVED, at: null });
    return out.filter((s) => s.to > s.from);
  }

  async function refresh() {
    if (!on || busy || !setMarks) return;
    const v = view();
    const path = currentPath();
    if (!v || !path) return;
    busy = true;
    try {
      const att = await attribution(path);
      const w = view();
      if (!on || !w) return;
      const spans = att ? place(w.state.doc, att) : [];
      if (spans.some((s) => s.who === UNSAVED) && !people.includes(UNSAVED)) people.push(UNSAVED);
      const fmt = (t) => (t ? new Date(t).toLocaleString() : '');
      const ranges = spans.map((s) => CM.Decoration.mark({ attributes: { class: 'ol-who', style: `background-color: ${hexA(s.who.color, 0.2)}; box-shadow: inset 0 -2px 0 ${hexA(s.who.color, 0.7)}`, title: `${s.who.name}${s.at ? ' · ' + fmt(s.at) : ''}` } }).range(s.from, s.to));
      w.dispatch({ effects: setMarks.of(CM.Decoration.set(ranges, true)) });
      renderBar(spans);
    } catch (err) {
      barText.textContent = `Could not read the history: ${err.message}`;
    } finally {
      busy = false;
    }
  }
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

  // ---- bar
  const bar = document.createElement('div');
  bar.className = 'ol-who-bar ol-topbar';
  bar.hidden = true;
  const barText = document.createElement('span');
  barText.className = 'ol-who-legend';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ol-who-close';
  close.textContent = '×';
  close.title = 'Turn the identifier off';
  close.addEventListener('click', () => toggle(false));
  bar.append(barText, close);
  function renderBar(spans) {
    barText.textContent = '';
    const chars = new Map();
    for (const s of spans || []) chars.set(s.who, (chars.get(s.who) || 0) + (s.to - s.from));
    const total = [...chars.values()].reduce((x, y) => x + y, 0) || 1;
    const lab = document.createElement('span');
    lab.textContent = 'Last written by:';
    lab.className = 'ol-who-label';
    barText.appendChild(lab);
    for (const [p, n] of [...chars.entries()].sort((x, y) => y[1] - x[1])) {
      const chip = document.createElement('span');
      chip.className = 'ol-who-chip';
      chip.style.background = hexA(p.color, 0.22);
      chip.style.borderColor = p.color;
      chip.textContent = `${p.name} ${Math.round((n / total) * 100)}%`;
      barText.appendChild(chip);
    }
    if (!chars.size) barText.append(' (no history yet)');
  }
  function attachBar() {
    const editor = document.querySelector('.cm-editor');
    const holder = editor && editor.parentElement;
    const host = holder && holder.parentElement;
    if (!host) return;
    let n = bar.parentElement === host ? bar.nextElementSibling : null;
    while (n && n !== holder && n.classList.contains('ol-topbar')) n = n.nextElementSibling;
    if (n !== holder) host.insertBefore(bar, holder);
  }

  const buttons = new Set();
  function toggle(want) {
    on = typeof want === 'boolean' ? want : !on;
    for (const b of buttons) b.classList.toggle('active', on);
    bar.hidden = !on;
    clearInterval(timer);
    if (on) {
      attachBar();
      barText.textContent = 'Reading the history…';
      refresh();
      timer = setInterval(refresh, 30000);
    } else {
      people = [];
      const v = view();
      if (v && setMarks) v.dispatch({ effects: setMarks.of(CM.Decoration.none) });
    }
    return true;
  }
  window.__euphorbiaIdentifierToggle = toggle;

  function addButton() {
    for (const group of document.querySelectorAll('.ol-cm-toolbar .ol-cm-toolbar-end')) {
      if (group.querySelector('.ol-who-toggle')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ol-cm-toolbar-button ol-who-toggle' + (on ? ' active' : '');
      b.title = 'Identifier: colour the text by who last wrote it (from the project history)';
      b.setAttribute('aria-label', 'Identifier');
      b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-7 1.6-7 4v2h10.5a6 6 0 0 1-.5-2.5c0-1.2.3-2.3 1-3.2-1.3-.2-2.6-.3-4-.3zm8 0a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => toggle());
      group.insertBefore(b, group.firstChild);
      buttons.add(b);
    }
  }

  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      CM = event.detail.CodeMirror;
      const { StateEffect, StateField, EditorView, Decoration } = CM;
      setMarks = setMarks || StateEffect.define();
      let debounce = null;
      event.detail.extensions.push(
        StateField.define({
          create: () => Decoration.none,
          update(v, tr) {
            v = v.map(tr.changes);
            for (const e of tr.effects) if (e.is(setMarks)) v = e.value;
            return v;
          },
          provide: (f) => EditorView.decorations.from(f),
        }),
        // After edits, read the history again once it has caught up.
        EditorView.updateListener.of((u) => {
          if (!on || !u.docChanged) return;
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 8000);
        })
      );
    } catch (err) {
      console.error('[euphorbia] identifier failed to load', err);
    }
  });
  window.addEventListener('doc:after-opened', () => {
    if (on) setTimeout(refresh, 500);
  });

  const style = document.createElement('style');
  style.textContent = `
    .ol-who-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 3px 10px; background: #eef2f7; color: #1b222c;
      border-bottom: 2px solid #5c6bc0; font: 12px system-ui, "Segoe UI", sans-serif; }
    .ol-who-bar[hidden] { display: none; }
    .ol-who-legend { flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
    .ol-who-label { opacity: .7; }
    .ol-who-chip { border: 1px solid; border-radius: 10px; padding: 0 8px; white-space: nowrap; }
    .ol-who-close { font: inherit; font-size: 15px; line-height: 1; border: 0; background: none; cursor: pointer; padding: 0 4px; }
    .ol-who-toggle.active { background: rgba(92,107,192,.22) !important; color: #3f51b5 !important; border-radius: 4px; }
  `;
  const scan = () => {
    if (!style.isConnected && document.head) document.head.appendChild(style);
    addButton();
    if (on) attachBar();
  };
  const start = () => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
