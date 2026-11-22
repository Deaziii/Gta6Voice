const HOMOGLYPH_MAP = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У",
  a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у"
};

const NON_HOMOGLYPH_LATIN = /[DFGIJLNQRSUVWZbdfghijklmnqrstuvwz]/;
const VALID_SINGLE_LETTER_WORDS = new Set(["а", "и", "о", "у", "я", "в", "к", "с", "ж", "б"]);

export const cleanText = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Fix random mid-word uppercase Cyrillic glitches from OCR (e.g. "ровОрИТ" -> "роворит")
 * while keeping real ALL-CAPS acronyms ("США", "ФБР") and capitalized words ("Господь") intact.
 */
export function fixMidWordCase(text) {
  return text.replace(/[А-Яа-яЁё]{2,}/g, word => {
    const hasLower = /[а-яё]/.test(word);
    const hasUpperAfterFirst = /[А-ЯЁ]/.test(word.slice(1));
    if (hasLower && hasUpperAfterFirst) {
      return word[0] + word.slice(1).toLocaleLowerCase("ru-RU");
    }
    return word;
  });
}

/**
 * Fix Latin lookalike characters produced by OCR inside Russian subtitle lines
 * and normalize mid-word OCR capitalization glitches.
 */
export function normalizeRussianHomoglyphs(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const cyrillicCount = (cleaned.match(/[А-Яа-яЁё]/g) || []).length;
  if (cyrillicCount < 1) return cleaned;

  const mapped = cleaned.split(" ").map(token => {
    const core = token.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    if (!core || NON_HOMOGLYPH_LATIN.test(core)) return token;

    const hasCyrillic = /[А-Яа-яЁё]/.test(core);
    const isShortHomoglyphWord = cyrillicCount >= 2 && /^[ABCEHKMOPTXYaceopxy]{1,2}$/.test(core);
    if (!hasCyrillic && !isShortHomoglyphWord) return token;

    return token.replace(/[ABCEHKMOPTXYaceopxy]/g, ch => HOMOGLYPH_MAP[ch] || ch);
  }).join(" ");

  return fixMidWordCase(mapped);
}

export const normalizeKey = value => normalizeRussianHomoglyphs(value)
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[^а-яa-z0-9 ]/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

