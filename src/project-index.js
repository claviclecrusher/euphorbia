'use strict';

// Project index for the AI chat.
//
// Each .tex file is split into units: section / subsection / subsubsection /
// paragraph headings, and inside them text paragraphs (blank-line separated),
// figures, tables, algorithms and display math. Every unit has a line range,
// a kind, a title (heading, caption or label) and a content hash. A one-line
// summary per unit is written by the summary model chosen in AI Settings and
// cached by content hash, so only units whose text changed are summarized
// again. Section summaries are built from their children's summaries. Units
// without a summary yet show their first sentence.
//
// The model gets the index (units + summaries), not the text, and reads text
// on request through tools (read_unit, read_file, search, expand).
//
// Storage per project (app data folder, ai-index/<server>/<project>/):
//   files.json      copy of the project's text files (from the zip download)
//   summaries.json  { <unit hash>: summary }
//   index.md        the index as last built, for reading by people

const { app, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

const STALE_MS = 2 * 60 * 1000;
const TEXT_EXT = /\.(tex|bib|sty|cls|bst|txt|md|bbx|cbx|cfg|def|ltx|dtx|ins|tikz|pgf|csv|dat)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LIMITS = {
  readLines: 400, // read_file lines per call
  readUnitChars: 20000, // read_unit characters per call
  searchHits: 40,
  indexChars: 60000, // above this the index shows sections only; expand() opens one
  summaryInputChars: 8000, // text per unit sent to the summary model
  batchUnits: 8, // leaf units summarized per call
  minParaChars: 120, // shorter paragraphs are merged with the next one
};

const HEADING = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)\}/;
const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const ENV_KINDS = {
  figure: 'figure', 'figure*': 'figure', table: 'table', 'table*': 'table', algorithm: 'algorithm',
  'algorithm*': 'algorithm', equation: 'math', 'equation*': 'math', align: 'math', 'align*': 'math',
  gather: 'math', 'gather*': 'math', multline: 'math', 'multline*': 'math', theorem: 'theorem',
  lemma: 'theorem', proposition: 'theorem', corollary: 'theorem', definition: 'theorem', proof: 'proof',
};

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const short = (s) => sha1(s).slice(0, 16);
const dirOf = (serverUrl, projectId) => path.join(app.getPath('userData'), 'ai-index', sha1(serverUrl).slice(0, 12), projectId);

// ------------------------------------------------------------- splitting ---

function firstSentence(text) {
  const s = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%') && !/^\\[a-zA-Z@]+\*?(\s*(\[[^\]]*\]|\{[^{}]*\}))*\s*$/.test(l))
    .join(' ')
    .replace(/\\(?:cite\w*|ref|cref|Cref|eqref|autoref)\{[^}]*\}/g, '[..]')
    .replace(/\s+/g, ' ');
  const m = s.match(/^(.{20,200}?[.!?])(\s|$)/);
  return (m ? m[1] : s.slice(0, 140)).trim();
}

