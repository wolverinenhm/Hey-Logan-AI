'use strict';

/**
 * Built-in AI chat agent.
 *
 * Talks to OpenAI-compatible chat-completion endpoints over HTTPS. Providers
 * are tried in order until one answers, so the assistant works out of the box:
 *
 *   1. Local models (Ollama, LM Studio) when they are running on this PC -
 *      free, open-source, private, no key.
 *   2. Any hosted provider you gave an API key to (free-tier keys from Groq,
 *      Google Gemini, OpenRouter, Cerebras, Mistral; or paid OpenAI/DeepSeek/
 *      any custom OpenAI-compatible endpoint).
 *   3. Pollinations.AI's public anonymous endpoint - free, no key, no signup,
 *      but rate-limited per IP (about one request every 30 seconds).
 *
 * No API key is ever stored in this repository. Keys come from environment
 * variables or from data/config.json -> ai.providers.<id>.apiKey on the user's
 * own machine (data/ is git-ignored), and they are never sent to the browser.
 */

const { firstSentences, truncate } = require('../util');

const DEFAULT_SYSTEM_PROMPT =
  'You are Logan, a friendly voice assistant running on the user\'s own computer. ' +
  'Your replies are read aloud, so answer in plain spoken English: short, direct, ' +
  'usually one to three sentences, with no markdown, lists, tables or code blocks ' +
  'unless the user explicitly asks for detail. If you do not know something, say so.';

/**
 * Provider catalog. `tier` drives the default order and the UI text:
 *  - local:   runs on this PC, no key, only used when reachable
 *  - keyless: public endpoint, no key needed
 *  - free-key: needs a (free) API key from the provider
 *  - paid:    needs a paid API key
 * Every field can be overridden in data/config.json -> ai.providers.<id>.
 * Model names change over time: override `model` if a provider retires one.
 */
const PROVIDERS = [
  {
    id: 'ollama',
    name: 'Ollama (local)',
    tier: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    signup: 'https://ollama.com/download'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    tier: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    signup: 'https://lmstudio.ai'
  },
  {
    id: 'groq',
    name: 'Groq',
    tier: 'free-key',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    tier: 'free-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (free models)',
    tier: 'free-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/keys'
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    tier: 'free-key',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    keyEnv: 'CEREBRAS_API_KEY',
    signup: 'https://cloud.cerebras.ai'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    tier: 'free-key',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    keyEnv: 'MISTRAL_API_KEY',
    signup: 'https://console.mistral.ai/api-keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    tier: 'paid',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    keyEnv: 'OPENAI_API_KEY',
    signup: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tier: 'paid',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
    signup: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    tier: 'paid',
    baseUrl: '',
    model: '',
    keyEnv: 'HEY_AI_CUSTOM_API_KEY',
    signup: ''
  },
  {
    id: 'pollinations',
    name: 'Pollinations.AI (free, no key)',
    tier: 'keyless',
    // Classic anonymous endpoint: OpenAI-compatible, no key, per-IP rate limit.
    baseUrl: 'https://text.pollinations.ai',
    chatPath: '/openai',
    model: '',
    signup: 'https://pollinations.ai'
  }
];

const TIER_ORDER = { local: 0, 'free-key': 1, paid: 2, keyless: 3 };

function aiConfig(config) {
  return (config && config.ai) || {};
}

/** Merge a catalog entry with the user's overrides and resolve its API key. */
function resolveProvider(def, config, env = process.env) {
  const overrides = (aiConfig(config).providers || {})[def.id] || {};
  const merged = { ...def, ...overrides, id: def.id, tier: def.tier };
  const apiKey = String(overrides.apiKey || (def.keyEnv && env[def.keyEnv]) || '').trim();
  merged.apiKey = apiKey;
  merged.enabled = overrides.enabled !== false;
  merged.baseUrl = String(merged.baseUrl || '').replace(/\/+$/, '');
  return merged;
}

/** True when the provider can be tried without probing the network. */
function isConfigured(provider) {
  if (!provider.enabled || !provider.baseUrl) return false;
  // A custom endpoint may be a keyless local server (e.g. llama.cpp, vLLM).
  if (provider.id === 'custom') return true;
  if (provider.tier === 'free-key' || provider.tier === 'paid') return Boolean(provider.apiKey);
  return true;
}

