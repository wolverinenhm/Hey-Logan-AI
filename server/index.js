'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const QRCode = require('qrcode');

const { APP_ROOT, loadConfig, writeConfig } = require('./config');
const { EventHub } = require('./events');
const { SessionStore } = require('./sessions');
const { isAuthorized, createRateLimiter, clientIp } = require('./security');
const { parseCommand } = require('./router');
const { describeAgents } = require('./agents/registry');
const { runCliAgent } = require('./agents/cli');
const { handleComputerCommand } = require('./agents/computer');
const { getAgentDef, GENERIC_WAKE } = require('./agents/defs');
const { ensureCertificate } = require('./tls');
const { normalizeText, resolveStatic, truncate, getLanAddresses, randId } = require('./util');

const PKG = require(path.join(APP_ROOT, 'package.json'));
const PUBLIC_DIR = path.join(APP_ROOT, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

const SETTINGS_WHITELIST = {
  'speech.lang': { type: 'string', pattern: /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/ },
  'speech.silenceMs': { type: 'number', min: 600, max: 6000 },
  'speech.wakeWindowMs': { type: 'number', min: 5000, max: 60000 },
  'ui.speakReplies': { type: 'boolean' },
  'ui.defaultAgent': { type: 'agent' }
};

/* ------------------------------------------------------------------ */
/* Small HTTP helpers                                                   */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      // Drain the rest so the 413 response can still be delivered instead of
      // resetting the connection.
      req.resume();
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                          */
/* ------------------------------------------------------------------ */

function buildUrls(state) {
  const httpsPort = state.urls && state.urls.https;
  const httpPort = state.urls && state.urls.http;
  const lan = getLanAddresses().map((entry) => entry.address);
  const out = { local: [], lan: [] };

  if (httpsPort) {
    out.local.push(`https://localhost:${httpsPort}`);
    for (const ip of lan) out.lan.push(`https://${ip}:${httpsPort}`);
  }
  if (httpPort) {
    out.local.push(`http://localhost:${httpPort}`);
    for (const ip of lan) out.lan.push(`http://${ip}:${httpPort}`);
  }
  return out;
}

function tokenized(urls, token) {
  const suffix = `?token=${encodeURIComponent(token)}`;
  return { local: urls.local.map((u) => u + suffix), lan: urls.lan.map((u) => u + suffix) };
}

function preferredPairingUrl(state) {
  const token = state.config.security.token;
  const urls = buildUrls(state);
  const lanHttps = urls.lan.filter((u) => u.startsWith('https://'));
  const localHttps = urls.local.filter((u) => u.startsWith('https://'));
  const lanHttp = urls.lan.filter((u) => u.startsWith('http://'));
  const localHttp = urls.local.filter((u) => u.startsWith('http://'));
  const base = lanHttps[0] || localHttps[0] || lanHttp[0] || localHttp[0] || 'http://localhost:8787';
  return `${base}?token=${encodeURIComponent(token)}`;
}

function publicSessionInfo(state) {
  const urls = buildUrls(state);
  return {
    app: { name: state.config.app.name, version: PKG.version },
    server: {
      httpPort: (state.urls && state.urls.http) || null,
      httpsPort: (state.urls && state.urls.https) || null,
      httpsEnabled: Boolean(state.urls && state.urls.https),
      startedAt: state.startedAt,
      clients: state.hub.size,
      urls
    },
    speech: state.config.speech,
    ui: state.config.ui,
    agents: describeAgents(state.config),
    genericWake: GENERIC_WAKE,
    sessions: state.sessions.size
  };
}

/* ------------------------------------------------------------------ */
/* Request handler                                                      */
/* ------------------------------------------------------------------ */

async function handleRequest(state, req, res) {
  setSecurityHeaders(res);

  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Bad URL' });
  }
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS' });
    res.end();
    return;
  }

  if (pathname === '/healthz') {
    return sendText(res, 200, 'ok');
  }

  if (pathname.startsWith('/api/')) {
    const ip = clientIp(req);
    const rate = state.limiter.check(ip);
    if (!rate.ok) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Too many failed attempts. Wait a few minutes or restart the server.',
        retryAfterMs: rate.retryAfterMs
      });
    }
    if (pathname !== '/api/health') {
      if (!isAuthorized(state.config, req, url)) {
        state.limiter.fail(ip);
        return sendJson(res, 401, {
          ok: false,
          error: 'Unauthorized. Open the pairing link from the server console, or paste the token in Settings.',
          requiresToken: true
        });
      }
      state.limiter.success(ip);
    }
    return handleApi(state, req, res, url);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(state, req, res, pathname);
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function handleApi(state, req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      app: 'Hey AI Bridge',
      version: PKG.version,
      time: new Date().toISOString(),
      requiresToken: true
    });
  }

  if (pathname === '/api/session-info' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...publicSessionInfo(state) });
  }

  if (pathname === '/api/agents' && method === 'GET') {
    return sendJson(res, 200, { ok: true, agents: describeAgents(state.config), genericWake: GENERIC_WAKE });
  }

  if (pathname === '/api/pairing' && method === 'GET') {
    const pairingUrl = preferredPairingUrl(state);
    const urls = tokenized(buildUrls(state), state.config.security.token);
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(pairingUrl, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M' });
    } catch (err) {
      console.warn('[pairing] QR generation failed:', err.message);
    }
    return sendJson(res, 200, { ok: true, token: state.config.security.token, pairingUrl, urls, qrSvg });
  }

  if (pathname === '/api/events' && method === 'GET') {
    const clientId = String(url.searchParams.get('client') || randId('c_', 8)).slice(0, 64);
    state.hub.subscribe(clientId, req, res);
    return undefined;
  }

  if (pathname === '/api/command' && method === 'POST') {
    return handleCommandRequest(state, req, res);
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    return sendJson(res, 200, { ok: true, sessions: state.sessions.list({ limit: 40 }) });
  }

  if (pathname.startsWith('/api/sessions/') && method === 'GET') {
    const id = pathname.slice('/api/sessions/'.length);
    const session = state.sessions.get(id);
    if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
    return sendJson(res, 200, { ok: true, session });
  }

  if (pathname === '/api/settings' && method === 'POST') {
    return handleSettingsRequest(state, req, res);
  }

  if (pathname.startsWith('/api/screenshot/') && method === 'GET') {
    return serveScreenshot(state, res, pathname.slice('/api/screenshot/'.length));
  }

  return sendJson(res, 404, { ok: false, error: 'Unknown API endpoint' });
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

