'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../server/config');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heyai-cfg-'));
}

test('loadConfig creates defaults, writes config.json and persists a token', () => {
  const dataDir = tmp();
  const first = loadConfig({ dataDir });

  assert.ok(first.config.security.token);
  assert.match(first.config.security.token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(fs.existsSync(first.configPath));

  const written = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
  assert.equal(written.security.token, first.config.security.token);

  const second = loadConfig({ dataDir });
  assert.equal(second.config.security.token, first.config.security.token);
  assert.equal(second.config.server.httpPort, 8787);
  assert.equal(second.config.ui.defaultAgent, 'computer');
});

test('user config overrides defaults without losing other keys', () => {
  const dataDir = tmp();
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      speech: { lang: 'de-DE' },
      agents: { codex: { enabled: true, command: 'my-codex' } }
    })
  );

  const loaded = loadConfig({ dataDir });
  assert.equal(loaded.config.speech.lang, 'de-DE');
  assert.equal(loaded.config.speech.silenceMs, 1500);
  assert.equal(loaded.config.agents.codex.command, 'my-codex');
  assert.equal(loaded.config.agents.codex.args[0], 'exec');
  assert.equal(loaded.config.agents['claude-code'].command, 'claude');
});

test('explicit token option wins over stored config', () => {
  const dataDir = tmp();
  const loaded = loadConfig({ dataDir, token: 'TEST-TOKEN-XYZ!' });
  assert.equal(loaded.config.security.token, 'TEST-TOKEN-XYZ!');
});

test('deep overrides merge into the config', () => {
  const dataDir = tmp();
  const loaded = loadConfig({
    dataDir,
    overrides: { server: { enableHttps: false, httpPort: 0 }, computer: { searchTimeoutMs: 1234 } }
  });
  assert.equal(loaded.config.server.enableHttps, false);
  assert.equal(loaded.config.server.httpPort, 0);
  assert.equal(loaded.config.computer.searchTimeoutMs, 1234);
  assert.equal(loaded.config.computer.maxDepth, 7);
});

test('environment overrides are applied', () => {
  const dataDir = tmp();
  process.env.HEY_AI_TOKEN = 'ENV-TOKEN-1234';
  process.env.HEY_AI_HTTP_PORT = '9999';
  try {
    const loaded = loadConfig({ dataDir });
    assert.equal(loaded.config.security.token, 'ENV-TOKEN-1234');
    assert.equal(loaded.config.server.httpPort, 9999);
  } finally {
    delete process.env.HEY_AI_TOKEN;
    delete process.env.HEY_AI_HTTP_PORT;
  }
});

test('placeholder tokens from copied example configs are replaced', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ security: { token: 'XXXX-XXXX-XXXX' } }));
  const loaded = loadConfig({ dataDir });
  assert.notEqual(loaded.config.security.token, 'XXXX-XXXX-XXXX');
  assert.match(loaded.config.security.token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('too-short tokens are replaced with a real token', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ security: { token: 'abc' } }));
  const loaded = loadConfig({ dataDir });
  assert.match(loaded.config.security.token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('corrupt config files fall back to defaults instead of crashing', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{not valid json');
  const loaded = loadConfig({ dataDir });
  assert.ok(loaded.config.security.token);
  assert.equal(loaded.config.server.httpPort, 8787);
});
