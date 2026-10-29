/* ============================================================
   Hey AI Bridge — UI controller
   Talks to the local bridge over REST + Server-Sent Events and
   wires browser speech recognition / TTS to the agent router.
   ============================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const PROTO = window.location.protocol;
  const isMobile = () => window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`heyai.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`heyai.${key}`, JSON.stringify(value));
      } catch {
        /* storage unavailable */
      }
    }
  };

  const LANGS = [
    ['en-US', 'English (US)'],
    ['en-GB', 'English (UK)'],
    ['en-AU', 'English (Australia)'],
    ['en-IN', 'English (India)'],
    ['en-CA', 'English (Canada)'],
    ['en-NZ', 'English (New Zealand)'],
    ['en-ZA', 'English (South Africa)'],
    ['de-DE', 'Deutsch'],
    ['es-ES', 'Español'],
    ['fr-FR', 'Français'],
    ['pt-BR', 'Português (Brasil)'],
    ['hi-IN', 'हिन्दी'],
    ['ja-JP', '日本語']
  ];

  const state = {
    token: '',
    clientId: `c_${Math.random().toString(36).slice(2, 10)}`,
    info: null,
    agents: [],
    genericWake: [],
    engine: null,
    sse: null,
    connected: false,
    wasHandsFree: false,
    cards: new Map(),
    currentSessionId: null,
    lastAgentId: null,
    lastResultAt: 0,
    busy: false,
    pairing: null,
    settings: {
      lang: store.get('lang', 'en-US'),
      tts: store.get('tts', true),
      followUps: store.get('followUps', true),
      rate: store.get('rate', 1.0),
      voiceURI: store.get('voiceURI', '')
    },
    deferredInstall: null
  };

  const el = {};

  /* ---------------- boot ---------------- */

  document.addEventListener('DOMContentLoaded', boot);

  function cacheDom() {
    const ids = [
      'connLabel', 'settingsBtn', 'installBtn', 'orb', 'statusDot', 'statusText', 'sayHint',
      'listenBtn', 'pttBtn', 'micWarning', 'agentStrip', 'agentsHint', 'transcript', 'emptyState',
      'textForm', 'textInput', 'clearBtn', 'settingsDialog', 'closeSettingsBtn', 'serverInput',
      'tokenInput', 'saveTokenBtn', 'pairNote', 'qrImg', 'copyPairBtn', 'pairUrls', 'langSelect',
      'voiceSelect', 'ttsToggle', 'followToggle', 'rateInput', 'rateVal', 'testVoiceBtn',
      'agentStatusList', 'sessionList', 'versionLabel', 'toastStack'
    ];
    for (const id of ids) el[id] = $(id);
  }

  function boot() {
    cacheDom();
    bindEvents();
    checkEnvironment();
    initSettingsControls();
    registerServiceWorker();

    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      state.token = urlToken;
      store.set('token', urlToken);
      params.delete('token');
      const search = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (search ? `?${search}` : '') + window.location.hash);
    } else {
      state.token = store.get('token', '');
    }

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredInstall = event;
      el.installBtn.classList.remove('hidden');
    });

    if (!state.token) {
      showTokenNeeded();
      return;
    }
    connect();
  }

  /* ---------------- environment checks ---------------- */

  function checkEnvironment() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!window.isSecureContext) {
      showMicWarning(
        'Microphone needs HTTPS. Open this app with the <strong>https://</strong> address printed in the server console (accept the certificate warning once), or use a tunnel such as Tailscale or Cloudflare. Typed commands work over http.'
      );
      el.listenBtn.disabled = true;
      el.pttBtn.disabled = true;
      return false;
    }
    if (!SR) {
      showMicWarning('This browser does not support the Web Speech API. Use Chrome or Edge for voice control — typed commands still work.');
      el.listenBtn.disabled = true;
      el.pttBtn.disabled = true;
      return false;
    }
    return true;
  }

  function showMicWarning(html) {
    el.micWarning.innerHTML = html;
    el.micWarning.classList.remove('hidden');
  }

  /* ---------------- networking ---------------- */

  async function api(path, options = {}) {
    const headers = { 'X-Bridge-Token': state.token, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401) {
      const error = new Error('Unauthorized');
      error.status = 401;
      throw error;
    }
    return res;
  }

  async function connect() {
    setStatus('idle', 'Connecting to your PC…');
    el.connLabel.textContent = 'connecting…';
    try {
      const res = await api('/api/session-info');
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const info = await res.json();
      state.info = info;
      state.agents = info.agents || [];
      state.genericWake = info.genericWake || [];
      applyServerSpeechDefaults(info);
      renderAgents();
      renderAgentStatus();
      updateVersion(info);
      initVoice();
      connectSSE();
      setConnection(true);
      loadSessions();
      setStatus('idle', 'Tap the orb or say a wake word');
    } catch (err) {
      if (err.status === 401) {
        showTokenNeeded();
        return;
      }
      el.connLabel.textContent = 'offline — retrying…';
      setStatus('error', `Cannot reach the bridge: ${err.message}`);
      toast('Cannot reach the PC. Is the server still running?', 'error');
      setTimeout(() => {
        if (!state.connected) connect();
      }, 5000);
    }
  }

  function applyServerSpeechDefaults(info) {
    if (!store.get('langSet') && info.speech && info.speech.lang) {
      state.settings.lang = info.speech.lang;
    }
    if (info.speech && info.speech.silenceMs && state.engine) {
      /* engine reads settings at creation; updated on reconnect */
    }
    if (info.ui && typeof info.ui.speakReplies === 'boolean' && !store.get('ttsSet')) {
      state.settings.tts = info.ui.speakReplies;
    }
  }

  function connectSSE() {
    if (state.sse) {
      try {
        state.sse.close();
      } catch {
        /* ignore */
      }
      state.sse = null;
    }
    if (!state.token) return;
    const url = `/api/events?client=${encodeURIComponent(state.clientId)}&token=${encodeURIComponent(state.token)}`;
    const source = new EventSource(url);
    state.sse = source;
    source.onopen = () => setConnection(true);
    source.onerror = () => setConnection(false);
    source.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerEvent(data);
    };
  }

  function setConnection(ok) {
    state.connected = ok;
    if (ok) {
      const ready = state.agents.filter((agent) => agent.enabled).length;
      el.connLabel.textContent = `${state.info?.app?.name || 'Hey AI Bridge'} · ${ready}/${state.agents.length || '?'} agents ready`;
      if (el.orb.dataset.state === 'error') setStatus('idle', 'Ready');
    } else {
      el.connLabel.textContent = 'connection lost — retrying…';
      if (state.busy) {
        clearTimeout(state.reconnectBusyTimer);
        state.reconnectBusyTimer = setTimeout(() => {
          if (state.connected || !state.busy) return;
          state.busy = false;
          setStatus('error', 'Connection lost — the reply may not have arrived.');
          toast('Connection to the bridge was lost while a command was running.', 'error');
        }, 6000);
      }
    }
  }

  function showTokenNeeded() {
    el.connLabel.textContent = 'access token needed';
    setStatus('error', 'Paste the pairing link or token to connect');
    setConnection(false);
    if (el.pairNote) el.pairNote.textContent = 'Open the pairing link from the PC console, or paste the token.';
    openSettings();
  }

  /* ---------------- server events ---------------- */

  function handleServerEvent(msg) {
    switch (msg.type) {
      case 'hello':
        setConnection(true);
        break;
      case 'command:routing':
        onRouting(msg);
        break;
      case 'agent:status':
        onAgentStatus(msg);
        break;
      case 'agent:chunk':
        onAgentChunk(msg);
        break;
      case 'agent:result':
        onAgentResult(msg);
        break;
      default:
        break;
    }
  }

  function onRouting(msg) {
    if (msg.sessionId) state.currentSessionId = msg.sessionId;
    if (msg.agentId) {
      state.lastAgentId = msg.agentId;
      highlightAgent(msg.agentId);
    }
    ensureAgentCard(msg);
    const name = agentName(msg.agentId);
    setStatus('thinking', `${name} is working…`);
  }

  function onAgentStatus(msg) {
    ensureAgentCard(msg);
    if (msg.status === 'thinking') setStatus('thinking', `${agentName(msg.agentId)} is working…`);
  }

  function onAgentChunk(msg) {
    const card = ensureAgentCard(msg);
    const stream = card.querySelector('.msg-stream');
    if (!stream) return;
    stream.classList.remove('hidden');
    const previous = stream.textContent || '';
    if (previous.length < 12000) stream.textContent = previous + msg.chunk;
    stream.scrollTop = stream.scrollHeight;
    setStatus('thinking', `${agentName(msg.agentId)} is working…`);
  }

  function onAgentResult(msg) {
    const card = msg.sessionId ? state.cards.get(msg.sessionId) || createAgentCard(msg) : createAgentCard(msg);
    if (msg.sessionId) state.cards.delete(msg.sessionId);
    finalizeCard(card, msg);

    state.busy = false;
    state.lastResultAt = Date.now();
    if (msg.agentId) state.lastAgentId = msg.agentId;
    if (msg.sessionId) state.currentSessionId = msg.sessionId;

    if (msg.agentId) highlightAgent(msg.agentId);

    if (msg.clientId === state.clientId) {
      speakResult(msg);
    } else {
      window.HeyAIVoice?.chime(msg.ok === false ? 'error' : 'done');
      if (!state.engine || !state.engine.isHandsFree()) setStatus('idle', 'Ready');
    }
  }

  /* ---------------- cards ---------------- */

  function removeEmptyState() {
    if (el.emptyState && el.emptyState.parentNode) el.emptyState.remove();
  }

  function appendCard(card) {
    removeEmptyState();
    el.transcript.appendChild(card);
    trimLog();
    card.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function trimLog() {
    const cards = el.transcript.querySelectorAll('.msg');
    if (cards.length > 80) {
      for (let i = 0; i < cards.length - 80; i += 1) cards[i].remove();
    }
  }

  function addUserMsg(text, options = {}) {
    const card = document.createElement('div');
    card.className = 'msg user';
    const top = document.createElement('div');
    top.className = 'msg-top';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = 'You';
    top.appendChild(who);

    if (options.via) {
      const via = document.createElement('span');
      via.className = 'via';
      via.textContent = options.via;
      top.appendChild(via);
    }
    if (options.followUp) {
      const badge = document.createElement('span');
      badge.className = 'badge follow';
      badge.textContent = 'follow-up';
      top.appendChild(badge);
    }
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date());
    top.appendChild(time);

    const body = document.createElement('p');
    body.className = 'msg-text';
    body.textContent = text;

    card.appendChild(top);
    card.appendChild(body);
    appendCard(card);
    return card;
  }

  function createAgentCard(msg) {
    const agent = agentById(msg.agentId);
    const color = agent ? agent.color : '#8b97ad';
    const card = document.createElement('div');
    card.className = 'msg agent pending';
    card.style.setProperty('--agent-color', color);
    if (msg.sessionId) card.dataset.session = msg.sessionId;

    const top = document.createElement('div');
    top.className = 'msg-top';

    const avatar = document.createElement('span');
    avatar.className = 'msg-avatar';
    avatar.textContent = agent ? agent.icon : '•';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = agent ? agent.name : msg.agentId || 'Agent';

    top.appendChild(avatar);
    top.appendChild(who);

    const badge = document.createElement('span');
    badge.className = 'badge';
    if (msg.generic) {
      badge.classList.add('wake');
      badge.textContent = 'which agent?';
      card.classList.add('generic');
    } else if (msg.routing?.matched) {
      badge.classList.add('wake');
      badge.textContent = 'wake word';
    } else if (msg.routing?.reusedSession || msg.reusedSession) {
      badge.classList.add('follow');
      badge.textContent = 'follow-up';
    } else if (msg.picked) {
      badge.textContent = 'direct';
    }
    if (badge.textContent) top.appendChild(badge);

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date());
    top.appendChild(time);

    const textEl = document.createElement('p');
    textEl.className = 'msg-text';
    textEl.textContent = msg.generic || msg.needsTask ? '' : 'Working…';

    const stream = document.createElement('pre');
    stream.className = 'msg-stream hidden';

    const details = document.createElement('details');
    details.className = 'msg-details hidden';
    const summary = document.createElement('summary');
    summary.textContent = 'Full output';
    const full = document.createElement('pre');
    full.className = 'msg-full';
    details.appendChild(summary);
    details.appendChild(full);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    card.appendChild(top);
    card.appendChild(textEl);
    card.appendChild(stream);
    card.appendChild(details);
    card.appendChild(meta);
    appendCard(card);

    if (msg.sessionId) state.cards.set(msg.sessionId, card);
    return card;
  }

  function ensureAgentCard(msg) {
    if (msg.sessionId && state.cards.has(msg.sessionId)) return state.cards.get(msg.sessionId);
    return createAgentCard(msg);
  }

  function finalizeCard(card, msg) {
    card.classList.remove('pending');
    if (!msg.ok) card.classList.add('error');

    const textEl = card.querySelector('.msg-text');
    const speech = String(msg.speech || '').trim();
    const fullText = String(msg.text || '').trim();
    const shown = speech || summarize(fullText) || (msg.ok ? 'Done.' : 'That command failed.');
    if (textEl) textEl.textContent = shown;

    const stream = card.querySelector('.msg-stream');
    if (stream && stream.textContent) stream.classList.add('hidden');

    const details = card.querySelector('.msg-details');
    const fullPre = card.querySelector('.msg-full');
    const worthDetails = fullText && fullText !== shown && (fullText.length > shown.length + 60 || fullText.includes('\n'));
    if (details && fullPre && worthDetails) {
      fullPre.textContent = fullText;
      details.classList.remove('hidden');
    }

    if (msg.screenshot) {
      const img = document.createElement('img');
      img.className = 'msg-shot';
      img.alt = 'Screenshot from your PC';
      img.src = `${msg.screenshot}${msg.screenshot.includes('?') ? '&' : '?'}token=${encodeURIComponent(state.token)}`;
      card.appendChild(img);
    }

    const meta = card.querySelector('.msg-meta');
    if (meta) {
      meta.textContent = '';
      addMeta(meta, formatDuration(msg.durationMs));
      if (msg.invocation && msg.invocation.via) addMeta(meta, msg.invocation.via);
      if (msg.exitCode !== null && msg.exitCode !== undefined) addMeta(meta, `exit ${msg.exitCode}`);
      if (msg.timedOut) addMeta(meta, 'timed out');
      if (msg.missing) addMeta(meta, 'not installed');
    }

    const badges = card.querySelector('.msg-top');
    if (msg.missing) addBadge(badges, 'not installed', 'missing');
    else if (!msg.ok) addBadge(badges, 'failed', 'fail');

    if (!msg.ok) window.HeyAIVoice?.chime('error');
  }

  function addMeta(container, text) {
    if (!text) return;
    const span = document.createElement('span');
    span.textContent = text;
    container.appendChild(span);
  }

  function addBadge(container, text, kind) {
    if (!container) return;
    if ([...container.querySelectorAll('.badge')].some((badge) => badge.textContent === text)) return;
    const badge = document.createElement('span');
    badge.className = `badge ${kind || ''}`.trim();
    badge.textContent = text;
    const time = container.querySelector('.msg-time');
    if (time) container.insertBefore(badge, time);
    else container.appendChild(badge);
  }

  /* ---------------- speaking replies ---------------- */

  function markReplyFinished() {
    // The follow-up window starts after the reply has been spoken, not when
    // the result arrived — otherwise long replies eat the whole window.
    state.lastResultAt = Date.now();
    if (!state.engine || !state.engine.isHandsFree()) setStatus('idle', 'Ready');
  }

  function speakResult(msg) {
    if (!state.engine) {
      window.HeyAIVoice?.chime(msg.ok === false ? 'error' : 'done');
      markReplyFinished();
      return;
    }
    if (!state.settings.tts) {
      window.HeyAIVoice?.chime(msg.ok === false ? 'error' : 'done');
      markReplyFinished();
      return;
    }
    const agent = agentById(msg.agentId);
    const speech = String(msg.speech || '').trim() || summarize(String(msg.text || '')) || (msg.ok ? 'Done.' : 'That command failed.');
    const settings = voiceSettingsFor(agent);
    state.engine.speak(speech, {
      ...settings,
      onend: markReplyFinished
    });
  }

  function voiceSettingsFor(agent) {
    const baseRate = agent && agent.voice && agent.voice.rate ? agent.voice.rate : 1;
    const basePitch = agent && agent.voice && agent.voice.pitch ? agent.voice.pitch : 1;
    return {
      lang: state.settings.lang,
      voiceURI: state.settings.voiceURI,
      rate: Math.min(1.6, Math.max(0.6, baseRate * state.settings.rate)),
      pitch: basePitch
    };
  }

  /* ---------------- voice engine ---------------- */

  function initVoice() {
    if (state.engine) return;
    if (!window.createVoiceEngine) {
      disableVoiceButtons();
      return;
    }
    const speechCfg = state.info?.speech || {};
    state.engine = window.createVoiceEngine({
      lang: state.settings.lang,
      agents: state.agents,
      genericWake: state.genericWake,
      silenceMs: speechCfg.silenceMs || 1500,
      wakeWindowMs: speechCfg.wakeWindowMs || 12000,
      onStateChange: handleVoiceState,
      onWake: handleWake,
      onCommand: handleVoiceCommand,
      onPartial: handlePartial,
      onUtterance: handleUtterance,
      onInfo: (message) => toast(message, 'info'),
      onError: (message) => {
        toast(message, 'error');
        setStatus('error', message);
      },
      onVoicesChanged: () => populateVoices()
    });
    if (!state.engine.supported) {
      disableVoiceButtons();
      showMicWarning('This browser does not support speech recognition. Use Chrome or Edge for voice control — typed commands still work.');
      return;
    }
    enableVoiceButtons();
  }

  function enableVoiceButtons() {
    if (!window.isSecureContext) return;
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return;
    el.listenBtn.disabled = false;
    el.pttBtn.disabled = false;
    if (!el.listenBtn.textContent || el.listenBtn.textContent === 'Voice unavailable') {
      el.listenBtn.textContent = 'Start listening';
    }
  }

  function disableVoiceButtons() {
    el.listenBtn.disabled = true;
    el.pttBtn.disabled = true;
    el.listenBtn.textContent = 'Voice unavailable';
  }

  function handleVoiceState({ state: voiceState, detail }) {
    if (!state.engine) return;
    if (voiceState === 'listening') {
      const handsFree = state.engine.isHandsFree();
      el.orb.dataset.state = 'listening';
      el.statusDot.className = 'dot state-listening';
      el.listenBtn.textContent = handsFree ? 'Stop listening' : 'Start listening';
      el.listenBtn.classList.toggle('primary', !handsFree);
      el.listenBtn.classList.toggle('secondary', handsFree);
      if (!detail || !detail.ptt) el.statusText.textContent = handsFree ? 'Listening for wake words…' : 'Ready';
    } else if (voiceState === 'awake') {
      el.orb.dataset.state = 'awake';
      el.statusDot.className = 'dot state-awake';
      if (!detail || !detail.agentId) el.statusText.textContent = 'Listening for your command…';
    } else if (voiceState === 'thinking') {
      el.orb.dataset.state = 'thinking';
      el.statusDot.className = 'dot state-thinking';
      if (!el.statusText.textContent.includes('working')) el.statusText.textContent = 'Working…';
    } else if (voiceState === 'speaking') {
      el.orb.dataset.state = 'speaking';
      el.statusDot.className = 'dot state-speaking';
      el.statusText.textContent = 'Speaking…';
    } else if (voiceState === 'error') {
      el.orb.dataset.state = 'error';
      el.statusDot.className = 'dot state-error';
      if (detail && detail.message) el.statusText.textContent = detail.message;
    } else if (voiceState === 'idle') {
      el.orb.dataset.state = 'idle';
      el.statusDot.className = 'dot';
      el.listenBtn.textContent = 'Start listening';
      el.listenBtn.classList.add('primary');
      el.listenBtn.classList.remove('secondary');
      if (!state.busy && !el.statusText.textContent.startsWith('Hearing')) el.statusText.textContent = 'Tap the orb or say a wake word';
    }
  }

  function handleWake({ agentId, agent, generic, remainder }) {
    window.HeyAIVoice?.chime('wake');
    if (generic) {
      setStatus('awake', 'Which agent?');
      if (state.settings.tts && state.engine) {
        state.engine.speak('Which agent? Say hey computer, hey claude code, hey codex, hey deepseek, hey workbuddy, or hey gemini.', {
          onend: () => {
            if (state.engine) state.engine.beginCapture(null);
          }
        });
      } else if (state.engine) {
        state.engine.beginCapture(null);
      }
      return;
    }

    if (agentId) highlightAgent(agentId);
    setStatus('awake', `${agent ? agent.name : 'Agent'} is listening…`);

    const ack = agent && agent.ack ? agent.ack : 'Here.';
    const spoken = String(remainder || '').trim();

    if (spoken) {
      // Wake word and command spoken in one breath: answer, then run it.
      if (state.settings.tts && state.engine) {
        state.engine.speak(ack, voiceSettingsFor(agent));
      }
      sendCommand(spoken, {
        via: 'voice',
        agentId: agentId || undefined,
        agentName: agent ? agent.name : undefined
      });
      return;
    }

    // Two-step flow: acknowledge, then capture the command that follows.
    if (state.settings.tts && state.engine) {
      state.engine.speak(ack, {
        ...voiceSettingsFor(agent),
        onend: () => {
          if (state.engine) state.engine.beginCapture(agentId);
        }
      });
    } else if (state.engine) {
      state.engine.beginCapture(agentId);
    }
  }

  function handleVoiceCommand({ text, agentId, ptt, picked }) {
    const via = ptt || picked ? 'voice' : 'voice';
    const agent = agentId ? agentById(agentId) : null;
    sendCommand(text, {
      via,
      agentId: agentId || undefined,
      agentName: agent ? agent.name : undefined
    });
  }

  function handlePartial(text) {
    if (!state.engine) return;
    const mode = state.engine.getMode();
    if (mode === 'capture' || mode === 'once' || mode === 'ptt') {
      setStatus('awake', `“${text}”`);
    } else {
      setStatus('listening', `Hearing: “${text}”`);
    }
  }

  function handleUtterance(text) {
    const heard = String(text || '').trim();
    if (!heard || !state.settings.followUps) return;
    if (state.busy) return;
    if (!state.lastResultAt || Date.now() - state.lastResultAt > 20000) return;
    const words = heard.split(/\s+/);
    if (words.length < 2) return;
    if (/^(thanks|thank you|okay|ok|nice|cool|goodbye|bye)$/i.test(heard)) return;
    sendCommand(heard, {
      via: 'voice',
      followUp: true,
      sessionId: state.currentSessionId,
      agentId: state.lastAgentId || undefined
    });
  }

  /* ---------------- sending commands ---------------- */

  async function sendCommand(text, options = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    addUserMsg(trimmed, {
      via: options.via || 'text',
      followUp: options.followUp,
      agentName: options.agentName
    });
    state.busy = true;
    setStatus('thinking', 'Sending to your PC…');

    const body = {
      text: trimmed,
      clientId: state.clientId,
      source: isMobile() ? 'phone' : 'pc'
    };
    if (options.sessionId) body.sessionId = options.sessionId;
    if (options.agentId) body.agentId = options.agentId;

    try {
      const res = await api('/api/command', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        state.busy = false;
        const message = data.error || `Command failed (${res.status})`;
        toast(message, 'error');
        setStatus('error', message);
      }
    } catch (err) {
      state.busy = false;
      if (err.status === 401) {
        showTokenNeeded();
      } else {
        toast(`Network error: ${err.message}`, 'error');
        setStatus('error', 'Connection problem');
      }
    }
  }

  /* ---------------- agents UI ---------------- */

  function agentById(id) {
    return state.agents.find((agent) => agent.id === id) || null;
  }

  function agentName(id) {
    const agent = agentById(id);
    return agent ? agent.name : 'Agent';
  }

  function renderAgents() {
    el.agentStrip.innerHTML = '';
    for (const agent of state.agents) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `agent-chip${agent.enabled ? '' : ' disabled'}`;
      button.dataset.agent = agent.id;
      button.style.setProperty('--agent-color', agent.color || '#22d3ee');
      button.title = agent.wake && agent.wake.length ? `Say “${agent.wake[0]} …” or tap to talk` : agent.name;

      const avatar = document.createElement('span');
      avatar.className = 'agent-avatar';
      avatar.textContent = agent.icon || '•';

      const meta = document.createElement('span');
      meta.className = 'agent-meta';
      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = agent.name;
      const sub = document.createElement('span');
      sub.className = 'agent-sub';
      sub.textContent = agent.wake && agent.wake[0] ? agent.wake[0] : agent.kind;
      meta.appendChild(name);
      meta.appendChild(sub);

      button.appendChild(avatar);
      button.appendChild(meta);
      button.addEventListener('click', () => onAgentChip(agent));
      el.agentStrip.appendChild(button);
    }
  }

  function onAgentChip(agent) {
    window.HeyAIVoice?.chime('wake');
    if (!agent.enabled) {
      toast(agent.install ? `${agent.name} is not installed. ${agent.install}` : `${agent.name} is not available on this PC.`, 'info');
    }
    highlightAgent(agent.id);
    if (state.engine && state.engine.supported && window.isSecureContext) {
      setStatus('awake', `Listening for ${agent.name}…`);
      state.engine.captureOnce(agent.id);
    } else {
      const prefix = `Hey ${agent.name}, `;
      el.textInput.value = el.textInput.value || prefix;
      el.textInput.focus();
      toast('Voice is unavailable here — type your command instead.', 'info');
    }
  }

  function highlightAgent(agentId) {
    const chips = el.agentStrip.querySelectorAll('.agent-chip');
    chips.forEach((chip) => chip.classList.toggle('active', chip.dataset.agent === agentId));
    clearTimeout(highlightAgent.timer);
    highlightAgent.timer = setTimeout(() => {
      chips.forEach((chip) => chip.classList.remove('active'));
    }, 7000);
  }

  function renderAgentStatus() {
    if (!el.agentStatusList) return;
    el.agentStatusList.innerHTML = '';
    for (const agent of state.agents) {
      const row = document.createElement('div');
      row.className = 'agent-status-row';
      row.style.setProperty('--agent-color', agent.color || '#22d3ee');

      const avatar = document.createElement('span');
      avatar.className = 'agent-avatar';
      avatar.textContent = agent.icon || '•';

      const info = document.createElement('div');
      info.className = 'agent-status-info';
      const name = document.createElement('div');
      name.className = 'agent-status-name';
      name.textContent = agent.name;
      const command = document.createElement('div');
      command.className = 'agent-status-cmd';
      command.textContent = agent.kind === 'computer' ? 'built-in' : agent.executable || agent.expectedCommand || agent.id;
      if (!agent.enabled && agent.install) command.title = agent.install;
      info.appendChild(name);
      info.appendChild(command);

      const pill = document.createElement('span');
      pill.className = `status-pill ${agent.enabled ? 'ready' : 'missing'}`;
      pill.textContent = agent.enabled ? 'ready' : 'not installed';

      row.appendChild(avatar);
      row.appendChild(info);
      row.appendChild(pill);
      el.agentStatusList.appendChild(row);
    }
  }

  /* ---------------- settings UI ---------------- */

  function initSettingsControls() {
    if (el.langSelect) {
      el.langSelect.innerHTML = '';
      for (const [code, label] of LANGS) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = `${label} (${code})`;
        el.langSelect.appendChild(option);
      }
      el.langSelect.value = state.settings.lang;
    }
    if (el.ttsToggle) el.ttsToggle.checked = state.settings.tts;
    if (el.followToggle) el.followToggle.checked = state.settings.followUps;
    if (el.rateInput) el.rateInput.value = state.settings.rate;
    if (el.rateVal) el.rateVal.textContent = `${Number(state.settings.rate).toFixed(2)}×`;
    if (el.serverInput) el.serverInput.value = `${PROTO}//${window.location.host}`;
    if (el.tokenInput) el.tokenInput.value = state.token || '';
    if (el.versionLabel && state.info) el.versionLabel.textContent = `v${state.info.app.version}`;
    populateVoices();
  }

  function populateVoices() {
    if (!el.voiceSelect) return;
    const voices = state.engine ? state.engine.getVoices() : window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    const base = String(state.settings.lang || 'en').split('-')[0].toLowerCase();
    const filtered = voices.filter((voice) => String(voice.lang || '').toLowerCase().startsWith(base));
    const candidates = filtered.length ? filtered : voices;

    const previous = el.voiceSelect.value;
    el.voiceSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Automatic';
    el.voiceSelect.appendChild(auto);

    for (const voice of candidates) {
      const option = document.createElement('option');
      option.value = voice.voiceURI || voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      el.voiceSelect.appendChild(option);
    }
    const wanted = state.settings.voiceURI || previous || '';
    if ([...el.voiceSelect.options].some((option) => option.value === wanted)) {
      el.voiceSelect.value = wanted;
    }
    if (state.engine && state.settings.voiceURI) state.engine.setVoice(state.settings.voiceURI);
  }

  function bindEvents() {
    if (el.settingsBtn) el.settingsBtn.addEventListener('click', openSettings);
    if (el.closeSettingsBtn) {
      el.closeSettingsBtn.addEventListener('click', () => {
        if (el.settingsDialog.open) el.settingsDialog.close();
      });
    }
    if (el.installBtn) {
      el.installBtn.addEventListener('click', async () => {
        if (!state.deferredInstall) return;
        state.deferredInstall.prompt();
        try {
          await state.deferredInstall.userChoice;
        } catch {
          /* ignore */
        }
        state.deferredInstall = null;
        el.installBtn.classList.add('hidden');
      });
    }

    if (el.listenBtn) el.listenBtn.addEventListener('click', toggleListening);
    if (el.orb) el.orb.addEventListener('click', toggleListening);

    if (el.pttBtn) {
      el.pttBtn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (!state.engine || !state.engine.supported) return;
        state.pttPointer = true;
        state.pttStartedAt = Date.now();
        setStatus('awake', 'Listening… release when done');
        state.engine.pttStart();
      });
      const end = (event) => {
        if (event) event.preventDefault();
        if (!state.pttPointer) return;
        state.pttPointer = false;
        if (state.engine) state.engine.pttStop();
      };
      el.pttBtn.addEventListener('pointerup', end);
      el.pttBtn.addEventListener('pointercancel', end);
      el.pttBtn.addEventListener('pointerleave', (event) => {
        if (state.pttPointer && event.buttons === 0) end(event);
      });
      el.pttBtn.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    if (el.textForm) {
      el.textForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = el.textInput.value.trim();
        if (!value) return;
        el.textInput.value = '';
        sendCommand(value, { via: 'text' });
      });
    }

    if (el.clearBtn) el.clearBtn.addEventListener('click', clearLog);

    if (el.saveTokenBtn) {
      el.saveTokenBtn.addEventListener('click', () => {
        const token = el.tokenInput.value.trim();
        if (!token) {
          toast('Paste the access token first.', 'error');
          return;
        }
        state.token = token;
        store.set('token', token);
        if (el.settingsDialog.open) el.settingsDialog.close();
        connect();
      });
    }

    if (el.langSelect) {
      el.langSelect.addEventListener('change', () => {
        state.settings.lang = el.langSelect.value;
        store.set('langSet', true);
        store.set('lang', state.settings.lang);
        if (state.engine) state.engine.setLang(state.settings.lang);
        populateVoices();
        api('/api/settings', { method: 'POST', body: JSON.stringify({ 'speech.lang': state.settings.lang }) }).catch(() => {});
      });
    }

    if (el.voiceSelect) {
      el.voiceSelect.addEventListener('change', () => {
        state.settings.voiceURI = el.voiceSelect.value;
        store.set('voiceURI', state.settings.voiceURI);
        if (state.engine) state.engine.setVoice(state.settings.voiceURI);
      });
    }

    if (el.ttsToggle) {
      el.ttsToggle.addEventListener('change', () => {
        state.settings.tts = el.ttsToggle.checked;
        store.set('tts', state.settings.tts);
        store.set('ttsSet', true);
      });
    }

    if (el.followToggle) {
      el.followToggle.addEventListener('change', () => {
        state.settings.followUps = el.followToggle.checked;
        store.set('followUps', state.settings.followUps);
      });
    }

    if (el.rateInput) {
      el.rateInput.addEventListener('input', () => {
        state.settings.rate = Number(el.rateInput.value);
        el.rateVal.textContent = `${state.settings.rate.toFixed(2)}×`;
        store.set('rate', state.settings.rate);
      });
    }

    if (el.testVoiceBtn) {
      el.testVoiceBtn.addEventListener('click', () => {
        if (!state.engine) {
          toast('Speech synthesis is unavailable in this browser.', 'error');
          return;
        }
        state.engine.speak('Hi, this is your Hey AI bridge. Wake me by saying, hey computer.', {
          ...voiceSettingsFor(null)
        });
      });
    }

    if (el.copyPairBtn) {
      el.copyPairBtn.addEventListener('click', async () => {
        const link = state.pairing && state.pairing.pairingUrl;
        if (!link) {
          toast('Pairing link not loaded yet.', 'error');
          return;
        }
        try {
          await navigator.clipboard.writeText(link);
          toast('Pairing link copied.', 'info');
        } catch {
          fallbackCopy(link);
        }
      });
    }

    if (el.settingsDialog) {
      el.settingsDialog.addEventListener('close', () => {
        if (el.settingsDialog.returnValue === 'reconnect') connect();
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (!state.engine) return;
      if (document.hidden) {
        state.wasHandsFree = state.engine.isHandsFree();
        if (state.wasHandsFree) state.engine.pause();
      } else if (state.wasHandsFree) {
        state.engine.resume();
      }
    });
  }

  function fallbackCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('Pairing link copied.', 'info');
    } catch {
      toast('Could not copy automatically. Select the link manually.', 'error');
    }
  }

  function toggleListening() {
    if (!state.engine || !state.engine.supported || !window.isSecureContext) {
      toast('Voice input is unavailable. Type your command instead.', 'info');
      el.textInput.focus();
      return;
    }
    if (state.engine.isHandsFree()) {
      state.engine.stopHandsFree();
      setStatus('idle', 'Listening stopped');
      toast('Stopped listening. Tap again to resume.', 'info');
    } else {
      state.engine.startHandsFree();
      setStatus('listening', 'Listening for wake words…');
    }
  }

  function openSettings() {
    initSettingsControls();
    renderAgentStatus();
    loadPairing();
    loadSessions();
    if (el.settingsDialog && !el.settingsDialog.open) {
      if (typeof el.settingsDialog.showModal === 'function') el.settingsDialog.showModal();
      else el.settingsDialog.setAttribute('open', '');
    }
  }

  /* ---------------- pairing + sessions ---------------- */

  async function loadPairing() {
    if (el.pairNote && !state.token) el.pairNote.textContent = 'No token yet.';
    try {
      const res = await api('/api/pairing');
      if (!res.ok) return;
      const data = await res.json();
      state.pairing = data;
      if (data.qrSvg && el.qrImg) {
        el.qrImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.qrSvg)}`;
        el.qrImg.classList.remove('hidden');
      }
      if (el.pairUrls) {
        el.pairUrls.innerHTML = '';
        const urls = [...(data.urls?.lan || []), ...(data.urls?.local || [])];
        for (const url of urls) {
          const code = document.createElement('code');
          code.textContent = url;
          el.pairUrls.appendChild(code);
        }
      }
      if (el.pairNote) el.pairNote.textContent = 'Scan the QR code or share the link.';
    } catch {
      if (el.pairNote) el.pairNote.textContent = 'Connect first to load the pairing link.';
    }
  }

  async function loadSessions() {
    if (!el.sessionList) return;
    try {
      const res = await api('/api/sessions');
      if (!res.ok) return;
      const data = await res.json();
      const sessions = data.sessions || [];
      el.sessionList.innerHTML = '';
      if (!sessions.length) {
        const p = document.createElement('p');
        p.className = 'muted small';
        p.textContent = 'No sessions yet.';
        el.sessionList.appendChild(p);
        return;
      }
      for (const session of sessions.slice(0, 12)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'session-row';
        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = `${session.title || '(no title)'} — ${agentName(session.agentId)}`;
        const at = document.createElement('span');
        at.className = 'session-at';
        at.textContent = formatWhen(session.updatedAt);
        button.appendChild(title);
        button.appendChild(at);
        button.addEventListener('click', () => loadSession(session.id));
        el.sessionList.appendChild(button);
      }
    } catch {
      /* ignore */
    }
  }

  async function loadSession(id) {
    try {
      const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const data = await res.json();
      const session = data.session;
      if (!session) return;
      clearLog();
      for (const message of session.messages || []) {
        if (message.role === 'user') {
          addUserMsg(message.text || '', { via: message.source === 'pc' ? 'text' : 'voice' });
        } else if (message.role === 'agent') {
          const card = createAgentCard({ sessionId: null, agentId: message.agentId });
          const msg = {
            ok: message.ok !== false,
            speech: message.speech,
            text: message.text,
            durationMs: message.durationMs,
            agentId: message.agentId,
            sessionId: null
          };
          finalizeCard(card, msg);
        }
      }
      if (el.settingsDialog.open) el.settingsDialog.close();
      el.transcript.scrollIntoView({ block: 'end', behavior: 'smooth' });
    } catch {
      /* ignore */
    }
  }

  /* ---------------- status + log helpers ---------------- */

  function setStatus(kind, text) {
    const orbStates = ['listening', 'awake', 'thinking', 'speaking', 'error'];
    if (el.orb) el.orb.dataset.state = orbStates.includes(kind) ? kind : 'idle';
    if (el.statusDot) el.statusDot.className = `dot${kind && kind !== 'idle' ? ` state-${kind === 'offline' ? 'error' : kind}` : ''}`;
    if (el.statusText && text) el.statusText.textContent = text;
  }

  function clearLog() {
    state.cards.clear();
    el.transcript.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.id = 'emptyState';
    empty.innerHTML = '<p class="empty-big">Nothing yet.</p><p class="muted">Try: <em>“Hey Computer, find my Word documents in Downloads.”</em></p>';
    el.transcript.appendChild(empty);
    el.emptyState = empty;
  }

  function toast(message, kind = 'info') {
    if (!el.toastStack) return;
    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = message;
    if (kind === 'error') item.style.borderColor = 'rgba(248, 113, 113, 0.5)';
    el.toastStack.appendChild(item);
    setTimeout(() => item.remove(), 4600);
  }

  /* ---------------- small formatting utils ---------------- */

  function summarize(text) {
    const clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*_>`|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return '';
    const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
    let result = sentences.slice(0, 2).join(' ');
    if (!result) result = clean;
    if (result.length > 360) result = `${result.slice(0, 359)}…`;
    return result;
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '';
    const value = Number(ms);
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
  }

  function formatTime(date) {
    try {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function formatWhen(iso) {
    try {
      const date = new Date(iso);
      const diff = Date.now() - date.getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function updateVersion(info) {
    if (el.versionLabel) el.versionLabel.textContent = `v${info.app.version}`;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
