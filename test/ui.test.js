'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

test('push-to-talk is not hard-disabled in the HTML', () => {
  const tag = html.match(/<button id="pttBtn"[^>]*>/);
  assert.ok(tag, 'pttBtn must exist');
  assert.ok(!/\bdisabled\b/.test(tag[0]), 'app.js enables it when voice is available');
});

test('index.html has no inline scripts (CSP-safe)', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
});

test('every element id referenced by app.js exists in index.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

  const refs = new Set();
  const block = app.match(/const ids = \[([\s\S]*?)\];/);
  assert.ok(block, 'expected the cacheDom id list in app.js');
  for (const match of block[1].matchAll(/'([^']+)'/g)) refs.add(match[1]);
  for (const match of app.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(match[1]);

  assert.ok(refs.size > 10, 'expected app.js to reference a set of element ids');
  for (const ref of refs) {
    assert.ok(ids.has(ref), `app.js references missing id "${ref}"`);
  }
});

test('manifest icons exist on disk', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    const file = path.join(ROOT, 'public', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `missing icon ${icon.src}`);
  }
});

test('one-breath wake path exists in app.js', () => {
  assert.match(app, /if \(spoken\) \{/);
  assert.match(app, /sendCommand\(spoken/);
});
