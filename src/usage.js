'use strict';

// Spending estimate: token usage reported by the APIs for every request this
// app makes (chat, Ctrl+K, summaries), priced per model, kept per month in
// ai-usage.json in the app data folder. Other apps or computers using the same
// key are not included. Models without a known price count tokens only.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// USD per 1M tokens: input, output, cache read (cache writes are 1.25 x input).
const PRICES = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-mythos-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 1],
  'claude-mythos-5-1': [10, 50, 1],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
};

const file = () => path.join(app.getPath('userData'), 'ai-usage.json');
let data = null;

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = { months: {} };
  }
  if (!data.months) data.months = {};
  return data;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(data));
  } catch {
    /* best effort */
  }
}

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Model ids from responses may carry a date suffix; match by prefix.
function priceOf(model) {
  const m = String(model || '');
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => m === k || m.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
}

function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const [inp, out, read] = p;
  return ((u.input || 0) * inp + (u.cacheWrite || 0) * inp * 1.25 + (u.cacheRead || 0) * read + (u.output || 0) * out) / 1e6;
}

// provider: claude | openai | local. usage: { input, output, cacheRead, cacheWrite }.
function record(provider, model, usage) {
  if (provider === 'local' || !usage) return;
  const d = load();
  const month = (d.months[monthKey()] ||= {});
  const key = `${provider}:${model}`;
  const e = (month[key] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: true });
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) e[k] += Math.max(0, Number(usage[k]) || 0);
  const c = costOf(model, usage);
  if (c == null) e.priced = false;
  else e.cost += c;
  save();
}

// From an Anthropic usage object.
const fromAnthropic = (u = {}) => ({
  input: u.input_tokens || 0,
  output: u.output_tokens || 0,
  cacheRead: u.cache_read_input_tokens || 0,
  cacheWrite: u.cache_creation_input_tokens || 0,
});
// From an OpenAI usage object.
const fromOpenAI = (u = {}) => {
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return { input: Math.max(0, (u.prompt_tokens || 0) - cached), cacheRead: cached, output: u.completion_tokens || 0, cacheWrite: 0 };
};

// This month's totals for one provider (or all): { cost, tokens, unpricedTokens, models }.
function summary(provider) {
  const month = load().months[monthKey()] || {};
  const out = { month: monthKey(), cost: 0, tokens: 0, unpricedTokens: 0, models: [] };
  for (const [key, e] of Object.entries(month)) {
    const [prov, ...rest] = key.split(':');
    if (provider && prov !== provider) continue;
    const tokens = e.input + e.output + e.cacheRead + e.cacheWrite;
    out.tokens += tokens;
    if (e.priced) out.cost += e.cost;
    else out.unpricedTokens += tokens;
    out.models.push({ provider: prov, model: rest.join(':'), tokens, cost: e.priced ? e.cost : null });
  }
  out.models.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.tokens - a.tokens);
  return out;
}

module.exports = { record, fromAnthropic, fromOpenAI, summary };