async function handleCommandRequest(state, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' });
  if (text.length > 2000) return sendJson(res, 400, { ok: false, error: 'text is too long (max 2000 chars)' });

  const input = {
    text,
    clientId: typeof body.clientId === 'string' && body.clientId ? body.clientId.slice(0, 64) : 'unknown',
    source: body.source === 'pc' ? 'pc' : 'phone',
    sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId.slice(0, 64) : null,
    agentId: typeof body.agentId === 'string' && body.agentId ? body.agentId.slice(0, 64) : null
  };

  if (body.sync === true) {
    const result = await executeCommand(state, input);
    return sendJson(res, result.ok === false ? 200 : 200, { ...result });
  }

  executeCommand(state, input).catch((err) => {
    console.error('[command] execution failed:', err);
    state.hub.publish({
      type: 'agent:result',
      clientId: input.clientId,
      source: input.source,
      sessionId: null,
      agentId: input.agentId,
      ok: false,
      speech: 'Something went wrong while running that command.',
      text: `Error: ${err.message}`,
      durationMs: 0
    });
  });

  return sendJson(res, 202, { ok: true, accepted: true });
}

async function executeCommand(state, input) {
  const { config } = state;
  const text = String(input.text || '').slice(0, 2000);
  const clientId = input.clientId || 'unknown';
  const source = input.source === 'pc' ? 'pc' : 'phone';
  const startedAt = Date.now();

  const routing = parseCommand(text, {
    defaultAgent: (config.ui && config.ui.defaultAgent) || 'computer'
  });

  if (routing.generic) {
    const speech =
      'Which agent? Say “Hey Computer”, “Hey Claude Code”, “Hey Codex”, “Hey DeepSeek”, “Hey Workbuddy” or “Hey Gemini”.';
    state.hub.publish({
      type: 'agent:result',
      clientId,
      source,
      sessionId: null,
      agentId: null,
      ok: true,
      speech,
      text: speech,
      durationMs: 0,
      generic: true
    });
    return { ok: true, generic: true, speech, text: speech };
  }

  if (routing.needsTask) {
    const def = getAgentDef(routing.agentId);
    const speech = `${def ? def.name : 'I'} here. What would you like me to do?`;
    state.hub.publish({
      type: 'agent:result',
      clientId,
      source,
      sessionId: null,
      agentId: routing.agentId,
      ok: true,
      speech,
      text: speech,
      durationMs: 0,
      needsTask: true
    });
    return { ok: true, speech, text: speech, needsTask: true };
  }

  let agentId = routing.agentId || (config.ui && config.ui.defaultAgent) || 'computer';
  if (input.agentId && getAgentDef(input.agentId) && !routing.matched) agentId = input.agentId;

  const def = getAgentDef(agentId);
  if (!def) {
    const speech = `I don't know an agent called ${agentId}.`;
    state.hub.publish({ type: 'agent:result', clientId, source, sessionId: null, agentId: null, ok: false, speech, text: speech, durationMs: 0 });
    return { ok: false, speech, text: speech };
  }

  let session = null;
  if (input.sessionId && !routing.newSession) session = state.sessions.get(input.sessionId);
  const reusedSession = Boolean(session);
  if (!session) {
    session = state.sessions.create({ agentId, source, title: truncate(routing.task || text, 80) });
  }
  if (routing.matched) session.agentId = agentId;

  const taskText = routing.task || text;

  state.hub.publish({
    type: 'command:routing',
    clientId,
    source,
    sessionId: session.id,
    agentId,
    text,
    routing: {
      matched: routing.matched,
      generic: false,
      newSession: routing.newSession,
      wakePhrase: routing.wakePhrase,
      task: taskText
    },
    reusedSession
  });

  state.sessions.addMessage(session.id, {
    role: 'user',
    text,
    task: taskText,
    agentId,
    source,
    matched: routing.matched,
    at: new Date().toISOString()
  });

  state.hub.publish({
    type: 'agent:status',
    clientId,
    source,
    sessionId: session.id,
    agentId,
    status: 'thinking'
  });

  let result;
  try {
    if (def.kind === 'cli') {
      result = await runCliAgent({
        agentId,
        def,
        config,
        prompt: taskText,
        hooks: {
          onChunk: (chunk, stream) => {
            state.hub.publish({
              type: 'agent:chunk',
              clientId,
              source,
              sessionId: session.id,
              agentId,
              stream,
              chunk: truncate(chunk, 4000)
            });
          }
        }
      });
    } else {
      result = await handleComputerCommand(
        { config, dataDir: state.dataDir, session, agentId, source },
        taskText
      );
    }
  } catch (err) {
    console.error(`[agent:${agentId}] failed:`, err);
    result = {
      ok: false,
      speech: 'Something went wrong on my side while running that.',
      text: `Error: ${err.message}`
    };
  }

  const durationMs = Date.now() - startedAt;

  state.sessions.addMessage(session.id, {
    role: 'agent',
    agentId,
    text: result.text || '',
    speech: result.speech || '',
    ok: result.ok !== false,
    at: new Date().toISOString(),
    durationMs
  });

  const payload = {
    type: 'agent:result',
    clientId,
    source,
    sessionId: session.id,
    agentId,
    ok: result.ok !== false,
    speech: result.speech || '',
    text: result.text || '',
    meta: result.meta || null,
    durationMs,
    exitCode: result.code == null ? null : result.code,
    missing: Boolean(result.missing),
    timedOut: Boolean(result.timedOut),
    screenshot: result.screenshot || null,
    invocation: result.invocation || null
  };
  state.hub.publish(payload);
  return payload;
}

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

