/* ============================================================
   Hey AI Bridge — voice engine
   Wake-word detection + command capture + TTS + push-to-talk.
   Uses the browser's Web Speech API (Chrome / Edge / Android Chrome).
   ============================================================ */

(function () {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SYNTH = window.speechSynthesis || null;

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasPhrase(haystack, phrase) {
    if (!phrase) return false;
    return ` ${haystack} `.includes(` ${phrase} `);
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Remove the matched wake phrase from the original transcript. */
  function removeWakePhrase(text, phraseNorm) {
    const words = String(phraseNorm || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(escapeRegExp);
    if (!words.length) return String(text || '');
    const re = new RegExp(`(?:^|[^a-z0-9'])(?:${words.join("[^a-z0-9']+")})(?=[^a-z0-9']|$)`, 'i');
    return String(text || '').replace(re, ' ');
  }

  function cleanRemainder(text) {
    return String(text || '')
      .replace(/^[\s,.;:!?\u2013\u2014-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Pick the best wake phrase match for a normalized transcript. */
  function matchWakeWith(norm, agents, genericWake) {
    const matches = [];
    for (const agent of agents || []) {
      if (!agent) continue;
      for (const phrase of agent.wake || []) {
        const p = normalize(phrase);
        if (p && hasPhrase(norm, p)) {
          matches.push({ agentId: agent.id, agent, phrase: p, strong: true, len: p.length });
        }
      }
      for (const phrase of agent.weak || []) {
        const p = normalize(phrase);
        if (p && (norm === p || norm.startsWith(`${p} `))) {
          matches.push({ agentId: agent.id, agent, phrase: p, strong: false, len: p.length });
        }
      }
    }
    for (const phrase of genericWake || []) {
      const p = normalize(phrase);
      if (p && hasPhrase(norm, p)) {
        matches.push({ agentId: null, agent: null, phrase: p, strong: true, len: p.length, generic: true });
      }
    }
    matches.sort((a, b) => Number(b.strong) - Number(a.strong) || b.len - a.len);
    return matches[0] || null;
  }

  /**
   * Pure helper used by tests and by the engine: what would this transcript do?
   * `remainder` carries a command spoken in the same breath as the wake word
   * (e.g. "hey computer find my budget file" -> "find my budget file").
   */
  function simulateWake(transcript, agents, genericWake) {
    const norm = normalize(transcript);
    const match = matchWakeWith(norm, agents, genericWake);
    if (!match) return null;
    const remainder = match.generic ? '' : cleanRemainder(removeWakePhrase(transcript, match.phrase));
    return {
      agentId: match.agentId,
      agent: match.agent,
      phrase: match.phrase,
      generic: Boolean(match.generic),
      transcript: norm,
      remainder
    };
  }

  function createVoiceEngine(options = {}) {
    const opts = {
      lang: options.lang || 'en-US',
      agents: options.agents || [],
      genericWake: options.genericWake || [],
      silenceMs: options.silenceMs || 1500,
      wakeWindowMs: options.wakeWindowMs || 12000,
      onStateChange: options.onStateChange || (() => {}),
      onWake: options.onWake || (() => {}),
      onCommand: options.onCommand || (() => {}),
      onPartial: options.onPartial || (() => {}),
      onUtterance: options.onUtterance || (() => {}),
      onInfo: options.onInfo || (() => {}),
      onError: options.onError || (() => {})
    };

    const engine = {
      lang: opts.lang,
      agents: opts.agents,
      genericWake: opts.genericWake,
      supported: Boolean(SR),
      handsFree: false,
      mode: 'idle', // idle | wake | capture | once | ptt
      speaking: false,
      listening: false,
      paused: false
    };

    let rec = null;
    let wakeBuffer = '';
    let captureBuffer = '';
    let captureAgentId = null;
    let silenceTimer = null;
    let wakeTimer = null;
    let wakeSilenceTimer = null;
    let restartTimer = null;
    let backoffMs = 400;
    let lastResultAt = 0;
    let ignoreUntil = 0;
    let onceRec = null;
    let onceText = '';
    let onceAgentId = null;
    let onceTimer = null;
    let onceSilenceTimer = null;
    let pttRec = null;
    let pttText = '';
    let pttInterim = '';
    let pttStopping = false;

    let voices = [];
    let selectedVoiceURI = '';

    /* ---------------- voices + TTS ---------------- */

    function loadVoices() {
      try {
        const list = SYNTH ? SYNTH.getVoices() || [] : [];
        if (list.length) {
          voices = list;
          if (typeof options.onVoicesChanged === 'function') options.onVoicesChanged(voices);
        }
      } catch {
        /* ignore */
      }
    }

    if (SYNTH) {
      loadVoices();
      try {
        SYNTH.onvoiceschanged = loadVoices;
      } catch {
        /* ignore */
      }
    }

    function pickVoice(lang) {
      if (!voices.length) return null;
      if (selectedVoiceURI) {
        const chosen = voices.find((v) => v.voiceURI === selectedVoiceURI);
        if (chosen) return chosen;
      }
      const base = String(lang || 'en-US').split('-')[0].toLowerCase();
      const langLower = String(lang || 'en-US').toLowerCase();
      const exact = voices.find((v) => String(v.lang || '').toLowerCase() === langLower);
      if (exact) return exact;
      const sameBase = voices.filter((v) => String(v.lang || '').toLowerCase().startsWith(base));
      const preferred = sameBase.find((v) => /female|natural|google|zira|aria|samantha|ava/i.test(v.name || ''));
      return preferred || sameBase[0] || voices[0] || null;
    }

    function setVoice(voiceURI) {
      selectedVoiceURI = String(voiceURI || '');
    }

    function pauseForSpeech() {
      if (engine.speaking) return;
      engine.speaking = true;
      clearTimers();
      try {
        if (rec) rec.abort();
      } catch {
        /* ignore */
      }
      try {
        if (onceRec) onceRec.abort();
      } catch {
        /* ignore */
      }
      try {
        if (pttRec) pttRec.abort();
      } catch {
        /* ignore */
      }
      onceRec = null;
      pttRec = null;
      pttStopping = false;
      if (engine.mode === 'once' || engine.mode === 'ptt') engine.mode = 'idle';
    }

    function resumeAfterSpeech() {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        engine.speaking = false;
        if (engine.paused) return;
        if (engine.handsFree) {
          startRecognition();
          emitState('listening');
        } else {
          emitState('idle');
        }
      }, 260);
    }

    function speak(text, settings = {}) {
      const content = String(text || '').trim();
      if (!content) {
        if (settings.onend) settings.onend();
        return;
      }
      if (!SYNTH) {
        emitState('idle');
        if (settings.onend) settings.onend();
        return;
      }

      pauseForSpeech();
      try {
        SYNTH.cancel();
      } catch {
        /* ignore */
      }

      const utterance = new SpeechSynthesisUtterance(content.slice(0, 1200));
      utterance.lang = settings.lang || engine.lang;
      const voice = settings.voiceURI ? voices.find((v) => v.voiceURI === settings.voiceURI) : pickVoice(utterance.lang);
      if (voice) utterance.voice = voice;
      utterance.rate = Math.min(1.6, Math.max(0.6, settings.rate || 1));
      utterance.pitch = Math.min(1.6, Math.max(0.6, settings.pitch || 1));

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        engine.speaking = false;
        if (settings.onend) settings.onend();
        resumeAfterSpeech();
      };

      utterance.onend = finish;
      utterance.onerror = finish;
      emitState('speaking', { text: content });

      try {
        SYNTH.speak(utterance);
      } catch {
        finish();
      }
    }

    /* ---------------- wake matching ---------------- */

    function matchWake(norm) {
      return matchWakeWith(norm, engine.agents, engine.genericWake);
    }

    /* ---------------- state helpers ---------------- */

    let lastEmitted = '';

    function emitState(state, detail = {}) {
      const payload = { state, detail, handsFree: engine.handsFree, mode: engine.mode };
      if (state !== lastEmitted || Object.keys(detail).length) {
        lastEmitted = state;
        opts.onStateChange(payload);
      }
    }

    function clearTimers() {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
      if (wakeSilenceTimer) {
        clearTimeout(wakeSilenceTimer);
        wakeSilenceTimer = null;
      }
    }

    function scheduleRestart(delay) {
      if (restartTimer) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (engine.paused || !engine.handsFree) return;
        if (engine.speaking) return;
        startRecognition();
      }, delay);
    }

    /* ---------------- recognition (hands-free) ---------------- */

    function startRecognition() {
      if (!SR) return;
      stopRecognition();
      let recognition;
      try {
        recognition = new SR();
      } catch {
        opts.onError('Could not start speech recognition.');
        return;
      }
      rec = recognition;
      recognition.lang = engine.lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        engine.listening = true;
        backoffMs = 400;
        if (engine.mode === 'capture') emitState('awake', { capturing: true });
        else emitState('listening');
      };

      recognition.onresult = (event) => {
        lastResultAt = Date.now();
        let interim = '';
        const finals = [];
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result) continue;
          const transcript = result[0] ? result[0].transcript : '';
          if (result.isFinal) finals.push(transcript.trim());
          else interim += ` ${transcript}`;
        }
        if (interim.trim()) opts.onPartial(interim.trim());
        for (const finalText of finals) {
          if (finalText) handleFinal(finalText);
        }
      };

      recognition.onerror = (event) => {
        const error = event.error;
        if (error === 'no-speech' || error === 'aborted') return;
        if (error === 'not-allowed' || error === 'service-not-allowed') {
          engine.handsFree = false;
          engine.listening = false;
          emitState('error', { message: 'Microphone blocked' });
          opts.onError('Microphone access is blocked. Allow microphone permission for this site in your browser settings, then start listening again.');
          return;
        }
        if (error === 'audio-capture') {
          engine.handsFree = false;
          engine.listening = false;
          emitState('error', { message: 'No microphone' });
          opts.onError('No microphone was found on this device.');
          return;
        }
        if (error === 'network') {
          backoffMs = Math.min(10000, backoffMs * 2);
          scheduleRestart(backoffMs);
          return;
        }
        opts.onError(`Speech recognition error: ${error}`);
      };

      recognition.onend = () => {
        engine.listening = false;
        if (engine.paused || engine.speaking) return;
        if (!engine.handsFree) {
          emitState('idle');
          return;
        }
        backoffMs = Math.min(3000, backoffMs + 150);
        scheduleRestart(backoffMs);
      };

      try {
        recognition.start();
      } catch {
        scheduleRestart(800);
      }
    }

    function stopRecognition() {
      if (!rec) return;
      const old = rec;
      rec = null;
      try {
        old.onend = null;
        old.onresult = null;
        old.onerror = null;
        old.abort();
      } catch {
        /* ignore */
      }
    }

    function handleFinal(finalText) {
      if (engine.mode === 'capture') {
        captureBuffer = `${captureBuffer} ${finalText}`.trim();
        opts.onPartial(captureBuffer);
        armCaptureSilence();
        return;
      }
      if (engine.mode === 'once' || engine.mode === 'ptt') return;

      // wake mode: ignore the tail of a command already dispatched in one breath
      if (Date.now() < ignoreUntil) return;

      wakeBuffer = `${wakeBuffer} ${finalText}`.trim();
      const words = wakeBuffer.split(' ');
      if (words.length > 50) wakeBuffer = words.slice(-50).join(' ');
      const heard = wakeBuffer;
      const norm = normalize(heard);
      const match = matchWake(norm);
      if (match) {
        wakeBuffer = '';
        const remainder = match.generic ? '' : cleanRemainder(removeWakePhrase(heard, match.phrase));
        if (remainder) ignoreUntil = Date.now() + 2500;
        armWakeSilence();
        opts.onWake({
          agentId: match.agentId,
          agent: match.agent,
          phrase: match.phrase,
          generic: Boolean(match.generic),
          transcript: norm,
          remainder
        });
        return;
      }
      armWakeSilence();
    }

    /* ---------------- wake-mode silence -> utterance ---------------- */

    function armWakeSilence() {
      if (wakeSilenceTimer) clearTimeout(wakeSilenceTimer);
      if (engine.mode !== 'wake' || engine.mode === 'capture') return;
      wakeSilenceTimer = setTimeout(() => {
        wakeSilenceTimer = null;
        if (engine.mode !== 'wake') return;
        if (!wakeBuffer) return;
        const heard = wakeBuffer;
        wakeBuffer = '';
        opts.onUtterance(heard);
      }, 1400);
    }

    function clearUtteranceBuffer() {
      wakeBuffer = '';
    }

    /* ---------------- capture (after wake) ---------------- */

    function beginCapture(agentId) {
      captureAgentId = agentId || null;
      captureBuffer = '';
      engine.mode = 'capture';
      engine.paused = false;
      clearTimers();
      emitState('awake', { capturing: true, agentId: captureAgentId });
      if (!engine.handsFree) return;
      if (engine.speaking) {
        engine.speaking = false;
      }
      if (!rec) {
        startRecognition();
      } else if (!engine.listening) {
        startRecognition();
      }
      startCaptureTimers();
    }

    function startCaptureTimers() {
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        if (engine.mode !== 'capture') return;
        if (!captureBuffer.trim()) {
          cancelCapture('I didn’t hear a command.');
        } else {
          finishCapture();
        }
      }, opts.wakeWindowMs);
      armCaptureSilence();
    }

    function armCaptureSilence() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (engine.mode !== 'capture') return;
        if (captureBuffer.trim()) finishCapture();
      }, opts.silenceMs);
    }

    function finishCapture() {
      if (engine.mode !== 'capture') return;
      const text = captureBuffer.trim();
      const agentId = captureAgentId;
      clearTimers();
      engine.mode = 'wake';
      captureBuffer = '';
      captureAgentId = null;
      emitState('thinking');
      if (text) {
        opts.onCommand({ text, agentId, ptt: false });
      } else {
        opts.onInfo('I didn’t catch that.');
        if (engine.handsFree) emitState('listening');
      }
    }

    function cancelCapture(reason) {
      if (engine.mode !== 'capture') return;
      clearTimers();
      engine.mode = 'wake';
      captureBuffer = '';
      captureAgentId = null;
      if (reason) opts.onInfo(reason);
      if (engine.handsFree) emitState('listening');
    }

    /* ---------------- push to talk ---------------- */

    function pttStart() {
      if (!SR || engine.mode === 'ptt') return;
      if (engine.mode === 'capture') cancelCapture('');
      if (engine.mode === 'once') stopOnce();
      engine.paused = false;
      engine.mode = 'ptt';
      pauseForSpeechAbortOnly();
      pttText = '';
      pttInterim = '';
      pttStopping = false;

      let recognition;
      try {
        recognition = new SR();
      } catch {
        return;
      }
      pttRec = recognition;
      recognition.lang = engine.lang;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result) continue;
          const transcript = result[0] ? result[0].transcript : '';
          if (result.isFinal) pttText = `${pttText} ${transcript}`.trim();
          else pttInterim = `${pttInterim} ${transcript}`.trim();
        }
        opts.onPartial(`${pttText} ${pttInterim}`.trim());
      };
      recognition.onerror = (event) => {
        if (event.error === 'not-allowed') {
          opts.onError('Microphone access is blocked.');
        }
      };
      recognition.onend = () => {
        if (pttStopping || engine.mode === 'ptt') finishPtt();
      };

      try {
        recognition.start();
        emitState('listening', { ptt: true });
      } catch {
        engine.mode = 'idle';
      }
    }

    function finishPtt() {
      const text = `${pttText} ${pttInterim}`.trim();
      pttStopping = false;
      const hadText = Boolean(text);
      stopPttRec();
      if (engine.mode === 'ptt') engine.mode = 'wake';
      pttText = '';
      pttInterim = '';
      if (hadText) {
        opts.onCommand({ text, agentId: null, ptt: true });
      } else {
        opts.onInfo('Nothing was captured.');
      }
      if (engine.handsFree) startRecognition();
    }

    function pttStop() {
      if (engine.mode !== 'ptt') return;
      pttStopping = true;
      try {
        if (pttRec) pttRec.stop();
        else finishPtt();
      } catch {
        finishPtt();
      }
    }

    function stopPttRec() {
      if (!pttRec) return;
      const old = pttRec;
      pttRec = null;
      try {
        old.onend = null;
        old.onresult = null;
        old.onerror = null;
        old.abort();
      } catch {
        /* ignore */
      }
    }

    function pauseForSpeechAbortOnly() {
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        rec = null;
      }
      clearTimers();
    }

    /* ---------------- one-shot capture for an agent chip ---------------- */

    function captureOnce(agentId) {
      if (!SR) return;
      if (engine.mode === 'ptt') return;
      if (engine.mode === 'once') stopOnce();
      if (engine.mode === 'capture') cancelCapture('');
      pauseForSpeechAbortOnly();
      engine.mode = 'once';
      onceAgentId = agentId || null;
      onceText = '';

      let recognition;
      try {
        recognition = new SR();
      } catch {
        engine.mode = 'idle';
        return;
      }
      onceRec = recognition;
      recognition.lang = engine.lang;
      recognition.continuous = true;
      recognition.interimResults = true;

      const arm = () => {
        if (onceSilenceTimer) clearTimeout(onceSilenceTimer);
        onceSilenceTimer = setTimeout(() => stopOnce(), opts.silenceMs);
      };

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result) continue;
          const transcript = result[0] ? result[0].transcript : '';
          if (result.isFinal) onceText = `${onceText} ${transcript}`.trim();
          else interim += ` ${transcript}`;
        }
        opts.onPartial(`${onceText} ${interim}`.trim());
        arm();
      };
      recognition.onerror = (event) => {
        if (event.error === 'not-allowed') opts.onError('Microphone access is blocked.');
      };
      recognition.onend = () => {
        if (engine.mode === 'once') stopOnce();
      };

      try {
        recognition.start();
        emitState('awake', { once: true, agentId: onceAgentId });
      } catch {
        engine.mode = 'idle';
        return;
      }

      if (onceTimer) clearTimeout(onceTimer);
      onceTimer = setTimeout(() => {
        onceTimer = null;
        if (engine.mode === 'once' && !onceText.trim()) {
          opts.onInfo('I didn’t hear anything.');
          stopOnce();
        }
      }, Math.max(8000, opts.wakeWindowMs));
      arm();
    }

    function stopOnce() {
      if (engine.mode !== 'once' && !onceRec) return;
      const text = onceText.trim();
      const agentId = onceAgentId;
      if (onceSilenceTimer) {
        clearTimeout(onceSilenceTimer);
        onceSilenceTimer = null;
      }
      if (onceTimer) {
        clearTimeout(onceTimer);
        onceTimer = null;
      }
      engine.mode = 'idle';
      onceText = '';
      onceAgentId = null;
      if (onceRec) {
        const old = onceRec;
        onceRec = null;
        try {
          old.onend = null;
          old.onresult = null;
          old.onerror = null;
          old.abort();
        } catch {
          /* ignore */
        }
      }
      if (text) {
        opts.onCommand({ text, agentId, ptt: false, picked: true });
      } else if (engine.handsFree) {
        startRecognition();
        emitState('listening');
      }
    }

    /* ---------------- public control ---------------- */

    function startHandsFree() {
      if (!SR) {
        opts.onError('This browser does not support speech recognition. Use Chrome or Edge.');
        return;
      }
      engine.handsFree = true;
      engine.paused = false;
      engine.mode = 'wake';
      wakeBuffer = '';
      clearTimers();
      startRecognition();
    }

    function stopHandsFree() {
      engine.handsFree = false;
      engine.mode = 'idle';
      engine.paused = true;
      clearTimers();
      wakeBuffer = '';
      captureBuffer = '';
      stopRecognition();
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      emitState('idle');
    }

    function pause() {
      engine.paused = true;
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        rec = null;
      }
      clearTimers();
    }

    function resume() {
      engine.paused = false;
      if (engine.handsFree && !engine.speaking) startRecognition();
    }

    function setLang(lang) {
      engine.lang = keepLang(lang);
      if (rec) {
        const wasHandsFree = engine.handsFree;
        stopRecognition();
        if (wasHandsFree && !engine.paused) startRecognition();
      }
    }

    function keepLang(lang) {
      return String(lang || 'en-US');
    }

    function setAgents(agents, genericWake) {
      engine.agents = agents || [];
      engine.genericWake = genericWake || [];
    }

    const api = {
      supported: engine.supported,
      isHandsFree: () => engine.handsFree,
      isSpeaking: () => engine.speaking,
      getMode: () => engine.mode,
      getLang: () => engine.lang,
      getState: () => ({ handsFree: engine.handsFree, mode: engine.mode, listening: engine.listening, speaking: engine.speaking, lastResultAt }),
      startHandsFree,
      stopHandsFree,
      beginCapture,
      cancelCapture,
      pause,
      resume,
      speak,
      chime: chime,
      setLang,
      setAgents,
      setVoice,
      captureOnce,
      pttStart,
      pttStop,
      clearUtteranceBuffer,
      getVoices: () => voices,
      refreshVoices: loadVoices
    };

    return api;
  }

  /* ---------------- chime ---------------- */

  function chime(kind) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const notes = kind === 'error' ? [392, 262] : kind === 'done' ? [784, 523] : [659, 988];
      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = now + index * 0.085;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.24);
      });
      setTimeout(() => {
        try {
          ctx.close();
        } catch {
          /* ignore */
        }
      }, 800);
    } catch {
      /* audio not available */
    }
  }

  window.createVoiceEngine = createVoiceEngine;
  window.HeyAIVoice = {
    chime,
    supported: Boolean(SR),
    _test: { normalize, hasPhrase, removeWakePhrase, cleanRemainder, matchWakeWith, simulateWake }
  };
})();