// Splits one .tex file into a unit tree. Lines are 1-based.
function splitTex(filePath, text) {
  const lines = text.split('\n');
  const root = { kind: 'file', path: filePath, title: filePath, level: -1, start: 1, end: lines.length, children: [] };
  const stack = [root];
  const begin = lines.findIndex((l) => /\\begin\{document\}/.test(l));
  let i = 0;
  if (begin > 0) {
    root.children.push({ kind: 'preamble', path: filePath, title: 'preamble', start: 1, end: begin + 1, children: [] });
    i = begin + 1;
  }
  let para = null; // open text paragraph
  const container = () => stack[stack.length - 1];
  const closePara = (endLine) => {
    if (!para) return;
    para.end = endLine;
    const body = lines.slice(para.start - 1, para.end).join('\n');
    const prev = container().children[container().children.length - 1];
    // Merge very short paragraphs into the previous one.
    if (body.trim().length < LIMITS.minParaChars && prev && prev.kind === 'para') prev.end = para.end;
    else if (body.trim()) container().children.push(para);
    para = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (/\\end\{document\}/.test(line)) {
      closePara(n - 1);
      break;
    }
    const h = HEADING.exec(line);
    if (h) {
      closePara(n - 1);
      const level = LEVELS[h[1]];
      while (stack.length > 1 && container().level >= level) container().end = n - 1, stack.pop();
      const unit = { kind: h[1], path: filePath, title: h[2].replace(/\s+/g, ' ').slice(0, 120), level, start: n, end: lines.length, children: [] };
      container().children.push(unit);
      stack.push(unit);
      continue;
    }
    const env = line.match(/\\begin\{([a-zA-Z*]+)\}/);
    if (env && ENV_KINDS[env[1]]) {
      closePara(n - 1);
      const name = env[1].replace('*', '\\*');
      let j = i;
      while (j < lines.length && !new RegExp(`\\\\end\\{${name}\\}`).test(lines[j])) j++;
      const body = lines.slice(i, j + 1).join('\n');
      const caption = (body.match(/\\caption\{([^}]*)/) || [])[1];
      const label = (body.match(/\\label\{([^}]*)\}/) || [])[1];
      container().children.push({
        kind: ENV_KINDS[env[1]], path: filePath, title: [label, caption && caption.slice(0, 100)].filter(Boolean).join(': ') || env[1],
        start: n, end: Math.min(j + 1, lines.length), children: [],
      });
      i = j;
      continue;
    }
    if (!line.trim()) {
      closePara(n - 1);
      continue;
    }
    if (!para) para = { kind: 'para', path: filePath, title: '', start: n, end: n, children: [] };
  }
  closePara(Math.min(i, lines.length));
  while (stack.length > 1) stack.pop();
  return root;
}

function splitBib(filePath, text) {
  const keys = Array.from(text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g), (m) => m[1]);
  return {
    kind: 'file', path: filePath, title: filePath, level: -1, start: 1, end: text.split('\n').length, children: [],
    note: `${keys.length} bibliography entries: ${keys.slice(0, 80).join(', ')}${keys.length > 80 ? ', …' : ''}`,
  };
}

// Numbers units, fills hashes (section hash = its children's hashes).
function finishTree(tree, text) {
  const lines = text.split('\n');
  const walk = (u) => {
    u.children.forEach(walk);
    const own = lines.slice(u.start - 1, u.end).join('\n');
    u.chars = own.length;
    u.hash = short(u.children.length ? `${u.kind}|${u.title}|${u.children.map((c) => c.hash).join(',')}` : `${u.kind}|${own}`);
    if (!u.children.length && !u.title) u.title = '';
    u.first = u.children.length ? '' : firstSentence(own);
  };
  walk(tree);
  return tree;
}

function splitFile(f) {
  if (/\.tex$/i.test(f.path)) return finishTree(splitTex(f.path, f.text), f.text);
  if (/\.bib$/i.test(f.path)) return finishTree(splitBib(f.path, f.text), f.text);
  return finishTree({ kind: 'file', path: f.path, title: f.path, level: -1, start: 1, end: f.text.split('\n').length, children: [], note: 'support file' }, f.text);
}

// --------------------------------------------------------------- project ---

const projects = new Map(); // dir -> project state

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(dir, name, data) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  } catch (err) {
    console.error('[ai-index] save failed:', err.message);
  }
}

function stateFor(serverUrl, projectId) {
  const dir = dirOf(serverUrl, projectId);
  let p = projects.get(dir);
  if (!p) {
    const stored = readJson(path.join(dir, 'files.json'), null);
    p = {
      dir, serverUrl, projectId,
      builtAt: stored ? stored.builtAt : 0,
      lastUpdated: stored ? stored.lastUpdated || null : null,
      main: stored ? stored.main : null,
      files: stored ? stored.files : [],
      trees: new Map(), // path -> { hash, tree }
      summaries: readJson(path.join(dir, 'summaries.json'), {}),
      refreshing: null,
    };
    projects.set(dir, p);
  }
  return p;
}

function treeOf(p, f) {
  const h = short(f.text);
  const cached = p.trees.get(f.path);
  if (cached && cached.hash === h) return cached.tree;
  const tree = splitFile(f);
  p.trees.set(f.path, { hash: h, tree });
  return tree;
}

