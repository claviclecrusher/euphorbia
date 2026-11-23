'use strict';

// AI features: settings (API connections and model lists), one-shot edits
// (Ctrl+K) and the chat panel. Everything runs in the main process so API keys
// never reach the Overleaf page; the page sends text, instructions and picks a
// model from the list configured here.
//
// Connections: Claude (Anthropic SDK), OpenAI (OpenAI SDK), and a local
// OpenAI-compatible server (Ollama, LM Studio, llama.cpp). Each has a list of
// models; the editor offers every model of every configured connection.

const { BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const projectIndex = require('./project-index');

const PROVIDERS = ['claude', 'openai', 'local'];
const PROVIDER_NAME = { claude: 'Claude', openai: 'OpenAI', local: 'Local' };
const DEFAULTS = {
  claude: { models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  openai: { models: [] },
  local: { models: [], baseURL: 'http://localhost:11434/v1' },
};
// Models that accept server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const EDIT_PROMPT = [
  'You edit passages of a LaTeX document.',
  'You receive the selected lines, some surrounding lines for context, and an instruction.',
  'Rewrite only the selected lines according to the instruction.',
  'Keep LaTeX commands, labels, citations and math intact unless the instruction says otherwise,',
  'and keep the language of the original text unless asked to translate.',
  'Reply with the replacement text for the selected lines only: no explanation, no code fences,',
  'nothing before or after it.',
].join(' ');

const CHAT_PROMPT = `You are a writing assistant inside a LaTeX editor (Overleaf). You help the user with
their project: answer questions about it, and change it when they ask.

You are given an index of the project, not its full text: every file is split into units
(sections, subsections, paragraphs, figures, tables, equations), each with an id, a line range and
a one-line summary. Use read_unit, read_file, search and expand to read what you need, and read the
exact lines before you edit them.

To change the project, write one edit block per change:

<edit file="path/of/the/file.tex">
<find>
the exact existing text to replace, copied character for character from the file,
as whole lines, long enough to be unique in the file
</find>
<replace>
the new text for those lines
</replace>
</edit>

Rules for edits:
- Only edit when the user asks for a change. Otherwise just answer.
- Copy <find> text exactly from what read_unit or read_file returned; never paraphrase it or include line numbers.
- Keep each edit small: only the lines that change, plus enough to be unique.
- Do not put edit blocks inside markdown code fences.
- Do not edit lines inside %%edit: or %%cand: blocks.
- Keep LaTeX commands, labels, citations and math intact unless asked otherwise.
- Before the edit blocks, say in one or two sentences what you are changing. The user reviews
  every edit and accepts or rejects it.

Each user message starts with its mode:
- [Mode: write] you may change the project with edit blocks as described above.
- [Mode: read-only] do not write any edit blocks; read what you need and answer only. If the user
  asks for a change, describe it in words (or show the new text) and say they can switch to write mode.

Passages the user points at are given as references with their file and line numbers.
Older parts of a long conversation are shown summarized; read_history opens them.
Answer in the language the user writes in.`;

let ctx = null;
let settingsWindow = null;

// ---------------------------------------------------------------- settings ---

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const cleanModels = (list) =>
  Array.from(new Set((Array.isArray(list) ? list : String(list || '').split(/[\n,]/)).map((m) => str(m, 200)).filter(Boolean))).slice(0, 50);

function settings() {
  const s = ctx.getConfig().ai || {};
  const out = { selected: { ...(s.selected || {}) } };
  for (const p of PROVIDERS) {
    const e = { ...DEFAULTS[p], ...(s[p] || {}) };
    // 0.10 stored a single `model` per connection.
    let models = Array.isArray(e.models) ? e.models : [];
    if (e.model && !models.includes(e.model)) models = [e.model, ...models];
    e.models = cleanModels(models);
    delete e.model;
    out[p] = e;
  }
  out.summary = typeof s.summary === 'string' ? s.summary : '';
  const limit = Number(s.tokenLimit);
  out.tokenLimit = Number.isFinite(limit) && limit >= 1000 ? Math.floor(limit) : 200000;
  // 0.10 had one active provider; carry it over as the default choice.
  if (s.provider && !out.selected.edit) {
    const m = out[s.provider] && out[s.provider].models[0];
    if (m) out.selected.edit = out.selected.chat = `${s.provider}:${m}`;
  }
  return out;
}

function sealKey(key) {
  if (!key) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(key).toString('base64');
  return 'plain:' + Buffer.from(key, 'utf8').toString('base64');
}

function openKey(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
  } catch {
    /* unreadable (e.g. keychain changed) */
  }
  return '';
}

