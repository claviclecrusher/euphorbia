// Runs in the Overleaf page (main world), before the editor is created.
//
// Candidates: a block of lines can hold several alternative versions. Exactly
// one is active (plain source, so it is what compiles); the others are kept
// as comments right next to it. Everything lives in the .tex source:
//
//   %%cand:begin id=k3f9
//   %%cand:option name="A"
//   %| We propose a method.
//   %%cand:option name="B" active
//   We propose a novel method that
//   improves stability.
//   %%cand:end
//
// The editor folds the marker and comment lines into a bar of buttons above
// the active text. Each option records who added it and when (by=, at=).
//
// Edits (Ctrl+Shift+K) keep the text from before a change next to the change,
// both visible, until the change is accepted or rejected. The new text is
// plain source (it compiles); the old text is kept as comments:
//
//   %%edit:begin by="Alice Kim" at="2026-11-23 14:05"
//   %- We propose a method.
//   %%edit:new
//   We propose a novel method.
//   %%edit:end
// Overleaf hands out its CodeMirror objects through the
// (unsupported) UNSTABLE_editor:extensions event.
(() => {
  if (window.__euphorbiaCandidates) return;
  window.__euphorbiaCandidates = true;

  const BEGIN = /^\s*%%cand:begin\b(?:\s+id=([\w-]+))?\s*$/;
  const OPTION = /^\s*%%cand:option\b((?:\s+\w+="[^"]*")*)(\s+active)?\s*$/;
  const ATTR = /(\w+)="([^"]*)"/g;
  const attrs = (text) => {
    const out = {};
    for (const m of String(text || '').matchAll(ATTR)) out[m[1]] = m[2];
    return out;
  };
  const clean = (v) => String(v || '').replace(/["\r\n]/g, '').trim();

  // Overleaf account name of the person editing, and the local time.
  function author() {
    try {
      const meta = document.querySelector('meta[name="ol-user"]');
      const u = meta ? JSON.parse(meta.getAttribute('content')) : null;
      const name = u && [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
      if (name) return clean(name).slice(0, 60);
      if (u && u.email) return clean(u.email.split('@')[0]).slice(0, 60);
    } catch {
      /* fall through */
    }
    return 'unknown';
  }
  function now() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  const stamp = (by, at) => [by, at].filter(Boolean).join(' \u00b7 ');
  const END = /^\s*%%cand:end\s*$/;
  const HIDDEN = /^\s*%\|\s?(.*)$/;

  // ------------------------------------------------------------- model ---

  // Finds well-formed blocks. Each: { id, from, to, firstLine, lastLine,
  // options: [{ name, active, lines }], active, bodyFromLine, bodyToLine }.
  // Positions are document offsets; *Line values are 1-based line numbers.
  function parse(doc) {
    const blocks = [];
    if (doc.length < 20) return blocks;
    let open = null;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const text = line.text;
      if (text.indexOf('%') < 0) {
        if (open && open.current) open.current.raw.push(n);
        else if (open) open = null; // text between begin and the first option
        continue;
      }
      let m;
      if ((m = BEGIN.exec(text))) {
        open = { id: m[1] || '', from: line.from, firstLine: n, options: [], current: null };
      } else if (open && (m = OPTION.exec(text))) {
        const a = attrs(m[1]);
        open.current = { name: a.name || '', by: a.by || '', at: a.at || '', active: !!m[2], headerLine: n, raw: [] };
        open.options.push(open.current);
      } else if (open && END.test(text)) {
        if (open.options.length) {
          finish(doc, open, line, n);
          blocks.push(open);
        }
        open = null;
      } else if (open && open.current) {
        open.current.raw.push(n);
      } else if (open) {
        open = null;
      }
    }
    return blocks;
  }

  function finish(doc, block, endLine, n) {
    block.to = endLine.to;
    block.lastLine = n;
    let active = block.options.findIndex((o) => o.active);
    if (active < 0) active = 0;
    block.active = active;
    block.options.forEach((o, i) => {
      o.active = i === active;
      const texts = o.raw.map((ln) => doc.line(ln).text);
      // Inactive options are stored commented out; the active one is plain.
      o.lines = o.active ? texts : texts.map((t) => { const h = HIDDEN.exec(t); return h ? h[1] : t; });
    });
    const a = block.options[active];
    block.bodyFromLine = a.raw.length ? a.raw[0] : 0;
    block.bodyToLine = a.raw.length ? a.raw[a.raw.length - 1] : 0;
    delete block.current;
  }

  function serialize(block) {
    const out = [`%%cand:begin id=${block.id}`];
    block.options.forEach((o, i) => {
      const active = i === block.active;
      const meta = (o.by ? ` by="${clean(o.by)}"` : '') + (o.at ? ` at="${clean(o.at)}"` : '');
      out.push(`%%cand:option name="${o.name.replace(/"/g, "'")}"${meta}${active ? ' active' : ''}`);
      for (const l of o.lines) out.push(active ? l : l.length ? `%| ${l}` : '%|');
    });
    out.push('%%cand:end');
    return out.join('\n');
  }

  const newId = () => Math.random().toString(36).slice(2, 6);

  function nextName(options) {
    const used = new Set(options.map((o) => o.name));
    for (let i = 0; i < 26; i++) {
      const name = String.fromCharCode(65 + i);
      if (!used.has(name)) return name;
    }
    return `Option ${options.length + 1}`;
  }

  function blockAt(state, pos) {
    return parse(state.doc).find((b) => pos >= b.from && pos <= b.to) || null;
  }

  // ----------------------------------------------------------- actions ---

  function replaceBlock(view, block, text, cursorInBody) {
    const spec = { changes: { from: block.from, to: block.to, insert: text }, userEvent: 'input.candidates' };
    view.dispatch(spec);
    if (cursorInBody) {
      const fresh = blockAt(view.state, block.from);
      if (fresh && fresh.bodyFromLine) {
        view.dispatch({ selection: { anchor: view.state.doc.line(fresh.bodyFromLine).from } });
      }
    }
    view.focus();
  }

  function editable(view) {
    return !view.state.readOnly;
  }

  // Ctrl+Shift+I: wrap the selected lines, or add an option inside a block.
  function createOrAdd(view) {
    if (!editable(view)) return false;
    const { state } = view;
    const sel = state.selection.main;
    const inside = blockAt(state, sel.head);
    if (inside) {
      addOption(view, inside.from);
      return true;
    }
    const first = state.doc.lineAt(sel.from);
    // A selection ending at the very start of a line does not include that line.
    let last = state.doc.lineAt(sel.to);
    if (sel.to > sel.from && sel.to === last.from && last.number > first.number) {
      last = state.doc.line(last.number - 1);
    }
    if (overlapsAny(state.doc, first.from, last.to)) return true; // no nesting
    const body = state.doc.sliceString(first.from, last.to);
    const text =
      `%%cand:begin id=${newId()}\n%%cand:option name="A" by="${author()}" at="${now()}" active\n${body}\n%%cand:end`;
    view.dispatch({
      changes: { from: first.from, to: last.to, insert: text },
      userEvent: 'input.candidates',
    });
    return true;
  }

  // New option starts as a copy of the active one and becomes active, ready
  // to be edited into an alternative.
  function addOption(view, pos) {
    const block = blockAt(view.state, pos);
    if (!block || !editable(view)) return;
    const current = block.options[block.active];
    block.options.push({ name: nextName(block.options), by: author(), at: now(), lines: current.lines.slice() });
    block.active = block.options.length - 1;
    replaceBlock(view, block, serialize(block), true);
  }

  function selectOption(view, pos, index) {
    const block = blockAt(view.state, pos);
    if (!block || !editable(view) || index === block.active || !block.options[index]) return;
    block.active = index;
    replaceBlock(view, block, serialize(block), false);
  }

  function renameOption(view, pos, index, name) {
    const block = blockAt(view.state, pos);
    name = String(name || '').replace(/["\r\n]/g, '').trim().slice(0, 40);
    if (!block || !editable(view) || !block.options[index] || !name) return;
    if (block.options[index].name === name) return;
    block.options[index].name = name;
    replaceBlock(view, block, serialize(block), false);
  }

  function deleteOption(view, pos, index) {
    const block = blockAt(view.state, pos);
    if (!block || !editable(view) || !block.options[index]) return;
    if (block.options.length === 1) return resolve(view, pos);
    block.options.splice(index, 1);
    if (index < block.active) block.active -= 1;
    else if (index === block.active) block.active = Math.min(index, block.options.length - 1);
    replaceBlock(view, block, serialize(block), false);
  }

  // Keep the active text, drop the markers and the other options.
  function resolve(view, pos) {
    const block = blockAt(view.state, pos);
    if (!block || !editable(view)) return;
    replaceBlock(view, block, block.options[block.active].lines.join('\n'), false);
  }

  // ------------------------------------------------------------- edits ---

  const E_BEGIN = /^\s*%%edit:begin\b((?:\s+\w+="[^"]*")*)\s*$/;
  const E_NEW = /^\s*%%edit:new\s*$/;
  const E_END = /^\s*%%edit:end\s*$/;
  const E_OLD = /^\s*%-(?: (.*)|)$/;

  // Each: { by, at, from, to, beginLine, newLine, endLine, oldLines: [text], newLines: [text] }.
  function parseEdits(doc) {
    const out = [];
    if (doc.length < 20) return out;
    let open = null;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const text = line.text;
      let m;
      if (!open) {
        if (text.indexOf('%%edit:begin') >= 0 && (m = E_BEGIN.exec(text))) {
          const a = attrs(m[1]);
          open = { by: a.by || '', at: a.at || '', ai: a.kind === 'ai', from: line.from, beginLine: n, newLine: 0, oldLines: [], newLines: [] };
        }
        continue;
      }
      if (!open.newLine) {
        if (E_NEW.test(text)) open.newLine = n;
        else if ((m = E_OLD.exec(text))) open.oldLines.push(m[1] || '');
        else open = null; // malformed: ignore the block
        continue;
      }
      if (E_END.test(text)) {
        open.endLine = n;
        open.to = line.to;
        out.push(open);
        open = null;
      } else if (E_BEGIN.test(text)) {
        open = null;
      } else {
        open.newLines.push(text);
      }
    }
    return out;
  }

  const editAt = (state, pos) => parseEdits(state.doc).find((b) => pos >= b.from && pos <= b.to) || null;

  function overlapsAny(doc, from, to) {
    return parse(doc).some((b) => from <= b.to && to >= b.from) || parseEdits(doc).some((b) => from <= b.to && to >= b.from);
  }

  // Ctrl+Shift+K: start an edit of the selected lines. The old text is kept
  // above, and the cursor goes to the copy below, which is what gets edited.
  // The selected lines, extended to whole lines: { first, last } or null.
  function selectedLines(state) {
    const sel = state.selection.main;
    const first = state.doc.lineAt(sel.from);
    let last = state.doc.lineAt(sel.to);
    if (sel.to > sel.from && sel.to === last.from && last.number > first.number) {
      last = state.doc.line(last.number - 1);
    }
    return { first, last, head: sel.head };
  }

  function createEdit(view) {
    if (!editable(view)) return false;
    const { state } = view;
    const { first, last, head: cursor } = selectedLines(state);
    if (editAt(state, cursor) || blockAt(state, cursor)) return true;
    if (overlapsAny(state.doc, first.from, last.to)) return true;
    const body = state.doc.sliceString(first.from, last.to);
    const old = body.split('\n').map((l) => (l.length ? `%- ${l}` : '%-')).join('\n');
    const head = `%%edit:begin by="${author()}" at="${now()}"\n${old}\n%%edit:new\n`;
    view.dispatch({
      changes: { from: first.from, to: last.to, insert: `${head}${body}\n%%edit:end` },
      selection: { anchor: first.from + head.length, head: first.from + head.length + body.length },
      userEvent: 'input.candidates',
    });
    view.focus();
    return true;
  }

  function settleEdit(view, pos, keepNew) {
    const block = editAt(view.state, pos);
    if (!block || !editable(view)) return;
    const lines = keepNew ? block.newLines : block.oldLines;
    view.dispatch({
      changes: { from: block.from, to: block.to, insert: lines.join('\n') },
      selection: { anchor: block.from },
      userEvent: 'input.candidates',
    });
    view.focus();
  }

  // ------------------------------------------------------- edit review ---
  //
  // Two kinds of reviewable changes:
  // - edit blocks (%%edit: comments in the source): made by people with
  //   Ctrl+Shift+K; shared with collaborators.
  // - AI suggestions: kept only on this computer (localStorage, per project)
  //   as { file, find, replace }. The source keeps the original text; the
  //   suggestion is drawn over it and written into the file on Accept.
  // Every item shows its place among all items of the project (‹ n/N ›);
  // Accept all / Reject all cover both kinds. Edit blocks in other files are
  // counted from the app's copy of the project (window.euphorbia.ai.listEdits).

  const reviewProject = (location.pathname.match(/^\/project\/([0-9a-f]{24})/) || [])[1] || null;
  const review = { files: [] }; // [{ path, count }] edit blocks per file, from the app copy
  let reviewViewRef = null;
  let countsEffect = null; // StateEffect, set once CodeMirror is known

  const nav = () => window.__olDesktopNav || null;
  const currentReviewPath = () => (nav() ? nav().currentPath() : '');
  const storeView = () => {
    try {
      return window.overleaf.unstable.store.get('editor.view');
    } catch {
      return null;
    }
  };
  const repaint = () => {
    if (typeof updateTopBar === 'function') updateTopBar();
    const v = reviewViewRef || storeView();
    if (v && countsEffect) v.dispatch({ effects: countsEffect.of(null) });
  };

  // ---- AI suggestions (local only)

  const PKEY = `ol-desktop-ai-suggestions:${reviewProject}`;
  function loadProposals() {
    try {
      const list = JSON.parse(localStorage.getItem(PKEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function saveProposals(list) {
    try {
      localStorage.setItem(PKEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
    repaint();
  }
  // The other split pane changed them.
  window.addEventListener('storage', (e) => {
    if (e.key === PKEY) repaint();
  });

  // Where `find` is in a document: { at, len } or { error }. Exact and unique
  // first, then whole lines with trailing spaces ignored.
  function locateText(doc, find) {
    if (!find) return { error: 'Nothing to find.' };
    const all = doc.toString();
    const i = all.indexOf(find);
    if (i >= 0 && all.indexOf(find, i + 1) < 0) return { at: i, len: find.length };
    if (i >= 0) return { error: 'The text to change appears more than once in the file.' };
    const norm = (t) => t.replace(/[ \t]+$/gm, '');
    const want = norm(find).split('\n');
    const lines = all.split('\n');
    const hits = [];
    for (let n = 0; n + want.length <= lines.length; n++) if (want.every((w, k) => norm(lines[n + k]) === w)) hits.push(n);
    if (hits.length === 1) {
      const at = doc.line(hits[0] + 1).from;
      return { at, len: doc.line(hits[0] + want.length).to - at };
    }
    return { error: hits.length ? 'The text to change appears more than once in the file.' : 'The original text is no longer in the file (it was changed).' };
  }

  // A suggestion placed in a document: whole-line span, original and new text.
  function placeProposal(doc, prop) {
    const hit = locateText(doc, prop.find);
    if (hit.error) return { error: hit.error };
    const first = doc.lineAt(hit.at);
    const last = doc.lineAt(hit.at + hit.len);
    const original = doc.sliceString(first.from, last.to);
    const updated = doc.sliceString(first.from, hit.at) + prop.replace + doc.sliceString(hit.at + hit.len, last.to);
    if (updated === original) return { error: 'The suggestion does not change anything.' };
    if (overlapsAny(doc, first.from, last.to)) return { error: 'That part of the file is inside an edit or candidates block.' };
    return { from: first.from, to: last.to, startLine: first.number, endLine: last.number, original, updated };
  }

  // Suggestions of this file that can be shown, in document order, without overlaps.
  function placedProposals(doc, path) {
    const out = [];
    for (const prop of loadProposals()) {
      if (prop.file !== path) continue;
      const pl = placeProposal(doc, prop);
      if (pl.error) continue;
      if (out.some((o) => pl.from <= o.to && pl.to >= o.from)) continue;
      out.push({ prop, ...pl });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  // Adds an AI edit: opens the file and writes it in as an AI edit block, so
  // its new text is what compiles until the user accepts or rejects it.
  async function addProposal({ file, find, replace, by }) {
    if (file !== currentReviewPath()) {
      if (!nav() || !(await nav().openPath(file))) return { ok: false, error: `Could not open ${file}.` };
    }
    const v = storeView();
    if (!v || !editable(v)) return { ok: false, error: 'The editor is not ready (or the file is read-only).' };
    return insertEdit(v, find, replace, by || 'AI', true);
  }

  // Suggestions kept on this computer by versions before 0.23 become AI edit
  // blocks when their file is open.
  function migrateProposals() {
    const list = loadProposals();
    if (!list.length) return;
    const v = storeView();
    const path = currentReviewPath();
    if (!v || !editable(v) || !path) return;
    const mine = list.filter((p) => p.file === path);
    if (!mine.length) return;
    for (const p of mine) insertEdit(v, p.find, p.replace, p.by || 'AI', true);
    const ids = new Set(mine.map((p) => p.id));
    try {
      localStorage.setItem(PKEY, JSON.stringify(list.filter((p) => !ids.has(p.id))));
    } catch {
      /* ignore */
    }
  }

  function dropProposals(ids) {
    const set = new Set(ids);
    saveProposals(loadProposals().filter((p) => !set.has(p.id)));
  }

  function settleProposal(view, id, keep) {
    const prop = loadProposals().find((p) => p.id === id);
    if (!prop) return;
    if (keep) {
      const pl = placeProposal(view.state.doc, prop);
      if (pl.error) {
        window.alert(`This suggestion cannot be applied: ${pl.error}`);
        return;
      }
      view.dispatch({ changes: { from: pl.from, to: pl.to, insert: pl.updated }, selection: { anchor: pl.from }, userEvent: 'input.candidates' });
    }
    dropProposals([id]);
    view.focus();
  }

  // Scrolls to a suggestion (used by the chat panel's edit cards).
  function revealProposal(id) {
    const v = storeView();
    const prop = loadProposals().find((p) => p.id === id);
    if (!v || !prop) return false;
    const pl = placeProposal(v.state.doc, prop);
    if (pl.error) return false;
    v.dispatch({ selection: { anchor: pl.from }, scrollIntoView: true });
    v.focus();
    return true;
  }

  // ---- both kinds together

  // Reviewable items of the open file in document order.
  function reviewItems(doc) {
    return parseEdits(doc).map((b) => ({ type: 'block', from: b.from, block: b }));
  }

  // Items per other file: edit blocks from the app copy plus local suggestions.
  function otherCounts() {
    const cur = currentReviewPath();
    const counts = new Map();
    for (const f of review.files) if (f.path !== cur) counts.set(f.path, (counts.get(f.path) || 0) + f.count);
    return counts;
  }

  // Position of item k of this file among all items in the project.
  function reviewPlace(local, k) {
    const cur = currentReviewPath();
    let before = 0;
    let after = 0;
    for (const [path, count] of otherCounts()) {
      if (path < cur) before += count;
      else after += count;
    }
    return { pos: before + k + 1, total: before + local + after, before, after };
  }

  async function refreshReview() {
    const ai = window.euphorbia && window.euphorbia.ai;
    if (!ai || !ai.listEdits || !reviewProject) return;
    try {
      const res = await ai.listEdits(reviewProject);
      if (!res || !res.ok) return;
      review.files = res.files;
    } catch {
      return;
    }
    repaint();
  }
  setInterval(() => {
    migrateProposals();
    refreshReview();
  }, 15000);
  setTimeout(() => {
    migrateProposals();
    refreshReview();
  }, 3000);

  function revealItem(view, item) {
    const line = item.type === 'block' ? Math.min(item.block.newLine + 1, view.state.doc.lines) : view.state.doc.lineAt(item.from).number;
    view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, scrollIntoView: true });
    view.focus();
  }

  // Moves `delta` (+1/-1) from item k of this file, into other files when needed.
  async function moveReview(view, k, delta) {
    const items = reviewItems(view.state.doc);
    const target = k + delta;
    if (target >= 0 && target < items.length) return revealItem(view, items[target]);
    if (!nav()) return;
    const cur = currentReviewPath();
    const others = Array.from(otherCounts()).filter(([, n]) => n > 0).map(([p]) => p).sort();
    const pathTo = delta > 0 ? others.find((p) => p > cur) || others[0] : others.slice().reverse().find((p) => p < cur) || others[others.length - 1];
    if (!pathTo) return;
    if (!(await nav().openPath(pathTo))) return;
    const v = storeView();
    const next = v ? reviewItems(v.state.doc) : [];
    if (next.length) revealItem(v, delta > 0 ? next[0] : next[next.length - 1]);
    refreshReview();
  }

  // AI edit blocks per file: the open file from the editor, the others from
  // the app's copy of the project.
  function aiCounts() {
    const cur = currentReviewPath();
    const counts = new Map();
    for (const f of review.files) if (f.path !== cur && f.ai) counts.set(f.path, f.ai);
    const v = storeView();
    if (v && cur) {
      const n = parseEdits(v.state.doc).filter((b) => b.ai).length;
      if (n) counts.set(cur, n);
    }
    return counts;
  }

  // Accepts or rejects every AI edit in the project (edit blocks made by
  // people are left alone), opening each file that has some.
  async function settleAllSuggestions(keep) {
    const counts = aiCounts();
    const total = Array.from(counts.values()).reduce((x, y) => x + y, 0);
    if (!total) return 0;
    const verb = keep ? 'Accept' : 'Reject';
    if (!window.confirm(`${verb} all ${total} AI edit(s) in ${counts.size} file(s)?${keep ? ' The new text is kept.' : ' The original text is kept.'}`)) return 0;
    const cur = currentReviewPath();
    const files = Array.from(counts.keys());
    const order = files.includes(cur) ? [cur, ...files.filter((f) => f !== cur)] : files;
    let done = 0;
    for (const f of order) {
      if (f !== currentReviewPath() && !(nav() && (await nav().openPath(f)))) continue;
      const v = storeView();
      if (!v || !editable(v)) continue;
      const blocks = parseEdits(v.state.doc).filter((bl) => bl.ai);
      if (!blocks.length) continue;
      v.dispatch({ changes: blocks.map((bl) => ({ from: bl.from, to: bl.to, insert: (keep ? bl.newLines : bl.oldLines).join('\n') })), userEvent: 'input.candidates' });
      done += blocks.length;
    }
    if (cur && currentReviewPath() !== cur && nav()) await nav().openPath(cur);
    setTimeout(refreshReview, 1500);
    return done;
  }

  // One bar above the editor while there are AI suggestions in the project.
  const topBar = document.createElement('div');
  topBar.className = 'ol-sugg-topbar ol-topbar';
  topBar.hidden = true;
  const topText = document.createElement('span');
  topText.className = 'ol-sugg-toptext';
  const topAccept = document.createElement('button');
  topAccept.type = 'button';
  topAccept.textContent = 'Accept all';
  topAccept.addEventListener('click', () => settleAllSuggestions(true));
  const topReject = document.createElement('button');
  topReject.type = 'button';
  topReject.textContent = 'Reject all';
  topReject.addEventListener('click', () => settleAllSuggestions(false));
  topAccept.className = 'ol-sugg-accept';
  topReject.className = 'ol-sugg-reject';

  // Files button: the files that have AI suggestions; a click opens one.
  const topFiles = document.createElement('button');
  topFiles.type = 'button';
  topFiles.className = 'ol-sugg-files';
  topFiles.textContent = 'Files \u25be';
  topFiles.title = 'Files with AI edits';
  const fileMenu = document.createElement('div');
  fileMenu.className = 'ol-sugg-filemenu';
  fileMenu.hidden = true;
  // Above the editor and its toolbar, so the list can drop over them.
  topBar.style.position = 'relative';
  topBar.style.zIndex = '30';

  async function openSuggestionFile(path) {
    fileMenu.hidden = true;
    if (path !== currentReviewPath()) {
      if (!nav() || !(await nav().openPath(path))) return;
    }
    const v = storeView();
    const first = v ? parseEdits(v.state.doc).find((bl) => bl.ai) : null;
    if (first) {
      v.dispatch({ selection: { anchor: v.state.doc.line(Math.min(first.newLine + 1, v.state.doc.lines)).from }, scrollIntoView: true });
      v.focus();
    }
  }

  function renderFileMenu() {
    fileMenu.textContent = '';
    const counts = aiCounts();
    const cur = currentReviewPath();
    for (const [path, n] of Array.from(counts).sort((a, b) => a[0].localeCompare(b[0]))) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ol-sugg-fileitem' + (path === cur ? ' current' : '');
      const name = document.createElement('span');
      name.textContent = path;
      const count = document.createElement('span');
      count.className = 'ol-sugg-filecount';
      count.textContent = String(n);
      item.append(name, count);
      item.addEventListener('click', () => openSuggestionFile(path));
      fileMenu.appendChild(item);
    }
  }

  topFiles.addEventListener('click', (e) => {
    e.stopPropagation();
    if (fileMenu.hidden) {
      renderFileMenu();
      // Fixed to the page, under the button, so no editor layer covers it.
      if (fileMenu.parentElement !== document.body) document.body.appendChild(fileMenu);
      const r = topFiles.getBoundingClientRect();
      fileMenu.style.top = `${r.bottom + 4}px`;
      fileMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 430))}px`;
    }
    fileMenu.hidden = !fileMenu.hidden;
  });
  fileMenu.addEventListener('mousedown', (e) => e.stopPropagation());
  window.addEventListener('mousedown', () => (fileMenu.hidden = true));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fileMenu.hidden = true;
  });

  topBar.append(topText, topFiles, topAccept, topReject);

  function updateTopBar() {
    const counts = aiCounts();
    const total = Array.from(counts.values()).reduce((x, y) => x + y, 0);
    topBar.hidden = !total;
    if (!total) {
      fileMenu.hidden = true;
      return;
    }
    if (!fileMenu.hidden) renderFileMenu();
    const files = counts.size;
    topText.textContent = `${total} AI edit${total > 1 ? 's' : ''} in ${files} file${files > 1 ? 's' : ''} waiting for review (the new text is what compiles)`;
  }

  function attachTopBar() {
    const editor = document.querySelector('.cm-editor');
    const holder = editor && editor.parentElement;
    const host = holder && holder.parentElement;
    if (!host) return;
    let n = topBar.parentElement === host ? topBar.nextElementSibling : null;
    while (n && n !== holder && n.classList.contains('ol-topbar')) n = n.nextElementSibling;
    if (n !== holder) host.insertBefore(topBar, holder);
    if (!topStyle.isConnected && document.head) document.head.appendChild(topStyle);
  }
  const topStyle = document.createElement('style');
  topStyle.textContent = `
    .ol-sugg-topbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 3px 10px;
      background: #ede5fb; color: #1b222c; border-bottom: 2px solid #8b5cf6; font: 12px system-ui, "Segoe UI", sans-serif; }
    .ol-sugg-topbar[hidden] { display: none; }
    .ol-sugg-toptext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ol-sugg-topbar button { font: inherit; border: 0; border-radius: 12px; padding: 1px 10px; cursor: pointer; color: #fff; white-space: nowrap; }
    .ol-sugg-topbar .ol-sugg-accept { background: #098842; }
    .ol-sugg-topbar .ol-sugg-reject { background: #b83a33; }
    .ol-sugg-topbar .ol-sugg-files { background: #fff; color: #4c1d95; border: 1px solid #a78bfa; }
    .ol-sugg-filemenu { position: fixed; z-index: 2147483000; font: 12px system-ui, "Segoe UI", sans-serif; min-width: 220px; max-width: 420px; max-height: 300px;
      overflow-y: auto; background: #fff; border: 1px solid #c4b5fd; border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.2); padding: 4px 0; }
    .ol-sugg-filemenu[hidden] { display: none; }
    .ol-sugg-fileitem { display: flex; width: 100%; justify-content: space-between; gap: 12px; text-align: left;
      background: none; color: #1b222c; border: 0; border-radius: 0; padding: 5px 12px; font: inherit; cursor: pointer; }
    .ol-sugg-fileitem:hover { background: #f1ecfb; }
    .ol-sugg-fileitem.current { font-weight: 600; }
    .ol-sugg-filecount { color: #6d28d9; }
  `;
  const startTopBar = () => {
    new MutationObserver(attachTopBar).observe(document.documentElement, { childList: true, subtree: true });
    attachTopBar();
    updateTopBar();
  };
  if (document.documentElement) startTopBar();
  else document.addEventListener('DOMContentLoaded', startTopBar);

  // ---------------------------------------------------------- AI edits ---
  //
  // Ctrl+K: ask for an instruction, send the selected lines to the AI model
  // configured in the app (File > AI Settings), and put the answer into an
  // edit block, so it can be accepted or rejected like any other edit.

  const aiBridge = () => window.euphorbia && window.euphorbia.ai;
  let aiPrompt = null; // the open prompt box, if any

  function aiEdit(view) {
    if (!editable(view) || !aiBridge()) return false;
    // Bibliography files are read-only for the AI.
    if (/\.bib$/i.test(currentFileName())) {
      window.alert('AI edits are turned off for .bib files: bibliography files are read-only for the AI.');
      return true;
    }
    const { state } = view;
    const { first, last, head } = selectedLines(state);
    if (editAt(state, head) || blockAt(state, head) || overlapsAny(state.doc, first.from, last.to)) return true;
    const original = state.doc.sliceString(first.from, last.to);
    if (!original.trim()) return true;
    openAiPrompt(view, first, last, original);
    return true;
  }

  function openAiPrompt(view, first, last, original) {
    closeAiPrompt();
    const box = document.createElement('div');
    box.className = 'ol-ai-prompt';
    const row = document.createElement('div');
    row.className = 'ol-ai-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Describe the change (Enter to run, Esc to cancel)';
    input.spellcheck = false;
    const model = document.createElement('select');
    model.className = 'ol-ai-model';
    model.title = 'Model';
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Edit';
    row.append(input, model, go);
    const status = document.createElement('div');
    status.className = 'ol-ai-status';
    box.append(row, status);

    const coords = view.coordsAtPos(first.from) || view.coordsAtPos(view.viewport.from);
    const content = view.contentDOM.getBoundingClientRect();
    box.style.left = `${Math.max(8, content.left + 8)}px`;
    box.style.width = `${Math.max(280, Math.min(640, content.width - 24))}px`;
    box.style.top = `${Math.max(8, (coords ? coords.top : content.top) - 64)}px`;
    document.body.appendChild(box);

    const lines = `${last.number - first.number + 1} line(s)`;
    aiBridge().info('edit').then((info) => {
      if (!info || !info.choices.length) {
        model.hidden = true;
        status.textContent = 'No AI model is set up yet.';
        addSettingsLink(status);
        return;
      }
      for (const c of info.choices) model.add(new Option(c.label, c.id, false, c.id === info.selected));
      if (!status.textContent) status.textContent = lines;
    });
    model.addEventListener('change', () => {
      aiBridge().select('edit', model.value);
      input.focus();
    });
    model.addEventListener('keydown', (e) => e.stopPropagation());

    let busy = false;
    const run = async () => {
      const instruction = input.value.trim();
      if (!instruction || busy) return;
      busy = true;
      input.disabled = true;
      go.disabled = true;
      status.textContent = 'Thinking\u2026';
      const doc = view.state.doc;
      model.disabled = true;
      const res = await aiBridge().edit({
        choiceId: model.value,
        instruction,
        selection: original,
        before: doc.sliceString(doc.line(Math.max(1, first.number - 20)).from, first.from),
        after: doc.sliceString(last.to, doc.line(Math.min(doc.lines, last.number + 20)).to),
        fileName: currentFileName(),
      });
      if (aiPrompt !== box) return; // cancelled meanwhile
      if (!res || !res.ok) {
        busy = false;
        input.disabled = false;
        go.disabled = false;
        model.disabled = false;
        status.textContent = (res && res.error) || 'Failed.';
        status.classList.add('ol-ai-error');
        if (/AI Settings/.test(status.textContent)) addSettingsLink(status);
        input.focus();
        return;
      }
      closeAiPrompt();
      applyAiResult(view, first.from, original, res.text, res.by);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') run();
      else if (e.key === 'Escape') closeAiPrompt(true);
    });
    go.addEventListener('click', run);
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    aiPrompt = box;
    aiPrompt.__view = view;
    input.focus();
  }

  function addSettingsLink(status) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'ol-ai-link';
    link.textContent = 'Open AI Settings';
    link.addEventListener('click', () => aiBridge().openSettings());
    status.appendChild(document.createTextNode(' '));
    status.appendChild(link);
  }

  function closeAiPrompt(refocus) {
    if (!aiPrompt) return;
    const view = aiPrompt.__view;
    aiPrompt.remove();
    aiPrompt = null;
    if (aiBridge()) aiBridge().cancel();
    if (refocus && view) view.focus();
  }
  window.addEventListener('mousedown', () => closeAiPrompt(false));
  const aiStyle = document.createElement('style');
  aiStyle.textContent = `
    .ol-ai-prompt { position: fixed; z-index: 2147483500; background: #fff; color: #1b222c; border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,.28); padding: 8px; font: 13px system-ui, "Segoe UI", sans-serif; }
    .ol-ai-row { display: flex; gap: 6px; }
    .ol-ai-row input { flex: 1; padding: 6px 8px; font: inherit; border: 1px solid #afb5c0; border-radius: 6px; outline: none; }
    .ol-ai-row input:focus { border-color: #098842; box-shadow: 0 0 0 1px #098842; }
    .ol-ai-row button { font: inherit; border: 0; border-radius: 16px; padding: 4px 14px; background: #098842; color: #fff; cursor: pointer; }
    .ol-ai-row button:disabled, .ol-ai-row input:disabled, .ol-ai-row select:disabled { opacity: .6; }
    .ol-ai-row select { max-width: 40%; font: inherit; font-size: 12px; border: 1px solid #afb5c0; border-radius: 6px; padding: 0 4px; background: #fff; }
    .ol-ai-status { font-size: 11px; color: #6b7280; margin-top: 5px; min-height: 14px; }
    .ol-ai-status.ol-ai-error { color: #b83a33; }
    .ol-ai-link { font: inherit; border: 0; background: none; color: #0f6fc5; padding: 0; cursor: pointer; text-decoration: underline; }
  `;
  const addAiStyle = () => { if (document.head && !aiStyle.isConnected) document.head.appendChild(aiStyle); };
  if (document.head) addAiStyle(); else document.addEventListener('DOMContentLoaded', addAiStyle);

  function currentFileName() {
    try {
      return window.overleaf.unstable.store.get('editor.open_doc_name') || '';
    } catch {
      return '';
    }
  }

  // The answer becomes an edit block. The lines may have moved while the
  // model was working: find the original text again before replacing it.
  function applyAiResult(view, from, original, text, by) {
    const doc = view.state.doc;
    let at = doc.sliceString(from, from + original.length) === original ? from : -1;
    if (at < 0) {
      const all = doc.toString();
      const i = all.indexOf(original);
      if (i >= 0 && all.indexOf(original, i + 1) < 0) at = i;
    }
    if (at < 0 || overlapsAny(doc, at, at + original.length)) {
      window.alert('The selected lines changed while the AI was working, so its answer was not inserted.');
      return;
    }
    const res = insertEdit(view, original, text, by, true);
    if (!res.ok) window.alert(`The AI suggestion was not added: ${res.error}`);
  }

  // Inserts an edit block replacing `find` with `replace` in the editor's
  // document. `find` must occur exactly once (an exact match first, then a
  // match that ignores trailing spaces). The block spans whole lines.
  function insertEdit(view, find, replace, by, ai = false) {
    const doc = view.state.doc;
    const all = doc.toString();
    const norm = (t) => t.replace(/[ \t]+$/gm, '');
    let at = -1;
    let len = 0;
    const i = all.indexOf(find);
    if (find && i >= 0 && all.indexOf(find, i + 1) < 0) {
      at = i;
      len = find.length;
    } else if (find) {
      // Retry on whole lines with trailing whitespace ignored.
      const want = norm(find).split('\n');
      const lines = all.split('\n');
      const hits = [];
      for (let n = 0; n + want.length <= lines.length; n++) {
        if (want.every((w, k) => norm(lines[n + k]) === w)) hits.push(n);
      }
      if (hits.length === 1) {
        at = doc.line(hits[0] + 1).from;
        len = doc.line(hits[0] + want.length).to - at;
      } else if (hits.length > 1) {
        return { ok: false, error: 'The text to change appears more than once in the file.' };
      }
    }
    if (at < 0) return { ok: false, error: 'The text to change was not found in the file (it may have changed).' };
    const first = doc.lineAt(at);
    const last = doc.lineAt(at + len);
    // Inside the new text of a waiting AI edit: revise that suggestion in place.
    const host = ai && parseEdits(doc).find((b) => b.ai && first.from <= b.to && last.to >= b.from);
    if (host) {
      const newFrom = doc.line(host.newLine + 1).from;
      const newTo = doc.line(host.endLine).from - 1;
      if (host.endLine === host.newLine + 1 || first.from < newFrom || last.to > newTo) {
        return { ok: false, error: 'That touches the markers or old lines of a suggested edit; edit only its new text.' };
      }
      if (replace === doc.sliceString(at, at + len)) return { ok: false, error: 'The edit does not change anything.' };
      view.dispatch({ changes: { from: at, to: at + len, insert: replace }, selection: { anchor: at }, scrollIntoView: true, userEvent: 'input.candidates' });
      return { ok: true, line: first.number, revised: true };
    }
    if (overlapsAny(doc, first.from, last.to)) return { ok: false, error: 'That part of the file is already inside an edit or candidates block.' };
    const original = doc.sliceString(first.from, last.to);
    const updated = doc.sliceString(first.from, at) + replace + doc.sliceString(at + len, last.to);
    if (updated === original) return { ok: false, error: 'The edit does not change anything.' };
    const old = original.split('\n').map((l) => (l.length ? `%- ${l}` : '%-')).join('\n');
    const head = `%%edit:begin by="${clean(by).slice(0, 80)}" at="${now()}"${ai ? ' kind="ai"' : ''}\n${old}\n%%edit:new\n`;
    view.dispatch({
      changes: { from: first.from, to: last.to, insert: `${head}${updated}\n%%edit:end` },
      selection: { anchor: first.from + head.length },
      scrollIntoView: true,
      userEvent: 'input.candidates',
    });
    return { ok: true, line: first.number };
  }
  window.__olDesktopEdits = { insertEdit, addProposal, revealProposal };

  // ------------------------------------------------------------ editor ---

  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      event.detail.extensions.push(buildExtension(event.detail.CodeMirror));
    } catch (err) {
      console.error('[euphorbia] candidates extension failed to load', err);
    }
  });

  function buildExtension(CM) {
    const { Decoration, EditorView, Prec, StateEffect, StateField, WidgetType, keymap } = CM;
    countsEffect = countsEffect || StateEffect.define();

    class BarWidget extends WidgetType {
      constructor(block) {
        super();
        this.names = block.options.map((o) => o.name);
        this.stamps = block.options.map((o) => stamp(o.by, o.at));
        this.active = block.active;
        this.key = `${block.id}|${this.active}|${this.names.join('\u0001')}|${this.stamps.join('\u0001')}`;
      }

      eq(other) {
        return other.key === this.key;
      }

      toDOM(view) {
        const bar = document.createElement('div');
        bar.className = 'ol-cand-bar';
        const pos = () => view.posAtDOM(bar);

        const label = document.createElement('span');
        label.className = 'ol-cand-label';
        label.textContent = 'Candidates';
        bar.appendChild(label);

        this.names.forEach((name, index) => {
          const chip = document.createElement('span');
          chip.className = 'ol-cand-chip' + (index === this.active ? ' ol-cand-active' : '');

          const pick = document.createElement('button');
          pick.type = 'button';
          pick.className = 'ol-cand-pick';
          pick.textContent = name || `Option ${index + 1}`;
          pick.title =
            (index === this.active ? 'Active' : 'Switch to this candidate') +
            ' (double-click to rename)' + (this.stamps[index] ? `\n${this.stamps[index]}` : '');
          let clickTimer = null;
          pick.addEventListener('click', () => {
            if (clickTimer) return;
            clickTimer = setTimeout(() => {
              clickTimer = null;
              selectOption(view, pos(), index);
            }, 220);
          });
          pick.addEventListener('dblclick', () => {
            clearTimeout(clickTimer);
            clickTimer = null;
            startRename(view, bar, chip, pick, index);
          });
          chip.appendChild(pick);

          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'ol-cand-del';
          del.textContent = '×';
          del.title = 'Delete this candidate';
          del.addEventListener('click', () => deleteOption(view, pos(), index));
          chip.appendChild(del);

          bar.appendChild(chip);
        });

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'ol-cand-tool';
        add.textContent = '+';
        add.title = 'Add a candidate (copy of the active one)';
        add.addEventListener('click', () => addOption(view, pos()));
        bar.appendChild(add);

        const meta = document.createElement('span');
        meta.className = 'ol-cand-meta';
        meta.textContent = this.stamps[this.active] || '';
        bar.appendChild(meta);

        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'ol-cand-tool ol-cand-done';
        done.textContent = 'Keep active';
        done.title = 'Keep the active candidate and remove the others';
        done.addEventListener('click', () => resolve(view, pos()));
        bar.appendChild(done);

        // Keep clicks from moving the editor selection into the folded lines.
        bar.addEventListener('mousedown', (e) => {
          if (e.target.tagName !== 'INPUT') e.preventDefault();
        });
        return bar;
      }

      ignoreEvent() {
        return true;
      }
    }

    function startRename(view, bar, chip, pick, index) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ol-cand-rename';
      input.value = pick.textContent;
      input.maxLength = 40;
      input.spellcheck = false;
      chip.replaceChild(input, pick);
      input.focus();
      input.select();
      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        const value = input.value;
        if (input.parentNode === chip) chip.replaceChild(pick, input);
        if (commit) renameOption(view, view.posAtDOM(bar), index, value);
        else view.focus();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    }

    class TailWidget extends WidgetType {
      eq() {
        return true;
      }

      toDOM() {
        const el = document.createElement('div');
        el.className = 'ol-cand-tail';
        return el;
      }

      ignoreEvent() {
        return true;
      }
    }

    // Header + old text, drawn as one widget so the old text cannot be edited.
    class EditHeadWidget extends WidgetType {
      constructor(block, k, place) {
        super();
        this.by = block.by;
        this.at = block.at;
        this.old = block.oldLines;
        this.empty = !block.newLines.length;
        this.k = k;
        this.place = place;
        this.ai = !!block.ai;
        this.key = `${this.ai}|${this.by}|${this.at}|${this.empty}|${k}|${place.pos}/${place.total}|${this.old.join('\n')}`;
      }

      eq(other) {
        return other.key === this.key;
      }

      toDOM(view) {
        const box = document.createElement('div');
        box.className = this.ai ? 'ol-edit-head ol-ai' : 'ol-edit-head';
        const pos = () => view.posAtDOM(box);

        const bar = document.createElement('div');
        bar.className = this.ai ? 'ol-edit-bar ol-sugg-bar' : 'ol-edit-bar';
        const label = document.createElement('span');
        label.className = 'ol-edit-label';
        label.textContent = this.ai ? 'AI edit' : 'Edit';
        bar.appendChild(label);
        const meta = document.createElement('span');
        meta.className = 'ol-edit-meta';
        meta.textContent = stamp(this.by, this.at);
        bar.appendChild(meta);
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'ol-edit-accept';
        accept.textContent = 'Accept';
        accept.title = 'Keep the new text and remove the old';
        accept.addEventListener('click', () => settleEdit(view, pos(), true));
        bar.appendChild(accept);
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'ol-edit-reject';
        reject.textContent = 'Reject';
        reject.title = 'Keep the old text and remove the new';
        reject.addEventListener('click', () => settleEdit(view, pos(), false));
        bar.appendChild(reject);

        const navBox = document.createElement('span');
        navBox.className = 'ol-edit-nav';
        const prev = document.createElement('button');
        prev.type = 'button';
        prev.textContent = '\u2039';
        prev.title = 'Previous edit';
        prev.disabled = this.place.pos <= 1;
        prev.addEventListener('click', () => moveReview(view, this.k, -1));
        const count = document.createElement('span');
        count.textContent = `${this.place.pos}/${this.place.total}`;
        count.title = 'This edit / all edits in the project';
        const next = document.createElement('button');
        next.type = 'button';
        next.textContent = '\u203a';
        next.title = 'Next edit';
        next.disabled = this.place.pos >= this.place.total;
        next.addEventListener('click', () => moveReview(view, this.k, 1));
        navBox.append(prev, count, next);
        bar.appendChild(navBox);

        bar.addEventListener('mousedown', (e) => e.preventDefault());
        box.appendChild(bar);

        for (const text of this.old) {
          const line = document.createElement('div');
          line.className = this.ai ? 'ol-edit-old ol-ai-old' : 'ol-edit-old';
          line.textContent = text || '\u200b';
          box.appendChild(line);
        }
        if (this.empty) {
          const note = document.createElement('div');
          note.className = 'ol-edit-note';
          note.textContent = '(all new text removed: accepting deletes these lines)';
          box.appendChild(note);
        }
        return box;
      }

      ignoreEvent() {
        return true;
      }
    }

    class EditTailWidget extends WidgetType {
      constructor(ai = false) {
        super();
        this.ai = ai;
      }

      eq(other) {
        return other.ai === this.ai;
      }

      toDOM() {
        const el = document.createElement('div');
        el.className = this.ai ? 'ol-edit-tail ol-ai-tail' : 'ol-edit-tail';
        return el;
      }

      ignoreEvent() {
        return true;
      }
    }

    // AI suggestion: header + suggested text, below the original lines.
    class SuggestionWidget extends WidgetType {
      constructor(placed, k, place) {
        super();
        this.id = placed.prop.id;
        this.by = placed.prop.by;
        this.at = placed.prop.at;
        this.lines = placed.updated.split('\n');
        this.k = k;
        this.place = place;
        this.key = `${this.id}|${k}|${place.pos}/${place.total}|${placed.updated}`;
      }

      eq(other) {
        return other.key === this.key;
      }

      toDOM(view) {
        const box = document.createElement('div');
        box.className = 'ol-sugg';
        const bar = document.createElement('div');
        bar.className = 'ol-edit-bar ol-sugg-bar';
        const meta = document.createElement('span');
        meta.className = 'ol-edit-meta';
        meta.textContent = stamp(this.by, this.at);
        meta.title = 'Only you see this suggestion until you accept it.';
        bar.appendChild(meta);
        const mk = (text, cls, title, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = cls;
          b.textContent = text;
          b.title = title;
          b.addEventListener('click', fn);
          return b;
        };
        bar.appendChild(mk('Accept', 'ol-edit-accept', 'Write this suggestion into the file', () => settleProposal(view, this.id, true)));
        bar.appendChild(mk('Reject', 'ol-edit-reject', 'Discard this suggestion', () => settleProposal(view, this.id, false)));
        const navBox = document.createElement('span');
        navBox.className = 'ol-edit-nav';
        const prev = mk('\u2039', '', 'Previous change', () => moveReview(view, this.k, -1));
        prev.disabled = this.place.pos <= 1;
        const count = document.createElement('span');
        count.textContent = `${this.place.pos}/${this.place.total}`;
        const next = mk('\u203a', '', 'Next change', () => moveReview(view, this.k, 1));
        next.disabled = this.place.pos >= this.place.total;
        navBox.append(prev, count, next);
        bar.appendChild(navBox);
        bar.addEventListener('mousedown', (e) => e.preventDefault());
        box.appendChild(bar);
        for (const text of this.lines) {
          const line = document.createElement('div');
          line.className = 'ol-sugg-line';
          line.textContent = text || '\u200b';
          box.appendChild(line);
        }
        return box;
      }

      ignoreEvent() {
        return true;
      }
    }
    const suggOldLine = Decoration.line({ class: 'ol-sugg-old' });

    const newLine = Decoration.line({ class: 'ol-edit-new' });
    const aiNewLine = Decoration.line({ class: 'ol-edit-new ol-ai-new' });

    const bodyLine = Decoration.line({ class: 'ol-cand-body' });

    function build(state) {
      const doc = state.doc;
      const ranges = [];
      for (const block of parse(doc)) {
        const bar = new BarWidget(block);
        if (!block.bodyFromLine) {
          // The active candidate is empty: the whole block folds into the bar.
          ranges.push(Decoration.replace({ widget: bar, block: true }).range(block.from, block.to));
          continue;
        }
        const headEnd = doc.line(block.bodyFromLine - 1).to;
        ranges.push(Decoration.replace({ widget: bar, block: true }).range(block.from, headEnd));
        for (let n = block.bodyFromLine; n <= block.bodyToLine; n++) {
          ranges.push(bodyLine.range(doc.line(n).from));
        }
        const tailFrom = doc.line(block.bodyToLine + 1).from;
        ranges.push(Decoration.replace({ widget: new TailWidget(), block: true }).range(tailFrom, block.to));
      }
      const items = reviewItems(doc);
      items.forEach((item, k) => {
        const place = reviewPlace(items.length, k);
        if (item.type === 'ai') {
          const pl = item.placed;
          for (let n = pl.startLine; n <= pl.endLine; n++) ranges.push(suggOldLine.range(doc.line(n).from));
          ranges.push(Decoration.widget({ widget: new SuggestionWidget(pl, k, place), block: true, side: 1 }).range(pl.to));
          return;
        }
        const block = item.block;
        const head = new EditHeadWidget(block, k, place);
        if (!block.newLines.length) {
          ranges.push(Decoration.replace({ widget: head, block: true }).range(block.from, block.to));
          return;
        }
        ranges.push(Decoration.replace({ widget: head, block: true }).range(block.from, doc.line(block.newLine).to));
        for (let n = block.newLine + 1; n < block.endLine; n++) ranges.push((block.ai ? aiNewLine : newLine).range(doc.line(n).from));
        ranges.push(Decoration.replace({ widget: new EditTailWidget(block.ai), block: true }).range(doc.line(block.endLine).from, block.to));
      });
      return Decoration.set(ranges, true);
    }

    const field = StateField.define({
      create: (state) => build(state),
      update: (value, tr) => (tr.docChanged || tr.effects.some((e) => e.is(countsEffect)) ? build(tr.state) : value),
      provide: (f) => [
        EditorView.decorations.from(f),
        EditorView.atomicRanges.of((view) => view.state.field(f, false) || Decoration.none),
      ],
    });
    // Keep a handle on the view for count refreshes.
    const viewTracker = CM.ViewPlugin.define((view) => {
      reviewViewRef = view;
      setTimeout(refreshReview, 500);
      return { destroy: () => (reviewViewRef === view ? (reviewViewRef = null) : null) };
    });

    const theme = EditorView.baseTheme({
      '.ol-cand-bar': {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 8px',
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
        fontSize: '12px',
        lineHeight: '1.4',
        borderLeft: '3px solid #098842',
        userSelect: 'none',
      },
      '&light .ol-cand-bar': { background: '#eef6f1', color: '#1b222c' },
      '&dark .ol-cand-bar': { background: '#1f2d27', color: '#e7e9ee' },
      '.ol-cand-label': { opacity: '0.65', marginRight: '2px' },
      '.ol-cand-chip': {
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: '12px',
        border: '1px solid rgba(128,128,128,0.45)',
        overflow: 'hidden',
      },
      '.ol-cand-chip.ol-cand-active': { background: '#098842', borderColor: '#098842', color: '#fff' },
      '.ol-cand-bar button': {
        font: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: '0',
        cursor: 'pointer',
        padding: '1px 8px',
      },
      '.ol-cand-bar button.ol-cand-del': { padding: '1px 6px 1px 2px', opacity: '0.6' },
      '.ol-cand-bar button.ol-cand-del:hover': { opacity: '1' },
      '.ol-cand-bar button.ol-cand-tool': {
        borderRadius: '12px',
        border: '1px dashed rgba(128,128,128,0.6)',
      },
      '.ol-cand-bar button.ol-cand-done': { marginLeft: 'auto', borderStyle: 'solid' },
      '.ol-cand-bar button.ol-cand-tool:hover, .ol-cand-chip:not(.ol-cand-active):hover': {
        background: 'rgba(128,128,128,0.18)',
      },
      '.ol-cand-rename': {
        font: 'inherit',
        width: '9em',
        margin: '0',
        padding: '0 6px',
        border: '0',
        outline: 'none',
        color: '#1b222c',
        background: '#fff',
      },
      '.ol-cand-meta': { marginLeft: 'auto', fontSize: '11px', opacity: '0.6' },
      '.ol-cand-meta + button.ol-cand-done': { marginLeft: '0' },
      '.ol-edit-head': { borderLeft: '3px solid #c0392b', userSelect: 'none' },
      '.ol-edit-bar': {
        display: 'flex',
        flexWrap: 'wrap',
        rowGap: '3px',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
        fontSize: '12px',
        lineHeight: '1.4',
      },
      '&light .ol-edit-bar': { background: '#f6f1ee', color: '#1b222c' },
      '&dark .ol-edit-bar': { background: '#2d2624', color: '#e7e9ee' },
      '.ol-edit-label': { fontWeight: '600', opacity: '0.75' },
      '.ol-edit-meta': { fontSize: '11px', opacity: '0.6', marginRight: 'auto' },
      '.ol-edit-bar button': {
        whiteSpace: 'nowrap',
        font: 'inherit',
        border: '0',
        borderRadius: '12px',
        padding: '1px 10px',
        cursor: 'pointer',
        color: '#fff',
      },
      '.ol-edit-bar button.ol-edit-accept': { background: '#098842' },
      '.ol-edit-bar button.ol-edit-reject': { background: '#b83a33' },
      '.ol-sugg': { borderLeft: '3px solid #6d28d9', userSelect: 'none' },
      '.ol-edit-nav, .ol-edit-all': { whiteSpace: 'nowrap', flex: '0 0 auto' },
      '.ol-sugg-bar .ol-edit-meta': { flex: '1 1 160px', minWidth: '0' },
      '&light .ol-sugg-bar': { background: '#f1ecfb', color: '#1b222c' },
      '&dark .ol-sugg-bar': { background: '#2a2340', color: '#e7e9ee' },
      '.ol-sugg-bar .ol-edit-label': { color: '#6d28d9' },
      '&dark .ol-sugg-bar .ol-edit-label': { color: '#c4b5fd' },
      '.ol-sugg-line': { padding: '0 2px 0 6px', whiteSpace: 'pre-wrap' },
      '&light .ol-sugg-line': { background: 'rgba(37, 99, 235, 0.12)' },
      '&dark .ol-sugg-line': { background: 'rgba(59, 130, 246, 0.22)' },
      '&light .ol-sugg-old, &light .ol-sugg-old.cm-activeLine': { background: 'rgba(124, 58, 237, 0.10)' },
      '&dark .ol-sugg-old, &dark .ol-sugg-old.cm-activeLine': { background: 'rgba(167, 139, 250, 0.14)' },
      '.ol-sugg-old': { borderLeft: '3px solid #8b5cf6' },
      '.ol-edit-nav': { display: 'inline-flex', alignItems: 'center', gap: '2px', marginLeft: '6px', fontSize: '11px', opacity: '0.85' },
      '.ol-edit-bar .ol-edit-nav button': { background: 'transparent', color: 'inherit', padding: '0 5px', fontSize: '14px', lineHeight: '1' },
      '.ol-edit-bar .ol-edit-nav button:disabled': { opacity: '0.3', cursor: 'default' },
      '.ol-edit-all': { display: 'inline-flex', gap: '4px', marginLeft: '4px' },
      '.ol-edit-bar .ol-edit-all button': { background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,0.5)', padding: '0 8px' },
      '.ol-edit-old': {
        padding: '0 2px 0 6px',
        whiteSpace: 'pre-wrap',
        textDecoration: 'line-through',
        textDecorationColor: 'rgba(184,58,51,0.55)',
      },
      '&light .ol-edit-old': { background: 'rgba(220, 53, 69, 0.14)' },
      '&dark .ol-edit-old': { background: 'rgba(220, 53, 69, 0.24)' },
      '.ol-edit-note': { padding: '0 8px', fontSize: '11px', opacity: '0.7', fontFamily: 'system-ui, sans-serif' },
      '&light .ol-edit-new, &light .ol-edit-new.cm-activeLine': { background: 'rgba(9, 136, 66, 0.14)' },
      '&dark .ol-edit-new, &dark .ol-edit-new.cm-activeLine': { background: 'rgba(9, 136, 66, 0.26)' },
      '.ol-edit-new': { borderLeft: '3px solid #098842' },
      '.ol-edit-tail': { height: '3px', borderLeft: '3px solid #098842', opacity: '0.5' },
      '.ol-cand-body': { borderLeft: '3px solid #098842' },
      // AI edits: purple for the old text, blue for the new.
      '.ol-edit-head.ol-ai': { borderLeft: '3px solid #6d28d9' },
      '.ol-ai-old': { textDecorationColor: 'rgba(109,40,217,0.55)' },
      '&light .ol-ai-old': { background: 'rgba(124, 58, 237, 0.10)' },
      '&dark .ol-ai-old': { background: 'rgba(167, 139, 250, 0.14)' },
      '.ol-edit-new.ol-ai-new': { borderLeft: '3px solid #2563eb' },
      '&light .ol-edit-new.ol-ai-new, &light .ol-edit-new.ol-ai-new.cm-activeLine': { background: 'rgba(37, 99, 235, 0.12)' },
      '&dark .ol-edit-new.ol-ai-new, &dark .ol-edit-new.ol-ai-new.cm-activeLine': { background: 'rgba(59, 130, 246, 0.22)' },
      '.ol-edit-tail.ol-ai-tail': { borderLeft: '3px solid #2563eb' },
      '.ol-cand-tail': { height: '3px', borderLeft: '3px solid #098842', opacity: '0.5' },
    });

    return [
      field,
      viewTracker,
      theme,
      Prec.highest(
        keymap.of([
          { key: 'Mod-Shift-i', run: createOrAdd, preventDefault: true },
          { key: 'Mod-Shift-k', run: createEdit, preventDefault: true },
          { key: 'Mod-k', run: aiEdit, preventDefault: true },
        ])
      ),
    ];
  }
})();