async function handleSettingsRequest(state, req, res) {
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
  }

  const applied = {};
  for (const [key, value] of Object.entries(body || {})) {
    const rule = SETTINGS_WHITELIST[key];
    if (!rule) continue;

    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') return sendJson(res, 400, { ok: false, error: `${key} must be a boolean` });
      setPath(state.config, key, value);
      applied[key] = value;
      continue;
    }
    if (rule.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
        return sendJson(res, 400, { ok: false, error: `${key} must be a number between ${rule.min} and ${rule.max}` });
      }
      setPath(state.config, key, Math.round(n));
      applied[key] = Math.round(n);
      continue;
    }
    if (rule.type === 'agent') {
      if (typeof value !== 'string' || !getAgentDef(value)) {
        return sendJson(res, 400, { ok: false, error: `${key} must be an agent id` });
      }
      setPath(state.config, key, value);
      applied[key] = value;
      continue;
    }
    if (typeof value !== 'string' || !rule.pattern.test(value)) {
      return sendJson(res, 400, { ok: false, error: `${key} has an invalid value` });
    }
    setPath(state.config, key, value);
    applied[key] = value;
  }

  writeConfig(state.configPath, state.config);
  return sendJson(res, 200, { ok: true, applied, speech: state.config.speech, ui: state.config.ui });
}

