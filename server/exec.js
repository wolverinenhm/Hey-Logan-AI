'use strict';

const { spawn } = require('child_process');
const { isWindows, truncate, quotePowerShell } = require('./util');

const MAX_CAPTURE = 400000;

/**
 * Run a command and capture its output (pipes, no shell).
 * Never rejects: every failure mode resolves with { ok: false, ... }.
 */
function execCommand(command, args = [], options = {}) {
  const {
    cwd,
    timeoutMs = 15000,
    env,
    detached = false,
    onStdout,
    onStderr
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      result.durationMs = Date.now() - startedAt;
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        detached,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return finish({ ok: false, error: err.message, spawnError: err.code || 'SPAWN_FAILED', code: null, stdout: '', stderr: '' });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      if (isWindows && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, detached: false });
        } catch { /* ignore */ }
      }
      finish({
        ok: false,
        error: `Timed out after ${timeoutMs} ms`,
        timedOut: true,
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (data) => {
      if (stdoutLen < MAX_CAPTURE) {
        stdoutLen += data.length;
        stdoutChunks.push(data);
      }
      if (onStdout) {
        try { onStdout(data.toString('utf8')); } catch { /* ignore */ }
      }
    });

    child.stderr.on('data', (data) => {
      if (stderrLen < MAX_CAPTURE) {
        stderrLen += data.length;
        stderrChunks.push(data);
      }
      if (onStderr) {
        try { onStderr(data.toString('utf8')); } catch { /* ignore */ }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message, spawnError: err.code || 'SPAWN_FAILED', code: null, stdout: '', stderr: '' });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !signal,
        code,
        signal: signal || null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
}

/**
 * Start a detached program and return immediately (used for opening files,
 * folders, apps and locking the screen). Never rejects.
 */
function spawnDetached(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: process.env,
        windowsHide: true,
        detached: true,
        shell: false,
        stdio: 'ignore'
      });
    } catch (err) {
      return finish({ ok: false, error: err.message, spawnError: err.code || 'SPAWN_FAILED' });
    }
    child.on('error', (err) => finish({ ok: false, error: err.message, spawnError: err.code || 'SPAWN_FAILED' }));
    child.on('spawn', () => {
      try { child.unref(); } catch { /* ignore */ }
      finish({ ok: true });
    });
    // Safety net if no spawn event arrives (should not happen on supported Node).
    setTimeout(() => finish({ ok: true }), 1500);
  });
}

async function openPath(target) {
  // PowerShell's single-quoted literal + Start-Process avoids cmd.exe
  // metacharacter problems with paths containing &, ^, |, % or spaces.
  if (isWindows) {
    const script = `Start-Process -FilePath ${quotePowerShell(target)}`;
    return spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }
  if (process.platform === 'darwin') return spawnDetached('open', [target]);
  return spawnDetached('xdg-open', [target]);
}

async function runPowerShell(script, { timeoutMs = 20000 } = {}) {
  return execCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs }
  );
}

module.exports = { execCommand, spawnDetached, openPath, runPowerShell, truncate, MAX_CAPTURE };
