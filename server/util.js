'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const isWindows = process.platform === 'win32';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random lowercase id, e.g. randId('s_', 10) -> "s_ab12cd34ef". */
function randId(prefix = '', len = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return String(prefix) + out;
}

/** Readable pairing token such as "K7QX-M3NP-9RTV". */
function randomToken(groups = 3, groupLen = 4) {
  const parts = [];
  for (let g = 0; g < groups; g++) {
    const bytes = crypto.randomBytes(groupLen);
    let part = '';
    for (let i = 0; i < groupLen; i++) part += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    parts.push(part);
  }
  return parts.join('-');
}

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary phrase check over a normalized string. */
function hasPhrase(haystack, phrase) {
  if (!phrase) return false;
  return ` ${haystack} `.includes(` ${String(phrase).trim()} `);
}

function truncate(text, max = 200) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}

function stripAnsi(text) {
  return String(text == null ? '' : text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function stripMarkdown(text) {
  if (!text) return '';
  let out = String(text);
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');
  out = out.replace(/^\s*>\s?/gm, '');
  out = out.replace(/\|/g, ' ');
  out = out.replace(/[\u2500-\u257f]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** First few sentences, suitable for text-to-speech. */
function firstSentences(text, maxSentences = 2, maxLen = 420) {
  const clean = stripMarkdown(text).trim();
  if (!clean) return '';
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  let out = sentences.slice(0, maxSentences).join(' ');
  if (!out) out = clean;
  return truncate(out, maxLen);
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rounded = v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

function formatDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return d.toISOString();
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an executable name the way a shell would, looking through PATH and
 * PATHEXT on Windows. Returns an absolute path or null.
 */
function findExecutable(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  if (trimmed.includes('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    return fileExists(trimmed) ? path.resolve(trimmed) : null;
  }

  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  if (isWindows) {
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .map((e) => e.toLowerCase());
    const hasExt = pathext.some((ext) => trimmed.toLowerCase().endsWith(ext));
    const candidates = hasExt ? [trimmed] : [trimmed, ...pathext.map((ext) => trimmed + ext)];
    for (const dir of pathDirs) {
      for (const cand of candidates) {
        const full = path.join(dir, cand);
        if (fileExists(full)) return full;
      }
    }
    return null;
  }

  for (const dir of pathDirs) {
    const full = path.join(dir, trimmed);
    if (fileExists(full)) return full;
  }
  return null;
}

/** IPv4 LAN addresses, most likely home-network addresses first. */
function getLanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('127.') || addr.address.startsWith('169.254.')) continue;
      out.push({ name, address: addr.address });
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  out.sort((a, b) => score(a.address) - score(b.address));
  return out;
}

/** Safely resolve a URL path inside a public directory; null on traversal. */
function resolveStatic(publicDir, urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  clean = clean.replace(/\\/g, '/');
  const rel = clean.replace(/^\/+/, '');
  const base = path.resolve(publicDir);
  if (!rel) return path.join(base, 'index.html');
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** Single-quoted PowerShell literal, safe against interpolation. */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Accumulates stream chunks and emits complete lines. */
function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const line of parts) onLine(line);
      return parts.length;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest) onLine(rest);
    }
  };
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return source.slice();
  const out = { ...(target || {}) };
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
        out[key] = deepMerge(out[key], value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

module.exports = {
  isWindows,
  randId,
  randomToken,
  normalizeText,
  hasPhrase,
  truncate,
  stripAnsi,
  stripMarkdown,
  firstSentences,
  humanBytes,
  formatDateTime,
  formatDuration,
  fileExists,
  findExecutable,
  getLanAddresses,
  resolveStatic,
  quotePowerShell,
  sleep,
  lineSplitter,
  clamp,
  deepMerge
};
