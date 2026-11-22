const HOMOGLYPH_MAP = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У",
  a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у"
};

const NON_HOMOGLYPH_LATIN = /[DFGIJLNQRSUVWZbdfghijklmnqrstuvwz]/;
const VALID_SINGLE_LETTER_WORDS = new Set(["а", "и", "о", "у", "я", "в", "к", "с", "ж", "б"]);

export const cleanText = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Fix Latin lookalike characters produced by OCR inside Russian subtitle lines
 * without touching genuine English UI prompts (e.g. "Press X to skip" or "GTA").
 */
export function normalizeRussianHomoglyphs(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const cyrillicCount = (cleaned.match(/[А-Яа-яЁё]/g) || []).length;
  if (cyrillicCount < 1) return cleaned;

  return cleaned.split(" ").map(token => {
    const core = token.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    if (!core || NON_HOMOGLYPH_LATIN.test(core)) return token;

    const hasCyrillic = /[А-Яа-яЁё]/.test(core);
    const isShortHomoglyphWord = cyrillicCount >= 2 && /^[ABCEHKMOPTXYaceopxy]{1,2}$/.test(core);
    if (!hasCyrillic && !isShortHomoglyphWord) return token;

    return token.replace(/[ABCEHKMOPTXYaceopxy]/g, ch => HOMOGLYPH_MAP[ch] || ch);
  }).join(" ");
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

/**
 * Determine how nextText relates to previousText:
 * - same: identical or minor OCR fix/punctuation/space variation
 * - partial: subset of an already-read caption (top row only, bottom row only, or edge clip)
 * - extension: two-line continuation or rolling overlap; delta contains ONLY unspoken words
 * - new: independent subtitle
 */
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

  // Same word count or near-identical character string.
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

  // Next is longer: check prefix/near-prefix, including a missed 1-2 leading words.
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

  // Next is shorter: contiguous subsequence anywhere (top row, bottom row, or middle).
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

  // Rolling subtitle overlap: suffix of previous matches prefix of next.
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

export class CaptionController {
  constructor(options = {}) {
    this.options = {
      uncertainHoldMs: 110,
      emptyGraceMs: 260,
      clearHistoryAfterEmptyMs: 1300,
      historyWindowMs: 4800,
      extensionAfterDoneWindowMs: 2400,
      maxUnseenAgeMs: 1150,
      staleAfterUnseenTotalMs: 2000,
      maxPendingAgeMs: 3200,
      preemptAfterActiveMs: 3600,
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
        if (this.candidate.hits >= 2 || this.candidate.confidence >= 56) {
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

    // Compare against active speech (protects against row flicker and extracts row-2 delta).
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

    // Compare against pending item and refine it in place.
    if (this.pending) {
      const sameSpeakerOrUnknown = !speaker || !this.pending.speaker || speaker === this.pending.speaker;
      const relPending = analyzeCaptionRelation(this.pending.sourceText, rawText);
      if (sameSpeakerOrUnknown && relPending.type === "same") {
        this.pending.lastSeenAt = now;
        if (confidence >= this.pending.confidence && rawText.length >= this.pending.sourceText.length) {
          const updatedSpeech = this.pending.suppressPrefixText
            ? analyzeCaptionRelation(this.pending.suppressPrefixText, rawText).delta
            : rawText;
          if (updatedSpeech && normalizeKey(updatedSpeech).length >= 2) {
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
        if (updatedSpeech && normalizeKey(updatedSpeech).length >= 2) {
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

    // Compare against recently spoken history.
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

    if (!speechText || normalizeKey(speechText).length < 2) {
      return this.getSnapshot(now);
    }

    // Fast-path for clear/two-line captions; briefly stabilize uncertain fragments.
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

    if (this.#isCandidateReady(this.candidate, now)) {
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
    const activeElapsed = now - this.active.startedAt;
    const pendingFresh = now - this.pending.lastSeenAt <= 500;
    return activeElapsed >= this.options.preemptAfterActiveMs &&
      pendingFresh &&
      this.droppedDuringActive >= 1;
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

  #isCandidateReady(cand, now) {
    if (!cand) return false;
    if (this.active && cand.confidence >= 52) return true;

    const wordsCount = cand.speechText.split(/\s+/).filter(Boolean).length;
    const hasTerminalPunct = /[.!?…]$/.test(cand.sourceText);

    if (cand.lineCount >= 2 && cand.confidence >= 56) return true;
    if (cand.confidence >= 68 && (hasTerminalPunct || wordsCount >= 3)) return true;
    if (cand.confidence >= 78) return true;
    if (cand.hits >= 2 && cand.confidence >= 45) return true;
    if (now - cand.firstSeenAt >= this.options.uncertainHoldMs && cand.confidence >= 52) return true;
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