export function isRussianSubtitleLine(line) {
  const value = normalizeRussianHomoglyphs(line);
  const letters = value.match(/[A-Za-zА-Яа-яЁё]/g) || [];
  const cyrillic = value.match(/[А-Яа-яЁё]/g) || [];
  if (cyrillic.length < 2 || !letters.length) return false;
  if (cyrillic.length / letters.length < 0.80) return false;
  if (!/[аеёиоуыэюя]/i.test(value)) return false;
  if (/[бвгджзйклмнпрстфхцчшщъь]{6,}/i.test(value)) return false;

  const words = value
    .replace(/[^A-Za-zА-Яа-яЁё0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;

  const hasMultiLetterCyrillicWord = words.some(
    word => (word.match(/[А-Яа-яЁё]/g) || []).length >= 2
  );
  if (!hasMultiLetterCyrillicWord) return false;

  const invalidSingleWords = words.filter(
    word => /^[А-Яа-яЁё]$/i.test(word) && !VALID_SINGLE_LETTER_WORDS.has(word.toLocaleLowerCase("ru-RU"))
  ).length;
  if (invalidSingleWords >= 2 || invalidSingleWords / words.length > 0.25) return false;

  return true;
}

/**
 * Lightweight (<0.4ms) pre-OCR pixel check on a 128x40 RGBA thumbnail of the ROI.
 * Prevents locking the single-threaded WASM worker for 500-1500ms when the ROI
 * hasn't changed or when pointing at a completely blank wall/screen.
 */
export function evaluateFrameGate(rgba, width, height, state = {}, now = Date.now()) {
  const pixelCount = width * height;
  if (!rgba || rgba.length < pixelCount * 4) {
    return { run: true, reason: "no-buffer", gray: null };
  }

  const gray = new Uint8Array(pixelCount);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }

  const prevGray = state.prevGray;
  const lastFullOcrAt = Number(state.lastFullOcrAt) || 0;
  const lastHadSubtitle = Boolean(state.lastHadSubtitle);
  const forceEveryMs = Number(state.forceEveryMs) || 1400;

  if (!prevGray || prevGray.length !== pixelCount || now - lastFullOcrAt >= forceEveryMs) {
    return { run: true, reason: "periodic", gray };
  }

  // 1. Tile-based Mean Absolute Difference (8x10 blocks) against last actual OCR frame
  const tileW = 8;
  const tileH = 10;
  let maxTileMad = 0;
  for (let ty = 0; ty <= height - tileH; ty += tileH) {
    for (let tx = 0; tx <= width - tileW; tx += tileW) {
      let sum = 0;
      for (let dy = 0; dy < tileH; dy++) {
        let idx = (ty + dy) * width + tx;
        for (let dx = 0; dx < tileW; dx++, idx++) {
          const diff = gray[idx] - prevGray[idx];
          sum += diff < 0 ? -diff : diff;
        }
      }
      const mad = sum / (tileW * tileH);
      if (mad > maxTileMad) maxTileMad = mad;
    }
  }

  if (maxTileMad < 5.2) {
    // Exact repeats can be skipped immediately. But a small non-zero change may
    // still be faint subtitle text, so let the stroke check inspect it below.
    let anyPixelChanged = false;
    for (let i = 0; i < pixelCount; i++) {
      if (gray[i] !== prevGray[i]) {
        anyPixelChanged = true;
        break;
      }
    }
    if (!anyPixelChanged || lastHadSubtitle) {
      return { run: false, reason: "unchanged", gray: prevGray };
    }
  }

  // 2. When previous OCR saw no subtitle, check if ANY horizontal scanlines contain
  // thin vertical stroke pairs (even very low contrast >= 9/255 passes).
  if (!lastHadSubtitle) {
    let activeStrokeRows = 0;
    for (let y = 1; y < height - 1; y++) {
      const rowOffset = y * width;
      let pairsInRow = 0;
      for (let x = 0; x < width - 3; x++) {
        const g1 = gray[rowOffset + x + 2] - gray[rowOffset + x];
        if (g1 >= 9 || g1 <= -9) {
          for (let span = 1; span <= 8 && x + 2 + span < width; span++) {
            const g2 = gray[rowOffset + x + 2 + span] - gray[rowOffset + x + span];
            if ((g1 > 0 && g2 <= -9) || (g1 < 0 && g2 >= 9)) {
              pairsInRow++;
              x += span;
              break;
            }
          }
        }
      }
      if (pairsInRow >= 2) {
        activeStrokeRows++;
        if (activeStrokeRows >= 2) break;
      }
    }

    if (activeStrokeRows < 2) {
      return { run: false, reason: "empty-scene", gray: prevGray };
    }
  }

  return { run: true, reason: "changed", gray };
}

function levenshteinSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / maxLength;
}

function tokenizeWithNormalizedMap(text) {
  const fixed = normalizeRussianHomoglyphs(text);
  const rawTokens = fixed.split(/\s+/).filter(Boolean);
  const normTokens = [];
  for (let rawIndex = 0; rawIndex < rawTokens.length; rawIndex++) {
    const norm = normalizeKey(rawTokens[rawIndex]);
    if (!norm) continue;
    for (const part of norm.split(/\s+/)) {
      if (part) normTokens.push({ norm: part, rawIndex });
    }
  }
  return { clean: fixed, rawTokens, normTokens };
}