// Downloads the project and keeps the copy. Only changed files are split
// again (trees are cached by file hash); summaries are cached by unit hash.
async function csrfToken(serverUrl) {
  const res = await session.defaultSession.fetch(`${serverUrl}/dev/csrf`, { credentials: 'include' });
  const text = res.ok ? (await res.text()).trim() : '';
  if (/^[\w-]{20,}$/.test(text)) return text;
  const page = await session.defaultSession.fetch(`${serverUrl}/project`, { credentials: 'include' });
  const m = (await page.text()).match(/<meta name="ol-csrfToken" content="([^"]+)"/);
  return m ? m[1] : null;
}

// The project's lastUpdated from Overleaf's project list, or null.
async function lastUpdated(p) {
  try {
    const token = await csrfToken(p.serverUrl);
    if (!token) return null;
    const res = await session.defaultSession.fetch(`${p.serverUrl}/api/project`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Accept: 'application/json' },
      body: JSON.stringify({ page: { size: 1000 } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const proj = (data.projects || []).find((x) => x.id === p.projectId || x._id === p.projectId);
    return proj && proj.lastUpdated ? String(proj.lastUpdated) : null;
  } catch {
    return null;
  }
}

async function refresh(p, { force = false, maxAge = STALE_MS } = {}) {
  if (!force && p.files.length && Date.now() - p.builtAt < maxAge) return p;
  if (p.refreshing) return p.refreshing;
  p.refreshing = (async () => {
    try {
      // Unchanged since the last download: keep the copy, skip the zip.
      const stamp = await lastUpdated(p);
      if (!force && stamp && p.files.length && stamp === p.lastUpdated) {
        p.builtAt = Date.now();
        return p;
      }
      const res = await session.defaultSession.fetch(`${p.serverUrl}/project/${p.projectId}/download/zip`, { credentials: 'include' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !/zip|octet-stream/i.test(type)) throw new Error(`Could not download the project to index it (HTTP ${res.status}).`);
      const entries = unzipSync(new Uint8Array(await res.arrayBuffer()), {
        filter: (f) => TEXT_EXT.test(f.name) && f.originalSize <= MAX_FILE_BYTES,
      });
      p.files = Object.keys(entries).sort().map((k) => ({ path: k, text: strFromU8(entries[k]).replace(/\r\n/g, '\n') }));
      const mainFile = p.files.find((f) => /\\documentclass/.test(f.text));
      p.main = mainFile ? mainFile.path : null;
      p.builtAt = Date.now();
      p.lastUpdated = stamp;
      for (const k of p.trees.keys()) if (!p.files.some((f) => f.path === k)) p.trees.delete(k);
      writeJson(p.dir, 'files.json', { builtAt: p.builtAt, lastUpdated: p.lastUpdated, main: p.main, files: p.files });
      writeJson(p.dir, 'index.md', indexMarkdown(p, p.files, { full: true }));
    } catch (err) {
      if (!p.files.length) throw err; // otherwise keep the last good copy
    } finally {
      p.refreshing = null;
    }
    return p;
  })();
  return p.refreshing;
}

// ----------------------------------------------------------------- index ---

function summaryOf(p, u) {
  return p.summaries[u.hash] || u.first || '';
}

function unitLine(p, u, id, depth) {
  const range = `L${u.start}-${u.end}`;
  const head = u.kind === 'para' || u.title === u.kind ? u.kind : `${u.kind}${u.title ? ` "${u.title}"` : ''}`;
  const sum = u.note || summaryOf(p, u);
  return `${'  '.repeat(depth)}- [${id}] ${head} ${range}${sum ? `: ${sum}` : ''}`;
}

// Assigns ids (path-scoped, stable while the structure is unchanged) and
// renders the index. With `full` every unit is listed; otherwise leaf units
// are left out when the index would be too long (expand() opens them).
function indexMarkdown(p, files, { full = false } = {}) {
  const render = (leaves) => {
    const out = ['# Project index', '', `Main file: ${p.main || '(not found)'}. Units are [file#n]; lines are 1-based.`, ''];
    files.forEach((f) => {
      const tree = treeOf(p, f);
      out.push(`## ${f.path} (${tree.end} lines)`);
      if (tree.note) out.push(`- ${tree.note}`);
      let n = 0;
      const walk = (u, depth) => {
        for (const c of u.children) {
          n++;
          c.id = `${f.path}#${n}`;
          const leaf = !c.children.length;
          if (leaves || !leaf || c.kind === 'preamble') out.push(unitLine(p, c, c.id, depth));
          walk(c, depth + 1);
        }
      };
      walk(tree, 0);
      out.push('');
    });
    return out.join('\n');
  };
  const all = render(true);
  if (full || all.length <= LIMITS.indexChars) return all;
  return `${render(false)}\nThe index is long, so paragraphs, figures, tables and math are left out. Call expand with a file or unit id to list them.\n`;
}

function findUnit(p, files, id) {
  const [filePath] = String(id).split('#');
  const f = files.find((x) => x.path === filePath);
  if (!f) return null;
  indexMarkdown(p, [f], { full: true }); // assigns ids
  let found = null;
  const walk = (u) => {
    for (const c of u.children) {
      if (c.id === id) found = c;
      walk(c);
    }
  };
  walk(treeOf(p, f));
  return found ? { f, u: found } : null;
}

// --------------------------------------------------------------- workspace ---

// Innermost unit containing a line (for labelling search hits).
function unitAtLine(p, f, line) {
  indexMarkdown(p, [f], { full: true }); // assigns ids
  let best = null;
  const walk = (u) => {
    for (const c of u.children) {
      if (line >= c.start && line <= c.end) {
        best = c;
        walk(c);
      }
    }
  };
  walk(treeOf(p, f));
  return best;
}

// Line ranges of edit and candidates blocks in a text (1-based, inclusive).
function blockRanges(text) {
  const out = [];
  let open = null;
  text.split('\n').forEach((l, i) => {
    if (/^\s*%%(edit|cand):begin\b/.test(l)) open = i + 1;
    else if (open && /^\s*%%(edit|cand):end\s*$/.test(l)) {
      out.push([open, i + 1]);
      open = null;
    }
  });
  return out;
}

const MARK_KINDS = ['notation', 'experiment', 'theory', 'citation', 'reference'];

// A view for one chat request. The index comes from the stored copy only, so
// it stays byte-identical between requests (prompt caching); the tools read
// the open file live. `embed(texts)` returns vectors, or is null.
function workspace(p, openDoc, { embed = null } = {}) {
  let files = p.files;
  if (openDoc && openDoc.path) {
    const live = { path: openDoc.path, text: openDoc.text };
    files = files.some((f) => f.path === openDoc.path) ? files.map((f) => (f.path === openDoc.path ? live : f)) : [...files, live];
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fileOf = (x) => byPath.get(String(x || '').replace(/^\.?\//, ''));
  const accepted = []; // { file, from, to } spans of edits accepted in this request

  const readOne = (id) => {
    const hit = findUnit(p, files, id);
    if (!hit) return `No unit ${id}.`;
    const lines = hit.f.text.split('\n').slice(hit.u.start - 1, hit.u.end).join('\n');
    const text = lines.length > LIMITS.readUnitChars ? `${lines.slice(0, LIMITS.readUnitChars)}\n[truncated; use read_file for the rest]` : lines;
    return `${hit.f.path}, lines ${hit.u.start}-${hit.u.end} (${hit.u.kind}) [${id}]:\n${text}`;
  };

  return {
    index: indexMarkdown(p, p.files),
    hasRelated: !!embed,
    tools: {
      read_unit({ id, ids }) {
        const list = [...(Array.isArray(ids) ? ids : []), ...(id ? [id] : [])].map(String).slice(0, 12);
        if (!list.length) return 'Give id or ids.';
        return list.map(readOne).join('\n\n');
      },
      read_file({ path: filePath, start_line, end_line }) {
        const f = fileOf(filePath);
        if (!f) return `No file "${filePath}". Files: ${files.map((x) => x.path).join(', ')}`;
        const lines = f.text.split('\n');
        const a = Math.max(1, Math.floor(Number(start_line) || 1));
        let b = Math.min(lines.length, Math.floor(Number(end_line) || lines.length));
        if (b < a) return `Line range ${start_line}-${end_line} is empty; ${f.path} has ${lines.length} lines.`;
        let note = '';
        if (b - a + 1 > LIMITS.readLines) {
          b = a + LIMITS.readLines - 1;
          note = `\n[truncated: read lines ${b + 1}-${lines.length} next]`;
        }
        return `${f.path}, lines ${a}-${b} of ${lines.length}:\n${lines.slice(a - 1, b).join('\n')}${note}`;
      },
      search({ query }) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return 'Empty query.';
        const hits = [];
        for (const f of files) {
          f.text.split('\n').forEach((line, i) => {
            if (hits.length < LIMITS.searchHits && line.toLowerCase().includes(q)) {
              const u = unitAtLine(p, f, i + 1);
              hits.push(`${f.path}:${i + 1}${u ? ` [${u.id}]` : ''}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
        return hits.length ? hits.join('\n') + (hits.length === LIMITS.searchHits ? '\n[more matches not shown]' : '') : `No matches for "${query}".`;
      },
      async find_related({ text, k }) {
        if (!embed) return 'Meaning-based search is not set up (no embedding model). Use search instead.';
        const res = await related(p, files, embed, String(text || ''), Math.min(Math.max(Number(k) || 8, 1), 20));
        return res.length ? res.map((r) => `[${r.id}] ${r.kind}${r.title ? ` "${r.title}"` : ''} L${r.start}-${r.end} (score ${r.score.toFixed(2)}): ${r.summary}`).join('\n') : 'Nothing related found.';
      },
      expand({ id }) {
        const key = String(id || '');
        const f = files.find((x) => x.path === key);
        if (f) return indexMarkdown(p, [f], { full: true });
        const hit = findUnit(p, files, key);
        if (!hit) return `No file or unit ${key}.`;
        const out = [unitLine(p, hit.u, hit.u.id, 0)];
        const walk = (u, d) => u.children.forEach((c) => (out.push(unitLine(p, c, c.id, d)), walk(c, d + 1)));
        walk(hit.u, 1);
        return out.join('\n');
      },
    },

    // Checks a proposed edit against the current text. Returns { ok, error } or
    // { ok, line } and remembers accepted spans to refuse overlapping edits.
    checkEdit({ file, find, replace }) {
      const f = fileOf(file);
      if (!f) return { ok: false, error: `No file "${file}". Files: ${files.map((x) => x.path).join(', ')}` };
      if (/\.bib$/i.test(f.path)) return { ok: false, error: '.bib files are read-only. Tell the user what to change instead.' };
      if (!find) return { ok: false, error: 'find is empty.' };
      if (find === replace) return { ok: false, error: 'replace is the same as find.' };
      const text = f.text;
      let at = text.indexOf(find);
      let len = find.length;
      if (at >= 0 && text.indexOf(find, at + 1) >= 0) {
        return { ok: false, error: 'find occurs more than once in the file; include more surrounding lines so it is unique.' };
      }
      if (at < 0) {
        const norm = (t) => t.replace(/[ \t]+$/gm, '');
        const want = norm(find).split('\n');
        const lines = text.split('\n');
        const hits = [];
        for (let n = 0; n + want.length <= lines.length; n++) if (want.every((w, j) => norm(lines[n + j]) === w)) hits.push(n);
        if (hits.length !== 1) {
          return { ok: false, error: hits.length ? 'find occurs more than once in the file.' : 'find was not found in the file. Read the unit again and copy the text exactly (without line numbers).' };
        }
        at = lines.slice(0, hits[0]).join('\n').length + (hits[0] ? 1 : 0);
        len = lines.slice(hits[0], hits[0] + want.length).join('\n').length;
      }
      const lineFrom = text.slice(0, at).split('\n').length;
      const lineTo = lineFrom + text.slice(at, at + len).split('\n').length - 1;
      if (blockRanges(text).some(([a, b]) => lineFrom <= b && lineTo >= a)) {
        return { ok: false, error: 'Those lines are inside an edit or candidates block; leave them alone.' };
      }
      if (accepted.some((s) => s.file === f.path && lineFrom <= s.to && lineTo >= s.from)) {
        return { ok: false, error: 'This overlaps an edit you already proposed in this answer; combine them into one edit.' };
      }
      accepted.push({ file: f.path, from: lineFrom, to: lineTo });
      return { ok: true, file: f.path, line: lineFrom };
    },

    // Forget the edits accepted so far (song-1: the local draft's edits are discarded).
    resetEdits() {
      accepted.length = 0;
    },

    checkMark({ file, start_line, end_line, kind }) {
      const f = fileOf(file);
      if (!f) return { ok: false, error: `No file "${file}".` };
      const n = f.text.split('\n').length;
      const a = Number(start_line);
      const b = Number(end_line == null ? start_line : end_line);
      if (!(a >= 1 && b >= a && b <= n)) return { ok: false, error: `Line range ${start_line}-${end_line} is outside ${f.path} (1-${n}).` };
      if (!MARK_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${MARK_KINDS.join(', ')}.` };
      return { ok: true, file: f.path, start: a, end: b };
    },
  };
}

// ------------------------------------------------------------- embeddings ---
//
// Each unit's vector (title + summary + the start of its text) is cached by
// unit hash and embedding model in embeddings.json. find_related ranks units
// by a mix of vector similarity and word overlap.

const toB64 = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64');
const fromB64 = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

function loadEmbeddings(p) {
  if (!p.embeddings) p.embeddings = readJson(path.join(p.dir, 'embeddings.json'), {});
  return p.embeddings;
}

function embedText(p, f, u) {
  const body = f.text.split('\n').slice(u.start - 1, u.end).join('\n').slice(0, 1500);
  return `${u.kind}${u.title ? `: ${u.title}` : ''}\n${summaryOf(p, u)}\n${body}`;
}

function allUnits(p, files) {
  const out = [];
  for (const f of files) {
    if (!/\.tex$/i.test(f.path)) continue;
    indexMarkdown(p, [f], { full: true });
    const walk = (u) => u.children.forEach((c) => {
      if (c.kind !== 'preamble') out.push({ f, u: c });
      walk(c);
    });
    walk(treeOf(p, f));
  }
  return out;
}

// Embeds units that have no vector yet for `model`. Returns how many were added.
async function embedUnits(p, model, embed, { shouldStop } = {}) {
  const store = loadEmbeddings(p);
  const todo = allUnits(p, p.files).filter(({ u }) => !store[`${model}|${u.hash}`]);
  for (let i = 0; i < todo.length; i += 32) {
    if (shouldStop && shouldStop()) break;
    const batch = todo.slice(i, i + 32);
    const vecs = await embed(batch.map(({ f, u }) => embedText(p, f, u)));
    batch.forEach(({ u }, j) => {
      if (vecs[j]) store[`${model}|${u.hash}`] = toB64(vecs[j]);
    });
    writeJson(p.dir, 'embeddings.json', store);
  }
  return todo.length;
}

const words = (t) => new Set(String(t).toLowerCase().match(/\\?[a-zÀ-￿][a-z0-9À-￿]{2,}/g) || []);

async function related(p, files, embed, query, k) {
  const store = loadEmbeddings(p);
  const units = allUnits(p, files);
  const [q] = await embed([query]);
  const qw = words(query);
  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  const qn = norm(q);
  const scored = [];
  for (const { f, u } of units) {
    const key = Object.keys(store).find((x) => x.endsWith(`|${u.hash}`));
    if (!key) continue;
    const v = fromB64(store[key]);
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
    const cos = dot / (qn * norm(v));
    const uw = words(embedText(p, f, u));
    let overlap = 0;
    for (const w of qw) if (uw.has(w)) overlap++;
    const kw = qw.size ? overlap / qw.size : 0;
    scored.push({ id: u.id, kind: u.kind, title: u.title, start: u.start, end: u.end, summary: summaryOf(p, u), score: 0.75 * cos + 0.25 * kw, leaf: !u.children.length });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

// ------------------------------------------------------------ summarizing ---

// Units without a cached summary, leaves first (sections need their children).
function pending(p) {
  const leaves = [];
  const sections = [];
  for (const f of p.files) {
    if (!/\.tex$/i.test(f.path)) continue;
    const lines = f.text.split('\n');
    const walk = (u) => {
      for (const c of u.children) {
        walk(c);
        if (p.summaries[c.hash] || c.kind === 'preamble') continue;
        if (c.children.length) sections.push({ u: c });
        else leaves.push({ u: c, text: lines.slice(c.start - 1, c.end).join('\n').slice(0, LIMITS.summaryInputChars) });
      }
    };
    walk(treeOf(p, f));
  }
  return { leaves, sections };
}

function estimateTokens(p) {
  const { leaves, sections } = pending(p);
  const chars = leaves.reduce((n, l) => n + l.text.length + 200, 0) + sections.length * 1500;
  return { units: leaves.length + sections.length, tokens: Math.ceil(chars / 3.5) };
}

const LEAF_PROMPT = `You summarize parts of a LaTeX paper for an index that another assistant uses to find
its way. For each numbered part, write one sentence (at most 30 words) saying what it says or shows:
the claim, result, method step, or what a figure/table/equation presents. No preamble.
Answer with exactly one line per part, in the form "<number>: <summary>".`;

const SECTION_PROMPT = `You summarize a section of a LaTeX paper for an index, from the summaries of its parts.
Write one or two sentences (at most 45 words) on what the section covers. Answer with the summary only.`;

// Runs one pass over pending units with `complete(system, user)`; `onProgress`
// reports { done, total }. Stops early when `shouldStop()` returns true.
async function summarize(p, complete, { onProgress, shouldStop } = {}) {
  let { leaves, sections } = pending(p);
  const total = leaves.length + sections.length;
  let done = 0;
  const report = () => onProgress && onProgress({ done, total });
  report();
  for (let i = 0; i < leaves.length; i += LIMITS.batchUnits) {
    if (shouldStop && shouldStop()) return { done, total, stopped: true };
    const batch = leaves.slice(i, i + LIMITS.batchUnits);
    const user = batch
      .map((b, k) => `${k + 1}. (${b.u.kind}${b.u.title ? `: ${b.u.title}` : ''})\n${b.text}`)
      .join('\n\n');
    const answer = await complete(LEAF_PROMPT, user);
    const lines = String(answer || '').split('\n');
    batch.forEach((b, k) => {
      const line = lines.find((l) => new RegExp(`^\\s*${k + 1}\\s*[:.)]`).test(l));
      const text = line ? line.replace(/^\s*\d+\s*[:.)]\s*/, '').trim() : '';
      if (text) p.summaries[b.u.hash] = text.slice(0, 300);
    });
    done += batch.length;
    writeJson(p.dir, 'summaries.json', p.summaries);
    report();
  }
  // Sections bottom-up: recompute pending so parents see their children.
  ({ sections } = pending(p));
  for (const s of sections) {
    if (shouldStop && shouldStop()) return { done, total, stopped: true };
    const u = s.u;
    if (u.children.some((c) => c.kind !== 'preamble' && !p.summaries[c.hash] && !c.first)) continue;
    const parts = u.children.map((c) => `- ${c.kind}${c.title ? ` "${c.title}"` : ''}: ${summaryOf(p, c)}`).join('\n');
    const answer = await complete(SECTION_PROMPT, `Section: ${u.title}\nParts:\n${parts}`);
    if (answer && answer.trim()) p.summaries[u.hash] = answer.trim().split('\n')[0].slice(0, 400);
    done++;
    writeJson(p.dir, 'summaries.json', p.summaries);
    report();
  }
  writeJson(p.dir, 'index.md', indexMarkdown(p, p.files, { full: true }));
  return { done, total, stopped: false };
}

function stats(p) {
  let units = 0;
  let summarized = 0;
  for (const f of p.files) {
    const walk = (u) => u.children.forEach((c) => {
      units++;
      if (p.summaries[c.hash]) summarized++;
      walk(c);
    });
    walk(treeOf(p, f));
  }
  return { files: p.files.length, chars: p.files.reduce((n, f) => n + f.text.length, 0), units, summarized, builtAt: p.builtAt, main: p.main };
}

// ------------------------------------------------------------ compile log ---

// Compiles the project on the server (like Recompile; the server reuses its
// previous run when nothing changed) and returns a short report of the log:
// status, errors with their file:line and context, warnings, and the end of
// the log when nothing else was found.
async function compileLog(p) {
  const token = await csrfToken(p.serverUrl);
  if (!token) return 'Could not compile: not signed in to the server.';
  const res = await session.defaultSession.fetch(`${p.serverUrl}/project/${p.projectId}/compile?auto_compile=true`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Accept: 'application/json' },
    body: JSON.stringify({ check: 'silent', draft: false, incrementalCompilesEnabled: true, stopOnFirstError: false }),
  });
  if (!res.ok) return `Could not compile (HTTP ${res.status}).`;
  const data = await res.json();
  const logFile = (data.outputFiles || []).find((f) => f.path === 'output.log');
  const head = `Compile status: ${data.status || 'unknown'}.`;
  if (!logFile) return `${head} No log was produced.`;
  const q = data.clsiServerId ? `?clsiserverid=${encodeURIComponent(data.clsiServerId)}` : '';
  const logRes = await session.defaultSession.fetch(`${p.serverUrl}${logFile.url}${q}`, { credentials: 'include' });
  if (!logRes.ok) return `${head} The log could not be read (HTTP ${logRes.status}).`;
  return head + '\n' + summarizeLog(await logRes.text());
}

// Errors ("! ..." with the l.N line and the file being read), file:line:
// messages, and LaTeX/package warnings with their input line.
function summarizeLog(log) {
  const lines = log.replace(/\r\n/g, '\n').split('\n');
  const errors = [];
  const warnings = [];
  // The project file being read: the most recent "(./name.tex" before the
  // error (project files are opened with a relative path, TeX's own with an
  // absolute one).
  const fileAt = (i) => {
    for (let k = i; k >= 0; k--) {
      const m = lines[k].match(/\(\.\/[^()\s]+\.(?:tex|bib|bbl|sty|cls)/g);
      if (m) return m[m.length - 1].slice(3);
    }
    return '';
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fle = l.match(/^(?:\.\/)?([^:\s]+\.\w+):(\d+): (.*)/);
    if (fle) {
      errors.push(`${fle[1]}:${fle[2]}: ${fle[3]}`);
      continue;
    }
    if (l.startsWith('! ')) {
      const ctx = [l];
      let line = '';
      for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
        const m = lines[k].match(/^l\.(\d+) ?(.*)/);
        if (m) {
          line = m[1];
          ctx.push(lines[k]);
          break;
        }
        if (lines[k].trim()) ctx.push(lines[k]);
      }
      const file = fileAt(i);
      errors.push(`${file || '?'}${line ? `:${line}` : ''}: ${ctx.join(' / ').slice(0, 400)}`);
      continue;
    }
    if (/^(LaTeX|Package \S+|Class \S+) Warning:/.test(l)) {
      let w = l;
      for (let k = i + 1; k < Math.min(lines.length, i + 4) && lines[k].trim() && !/Warning:/.test(lines[k]); k++) w += ' ' + lines[k].trim();
      warnings.push(w.replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  const out = [];
  out.push(errors.length ? `Errors (${errors.length}):\n${errors.slice(0, 30).join('\n')}` : 'Errors: none.');
  if (warnings.length) out.push(`Warnings (${warnings.length}):\n${[...new Set(warnings)].slice(0, 30).join('\n')}`);
  if (!errors.length && /Emergency stop|Fatal error|no output PDF/i.test(log)) out.push(`End of the log:\n${lines.slice(-40).join('\n')}`);
  return out.join('\n\n');
}

module.exports = { stateFor, refresh, workspace, summarize, estimateTokens, stats, embedUnits, compileLog, summarizeLog, LIMITS };
