'use strict';

// Project index for the AI chat.
//
// The model does not get the whole project. It gets an index: a Markdown map
// of the project that keeps only what helps it find its way (files, sections
// with line ranges and their first sentence, labels, citation keys). When it
// needs actual text it asks for it with tools (read_file, search), and the app
// answers mechanically from the stored copy of the files.
//
// The copy is built from the project's zip download and kept on this computer
// (files.json + index.md per project); it is rebuilt when older than STALE_MS
// or on request. The file open in the editor is always read live instead.

const { app, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

const STALE_MS = 2 * 60 * 1000;
const TEXT_EXT = /\.(tex|bib|sty|cls|bst|txt|md|bbx|cbx|cfg|def|ltx|dtx|ins|tikz|pgf|csv|dat)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 400;
const SECTION = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)\}/;
const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

const memory = new Map(); // key -> { files, index, builtAt, main }

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const dirOf = (serverUrl, projectId) => path.join(app.getPath('userData'), 'ai-index', sha1(serverUrl).slice(0, 12), projectId);

// ------------------------------------------------------------ the index ---

// First prose sentence after line `from` (0-based), skipping commands and comments.
function firstSentence(lines, from, to) {
  let buf = '';
  for (let i = from; i < to && buf.length < 400; i++) {
    const l = lines[i].trim();
    // Skip comments, structural commands, and lines that are only a command.
    const onlyCommand = /^\\[a-zA-Z@]+\*?(\s*(\[[^\]]*\]|\{[^{}]*\}))*\s*$/.test(l);
    if (!l || l.startsWith('%') || onlyCommand || /^\\(begin|end|label|section|subsection|subsubsection|paragraph|chapter|item|centering|includegraphics|caption)\b/.test(l)) {
      if (buf) break;
      continue;
    }
    buf += (buf ? ' ' : '') + l;
  }
  const s = buf.replace(/\\(?:cite|ref|cref|eqref)\{[^}]*\}/g, '[..]').replace(/\s+/g, ' ');
  const m = s.match(/^(.{20,220}?[.!?])(\s|$)/);
  return (m ? m[1] : s.slice(0, 160)).trim();
}

function describeTex(file) {
  const lines = file.text.split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = SECTION.exec(line);
    if (m) heads.push({ line: i, level: LEVELS[m[1]], title: m[2].replace(/\s+/g, ' ').slice(0, 120) });
  });
  const out = [];
  const begin = lines.findIndex((l) => /\\begin\{document\}/.test(l));
  if (begin > 0) out.push(`- L1-${begin + 1}: preamble`);
  if (heads.length && heads[0].line > Math.max(begin, 0) + 1) {
    const s = firstSentence(lines, Math.max(begin + 1, 0), heads[0].line);
    if (s) out.push(`- L${Math.max(begin + 2, 1)}-${heads[0].line}: (before the first section) ${s}`);
  }
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    const s = firstSentence(lines, h.line + 1, end);
    out.push(`${'  '.repeat(Math.max(0, h.level - 2))}- L${h.line + 1}-${end}: ${h.title}${s ? ` — ${s}` : ''}`);
  });
  if (!heads.length) {
    const s = firstSentence(lines, Math.max(begin + 1, 0), lines.length);
    if (s) out.push(`- ${s}`);
  }
  const labels = Array.from(file.text.matchAll(/\\label\{([^}]+)\}/g), (m) => m[1]);
  if (labels.length) out.push(`- labels: ${labels.slice(0, 60).join(', ')}${labels.length > 60 ? ', …' : ''}`);
  const inputs = Array.from(file.text.matchAll(/\\(?:input|include|subfile)\{([^}]+)\}/g), (m) => m[1]);
  if (inputs.length) out.push(`- includes: ${inputs.join(', ')}`);
  return out;
}

function describeBib(file) {
  const keys = Array.from(file.text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g), (m) => m[1]);
  return [`- ${keys.length} entries: ${keys.slice(0, 80).join(', ')}${keys.length > 80 ? ', …' : ''}`];
}

