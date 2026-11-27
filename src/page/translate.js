// Runs in the Overleaf page. Translate: Ctrl+Shift+L (or right-click) on a
// selection shows its translation under the last selected line, like a note.
// Nothing is written into the file; × removes it. Translations stay while
// the file is open and move with the text.
(() => {
  if (window.__euphorbiaTranslateLoaded) return;
  window.__euphorbiaTranslateLoaded = true;
  const ai = window.euphorbia && window.euphorbia.ai;
  if (!ai || !ai.translate) return;

  let CM = null;
  let addEffect = null;
  let removeEffect = null;
  let nextId = 1;
  const view = () => { try { return window.overleaf.unstable.store.get('editor.view'); } catch { return null; } };

  async function translate(v) {
    v = v || view();
    if (!v || !addEffect) return false;
    const sel = v.state.selection.main;
    if (sel.empty) return true;
    const doc = v.state.doc;
    const first = doc.lineAt(sel.from);
    let last = doc.lineAt(sel.to);
    if (sel.to === last.from && last.number > first.number) last = doc.line(last.number - 1);
    const text = doc.sliceString(first.from, last.to);
    const id = nextId++;
    v.dispatch({ effects: addEffect.of({ id, pos: last.to, state: 'busy', text: 'Translating…' }) });
    const res = await ai.translate(text);
    const w = view();
    if (!w) return true;
    w.dispatch({ effects: addEffect.of({ id, update: true, state: res.ok ? 'done' : 'error', text: res.ok ? res.text : res.error, meta: res.ok ? `${res.lang} · ${res.model}` : '' }) });
    return true;
  }
  window.__euphorbiaTranslate = () => translate();

  window.addEventListener('UNSTABLE_editor:extensions', (event) => {
    try {
      CM = event.detail.CodeMirror;
      const { StateEffect, StateField, EditorView, Decoration, WidgetType, keymap, Prec } = CM;
      addEffect = StateEffect.define();
      removeEffect = StateEffect.define();

      class Box extends WidgetType {
        constructor(t) { super(); this.t = t; }
        eq(o) { return o.t.id === this.t.id && o.t.text === this.t.text && o.t.state === this.t.state; }
        toDOM(view) {
          const box = document.createElement('div');
          box.className = `ol-tr ol-tr-${this.t.state}`;
          const head = document.createElement('div');
          head.className = 'ol-tr-head';
          const label = document.createElement('span');
          label.textContent = `\u{1F310} ${this.t.meta || 'Translation'}`;
          const copy = document.createElement('button');
          copy.textContent = 'Copy';
          copy.title = 'Copy the translation';
          copy.addEventListener('click', () => { navigator.clipboard.writeText(this.t.text); copy.textContent = 'Copied'; });
          const x = document.createElement('button');
          x.textContent = '×';
          x.title = 'Close';
          x.addEventListener('click', () => view.dispatch({ effects: removeEffect.of(this.t.id) }));
          if (this.t.state === 'done') head.append(label, copy, x);
          else head.append(label, x);
          const body = document.createElement('div');
          body.className = 'ol-tr-body';
          body.textContent = this.t.text;
          box.append(head, body);
          box.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'BUTTON') e.stopPropagation(); });
          return box;
        }
        ignoreEvent() { return true; }
      }

      // Each translation: { id, pos, state, text, meta }.
      const field = StateField.define({
        create: () => [],
        update(list, tr) {
          let out = tr.docChanged ? list.map((t) => ({ ...t, pos: tr.changes.mapPos(t.pos, 1) })) : list;
          for (const e of tr.effects) {
            if (e.is(addEffect)) {
              if (e.value.update) out = out.map((t) => (t.id === e.value.id ? { ...t, ...e.value, update: undefined } : t));
              else out = [...out, e.value];
            }
            if (e.is(removeEffect)) out = out.filter((t) => t.id !== e.value);
          }
          return out;
        },
        provide: (f) => EditorView.decorations.from(f, (list) => Decoration.set(list.map((t) => Decoration.widget({ widget: new Box(t), block: true, side: 1 }).range(t.pos)), true)),
      });
      event.detail.extensions.push(
        field,
        Prec.highest(keymap.of([{ key: 'Mod-Shift-l', run: (v) => (translate(v), true), preventDefault: true }])),
        EditorView.baseTheme({
          '.ol-tr': { margin: '2px 0 6px 18px', padding: '4px 10px 6px', borderRadius: '3px 8px 8px 8px', maxWidth: 'calc(100% - 40px)',
            fontFamily: 'system-ui, "Segoe UI", sans-serif', fontSize: '13px', lineHeight: '1.55', boxShadow: '1px 2px 4px rgba(0,0,0,0.16)', userSelect: 'text' },
          '&light .ol-tr': { background: '#e8f1fd', color: '#14273d', border: '1px solid #9cc0ee' },
          '&dark .ol-tr': { background: '#1f3048', color: '#dfeaf8', border: '1px solid #3d5f8a' },
          '.ol-tr-head': { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10.5px', opacity: '0.75', marginBottom: '2px' },
          '.ol-tr-head span': { flex: '1' },
          '.ol-tr-head button': { border: '0', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px', padding: '0 3px' },
          '.ol-tr-body': { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
          '.ol-tr-busy .ol-tr-body': { fontStyle: 'italic', opacity: '0.7' },
          '.ol-tr-error .ol-tr-body': { color: '#b83a33' },
        })
      );
    } catch (err) {
      console.error('[euphorbia] translate failed to load', err);
    }
  });
})();
