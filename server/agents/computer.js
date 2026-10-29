'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { normalizeText, hasPhrase, humanBytes, formatDateTime, formatDuration, truncate, isWindows } = require('../util');
const { spawnDetached, openPath, runPowerShell } = require('../exec');

/* ------------------------------------------------------------------ */
/* Folder vocabulary                                                    */
/* ------------------------------------------------------------------ */

const FOLDER_ALIASES = {
  downloads: ['downloads', 'download', 'down loads'],
  documents: ['documents', 'document', 'docs', 'my documents'],
  desktop: ['desktop', 'desk top'],
  pictures: ['pictures', 'picture', 'photos', 'photo', 'images', 'image', 'screenshots'],
  music: ['music', 'songs', 'song', 'audio'],
  videos: ['videos', 'video', 'movies', 'movie'],
  home: ['home folder', 'home directory', 'user folder', 'user profile', 'profile folder']
};

const FOLDER_BASES = {
  downloads: () => path.join(os.homedir(), 'Downloads'),
  documents: () => path.join(os.homedir(), 'Documents'),
  desktop: () => path.join(os.homedir(), 'Desktop'),
  pictures: () => path.join(os.homedir(), 'Pictures'),
  music: () => path.join(os.homedir(), 'Music'),
  videos: () => path.join(os.homedir(), 'Videos'),
  home: () => os.homedir()
};

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasAlternation(aliases) {
  return aliases
    .map((alias) => escapeRegExp(alias).replace(/\s+/g, '\\s+'))
    .join('|');
}

const FOLDER_PATTERNS = Object.fromEntries(
  Object.entries(FOLDER_ALIASES).map(([key, aliases]) => {
    const alt = aliasAlternation(aliases);
    return [
      key,
      {
        inFolder: new RegExp(
          `\\b(?:in|at|inside|from|under|on|within)\\s+(?:the\\s+|my\\s+|your\\s+|our\\s+)?(?:${alt})(?:\\s+(?:folder|dir|directory))?\\b`
        ),
        folderWord: new RegExp(`\\b(?:the\\s+|my\\s+|your\\s+)?(?:${alt})\\s+(?:folder|dir|directory)\\b`),
        bareOpen: new RegExp(
          `^(?:open|list|show|browse|look\\s+in|go\\s+to)\\s+(?:me\\s+)?(?:the\\s+|my\\s+|your\\s+)?(?:${alt})$`
        )
      }
    ];
  })
);

function detectFolder(norm) {
  for (const [key, patterns] of Object.entries(FOLDER_PATTERNS)) {
    if (patterns.inFolder.test(norm) || patterns.folderWord.test(norm) || patterns.bareOpen.test(norm)) return key;
  }
  return null;
}

function resolveFolder(config, key) {
  const overrides = (config && config.computer && config.computer.folderMap) || {};
  if (overrides && overrides[key]) return path.resolve(overrides[key]);
  const base = FOLDER_BASES[key];
  return base ? base() : null;
}

/* ------------------------------------------------------------------ */
/* File types                                                           */
/* ------------------------------------------------------------------ */

const TYPE_RULES = [
  {
    label: 'Word document',
    plural: 'Word documents',
    exts: ['.docx', '.doc', '.rtf', '.odt'],
    match: /\b(?:word\s+(?:document|doc|file)s?|word|docx|ms\s+word)\b/
  },
  {
    label: 'spreadsheet',
    plural: 'spreadsheets',
    exts: ['.xlsx', '.xls', '.csv', '.ods'],
    match: /\b(?:excel|spreadsheets?|spread\s+sheet|xlsx|xls|csv)\b/
  },
  {
    label: 'PowerPoint',
    plural: 'PowerPoint files',
    exts: ['.pptx', '.ppt', '.odp'],
    match: /\b(?:powerpoint|power\s+point|presentations?|slides?|pptx?|ppt)\b/
  },
  {
    label: 'PDF',
    plural: 'PDFs',
    exts: ['.pdf'],
    match: /\bpdfs?\b/
  },
  {
    label: 'image',
    plural: 'images',
    exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tiff'],
    match: /\b(?:images?|photos?|pictures?|screenshots?|png|jpe?g|gif)\b/
  },
  {
    label: 'video',
    plural: 'videos',
    exts: ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.wmv'],
    match: /\b(?:videos?|movies?|mp4|mov|mkv)\b/
  },
  {
    label: 'audio file',
    plural: 'audio files',
    exts: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'],
    match: /\b(?:audio|music|songs?|mp3|wav|m4a)\b/
  },
  {
    label: 'text file',
    plural: 'text files',
    exts: ['.txt', '.md', '.markdown'],
    match: /\b(?:text\s+files?|txt|markdown)\b/
  },
  {
    label: 'archive',
    plural: 'archives',
    exts: ['.zip', '.rar', '.7z', '.tar', '.gz'],
    match: /\b(?:zips?|archives?|rar|7z)\b/
  },
  {
    label: 'installer',
    plural: 'installers',
    exts: ['.exe', '.msi'],
    match: /\b(?:installers?|exe|setup\s+file)\b/
  },
  {
    label: 'script',
    plural: 'scripts',
    exts: ['.js', '.ts', '.py', '.ps1', '.sh', '.json'],
    match: /\b(?:scripts?|code\s+files?|source\s+files?|source\s+code)\b/
  }
];

