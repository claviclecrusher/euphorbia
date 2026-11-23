'use strict';

// AI edits: settings (provider, model, API keys) and the calls themselves.
// Everything runs in the main process so API keys never reach the Overleaf
// page; the page only sends the selected text and the instruction.
//
// Providers: Claude (Anthropic SDK), OpenAI (OpenAI SDK), and a local model
// served through an OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp).

const { BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const PROVIDERS = ['claude', 'openai', 'local'];
const DEFAULTS = {
  provider: 'claude',
  claude: { model: 'claude-opus-5-5' },
  openai: { model: '' },
  local: { model: '', baseURL: 'http://localhost:11434/v1' },
};
// Models that accept server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

const SYSTEM_PROMPT = [
  'You edit passages of a LaTeX document.',
  'You receive the selected lines, some surrounding lines for context, and an instruction.',
  'Rewrite only the selected lines according to the instruction.',
  'Keep LaTeX commands, labels, citations and math intact unless the instruction says otherwise,',
  'and keep the language of the original text unless asked to translate.',
  'Reply with the replacement text for the selected lines only: no explanation, no code fences,',
  'nothing before or after it.',
].join(' ');

let ctx = null;
let settingsWindow = null;

// ---------------------------------------------------------------- settings ---

function settings() {
  const s = ctx.getConfig().ai || {};
  return {
    provider: PROVIDERS.includes(s.provider) ? s.provider : DEFAULTS.provider,
    claude: { ...DEFAULTS.claude, ...(s.claude || {}) },
    openai: { ...DEFAULTS.openai, ...(s.openai || {}) },
    local: { ...DEFAULTS.local, ...(s.local || {}) },
  };
}

// Keys are encrypted with the OS keychain when available.
function sealKey(key) {
  if (!key) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(key).toString('base64');
  }
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

// What the settings window sees: never the keys themselves.
function publicSettings() {
  const s = settings();
  return {
    provider: s.provider,
    claude: { model: s.claude.model, hasKey: !!openKey(s.claude.key) },
    openai: { model: s.openai.model, hasKey: !!openKey(s.openai.key) },
    local: { model: s.local.model, baseURL: s.local.baseURL, hasKey: !!openKey(s.local.key) },
    encrypted: safeStorage.isEncryptionAvailable(),
  };
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// `form`: { provider, claude: { model, key? }, openai: {...}, local: { model, baseURL, key? } }.
// A key field left empty keeps the stored key; `clearKey` removes it.
function applyForm(form) {
  const current = settings();
  const next = { provider: PROVIDERS.includes(form.provider) ? form.provider : current.provider };
  for (const p of PROVIDERS) {
    const f = (form && form[p]) || {};
    const entry = { ...current[p], model: str(f.model, 200) };
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

// ------------------------------------------------------------------ calls ---

function describe(s) {
  const p = s.provider;
  const model = s[p].model;
  const name = p === 'claude' ? 'Claude' : p === 'openai' ? 'OpenAI' : 'Local';
  return { provider: p, model, label: `AI (${model || name})` };
}

function userMessage({ instruction, selection, before, after, fileName }) {
  return [
    fileName ? `File: ${fileName}` : '',
    'Lines before the selection:',
    '<before>',
    before || '',
    '</before>',
    'Selected lines to rewrite:',
    '<selection>',
    selection,
    '</selection>',
    'Lines after the selection:',
    '<after>',
    after || '',
    '</after>',
    `Instruction: ${instruction}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// Models sometimes wrap the answer in a code fence anyway.
function cleanOutput(text) {
  let t = String(text || '');
  const fence = t.match(/^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) t = fence[1];
  return t.replace(/^\n+|\n+$/g, '');
}

async function callClaude(s, prompt, signal) {
  const key = openKey(s.claude.key);
  if (!key) throw new Error('No Claude API key. Add one in File > AI Settings.');
  const client = new Anthropic({ apiKey: key });
  const model = s.claude.model || DEFAULTS.claude.model;
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  };
  if (FALLBACK_MODELS.has(model)) {
    // A policy decline is re-run on a fallback model inside the same call.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const response = await client.beta.messages.create(params, { signal });
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details && response.stop_details.explanation;
    throw new Error(`The model declined this request.${why ? ` ${why}` : ''}`);
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off (too long). Try a shorter selection.');
  return { text, model: response.model || model };
}

async function callOpenAICompatible(entry, prompt, signal, { local }) {
  const key = openKey(entry.key);
  if (!local && !key) throw new Error('No OpenAI API key. Add one in File > AI Settings.');
  if (!entry.model) throw new Error(`Set a model name for ${local ? 'the local model' : 'OpenAI'} in File > AI Settings.`);
  const client = new OpenAI({
    apiKey: key || 'local',
    ...(local ? { baseURL: entry.baseURL } : {}),
  });
  const response = await client.chat.completions.create(
    {
      model: entry.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    },
    { signal }
  );
  const choice = response.choices && response.choices[0];
  if (!choice || !choice.message) throw new Error('The model returned no answer.');
  if (choice.finish_reason === 'length') throw new Error('The answer was cut off (too long). Try a shorter selection.');
  return { text: choice.message.content || '', model: response.model || entry.model };
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return 'The API key was rejected. Check it in File > AI Settings.';
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    return 'Rate limited by the provider. Try again in a moment.';
  }
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError) {
    return 'Model not found. Check the model name in File > AI Settings.';
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return 'Could not reach the AI service. Check the network (or that the local server is running).';
  }
  if (err && err.name === 'AbortError') return 'Cancelled.';
  return String((err && err.message) || err).slice(0, 400);
}

const running = new Map(); // webContents id -> AbortController

async function runEdit(request, contentsId) {
  const s = settings();
  const prompt = userMessage(request);
  const controller = new AbortController();
  running.set(contentsId, controller);
  try {
    let result;
    if (s.provider === 'claude') result = await callClaude(s, prompt, controller.signal);
    else result = await callOpenAICompatible(s[s.provider], prompt, controller.signal, { local: s.provider === 'local' });
    const text = cleanOutput(result.text);
    if (!text.trim()) throw new Error('The model returned an empty answer.');
    return { ok: true, text, by: `AI (${result.model})` };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  } finally {
    if (running.get(contentsId) === controller) running.delete(contentsId);
  }
}

// ------------------------------------------------------------- settings UI ---

function showSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  const parent = ctx.getMainWindow();
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 860,
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

  // Saves, then sends a one-line request with the chosen provider.
  ipcMain.handle('ai-settings:test', async (event, form) => {
    if (!fromSettings(event)) return { ok: false, error: 'forbidden' };
    try {
      ctx.saveConfig({ ai: applyForm(form || {}) });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    const res = await runEdit(
      { instruction: 'Fix the spelling.', selection: 'Teh quick brown fox.', before: '', after: '' },
      event.sender.id
    );
    return res.ok ? { ok: true, sample: res.text, by: res.by, settings: publicSettings() } : res;
  });

  ipcMain.handle('ai-settings:close', (event) => {
    if (fromSettings(event)) settingsWindow.close();
  });

  // From the editor: rewrite the selection.
  ipcMain.handle('ai:edit', async (event, request) => {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!ctx.isServerUrl(frameUrl)) return { ok: false, error: 'forbidden' };
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
      event.sender.id
    );
  });

  ipcMain.on('ai:cancel', (event) => {
    const c = running.get(event.sender.id);
    if (c) c.abort();
  });

  ipcMain.handle('ai:info', (event) => {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!ctx.isServerUrl(frameUrl)) return null;
    return describe(settings());
  });

  ipcMain.on('ai:open-settings', (event) => {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    if (ctx.isServerUrl(frameUrl)) showSettings();
  });
}

module.exports = { init, showSettings };