function indexMarkdown(files, main) {
  const out = ['# Project index', ''];
  out.push(`Main file: ${main || '(not found)'}. Line numbers are 1-based. Use read_file to get exact text before editing.`, '');
  for (const f of files) {
    const n = f.text.split('\n').length;
    out.push(`## ${f.path} (${n} lines)`);
    if (/\.tex$/i.test(f.path)) out.push(...describeTex(f));
    else if (/\.bib$/i.test(f.path)) out.push(...describeBib(f));
    else out.push('- (support file)');
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------- build/store ---

async function build(serverUrl, projectId) {
  const res = await session.defaultSession.fetch(`${serverUrl}/project/${projectId}/download/zip`, { credentials: 'include' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !/zip|octet-stream/i.test(type)) throw new Error(`Could not download the project to index it (HTTP ${res.status}).`);
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()), {
    filter: (f) => TEXT_EXT.test(f.name) && f.originalSize <= MAX_FILE_BYTES,
  });
  const files = Object.keys(entries).sort().map((p) => ({ path: p, text: strFromU8(entries[p]).replace(/\r\n/g, '\n') }));
  const mainFile = files.find((f) => /\\documentclass/.test(f.text));
  const main = mainFile ? mainFile.path : null;
  return { builtAt: Date.now(), main, files, index: indexMarkdown(files, main) };
}

function save(dir, data) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify({ builtAt: data.builtAt, main: data.main, files: data.files }));
    fs.writeFileSync(path.join(dir, 'index.md'), data.index);
  } catch (err) {
    console.error('[ai-index] save failed:', err.message);
  }
}

function load(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'));
    d.index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
    return d;
  } catch {
    return null;
  }
}

async function getProject(serverUrl, projectId, { force = false } = {}) {
  const dir = dirOf(serverUrl, projectId);
  let data = memory.get(dir) || load(dir);
  if (!force && data && Date.now() - data.builtAt < STALE_MS) {
    memory.set(dir, data);
    return data;
  }
  try {
    data = await build(serverUrl, projectId);
  } catch (err) {
    if (data) return data; // keep using the last good copy
    throw err;
  }
  memory.set(dir, data);
  save(dir, data);
  return data;
}

// A view of the project for one chat request: the stored files with the open
// file replaced by its live text, and the index rebuilt if that changed it.
function workspace(data, openDoc) {
  let files = data.files;
  if (openDoc && openDoc.path) {
    const live = { path: openDoc.path, text: openDoc.text };
    files = files.some((f) => f.path === openDoc.path) ? files.map((f) => (f.path === openDoc.path ? live : f)) : [...files, live];
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    index: files === data.files ? data.index : indexMarkdown(files, data.main),
    readFile(p, start, end) {
      const f = byPath.get(String(p || '').replace(/^\.?\//, ''));
      if (!f) return `No file "${p}". Files: ${files.map((x) => x.path).join(', ')}`;
      const lines = f.text.split('\n');
      const a = Math.max(1, Math.floor(Number(start) || 1));
      let b = Math.min(lines.length, Math.floor(Number(end) || lines.length));
      if (b < a) return `Line range ${start}-${end} is empty; ${f.path} has ${lines.length} lines.`;
      let note = '';
      if (b - a + 1 > MAX_READ_LINES) {
        b = a + MAX_READ_LINES - 1;
        note = `\n[truncated: read lines ${b + 1}-${lines.length} next]`;
      }
      return `${f.path}, lines ${a}-${b} of ${lines.length}:\n${lines.slice(a - 1, b).join('\n')}${note}`;
    },
    search(query) {
      const q = String(query || '').trim();
      if (!q) return 'Empty query.';
      const needle = q.toLowerCase();
      const hits = [];
      for (const f of files) {
        f.text.split('\n').forEach((line, i) => {
          if (hits.length < 40 && line.toLowerCase().includes(needle)) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      return hits.length ? hits.join('\n') + (hits.length === 40 ? '\n[more matches not shown]' : '') : `No matches for "${q}".`;
    },
  };
}

function stats(data) {
  return { files: data.files.length, chars: data.files.reduce((n, f) => n + f.text.length, 0), indexChars: data.index.length, builtAt: data.builtAt, main: data.main };
}

module.exports = { getProject, workspace, stats };