function detectType(norm) {
  for (const rule of TYPE_RULES) {
    if (rule.match.test(norm)) return rule;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Query extraction                                                     */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set(
  (
    'find search locate look for looking searching finding where is where s up get open launch start started begin run list show me my our mine the a an any some please kindly ' +
    'can you could would i want need would like then and also it that this these those file files document documents folder folders ' +
    'directory dir in at inside from on of to for called named titled around quickly now ' +
    'word excel spreadsheet spread sheet powerpoint presentation slide slides pdf doc docs image images photo photos picture pictures ' +
    'screenshot screenshots video videos movie movies audio music song songs text zip zips archive archives installer installers ' +
    'exe setup script scripts code source png jpg jpeg gif mp4 mov mkv mp3 wav txt markdown xlsx xls csv pptx ppt docx rtf odt ods odp tiff heic ' +
    'pc computer laptop machine system status stats battery memory usage disk space take capture screen lock time all everything ' +
    'new session another fresh open it that this results result app apps application program bring switch to'
  )
    .split(/\s+/)
    .filter(Boolean)
);

function removeFolderMentions(norm, folderKey) {
  if (!folderKey) return norm;
  const aliases = FOLDER_ALIASES[folderKey] || [];
  let result = norm;
  for (const alias of aliases) {
    const re = new RegExp(`\\b${escapeRegExp(alias).replace(/\s+/g, '\\s+')}(?:\\s+(?:folder|dir|directory))?\\b`, 'g');
    result = result.replace(re, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

function extractQuery(norm, { folderKey = null, type = null } = {}) {
  let source = norm;
  const called = norm.match(/\b(?:called|named|titled)\s+(.+)$/);
  if (called) source = called[1];
  source = removeFolderMentions(source, folderKey);
  const tokens = source.split(' ').map((t) => t.trim()).filter(Boolean);
  const kept = [];
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    if (token.length < 2 && !/[0-9]/.test(token)) continue;
    kept.push(token);
  }
  return kept.join(' ').slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Intent parsing                                                       */
/* ------------------------------------------------------------------ */

const KNOWN_APPS = {
  notepad: 'notepad.exe',
  'notepad plus plus': 'notepad++.exe',
  notepadplusplus: 'notepad++.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
  edge: 'msedge.exe',
  'microsoft edge': 'msedge.exe',
  chrome: 'chrome.exe',
  'google chrome': 'chrome.exe',
  explorer: 'explorer.exe',
  'file explorer': 'explorer.exe',
  'windows explorer': 'explorer.exe',
  settings: 'ms-settings:',
  'windows settings': 'ms-settings:',
  paint: 'mspaint.exe',
  'ms paint': 'mspaint.exe',
  cmd: 'cmd.exe',
  'command prompt': 'cmd.exe',
  powershell: 'powershell.exe',
  terminal: 'wt.exe',
  'windows terminal': 'wt.exe',
  vscode: 'code',
  'visual studio code': 'code',
  code: 'code',
  word: 'winword.exe',
  'microsoft word': 'winword.exe',
  excel: 'excel.exe',
  'microsoft excel': 'excel.exe',
  powerpoint: 'powerpnt.exe',
  'microsoft powerpoint': 'powerpnt.exe',
  outlook: 'outlook.exe',
  spotify: 'spotify:',
  steam: 'steam:',
  'task manager': 'taskmgr.exe',
  taskmgr: 'taskmgr.exe',
  'control panel': 'control.exe',
  'file manager': 'explorer.exe',
  'snipping tool': 'snippingtool.exe'
};

function findKnownApp(phrase) {
  const p = normalizeText(phrase);
  if (!p) return null;
  if (KNOWN_APPS[p]) return KNOWN_APPS[p];
  for (const [name, target] of Object.entries(KNOWN_APPS)) {
    if (p === name || p.startsWith(`${name} `) || p.endsWith(` ${name}`)) return target;
  }
  return null;
}

function detectVerb(norm) {
  if (/^(?:lock|lock\s+(?:the\s+)?(?:screen|pc|computer|laptop|workstation|it|this))\b/.test(norm)) return 'lock';
  if (/^(?:take\s+(?:a\s+)?screenshot|screenshot|capture\s+(?:the\s+)?screen|grab\s+(?:a\s+)?screenshot)/.test(norm)) return 'screenshot';
  if (/\b(?:what(?:'s| is) the time|current time|time is it)\b/.test(norm)) return 'time';
  if (/^(?:help|what can you do|capabilities|what do you do|commands)\b/.test(norm)) return 'help';
  if (
    /\b(?:how (?:is|are) (?:my|the|your) (?:pc|computer|laptop)|(?:pc|computer|laptop) (?:status|health)|system status|system info|stats|battery|memory usage|cpu usage|disk (?:space|usage)|free space)\b/.test(
      norm
    )
  ) {
    return 'stats';
  }
  if (/^(?:start|begin)\s+(?:looking|searching|finding|search)\b/.test(norm)) return 'find';
  if (/^(?:find|search|locate|look\s+for|look\s+up|where\s+is|where's|where\s+are|get\s+me|grab)\b/.test(norm)) return 'find';
  if (/^(?:open|launch|start|run|bring\s+up|switch\s+to)\b/.test(norm)) {
    const rest = norm.replace(/^(?:open|launch|start|run|bring\s+up|switch\s+to)\s+/, '').trim();
    if (rest && findKnownApp(rest)) return 'launch';
    return 'open';
  }
  if (/^(?:list|show)\b/.test(norm)) return 'list';
  if (/\b(?:list|show|what's in|contents of)\b.*\b(?:folder|directory|downloads|desktop|documents)\b/.test(norm)) return 'list';
  return 'find';
}

function parseIntent(task) {
  const raw = String(task == null ? '' : task).trim();
  const norm = normalizeText(raw);
  const intent = detectVerb(norm);
  const folderKey = detectFolder(norm);
  const type = detectType(norm);
  const query = extractQuery(norm, { folderKey, type });

  let appPhrase = null;
  if (intent === 'launch' || intent === 'open') {
    const rest = norm.replace(/^(?:open|launch|start|run|bring\s+up|switch\s+to)\s+/, '').trim();
    if (rest && findKnownApp(rest)) {
      appPhrase = rest;
    } else if (intent === 'launch') {
      appPhrase = rest;
    }
  }

  const openAfter = /\b(?:and|then)?\s*open\s+(?:it|that|this|the\s+file|the\s+document|the\s+doc|the\s+result|the\s+folder)\b/.test(norm);
  const absolute = raw.match(/([A-Za-z]:[\\/][^,;]+)/);

  return {
    raw,
    norm,
    intent,
    folderKey,
    type,
    typeExts: type ? type.exts : null,
    query,
    appPhrase,
    openAfter,
    absoluteRoot: absolute ? absolute[1].trim() : null
  };
}

/* ------------------------------------------------------------------ */
/* File search                                                          */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'appdata',
  '$recycle.bin',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
  'perflogs',
  'recovery',
  '.cache',
  '.npm-cache',
  '.tools',
  'library',
  '__pycache__',
  'site-packages',
  '.venv',
  'venv'
]);

function tokenizeQuery(query) {
  return normalizeText(query)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function scoreMatch(nameLower, queryNorm, qTokens) {
  let score = 0;
  if (queryNorm) {
    if (nameLower === queryNorm) score += 120;
    else if (nameLower.startsWith(queryNorm)) score += 95;
    else if (nameLower.includes(queryNorm)) score += 75;

    if (qTokens.length) {
      let hits = 0;
      for (const token of qTokens) {
        if (nameLower.includes(token)) hits += 1;
      }
      if (hits === qTokens.length) score += 60;
      else if (hits > 0) score += Math.round(20 * (hits / qTokens.length));
    }
    const compact = qTokens.join('');
    if (compact && nameLower.includes(compact)) score += 15;
    if (score === 0) return 0;
  } else {
    score = 10;
  }
  return score;
}

async function dirExists(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively search directories for files whose names match a query and/or
 * allowed extensions. Depth/time/file-count capped so a huge Downloads folder
 * never hangs the server.
 */
async function searchFiles(options) {
  const {
    roots = [],
    query = '',
    exts = null,
    maxDepth = 7,
    maxFiles = 25000,
    timeoutMs = 8000,
    maxResults = 8
  } = options;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const queryNorm = normalizeText(query);
  const qTokens = tokenizeQuery(query);
  const extSet = exts && exts.length ? new Set(exts.map((e) => e.toLowerCase())) : null;
  const results = [];
  let scanned = 0;
  let truncated = false;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (Date.now() > deadline) { truncated = true; return; }
    if (scanned >= maxFiles) { truncated = true; return; }

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (Date.now() > deadline || scanned >= maxFiles) { truncated = true; return; }
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lower)) continue;
        if (lower.startsWith('.') && lower !== '.') continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      scanned += 1;
      const lower = entry.name.toLowerCase();
      if (extSet) {
        const ext = path.extname(lower);
        if (!extSet.has(ext)) continue;
      }
      const score = scoreMatch(lower, queryNorm, qTokens);
      if (score <= 0) continue;

      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      results.push({ path: full, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, score });
    }
  }

  for (const root of roots) {
    if (await dirExists(root)) await walk(root, 0);
  }

  results.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);

  return {
    results: results.slice(0, maxResults),
    totalMatches: results.length,
    scanned,
    truncated,
    roots,
    durationMs: Date.now() - startedAt
  };
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function friendlyFolderName(config, dir) {
  const known = ['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos', 'home'];
  for (const key of known) {
    const resolved = resolveFolder(config, key);
    if (resolved && path.resolve(resolved).toLowerCase() === path.resolve(dir).toLowerCase()) {
      return key === 'home' ? 'your home folder' : key.charAt(0).toUpperCase() + key.slice(1);
    }
  }
  return path.basename(dir) || dir;
}

function rootsLabel(config, roots) {
  if (!roots || !roots.length) return 'your usual folders';
  return roots.map((root) => friendlyFolderName(config, root)).join(', ');
}

function formatResults(config, intent, search) {
  const { results, roots, scanned, durationMs, truncated } = search;
  const where = rootsLabel(config, roots);

  if (!results.length) {
    const what = intent.query
      ? `“${intent.query}”`
      : intent.type
        ? intent.type.plural
        : 'anything matching that';
    return {
      ok: true,
      speech: `I couldn't find ${what} in ${where}.`,
      text: `No matches for ${what} in ${where}.\n\nScanned ${scanned} files in ${formatDuration(durationMs)}.${truncated ? ' (Search hit its limits — increase limits in config.json if needed.)' : ''}`
    };
  }

  const best = results[0];
  const bestFolder = friendlyFolderName(config, path.dirname(best.path));
  const lines = results.map((item, index) => {
    const n = index + 1;
    return `${n}. ${item.name}\n   ${humanBytes(item.size)} · ${formatDateTime(new Date(item.mtimeMs))}\n   ${item.path}`;
  });

  let speech;
  if (results.length === 1) {
    speech = `Found it: ${best.name}, in ${bestFolder}.`;
  } else {
    speech = `Found ${results.length} matches. The best match is ${best.name}, in ${bestFolder}.`;
  }
  if (intent.openAfter) speech += ' Opening it now.';

  const text = `Found ${results.length} match${results.length === 1 ? '' : 'es'}${intent.query ? ` for “${intent.query}”` : ''} in ${where}:\n\n${lines.join('\n\n')}\n\nScanned ${scanned} files in ${formatDuration(durationMs)}.`;

  return { ok: true, speech, text, best, results };
}

function pluralType(intent) {
  if (!intent.type) return 'matches';
  return intent.type.plural;
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

async function openTarget(ctx, intent) {
  const { config, session } = ctx;
  const norm = intent.norm;

  // "open it" / "open that" -> reuse the previous result.
  const refersBack = /^(?:open|launch|start|run|show)\s+(?:it|that|this|them|the\s+file|the\s+document|the\s+doc|the\s+folder|the\s+result|the\s+results)\b/.test(norm);
  if ((refersBack || norm === 'open' || norm === 'launch') && session?.context?.lastOpenTarget) {
    const target = session.context.lastOpenTarget;
    const result = await openPath(target.target);
    return {
      ok: result.ok,
      speech: result.ok ? `Opening ${target.label}.` : `I couldn't open ${target.label}: ${truncate(result.error, 160)}`,
      text: result.ok ? `Opened: ${target.target}` : `Failed to open ${target.target}: ${result.error}`,
      meta: { opened: target }
    };
  }

  // A known app by name.
  if (intent.appPhrase) {
    const app = findKnownApp(intent.appPhrase);
    if (app) {
      const result = await spawnDetached('cmd.exe', ['/d', '/c', 'start', '', app]);
      return {
        ok: result.ok,
        speech: result.ok ? `Launching ${intent.appPhrase}.` : `I couldn't launch that app: ${truncate(result.error, 160)}`,
        text: result.ok ? `Launched ${intent.appPhrase} (${app}).` : `Failed to launch ${app}: ${result.error}`,
        meta: { launched: app }
      };
    }
  }

  // A well-known folder.
  if (intent.folderKey) {
    const dir = resolveFolder(config, intent.folderKey);
    if (dir) {
      const result = await openPath(dir);
      const name = friendlyFolderName(config, dir);
      return {
        ok: result.ok,
        speech: result.ok ? `Opening ${name}.` : `I couldn't open ${name}.`,
        text: result.ok ? `Opened folder: ${dir}` : `Failed to open ${dir}: ${result.error}`,
        meta: { opened: { kind: 'folder', target: dir, label: name } }
      };
    }
  }

  // Search for a file and open the best match.
  const search = await searchForIntent(ctx, intent);
  if (search.results.length) {
    const best = search.results[0];
    if (session) {
      session.context.lastSearch = search;
      session.context.lastOpenTarget = { kind: 'file', target: best.path, label: best.name };
    }
    const result = await openPath(best.path);
    return {
      ok: result.ok,
      speech: result.ok ? `Opening ${best.name}.` : `I found ${best.name} but couldn't open it: ${truncate(result.error, 140)}`,
      text: result.ok ? `Opened: ${best.path}` : `Found ${best.path} but opening failed: ${result.error}`,
      meta: { opened: { kind: 'file', target: best.path, label: best.name } }
    };
  }

  return {
    ok: true,
    speech: intent.query
      ? `I couldn't find “${intent.query}”, so I didn't open anything.`
      : 'Tell me what to open — an app name, a folder, or a file to search for.',
    text: `Nothing to open${intent.query ? ` for “${intent.query}”` : ''}.`
  };
}

async function searchForIntent(ctx, intent) {
  const { config } = ctx;
  const computerCfg = config.computer || {};
  const roots = [];

  if (intent.absoluteRoot && computerCfg.allowAbsolutePaths) {
    roots.push(path.resolve(intent.absoluteRoot));
  } else if (intent.folderKey) {
    const dir = resolveFolder(config, intent.folderKey);
    if (dir) roots.push(dir);
  }

  if (!roots.length) {
    const keys = computerCfg.searchRoots || ['downloads', 'documents', 'desktop'];
    for (const key of keys) {
      const dir = resolveFolder(config, key);
      if (dir) roots.push(dir);
    }
  }

  const uniqueRoots = [...new Set(roots.map((r) => path.resolve(r)))];

  return searchFiles({
    roots: uniqueRoots,
    query: intent.query,
    exts: intent.typeExts,
    maxDepth: computerCfg.maxDepth || 7,
    maxFiles: computerCfg.maxFiles || 25000,
    timeoutMs: computerCfg.searchTimeoutMs || 8000,
    maxResults: computerCfg.maxResults || 8
  });
}

async function handleFind(ctx, intent) {
  const { config, session } = ctx;

  // No filename and no file type: never return an arbitrary "newest file".
  if (!intent.query && !intent.type) {
    if (intent.folderKey) return handleList(ctx, intent);
    if (session?.context?.lastSearch) {
      return formatResults(config, intent, session.context.lastSearch);
    }
    return {
      ok: true,
      speech: 'What file should I look for? For example: find the budget Word document in Downloads.',
      text: 'Tell me a file name, a file type (Word document, PDF, spreadsheet…), or a folder to search.'
    };
  }

  const search = await searchForIntent(ctx, intent);

  if (!search.results.length) {
    const where = rootsLabel(config, search.roots);
    const what = intent.query ? `“${intent.query}”` : intent.type ? intent.type.plural : 'anything matching that';
    return {
      ok: true,
      speech: `I couldn't find ${what} in ${where}.`,
      text: `No matches for ${what} in ${where}.\n\nScanned ${search.scanned} files in ${formatDuration(search.durationMs)}.`,
      meta: { scanned: search.scanned }
    };
  }

  if (session) {
    session.context.lastSearch = search;
    session.context.lastOpenTarget = { kind: 'file', target: search.results[0].path, label: search.results[0].name };
  }

  if (intent.openAfter) {
    const best = search.results[0];
    const open = await openPath(best.path);
    const speech = formatResults(config, { ...intent, openAfter: false }, search).speech +
      (open.ok ? ' Opening it now.' : ` I couldn't open it: ${truncate(open.error, 120)}`);
    return {
      ok: open.ok,
      speech,
      text: `Found ${search.results.length} match${search.results.length === 1 ? '' : 'es'}${intent.query ? ` for “${intent.query}”` : ''}.\n\nOpened: ${open.ok ? best.path : 'failed'}`,
      meta: { opened: { kind: 'file', target: best.path, label: best.name } }
    };
  }

  return formatResults(config, intent, search);
}

async function handleList(ctx, intent) {
  const { config } = ctx;
  const key = intent.folderKey || 'downloads';
  const dir = resolveFolder(config, key);
  if (!dir) {
    return { ok: true, speech: 'I do not know that folder.', text: 'Unknown folder.' };
  }

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, speech: `I couldn't read ${friendlyFolderName(config, dir)}.`, text: `Error: ${err.message}` };
  }

  const withStats = [];
  for (const entry of entries.slice(0, 200)) {
    const full = path.join(dir, entry.name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = await fsp.stat(full);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch { /* ignore */ }
    withStats.push({ name: entry.name, isDir: entry.isDirectory(), size, mtimeMs });
  }
  withStats.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.mtimeMs - a.mtimeMs);

  const shown = withStats.slice(0, 25);
  const folderName = friendlyFolderName(config, dir);
  const lines = shown.map((item, i) => `${i + 1}. ${item.isDir ? '📁' : '📄'} ${item.name}${item.isDir ? '' : ` — ${humanBytes(item.size)}`}`);

  if (ctx.session) ctx.session.context.lastOpenTarget = { kind: 'folder', target: dir, label: folderName };

  return {
    ok: true,
    speech: `${folderName} has ${withStats.length} item${withStats.length === 1 ? '' : 's'}. Showing the first ${shown.length}.`,
    text: `${folderName} (${dir}) has ${withStats.length} item${withStats.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}${withStats.length > shown.length ? `\n\n…and ${withStats.length - shown.length} more.` : ''}`
  };
}

async function handleScreenshot(ctx) {
  const { config, dataDir } = ctx;
  if (!isWindows) {
    return { ok: false, speech: 'Screenshots are only implemented for Windows right now.', text: 'Unsupported platform.' };
  }
  const shotDir = path.resolve(dataDir, config.computer?.screenshotDir || 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const name = `shot-${Date.now()}.png`;
  const target = path.join(shotDir, name);
  const safeTarget = target.replace(/'/g, "''");

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    `$bmp.Save('${safeTarget}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
    `Write-Output '${safeTarget}'`
  ].join('; ');

  const result = await runPowerShell(script, { timeoutMs: 15000 });
  if (!result.ok) {
    return {
      ok: false,
      speech: "I couldn't take a screenshot on this machine.",
      text: `Screenshot failed: ${truncate(result.error || result.stderr || 'unknown error', 400)}\n\nOn the owner's PC this works. Inside a restricted session (like the DSH sandbox) launching PowerShell is blocked.`
    };
  }

  return {
    ok: true,
    speech: 'Screenshot taken.',
    text: `Screenshot saved: ${target}`,
    screenshot: `/api/screenshot/${encodeURIComponent(name)}`,
    meta: { file: target }
  };
}

async function handleLock() {
  if (!isWindows) {
    return { ok: false, speech: 'Locking the screen is only implemented for Windows right now.', text: 'Unsupported platform.' };
  }
  const result = await spawnDetached('rundll32.exe', ['user32.dll,LockWorkStation']);
  return {
    ok: result.ok,
    speech: result.ok ? 'Locking the screen. See you in a bit.' : `I couldn't lock the screen: ${truncate(result.error, 120)}`,
    text: result.ok ? 'Screen locked.' : `Lock failed: ${result.error}`
  };
}

async function handleStats() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const uptimeSec = os.uptime();
  const load = os.loadavg()[0] || 0;

  let diskLine = '';
  if (isWindows) {
    const disk = await runPowerShell(
      'Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null } | ForEach-Object { "{0}|{1}|{2}" -f $_.Name, $_.Used, $_.Free }',
      { timeoutMs: 8000 }
    );
    if (disk.ok && disk.stdout.trim()) {
      const rows = disk.stdout.trim().split(/\r?\n/).map((line) => line.split('|')).filter((r) => r.length === 3);
      diskLine = rows
        .map(([drive, used, free]) => {
          const u = Number(used);
          const f = Number(free);
          const total = u + f;
          const pct = total > 0 ? Math.round((u / total) * 100) : 0;
          return `${drive}: ${humanBytes(f)} free of ${humanBytes(total)} (${pct}% used)`;
        })
        .join('\n');
    }
  }

  const uptimeH = Math.floor(uptimeSec / 3600);
  const uptimeM = Math.floor((uptimeSec % 3600) / 60);
  const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

  const text = [
    `CPU: ${cpus.length} cores, load ${load.toFixed(2)}`,
    `Memory: ${humanBytes(usedMem)} used of ${humanBytes(totalMem)} (${memPct}%)`,
    `Uptime: ${uptimeH}h ${uptimeM}m`,
    diskLine ? `Disks:\n${diskLine}` : 'Disks: unavailable in this session'
  ].join('\n');

  return {
    ok: true,
    speech: `Memory is ${memPct} percent used. ${cpus.length} CPU cores, load ${load.toFixed(1)}. Uptime ${uptimeH} hours.`,
    text
  };
}

function handleTime() {
  const now = new Date();
  const text = now.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  return { ok: true, speech: `It's ${text}.`, text };
}

function handleHelp() {
  const text = [
    'I am the built-in Computer agent. Things you can say (with a wake word):',
    '',
    '• “find my tax return PDF in Downloads”',
    '• “find the budget Word document in Documents and open it”',
    '• “list my Downloads folder”',
    '• “open Downloads” / “open Notepad” / “launch Chrome”',
    '• “take a screenshot”',
    '• “lock the screen”',
    '• “how is my PC doing?” / “what time is it?”',
    '',
    'Wake me with “Hey Computer”, “Hey PC” or “Hey Laptop”.',
    'Other agents: Hey Claude Code, Hey Codex, Hey DeepSeek, Hey Workbuddy, Hey Gemini.'
  ].join('\n');
  return { ok: true, speech: 'I can find files, open folders and apps, take screenshots, lock the screen and report PC stats. Ask me to find something in Downloads.', text };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

async function handleComputerCommand(ctx, task) {
  const startedAt = Date.now();
  let intent;
  try {
    intent = parseIntent(task);
  } catch (err) {
    return { ok: false, speech: "I couldn't understand that command.", text: `Parse error: ${err.message}` };
  }

  let result;
  try {
    switch (intent.intent) {
      case 'lock':
        result = await handleLock();
        break;
      case 'screenshot':
        result = await handleScreenshot(ctx);
        break;
      case 'stats':
        result = await handleStats();
        break;
      case 'time':
        result = handleTime();
        break;
      case 'help':
        result = handleHelp();
        break;
      case 'list':
        result = await handleList(ctx, intent);
        break;
      case 'launch':
      case 'open':
        result = await openTarget(ctx, intent);
        break;
      case 'find':
      default:
        result = await handleFind(ctx, intent);
        break;
    }
  } catch (err) {
    result = {
      ok: false,
      speech: 'Something went wrong while running that command.',
      text: `Error: ${err.message}`
    };
  }

  result.meta = {
    ...(result.meta || {}),
    intent: intent.intent,
    folder: intent.folderKey,
    type: intent.type ? intent.type.label : null,
    query: intent.query || null,
    durationMs: Date.now() - startedAt
  };
  return result;
}

module.exports = {
  handleComputerCommand,
  _internals: {
    parseIntent,
    detectVerb,
    detectFolder,
    detectType,
    extractQuery,
    scoreMatch,
    searchFiles,
    findKnownApp,
    resolveFolder,
    formatResults,
    FOLDER_ALIASES,
    TYPE_RULES,
    KNOWN_APPS
  }
};
