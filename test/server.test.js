'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp, listen, close } = require('../server/index');

const TOKEN = 'TEST-TOKEN-0001';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer() {
  const dataDir = tmp('heyai-srv-');
  const downloads = path.join(dataDir, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, 'budget-2026.docx'), Buffer.alloc(1500));
  fs.writeFileSync(path.join(downloads, 'notes.txt'), 'hello');

  const app = createApp({
    dataDir,
    token: TOKEN,
    overrides: {
      server: { enableHttps: false, httpPort: 0, host: '127.0.0.1' },
      computer: {
        folderMap: { downloads },
        searchRoots: ['downloads'],
        maxDepth: 4,
        maxFiles: 2000,
        searchTimeoutMs: 3000,
        maxResults: 8
      }
    }
  });
  await listen(app);
  const port = app.httpServer.address().port;
  return { app, base: `http://127.0.0.1:${port}` };
}

function authHeaders(token = TOKEN) {
  return { 'X-Bridge-Token': token };
}

function waitFor(predicate, timeoutMs = 6000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      return setTimeout(tick, intervalMs);
    };
    tick();
  });
}

let server;

test.before(async () => {
  server = await startServer();
});

test.after(async () => {
  if (server) await close(server.app);
});

test('health endpoint is public', async () => {
  const res = await fetch(`${server.base}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.requiresToken, true);
  assert.equal(data.app, 'Hey AI Bridge');
});

test('protected endpoints reject missing or wrong tokens', async () => {
  const missing = await fetch(`${server.base}/api/session-info`);
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${server.base}/api/session-info`, { headers: { 'X-Bridge-Token': 'WRONG' } });
  assert.equal(wrong.status, 401);
});

test('session-info lists all six agents and server urls', async () => {
  const res = await fetch(`${server.base}/api/session-info`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.agents.length, 6);

  const ids = data.agents.map((agent) => agent.id);
  for (const id of ['computer', 'claude-code', 'codex', 'deepseek', 'workbuddy', 'gemini']) {
    assert.ok(ids.includes(id), `missing agent ${id}`);
  }

  const computer = data.agents.find((agent) => agent.id === 'computer');
  assert.equal(computer.enabled, true);
  assert.equal(computer.kind, 'computer');
  assert.ok(Array.isArray(computer.wake) && computer.wake.length > 0);

  assert.ok(data.server.urls.local.some((url) => url.startsWith('http://')));
  assert.ok(Array.isArray(data.genericWake));
});

test('serves the PWA shell and blocks path traversal', async () => {
  const index = await fetch(`${server.base}/`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.ok(html.includes('Hey AI'));
  assert.ok(html.includes('/app.js'));
  assert.ok(html.includes('/voice.js'));

  const traversal = await fetch(`${server.base}/..%2f..%2fserver%2findex.js`);
  assert.equal(traversal.status, 404);

  const manifest = await fetch(`${server.base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type') || '', /manifest/);
});

test('pairing endpoint returns a QR code and tokenized URLs', async () => {
  const res = await fetch(`${server.base}/api/pairing`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.token, TOKEN);
  assert.ok(data.pairingUrl.includes(encodeURIComponent(TOKEN)));
  assert.ok(data.qrSvg.includes('<svg'));
  assert.ok(Array.isArray(data.urls.local) && data.urls.local.length >= 1);
});

test('command executes the Computer agent synchronously', async () => {
  const res = await fetch(`${server.base}/api/command`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'hey computer find the budget word document in downloads',
      sync: true,
      clientId: 'test-client',
      source: 'phone'
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.agentId, 'computer');
  assert.match(data.speech, /Found/i);
  assert.ok(data.text.includes('budget-2026.docx'));
  assert.ok(data.sessionId);
  assert.ok(data.meta);
  assert.equal(data.meta.intent, 'find');
});

test('generic wake asks which agent', async () => {
  const res = await fetch(`${server.base}/api/command`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hey ai what is the weather', sync: true, clientId: 'test-client' })
  });
  const data = await res.json();
  assert.equal(data.generic, true);
  assert.match(data.speech, /Which agent/i);
});

test('text-only wake phrase asks for a task', async () => {
  const res = await fetch(`${server.base}/api/command`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hey gemini', sync: true, clientId: 'test-client' })
  });
  const data = await res.json();
  assert.equal(data.needsTask, true);
  assert.match(data.speech, /What would you like me to do/i);
});

test('missing CLI agents report a helpful install message', async (t) => {
  const info = await (await fetch(`${server.base}/api/session-info`, { headers: authHeaders() })).json();
  const codex = info.agents.find((agent) => agent.id === 'codex');
  if (codex.enabled) {
    t.skip('Codex is installed on this machine');
    return;
  }

  const res = await fetch(`${server.base}/api/command`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hey codex fix the failing test', sync: true, clientId: 'test-client' })
  });
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.missing, true);
  assert.match(data.speech, /couldn't find Codex/i);
  assert.match(data.text, /npm install -g @openai\/codex/);
});

test('settings endpoint validates and persists allowed values', async () => {
  const ok = await fetch(`${server.base}/api/settings`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'ui.speakReplies': false })
  });
  assert.equal(ok.status, 200);
  const okData = await ok.json();
  assert.equal(okData.ok, true);
  assert.equal(okData.ui.speakReplies, false);

  const bad = await fetch(`${server.base}/api/settings`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'speech.lang': 'not a lang!' })
  });
  assert.equal(bad.status, 400);

  const unknown = await fetch(`${server.base}/api/settings`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'server.host': '0.0.0.0' })
  });
  assert.equal(unknown.status, 200);
  const unknownData = await unknown.json();
  assert.deepEqual(unknownData.applied, {});
});

test('sessions are listed and readable after a command', async () => {
  const list = await fetch(`${server.base}/api/sessions`, { headers: authHeaders() });
  assert.equal(list.status, 200);
  const listData = await list.json();
  assert.ok(listData.sessions.length >= 1);
  const id = listData.sessions[0].id;

  const detail = await fetch(`${server.base}/api/sessions/${encodeURIComponent(id)}`, { headers: authHeaders() });
  assert.equal(detail.status, 200);
  const detailData = await detail.json();
  assert.equal(detailData.session.id, id);
  assert.ok(detailData.session.messages.length >= 2);
});

test('SSE delivers routing and result events for async commands', async () => {
  const controller = new AbortController();
  const url = `${server.base}/api/events?client=test-sse&token=${encodeURIComponent(TOKEN)}`;
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readLoop = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await waitFor(() => events.some((event) => event.type === 'hello'), 4000);

  const post = await fetch(`${server.base}/api/command`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'hey computer list my downloads folder',
      sync: false,
      clientId: 'test-sse',
      source: 'phone'
    })
  });
  assert.equal(post.status, 202);

  await waitFor(() => events.some((event) => event.type === 'agent:result'), 10000);

  controller.abort();
  await readLoop;

  const routing = events.find((event) => event.type === 'command:routing');
  const result = events.find((event) => event.type === 'agent:result');
  assert.ok(routing, 'expected a command:routing event');
  assert.equal(routing.agentId, 'computer');
  assert.ok(result, 'expected an agent:result event');
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, routing.sessionId);
  assert.ok(result.text.includes('budget-2026.docx'));
});