export function analyzeCaptionRelation(previousText, nextText) {
  const prev = tokenizeWithNormalizedMap(previousText);
  const next = tokenizeWithNormalizedMap(nextText);

  if (!prev.normTokens.length || !next.normTokens.length) {
    return { type: "new", delta: next.clean };
  }

  const prevWords = prev.normTokens.map(item => item.norm);
  const nextWords = next.normTokens.map(item => item.norm);
  const prevJoined = prevWords.join(" ");
  const nextJoined = nextWords.join(" ");

  if (prevWords.length === nextWords.length) {
    if (levenshteinSimilarity(prevJoined, nextJoined) >= 0.82) {
      return { type: "same", delta: "" };
    }
  } else if (
    Math.abs(prevJoined.length - nextJoined.length) / Math.max(prevJoined.length, nextJoined.length) <= 0.20 &&
    levenshteinSimilarity(prevJoined, nextJoined) >= 0.85
  ) {
    return { type: "same", delta: "" };
  }

  if (nextWords.length > prevWords.length) {
    const maxOffset = prevWords.length >= 2 ? Math.min(2, nextWords.length - prevWords.length) : 0;
    for (let offset = 0; offset <= maxOffset; offset++) {
      const candidateSlice = nextWords.slice(offset, offset + prevWords.length).join(" ");
      if (levenshteinSimilarity(prevJoined, candidateSlice) >= 0.80) {
        const endNormIndex = offset + prevWords.length - 1;
        if (endNormIndex >= nextWords.length - 1) {
          return { type: "same", delta: "" };
        }
        const lastMatchedRawIndex = next.normTokens[endNormIndex].rawIndex;
        const delta = next.rawTokens.slice(lastMatchedRawIndex + 1).join(" ").trim();
        return {
          type: delta ? "extension" : "same",
          delta
        };
      }
    }
  }

  if (nextWords.length < prevWords.length) {
    const winLen = nextWords.length;
    if (winLen >= 2) {
      for (let start = 0; start <= prevWords.length - winLen; start++) {
        const sliceJoined = prevWords.slice(start, start + winLen).join(" ");
        if (levenshteinSimilarity(nextJoined, sliceJoined) >= 0.82) {
          return { type: "partial", delta: "" };
        }
      }
    } else if (winLen === 1) {
      const word = nextWords[0];
      if (word.length >= 4 || prevWords.length <= 3) {
        const firstSim = levenshteinSimilarity(word, prevWords[0]);
        const lastSim = levenshteinSimilarity(word, prevWords[prevWords.length - 1]);
        if (firstSim >= 0.86 || lastSim >= 0.86) {
          return { type: "partial", delta: "" };
        }
      }
    }
  }

  const maxOverlap = Math.min(prevWords.length, nextWords.length - 1);
  for (let k = maxOverlap; k >= 1; k--) {
    const prevTail = prevWords.slice(prevWords.length - k);
    if (k === 1 && prevTail[0].length < 6) continue;
    const nextHead = nextWords.slice(0, k);
    if (levenshteinSimilarity(prevTail.join(" "), nextHead.join(" ")) >= 0.84) {
      const lastMatchedRawIndex = next.normTokens[k - 1].rawIndex;
      const delta = next.rawTokens.slice(lastMatchedRawIndex + 1).join(" ").trim();
      if (delta) return { type: "extension", delta };
    }
  }

  return { type: "new", delta: next.clean };
}

function isSpeakableFragment(text) {
  if (!text) return false;
  if (normalizeKey(text).length >= 2) return true;
  return /[А-Яа-яЁё]/.test(text) && /[!?…]/.test(text);
}

export class CaptionController {
  constructor(options = {}) {
    this.options = {
      fastStartConfidence: 42,
      emptyGraceMs: 220,
      clearHistoryAfterEmptyMs: 1250,
      historyWindowMs: 4600,
      extensionAfterDoneWindowMs: 2300,
      maxUnseenAgeMs: 1100,
      staleAfterUnseenTotalMs: 1900,
      maxPendingAgeMs: 2900,
      preemptAfterActiveMs: 2400,
      preemptSingleAfterActiveMs: 3100,
      ...options
    };
    this.reset();
  }

  reset() {
    this.candidate = null;
    this.pending = null;
    this.active = null;
    this.history = [];
    this.emptySince = null;
    this.droppedDuringActive = 0;
    this.stats = {
      dropped: 0,
      stale: 0,
      spoken: 0,
      lastLagMs: null,
      lastSpeechMs: null
    };
  }

