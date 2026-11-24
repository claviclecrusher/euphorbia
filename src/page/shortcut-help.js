// Runs in the Overleaf page. Appends an "Euphorbia Native Shortcuts"
// section to Help → Keyboard shortcuts, below Overleaf's own shortcuts.
(() => {
  if (window.__euphorbiaShortcutHelp) return;
  window.__euphorbiaShortcutHelp = true;

  const ctrl = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  const KEYS = [
    [`${ctrl} + Shift + I`, 'Candidates: turn the selected lines into a candidate block, or add a candidate inside one'],
    [`${ctrl} + K`, 'AI edit: rewrite the selected lines from an instruction; the result is an edit with Accept / Reject (File > AI Settings)'],
    [`${ctrl} + L`, 'AI chat: open the AI Chat tab and add the selected lines (if any) to the message'],
    [`${ctrl} + Shift + K`, 'Edit with diff: keep the selected lines as the old version and edit a copy (Accept / Reject)'],
    [`${ctrl} + Shift + J`, 'Note: attach a short note to the line (a "% comment (author, time): ..." line under it, shown as a sticky note)'],
    [`${ctrl} + Shift + P`, 'Go to code location in PDF (from the cursor)'],
    [`${ctrl} + Shift + U`, 'Euphorbia code view: show candidates and edits as the comments they are in the source (toggle; also on the editor toolbar)'],
    [`${ctrl} + 1 … 9`, 'Switch to a saved server'],
    [`${ctrl} + Shift + H`, 'Back to the project list'],
    ['F12', 'Developer tools'],
  ];

  function enhance(body) {
    if (body.querySelector('.ol-desktop-hotkeys')) return;
    const section = document.createElement('div');
    section.className = 'ol-desktop-hotkeys';
    section.style.marginTop = '24px';
    const h = document.createElement('h3');
    h.textContent = 'Euphorbia Native Shortcuts';
    section.appendChild(h);
    for (const [combination, description] of KEYS) {
      const row = document.createElement('div');
      row.className = 'hotkey';
      const c = document.createElement('span');
      c.className = 'combination';
      c.textContent = combination;
      const d = document.createElement('span');
      d.className = 'description';
      d.textContent = description;
      row.append(c, d);
      section.appendChild(row);
    }
    body.appendChild(section);
  }

  const scan = () => document.querySelectorAll('.modal-body.hotkeys-modal').forEach(enhance);
  const start = () => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