/**
 * The ordered list of providers to try for one request.
 * config.ai.provider: 'auto' (default) or one provider id to force.
 * config.ai.order: optional explicit list of provider ids.
 */
function providerChain(config, env = process.env) {
  const cfg = aiConfig(config);
  const all = PROVIDERS.map((def) => resolveProvider(def, config, env));
  const forced = cfg.provider && cfg.provider !== 'auto' ? all.find((p) => p.id === cfg.provider) : null;
  if (forced) return isConfigured(forced) ? [forced] : [];

  let ordered;
  if (Array.isArray(cfg.order) && cfg.order.length) {
    ordered = cfg.order.map((id) => all.find((p) => p.id === id)).filter(Boolean);
  } else {
    ordered = all
      .map((p, index) => ({ p, index }))
      .sort((a, b) => TIER_ORDER[a.p.tier] - TIER_ORDER[b.p.tier] || a.index - b.index)
      .map(({ p }) => p);
  }
  return ordered.filter(isConfigured);
}

/** Public summary for the UI and the console - never includes keys. */
function describeProviders(config, env = process.env) {
  const chain = providerChain(config, env).map((p) => p.id);
  return PROVIDERS.map((def) => {
    const p = resolveProvider(def, config, env);
    return {
      id: p.id,
      name: p.name,
      tier: p.tier,
      model: p.model || null,
      hasKey: Boolean(p.apiKey),
      needsKey: p.tier === 'free-key' || p.tier === 'paid',
      inChain: chain.includes(p.id),
      signup: p.signup || null
    };
  });
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, raw, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** Local servers: pick the first installed model when none is configured. */
async function detectLocalModel(provider, fetchImpl, timeoutMs) {
  const res = await fetchJson(fetchImpl, `${provider.baseUrl}/models`, { method: 'GET' }, timeoutMs);
  if (!res.ok || !res.json) return null;
  const list = Array.isArray(res.json.data) ? res.json.data : Array.isArray(res.json.models) ? res.json.models : [];
  const first = list.find((m) => m && (m.id || m.name));
  return first ? String(first.id || first.name) : null;
}

function extractReply(json) {
  if (!json) return '';
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) return '';
  const content = choice.message ? choice.message.content : choice.text;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part && part.text) || '').join('');
  }
  return typeof content === 'string' ? content : '';
}

/** Remove "thinking" blocks some open models emit before the answer. */
function cleanReply(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim();
}

/** Recent turns of this session, as chat messages, for follow-up questions. */
function historyFromSession(session, agentId, maxTurns) {
  if (!session || !Array.isArray(session.messages) || maxTurns <= 0) return [];
  const out = [];
  for (const msg of session.messages) {
    if (msg.agentId !== agentId) continue;
    if (msg.role === 'user' && msg.task) out.push({ role: 'user', content: String(msg.task) });
    else if (msg.role === 'agent' && msg.ok !== false && msg.text) out.push({ role: 'assistant', content: String(msg.text) });
  }
  return out.slice(-maxTurns * 2);
}

async function callProvider(provider, messages, opts) {
  const { fetchImpl, timeoutMs, maxTokens, temperature } = opts;
  let model = provider.model;
  if (provider.tier === 'local' && !model) {
    model = await detectLocalModel(provider, fetchImpl, Math.min(timeoutMs, opts.localProbeMs));
    if (!model) return { ok: false, skip: true, error: 'not running or no model installed' };
  }

  const body = { messages, stream: false, max_tokens: maxTokens, temperature };
  if (model) body.model = model;

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.id === 'openrouter') {
    headers['X-Title'] = 'Hey Logan AI';
  }

  const url = `${provider.baseUrl}${provider.chatPath || '/chat/completions'}`;
  const res = await fetchJson(fetchImpl, url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);

  if (!res.ok) {
    const apiError = res.json && res.json.error;
    const detail = (apiError && (apiError.message || apiError)) || truncate(res.raw || '', 160);
    return {
      ok: false,
      status: res.status,
      rateLimited: res.status === 429 || res.status === 402,
      error: `HTTP ${res.status}${detail ? `: ${truncate(String(detail), 160)}` : ''}`
    };
  }

  const reply = cleanReply(extractReply(res.json));
  if (!reply) return { ok: false, error: 'empty reply' };
  return { ok: true, reply, model: (res.json && res.json.model) || model || null };
}

