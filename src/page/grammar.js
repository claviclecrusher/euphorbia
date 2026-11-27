// Runs in the Overleaf page. Grammar check: the toolbar button (or
// Ctrl+Shift+G) checks every prose sentence of the open file, one sentence at
// a time without the rest of the paper, and marks the wrong words in red. A
// bar above the editor shows the count with ‹ n/N › and × (which turns the
// check off). While it is on, sentences you edit are checked again after a
// short pause; a mark goes away as soon as its text changes.
(() => {
  if (window.__euphorbiaGrammar) return;
  window.__euphorbiaGrammar = true;
  const PANE = window.__olDesktopPane || 0;
  const ai = window.euphorbia && window.euphorbia.ai;
  if (!ai || !ai.grammar) return;

  let CM = null;
  let setMarks = null; // StateEffect
  let on = false;
  let views = new Set();
  const cache = new Map(); // sentence text -> errors [{ wrong, fix, why }]
  const pending = new Set(); // sentence texts being checked
  let errors = []; // current marks of the open file: { from, to, fix, why }
  let at = -1;

  const view = () => window.overleaf && window.overleaf.unstable && window.overleaf.unstable.store.get('editor.view');

  // ---- prose sentences of a document: { text, from }
  const SKIP_ENVS = /^(equation|align|gather|multline|eqnarray|displaymath|math|verbatim|lstlisting|minted|tabular|tikzpicture|figure\*?|table\*?|algorithm|algorithmic)\*?$/;
  function sentences(doc) {
    const out = [];
    let skip = 0;
    let para = null; // { from, text }
    const flush = () => {
      if (!para) return;
      const t = para.text;
      const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
      let m;
      while ((m = re.exec(t))) {
        const raw = m[0];
        const lead = raw.length - raw.trimStart().length;
        const s = raw.trim();
        if (s.split(/\s+/).length >= 4 && /[a-zA-Z]{3,}/.test(s.replace(/\\[a-zA-Z]+/g, ''))) out.push({ text: s, from: para.from + m.index + lead });
        if (!m[0]) break;
      }
      para = null;
    };
    for (let n = 1; n <= doc.lines; n++) {
      const l = doc.line(n);
      const text = l.text;
      const b = /\\begin\{([^}]+)\}/.exec(text);
      const e = /\\end\{([^}]+)\}/.exec(text);
      if (b && SKIP_ENVS.test(b[1])) skip++;
      const skipped = skip > 0;
      if (e && SKIP_ENVS.test(e[1])) skip = Math.max(0, skip - 1);
      const t = text.trim();
      if (skipped || !t || t.startsWith('%') || /^\\(begin|end|section|subsection|subsubsection|paragraph|label|item\s*$|documentclass|usepackage|title|author|maketitle|bibliography|newcommand|def|input|include|caption|centering)\b/.test(t) && !/[.!?]\s*$/.test(t)) {
        flush();
        continue;
      }
      // strip a trailing comment
      const cut = text.search(/(?<!\\)%/);
      const body = cut >= 0 ? text.slice(0, cut) : text;
      if (!para) para = { from: l.from, text: body };
      else para.text += ' ' + body; // one char stands for the line break
    }
    flush();
    return out;
  }

  // ---- marks
  function paint() {
    if (!setMarks || !CM) return;
    const v = view();
    if (!v) return;
    const ranges = on
      ? errors.filter((e) => e.to <= v.state.doc.length).map((e) => CM.Decoration.mark({ class: 'ol-gram', attributes: { title: `${e.fix ? `→ ${e.fix}` : ''}${e.why ? `  (${e.why})` : ''}` } }).range(e.from, e.to))
      : [];
    v.dispatch({ effects: setMarks.of(CM.Decoration.set(ranges, true)) });
    updateBar();
  }

  // Marks for the sentences of the document, from the cache.
  function collect(doc) {
    const out = [];
    for (const s of sentences(doc)) {
      for (const e of cache.get(s.text) || []) {
        let i = s.text.indexOf(e.wrong);
        if (i < 0) continue;
        out.push({ from: s.from + i, to: s.from + i + e.wrong.length, fix: e.fix, why: e.why });
      }
    }
    return out.sort((a, b) => a.from - b.from);
  }

  async function checkAll(onlyNew) {
    const v = view();
    if (!v || !on) return;
    const list = sentences(v.state.doc).map((s) => s.text).filter((t) => !cache.has(t) && !pending.has(t));
    if (onlyNew && !list.length) return;
    if (!onlyNew) setText(list.length ? `Checking ${list.length} sentence(s)…` : null);
    const BATCH = 16;
    const batches = [];
    for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
    for (const b of batches) for (const t of b) pending.add(t);
    // a few requests at once, so a long file is fast
    let next = 0;
    const worker = async () => {
      while (next < batches.length && on) {
        const b = batches[next++];
        const res = await ai.grammar(b);
        for (const t of b) pending.delete(t);
        if (!on || (res && res.cancelled)) return;
        if (!res || !res.ok) {
          setText(res && res.error ? `Grammar check failed: ${res.error}` : 'Grammar check failed.');
          continue;
        }
        b.forEach((t) => cache.set(t, []));
        for (const e of res.errors) cache.get(b[e.n]).push(e);
        const w = view();
        if (w && on) {
          errors = collect(w.state.doc);
          paint();
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (on) setText(null);
  }

  // ---- bar
  const bar = document.createElement('div');
  bar.className = 'ol-gram-bar ol-topbar';
  bar.hidden = true;
  const barText = document.createElement('span');
  barText.className = 'ol-gram-text';
  const prev = document.createElement('button');
  prev.textContent = '‹';
  prev.title = 'Previous error';
  const pos = document.createElement('span');
  const nxt = document.createElement('button');
  nxt.textContent = '›';
  nxt.title = 'Next error';
  const close = document.createElement('button');
  close.className = 'ol-gram-close';
  close.textContent = '×';
  close.title = 'Turn the grammar check off';
  for (const b of [prev, nxt, close]) {
    b.type = 'button';
    b.addEventListener('mousedown', (e) => e.preventDefault());
  }
  bar.append(barText, prev, pos, nxt, close);
  let note = null;
  const setText = (t) => {
    note = t;
    updateBar();
  };
  function updateBar() {
    bar.hidden = !on;
    if (!on) return;
    const n = errors.length;
    barText.textContent = note || (n ? `${n} grammar issue${n === 1 ? '' : 's'}` : 'No grammar issues found');
    const v = view();
    const head = v ? v.state.selection.main.head : 0;
    const k = errors.findIndex((e) => head >= e.from && head <= e.to);
    if (k >= 0) at = k;
    pos.textContent = n ? `${k >= 0 ? k + 1 : '–'}/${n}` : '';
    prev.disabled = nxt.disabled = !n;
  }
  function go(delta) {
    const v = view();
    if (!v || !errors.length) return;
    const head = v.state.selection.main.head;
    let k;
    if (delta > 0) k = errors.findIndex((e) => e.from > head);
    else k = errors.map((e) => e.to < head).lastIndexOf(true);
    if (k < 0) k = delta > 0 ? 0 : errors.length - 1;
    const e = errors[k];
    v.dispatch({ selection: { anchor: e.from, head: e.to }, scrollIntoView: true });
    v.focus();
  }
  prev.addEventListener('click', () => go(-1));
  nxt.addEventListener('click', () => go(1));
  close.addEventListener('click', () => toggle(false));

  function attachBar() {
    const editor = document.querySelector('.cm-editor');
    const holder = editor && editor.parentElement;
    const host = holder && holder.parentElement;
    if (!host) return;
    let n = bar.parentElement === host ? bar.nextElementSibling : null;
    while (n && n !== holder && n.classList.contains('ol-topbar')) n = n.nextElementSibling;
    if (n !== holder) host.insertBefore(bar, holder);
  }

  // ---- on / off
  const buttons = new Set();
  function toggle(want) {
    on = typeof want === 'boolean' ? want : !on;
    for (const b of buttons) b.classList.toggle('active', on);
    if (!on) {
      errors = [];
      note = null;
      pending.clear();
      clearTimeout(timer);
      if (ai.grammarCancel) ai.grammarCancel(); // stop the requests still running
    }
    attachBar();
    paint();
    if (on) checkAll(false);
    return true;
  }
  window.__euphorbiaGrammarToggle = toggle;

  function addButton() {
    if (PANE !== 1) return;
    for (const group of document.querySelectorAll('.ol-cm-toolbar .ol-cm-toolbar-end')) {
      if (group.querySelector('.ol-gram-toggle')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ol-cm-toolbar-button ol-gram-toggle' + (on ? ' active' : '');
      b.title = `Grammar check (${/Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+Shift+G)`;
      b.setAttribute('aria-label', 'Grammar check');
      b.textContent = 'Aa';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => toggle());
      group.insertBefore(b, group.firstChild);
      buttons.add(b);
    }
  }

  // ---- editor extension
  let timer = null;
  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      CM = event.detail.CodeMirror;
      const { StateEffect, StateField, EditorView, Decoration, keymap, Prec } = CM;
      setMarks = setMarks || StateEffect.define();
      const field = StateField.define({
        create: () => Decoration.none,
        update(value, tr) {
          let v = value;
          if (tr.docChanged) {
            // a mark whose text was touched goes away
            const touched = [];
            tr.changes.iterChangedRanges((fa, ta) => touched.push([fa, ta]));
            v = v.update({ filter: (from, to) => !touched.some(([a, b]) => a <= to && b >= from) }).map(tr.changes);
          }
          for (const e of tr.effects) if (e.is(setMarks)) v = e.value;
          return v;
        },
        provide: (f) => EditorView.decorations.from(f),
      });
      event.detail.extensions.push(
        field,
        EditorView.updateListener.of((u) => {
          if (!on) return;
          if (u.docChanged) {
            // keep the list in step with the marks that are still there
            const set = u.state.field(field);
            const next = [];
            set.between(0, u.state.doc.length, (from, to, d) => {
              const t = (d.spec.attributes && d.spec.attributes.title) || '';
              const m = /→ ([^(]*?)\s*(?:\(|$)/.exec(t);
              next.push({ from, to, fix: m ? m[1].trim() : '', why: '' });
            });
            errors = next;
            updateBar();
            clearTimeout(timer);
            timer = setTimeout(() => checkAll(true), 900);
          } else if (u.selectionSet) updateBar();
        }),
        CM.ViewPlugin.define((v) => {
          views.add(v);
          return { destroy: () => views.delete(v) };
        }),
        EditorView.baseTheme({
          '.ol-gram': { textDecoration: 'underline wavy rgba(184,58,51,0.9)', textDecorationSkipInk: 'none', borderRadius: '2px' },
          '&light .ol-gram': { background: 'rgba(220, 53, 69, 0.22)' },
          '&dark .ol-gram': { background: 'rgba(220, 53, 69, 0.38)' },
        }),
        Prec.highest(keymap.of([{ key: 'Mod-Shift-g', run: () => toggle(), preventDefault: true }]))
      );
    } catch (err) {
      console.error('[euphorbia] grammar check failed to load', err);
    }
  });

  // A different file opened: check it (its sentences may be cached already).
  window.addEventListener('doc:after-opened', () => {
    if (!on) return;
    setTimeout(() => {
      const v = view();
      if (!v) return;
      errors = collect(v.state.doc);
      paint();
      checkAll(false);
    }, 400);
  });

  const style = document.createElement('style');
  style.textContent = `
    .ol-gram-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 3px 10px;
      background: #fdecea; color: #1b222c; border-bottom: 2px solid #d9534f; font: 12px system-ui, "Segoe UI", sans-serif; }
    .ol-gram-bar[hidden] { display: none; }
    .ol-gram-text { flex: 1; }
    .ol-gram-bar button { font: inherit; border: 0; background: none; cursor: pointer; color: #8a1f1a; padding: 0 6px; font-size: 15px; line-height: 1; }
    .ol-gram-bar button:disabled { opacity: .3; cursor: default; }
    .ol-gram-toggle { font: 600 13px system-ui, sans-serif !important; min-width: 28px; }
    .ol-gram-toggle.active { background: rgba(217,83,79,.2) !important; color: #c0392b !important; border-radius: 4px; }
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