  observe(observation, now = Date.now()) {
    this.history = this.history.filter(entry => now - entry.completedAt <= this.options.historyWindowMs);

    const rawText = normalizeRussianHomoglyphs(observation?.text || "");
    const speaker = observation?.speaker || "";
    const confidence = Number(observation?.confidence) || 0;
    const lineCount = Math.max(1, Number(observation?.lineCount) || 1);

    if (!rawText) {
      if (this.emptySince === null) this.emptySince = now;
      const emptyElapsed = now - this.emptySince;

      if (this.candidate && emptyElapsed >= this.options.emptyGraceMs) {
        if (this.candidate.hits >= 2 || this.candidate.confidence >= this.options.fastStartConfidence) {
          this.#promoteCandidate(now);
        } else {
          this.candidate = null;
        }
      }

      if (
        emptyElapsed >= this.options.clearHistoryAfterEmptyMs &&
        !this.active &&
        !this.pending
      ) {
        this.history = [];
      }

      return this.getSnapshot(now);
    }

    this.emptySince = null;
    const key = normalizeKey(rawText);
    if (key.length < 2) return this.getSnapshot(now);

    let suppressPrefixText = "";
    let speechText = rawText;

    if (this.active) {
      const sameSpeakerOrUnknown = !speaker || !this.active.speaker || speaker === this.active.speaker;
      const relActive = analyzeCaptionRelation(this.active.sourceText, rawText);
      if (sameSpeakerOrUnknown && (relActive.type === "same" || relActive.type === "partial")) {
        return this.getSnapshot(now);
      }
      if (sameSpeakerOrUnknown && relActive.type === "extension") {
        suppressPrefixText = this.active.sourceText;
        speechText = relActive.delta;
      }
    }

    if (this.pending) {
      const sameSpeakerOrUnknown = !speaker || !this.pending.speaker || speaker === this.pending.speaker;
      const relPending = analyzeCaptionRelation(this.pending.sourceText, rawText);
      if (sameSpeakerOrUnknown && relPending.type === "same") {
        this.pending.lastSeenAt = now;
        if (confidence >= this.pending.confidence && rawText.length >= this.pending.sourceText.length) {
          const updatedSpeech = this.pending.suppressPrefixText
            ? analyzeCaptionRelation(this.pending.suppressPrefixText, rawText).delta
            : rawText;
          if (isSpeakableFragment(updatedSpeech)) {
            this.pending.sourceText = rawText;
            this.pending.speechText = updatedSpeech;
            this.pending.key = key;
            this.pending.confidence = confidence;
            this.pending.lineCount = Math.max(this.pending.lineCount, lineCount);
          }
        }
        this.candidate = null;
        return this.getSnapshot(now);
      }
      if (sameSpeakerOrUnknown && relPending.type === "extension") {
        const updatedSpeech = this.pending.suppressPrefixText
          ? analyzeCaptionRelation(this.pending.suppressPrefixText, rawText).delta
          : rawText;
        if (isSpeakableFragment(updatedSpeech)) {
          this.pending.sourceText = rawText;
          this.pending.speechText = updatedSpeech;
          this.pending.key = key;
          this.pending.lastSeenAt = now;
          this.pending.confidence = Math.max(this.pending.confidence, confidence);
          this.pending.lineCount = Math.max(this.pending.lineCount, lineCount);
          this.candidate = null;
          return this.getSnapshot(now);
        }
      }
      if (sameSpeakerOrUnknown && relPending.type === "partial") {
        this.pending.lastSeenAt = now;
        return this.getSnapshot(now);
      }
    }

    if (!suppressPrefixText && this.history.length) {
      for (let i = 0; i < this.history.length; i++) {
        const entry = this.history[i];
        const sameSpeakerOrUnknown = !speaker || !entry.speaker || speaker === entry.speaker;
        if (!sameSpeakerOrUnknown) continue;

        const relHist = analyzeCaptionRelation(entry.text, rawText);
        if (relHist.type === "same" || relHist.type === "partial") {
          return this.getSnapshot(now);
        }
        if (
          i === 0 &&
          relHist.type === "extension" &&
          now - entry.completedAt <= this.options.extensionAfterDoneWindowMs
        ) {
          suppressPrefixText = entry.text;
          speechText = relHist.delta;
          break;
        }
      }
    }

    if (!isSpeakableFragment(speechText)) {
      return this.getSnapshot(now);
    }

    if (!this.candidate) {
      this.candidate = {
        sourceText: rawText,
        speechText,
        suppressPrefixText,
        key,
        speaker,
        confidence,
        lineCount,
        firstSeenAt: now,
        lastSeenAt: now,
        hits: 1
      };
    } else {
      const relCand = analyzeCaptionRelation(this.candidate.sourceText, rawText);
      if (relCand.type === "same") {
        this.candidate.hits += 1;
        this.candidate.lastSeenAt = now;
        this.candidate.lineCount = Math.max(this.candidate.lineCount, lineCount);
        if (confidence >= this.candidate.confidence) {
          this.candidate.sourceText = rawText;
          this.candidate.speechText = speechText;
          this.candidate.suppressPrefixText = suppressPrefixText;
          this.candidate.key = key;
          this.candidate.confidence = confidence;
          if (speaker) this.candidate.speaker = speaker;
        }
      } else if (relCand.type === "extension") {
        this.candidate.sourceText = rawText;
        this.candidate.speechText = speechText;
        this.candidate.suppressPrefixText = suppressPrefixText;
        this.candidate.key = key;
        this.candidate.lastSeenAt = now;
        this.candidate.hits += 1;
        this.candidate.lineCount = Math.max(this.candidate.lineCount, lineCount);
        this.candidate.confidence = Math.max(this.candidate.confidence, confidence);
        if (speaker) this.candidate.speaker = speaker;
      } else if (relCand.type === "partial") {
        this.candidate.lastSeenAt = now;
        this.candidate.hits += 1;
      } else {
        if (this.candidate.hits >= 2) {
          this.stats.dropped += 1;
          if (this.active) this.droppedDuringActive += 1;
        }
        this.candidate = {
          sourceText: rawText,
          speechText,
          suppressPrefixText,
          key,
          speaker,
          confidence,
          lineCount,
          firstSeenAt: now,
          lastSeenAt: now,
          hits: 1
        };
      }
    }

    if (this.#isCandidateReady(this.candidate)) {
      this.#promoteCandidate(now);
    }

    return this.getSnapshot(now);
  }