function noProviderText(config) {
  return [
    'No AI provider answered.',
    '',
    'Free options, no paid account needed:',
    '  - Pollinations.AI works with no key, but allows about one request every 30 seconds.',
    '  - Install Ollama (https://ollama.com) and run "ollama pull llama3.2" for a free, private model on this PC.',
    '  - Or paste a free API key from Groq, Google Gemini, OpenRouter, Cerebras or Mistral into',
    '    data/config.json -> ai.providers.<id>.apiKey (or set e.g. GROQ_API_KEY).',
    aiConfig(config).provider && aiConfig(config).provider !== 'auto'
      ? `\nai.provider is forced to "${aiConfig(config).provider}" - set it to "auto" to allow fallbacks.`
      : null
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Run one chat turn.
 * Returns the same result shape as the other agents: { ok, speech, text, meta }.
 */
async function runLlmAgent({ agentId = 'chat', def, config, prompt, session, hooks = {}, fetchImpl, env } = {}) {
  const cfg = aiConfig(config);
  const doFetch = fetchImpl || globalThis.fetch;
  const name = (def && def.name) || 'AI Chat';
  const chain = providerChain(config, env || process.env);

  if (typeof doFetch !== 'function') {
    return { ok: false, speech: `${name} needs Node.js 20 or newer.`, text: 'fetch() is not available in this Node.js version.' };
  }
  if (!chain.length) {
    return { ok: false, speech: `${name} has no AI provider configured.`, text: noProviderText(config) };
  }

  const messages = [
    { role: 'system', content: String(cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT) },
    ...historyFromSession(session, agentId, Number.isFinite(cfg.historyTurns) ? cfg.historyTurns : 4),
    { role: 'user', content: String(prompt || '') }
  ];

  const opts = {
    fetchImpl: doFetch,
    timeoutMs: Number(cfg.timeoutMs) || 60000,
    localProbeMs: Number(cfg.localProbeMs) || 1500,
    maxTokens: Number(cfg.maxTokens) || 600,
    temperature: Number.isFinite(cfg.temperature) ? cfg.temperature : 0.6
  };

  const attempts = [];
  const startedAt = Date.now();
  for (const provider of chain) {
    let outcome;
    try {
      outcome = await callProvider(provider, messages, opts);
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      outcome = {
        ok: false,
        skip: provider.tier === 'local',
        error: aborted ? 'timed out' : (err && err.cause && err.cause.code) || (err && err.message) || 'request failed'
      };
    }
    attempts.push({ provider: provider.id, ok: outcome.ok, error: outcome.error || null });

    if (outcome.ok) {
      hooks.onChunk?.(`${outcome.reply}\n`, 'stdout');
      return {
        ok: true,
        speech: firstSentences(outcome.reply, 3, 420) || `${name} finished.`,
        text: outcome.reply,
        meta: { provider: provider.id, providerName: provider.name, model: outcome.model, attempts, durationMs: Date.now() - startedAt }
      };
    }
    if (!outcome.skip) {
      hooks.onChunk?.(`[${provider.name}] ${outcome.error}${outcome.rateLimited ? ' - trying the next provider' : ''}\n`, 'stderr');
    }
  }

  const onlyRateLimited = attempts.length > 0 && attempts.every((a) => /HTTP 4(29|02)/.test(a.error || '') || /not running/.test(a.error || ''));
  const speech = onlyRateLimited
    ? 'The free AI service is busy right now. Wait half a minute and ask again.'
    : `${name} couldn't reach any AI provider. Check the internet connection, or set up a free key in the settings file.`;
  const tried = attempts.map((a) => `  - ${a.provider}: ${a.error}`).join('\n');
  return {
    ok: false,
    speech,
    text: `${noProviderText(config)}\n\nTried:\n${tried}`,
    meta: { attempts, durationMs: Date.now() - startedAt }
  };
}

module.exports = {
  PROVIDERS,
  DEFAULT_SYSTEM_PROMPT,
  providerChain,
  describeProviders,
  resolveProvider,
  runLlmAgent,
  _internals: { extractReply, cleanReply, historyFromSession, isConfigured }
};
