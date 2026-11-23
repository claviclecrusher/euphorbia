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
  if (window.__overleafDesktopCandidates) return;
  window.__overleafDesktopCandidates = true;

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
          open = { by: a.by || '', at: a.at || '', from: line.from, beginLine: n, newLine: 0, oldLines: [], newLines: [] };
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
  // Every edit block shows its place among all edit blocks of the project
  // (\u2039 n/N \u203a) and can accept or reject all of them. Blocks in this file
  // are counted live; other files come from the app's copy of the project
  // (window.overleafDesktop.ai.listEdits). Moving to another file goes through
  // the chat panel's file opener (window.__olDesktopNav).

  const reviewProject = (location.pathname.match(/^\/project\/([0-9a-f]{24})/) || [])[1] || null;
  const review = { files: [], path: '' }; // files: [{ path, count }] from the app copy
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

  // Position of block k of this file among all blocks in the project.
  function reviewPlace(local, k) {
    const cur = currentReviewPath();
    let before = 0;
    let after = 0;
    for (const f of review.files) {
      if (f.path === cur) continue;
      if (f.path < cur) before += f.count;
      else after += f.count;
    }
    return { pos: before + k + 1, total: before + local + after, before, after };
  }

  async function refreshReview() {
    const ai = window.overleafDesktop && window.overleafDesktop.ai;
    if (!ai || !ai.listEdits || !reviewProject) return;
    try {
      const res = await ai.listEdits(reviewProject);
      if (!res || !res.ok) return;
      review.files = res.files;
    } catch {
      return;
    }
    const v = reviewViewRef || storeView();
    if (v && countsEffect) v.dispatch({ effects: countsEffect.of(null) });
  }
  setInterval(refreshReview, 15000);
  setTimeout(refreshReview, 3000);

  function revealBlock(view, block) {
    const anchor = view.state.doc.line(Math.min(block.newLine + 1, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  }

  // Moves `delta` (+1/-1) from block k of this file, into other files when needed.
  async function moveReview(view, k, delta) {
    const local = parseEdits(view.state.doc);
    const target = k + delta;
    if (target >= 0 && target < local.length) return revealBlock(view, local[target]);
    if (!nav()) return;
    const cur = currentReviewPath();
    const others = review.files.filter((f) => f.count > 0 && f.path !== cur).map((f) => f.path).sort();
    const pathTo = delta > 0 ? others.find((p) => p > cur) || others[0] : others.slice().reverse().find((p) => p < cur) || others[others.length - 1];
    if (!pathTo) return;
    if (!(await nav().openPath(pathTo))) return;
    const v = storeView();
    const blocks = v ? parseEdits(v.state.doc) : [];
    if (blocks.length) revealBlock(v, delta > 0 ? blocks[0] : blocks[blocks.length - 1]);
    refreshReview();
  }

  function settleAllIn(view, keepNew) {
    const blocks = parseEdits(view.state.doc);
    if (!blocks.length || !editable(view)) return 0;
    view.dispatch({
      changes: blocks.map((b) => ({ from: b.from, to: b.to, insert: (keepNew ? b.newLines : b.oldLines).join('\n') })),
      userEvent: 'input.candidates',
    });
    return blocks.length;
  }

  // Accepts or rejects every edit block in the project, file by file.
  async function settleAll(view, keepNew) {
    const local = parseEdits(view.state.doc).length;
    const cur = currentReviewPath();
    const others = review.files.filter((f) => f.count > 0 && f.path !== cur);
    const total = local + others.reduce((n, f) => n + f.count, 0);
    const files = (local ? 1 : 0) + others.length;
    const verb = keepNew ? 'Accept' : 'Reject';
    if (!window.confirm(`${verb} all ${total} edit(s) in ${files} file(s)?${keepNew ? '' : ' The original text is kept.'}`)) return;
    let done = settleAllIn(view, keepNew);
    if (others.length && nav()) {
      for (const f of others) {
        if (!(await nav().openPath(f.path))) continue;
        const v = storeView();
        if (v) done += settleAllIn(v, keepNew);
      }
      if (cur) await nav().openPath(cur);
    }
    review.files = review.files.map((f) => ({ ...f, count: 0 }));
    const v = storeView();
    if (v && countsEffect) v.dispatch({ effects: countsEffect.of(null) });
    setTimeout(refreshReview, 1500);
    return done;
  }

  // ---------------------------------------------------------- AI edits ---
  //
  // Ctrl+K: ask for an instruction, send the selected lines to the AI model
  // configured in the app (File > AI Settings), and put the answer into an
  // edit block, so it can be accepted or rejected like any other edit.

  const aiBridge = () => window.overleafDesktop && window.overleafDesktop.ai;
  let aiPrompt = null; // the open prompt box, if any

  function aiEdit(view) {
    if (!editable(view) || !aiBridge()) return false;
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
    const old = original.split('\n').map((l) => (l.length ? `%- ${l}` : '%-')).join('\n');
    const head = `%%edit:begin by="${clean(by).slice(0, 80)}" at="${now()}"\n${old}\n%%edit:new\n`;
    view.dispatch({
      changes: { from: at, to: at + original.length, insert: `${head}${text}\n%%edit:end` },
      selection: { anchor: at + head.length },
      userEvent: 'input.candidates',
    });
    view.focus();
  }

  // Inserts an edit block replacing `find` with `replace` in the editor's
  // document. `find` must occur exactly once (an exact match first, then a
  // match that ignores trailing spaces). The block spans whole lines.
  function insertEdit(view, find, replace, by) {
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
    if (overlapsAny(doc, first.from, last.to)) return { ok: false, error: 'That part of the file is already inside an edit or candidates block.' };
    const original = doc.sliceString(first.from, last.to);
    const updated = doc.sliceString(first.from, at) + replace + doc.sliceString(at + len, last.to);
    if (updated === original) return { ok: false, error: 'The edit does not change anything.' };
    const old = original.split('\n').map((l) => (l.length ? `%- ${l}` : '%-')).join('\n');
    const head = `%%edit:begin by="${clean(by).slice(0, 80)}" at="${now()}"\n${old}\n%%edit:new\n`;
    view.dispatch({
      changes: { from: first.from, to: last.to, insert: `${head}${updated}\n%%edit:end` },
      selection: { anchor: first.from + head.length },
      scrollIntoView: true,
      userEvent: 'input.candidates',
    });
    return { ok: true, line: first.number };
  }
  window.__olDesktopEdits = { insertEdit };

  // ------------------------------------------------------------ editor ---

  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      event.detail.extensions.push(buildExtension(event.detail.CodeMirror));
    } catch (err) {
      console.error('[overleaf-desktop] candidates extension failed to load', err);
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
        this.key = `${this.by}|${this.at}|${this.empty}|${k}|${place.pos}/${place.total}|${this.old.join('\n')}`;
      }

      eq(other) {
        return other.key === this.key;
      }

      toDOM(view) {
        const box = document.createElement('div');
        box.className = 'ol-edit-head';
        const pos = () => view.posAtDOM(box);

        const bar = document.createElement('div');
        bar.className = 'ol-edit-bar';
        const label = document.createElement('span');
        label.className = 'ol-edit-label';
        label.textContent = 'Edit';
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

        if (this.place.total > 1) {
          const all = document.createElement('span');
          all.className = 'ol-edit-all';
          const acceptAll = document.createElement('button');
          acceptAll.type = 'button';
          acceptAll.textContent = 'Accept all';
          acceptAll.title = 'Accept every edit in the project';
          acceptAll.addEventListener('click', () => settleAll(view, true));
          const rejectAll = document.createElement('button');
          rejectAll.type = 'button';
          rejectAll.textContent = 'Reject all';
          rejectAll.title = 'Reject every edit in the project';
          rejectAll.addEventListener('click', () => settleAll(view, false));
          all.append(acceptAll, rejectAll);
          bar.appendChild(all);
        }
        bar.addEventListener('mousedown', (e) => e.preventDefault());
        box.appendChild(bar);

        for (const text of this.old) {
          const line = document.createElement('div');
          line.className = 'ol-edit-old';
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
      eq() {
        return true;
      }

      toDOM() {
        const el = document.createElement('div');
        el.className = 'ol-edit-tail';
        return el;
      }

      ignoreEvent() {
        return true;
      }
    }

    const newLine = Decoration.line({ class: 'ol-edit-new' });

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
      const edits = parseEdits(doc);
      edits.forEach((block, k) => {
        const head = new EditHeadWidget(block, k, reviewPlace(edits.length, k));
        if (!block.newLines.length) {
          ranges.push(Decoration.replace({ widget: head, block: true }).range(block.from, block.to));
          return;
        }
        ranges.push(Decoration.replace({ widget: head, block: true }).range(block.from, doc.line(block.newLine).to));
        for (let n = block.newLine + 1; n < block.endLine; n++) ranges.push(newLine.range(doc.line(n).from));
        ranges.push(Decoration.replace({ widget: new EditTailWidget(), block: true }).range(doc.line(block.endLine).from, block.to));
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
        font: 'inherit',
        border: '0',
        borderRadius: '12px',
        padding: '1px 10px',
        cursor: 'pointer',
        color: '#fff',
      },
      '.ol-edit-bar button.ol-edit-accept': { background: '#098842' },
      '.ol-edit-bar button.ol-edit-reject': { background: '#b83a33' },
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
