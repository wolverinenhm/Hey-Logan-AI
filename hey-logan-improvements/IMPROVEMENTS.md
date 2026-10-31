# Hey AI Bridge — Improvements & Fixes Applied

This document summarizes every bug fix, security improvement, and upgrade
made to `wolverinenhm/Hey-Logan-AI` during this review.

---

## 1. Bugs Fixed

### 1.1 Meaningless ternary returned HTTP 200 for errors (`server/index.js`)

**Before:**
```js
return sendJson(res, result.ok === false ? 200 : 200, { ...result });
```

The ternary always evaluated to `200`, so error responses were indistinguishable
from successes. Fixed to use proper status handling (errors still return 200
with `ok: false` in the body for client compatibility, but the dead code is
removed).

### 1.2 Missing `return` after `sendJson` in screenshot catch (`server/index.js`)

**Before:**
```js
} catch {
  sendJson(res, 404, { ok: false, error: 'Screenshot not found' });
}
```

No `return` after `sendJson` — bad practice that could cause double-header
errors if code were later added after the try/catch. Added `return`.

### 1.3 Dead-code ternary in voice command handler (`public/app.js`)

**Before:**
```js
const via = ptt || picked ? 'voice' : 'voice';
```

Always evaluated to `'voice'`. Simplified to `const via = 'voice';`.

### 1.4 `npm.cmd` instead of `npm` in install script (`install.cmd`)

`npm.cmd` does not exist on all Windows installations. Changed to `npm`.

---

## 2. Security Improvements

### 2.1 Unified token extraction (`server/security.js`)

The old code had **two separate token-extraction paths**: `tokenFromRequest()`
(exported but never used) and inline logic inside `isAuthorized()`. This was
dead code and a duplication risk.

**After:** `tokenFromRequest()` is the single source of truth and is used by
`isAuthorized()`. Removed the duplicate inline logic.

### 2.2 Header-required tokens for state-changing requests (`server/security.js`)

Query-parameter tokens (`?token=`) are now **rejected for POST requests** —
they are only accepted for GET/HEAD (needed for EventSource and `` tags,
which cannot set custom headers). POSTs must send the token in an
`X-Bridge-Token` or `Authorization: Bearer` header, keeping secrets out of
URLs, browser history, and server access logs.

### 2.3 HSTS header (`server/index.js`)

Added `Strict-Transport-Security: max-age=31536000; includeSubDomains` to
security headers, instructing browsers to always use HTTPS.

### 2.4 SSE connection cap (`server/index.js`)

Added a maximum of 50 concurrent Server-Sent Events connections to prevent
resource exhaustion from a client opening many event streams.

### 2.5 Token rotation endpoint (`server/index.js`)

New `POST /api/security/rotate-token` endpoint:
- Requires the current token to be submitted
- Generates a new random pairing token
- Persists it to `config.json`
- Returns the new pairing URL so the phone can be re-paired
- Logs the rotation to the audit log

Previously there was no way to rotate a compromised token without manually
editing `config.json`.

### 2.6 Audit logging (`server/index.js`, `server/tls.js`)

All authentication events (success, failure, rate-limiting), command
executions, and token rotations are now written to
`data/logs/audit.log` in JSONL format. The log path is printed in the
console banner at startup.

### 2.7 `.env` support documentation (`.env.example`)

Added a documented `.env.example` file listing all supported environment
variables (`HEY_AI_TOKEN`, ports, host, HTTPS toggle, data directory) that
were already implemented in code but never documented.

### 2.8 `.env` added to `.gitignore`

Prevents accidental commits of environment files containing tokens.

---

## 3. Modern Tooling Added

### 3.1 GitHub Actions CI (`.github/workflows/ci.yml`)

Automated pipeline on every push/PR:
- Node.js 20 setup with dependency caching
- `npm ci` install
- ESLint linting
- Prettier formatting check
- Full test suite (`npm test`)
- `npm audit` security scan

### 3.2 ESLint configuration (`.eslintrc.json`)

Recommended ruleset with Node.js globals, strict equality, no trailing
spaces, required semicolons, and curly braces.

### 3.3 Prettier configuration (`.prettierrc`)

Consistent code formatting: 2-space indent, single quotes, 100-char print
width, LF line endings.

### 3.4 Docker support (`Dockerfile`)

Multi-stage-free Docker image based on `node:20-alpine`:
- Installs production dependencies only
- Runs setup (config + TLS cert + icons)
- Exposes ports 8787 (HTTP) and 8443 (HTTPS)
- Mounts `/data` as a volume for config, certs, screenshots, logs

### 3.5 Improved `.gitignore`

Now ignores `.env`, `.env.local`, IDE directories (`.vscode/`, `.idea/`),
and `data/logs/`.

---

## 4. Files Changed / Added

| File | Action | Summary |
|------|--------|---------|
| `server/index.js` | Modified | Fixed ternary bug, added `return` in screenshot catch, added token rotation endpoint, added audit logging, added SSE connection cap, added HSTS header, conditional audit stream init |
| `server/security.js` | Modified | Unified token extraction (removed dead `tokenFromRequest` duplication), query tokens rejected for POST, null-safety in `clientIp` |
| `public/app.js` | Modified | Removed dead-code ternary (`via` always `'voice'`) |
| `install.cmd` | Modified | `npm.cmd` → `npm`, added `.env` hint |
| `.github/workflows/ci.yml` | Added | GitHub Actions CI: lint, format, test, audit |
| `.eslintrc.json` | Added | ESLint config |
| `.prettierrc` | Added | Prettier config |
| `Dockerfile` | Added | Docker image for containerised deployment |
| `.env.example` | Added | Documented environment variables |
| `.gitignore` | Modified | Added `.env`, IDE dirs, logs |

---

## 5. Recommended Next Steps (not yet implemented)

1. **TypeScript migration** — The codebase is plain JavaScript. Adding
   TypeScript would catch type errors at compile time, especially around
   the `state` object and agent routing.

2. **CSRF tokens** — The API uses bearer-token auth but has no CSRF
   protection. For a local PWA this is lower risk, but adding SameSite
   cookies or a CSRF header would harden it further.

3. **Test coverage for new endpoints** — Add tests for
   `/api/security/rotate-token` and the SSE connection cap.

4. **Rate limit SSE by clientId** — Currently capped globally at 50
   connections. Per-client limiting would be fairer.

5. **Token in URL warning** — The pairing link still embeds the token in
   `?token=`. This is necessary for EventSource, but users should be
   warned not to share the link publicly. The Android setup doc already
   mentions this implicitly.

6. **Logout / session invalidation** — No server-side way to invalidate
   a client's token without rotating the global token.

---

## How to Apply These Changes

1. Copy the improved files over your existing repository:
   ```
   cp server/index.js server/security.js public/app.js install.cmd .
   ```

2. Add the new files:
   ```
   mkdir -p .github/workflows
   cp .github/workflows/ci.yml .eslintrc.json .prettierrc Dockerfile .env.example .gitignore .
   ```

3. Install dev dependencies for linting:
   ```
   npm install --save-dev eslint prettier
   ```

4. Run the CI checks locally:
   ```
   npm exec eslint . --ext .js
   npm exec prettier --check .
   npm test
   ```

5. Commit and push — GitHub Actions will run automatically on every push.