function setPath(target, key, value) {
  const parts = key.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

/* ------------------------------------------------------------------ */
/* Static files + screenshots                                           */
/* ------------------------------------------------------------------ */

function serveStatic(state, req, res, pathname) {
  let filePath = resolveStatic(PUBLIC_DIR, pathname);
  if (!filePath) return sendJson(res, 404, { ok: false, error: 'Not found' });

  try {
    let stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.statSync(filePath);
    }
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'Not found' });

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Service-Worker-Allowed': '/'
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return;
  } catch {
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }
}

function serveScreenshot(state, res, rawName) {
  let name;
  try {
    name = decodeURIComponent(String(rawName || ''));
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid screenshot name' });
  }
  if (!/^shot-[0-9]+\.png$/.test(name)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid screenshot name' });
  }
  const shotDir = path.resolve(state.dataDir, state.config.computer?.screenshotDir || 'screenshots');
  const filePath = path.join(shotDir, name);
  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { ok: false, error: 'Screenshot not found' });
  }
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                        */
/* ------------------------------------------------------------------ */

function createApp(options = {}) {
  const loaded = loadConfig(options);

  const state = {
    config: loaded.config,
    dataDir: loaded.dataDir,
    configPath: loaded.configPath,
    hub: new EventHub(),
    sessions: new SessionStore({ max: 200 }),
    limiter: createRateLimiter(loaded.config.security.rateLimit),
    startedAt: Date.now(),
    urls: {},
    handler: null,
    httpServer: null,
    httpsServer: null,
    certPath: null
  };

  state.handler = (req, res) => {
    handleRequest(state, req, res).catch((err) => {
      console.error('[http] Unhandled error:', err);
      try {
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
      } catch {
        /* response already gone */
      }
    });
  };

  state.httpServer = http.createServer(state.handler);

  if (state.config.server.enableHttps) {
    try {
      const tls = ensureCertificate(state.dataDir);
      state.certPath = tls.certPath;
      state.httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, state.handler);
    } catch (err) {
      console.warn(`[tls] Could not create HTTPS server (${err.message}); continuing with HTTP only.`);
      state.httpsServer = null;
    }
  }

  return state;
}