const usable = (s, p) => (p === 'local' ? !!s.local.baseURL : !!openKey(s[p].key)) && s[p].models.length > 0;

function publicSettings() {
  const s = settings();
  const out = { encrypted: safeStorage.isEncryptionAvailable(), summary: s.summary, tokenLimit: s.tokenLimit, choices: choices(s) };
  for (const p of PROVIDERS) {
    out[p] = { models: s[p].models, hasKey: !!openKey(s[p].key), ...(p === 'local' ? { baseURL: s[p].baseURL } : {}) };
  }
  return out;
}

// `form`: { claude: { models, key?, clearKey? }, openai: {...}, local: { models, baseURL, key?, clearKey? } }.
// An empty key field keeps the stored key.
function applyForm(form) {
  const current = ctx.getConfig().ai || {};
  const s = settings();
  const next = { ...current, selected: s.selected };
  delete next.provider;
  if (form && typeof form.summary === 'string') next.summary = str(form.summary, 300);
  if (form && form.tokenLimit != null) {
    const n = Math.floor(Number(form.tokenLimit));
    if (!Number.isFinite(n) || n < 1000) throw new Error('The token limit must be a number of at least 1000.');
    next.tokenLimit = n;
  }
  for (const p of PROVIDERS) {
    const f = (form && form[p]) || {};
    const entry = { ...s[p], models: cleanModels(f.models) };
    if (p === 'local') {
      const url = str(f.baseURL, 500) || DEFAULTS.local.baseURL;
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The local server address must be http or https.');
      entry.baseURL = url.replace(/\/+$/, '');
    }
    if (f.clearKey) entry.key = '';
    else if (str(f.key, 1000)) entry.key = sealKey(str(f.key, 1000));
    next[p] = entry;
  }
  return next;
}

// Models offered in the editor: every model of every usable connection.
function choices(s = settings()) {
  const out = [];
  for (const p of PROVIDERS) {
    if (!usable(s, p)) continue;
    for (const m of s[p].models) out.push({ id: `${p}:${m}`, provider: p, model: m, label: `${PROVIDER_NAME[p]} · ${m}` });
  }
  return out;
}

function resolve(choiceId, purpose) {
  const s = settings();
  const list = choices(s);
  const pick = list.find((c) => c.id === choiceId) || list.find((c) => c.id === s.selected[purpose]) || list[0];
  if (!pick) throw new Error('No AI model is set up. Add an API connection in File > AI Settings.');
  return { s, ...pick };
}

function remember(purpose, choiceId) {
  const ai = { ...(ctx.getConfig().ai || {}) };
  ai.selected = { ...(ai.selected || {}), [purpose]: choiceId };
  ctx.saveConfig({ ai });
}

// ------------------------------------------------------------------ clients ---

function anthropicClient(s) {
  const key = openKey(s.claude.key);
  if (!key) throw new Error('No Claude API key. Add one in File > AI Settings.');
  return new Anthropic({ apiKey: key });
}

function openaiClient(s, provider) {
  const entry = s[provider];
  const key = openKey(entry.key);
  if (provider === 'openai' && !key) throw new Error('No OpenAI API key. Add one in File > AI Settings.');
  return new OpenAI({ apiKey: key || 'local', ...(provider === 'local' ? { baseURL: entry.baseURL } : {}) });
}

function withFallbacks(model, params) {
  if (FALLBACK_MODELS.has(model)) {
    // A policy decline is re-run on a fallback model inside the same call.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) return 'The API key was rejected. Check it in File > AI Settings.';
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) return 'Rate limited by the provider. Try again in a moment.';
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError) return 'Model not found. Check the model list in File > AI Settings.';
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) return 'Could not reach the AI service. Check the network (or that the local server is running).';
  if (err && err.quiet) return err.message;
  if (err && (err.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError)) return 'Cancelled.';
  return String((err && err.message) || err).slice(0, 400);
}

