'use strict';

const fs = require('fs');
const path = require('path');
const { randomToken, deepMerge } = require('./util');

const APP_ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(APP_ROOT, 'package.json'));

const PLACEHOLDER_TOKENS = new Set([
  'GENERATED-ON-FIRST-RUN',
  'CHANGEME',
  'CHANGE-ME',
  'XXXX-XXXX-XXXX',
  'YOUR-TOKEN-HERE',
  'TOKEN'
]);

function isPlaceholderToken(value) {
  const token = String(value == null ? '' : value).trim();
  if (!token) return true;
  if (token.length < 6) return true;
  return PLACEHOLDER_TOKENS.has(token.toUpperCase());
}

function toPort(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function defaultConfig() {
  return {
    app: {
      name: 'Hey AI Bridge',
      version: PKG.version
    },
    server: {
      host: '0.0.0.0',
      httpPort: 8787,
      httpsPort: 8443,
      enableHttp: true,
      enableHttps: true
    },
    security: {
      token: randomToken(),
      rateLimit: { windowMs: 300000, max: 12, banMs: 600000 }
    },
    speech: {
      lang: 'en-US',
      wakeWindowMs: 12000,
      silenceMs: 1500
    },
    ui: {
      defaultAgent: 'computer',
      speakReplies: true
    },
    agents: {
      computer: { enabled: true },
      'claude-code': { enabled: 'auto', command: 'claude', args: ['-p', '{prompt}'], timeoutMs: 300000, cwd: '' },
      codex: { enabled: 'auto', command: 'codex', args: ['exec', '{prompt}'], timeoutMs: 300000, cwd: '' },
      deepseek: { enabled: 'auto', command: 'dsh', args: ['headless', '{prompt}'], timeoutMs: 900000, cwd: '' },
      workbuddy: { enabled: 'auto', command: 'workbuddy', args: ['--prompt', '{prompt}'], timeoutMs: 300000, cwd: '' },
      gemini: { enabled: 'auto', command: 'gemini', args: ['-p', '{prompt}'], timeoutMs: 300000, cwd: '' }
    },
    computer: {
      searchRoots: ['downloads', 'documents', 'desktop'],
      folderMap: {},
      maxDepth: 7,
      maxFiles: 25000,
      maxResults: 8,
      searchTimeoutMs: 8000,
      allowAbsolutePaths: false,
      screenshotDir: 'screenshots'
    }
  };
}

/**
 * Load (or create) the JSON config in the data directory.
 *
 * options:
 *   dataDir   - directory for config.json, certs, screenshots (default ./data)
 *   configPath- explicit config file path
 *   token     - force a specific access token (useful for tests)
 *   overrides - deep-merged on top of the user config (useful for tests)
 */
function loadConfig(options = {}) {
  const dataDir = path.resolve(
    options.dataDir || process.env.HEY_AI_DATA_DIR || path.join(APP_ROOT, 'data')
  );
  fs.mkdirSync(dataDir, { recursive: true });

  const configPath = options.configPath ? path.resolve(options.configPath) : path.join(dataDir, 'config.json');

  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.warn(`[config] Could not parse ${configPath} (${err.message}). Using defaults for missing values.`);
      userConfig = {};
    }
  }

  let config = deepMerge(defaultConfig(), userConfig);

  if (options.overrides) config = deepMerge(config, options.overrides);

  if (process.env.HEY_AI_TOKEN) config.security.token = process.env.HEY_AI_TOKEN;
  if (process.env.HEY_AI_HTTP_PORT) config.server.httpPort = toPort(process.env.HEY_AI_HTTP_PORT, config.server.httpPort);
  if (process.env.HEY_AI_HTTPS_PORT) config.server.httpsPort = toPort(process.env.HEY_AI_HTTPS_PORT, config.server.httpsPort);
  if (process.env.HEY_AI_HOST) config.server.host = process.env.HEY_AI_HOST;
  if (process.env.HEY_AI_NO_HTTPS === '1') config.server.enableHttps = false;

  if (options.token) config.security.token = options.token;

  // A copied config.example.json (or a hand-written config) must never leave
  // the bridge using a publicly known placeholder as its access token.
  if (isPlaceholderToken(config.security.token)) {
    config.security.token = randomToken();
  }

  config.server.httpPort = toPort(config.server.httpPort, 8787);
  config.server.httpsPort = toPort(config.server.httpsPort, 8443);
  config.app.version = PKG.version;

  writeConfig(configPath, config);

  return { config, configPath, dataDir };
}

function writeConfig(configPath, config) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[config] Could not save ${configPath}: ${err.message}`);
  }
}

module.exports = { APP_ROOT, defaultConfig, loadConfig, writeConfig, toPort };
