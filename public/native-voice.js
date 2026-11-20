/* ============================================================
   Hey Logan AI - native speech bridge (page side)

   Android System WebView does not implement the Web Speech API. The Windows /
   browser version of this app simply uses the browser API. The Android app
   injects a Java object `window.HeyNativeVoice` (SpeechRecognizer +
   TextToSpeech) before the page loads; this script detects it and recreates
   the exact slice of the Web Speech API that app/voice.js consumes:

     - SpeechRecognition / webkitSpeechRecognition: start(), stop(), abort(),
       lang, continuous, interimResults, maxAlternatives,
       onstart / onresult / onerror / onend,
       event.resultIndex and event.results[i].isFinal / [0].transcript
     - speechSynthesis + SpeechSynthesisUtterance only when the WebView has no
       speech synthesis of its own.

   In a normal browser (no bridge) this file does nothing at all.
   ============================================================ */

(function () {
  'use strict';

  var bridge = window.HeyNativeVoice;
  if (!bridge ||
      typeof bridge.sttAvailable !== 'function' ||
      typeof bridge.startListening !== 'function' ||
      typeof bridge.stopListening !== 'function' ||
      typeof bridge.speak !== 'function' ||
      typeof bridge.stopSpeaking !== 'function') {
    return; // Browser / PWA: keep the real Web Speech API untouched.
  }

  if (window.__heyNativeVoice) {
    return; // Already installed (page reloaded inside the same WebView).
  }

  function report(error) {
    try {
      if (window.console && typeof window.console.error === 'function') {
        window.console.error('[HeyNativeVoice]', error);
      }
    } catch (ignored) {
      /* logging must never break voice */
    }
  }

  var live = [];
  var nativeState = 'idle';
  var pendingStop = null;

  function liveIndex(instance) {
    for (var i = 0; i < live.length; i += 1) {
      if (live[i] === instance) return i;
    }
    return -1;
  }

  function addLive(instance) {
    if (liveIndex(instance) < 0) live.push(instance);
  }

  function removeLive(instance) {
    var index = liveIndex(instance);
    if (index >= 0) live.splice(index, 1);
  }

  function dispatch(instance, name, event) {
    var handler = instance[name];
    if (typeof handler !== 'function') return;
    try {
      handler.call(instance, event);
    } catch (error) {
      report(error);
    }
  }

  function resultEvent(text, isFinal, confidence) {
    var result = { isFinal: !!isFinal, length: 1 };
    result[0] = {
      transcript: text === undefined || text === null ? '' : String(text),
      confidence: typeof confidence === 'number' ? confidence : 0
    };
    return { type: 'result', resultIndex: 0, results: [result] };
  }

  function announceStart(instance) {
    if (!instance || instance._ended || !instance._live || instance._started) return;
    instance._started = true;
    dispatch(instance, 'onstart', { type: 'start' });
  }

  function announceStartLater(instance) {
    setTimeout(function () {
      announceStart(instance);
    }, 0);
  }

  function endInstance(instance) {
    if (!instance || instance._ended) return;
    instance._ended = true;
    instance._live = false;
    instance._started = false;
    removeLive(instance);
    dispatch(instance, 'onend', { type: 'end' });
  }

  function failInstance(instance, code) {
    if (!instance) return;
    dispatch(instance, 'onerror', { type: 'error', error: code });
    endInstance(instance);
  }

  function scheduleNativeStop() {
    if (live.length > 0 || nativeState === 'idle') return;
    if (pendingStop !== null) clearTimeout(pendingStop);
    // A short grace period lets the very common "abort old instance, start the
    // next one" pattern reuse the running native session.
    pendingStop = setTimeout(function () {
      pendingStop = null;
      if (live.length > 0) return;
      nativeState = 'idle';
      try {
        bridge.stopListening();
      } catch (error) {
        report(error);
      }
    }, 120);
  }

  function NativeSpeechRecognition() {
    this.lang = 'en-US';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this._live = false;
    this._started = false;
    this._ended = false;
  }

  NativeSpeechRecognition.prototype.start = function () {
    if (this._live) return;
    this._live = true;
    this._started = false;
    this._ended = false;
    addLive(this);
    if (pendingStop !== null) {
      clearTimeout(pendingStop);
      pendingStop = null;
    }
    if (nativeState === 'listening') {
      announceStartLater(this);
      return;
    }
    if (nativeState === 'starting') return;
    nativeState = 'starting';
    try {
      bridge.startListening(String(this.lang || 'en-US'));
    } catch (error) {
      nativeState = 'idle';
      this._live = false;
      removeLive(this);
      failInstance(this, 'service-not-allowed');
    }
  };

  NativeSpeechRecognition.prototype.stop = function () {
    if (!this._live) return;
    this._live = false;
    removeLive(this);
    scheduleNativeStop();
    endInstance(this);
  };

  NativeSpeechRecognition.prototype.abort = function () {
    this.stop();
  };

  var synth = null;
  var currentUtterance = null;
  var shimSynthesis = !window.speechSynthesis || typeof window.speechSynthesis !== 'object';

  function finishUtterance(utterance, failed) {
    if (!utterance || utterance._done) return;
    utterance._done = true;
    if (currentUtterance === utterance) currentUtterance = null;
    if (synth) synth.speaking = false;
    var handler = failed ? utterance.onerror : utterance.onend;
    if (typeof handler !== 'function' && failed) handler = utterance.onend;
    if (typeof handler !== 'function') return;
    try {
      handler.call(utterance, { type: failed ? 'error' : 'end', error: failed ? 'synthesis-failed' : '' });
    } catch (error) {
      report(error);
    }
  }

  if (shimSynthesis) {
    var deviceVoice = {
      name: 'Device voice',
      lang: 'en-US',
      voiceURI: 'hey-logan-device',
      localService: true,
      'default': true
    };

    synth = {
      speaking: false,
      paused: false,
      pending: false,
      onvoiceschanged: null,
      getVoices: function () {
        return [deviceVoice];
      },
      speak: function (utterance) {
        if (!utterance || typeof utterance !== 'object') return;
        if (currentUtterance && currentUtterance !== utterance) currentUtterance._done = true;
        currentUtterance = utterance;
        utterance._done = false;
        synth.speaking = true;
        var text = utterance.text === undefined || utterance.text === null ? '' : String(utterance.text);
        if (!text) {
          finishUtterance(utterance, false);
          return;
        }
        var rate = Number(utterance.rate);
        var pitch = Number(utterance.pitch);
        try {
          bridge.speak(
            text,
            utterance.lang ? String(utterance.lang) : 'en-US',
            isFinite(rate) && rate > 0 ? rate : 1,
            isFinite(pitch) && pitch > 0 ? pitch : 1
          );
        } catch (error) {
          finishUtterance(utterance, true);
        }
      },
      cancel: function () {
        var utterance = currentUtterance;
        currentUtterance = null;
        synth.speaking = false;
        if (utterance) utterance._done = true;
        try {
          bridge.stopSpeaking();
        } catch (error) {
          report(error);
        }
      }
    };

    window.speechSynthesis = synth;
    if (typeof window.SpeechSynthesisUtterance !== 'function') {
      window.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) {
        this.text = text === undefined || text === null ? '' : String(text);
        this.lang = '';
        this.voice = null;
        this.rate = 1;
        this.pitch = 1;
        this.volume = 1;
        this.onstart = null;
        this.onend = null;
        this.onerror = null;
        this._done = false;
      };
    }
  }

  function handleNative(jsonString) {
    var event;
    try {
      event = JSON.parse(String(jsonString));
    } catch (error) {
      report(error);
      return;
    }
    if (!event || typeof event !== 'object') return;
    var type = String(event.type || '');

    if (type === 'start') {
      if (live.length === 0) {
        nativeState = 'idle';
        try {
          bridge.stopListening();
        } catch (error) {
          report(error);
        }
        return;
      }
      nativeState = 'listening';
      var starting = live.slice(0);
      for (var s = 0; s < starting.length; s += 1) announceStart(starting[s]);
      return;
    }

    if (type === 'partial' || type === 'final') {
      var text = event.text === undefined || event.text === null ? '' : String(event.text);
      if (!text) return;
      var confidence = typeof event.confidence === 'number' ? event.confidence : 0;
      var result = resultEvent(text, type === 'final', confidence);
      var receiving = live.slice(0);
      for (var r = 0; r < receiving.length; r += 1) dispatch(receiving[r], 'onresult', result);
      return;
    }

    if (type === 'error') {
      var errorEvent = {
        type: 'error',
        error: event.error ? String(event.error) : 'network',
        message: ''
      };
      var failing = live.slice(0);
      for (var f = 0; f < failing.length; f += 1) dispatch(failing[f], 'onerror', errorEvent);
      return;
    }

    if (type === 'end') {
      nativeState = 'idle';
      var ending = live.slice(0);
      for (var e = 0; e < ending.length; e += 1) endInstance(ending[e]);
      return;
    }

    if (type === 'tts-start') {
      if (currentUtterance) dispatch(currentUtterance, 'onstart', { type: 'start' });
      return;
    }

    if (type === 'tts-end') {
      if (currentUtterance) finishUtterance(currentUtterance, false);
    }
  }

  var installed = false;
  try {
    bridge._onNative = handleNative;
    installed = true;
  } catch (error) {
    report(error);
  }
  if (!installed) return;

  window.__heyNativeVoice = true;

  var sttAvailable = false;
  try {
    sttAvailable = bridge.sttAvailable() === true;
  } catch (error) {
    sttAvailable = false;
  }

  if (sttAvailable) {
    if (typeof window.SpeechRecognition !== 'function') window.SpeechRecognition = NativeSpeechRecognition;
    if (typeof window.webkitSpeechRecognition !== 'function') window.webkitSpeechRecognition = window.SpeechRecognition;
  } else {
    report('device has no speech recognition service');
  }
})();
