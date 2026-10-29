# Hey AI Bridge

**Talk to your PC and your AI agents from anywhere in your home — including from your Android phone.**

Say **“Hey Claude Code, open a new session and find my budget Word document in Downloads”** and the assistant answers, runs the task on your computer, and speaks the result back to you.

```
  ┌───────────────────────────────┐          ┌──────────────────────────────────┐
  │  Android phone / PC browser   │  HTTPS   │  Your PC — Node.js server        │
  │  Hey AI Bridge PWA            │ ───────▶ │  • wake-word routing             │
  │  • wake words, speech-to-text │  + SSE   │  • token auth + rate limiting    │
  │  • spoken replies (TTS)       │ ◀─────── │  • Computer agent (files, apps)  │
  │  • command history            │          │  • CLI adapters: Claude Code,    │
  └───────────────────────────────┘          │    Codex, DeepSeek, Workbuddy,   │
                                             │    Gemini                        │
                                             └──────────────────────────────────┘
```

No cloud backend, no account, no subscription. The bridge runs on your machine, on your local network, behind a private access token.

---

## Contents

- [What it does](#what-it-does)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start (Windows)](#quick-start-windows)
- [Pair your Android phone](#pair-your-android-phone)
- [Using it](#using-it)
- [Wake words](#wake-words)
- [Connect your AI agents](#connect-your-ai-agents)
- [Configuration](#configuration)
- [Using it away from home](#using-it-away-from-home)
- [Security & privacy](#security--privacy)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Development & tests](#development--tests)
- [Roadmap](#roadmap)
- [License](#license)

---

## What it does

Hey AI Bridge is a **voice command center for your computer and your AI agents**.

1. You open the app on your phone (or a browser tab on the PC) and tap **Start listening**.
2. You say a **wake phrase** — `Hey Computer`, `Hey Claude Code`, `Hey Codex`, `Hey DeepSeek`, `Hey Workbuddy`, `Hey Gemini` (or `Hey AI` if you don’t care which one).
3. The assistant **answers you** (“Claude Code here.”), then listens for your command.
4. The command is routed to the agent you named:
   - the **Computer agent** can search your files, open folders and apps, take a screenshot, lock the screen, and report PC stats;
   - the **CLI agents** (Claude Code, Codex, DeepSeek Harness via `dsh headless`, Workbuddy, Gemini) run their CLI non-interactively with your spoken prompt and stream their output back.
5. The result is shown on screen **and spoken back to you** using your device’s text-to-speech voice.

Example from real life:

> **“Hey Computer, start looking for me the budget Word document at the Downloads folder.”**
> → *“Found 2 matches. The best match is budget-2026.docx, in Downloads.”*

> **“Hey Claude Code, please open a new session and start looking for the tax return PDF in Downloads. Then summarise what you find.”**
> → routes to Claude Code CLI with the task *(requires Claude Code installed)*.

---

## Features

| Feature | Details |
|---|---|
| 🎙 Wake-word voice control | “Hey Claude Code”, “Hey Computer”, “Hey Codex”, “Hey DeepSeek”, “Hey Workbuddy”, “Hey Gemini”, generic “Hey AI” |
| 🗣 Spoken replies | Browser TTS with per-agent voice pitch/rate; acknowledgement when you call, result summary when done |
| 💬 Conversation follow-ups | After a reply, you can say “open it” for 20 s without repeating the wake word (optional) |
| 🖥 Computer agent | Find files by name/type/folder, open files & folders, launch apps, list folders, screenshot, lock screen, PC stats |
| 🤖 AI CLI adapters | Claude Code, OpenAI Codex, DeepSeek Harness (`dsh headless`), Workbuddy (configurable), Gemini CLI |
| 📱 Installable PWA | Add to Android home screen; full-screen, offline app shell, QR pairing |
| 🔔 Real-time streaming | CLI output streams line-by-line over Server-Sent Events |
| 🕘 Sessions | Every request is grouped into a session with history; browse recent sessions in Settings |
| 🔒 Private by design | Runs only on your machine/LAN; access token required; HTTPS self-signed cert; rate limiting; CSP |
| ⌨️ Text fallback | Everything also works by typing a command (useful when voice isn’t available) |
| 🎛 Configurable | Ports, wake windows, languages, agent commands/args/working directories, search limits |

---

## Requirements

- **Windows 10/11** on the PC that runs the bridge (the built-in Computer agent is Windows-focused; file search also works on macOS/Linux, but screenshot/lock/stats are Windows-only).
- **Node.js 20 or newer** — https://nodejs.org (the install script checks the version).
- **A phone and the PC on the same Wi-Fi network** (for the phone to reach the PC).
- **Chrome or Edge** on the devices you want to use voice with.
  Firefox and Safari do not support the Web Speech API used for wake words.
- Optional: the AI CLIs you want to control (Claude Code, Codex, Gemini, and/or the `dsh` CLI that ships with DeepSeek Harness). Workbuddy needs its CLI command configured.

> The phone must use **HTTPS** for microphone access. This project generates a local self-signed certificate automatically — see [Pair your Android phone](#pair-your-android-phone).

---

## Quick start (Windows)

1. **Install Node.js 20+** if you haven’t already: https://nodejs.org.
2. Double-click **`install.cmd`**.
   It installs dependencies, creates `data/config.json`, generates the HTTPS certificate and PWA icons.
3. Double-click **`start.cmd`**.
   Keep the console window open — it prints your URLs, access token, pairing QR code and agent status:
   ```
   Desktop (this PC):
     https://localhost:8443
     http://localhost:8787
   Phone (same Wi-Fi):
     https://192.168.x.x:8443
   Access token:  XXXX-XXXX-XXXX
   Pairing link:  https://192.168.x.x:8443?token=XXXX-XXXX-XXXX
   ```
4. On the PC, open **https://localhost:8443** (or http://localhost:8787) and click **Start listening** to test on the PC microphone.
5. On your phone, scan the **QR code** in the console (or in the app’s Settings → Pair your phone) — see the next section.

> First Windows Firewall prompt: allow **Node.js** on **Private networks** (not Public) so your phone can reach the bridge.

PowerShell alternative:

```powershell
cd C:\Users\YOU\Downloads\hey-ai-bridge
npm install
node scripts/setup.js
npm start
```

---

## Pair your Android phone

1. Install **Chrome** on the phone and connect it to the **same Wi-Fi** as the PC.
2. Scan the QR code printed in the PC console (Settings → Pair your phone also shows it).
3. Chrome will warn about the certificate: choose **Advanced → Proceed to `<ip>`**.
   This is expected: the certificate is created locally for your home network.
4. Tap **Start listening**, allow **Microphone** access when Chrome asks.
5. Optional: Chrome menu → **Add to Home screen** (or the app’s **Install** button) to run it full-screen like a native app.

**If Chrome refuses microphone access on the self-signed page**, you have two clean options:

- Use a tunnel with a real certificate (recommended for day-to-day use away from your desk):
  - **Tailscale** (private mesh VPN): install Tailscale on PC and phone, then use the PC’s Tailscale IP with `https` via [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve), or simply keep the app local and use Tailscale to reach it securely.
  - **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8787` gives you an `https://…trycloudflare.com` URL with a valid certificate.
- Or install the self-signed certificate as a trusted CA on the phone:
  Android Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
  (Certificate file: `data/certs/cert.pem`.)

---

## Using it

### Voice

- Tap **Start listening** once. The orb pulses while it listens for wake words.
- Say a wake phrase, wait for the short acknowledgement, then speak your command.
- You can also speak **wake word + command in one breath** — *“Hey Computer, find my tax PDF in Downloads”* — and the task starts immediately while the acknowledgement is spoken.
- The bridge shows what it heard and shows/streams the agent’s answer; the reply is spoken on the device you spoke into.
- Say **“Stop listening”** (tap the orb again) to pause. Tap **Hold to talk** to speak a one-off command without a wake word.

### Typing

Type any command in the bottom bar. You can include or omit the wake word; without one, the default agent (`ui.defaultAgent`, default `computer`) handles it. Prepend an agent name (e.g. `Hey Codex, …`) to route it.

### Agent chips

Tap an agent card to talk directly to it — no wake word needed. Its answer appears and is spoken back.

### Follow-ups

If enabled (Settings → Voice), after a reply you have **20 seconds** to say a follow-up like *“open it”* or *“now summarise that”* without repeating the wake word. The follow-up stays in the same session, so the Computer agent remembers the last search results.

### Sessions panel

Settings → Recent sessions lists the last conversations on the PC (in memory). Tap one to load it into the conversation view.

---

## Wake words

| Agent | Wake phrases you can say | Weak form |
|---|---|---|
| **Computer** | “Hey Computer”, “Hey PC”, “Hey Laptop”, “Hey Machine”, “Hey this computer” | “Computer …” / “PC …” at the start of a command |
| **Claude Code** | “Hey Claude Code”, “Hey Claude”, “Hey Claud”, “Hey cloud code” | “Claude Code …” / “Claude …” |
| **Codex** | “Hey Codex”, “Hey Code X”, “Hey Codecs” | “Codex …” |
| **DeepSeek Harness** | “Hey DeepSeek”, “Hey Deep Seek”, “Hey DSH”, “Hey DeepSeek Harness” | “DeepSeek …” / “DSH …” |
| **Workbuddy** | “Hey Workbuddy”, “Hey Work Buddy”, “Hey Work Body” | “Workbuddy …” |
| **Gemini** | “Hey Gemini”, “Hey Gem Mini”, “Hey Geminy” | “Gemini …” |
| **Any agent** | “Hey AI”, “Hey Assistant”, “Hey Agents”, “Hey Anybody”, “Hey Bridge” → asks which agent | — |

Phrases are matched fuzzily against punctuated/capitalised speech, anywhere in the utterance. Say the **bare agent name at the start** of the command to skip “hey” (e.g. “Claude, open the repo”).

You can edit wake phrases in `server/agents/defs.js` (restart the server afterwards).

---

## Connect your AI agents

The bridge auto-detects each CLI on `PATH`. “Ready” agents appear in the console banner and in Settings → Agents; “not installed” agents politely explain how to install themselves when called.

### Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
claude login   # (or set ANTHROPIC_API_KEY)
```

The bridge runs `claude -p "<your prompt>"`.

### OpenAI Codex

```powershell
npm install -g @openai/codex
codex login
```

The bridge runs `codex exec "<your prompt>"`.

### DeepSeek Harness

Already installed if **DeepSeek Harness (dsh)** is installed. The bridge runs:

```
dsh headless "<your prompt>"
```

If `dsh` is not on `PATH`, set `agents.deepseek.command` in `data/config.json` to the full path of `dsh.cmd`.

### Google Gemini CLI

```powershell
npm install -g @google/gemini-cli
gemini login
```

The bridge runs `gemini -p "<your prompt>"`.

### Workbuddy

Workbuddy has no universal CLI contract, so it is **configured, not assumed**. In `data/config.json`:

```json
"agents": {
  "workbuddy": {
    "enabled": "auto",
    "command": "C:\\Path\\To\\workbuddy.exe",
    "args": ["--prompt", "{prompt}"],
    "timeoutMs": 300000
  }
}
```

- `command` may be a name on `PATH` or an absolute path.
- `args` is an argv template; `{prompt}` is replaced with your spoken task. If the template has no `{prompt}`, the prompt is appended as the last argument.
- `enabled`: `"auto"` (only when found), `true`, or `false`.

Restart the server after editing the config.

> **How the prompt is passed:** `.exe` CLIs are spawned directly with a real argv array (no shell quoting issues). For npm `.cmd` shims, the bridge runs the underlying Node script when it can find it; otherwise it falls back to PowerShell with single-quoted arguments. Output is streamed back line by line.

---

## Configuration

The live config lives at **`data/config.json`** (created on first run; keep it out of git — see `.gitignore`). `config.example.json` in the repo documents the defaults.

```jsonc
{
  "server": {
    "host": "0.0.0.0",          // listen on the LAN; use 127.0.0.1 to restrict to this PC
    "httpPort": 8787,
    "httpsPort": 8443,
    "enableHttp": true,
    "enableHttps": true          // HTTPS is required for phone microphones
  },
  "security": {
    "token": "AUTO-GENERATED",   // access token; also printed at startup
    "rateLimit": { "windowMs": 300000, "max": 12, "banMs": 600000 }
  },
  "speech": {
    "lang": "en-US",             // recognition language default (UI can override)
    "wakeWindowMs": 12000,       // how long to wait for a command after a wake word
    "silenceMs": 1500            // pause that ends the command
  },
  "ui": {
    "defaultAgent": "computer",  // used when no wake word is spoken
    "speakReplies": true
  },
  "agents": {
    "computer": { "enabled": true },
    "claude-code": { "enabled": "auto", "command": "claude", "args": ["-p", "{prompt}"], "timeoutMs": 300000, "cwd": "" },
    "codex": { "enabled": "auto", "command": "codex", "args": ["exec", "{prompt}"], "timeoutMs": 300000, "cwd": "" },
    "deepseek": { "enabled": "auto", "command": "dsh", "args": ["headless", "{prompt}"], "timeoutMs": 900000, "cwd": "" },
    "workbuddy": { "enabled": "auto", "command": "workbuddy", "args": ["--prompt", "{prompt}"], "timeoutMs": 300000, "cwd": "" },
    "gemini": { "enabled": "auto", "command": "gemini", "args": ["-p", "{prompt}"], "timeoutMs": 300000, "cwd": "" }
  },
  "computer": {
    "searchRoots": ["downloads", "documents", "desktop"],
    "folderMap": {},              // e.g. { "downloads": "D:\\Downloads" }
    "maxDepth": 7,
    "maxFiles": 25000,
    "maxResults": 8,
    "searchTimeoutMs": 8000,
    "allowAbsolutePaths": false,  // allow "find X in C:\some\dir"
    "screenshotDir": "screenshots"
  }
}
```

**Environment overrides:** `HEY_AI_TOKEN`, `HEY_AI_HTTP_PORT`, `HEY_AI_HTTPS_PORT`, `HEY_AI_HOST`, `HEY_AI_NO_HTTPS=1`, `HEY_AI_DATA_DIR`.

**Computer agent capabilities** (spoken examples):

| Say | Action |
|---|---|
| “find my tax return PDF in Downloads” | Recursive search (name + type), ranked results |
| “find the budget Word document in Documents and open it” | Search then open the best match |
| “list my Downloads folder” / “show Downloads” | Folder listing |
| “open Downloads” / “open Notepad” / “launch Chrome” | Open folder or launch a known app |
| “take a screenshot” | Saves a PNG and shows it in the app |
| “lock the screen” | Locks Windows |
| “how is my PC doing?” | CPU, memory, uptime, disk |
| “what time is it?” | Current date/time |

Known apps include Notepad, Calculator, Chrome, Edge, Explorer, Settings, Paint, CMD, PowerShell, Windows Terminal, VS Code, Word/Excel/PowerPoint, Outlook, Spotify, Steam, Task Manager, Control Panel, Snipping Tool.

Supported folder words: Downloads, Documents, Desktop, Pictures (photos/images), Music, Videos, home user folder. `folderMap` lets you point any of them elsewhere (e.g. a second drive).

---

## Using it away from home

The app is built for your home LAN. To use it from outside your network:

- **Tailscale (recommended):** install it on the PC and phone. You get a private, encrypted network between your devices. The bridge stays off the public internet.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:8787` exposes a valid HTTPS URL without opening ports. Note that the tunnel URL is public — your access token is the only protection, so use a long random one.
- **Port forwarding / DDNS:** possible but not recommended. If you do it, use `HEY_AI_TOKEN=<long random token>`, keep HTTPS on, and never expose the HTTP port.

---

## Security & privacy

- **Local only by default.** The server binds to your LAN; it has no cloud component. Commands never leave your network except whatever the invoked AI CLI sends to its own provider (that’s exactly what running that CLI normally does).
- **Access token.** Every API call and SSE connection requires the token, compared in constant time. Failed attempts are rate-limited per IP (12 failures / 5 min → 10 min ban).
- **HTTPS** with a locally generated self-signed certificate (SHA-256, 10-year validity, includes your LAN IPs and hostname). The private key stays in `data/certs/` (mode 600 on POSIX).
- **Hardening:** CSP (`default-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, no-referrer, path-traversal-safe static serving, screenshot filename allowlist, settings whitelist.
- **Voice privacy:** recognition uses the browser’s Web Speech API. Chrome/Edge may send audio to the browser vendor’s speech service to transcribe it. The bridge itself only receives the resulting transcript. Typed commands never leave your machine except to the AI CLI you invoke.
- **`data/` is gitignored**, so your token, certificate, config and screenshot files are never committed.
- **Microphone and TTS** are per-device: the phone speaks into the phone, the PC browser speaks into the PC speakers. Only the client that sent the command hears the spoken reply.

> Treat the token like a password. Anyone with the pairing link and network access can operate your PC through this app.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| “Microphone needs HTTPS” banner | Open the `https://` URL (accept the cert warning) or use a tunnel. HTTP is only for typed commands. |
| Chrome says “Microphone access is blocked” | Allow microphone permission for the site; self-signed page may need the cert accepted again after Chrome updates. |
| Phone can’t connect | Same Wi-Fi? Windows Firewall allowed Node.js on **Private** networks? Guest Wi-Fi may isolate clients. Check the phone URL uses the PC’s current LAN IP (`ipconfig`). |
| Certificate warning on the phone | Expected for self-signed certs: Advanced → Proceed. Use a tunnel for a warning-free experience. |
| Wake word not triggering | Say the phrase clearly; check Settings → recognition language; ensure the orb is pulsing; close other apps using the mic; wake phrases are English. |
| Agent says “couldn’t find `<CLI>`” | Install the CLI, reopen the console (`start.cmd`) so `PATH` refreshes, or set an absolute command path in `data/config.json`. |
| CLI prints nothing / exits with code | Run the same CLI manually in a terminal to confirm it works and is authenticated. Adjust `args`/`timeoutMs` in the config. |
| No spoken reply | Settings → “Speak replies on this device”; device volume; try “Test voice”; the browser needs installed TTS voices. |
| Reply speaks over your next command | TTS pauses recognition automatically; wait for “Speaking…” to finish (or disable TTS). |
| Port already in use | Change `server.httpPort` / `server.httpsPort` in `data/config.json` and restart. |
| Phone URL stopped working after PC reboot | The PC’s LAN IP may have changed — rescan the QR code from the new startup banner. |
| Screenshots fail | Screenshots need an interactive Windows session and `powershell.exe`; they are blocked in restricted/sandboxed environments. |
| `spawn EPERM` errors | Only expected inside heavily sandboxed agent environments; on a normal Windows install the bridge can launch CLIs and PowerShell. |

---

## Project structure

```
hey-ai-bridge/
├── server/
│   ├── index.js            # HTTP(S) server, REST API, SSE hub, command orchestration
│   ├── config.js           # defaults, config load/save, env overrides
│   ├── security.js         # token auth, constant-time compare, rate limiter
│   ├── events.js           # Server-Sent Events hub
│   ├── sessions.js         # in-memory sessions + follow-up context
│   ├── router.js           # wake phrase -> agent + task parsing
│   ├── tls.js              # self-signed certificate generation
│   ├── exec.js             # child process helpers (capture + detached)
│   └── agents/
│       ├── defs.js         # agent catalog: wake phrases, colours, CLI defaults
│       ├── registry.js     # availability detection for the UI
│       ├── cli.js          # Claude Code / Codex / DSH / Workbuddy / Gemini adapters
│       └── computer.js     # built-in Computer agent (files, apps, lock, screenshot)
├── public/
│   ├── index.html          # PWA shell
│   ├── app.js              # UI controller, SSE, sessions, settings
│   ├── voice.js            # wake-word engine, capture, push-to-talk, TTS
│   ├── style.css
│   ├── sw.js               # service worker (app shell cache)
│   ├── manifest.webmanifest
│   └── icon*.png / icon.svg
├── scripts/
│   ├── setup.js            # one-time setup
│   └── make-icons.js       # generates PNG icons (no image libraries)
├── docs/
│   └── ANDROID-SETUP.md    # step-by-step phone pairing guide
├── test/                   # unit + integration tests (node:test)
├── data/                   # runtime: config, certs, screenshots (gitignored)
├── config.example.json
├── install.cmd / start.cmd # Windows launchers
└── README.md
```

---

## Development & tests

```powershell
npm test              # runs every suite in one process
npm run test:isolated # node --test, one process per file (also fine on a normal machine)
npm start             # start the server
npm run dev           # restart on file changes
```

The tests cover: wake-word routing (including the “open a new session” phrasing), the Computer agent’s intent parser and file search, config merging/env overrides, token auth + rate limiting, static path traversal protection, the REST API, and the SSE event flow for asynchronous commands.

**Adding an agent:** add an entry to `server/agents/defs.js` (id, name, icon, colour, wake phrases, CLI defaults) and a matching `agents.<id>` block in `config.example.json`. The registry, UI and router pick it up automatically.

---

## Roadmap

- [ ] Native Android APK (Capacitor wrapper around the same PWA)
- [ ] Local wake-word engine (openWakeWord/Porcupine) so wake words work without the browser
- [ ] Local speech-to-text (Whisper) as an alternative to the browser’s speech service
- [ ] Persistent session history (SQLite/JSON) and conversation memory for CLI agents
- [ ] Multi-step task chaining (“find it, then email it to me”)
- [ ] Wake-word training for custom agent names
- [ ] macOS/Linux parity for the Computer agent (screenshot, lock, stats)

---

## License

MIT — see [LICENSE](LICENSE).

Built for your own machine. Use the token, tunnel and firewall choices that match your comfort level.
