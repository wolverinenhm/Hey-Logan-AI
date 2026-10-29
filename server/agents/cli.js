'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { execCommand } = require('../exec');
const {
  findExecutable,
  firstSentences,
  stripAnsi,
  truncate,
  lineSplitter,
  quotePowerShell
} = require('../util');

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function expandPath(value) {
  let p = String(value == null ? '' : value).trim();
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  p = p.replace(/%([^%]+)%/g, (match, name) => (process.env[name] === undefined ? match : process.env[name]));
  return p;
}

function resolveCliCommand(agentId, def, config) {
  const cfg = (config.agents && config.agents[agentId]) || {};
  const command = String(cfg.command || (def.cli && def.cli.command) || agentId).trim();
  const resolved = command ? findExecutable(expandPath(command)) : null;
  return { command, resolved, cfg };
}

/**
 * npm global CLIs on Windows are .cmd shims that ultimately launch a JS file
 * with node. If we can find that JS file we run node directly, which lets us
 * pass the prompt as a real argv entry (no shell quoting problems).
 */
function findShimScript(shimPath) {
  try {
    const content = fs.readFileSync(shimPath, 'utf8');
    if (content.length > 100000) return null;
    const match = content.match(/%~dp0([^"\r\n]+?\.(?:js|mjs|cjs))/i);
    if (!match) return null;
    const candidate = path.resolve(path.dirname(shimPath), match[1].replace(/\\/g, '/'));
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Build the actual process invocation for a CLI agent.
 *
 * - native .exe: spawn directly, argv array (safest)
 * - npm .cmd/.bat shim: try the underlying node script, else PowerShell
 * - .ps1: powershell -File
 */
function buildInvocation(resolvedPath, argvTemplate, prompt) {
  const template = Array.isArray(argvTemplate) && argvTemplate.length ? argvTemplate : ['{prompt}'];
  const usesPlaceholder = template.some((entry) => String(entry).includes('{prompt}'));
  const args = template.map((entry) => String(entry).replace(/\{prompt\}/g, prompt));
  if (!usesPlaceholder) args.push(prompt);

  const lower = resolvedPath.toLowerCase();

  if (/\.(cmd|bat)$/i.test(lower)) {
    const shimScript = findShimScript(resolvedPath);
    if (shimScript) {
      return { command: process.execPath, args: [shimScript, ...args], via: 'node-shim' };
    }
    // Fallback: PowerShell single-quoted arguments are not expanded by cmd.
    const safeArgs = args.map((arg) => String(arg).replace(/"/g, "'"));
    const script = `& ${quotePowerShell(resolvedPath)} ${safeArgs.map(quotePowerShell).join(' ')}`;
    return { command: 'powershell.exe', args: [...PS_FLAGS, '-Command', script], via: 'powershell' };
  }

  if (/\.ps1$/i.test(lower)) {
    return { command: 'powershell.exe', args: [...PS_FLAGS, '-File', resolvedPath, ...args], via: 'powershell-file' };
  }

  return { command: resolvedPath, args, via: 'direct' };
}

function buildCliSpeech(def, { result, combined, timeoutMs }) {
  const name = def.name;

  if (result.timedOut) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    return `${name} ran for more than ${minutes} minute${minutes === 1 ? '' : 's'}, so I stopped it. Try a smaller task.`;
  }

  if (result.spawnError) {
    if (result.spawnError === 'EPERM') {
      return `I couldn't start ${name} — this session blocks launching programs.`;
    }
    return `I couldn't start ${name}: ${truncate(result.error || result.spawnError, 180)}`;
  }

  if (!result.ok) {
    const detail = firstSentences(combined || result.stderr || '', 1, 240);
    const code = result.code == null ? '' : ` (code ${result.code})`;
    return `${name} exited with an error${code}. ${detail}`.trim();
  }

  const summary = firstSentences(combined, 2, 380);
  return summary || `${name} finished.`;
}

/**
 * Run one non-interactive CLI agent turn.
 * CLI agents are stateless processes: each command is a fresh run, optionally
 * started in the configured working directory.
 */
async function runCliAgent({ agentId, def, config, prompt, hooks = {} }) {
  const { resolved } = resolveCliCommand(agentId, def, config);
  const cfg = (config.agents && config.agents[agentId]) || {};
  const timeoutMs = Number(cfg.timeoutMs) || (def.cli && def.cli.timeoutMs) || 300000;
  const cwdSetting = expandPath(cfg.cwd || '');
  const cwd = cwdSetting && fs.existsSync(cwdSetting) ? cwdSetting : os.homedir();

  if (!resolved) {
    const install = (def.cli && def.cli.install) || '';
    const speech = `I couldn't find ${def.name} on this PC.${install ? ` To install it: ${install}.` : ' Set its command in data/config.json.'}`;
    const text = [
      `${def.name} is not installed or not on PATH.`,
      '',
      `Expected command: ${cfg.command || (def.cli && def.cli.command) || agentId}`,
      install ? `Install with: ${install}` : '',
      `Or edit "agents.${agentId}" in data/config.json.`,
      def.cli && def.cli.docsUrl ? `Docs: ${def.cli.docsUrl}` : ''
    ]
      .filter(Boolean)
      .join('\n');
    return { ok: false, missing: true, speech, text, code: null, durationMs: 0, stdout: '', stderr: '' };
  }

  const invocation = buildInvocation(resolved, cfg.args || (def.cli && def.cli.args), prompt);
  const startedAt = Date.now();
  const stdoutSplitter = lineSplitter((line) => hooks.onChunk?.(`${line}\n`, 'stdout'));
  const stderrSplitter = lineSplitter((line) => hooks.onChunk?.(`${line}\n`, 'stderr'));

  const result = await execCommand(invocation.command, invocation.args, {
    cwd,
    timeoutMs,
    onStdout: (chunk) => stdoutSplitter.push(stripAnsi(chunk)),
    onStderr: (chunk) => stderrSplitter.push(stripAnsi(chunk))
  });
  stdoutSplitter.flush();
  stderrSplitter.flush();

  const stdout = stripAnsi(result.stdout || '');
  const stderr = stripAnsi(result.stderr || '');
  const combined = `${stdout}\n${stderr}`.trim();
  const durationMs = Date.now() - startedAt;

  const text = combined
    ? combined
    : result.ok
      ? '(The CLI finished but printed no output.)'
      : `(no output; exit code ${result.code == null ? 'unknown' : result.code})`;

  return {
    ok: Boolean(result.ok),
    code: result.code == null ? null : result.code,
    timedOut: Boolean(result.timedOut),
    durationMs,
    stdout,
    stderr,
    speech: buildCliSpeech(def, { result, combined, timeoutMs }),
    text,
    invocation: { via: invocation.via, command: path.basename(invocation.command) }
  };
}

module.exports = {
  resolveCliCommand,
  buildInvocation,
  findShimScript,
  expandPath,
  runCliAgent,
  _internals: { PS_FLAGS }
};