  pullNextUtterance(now = Date.now()) {
    if (this.active || !this.pending) return null;

    const totalAge = now - this.pending.firstSeenAt;
    const unseenAge = now - this.pending.lastSeenAt;
    const isStale =
      (unseenAge > this.options.maxUnseenAgeMs && totalAge > this.options.staleAfterUnseenTotalMs) ||
      totalAge > this.options.maxPendingAgeMs;

    if (isStale) {
      this.stats.stale += 1;
      this.pending = null;
      return null;
    }

    const lagMs = Math.max(0, now - this.pending.firstSeenAt);
    this.active = {
      ...this.pending,
      startedAt: now,
      lagMs
    };
    this.pending = null;
    this.droppedDuringActive = 0;
    this.stats.lastLagMs = lagMs;
    return this.active;
  }

  shouldPreemptActive(now = Date.now()) {
    if (!this.active || !this.pending) return false;
    // Never interrupt row 1 just to speak its own row-2 continuation.
    if (this.pending.suppressPrefixText) return false;

    const activeElapsed = now - this.active.startedAt;
    const pendingFresh = now - this.pending.lastSeenAt <= 550;
    if (!pendingFresh) return false;

    if (activeElapsed >= this.options.preemptAfterActiveMs && this.droppedDuringActive >= 1) {
      return true;
    }
    if (activeElapsed >= this.options.preemptSingleAfterActiveMs && now - this.pending.firstSeenAt >= 450) {
      return true;
    }
    return false;
  }

  onSpeechEnd(now = Date.now()) {
    if (!this.active) return;
    const finished = this.active;
    this.stats.spoken += 1;
    this.stats.lastSpeechMs = Math.max(0, now - finished.startedAt);
    this.history.unshift({
      text: finished.sourceText,
      key: finished.key,
      speaker: finished.speaker || "",
      completedAt: now
    });
    if (this.history.length > 4) this.history.length = 4;
    this.active = null;
    this.droppedDuringActive = 0;
  }

  clearQueueAndSpeech() {
    this.candidate = null;
    this.pending = null;
    this.active = null;
    this.droppedDuringActive = 0;
  }

  getSnapshot(now = Date.now()) {
    const state = this.active
      ? "SPEAKING"
      : this.pending
        ? "QUEUED"
        : this.candidate
          ? "STABILIZING"
          : "IDLE";
    return {
      state,
      hasActive: Boolean(this.active),
      hasPending: Boolean(this.pending),
      hasCandidate: Boolean(this.candidate),
      activeElapsedMs: this.active ? Math.max(0, now - this.active.startedAt) : null,
      pendingAgeMs: this.pending ? Math.max(0, now - this.pending.firstSeenAt) : null,
      lastLagMs: this.stats.lastLagMs,
      lastSpeechMs: this.stats.lastSpeechMs,
      dropped: this.stats.dropped,
      stale: this.stats.stale,
      spoken: this.stats.spoken
    };
  }

  #isCandidateReady(cand) {
    if (!cand) return false;
    // Promote on the VERY FIRST scan for any normal Russian subtitle so we never
    // pay an extra full OCR pass before TTS starts.
    if (cand.confidence >= this.options.fastStartConfidence) return true;
    if (cand.hits >= 2 && cand.confidence >= 30) return true;
    return false;
  }

  #promoteCandidate(now) {
    if (!this.candidate) return;
    if (this.pending) {
      this.stats.dropped += 1;
      if (this.active) this.droppedDuringActive += 1;
    }
    this.pending = {
      ...this.candidate,
      queuedAt: now
    };
    this.candidate = null;
  }
}
