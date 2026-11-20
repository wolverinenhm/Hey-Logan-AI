'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Load the browser voice engine in a tiny VM sandbox (no SpeechRecognition or
 * speechSynthesis available, which is fine for the pure parsing helpers).
 */
function loadVoice() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'voice.js'), 'utf8');
  const sandbox = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    URL
  };
  sandbox.window.setTimeout = setTimeout;
  sandbox.window.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.HeyAIVoice;
}

const voice = loadVoice();

const AGENTS = [
  { id: 'computer', name: 'Computer', wake: ['hey computer'], weak: ['computer'] },
  { id: 'claude-code', name: 'Claude Code', wake: ['hey claude code', 'hey claude'], weak: ['claude'] }
];
const GENERIC = ['hey ai'];

test('wake + command in one breath keeps the command as the remainder (regression)', () => {
  const result = voice._test.simulateWake('hey computer find the budget word document in downloads', AGENTS, GENERIC);
  assert.equal(result.agentId, 'computer');
  assert.equal(result.remainder, 'find the budget word document in downloads');
});

test('a bare wake phrase yields no remainder (two-step flow still works)', () => {
  const result = voice._test.simulateWake('hey computer', AGENTS, GENERIC);
  assert.equal(result.agentId, 'computer');
  assert.equal(result.remainder, '');
});

test('punctuated one-breath commands are cleaned up', () => {
  const result = voice._test.simulateWake(
    'Hey Claude Code, please open a new session and find the tax PDF.',
    AGENTS,
    GENERIC
  );
  assert.equal(result.agentId, 'claude-code');
  assert.equal(result.remainder, 'please open a new session and find the tax PDF.');
});

test('generic wake has no agent and no remainder', () => {
  const result = voice._test.simulateWake('hey ai what is the weather', AGENTS, GENERIC);
  assert.equal(result.generic, true);
  assert.equal(result.agentId, null);
  assert.equal(result.remainder, '');
});

test('transcripts without a wake word return null', () => {
  assert.equal(voice._test.simulateWake('find my tax return', AGENTS, GENERIC), null);
});

test('removeWakePhrase removes only the wake words', () => {
  const remainder = voice._test.removeWakePhrase('hey computer please open downloads', 'hey computer');
  assert.equal(remainder.trim(), 'please open downloads');
});

/* ---------------- the assistant's own wake word ("Hey Logan") ---------------- */

const DEFAULT_WAKE = ['hey logan', 'hi logan', 'okay logan'];

test('the assistant wake word matches without an agent', () => {
  const result = voice._test.simulateWake('Hey Logan', AGENTS, GENERIC, DEFAULT_WAKE);
  assert.equal(result.defaultWake, true);
  assert.equal(result.agentId, null);
  assert.equal(result.generic, false);
  assert.equal(result.remainder, '');
});

test('a command spoken after "Hey Logan" becomes the remainder', () => {
  const result = voice._test.simulateWake('hey logan find my budget pdf in downloads', AGENTS, GENERIC, DEFAULT_WAKE);
  assert.equal(result.defaultWake, true);
  assert.equal(result.remainder, 'find my budget pdf in downloads');
});

test('an explicit agent wake still wins over the assistant wake', () => {
  const result = voice._test.simulateWake('hey claude code summarise the repo', AGENTS, GENERIC, DEFAULT_WAKE);
  assert.equal(result.agentId, 'claude-code');
  assert.equal(result.defaultWake, false);
});

test('the assistant wake word does not match without it being configured', () => {
  assert.equal(voice._test.simulateWake('hey logan', AGENTS, GENERIC), null);
});
