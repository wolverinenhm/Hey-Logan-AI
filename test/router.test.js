'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand } = require('../server/router');

test('the example command routes to Claude Code and strips the new-session wording', () => {
  const result = parseCommand(
    'Hey Claude Code, please open a new session and find the budget word document in Downloads.'
  );
  assert.equal(result.agentId, 'claude-code');
  assert.equal(result.matched, true);
  assert.equal(result.newSession, true);
  assert.equal(result.wakePhrase, 'hey claude code');
  assert.match(result.task, /^find the budget word document in downloads\.?$/i);
});

test('weak agent name at the start is accepted without "hey"', () => {
  const result = parseCommand('Claude, open Downloads please');
  assert.equal(result.agentId, 'claude-code');
  assert.equal(result.matched, true);
  assert.match(result.task, /^open downloads/i);
});

test('a bare mention inside a sentence does not wake an agent', () => {
  const result = parseCommand('find the claude notes in downloads');
  assert.equal(result.matched, false);
  assert.equal(result.agentId, 'computer');
  assert.match(result.task, /^find the claude notes in downloads$/i);
});

test('wake phrase in the middle of a sentence still routes', () => {
  const result = parseCommand('so hey codex could you fix the failing test');
  assert.equal(result.agentId, 'codex');
  assert.equal(result.matched, true);
  assert.equal(result.task, 'fix the failing test');
});

test('the longest matching wake phrase wins', () => {
  const result = parseCommand('hey deepseek harness what should I work on next');
  assert.equal(result.agentId, 'deepseek');
  assert.equal(result.wakePhrase, 'hey deepseek harness');
  assert.equal(result.task, 'what should I work on next');
});

test('generic wake asks which agent', () => {
  const result = parseCommand('hey ai what is the weather');
  assert.equal(result.generic, true);
  assert.equal(result.matched, true);
  assert.equal(result.agentId, null);
  assert.equal(result.task, 'what is the weather');
});

test('no wake word falls through to the default agent', () => {
  const result = parseCommand('find my tax return pdf in documents');
  assert.equal(result.matched, false);
  assert.equal(result.agentId, 'computer');
  assert.equal(result.task, 'find my tax return pdf in documents');
});

test('only a wake phrase produces needsTask', () => {
  const result = parseCommand('hey gemini');
  assert.equal(result.agentId, 'gemini');
  assert.equal(result.newSession, false);
  assert.equal(result.needsTask, true);
  assert.equal(result.task, '');
});

test('computer wake phrase and lock command', () => {
  const result = parseCommand('hey computer lock the screen');
  assert.equal(result.agentId, 'computer');
  assert.equal(result.task, 'lock the screen');
});

test('new session wording is recognized in several forms', () => {
  const startForm = parseCommand('start a new session hey computer list downloads');
  assert.equal(startForm.newSession, true);
  assert.equal(startForm.agentId, 'computer');
  assert.equal(startForm.task, 'list downloads');

  const bareForm = parseCommand('hey workbuddy new session summarize my inbox');
  assert.equal(bareForm.newSession, true);
  assert.equal(bareForm.agentId, 'workbuddy');
  assert.equal(bareForm.task, 'summarize my inbox');
});

test('fillers are stripped from the task', () => {
  const result = parseCommand('hey claude code can you please review my repo');
  assert.equal(result.task, 'review my repo');
});

test('empty input yields a needsTask result on the fallback agent', () => {
  const result = parseCommand('   ');
  assert.equal(result.agentId, 'computer');
  assert.equal(result.needsTask, true);
});