function cleanOutput(text) {
  let t = String(text || '');
  const fence = t.match(/^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) t = fence[1];
  return t.replace(/^\n+|\n+$/g, '');
}

// ------------------------------------------------------------ one-shot edit ---

function editMessage({ instruction, selection, before, after, fileName }) {
  return [
    fileName ? `File: ${fileName}` : '',
    'Lines before the selection:', '<before>', before || '', '</before>',
    'Selected lines to rewrite:', '<selection>', selection, '</selection>',
    'Lines after the selection:', '<after>', after || '', '</after>',
    `Instruction: ${instruction}`,
  ].filter((l) => l !== '').join('\n');
}

async function complete(pick, system, messages, signal) {
  if (pick.provider === 'claude') {
    const client = anthropicClient(pick.s);
    const response = await client.beta.messages.create(
      withFallbacks(pick.model, { model: pick.model, max_tokens: 16000, system, messages }),
      { signal }
    );
    if (response.stop_reason === 'refusal') {
      const why = response.stop_details && response.stop_details.explanation;
      throw new Error(`The model declined this request.${why ? ` ${why}` : ''}`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off (too long). Try a shorter selection.');
    return { text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), model: response.model || pick.model };
  }
  const client = openaiClient(pick.s, pick.provider);
  const response = await client.chat.completions.create(
    { model: pick.model, messages: [{ role: 'system', content: system }, ...messages] },
    { signal }
  );
  const choice = response.choices && response.choices[0];
  if (!choice || !choice.message) throw new Error('The model returned no answer.');
  if (choice.finish_reason === 'length') throw new Error('The answer was cut off (too long). Try a shorter selection.');
  return { text: choice.message.content || '', model: response.model || pick.model };
}

const running = new Map(); // key -> AbortController

async function runEdit(request, choiceId, key) {
  const controller = new AbortController();
  running.set(key, controller);
  try {
    const pick = resolve(choiceId, 'edit');
    const result = await complete(pick, EDIT_PROMPT, [{ role: 'user', content: editMessage(request) }], controller.signal);
    const text = cleanOutput(result.text);
    if (!text.trim()) throw new Error('The model returned an empty answer.');
    return { ok: true, text, by: `AI (${pick.model})` };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  } finally {
    if (running.get(key) === controller) running.delete(key);
  }
}

// --------------------------------------------------------------------- chat ---

function refsText(refs) {
  if (!refs || !refs.length) return '';
  return refs
    .map((r) => `<reference file="${r.path}" lines="${r.startLine}-${r.endLine}">\n${r.text}\n</reference>`)
    .join('\n');
}

// History from the page: [{ role, content, refs }]. Adjacent same-role turns
// are merged, and the conversation starts with a user turn.
function chatMessages(history) {
  const out = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = String(m.content || '').slice(0, 40000);
    if (role === 'user') {
      const refs = refsText(m.refs);
      if (refs) content = `${refs}\n\n${content}`;
      content = `[Mode: ${m.mode === 'read' ? 'read-only' : 'write'}]\n${content}`;
    }
    if (!content.trim()) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ------------------------------------------------------- chat: tools ---

const TOOL_DEFS = [
  {
    name: 'read_unit',
    description: 'Read the exact text of one unit from the index, e.g. "sections/method.tex#4". Use it before writing an edit.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Unit id as shown in the index, file#n' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read lines of a project file exactly as they are. Up to 400 lines per call.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path as listed in the index' },
        start_line: { type: 'integer', description: 'First line (1-based). Defaults to 1.' },
        end_line: { type: 'integer', description: 'Last line (inclusive). Defaults to the end.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Find lines containing a text (case-insensitive) across the project. Returns path:line: text, up to 40 matches.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to look for' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'expand',
    description: 'List the units inside a file or unit with their summaries (use when the index leaves them out).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'A file path or a unit id' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_history',
    description: 'Read the full text of an earlier part of this conversation that is only shown summarized, e.g. "h2".',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'History block id, h1, h2, ...' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
const MAX_TOOL_ROUNDS = 8;

// Checks a tool input against the schema (types and required fields) and runs it.
function runTool(tools, name, input) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return { ok: false, text: `Unknown tool ${name}` };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, text: 'Invalid input: expected an object' };
  const props = def.input_schema.properties;
  for (const k of def.input_schema.required) if (input[k] == null || input[k] === '') return { ok: false, text: `Invalid input: ${k} is required` };
  for (const [k, v] of Object.entries(input)) {
    if (!props[k]) return { ok: false, text: `Invalid input: unknown field ${k}` };
    if (props[k].type === 'string' && typeof v !== 'string') return { ok: false, text: `Invalid input: ${k} must be a string` };
    if (props[k].type === 'integer' && !Number.isInteger(v)) return { ok: false, text: `Invalid input: ${k} must be an integer` };
  }
  return { ok: true, text: tools[name](input) };
}

function toolStatus(name, input) {
  const i = input || {};
  if (name === 'read_unit') return `Reading ${i.id || 'a unit'}…`;
  if (name === 'read_file') return `Reading ${i.path || 'a file'}${i.start_line ? ` ${i.start_line}-${i.end_line || ''}` : ''}…`;
  if (name === 'search') return `Searching for “${String(i.query || '').slice(0, 40)}”…`;
  if (name === 'expand') return `Opening ${i.id || 'the index'}…`;
  if (name === 'read_history') return `Re-reading earlier messages (${i.id || ''})…`;
  return 'Working…';
}

// ------------------------------------------------- chat: history compaction ---
//
// The newest messages, up to RECENT_CHARS, are sent as they are. Older ones
// are grouped into blocks of up to BLOCK_CHARS, each replaced by a summary
// (summary model; cached by content hash) that the model can open again with
// read_history.

const RECENT_CHARS = 20000;
const BLOCK_CHARS = 8000;
const HISTORY_PROMPT = `Summarize this part of a conversation between a user and an assistant working on a LaTeX
paper, in at most 80 words: what was asked, what was decided or changed, and anything left open.
Answer with the summary only.`;

const historyCache = new Map(); // hash -> summary (persisted per project dir)

function renderTurn(m) {
  const refs = (m.refs || []).map((r) => `[ref ${r.path}:${r.startLine}-${r.endLine}]`).join(' ');
  return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${refs ? `${refs} ` : ''}${String(m.content || '')}`;
}

async function compactHistory(history, summarizer, cacheFile) {
  const size = (m) => String(m.content || '').length + (m.refs || []).reduce((n, r) => n + r.text.length, 0);
  let used = 0;
  let cut = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = size(history[i]);
    if (used + s > RECENT_CHARS && history.length - i > 2) break;
    used += s;
    cut = i;
  }
  const older = history.slice(0, cut);
  const blocks = [];
  let cur = null;
  older.forEach((m, i) => {
    const t = renderTurn(m);
    if (!cur || cur.text.length + t.length > BLOCK_CHARS) {
      cur = { id: `h${blocks.length + 1}`, from: i + 1, to: i + 1, text: '' };
      blocks.push(cur);
    }
    cur.text += (cur.text ? '\n\n' : '') + t;
    cur.to = i + 1;
  });
  if (cacheFile && !historyCache.size) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(require('fs').readFileSync(cacheFile, 'utf8')))) historyCache.set(k, v);
    } catch {
      /* none yet */
    }
  }
  let changed = false;
  for (const b of blocks) {
    const key = require('crypto').createHash('sha1').update(b.text).digest('hex').slice(0, 20);
    if (historyCache.has(key)) {
      b.summary = historyCache.get(key);
      continue;
    }
    if (summarizer) {
      try {
        b.summary = (await summarizer(HISTORY_PROMPT, b.text)).trim().slice(0, 800);
        historyCache.set(key, b.summary);
        changed = true;
      } catch {
        b.summary = '';
      }
    }
    if (!b.summary) {
      // No summary model: the start of each message.
      b.summary = b.text.split('\n\n').map((t) => t.slice(0, 140).replace(/\s+/g, ' ')).join(' / ');
    }
  }
  if (changed && cacheFile) {
    try {
      require('fs').writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(historyCache)));
    } catch {
      /* best effort */
    }
  }
  return { recent: history.slice(cut), blocks };
}

// --------------------------------------------------------- summary model ---

function summaryPick() {
  const s = settings();
  if (!s.summary) return null;
  const c = choices(s).find((x) => x.id === s.summary);
  return c ? { s, ...c } : null;
}

const summarizerFor = (pick, signal) =>
  pick ? async (system, user) => (await complete(pick, system, [{ role: 'user', content: user }], signal)).text : null;

// ------------------------------------------------- background summarizing ---
//
// Started when a project page opens and re-run every couple of minutes while
// it stays open (the page pings). Only units whose text changed are
// summarized. With a paid summary model, a first pass larger than the token
// limit waits for the user's go-ahead in the chat panel.

const indexJobs = new Map(); // project dir -> { running, status, approved, listeners:Set<webContents> }

function pushStatus(job) {
  for (const wc of job.listeners) if (!wc.isDestroyed()) wc.send('ai:index-status', job.status);
}

async function runIndexJob(projectId, sender) {
  const p = projectIndex.stateFor(ctx.getConfig().current, projectId);
  let job = indexJobs.get(p.dir);
  if (!job) {
    job = { running: false, status: { projectId, state: 'idle' }, approved: false, listeners: new Set() };
    indexJobs.set(p.dir, job);
  }
  if (sender) job.listeners.add(sender);
  pushStatus(job);
  if (job.running) return;
  job.running = true;
  try {
    await projectIndex.refresh(p);
    const pick = summaryPick();
    const base = { projectId, ...projectIndex.stats(p), model: pick ? pick.model : null };
    if (!pick) {
      job.status = { ...base, state: 'no-model' };
      return;
    }
    const est = projectIndex.estimateTokens(p);
    if (!est.units) {
      job.status = { ...base, state: 'ready' };
      return;
    }
    const limit = settings().tokenLimit;
    if (pick.provider !== 'local' && est.tokens > limit && !job.approved) {
      job.status = { ...base, state: 'needs-approval', estimate: est };
      return;
    }
    job.status = { ...base, state: 'summarizing', done: 0, total: est.units };
    pushStatus(job);
    const result = await projectIndex.summarize(p, summarizerFor(pick), {
      onProgress: ({ done, total }) => {
        job.status = { ...base, ...projectIndex.stats(p), state: 'summarizing', done, total };
        pushStatus(job);
      },
      shouldStop: () => job.stop === true,
    });
    job.status = { ...base, ...projectIndex.stats(p), state: result.stopped ? 'paused' : 'ready' };
  } catch (err) {
    job.status = { projectId, state: 'error', error: friendly(err) };
  } finally {
    job.running = false;
    job.stop = false;
    pushStatus(job);
  }
}

// --------------------------------------------------------------- chat: run ---

const pauses = new Map(); // `${sender.id}:${requestId}` -> resolve(boolean)

function estimate(chars) {
  return Math.ceil(chars / 3.5);
}

async function runChat(sender, req) {
  const id = req.requestId;
  const send = (type, payload = {}) => {
    if (!sender.isDestroyed()) sender.send('ai:chat-event', { id, type, ...payload });
  };
  const controller = new AbortController();
  const key = `chat:${sender.id}:${id}`;
  running.set(key, controller);
  try {
    const pick = resolve(req.choiceId, 'chat');
    const s = pick.s;
    const metered = pick.provider !== 'local';
    let allowance = s.tokenLimit;
    let used = 0;
    // Pauses before a call that would go over the allowance; resolves false to stop.
    const checkBudget = async (nextTokens) => {
      if (!metered || used + nextTokens <= allowance) return true;
      send('pause', { used, next: nextTokens, limit: s.tokenLimit });
      const go = await new Promise((r) => pauses.set(`${sender.id}:${id}`, r));
      pauses.delete(`${sender.id}:${id}`);
      if (go) allowance = used + nextTokens + s.tokenLimit;
      send('status', { text: go ? 'Continuing…' : 'Stopped at your request.' });
      return go;
    };

    send('status', { text: 'Reading the project index…', model: pick.model });
    const p = projectIndex.stateFor(ctx.getConfig().current, req.projectId);
    await projectIndex.refresh(p);
    const ws = projectIndex.workspace(p, req.openDoc);

    send('status', { text: 'Preparing the conversation…' });
    const sumPick = summaryPick();
    const { recent, blocks } = await compactHistory(req.history || [], summarizerFor(sumPick, controller.signal), require('path').join(p.dir, 'history.json'));
    const messages = chatMessages(recent);
    if (!messages.length) throw new Error('Nothing to send.');
    const history = blocks.length
      ? `\n\nEarlier in this conversation (summarized; call read_history with the id to read a part in full):\n${blocks
          .map((b) => `[${b.id}] messages ${b.from}-${b.to}: ${b.summary}`)
          .join('\n')}`
      : '';
    const openNote = req.openDoc && req.openDoc.path ? `\n\nThe file open in the editor is ${req.openDoc.path}.` : '';
    const tools = {
      ...ws.tools,
      read_history: ({ id: hid }) => {
        const b = blocks.find((x) => x.id === hid);
        return b ? b.text : `No history block ${hid}. Blocks: ${blocks.map((x) => x.id).join(', ') || 'none'}`;
      },
    };
    const context = `${ws.index}${openNote}${history}`;
    if (!(await checkBudget(estimate(CHAT_PROMPT.length + context.length + JSON.stringify(messages).length)))) {
      throw Object.assign(new Error('Stopped before sending: the request would go over the token limit.'), { quiet: true });
    }
    send('status', { text: 'Thinking…' });

    let text = '';
    let rounds = 0;
    let stopped = false;
    if (pick.provider === 'claude') {
      const client = anthropicClient(s);
      // Client tools streamed with eager input; inputs are validated in runTool.
      const defs = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));
      const msgs = messages.slice();
      for (;;) {
        const stream = client.beta.messages.stream(
          withFallbacks(pick.model, {
            model: pick.model,
            max_tokens: 64000,
            cache_control: { type: 'ephemeral' },
            // The index is the long, stable part: cache it between turns.
            system: [
              { type: 'text', text: CHAT_PROMPT },
              { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
            ],
            tools: defs,
            messages: msgs,
          }),
          { signal: controller.signal }
        );
        stream.on('text', (delta) => {
          text += delta;
          send('delta', { text: delta });
        });
        const final = await stream.finalMessage();
        const u = final.usage || {};
        used += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        send('usage', { used });
        if (final.stop_reason === 'refusal') {
          const why = final.stop_details && final.stop_details.explanation;
          throw new Error(`The model declined this request.${why ? ` ${why}` : ''}`);
        }
        if (final.stop_reason === 'max_tokens') {
          send('notice', { text: 'The answer was cut off at the length limit.' });
          break;
        }
        // Thinking and tool blocks go back unchanged.
        msgs.push({ role: 'assistant', content: final.content });
        if (final.stop_reason !== 'tool_use') break;
        if (++rounds > MAX_TOOL_ROUNDS) {
          send('notice', { text: 'Stopped after too many lookups.' });
          break;
        }
        const results = [];
        for (const block of final.content) {
          if (block.type !== 'tool_use') continue;
          send('status', { text: toolStatus(block.name, block.input) });
          const r = runTool(tools, block.name, block.input);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
        }
        msgs.push({ role: 'user', content: results });
        if (text && !text.endsWith('\n')) {
          text += '\n';
          send('delta', { text: '\n' });
        }
        // The next round resends everything; ask first if that goes over the limit.
        const next = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) + estimate(JSON.stringify(results).length);
        if (!(await checkBudget(next))) {
          stopped = true;
          break;
        }
      }
    } else {
      const client = openaiClient(s, pick.provider);
      const defs = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      const msgs = [{ role: 'system', content: `${CHAT_PROMPT}\n\n${context}` }, ...messages];
      for (;;) {
        const response = await client.chat.completions.create({ model: pick.model, messages: msgs, tools: defs }, { signal: controller.signal });
        const u = response.usage || {};
        used += (u.prompt_tokens || 0) + (u.completion_tokens || 0);
        send('usage', { used });
        const choice = response.choices && response.choices[0];
        const msg = choice && choice.message;
        if (!msg) throw new Error('The model returned no answer.');
        if (msg.content) {
          const piece = text && !text.endsWith('\n') ? `\n${msg.content}` : msg.content;
          text += piece;
          send('delta', { text: piece });
        }
        const calls = msg.tool_calls || [];
        msgs.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) {
          if (choice.finish_reason === 'length') send('notice', { text: 'The answer was cut off at the length limit.' });
          break;
        }
        if (++rounds > MAX_TOOL_ROUNDS) {
          send('notice', { text: 'Stopped after too many lookups.' });
          break;
        }
        let added = 0;
        for (const call of calls) {
          let input = null;
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            input = null;
          }
          send('status', { text: toolStatus(call.function.name, input) });
          const r = input ? runTool(tools, call.function.name, input) : { text: 'Invalid input: arguments are not valid JSON' };
          msgs.push({ role: 'tool', tool_call_id: call.id, content: r.text });
          added += r.text.length;
        }
        if (!(await checkBudget((u.prompt_tokens || 0) + (u.completion_tokens || 0) + estimate(added)))) {
          stopped = true;
          break;
        }
      }
    }
    if (!text.trim()) throw new Error(stopped ? 'Stopped before the model answered.' : 'The model returned an empty answer.');
    if (stopped) send('notice', { text: 'Stopped at the token limit; the answer may be incomplete.' });
    send('done', { text, by: `AI (${pick.model})`, lookups: rounds, used });
  } catch (err) {
    send('error', { text: friendly(err) });
  } finally {
    running.delete(key);
    const r = pauses.get(`${sender.id}:${id}`);
    if (r) r(false);
  }
}

// --------------------------------------------------------- model discovery ---

async function fetchModels(provider, form) {
  const s = settings();
  const draft = applyForm(form);
  const merged = { ...s, [provider]: { ...s[provider], ...draft[provider] } };
  if (provider === 'claude') {
    const client = anthropicClient(merged);
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  const client = openaiClient(merged, provider);
  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids.sort();
}

// ------------------------------------------------------------- settings UI ---

function showSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  const parent = ctx.getMainWindow();
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 880,
    minHeight: 500,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: parent || undefined,
    modal: !!parent,
    title: 'AI Settings',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'ai-settings-preload.js'),
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'ai-settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

const fromSettings = (event) => settingsWindow && event.sender === settingsWindow.webContents;
const fromServer = (event) => ctx.isServerUrl(event.senderFrame ? event.senderFrame.url : '');

function init(context) {
  ctx = context;

  ipcMain.handle('ai-settings:get', (event) => (fromSettings(event) ? publicSettings() : null));

  ipcMain.handle('ai-settings:save', (event, form) => {
    if (!fromSettings(event)) return { ok: false, error: 'forbidden' };
    try {
      ctx.saveConfig({ ai: applyForm(form || {}) });
      return { ok: true, settings: publicSettings() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Saves, then sends a one-line request to the connection's first model.
  ipcMain.handle('ai-settings:test', async (event, form, provider) => {
    if (!fromSettings(event) || !PROVIDERS.includes(provider)) return { ok: false, error: 'forbidden' };
    try {
      ctx.saveConfig({ ai: applyForm(form || {}) });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    const s = settings();
    if (!usable(s, provider)) return { ok: false, error: `Add ${provider === 'local' ? 'a server address and' : 'an API key and'} at least one model first.` };
    const res = await runEdit(
      { instruction: 'Fix the spelling.', selection: 'Teh quick brown fox.' },
      `${provider}:${s[provider].models[0]}`,
      `test:${event.sender.id}`
    );
    return res.ok ? { ok: true, sample: res.text, by: res.by, settings: publicSettings() } : res;
  });

  ipcMain.handle('ai-settings:models', async (event, form, provider) => {
    if (!fromSettings(event) || !PROVIDERS.includes(provider)) return { ok: false, error: 'forbidden' };
    try {
      return { ok: true, models: await fetchModels(provider, form || {}) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  });

  ipcMain.handle('ai-settings:close', (event) => {
    if (fromSettings(event)) settingsWindow.close();
  });

  // ---- from the editor

  ipcMain.handle('ai:info', (event, purpose) => {
    if (!fromServer(event)) return null;
    const s = settings();
    const list = choices(s);
    const p = purpose === 'chat' ? 'chat' : 'edit';
    const selected = list.find((c) => c.id === s.selected[p]) ? s.selected[p] : list[0] ? list[0].id : null;
    return { choices: list, selected };
  });

  ipcMain.on('ai:select', (event, purpose, choiceId) => {
    if (!fromServer(event) || !['edit', 'chat'].includes(purpose)) return;
    if (choices().some((c) => c.id === choiceId)) remember(purpose, choiceId);
  });

  ipcMain.handle('ai:edit', async (event, request) => {
    if (!fromServer(event)) return { ok: false, error: 'forbidden' };
    const r = request || {};
    const instruction = str(r.instruction, 2000);
    const selection = String(r.selection || '').slice(0, 60000);
    if (!instruction || !selection.trim()) return { ok: false, error: 'Nothing to edit.' };
    return runEdit(
      {
        instruction,
        selection,
        before: String(r.before || '').slice(-6000),
        after: String(r.after || '').slice(0, 6000),
        fileName: str(r.fileName, 200),
      },
      str(r.choiceId, 300),
      `edit:${event.sender.id}`
    );
  });

  ipcMain.on('ai:cancel', (event) => {
    const c = running.get(`edit:${event.sender.id}`);
    if (c) c.abort();
  });

  ipcMain.on('ai:chat-start', (event, req) => {
    if (!fromServer(event) || !req || !/^[0-9a-f]{24}$/.test(String(req.projectId))) return;
    runChat(event.sender, {
      requestId: str(req.requestId, 50),
      choiceId: str(req.choiceId, 300),
      projectId: String(req.projectId),
      history: Array.isArray(req.history) ? req.history.slice(-200) : [],
      openDoc: req.openDoc && typeof req.openDoc.text === 'string'
        ? { path: str(req.openDoc.path, 500), text: req.openDoc.text.slice(0, 2000000) }
        : null,
    });
  });

  ipcMain.on('ai:chat-cancel', (event, requestId) => {
    const c = running.get(`chat:${event.sender.id}:${requestId}`);
    if (c) c.abort();
    const r = pauses.get(`${event.sender.id}:${requestId}`);
    if (r) r(false);
  });

  ipcMain.handle('ai:reindex', async (event, projectId) => {
    if (!fromServer(event) || !/^[0-9a-f]{24}$/.test(String(projectId))) return { ok: false };
    try {
      const p = projectIndex.stateFor(ctx.getConfig().current, String(projectId));
      await projectIndex.refresh(p, { force: true });
      runIndexJob(String(projectId), event.sender);
      return { ok: true, ...projectIndex.stats(p) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  });

  // The project page opened, or is still open (pinged every 2 minutes):
  // refresh the copy and summarize what changed, in the background.
  ipcMain.on('ai:project-open', (event, projectId) => {
    if (!fromServer(event) || !/^[0-9a-f]{24}$/.test(String(projectId))) return;
    runIndexJob(String(projectId), event.sender);
  });

  // Answer to "summarizing this project needs ~N tokens".
  ipcMain.on('ai:index-approve', (event, projectId, allow) => {
    if (!fromServer(event) || !/^[0-9a-f]{24}$/.test(String(projectId))) return;
    const p = projectIndex.stateFor(ctx.getConfig().current, String(projectId));
    const job = indexJobs.get(p.dir);
    if (!job) return;
    if (allow) {
      job.approved = true;
      runIndexJob(String(projectId), event.sender);
    } else {
      job.status = { ...job.status, state: 'declined' };
      pushStatus(job);
    }
  });

  // Edit blocks per file, for the review counter (n/N) in the editor.
  ipcMain.handle('ai:list-edits', async (event, projectId) => {
    if (!fromServer(event) || !/^[0-9a-f]{24}$/.test(String(projectId))) return { ok: false };
    try {
      const p = projectIndex.stateFor(ctx.getConfig().current, String(projectId));
      await projectIndex.refresh(p, { maxAge: 15000 });
      const files = p.files
        .map((f) => ({ path: f.path, count: (f.text.match(/^\s*%%edit:begin\b/gm) || []).length }))
        .filter((f) => f.count > 0);
      return { ok: true, files };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  });

  // Answer to a paused chat request.
  ipcMain.on('ai:chat-continue', (event, requestId, go) => {
    const r = pauses.get(`${event.sender.id}:${requestId}`);
    if (r) r(!!go);
  });

  ipcMain.on('ai:open-settings', (event) => {
    if (fromServer(event)) showSettings();
  });

  // Ctrl+L in the bottom split pane: hand the reference to the main page's chat.
  ipcMain.on('ai:ref', (event, ref) => {
    if (!fromServer(event)) return;
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed() && event.sender !== win.webContents) win.webContents.send('ai:ref', ref);
  });
}

module.exports = { init, showSettings };
