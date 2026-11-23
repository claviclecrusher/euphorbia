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
// the active text. Overleaf hands out its CodeMirror objects through the
// (unsupported) UNSTABLE_editor:extensions event.
(() => {
  if (window.__overleafDesktopCandidates) return;
  window.__overleafDesktopCandidates = true;

  const BEGIN = /^\s*%%cand:begin\b(?:\s+id=([\w-]+))?\s*$/;
  const OPTION = /^\s*%%cand:option\b(?:\s+name="([^"]*)")?(\s+active)?\s*$/;
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
        open.current = { name: m[1] || '', active: !!m[2], headerLine: n, raw: [] };
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
      out.push(`%%cand:option name="${o.name.replace(/"/g, "'")}"${active ? ' active' : ''}`);
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
    const overlaps = parse(state.doc).some((b) => first.from <= b.to && last.to >= b.from);
    if (overlaps) return true; // no nesting
    const body = state.doc.sliceString(first.from, last.to);
    const text =
      `%%cand:begin id=${newId()}\n%%cand:option name="A" active\n${body}\n%%cand:end`;
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
    block.options.push({ name: nextName(block.options), lines: current.lines.slice() });
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

  // ------------------------------------------------------------ editor ---

  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      event.detail.extensions.push(buildExtension(event.detail.CodeMirror));
    } catch (err) {
      console.error('[overleaf-desktop] candidates extension failed to load', err);
    }
  });

  function buildExtension(CM) {
    const { Decoration, EditorView, Prec, StateField, WidgetType, keymap } = CM;

    class BarWidget extends WidgetType {
      constructor(block) {
        super();
        this.names = block.options.map((o) => o.name);
        this.active = block.active;
        this.key = `${block.id}|${this.active}|${this.names.join('\u0001')}`;
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
          pick.title = index === this.active ? 'Active (double-click to rename)' : 'Switch to this candidate (double-click to rename)';
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
      return Decoration.set(ranges, true);
    }

    const field = StateField.define({
      create: (state) => build(state),
      update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
      provide: (f) => [
        EditorView.decorations.from(f),
        EditorView.atomicRanges.of((view) => view.state.field(f, false) || Decoration.none),
      ],
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
      '.ol-cand-body': { borderLeft: '3px solid #098842' },
      '.ol-cand-tail': { height: '3px', borderLeft: '3px solid #098842', opacity: '0.5' },
    });

    return [
      field,
      theme,
      Prec.highest(keymap.of([{ key: 'Mod-Shift-i', run: createOrAdd, preventDefault: true }])),
    ];
  }
})();
