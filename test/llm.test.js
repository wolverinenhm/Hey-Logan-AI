'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { providerChain, describeProviders, runLlmAgent, _internals } = require('../server/agents/llm');
const { looksLikeComputerTask } = require('../server/agents/computer');
const { parseCommand } = require('../server/router');

const NO_ENV = {};

function okResponse(json, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    text: async () => JSON.stringify(json)
  };
}

function reply(content, model = 'test-model') {
  return { model, choices: [{ message: { role: 'assistant', content } }] };
}

test('default chain needs no key: local servers first, Pollinations last', () => {
  const ids = providerChain({}, NO_ENV).map((p) => p.id);
  assert.deepEqual(ids, ['ollama', 'lmstudio', 'pollinations']);
});

test('providers with a key join the chain before the keyless fallback', () => {
  const ids = providerChain({ ai: { providers: { groq: { apiKey: 'gsk_test' } } } }, { OPENAI_API_KEY: 'sk-test' }).map((p) => p.id);
  assert.deepEqual(ids, ['ollama', 'lmstudio', 'groq', 'openai', 'pollinations']);
});

test('ai.provider forces one provider; ai.order and enabled:false are honoured', () => {
  assert.deepEqual(providerChain({ ai: { provider: 'pollinations' } }, NO_ENV).map((p) => p.id), ['pollinations']);
  assert.deepEqual(providerChain({ ai: { provider: 'groq' } }, NO_ENV), [], 'forced keyed provider without key is unusable');
  assert.deepEqual(
    providerChain({ ai: { order: ['pollinations', 'ollama'] } }, NO_ENV).map((p) => p.id),
    ['pollinations', 'ollama']
  );
  assert.deepEqual(
    providerChain({ ai: { providers: { ollama: { enabled: false }, lmstudio: { enabled: false } } } }, NO_ENV).map((p) => p.id),
    ['pollinations']
  );
});

test('describeProviders never exposes API keys', () => {
  const list = describeProviders({ ai: { providers: { groq: { apiKey: 'gsk_secret_value' } } } }, NO_ENV);
  const json = JSON.stringify(list);
  assert.ok(!json.includes('gsk_secret_value'));
  const groq = list.find((p) => p.id === 'groq');
  assert.equal(groq.hasKey, true);
  assert.equal(groq.inChain, true);
});

test('falls through unreachable local servers and rate-limited providers', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('http://127.0.0.1')) {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    if (url.includes('groq')) return okResponse({ error: { message: 'Rate limit reached' } }, 429);
    return okResponse(reply('Paris is the capital of France.'));
  };
  const result = await runLlmAgent({
    config: { ai: { providers: { groq: { apiKey: 'gsk_test' } } } },
    prompt: 'What is the capital of France?',
    fetchImpl,
    env: NO_ENV
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.provider, 'pollinations');
  assert.match(result.speech, /Paris/);
  const groqCall = calls.find((c) => c.url.includes('groq'));
  assert.equal(groqCall.options.headers.Authorization, 'Bearer gsk_test');
  const pollCall = calls.find((c) => c.url.includes('pollinations'));
  assert.equal(pollCall.url, 'https://text.pollinations.ai/openai');
  assert.equal(pollCall.options.headers.Authorization, undefined, 'keyless provider sends no auth header');
  const body = JSON.parse(pollCall.options.body);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[body.messages.length - 1].content, 'What is the capital of France?');
});

test('local server model is auto-detected', async () => {
  const fetchImpl = async (url, options) => {
    if (url === 'http://127.0.0.1:11434/v1/models') return okResponse({ data: [{ id: 'llama3.2:latest' }] });
    if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
      assert.equal(JSON.parse(options.body).model, 'llama3.2:latest');
      return okResponse(reply('<think>hmm</think>Hello from Ollama.'));
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await runLlmAgent({ config: {}, prompt: 'hi', fetchImpl, env: NO_ENV });
  assert.equal(result.ok, true);
  assert.equal(result.meta.provider, 'ollama');
  assert.equal(result.text, 'Hello from Ollama.');
});

test('all providers failing gives a helpful answer', async () => {
  const fetchImpl = async () => okResponse({ error: 'busy' }, 402);
  const result = await runLlmAgent({
    config: { ai: { providers: { ollama: { enabled: false }, lmstudio: { enabled: false } } } },
    prompt: 'hi',
    fetchImpl,
    env: NO_ENV
  });
  assert.equal(result.ok, false);
  assert.match(result.speech, /busy/i);
  assert.match(result.text, /Ollama/);
});

test('session history is passed for follow-up questions', () => {
  const session = {
    messages: [
      { role: 'user', agentId: 'chat', task: 'Who wrote Hamlet?' },
      { role: 'agent', agentId: 'chat', ok: true, text: 'William Shakespeare.' },
      { role: 'user', agentId: 'computer', task: 'find budget' }
    ]
  };
  assert.deepEqual(_internals.historyFromSession(session, 'chat', 4), [
    { role: 'user', content: 'Who wrote Hamlet?' },
    { role: 'assistant', content: 'William Shakespeare.' }
  ]);
});

test('smart routing tells PC commands from general questions', () => {
  for (const pc of [
    'find the budget word document in downloads',
    'open notepad',
    'lock the screen',
    'what time is it',
    'where is my tax return pdf',
    'how is my pc doing',
    'budget report'
  ]) {
    assert.equal(looksLikeComputerTask(pc), true, pc);
  }
  for (const q of ['what is the capital of France', 'write a haiku about rain', 'explain black holes', 'who won the 2022 world cup?']) {
    assert.equal(looksLikeComputerTask(q), false, q);
  }
});

test('"hey chat" and "hey gpt" route to the chat agent', () => {
  assert.equal(parseCommand('hey chat what is two plus two').agentId, 'chat');
  assert.equal(parseCommand('hey gpt tell me a joke').agentId, 'chat');
  assert.equal(parseCommand('hey ai chat explain gravity').agentId, 'chat');
});

/* End-to-end through the HTTP server, with a fake OpenAI-compatible API. */

test('server routes "Hey Logan, <question>" to the chat agent', async (t) => {
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const question = body.messages[body.messages.length - 1].content;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply(`You asked: ${question}`, 'fake-1')));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => fake.close());

  const { createApp, listen, close } = require('../server/index');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heyai-llm-'));
  const app = createApp({
    dataDir,
    token: 'TEST-TOKEN-LLM1',
    overrides: {
      server: { enableHttps: false, httpPort: 0, host: '127.0.0.1' },
      ai: {
        provider: 'custom',
        providers: { custom: { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: 'local-test', model: 'fake-1' } }
      }
    }
  });
  await listen(app);
  t.after(() => close(app));
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'X-Bridge-Token': 'TEST-TOKEN-LLM1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hey logan what is the capital of France', sync: true, clientId: 'c1' })
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.agentId, 'chat');
  assert.match(data.text, /You asked: what is the capital of France/);
  assert.equal(data.meta.provider, 'custom');

  const info = await (await fetch(`${base}/api/session-info`, { headers: { 'X-Bridge-Token': 'TEST-TOKEN-LLM1' } })).json();
  assert.ok(!JSON.stringify(info).includes('local-test'), 'API key must not reach the browser');
});