function listen(state) {
  return new Promise((resolve, reject) => {
    const { config } = state;
    const host = config.server.host || '0.0.0.0';
    const tasks = [];

    if (config.server.enableHttp !== false) {
      tasks.push(
        new Promise((res, rej) => {
          state.httpServer.once('error', rej);
          state.httpServer.listen(config.server.httpPort, host, () => {
            state.urls.http = state.httpServer.address().port;
            res();
          });
        })
      );
    }

    if (state.httpsServer) {
      tasks.push(
        new Promise((res, rej) => {
          state.httpsServer.once('error', rej);
          state.httpsServer.listen(config.server.httpsPort, host, () => {
            state.urls.https = state.httpsServer.address().port;
            res();
          });
        })
      );
    }

    if (!tasks.length) return resolve(state);
    Promise.all(tasks).then(() => resolve(state)).catch(reject);
  });
}

function close(state) {
  state.hub.close();
  return new Promise((resolve) => {
    const servers = [state.httpServer, state.httpsServer].filter(Boolean);
    if (!servers.length) return resolve();
    let remaining = servers.length;
    const done = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
    };
    for (const server of servers) {
      try {
        server.close(() => done());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        done();
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Console banner                                                       */
/* ------------------------------------------------------------------ */

function printBanner(state) {
  const { config } = state;
  const urls = buildUrls(state);
  const token = config.security.token;
  const lanHttps = urls.lan.filter((u) => u.startsWith('https://'));
  const preferred = preferredPairingUrl(state);

  const agents = describeAgents(config);
  const agentLines = agents.map((agent) => {
    const status = agent.enabled ? 'ready' : 'not found';
    const hint = !agent.enabled && agent.install ? `  ->  ${agent.install}` : '';
    return `  ${agent.enabled ? '[ok]' : '[--]'} ${agent.name.padEnd(18)} ${status}${hint}`;
  });

  const lines = [
    '',
    '  ╔══════════════════════════════════════════════════════════════╗',
    '  ║                    H E Y   A I   B R I D G E                 ║',
    '  ╚══════════════════════════════════════════════════════════════╝',
    `  ${config.app.name} v${PKG.version}`,
    '',
    '  Desktop (this PC):',
    ...(urls.local.length ? urls.local.map((u) => `    ${u}`) : ['    (no listeners)']),
    '',
    '  Phone (same Wi-Fi):',
    ...(lanHttps.length ? lanHttps.map((u) => `    ${u}`) : ['    (no LAN HTTPS address found)']),
    '',
    `  Access token:  ${token}`,
    `  Pairing link:  ${preferred}`,
    '',
    '  Agents:',
    ...agentLines,
    '',
    `  Config:        ${state.configPath}`,
    `  Data folder:   ${state.dataDir}`,
    ''
  ];
  console.log(lines.join('\n'));

  fs.writeFileSync(
    path.join(state.dataDir, 'pairing.txt'),
    [
      `${config.app.name} v${PKG.version}`,
      `Token: ${token}`,
      `Pairing link: ${preferred}`,
      '',
      'Desktop URLs:',
      ...urls.local.map((u) => `  ${u}`),
      '',
      'Phone URLs (same Wi-Fi):',
      ...urls.lan.map((u) => `  ${u}?token=${token}`),
      ''
    ].join('\n'),
    'utf8'
  );

  QRCode.toString(preferred, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
    .then((art) => {
      console.log('  Scan to open on your phone:\n');
      console.log(art);
    })
    .catch(() => {});
}

async function main() {
  const state = createApp({});
  await listen(state);
  printBanner(state);

  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received, shutting down...`);
    try {
      await close(state);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  listen,
  close,
  executeCommand,
  buildUrls,
  preferredPairingUrl,
  __internals: { buildUrls, publicSessionInfo, tokenized }
};
