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

You are given an index of the project (files, sections with line ranges and their first sentence,
labels, citation keys), not its full text. Use the read_file and search tools to read what you need.
Read the exact lines before you edit them.

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
- Copy <find> text exactly from what read_file returned; never paraphrase it or include line numbers.
- Keep each edit small: only the lines that change, plus enough to be unique.
- Do not put edit blocks inside markdown code fences.
- Do not edit lines inside %%edit: or %%cand: blocks.
- Keep LaTeX commands, labels, citations and math intact unless asked otherwise.
- Before the edit blocks, say in one or two sentences what you are changing. The user reviews
  every edit and accepts or rejects it.

Passages the user points at are given as references with their file and line numbers.
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
  const out = { encrypted: safeStorage.isEncryptionAvailable() };
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
  for (const m of history.slice(-30)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = String(m.content || '').slice(0, 40000);
    if (role === 'user') {
      const refs = refsText(m.refs);
      if (refs) content = `${refs}\n\n${content}`;
    }
    if (!content.trim()) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Tools the chat model can call. The app answers them from the stored project.
const TOOL_DEFS = [
  {
    name: 'read_file',
    description:
      'Read lines of a project file exactly as they are. Use it before writing an edit, and copy <find> text from what it returns. Up to 400 lines per call.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path as listed in the index, e.g. sections/method.tex' },
        start_line: { type: 'integer', description: 'First line (1-based). Defaults to 1.' },
        end_line: { type: 'integer', description: 'Last line (inclusive). Defaults to the end of the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Find lines containing a text (case-insensitive) across the project. Returns path:line: text for up to 40 matches.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to look for' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
const MAX_TOOL_ROUNDS = 8;

// Checks a tool input against the schema above and runs it.
function runTool(ws, name, input) {
  const bad = (msg) => ({ ok: false, text: `Invalid input: ${msg}` });
  if (!input || typeof input !== 'object') return bad('expected an object');
  const intOrNull = (v) => v == null || Number.isInteger(v);
  if (name === 'read_file') {
    if (typeof input.path !== 'string' || !input.path) return bad('path must be a string');
    if (!intOrNull(input.start_line) || !intOrNull(input.end_line)) return bad('line numbers must be integers');
    return { ok: true, text: ws.readFile(input.path, input.start_line, input.end_line) };
  }
  if (name === 'search') {
    if (typeof input.query !== 'string' || !input.query) return bad('query must be a string');
    return { ok: true, text: ws.search(input.query) };
  }
  return { ok: false, text: `Unknown tool ${name}` };
}

function toolStatus(name, input) {
  if (name === 'read_file' && input && input.path) {
    return `Reading ${input.path}${input.start_line ? ` ${input.start_line}-${input.end_line || ''}` : ''}…`;
  }
  if (name === 'search' && input && input.query) return `Searching for “${String(input.query).slice(0, 40)}”…`;
  return 'Working…';
}

async function runChat(sender, req) {
  const id = req.requestId;
  const send = (type, payload = {}) => {
    if (!sender.isDestroyed()) sender.send('ai:chat-event', { id, type, ...payload });
  };
  const controller = new AbortController();
  running.set(`chat:${sender.id}:${id}`, controller);
  try {
    const pick = resolve(req.choiceId, 'chat');
    send('status', { text: 'Reading the project index…', model: pick.model });
    const data = await projectIndex.getProject(ctx.getConfig().current, req.projectId);
    const ws = projectIndex.workspace(data, req.openDoc);
    const openNote = req.openDoc && req.openDoc.path ? `\n\nThe file open in the editor is ${req.openDoc.path}.` : '';
    const messages = chatMessages(req.history || []);
    if (!messages.length) throw new Error('Nothing to send.');
    send('status', { text: 'Thinking…' });

    let text = '';
    let rounds = 0;
    if (pick.provider === 'claude') {
      const client = anthropicClient(pick.s);
      // Client tools streamed with eager input; inputs are validated in runTool.
      const tools = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));
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
              { type: 'text', text: `${ws.index}${openNote}`, cache_control: { type: 'ephemeral' } },
            ],
            tools,
            messages: msgs,
          }),
          { signal: controller.signal }
        );
        stream.on('text', (delta) => {
          text += delta;
          send('delta', { text: delta });
        });
        const final = await stream.finalMessage();
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
          const r = runTool(ws, block.name, block.input);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
        }
        msgs.push({ role: 'user', content: results });
        if (text && !text.endsWith('\n')) {
          text += '\n';
          send('delta', { text: '\n' });
        }
      }
    } else {
      const client = openaiClient(pick.s, pick.provider);
      const tools = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      const msgs = [{ role: 'system', content: `${CHAT_PROMPT}\n\n${ws.index}${openNote}` }, ...messages];
      for (;;) {
        const response = await client.chat.completions.create({ model: pick.model, messages: msgs, tools }, { signal: controller.signal });
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
        for (const call of calls) {
          let input = null;
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            input = null;
          }
          send('status', { text: toolStatus(call.function.name, input) });
          const r = input ? runTool(ws, call.function.name, input) : { text: 'Invalid input: arguments are not valid JSON' };
          msgs.push({ role: 'tool', tool_call_id: call.id, content: r.text });
        }
      }
    }
    if (!text.trim()) throw new Error('The model returned an empty answer.');
    send('done', { text, by: `AI (${pick.model})`, lookups: rounds });
  } catch (err) {
    send('error', { text: friendly(err) });
  } finally {
    running.delete(`chat:${sender.id}:${id}`);
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
      history: Array.isArray(req.history) ? req.history.slice(-40) : [],
      openDoc: req.openDoc && typeof req.openDoc.text === 'string'
        ? { path: str(req.openDoc.path, 500), text: req.openDoc.text.slice(0, 2000000) }
        : null,
    });
  });

  ipcMain.on('ai:chat-cancel', (event, requestId) => {
    const c = running.get(`chat:${event.sender.id}:${requestId}`);
    if (c) c.abort();
  });

  ipcMain.handle('ai:reindex', async (event, projectId) => {
    if (!fromServer(event) || !/^[0-9a-f]{24}$/.test(String(projectId))) return { ok: false };
    try {
      const data = await projectIndex.getProject(ctx.getConfig().current, String(projectId), { force: true });
      return { ok: true, ...projectIndex.stats(data) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
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
