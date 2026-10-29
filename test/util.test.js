'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const util = require('../server/util');

test('normalizeText lowercases, strips punctuation and collapses spaces', () => {
  assert.equal(util.normalizeText('  Hey,  CLAUDE-Code!!  '), 'hey claude code');
  assert.equal(util.normalizeText("What's the time?"), "what's the time");
  assert.equal(util.normalizeText('Café   déjà-vu'), 'cafe deja vu');
  assert.equal(util.normalizeText(null), '');
  assert.equal(util.normalizeText(undefined), '');
});

test('hasPhrase respects word boundaries', () => {
  assert.equal(util.hasPhrase('hey claude code open it', 'hey claude code'), true);
  assert.equal(util.hasPhrase('they claude codex', 'hey claude code'), false);
  assert.equal(util.hasPhrase('hey codex please', 'codex'), true);
  assert.equal(util.hasPhrase('hey coders', 'codex'), false);
});

test('findExecutable finds node and reports missing tools', () => {
  const node = util.findExecutable('node');
  assert.ok(node, 'node executable should be found on PATH');
  assert.ok(/node(\.exe)?$/i.test(node));
  assert.equal(util.findExecutable('definitely-not-installed-xyz'), null);
  assert.equal(util.findExecutable(''), null);
  assert.equal(util.findExecutable(null), null);
});

test('resolveStatic serves index.html and blocks traversal', () => {
  const publicDir = path.resolve(__dirname, '..', 'public');
  assert.ok(util.resolveStatic(publicDir, '/').endsWith(path.join('public', 'index.html')));
  assert.ok(util.resolveStatic(publicDir, '/app.js').endsWith(path.join('public', 'app.js')));
  assert.equal(util.resolveStatic(publicDir, '/../server/index.js'), null);
  assert.equal(util.resolveStatic(publicDir, '/%2e%2e/server/index.js'), null);
  assert.equal(util.resolveStatic(publicDir, '/..%5cserver%5cindex.js'), null);
});

test('humanBytes and formatDuration are readable', () => {
  assert.equal(util.humanBytes(0), '0 B');
  assert.equal(util.humanBytes(1024), '1 KB');
  assert.equal(util.humanBytes(1500), '1.5 KB');
  assert.equal(util.formatDuration(2500), '2.5 s');
  assert.equal(util.formatDuration(125000), '2m 5s');
});

test('stripMarkdown and firstSentences produce speech-friendly text', () => {
  const markdown = '# Title\n\n**Bold** and `code` and [link](https://example.com).\n\n- one\n- two';
  const clean = util.stripMarkdown(markdown);
  assert.ok(clean.includes('Bold'));
  assert.ok(!clean.includes('**'));
  assert.ok(!clean.includes('https://'));
  assert.ok(!clean.includes('#'));

  const summary = util.firstSentences('First sentence. Second sentence! Third?', 2, 400);
  assert.equal(summary, 'First sentence. Second sentence!');

  const long = util.firstSentences('x'.repeat(600), 2, 100);
  assert.ok(long.length <= 100);
});

test('randomToken looks like a pairing token and is unique', () => {
  const token = util.randomToken();
  assert.match(token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notEqual(token, util.randomToken());
});

test('deepMerge merges nested objects but replaces arrays', () => {
  const merged = util.deepMerge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { x: 1, y: 3 }, list: [9] });
});

test('getLanAddresses returns only IPv4 non-loopback addresses', () => {
  for (const entry of util.getLanAddresses()) {
    assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!entry.address.startsWith('127.'));
  }
});

test('lineSplitter emits complete lines and flushes the remainder', () => {
  const lines = [];
  const splitter = util.lineSplitter((line) => lines.push(line));
  splitter.push('hello\nwor');
  splitter.push('ld\r\nbye');
  splitter.flush();
  assert.deepEqual(lines, ['hello', 'world', 'bye']);
});
