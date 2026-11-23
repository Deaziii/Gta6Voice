import {
  ROLES,
  ROLE_META,
  cleanText,
  formatForAiSpeech,
  formatForFastSpeech,
  normalizeKey
} from "./captionController.js";

export const ELEVENLABS_PREMADE_VOICES = [
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam · Глубокий мужской (Джейсон)", gender: "m" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah · Живая женская (Люсия)", gender: "f" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam · Энергичный мужской (NPC М)", gender: "m" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura · Яркая женская (NPC Ж)", gender: "f" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George · Тёплый харизматичный (М)", gender: "m" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum · Хриплый уличный (М)", gender: "m" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie · Быстрый разговорный (М)", gender: "m" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel · Властный чёткий (М)", gender: "m" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda · Мягкая естественная (Ж)", gender: "f" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice · Чёткая динамичная (Ж)", gender: "f" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily · Бархатная спокойная (Ж)", gender: "f" }
];

export const DEFAULT_AI_ROLE_VOICES = {
  [ROLES.JASON]: "pNInz6obpgDQGcFmaJgB",
  [ROLES.LUCIA]: "EXAVITQu4vr4xnSDxMaL",
  [ROLES.MALE_NPC]: "TX3LPaxmHKxFdv7VOQHJ",
  [ROLES.FEMALE_NPC]: "FGY2WhTYpPnrIDTdsKH5"
};

// Tiny silent WAV (44 bytes PCM) to unlock HTMLAudioElement permanently on user tap
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

const clamp = (val, min, max) => Math.min(max, Math.max(min, val));

function detectOfflineVoiceGender(voice) {
  const probe = ((voice?.name || "") + " " + (voice?.voiceURI || "")).toLowerCase();
  if (/(female|жен|irina|ирина|anna|анна|elena|елена|svetlana|светлана|dariya|дарья|natasha|tatyana|ruf\b|dfc\b|sfg\b|milena|katya|alyona)/.test(probe)) {
    return "f";
  }
  if (/(male|муж|dmitr|дмитр|aleks|алекс|artem|артем|pavel|павел|denis|денис|ruslan|руслан|maxim|максим|yuri|юрий|rud\b|rue\b|sfb\b)/.test(probe)) {
    return "m";
  }
  return "u";
}

export class VoiceEngine {
  constructor(options = {}) {
    this.mode = "offline"; // "offline" | "elevenlabs"
    this.apiKey = "";
    this.aiModel = "eleven_flash_v2_5";
    this.fallbackToOffline = true;
    this.fallbackTimeoutMs = 1350;
    this.rate = 1.45;
    this.volume = 1.0; // legacy fallback
    this.roleVolumes = {
      [ROLES.JASON]: 1.0,
      [ROLES.LUCIA]: 1.0,
      [ROLES.MALE_NPC]: 1.0,
      [ROLES.FEMALE_NPC]: 1.0
    };
    this.roleDefinitions = Object.values(ROLE_META).map(meta => ({ ...meta, name: meta.short, aliases: [meta.short] }));

    this.offlineSelections = {
      [ROLES.JASON]: "",
      [ROLES.LUCIA]: "",
      [ROLES.MALE_NPC]: "",
      [ROLES.FEMALE_NPC]: ""
    };
    this.aiSelections = { ...DEFAULT_AI_ROLE_VOICES };

    this.systemVoices = [];
    this.customAiVoices = [];

    this.audioCtx = null;
    this.keepAliveOsc = null;
    this.audioEl = options.audioElement || new Audio();
    this.audioEl.preload = "auto";
    this.audioUnlocked = false;

    this.activeAbort = null;
    this.activeCancelFn = null;
    this.speechWatchdog = null;

    // LRU RAM cache of synthesized MP3 blobs + in-flight speculative prefetch promises
    this.audioCache = new Map();
    this.inflightFetches = new Map();
    this.maxCacheEntries = 42;

    this.onStateChange = options.onStateChange || (() => {});
  }

