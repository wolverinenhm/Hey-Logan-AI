'use strict';

const { normalizeText, hasPhrase } = require('./util');
const { AGENTS, GENERIC_WAKE } = require('./agents/defs');

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex that finds a normalized phrase inside arbitrary (original) text,
 * allowing arbitrary punctuation and whitespace between the words.
 */
function phraseRegExp(phraseNorm) {
  const words = String(phraseNorm).trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!words.length) return null;
  return new RegExp(`(?:^|[^a-z0-9'])(?:${words.join("[^a-z0-9']+")})(?=[^a-z0-9']|$)`, 'i');
}

function removeFirstPhrase(original, phraseNorm) {
  const re = phraseRegExp(phraseNorm);
  if (!re) return original;
  return String(original).replace(re, ' ');
}

function findWakeMatches(norm) {
  const matches = [];
  for (const def of AGENTS) {
    for (const phrase of def.wake || []) {
      const p = normalizeText(phrase);
      if (!p) continue;
      if (hasPhrase(norm, p)) {
        matches.push({ agentId: def.id, phrase: p, strong: true, len: p.length });
      }
    }
    for (const phrase of def.weak || []) {
      const p = normalizeText(phrase);
      if (!p) continue;
      if (norm === p || norm.startsWith(`${p} `)) {
        matches.push({ agentId: def.id, phrase: p, strong: false, len: p.length });
      }
    }
  }
  return matches;
}

const FILLERS = /^(?:(?:please|kindly|can you|could you|would you|will you|i want you to|i would like you to|i'd like you to|i need you to|i want to|i'd like to|let's|lets|now|then|and|also|ok|okay|so|um|uh|hey|hi|hello)\b[\s,]+)+/i;

function cleanTask(task) {
  let text = String(task == null ? '' : task).trim();
  text = text.replace(/^[\s,.:;!?\u2013\u2014-]+/, '');
  let previous;
  do {
    previous = text;
    text = text.replace(FILLERS, '');
  } while (text !== previous && text.length > 0);
  text = text.replace(/^[\s,.:;!?]+/, '').replace(/[\s,]+$/, '').trim();
  return text;
}

function extractNewSessionFlag(task) {
  let text = task;
  let newSession = false;

  const leading = /^(?:open|start|begin|create)\s+(?:a\s+|an\s+|another\s+|new\s+)?new\s+session\b[\s,.:;!?-]*/i;
  if (leading.test(text)) {
    text = text.replace(leading, '');
    newSession = true;
  }

  const bare = /^(?:a\s+|the\s+)?(?:new|fresh|another)\s+session\b[\s,.:;!?-]*/i;
  if (bare.test(text)) {
    text = text.replace(bare, '');
    newSession = true;
  }

  text = text.replace(/^(?:and|then|so)\b[\s,]+/i, '');
  return { task: text.trim(), newSession };
}

/**
 * Parse a spoken transcript into an agent + task.
 *
 * Order of precedence:
 *   1. Strong wake phrases ("hey claude code") anywhere in the utterance.
 *   2. Weak agent names ("claude", "codex") at the very start of the utterance.
 *   3. Generic wake ("hey ai") -> ask which agent.
 *   4. No wake at all -> the configured default agent handles the whole text.
 */
function parseCommand(input, options = {}) {
  const raw = String(input == null ? '' : input).trim();
  const fallback = options.defaultAgent || 'computer';
  const norm = normalizeText(raw);

  if (!norm) {
    return { agentId: fallback, matched: false, generic: false, task: '', raw, newSession: false, wakePhrase: null, needsTask: true };
  }

  const matches = findWakeMatches(norm);
  if (matches.length) {
    matches.sort((a, b) => (Number(b.strong) - Number(a.strong)) || (b.len - a.len));
    const best = matches[0];
    const withoutWake = removeFirstPhrase(raw, best.phrase);
    const { task, newSession } = extractNewSessionFlag(cleanTask(withoutWake));
    return {
      agentId: best.agentId,
      matched: true,
      generic: false,
      task,
      raw,
      newSession,
      wakePhrase: best.phrase,
      needsTask: !task
    };
  }

  for (const generic of GENERIC_WAKE) {
    const gp = normalizeText(generic);
    if (!gp || !hasPhrase(norm, gp)) continue;
    const withoutWake = removeFirstPhrase(raw, gp);
    const { task, newSession } = extractNewSessionFlag(cleanTask(withoutWake));
    return {
      agentId: null,
      matched: true,
      generic: true,
      task,
      raw,
      newSession,
      wakePhrase: gp,
      needsTask: !task
    };
  }

  return {
    agentId: fallback,
    matched: false,
    generic: false,
    task: cleanTask(raw),
    raw,
    newSession: false,
    wakePhrase: null,
    needsTask: false
  };
}

/** Wake phrases grouped by agent (used by the UI/tests). */
function wakePhraseCatalog() {
  return AGENTS.map((def) => ({ id: def.id, name: def.name, wake: def.wake, weak: def.weak }));
}

module.exports = { parseCommand, cleanTask, wakePhraseCatalog, findWakeMatches, GENERIC_WAKE_LABEL: GENERIC_WAKE };
