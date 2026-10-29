'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleComputerCommand, _internals } = require('../server/agents/computer');

const { parseIntent, searchFiles, findKnownApp, resolveFolder } = _internals;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heyai-docs-'));
  fs.writeFileSync(path.join(root, 'budget-2026.docx'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'holiday.png'), Buffer.alloc(100));

  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'report budget draft.docx'), Buffer.alloc(512));

  const skipped = path.join(root, 'node_modules');
  fs.mkdirSync(skipped);
  fs.writeFileSync(path.join(skipped, 'budget-secret.docx'), Buffer.alloc(10));

  fs.writeFileSync(path.join(root, 'help-document.txt'), 'help me');
  fs.writeFileSync(path.join(root, 'unrelated-file.txt'), 'nothing to see');

  return root;
}

const fixture = makeFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heyai-data-'));
const config = {
  computer: {
    folderMap: { downloads: fixture },
    searchRoots: ['downloads', 'documents'],
    maxDepth: 5,
    maxFiles: 5000,
    maxResults: 8,
    searchTimeoutMs: 4000,
    allowAbsolutePaths: false,
    screenshotDir: 'screenshots'
  }
};

function context(session = { context: {} }) {
  return { config, dataDir, session, agentId: 'computer' };
}

test('parseIntent understands the example command', () => {
  const intent = parseIntent('start looking for me xxx word document at Downloads folder');
  assert.equal(intent.intent, 'find');
  assert.equal(intent.folderKey, 'downloads');
  assert.equal(intent.query, 'xxx');
  assert.deepEqual(intent.typeExts, ['.docx', '.doc', '.rtf', '.odt']);
});

test('parseIntent detects type-only searches, lock, launch and screenshot', () => {
  const pdf = parseIntent('find the PDF files');
  assert.equal(pdf.intent, 'find');
  assert.equal(pdf.query, '');
  assert.ok(pdf.typeExts.includes('.pdf'));

  assert.equal(parseIntent('lock the screen').intent, 'lock');
  assert.equal(parseIntent('take a screenshot').intent, 'screenshot');
  assert.equal(parseIntent('open notepad').intent, 'launch');
  assert.equal(parseIntent('open calculator').intent, 'launch');
  assert.equal(parseIntent('open downloads').intent, 'open');
  assert.equal(parseIntent('list my downloads folder').intent, 'list');
  assert.equal(parseIntent('what time is it').intent, 'time');
  assert.equal(parseIntent('how is my pc doing').intent, 'stats');
});

test('parseIntent extracts quoted-style names and open-after', () => {
  const intent = parseIntent('find the document called budget report in downloads and open it');
  assert.equal(intent.query, 'budget report');
  assert.equal(intent.openAfter, true);
  assert.equal(intent.folderKey, 'downloads');
});

test('searchFiles finds matches, skips node_modules and filters by type', async () => {
  const result = await searchFiles({
    roots: [fixture],
    query: 'budget',
    exts: ['.docx'],
    maxDepth: 5,
    maxFiles: 1000,
    timeoutMs: 3000,
    maxResults: 8
  });
  const names = result.results.map((item) => item.name).sort();
  assert.deepEqual(names, ['budget-2026.docx', 'report budget draft.docx']);
  assert.ok(result.scanned >= 3);

  const noMatch = await searchFiles({ roots: [fixture], query: 'zzz-nothing', maxDepth: 3, timeoutMs: 2000 });
  assert.equal(noMatch.results.length, 0);
});

test('resolveFolder honours folderMap overrides', () => {
  assert.equal(resolveFolder(config, 'downloads'), fixture);
  assert.ok(resolveFolder(config, 'desktop').toLowerCase().endsWith('desktop'));
});

test('findKnownApp maps common applications', () => {
  assert.equal(findKnownApp('notepad'), 'notepad.exe');
  assert.equal(findKnownApp('chrome'), 'chrome.exe');
  assert.equal(findKnownApp('calculator'), 'calc.exe');
  assert.equal(findKnownApp('totally nonexistent app'), null);
});

test('find command returns ranked results and a spoken summary', async () => {
  const session = { context: {} };
  const result = await handleComputerCommand(context(session), 'find the budget word document in downloads');
  assert.equal(result.ok, true);
  assert.match(result.speech, /Found/i);
  assert.ok(result.text.includes('budget-2026.docx'));
  assert.equal(session.context.lastSearch.results.length, 2);
  assert.ok(result.meta);
  assert.equal(result.meta.intent, 'find');
});

test('list command lists folder contents', async () => {
  const result = await handleComputerCommand(context(), 'list my downloads folder');
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('budget-2026.docx'));
  assert.ok(result.text.includes('notes.txt'));
});

test('find with no match explains where it searched', async () => {
  const result = await handleComputerCommand(context(), 'find the quarterly tax return pdf in downloads');
  assert.match(result.speech, /couldn't find/i);
  assert.match(result.text, /No matches/i);
});

test('help lists capabilities', async () => {
  const result = await handleComputerCommand(context(), 'help');
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('find my tax return PDF in Downloads'));
});

test('a query of generic words still searches by name (regression)', async () => {
  const result = await handleComputerCommand(context(), 'find the help document in downloads');
  assert.equal(result.ok, true);
  assert.equal(result.meta.query, 'help');
  assert.match(result.text, /help-document\.txt/);
});

test('find without a file name lists the folder instead of the newest file (regression)', async () => {
  const result = await handleComputerCommand(context(), 'find everything in downloads');
  assert.equal(result.ok, true);
  assert.match(result.speech, /has \d+ item/);
  assert.ok(result.text.includes('help-document.txt'));
});

test('ambiguous find without context asks for a file name', async () => {
  const result = await handleComputerCommand(context(), 'find it');
  assert.equal(result.ok, true);
  assert.match(result.speech, /What file should I look for/i);
});

test('unknown task falls back to a file search', async () => {
  const result = await handleComputerCommand(context(), 'the budget review notes');
  assert.equal(result.ok, true);
  assert.ok(result.text.toLowerCase().includes('found') || result.text.toLowerCase().includes('no matches'));
});