  unlockAudio() {
    this.audioUnlocked = true;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx && !this.audioCtx) {
        const actx = new AudioCtx();
        const osc = actx.createOscillator();
        const gain = actx.createGain();
        osc.frequency.value = 40;
        gain.gain.value = 0.00004;
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.start();
        this.audioCtx = actx;
        this.keepAliveOsc = osc;
      }
      if (this.audioCtx?.state === "suspended") {
        this.audioCtx.resume().catch(() => {});
      }
    } catch (_) {}

    // Unlock persistent HTMLAudioElement on Android Chrome
    try {
      this.audioEl.muted = true;
      this.audioEl.src = SILENT_WAV_DATA_URI;
      const playPromise = this.audioEl.play();
      if (playPromise?.then) {
        playPromise.then(() => {
          this.audioEl.pause();
          this.audioEl.muted = false;
        }).catch(() => {
          this.audioEl.muted = false;
        });
      } else {
        this.audioEl.muted = false;
      }
    } catch (_) {
      this.audioEl.muted = false;
    }

    // Unlock Android SpeechSynthesis inside user tap
    if ("speechSynthesis" in window) {
      try {
        speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance(" ");
        u.lang = "ru-RU";
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch (_) {}
    }
  }

  stopKeepAlive() {
    if (!this.audioCtx) return;
    const actx = this.audioCtx;
    this.audioCtx = null;
    this.keepAliveOsc = null;
    try { actx.close(); } catch (_) {}
  }

  resumeIfSuspended() {
    if (this.audioCtx?.state === "suspended") {
      this.audioCtx.resume().catch(() => {});
    }
    if ("speechSynthesis" in window) {
      try {
        if (speechSynthesis.paused) speechSynthesis.resume();
      } catch (_) {}
    }
  }

  setRoleDefinitions(definitions = []) {
    if (!Array.isArray(definitions) || !definitions.length) return;
    this.roleDefinitions = definitions.map(role => ({ ...role }));
    for (const role of this.roleDefinitions) {
      if (!(role.id in this.roleVolumes)) this.roleVolumes[role.id] = 1;
      if (!(role.id in this.offlineSelections)) this.offlineSelections[role.id] = "";
      if (!(role.id in this.aiSelections)) {
        this.aiSelections[role.id] = role.gender === "f"
          ? DEFAULT_AI_ROLE_VOICES[ROLES.LUCIA]
          : DEFAULT_AI_ROLE_VOICES[ROLES.JASON];
      }
    }
  }

  refreshSystemVoices() {
    if (!("speechSynthesis" in window)) {
      this.systemVoices = [];
      return [];
    }
    const all = speechSynthesis.getVoices() || [];
    // Sort local Russian voices first for zero-network offline speed
    this.systemVoices = all
      .map((voice, index) => ({
        voice,
        index,
        isRu: /^ru/i.test(voice.lang) || /russian|русск/i.test(voice.name),
        gender: detectOfflineVoiceGender(voice)
      }))
      .filter(entry => entry.isRu)
      .sort((a, b) => Number(Boolean(b.voice.localService)) - Number(Boolean(a.voice.localService)));

    return this.systemVoices;
  }

  getAllAiVoices() {
    const seen = new Set();
    const list = [];
    for (const item of [...this.customAiVoices, ...ELEVENLABS_PREMADE_VOICES]) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      list.push(item);
    }
    return list;
  }

  async fetchAccountVoices(apiKey = this.apiKey) {
    const cleanKey = (apiKey || "").trim();
    if (!cleanKey) throw new Error("Сначала введи API-ключ ElevenLabs.");

    // Keep the exact endpoint and request shape from the last confirmed working release.
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: { "xi-api-key": cleanKey }
    });
    if (!response.ok) {
      throw new Error("ElevenLabs вернул ошибку " + response.status + " (проверь ключ или доступ API).");
    }
    const data = await response.json();
    const voices = Array.isArray(data?.voices) ? data.voices : [];
    this.customAiVoices = voices.map(v => {
      const genderLabel = (v.labels?.gender || "").toLowerCase();
      const gender = genderLabel.startsWith("f") ? "f" : genderLabel.startsWith("m") ? "m" : "u";
      const tag = v.category === "cloned" || v.category === "generated" ? " · свой" : "";
      return {
        id: v.voice_id,
        name: v.name + tag + (gender === "f" ? " (Ж)" : gender === "m" ? " (М)" : ""),
        gender
      };
    });
    return this.getAllAiVoices();
  }

  cancel() {
    if (this.speechWatchdog) {
      window.clearTimeout(this.speechWatchdog);
      this.speechWatchdog = null;
    }
    if (this.activeAbort) {
      try { this.activeAbort.abort(); } catch (_) {}
      this.activeAbort = null;
    }
    if (this.activeCancelFn) {
      const fn = this.activeCancelFn;
      this.activeCancelFn = null;
      try { fn(); } catch (_) {}
    }
    try {
      this.audioEl.pause();
      this.audioEl.removeAttribute("src");
    } catch (_) {}
    if ("speechSynthesis" in window) {
      try { speechSynthesis.cancel(); } catch (_) {}
    }
  }

  /**
   * Speculatively synthesize a waiting `pending` item in the background while
   * the current line is still playing -> 0ms network wait on transition!
   */
  prefetch(item) {
    if (!item || this.mode !== "elevenlabs" || !this.apiKey.trim()) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    const turns = Array.isArray(item.turns) && item.turns.length
      ? item.turns
      : [{ text: item.speechText || item.text, role: item.role || ROLES.JASON }];

    const firstTurn = turns[0];
    const spoken = formatForAiSpeech(firstTurn?.text || "");
    if (!spoken) return;

    const role = firstTurn.role || ROLES.JASON;
    const voiceId = this.aiSelections[role] || DEFAULT_AI_ROLE_VOICES[role] || DEFAULT_AI_ROLE_VOICES[ROLES.JASON];
    this.#fetchAiClip(spoken, voiceId, this.rate).catch(() => {});
  }

  /**
   * Speak an utterance item (supports multi-character `turns` inside a single caption)
   * using either the AI engine (with automatic offline fallback) or Offline engine.
   */
  async speakItem(item, { catchUpBoost = 0, onStart } = {}) {
    const turns = Array.isArray(item?.turns) && item.turns.length
      ? item.turns
      : [{ text: item?.speechText || item?.text || "", role: item?.role || ROLES.JASON }];

    const effectiveRate = clamp(this.rate + catchUpBoost, 0.90, 2.20);
    let cancelled = false;
    this.activeCancelFn = () => { cancelled = true; };

    let startedNotified = false;
    const notifyStart = info => {
      if (!startedNotified) {
        startedNotified = true;
        if (onStart) onStart(info);
      }
      this.onStateChange(info);
    };

    for (let i = 0; i < turns.length; i++) {
      if (cancelled) break;
      const turn = turns[i];
      const role = turn.role || ROLES.JASON;

      // Speculatively prefetch next turn in multi-turn exchange while turn `i` plays
      if (i + 1 < turns.length && this.mode === "elevenlabs" && this.apiKey.trim()) {
        const nextTurn = turns[i + 1];
        const nextRole = nextTurn.role || ROLES.LUCIA;
        const nextVoiceId = this.aiSelections[nextRole] || DEFAULT_AI_ROLE_VOICES[nextRole];
        const nextText = formatForAiSpeech(nextTurn.text);
        if (nextText) this.#fetchAiClip(nextText, nextVoiceId, effectiveRate).catch(() => {});
      }

      const wantAi =
        this.mode === "elevenlabs" &&
        Boolean(this.apiKey.trim()) &&
        (typeof navigator === "undefined" || navigator.onLine !== false);

      if (wantAi) {
        const aiSpoken = formatForAiSpeech(turn.text);
        if (!aiSpoken) continue;
        try {
          await this.#playAiTurn(aiSpoken, role, effectiveRate, () => cancelled, notifyStart);
          continue;
        } catch (err) {
          if (cancelled || err?.name === "AbortError") break;
          console.warn("AI TTS failed or timed out, switching to instant offline fallback:", err);
          if (!this.fallbackToOffline) throw err;
          await this.#playOfflineTurn(turn.text, role, effectiveRate, true, () => cancelled, notifyStart);
          continue;
        }
      } else {
        await this.#playOfflineTurn(turn.text, role, effectiveRate, false, () => cancelled, notifyStart);
      }
    }

    if (this.activeCancelFn) this.activeCancelFn = null;
  }

  #resolveOfflineSlot(role) {
    const ruVoices = this.systemVoices.length ? this.systemVoices : this.refreshSystemVoices();
    const explicitUri = this.offlineSelections[role];
    if (explicitUri) {
      const found = ruVoices.find(v => v.voice.voiceURI === explicitUri || v.voice.name === explicitUri);
      if (found) {
        return { voice: found.voice, shared: false };
      }
    }

    const roleMeta = this.roleDefinitions.find(item => item.id === role) || ROLE_META[role] || {};
    const wantGender = roleMeta.gender || "m";
    const isMain = Boolean(roleMeta.main);
    const matchingGender = ruVoices.filter(v => v.gender === wantGender);

    if (matchingGender.length >= 2) {
      return { voice: (isMain ? matchingGender[0] : matchingGender[1]).voice, shared: false };
    }
    if (matchingGender.length === 1) {
      return { voice: matchingGender[0].voice, shared: !isMain };
    }
    if (ruVoices.length >= 2) {
      const pickIndex = role === ROLES.JASON
        ? 0
        : role === ROLES.LUCIA
          ? 1
          : role === ROLES.MALE_NPC
            ? 0
            : Math.min(1, ruVoices.length - 1);
      return { voice: ruVoices[pickIndex].voice, shared: ruVoices.length < 4 };
    }
    if (ruVoices.length === 1) {
      return { voice: ruVoices[0].voice, shared: true };
    }
    return { voice: null, shared: true };
  }

  #offlineProsody(role, shared) {
    if (!shared) {
      switch (role) {
        case ROLES.JASON: return { pitch: 0.96, rateMul: 1.0 };
        case ROLES.LUCIA: return { pitch: 1.04, rateMul: 1.01 };
        case ROLES.MALE_NPC: return { pitch: 1.02, rateMul: 1.03 };
        case ROLES.FEMALE_NPC: return { pitch: 1.09, rateMul: 1.03 };
        default: return { pitch: 1.0, rateMul: 1.0 };
      }
    }
    // Distinct pitch sculpting when the phone only has 1-2 Russian offline voices installed
    const roleMeta = this.roleDefinitions.find(item => item.id === role) || ROLE_META[role] || {};
    if (!ROLE_META[role]) return { pitch: roleMeta.gender === "f" ? 1.12 : 0.96, rateMul: 1.02 };
    switch (role) {
      case ROLES.JASON: return { pitch: 0.90, rateMul: 1.0 };
      case ROLES.LUCIA: return { pitch: 1.09, rateMul: 1.02 };
      case ROLES.MALE_NPC: return { pitch: 1.02, rateMul: 1.04 };
      case ROLES.FEMALE_NPC: return { pitch: 1.18, rateMul: 1.04 };
      default: return { pitch: 1.0, rateMul: 1.0 };
    }
  }

  #playOfflineTurn(rawText, role, effectiveRate, isFallback, isCancelled, notifyStart) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window) || isCancelled()) {
        resolve();
        return;
      }
      const spoken = formatForFastSpeech(rawText) || cleanText(rawText);
      if (!spoken) {
        resolve();
        return;
      }

      const { voice, shared } = this.#resolveOfflineSlot(role);
      const prosody = this.#offlineProsody(role, shared);
      const finalRate = clamp(effectiveRate * prosody.rateMul, 0.85, 2.20);

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.speechWatchdog) {
          window.clearTimeout(this.speechWatchdog);
          this.speechWatchdog = null;
        }
        resolve();
      };

      const armWatchdog = () => {
        if (this.speechWatchdog) window.clearTimeout(this.speechWatchdog);
        this.speechWatchdog = window.setTimeout(() => {
          try { speechSynthesis.cancel(); } catch (_) {}
          finish();
        }, 8500);
      };

      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.lang = "ru-RU";
      utterance.rate = finalRate;
      utterance.pitch = prosody.pitch;
      utterance.volume = this.roleVolumes[role] ?? this.volume;
      if (voice) utterance.voice = voice;

      utterance.onstart = () => {
        armWatchdog();
        notifyStart({
          role,
          engine: isFallback ? "fallback" : "offline",
          rate: finalRate
        });
      };
      utterance.onboundary = armWatchdog;
      utterance.onend = finish;
      utterance.onerror = finish;

      try {
        if (speechSynthesis.paused) speechSynthesis.resume();
        speechSynthesis.speak(utterance);
        armWatchdog();
      } catch (_) {
        finish();
      }
    });
  }

  #cacheKey(voiceId, text, apiSpeed) {
    return this.aiModel + "|" + voiceId + "|" + apiSpeed.toFixed(2) + "|" + normalizeKey(text);
  }

  #storeCachedBlob(key, blob) {
    if (this.audioCache.has(key)) this.audioCache.delete(key);
    this.audioCache.set(key, blob);
    if (this.audioCache.size > this.maxCacheEntries) {
      const oldestKey = this.audioCache.keys().next().value;
      if (oldestKey) this.audioCache.delete(oldestKey);
    }
  }

  async #fetchAiClip(spokenText, voiceId, targetRate, externalSignal) {
    const apiSpeed = clamp(targetRate, 0.85, 1.20);
    const key = this.#cacheKey(voiceId, spokenText, apiSpeed);

    if (this.audioCache.has(key)) {
      const cached = this.audioCache.get(key);
      this.#storeCachedBlob(key, cached);
      return { blob: cached, apiSpeed, fromCache: true };
    }

    if (this.inflightFetches.has(key) && !externalSignal) {
      const blob = await this.inflightFetches.get(key);
      return { blob, apiSpeed, fromCache: true };
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(new Error("AI_TIMEOUT")), this.fallbackTimeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        window.clearTimeout(timeoutId);
        throw new DOMException("Aborted", "AbortError");
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const body = {
      text: spokenText,
      model_id: this.aiModel,
      voice_settings: {
        stability: 0.42,
        similarity_boost: 0.78,
        style: 0.15,
        use_speaker_boost: true,
        speed: Number(apiSpeed.toFixed(2))
      }
    };
    if (this.aiModel === "eleven_flash_v2_5") {
      body.language_code = "ru";
    }

    const url = "https://api.elevenlabs.io/v1/text-to-speech/" +
      encodeURIComponent(voiceId) +
      "/stream?output_format=mp3_22050_32";

    const fetchPromise = (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "xi-api-key": this.apiKey.trim(),
            "Content-Type": "application/json",
            "Accept": "audio/mpeg"
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) {
          throw new Error("ElevenLabs HTTP " + res.status);
        }
        const blob = await res.blob();
        if (!blob || blob.size < 64) {
          throw new Error("Empty AI audio response");
        }
        this.#storeCachedBlob(key, blob);
        return blob;
      } finally {
        window.clearTimeout(timeoutId);
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        this.inflightFetches.delete(key);
      }
    })();

    this.inflightFetches.set(key, fetchPromise);
    const blob = await fetchPromise;
    return { blob, apiSpeed, fromCache: false };
  }

  async #playAiTurn(spokenText, role, effectiveRate, isCancelled, notifyStart) {
    const voiceId = this.aiSelections[role] || DEFAULT_AI_ROLE_VOICES[role] || DEFAULT_AI_ROLE_VOICES[ROLES.JASON];
    const abortCtrl = new AbortController();
    this.activeAbort = abortCtrl;

    let blobResult;
    try {
      blobResult = await this.#fetchAiClip(spokenText, voiceId, effectiveRate, abortCtrl.signal);
    } finally {
      if (this.activeAbort === abortCtrl) this.activeAbort = null;
    }

    if (isCancelled()) return;

    const { blob, apiSpeed, fromCache } = blobResult;
    const extraPlaybackRate = clamp(effectiveRate / apiSpeed, 0.95, 1.65);

    await new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      let finished = false;

      const cleanup = () => {
        if (finished) return;
        finished = true;
        if (this.speechWatchdog) {
          window.clearTimeout(this.speechWatchdog);
          this.speechWatchdog = null;
        }
        this.audioEl.onended = null;
        this.audioEl.onerror = null;
        this.audioEl.onplaying = null;
        URL.revokeObjectURL(objectUrl);
      };

      this.audioEl.src = objectUrl;
      this.audioEl.volume = this.roleVolumes[role] ?? this.volume;
      if ("preservesPitch" in this.audioEl) this.audioEl.preservesPitch = true;
      if ("webkitPreservesPitch" in this.audioEl) this.audioEl.webkitPreservesPitch = true;
      this.audioEl.playbackRate = extraPlaybackRate;

      this.speechWatchdog = window.setTimeout(() => {
        cleanup();
        try { this.audioEl.pause(); } catch (_) {}
        resolve();
      }, 11000);

      this.audioEl.onplaying = () => {
        notifyStart({
          role,
          engine: fromCache ? "ai-cache" : "ai",
          rate: effectiveRate
        });
      };
      this.audioEl.onended = () => {
        cleanup();
        resolve();
      };
      this.audioEl.onerror = err => {
        cleanup();
        reject(err || new Error("Audio playback error"));
      };

      const playPromise = this.audioEl.play();
      if (playPromise?.catch) {
        playPromise.catch(err => {
          cleanup();
          reject(err);
        });
      }
    });
  }
}