import { PaddleOCR } from "@paddleocr/paddleocr-js";
import {
  CaptionController,
  cleanText,
  evaluateFrameGate,
  isRussianSubtitleLine,
  normalizeRussianHomoglyphs
} from "./captionController.js";

(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("camera"), canvas = $("frame");
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });

  const GATE_W = 128;
  const GATE_H = 40;
  const gateCanvas = document.createElement("canvas");
  gateCanvas.width = GATE_W;
  gateCanvas.height = GATE_H;
  const gateCtx = gateCanvas.getContext("2d", { willReadFrequently: true, alpha: false });

  const SPEED_PRESETS = {
    turbo: { maxW: 576, maxH: 256, detLimit: 512, minUpscale: 1.25 },
    balanced: { maxW: 704, maxH: 320, detLimit: 640, minUpscale: 1.45 },
    sharp: { maxW: 896, maxH: 416, detLimit: 800, minUpscale: 1.75 }
  };

  let stream = null;
  let worker = null;
  let scanning = false;
  let loopRunning = false;
  let speechEnabled = true;
  let recognitionEnabled = true;
  let audioUnlocked = false;
  let activeSpeech = false;
  let activeSpeechStartedAt = 0;
  let speechWatchdog = null;
  let voices = [];
  let cachedRuntimeReport = "";
  let consecutiveOcrErrors = 0;
  let lastProcessedVideoTime = -1;
  let lastRoiSignature = "";
  let prevGateGray = null;
  let lastFullOcrAt = 0;
  let lastHadSubtitle = false;
  let keepAliveAudioCtx = null;

  const captionController = new CaptionController();

  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round32 = (value, min = 32) => Math.max(min, Math.round(value / 32) * 32);
  const setStatus = value => { $("status").textContent = value; };

  /**
   * Keep Bluetooth A2DP / Android audio output awake with an inaudible (-80 dB) signal
   * while scanning so the first word of a new subtitle never suffers 300ms BT wakeup lag.
   */
  function startAudioKeepAlive() {
    if (keepAliveAudioCtx) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const actx = new AudioCtx();
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.frequency.value = 40;
      gain.gain.value = 0.00005;
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.start();
      if (actx.state === "suspended") actx.resume().catch(() => {});
      keepAliveAudioCtx = actx;
    } catch (_) {}
  }

  function stopAudioKeepAlive() {
    if (!keepAliveAudioCtx) return;
    const actx = keepAliveAudioCtx;
    keepAliveAudioCtx = null;
    try { actx.close(); } catch (_) {}
  }

  function updateDiagnostics(now = Date.now()) {
    const snap = captionController.getSnapshot(now);
    const queueLabel = snap.hasActive && snap.hasPending
      ? "1 + 1 ждёт"
      : snap.hasActive
        ? "1 говорит"
        : snap.hasPending
          ? "1 ждёт"
          : snap.hasCandidate
            ? "стаб…"
            : "0";
    $("queueState").textContent = queueLabel;
    $("ttsLag").textContent = snap.lastLagMs !== null ? Math.round(snap.lastLagMs) + " мс" : "—";
    const speechMs = activeSpeech && activeSpeechStartedAt
      ? now - activeSpeechStartedAt
      : snap.lastSpeechMs;
    $("speechDuration").textContent = speechMs !== null ? (speechMs / 1000).toFixed(1) + " с" : "—";
    $("droppedCount").textContent = String(snap.dropped + snap.stale);
  }

  function updateSpeechButton() {
    $("toggleSpeech").textContent = speechEnabled ? "Озвучка: ВКЛ" : "Озвучка: ВЫКЛ";
    $("toggleSpeech").setAttribute("aria-pressed", speechEnabled ? "true" : "false");
  }
  function updateRecognitionButton() {
    $("toggleRecognition").textContent = recognitionEnabled ? "Распознавание: ВКЛ" : "Распознавание: ВЫКЛ";
    $("toggleRecognition").setAttribute("aria-pressed", recognitionEnabled ? "true" : "false");
  }
  updateSpeechButton();
  updateRecognitionButton();
  updateDiagnostics();

  function invalidateFrameGate() {
    prevGateGray = null;
    lastFullOcrAt = 0;
    lastProcessedVideoTime = -1;
  }

  function updateRoi() {
    let left = clamp(Number($("roiLeft").value), 0, 80);
    let top = clamp(Number($("roiTop").value), 0, 85);
    let width = clamp(Number($("roiWidth").value), 20, 100);
    let height = clamp(Number($("roiHeight").value), 3, 70);
    left = Math.min(left, 100 - width);
    top = Math.min(top, 100 - height);

    $("roiLeft").value = String(left);
    $("roiTop").value = String(top);
    $("roiWidth").value = String(width);
    $("roiHeight").value = String(height);
    $("roiLeft").max = String(100 - width);
    $("roiTop").max = String(100 - height);

    document.documentElement.style.setProperty("--roi-left", left + "%");
    document.documentElement.style.setProperty("--roi-width", width + "%");
    document.documentElement.style.setProperty("--roi-top", top + "%");
    document.documentElement.style.setProperty("--roi-height", height + "%");
    $("roiLeftValue").textContent = left + "%";
    $("roiTopValue").textContent = top + "%";
    $("roiWidthValue").textContent = width + "%";
    $("roiHeightValue").textContent = height + "%";
    $("roiLabel").textContent = "X " + left + "% · Y " + top + "% · " + width + "% × " + height + "%";
    invalidateFrameGate();
  }
  ["roiLeft", "roiTop", "roiWidth", "roiHeight"].forEach(id => {
    $(id).addEventListener("input", updateRoi);
  });

  $("slimRoi")?.addEventListener("click", () => {
    const currentTop = Number($("roiTop").value);
    const currentHeight = Number($("roiHeight").value);
    const center = currentTop + currentHeight / 2;
    const targetHeight = 13;
    $("roiLeft").value = "6";
    $("roiWidth").value = "88";
    $("roiHeight").value = String(targetHeight);
    $("roiTop").value = String(clamp(Math.round(center - targetHeight / 2), 0, 100 - targetHeight));
    updateRoi();
  });

  $("ocrSpeed")?.addEventListener("change", invalidateFrameGate);

  let roiPointer = null;
  const guide = $("guide");
  guide.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const handle = event.target.closest("[data-handle]")?.dataset.handle || "";
    roiPointer = {
      id: event.pointerId,
      mode: handle || "move",
      startX: event.clientX,
      startY: event.clientY,
      rect: $("videoWrap").getBoundingClientRect(),
      left: Number($("roiLeft").value),
      top: Number($("roiTop").value),
      width: Number($("roiWidth").value),
      height: Number($("roiHeight").value)
    };
    guide.classList.add("dragging");
    try { guide.setPointerCapture(event.pointerId); } catch (_) {}
  });

  guide.addEventListener("pointermove", event => {
    if (!roiPointer || roiPointer.id !== event.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - roiPointer.startX) / Math.max(1, roiPointer.rect.width) * 100;
    const dy = (event.clientY - roiPointer.startY) / Math.max(1, roiPointer.rect.height) * 100;
    let left = roiPointer.left;
    let top = roiPointer.top;
    let right = left + roiPointer.width;
    let bottom = top + roiPointer.height;

    if (roiPointer.mode === "move") {
      left = clamp(roiPointer.left + dx, 0, 100 - roiPointer.width);
      top = clamp(roiPointer.top + dy, 0, 100 - roiPointer.height);
    } else {
      if (roiPointer.mode.includes("w")) left = clamp(roiPointer.left + dx, 0, right - 20);
      if (roiPointer.mode.includes("e")) right = clamp(roiPointer.left + roiPointer.width + dx, left + 20, 100);
      if (roiPointer.mode.includes("n")) top = clamp(roiPointer.top + dy, 0, bottom - 3);
      if (roiPointer.mode.includes("s")) bottom = clamp(roiPointer.top + roiPointer.height + dy, top + 3, 100);
    }

    if (roiPointer.mode !== "move") {
      left = Math.round(left);
      top = Math.round(top);
      right = Math.round(right);
      bottom = Math.round(bottom);
      $("roiLeft").value = String(left);
      $("roiTop").value = String(top);
      $("roiWidth").value = String(Math.max(20, right - left));
      $("roiHeight").value = String(Math.max(3, bottom - top));
    } else {
      $("roiLeft").value = String(Math.round(left));
      $("roiTop").value = String(Math.round(top));
    }
    updateRoi();
  });

  function finishRoiPointer(event) {
    if (!roiPointer || roiPointer.id !== event.pointerId) return;
    roiPointer = null;
    guide.classList.remove("dragging");
    try {
      if (guide.hasPointerCapture(event.pointerId)) guide.releasePointerCapture(event.pointerId);
    } catch (_) {}
  }
  guide.addEventListener("pointerup", finishRoiPointer);
  guide.addEventListener("pointercancel", finishRoiPointer);
  updateRoi();

  function refreshVoices() {
    voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    ["defaultVoice", "jasonVoice", "luciaVoice"].forEach(id => {
      const select = $(id);
      const previous = select.value;
      select.innerHTML = "";
      const first = document.createElement("option");
      first.value = "";
      first.textContent = id === "defaultVoice" ? "Русский голос Android по умолчанию" : "Автоматически";
      select.appendChild(first);
      voices.forEach((voice, index) => {
        if (/^ru/i.test(voice.lang)) {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = voice.name + " · " + voice.lang;
          select.appendChild(option);
        }
      });
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
    });
  }

  if ("speechSynthesis" in window) {
    speechSynthesis.onvoiceschanged = refreshVoices;
    refreshVoices();
  }

  function voiceFor(speaker) {
    const id = /lucia/i.test(speaker) ? "luciaVoice" : /jason/i.test(speaker) ? "jasonVoice" : "defaultVoice";
    const selected = $(id).value || (id !== "defaultVoice" ? $("defaultVoice").value : "");
    if (selected) return voices[Number(selected)] || null;
    return voices.find(voice => /^ru/i.test(voice.lang)) || null;
  }

  function pumpSpeechQueue() {
    const now = Date.now();
    if (!speechEnabled || !audioUnlocked || !("speechSynthesis" in window)) {
      updateDiagnostics(now);
      return;
    }

    if (activeSpeech) {
      if (captionController.shouldPreemptActive(now)) {
        try { speechSynthesis.cancel(); } catch (_) {}
        if (speechWatchdog) window.clearTimeout(speechWatchdog);
        speechWatchdog = null;
        captionController.onSpeechEnd(now);
        activeSpeech = false;
        activeSpeechStartedAt = 0;
      } else {
        updateDiagnostics(now);
        return;
      }
    }

    const item = captionController.pullNextUtterance(now);
    if (!item) {
      updateDiagnostics(now);
      return;
    }

    activeSpeech = true;
    activeSpeechStartedAt = now;
    updateDiagnostics(now);

    let finished = false;
    const utterance = new SpeechSynthesisUtterance(item.speechText);
    utterance.lang = "ru-RU";
    const baseRate = Number($("rate").value);
    const catchUpBoost = item.lagMs > 1200 ? 0.24 : item.lagMs > 450 ? 0.12 : 0;
    utterance.rate = clamp(baseRate + catchUpBoost, 0.85, 1.65);
    utterance.volume = Number($("volume").value);
    const voice = voiceFor(item.speaker);
    if (voice) utterance.voice = voice;

    const armWatchdog = () => {
      if (speechWatchdog) window.clearTimeout(speechWatchdog);
      speechWatchdog = window.setTimeout(() => {
        if (finished) return;
        console.warn("TTS watchdog: forcing queue recovery");
        try { speechSynthesis.cancel(); } catch (_) {}
        finishSpeech();
      }, 12000);
    };

    function finishSpeech() {
      if (finished) return;
      finished = true;
      const endedAt = Date.now();
      if (speechWatchdog) window.clearTimeout(speechWatchdog);
      speechWatchdog = null;
      captionController.onSpeechEnd(endedAt);
      activeSpeech = false;
      activeSpeechStartedAt = 0;
      $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена";
      updateDiagnostics(endedAt);
      window.setTimeout(pumpSpeechQueue, 0);
    }

    utterance.onstart = () => {
      activeSpeechStartedAt = Date.now();
      $("speechState").textContent = "Говорит";
      updateDiagnostics(activeSpeechStartedAt);
      armWatchdog();
    };
    utterance.onboundary = armWatchdog;
    utterance.onend = finishSpeech;
    utterance.onerror = event => {
      console.warn("Speech synthesis error", event);
      $("speechState").textContent = "Повторяю очередь после ошибки";
      finishSpeech();
    };

    try {
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(utterance);
      armWatchdog();
    } catch (error) {
      console.error(error);
      $("speechState").textContent = "Ошибка TTS";
      finishSpeech();
    }
  }

  function cancelSpeechAndQueue() {
    captionController.clearQueueAndSpeech();
    if (speechWatchdog) window.clearTimeout(speechWatchdog);
    speechWatchdog = null;
    activeSpeech = false;
    activeSpeechStartedAt = 0;
    if ("speechSynthesis" in window) {
      try { speechSynthesis.cancel(); } catch (_) {}
    }
    updateDiagnostics();
  }

  function parsePaddleResult(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    const boxes = items.map((item, index) => {
      const points = Array.isArray(item.poly)
        ? item.poly.filter(point => Array.isArray(point) && point.length >= 2 &&
          Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
        : [];
      const xs = points.map(point => Number(point[0]));
      const ys = points.map(point => Number(point[1]));
      const minX = xs.length ? Math.min(...xs) : index;
      const maxX = xs.length ? Math.max(...xs) : index + 1;
      const minY = ys.length ? Math.min(...ys) : index;
      const maxY = ys.length ? Math.max(...ys) : index + 1;
      const rawScore = Number(item.score);
      const confidence = Number.isFinite(rawScore)
        ? (rawScore <= 1 ? rawScore * 100 : rawScore)
        : 0;
      return {
        text: cleanText(item.text),
        confidence,
        left: minX,
        centerY: (minY + maxY) / 2,
        height: Math.max(1, maxY - minY),
        index
      };
    }).filter(item => item.text).sort((a, b) =>
      a.centerY - b.centerY || a.left - b.left
    );

    const rows = [];
    for (const item of boxes) {
      let row = rows.find(candidate =>
        Math.abs(candidate.centerY - item.centerY) <=
        Math.max(candidate.height, item.height) * 0.62
      );
      if (!row) {
        row = { centerY: item.centerY, height: item.height, items: [] };
        rows.push(row);
      }
      row.items.push(item);
      const count = row.items.length;
      row.centerY = row.items.reduce((sum, entry) => sum + entry.centerY, 0) / count;
      row.height = row.items.reduce((sum, entry) => sum + entry.height, 0) / count;
    }

    const lines = rows.sort((a, b) => a.centerY - b.centerY).map(row => {
      const ordered = row.items.sort((a, b) => a.left - b.left);
      return {
        text: cleanText(ordered.map(item => item.text).join(" ")),
        confidence: ordered.reduce((sum, item) => sum + item.confidence, 0) / ordered.length
      };
    }).filter(line => line.text);

    const parsed = parseSubtitle({ lines });
    const debugRows = lines.map(line =>
      "[" + Math.round(line.confidence) + "%] " + line.text
    );
    return {
      ...parsed,
      report: (parsed.report || "PaddleOCR: строки не найдены.") +
        (debugRows.length ? "\n\nPaddleOCR строки:\n" + debugRows.join("\n") : "")
    };
  }

  function parseSubtitle(data) {
    const namePattern = /^(Jason|Lucia|Tourist)\s*[:：-]?\s*/i;
    const lines = Array.isArray(data.lines) && data.lines.length
      ? data.lines.map(line => ({ text: cleanText(line.text), confidence: Number(line.confidence) }))
      : (data.text || "").split(/\r?\n/).map(text => ({ text: cleanText(text), confidence: Number(data.confidence) }));

    let speaker = "";
    const accepted = [];
    const report = [];
    for (const line of lines) {
      if (!line.text) continue;
      let lineText = line.text;
      if ($("showNames").checked) {
        const match = lineText.match(namePattern);
        if (match) {
          speaker = match[1];
          lineText = cleanText(lineText.slice(match[0].length));
          if (!lineText) {
            report.push("NAME · " + line.text);
            continue;
          }
        }
      }
      lineText = normalizeRussianHomoglyphs(lineText);
      const ok = isRussianSubtitleLine(lineText);
      report.push((ok ? "OK" : "SKIP") + " [" +
        (Number.isFinite(line.confidence) ? Math.round(line.confidence) : "?") +
        "%] " + lineText);
      if (ok) accepted.push({ text: lineText, confidence: line.confidence });
    }

    const text = cleanText(accepted.map(line => line.text).join(" "))
      .replace(/[^А-Яа-яЁё0-9 .,!?…:;()'’«»\-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 2 || text.length > 180) {
      return { subtitle: null, report: report.join("\n") || "Нет текстовых строк в зоне сканирования." };
    }
    const confidences = accepted.map(line => line.confidence).filter(Number.isFinite);
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : Number(data.confidence) || 0;
    return {
      subtitle: { text, speaker, confidence, lineCount: accepted.length },
      report: report.join("\n")
    };
  }

  function currentSpeedPreset() {
    const key = $("ocrSpeed")?.value || "turbo";
    return SPEED_PRESETS[key] || SPEED_PRESETS.turbo;
  }

  /**
   * 1) Fast 128x40 gate check (<0.4ms) skips duplicate/empty frames so the WASM worker
   *    stays immediately ready for new dialogue.
   * 2) Compact stride-32 crop (576px default in Turbo) slashes DBNet detMs ~3.5x while
   *    preserving native portrait sensor sharpness without artificial dark-border boxes.
   */
  function prepareRecognitionImage(now) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return { kind: "invalid" };

    const leftPct = Number($("roiLeft").value);
    const topPct = Number($("roiTop").value);
    const widthPct = Number($("roiWidth").value);
    const heightPct = Number($("roiHeight").value);
    const roiSig = leftPct + ":" + topPct + ":" + widthPct + ":" + heightPct;

    const sx = Math.floor(vw * leftPct / 100);
    const sy = Math.floor(vh * topPct / 100);
    const sw = Math.min(Math.floor(vw * widthPct / 100), vw - sx);
    const sh = Math.min(Math.floor(vh * heightPct / 100), vh - sy);
    if (sw < 16 || sh < 12) return { kind: "invalid" };

    const currentVideoTime = Number(video.currentTime) || 0;
    if (currentVideoTime > 0 && currentVideoTime === lastProcessedVideoTime && roiSig === lastRoiSignature) {
      return { kind: "skip", reason: "same-video-frame" };
    }
    lastProcessedVideoTime = currentVideoTime;
    lastRoiSignature = roiSig;

    gateCtx.drawImage(video, sx, sy, sw, sh, 0, 0, GATE_W, GATE_H);
    const gateData = gateCtx.getImageData(0, 0, GATE_W, GATE_H).data;
    const gate = evaluateFrameGate(
      gateData,
      GATE_W,
      GATE_H,
      { prevGray: prevGateGray, lastFullOcrAt, lastHadSubtitle },
      now
    );
    if (!gate.run) {
      return { kind: "skip", reason: gate.reason };
    }

    const preset = currentSpeedPreset();
    const scale = Math.min(preset.minUpscale, preset.maxW / sw, preset.maxH / sh);
    const outW = round32(Math.min(preset.maxW, sw * scale), 64);
    const outH = round32(Math.min(preset.maxH, sh * scale), 32);

    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.filter = "grayscale(1) contrast(1.33)";
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    ctx.filter = "none";

    return { kind: "ready", image: canvas, gateGray: gate.gray, preset };
  }

  async function scanLoop() {
    if (loopRunning) return;
    loopRunning = true;

    while (scanning) {
      if (!recognitionEnabled) {
        $("ocrState").textContent = "Распознавание остановлено";
        await wait(140);
        continue;
      }
      if (!worker || video.readyState < 2 || !video.videoWidth) {
        $("ocrState").textContent = "Жду кадр камеры…";
        await wait(100);
        continue;
      }

      const started = performance.now();
      const captureNow = Date.now();
      try {
        const prepared = prepareRecognitionImage(captureNow);
        if (prepared.kind === "invalid") {
          $("ocrState").textContent = "Проверь рамку";
          await wait(180);
          continue;
        }
        if (prepared.kind === "skip") {
          if (prepared.reason === "empty-scene") {
            captionController.observe({ text: "", confidence: 0 }, captureNow);
            pumpSpeechQueue();
          }
          await wait(24);
          continue;
        }

        const [result] = await worker.predict(prepared.image, {
          textDetLimitSideLen: prepared.preset.detLimit,
          textDetLimitType: "max",
          textRecScoreThresh: 0.15,
          textDetThresh: 0.25,
          textDetBoxThresh: 0.35
        });
        const parsed = parsePaddleResult(result);

        prevGateGray = prepared.gateGray;
        lastFullOcrAt = Date.now();
        consecutiveOcrErrors = 0;

        const metrics = result?.metrics || {};
        const totalMs = Number(metrics.totalMs);
        const detMs = Number(metrics.detMs);
        const recMs = Number(metrics.recMs);
        const measuredMs = Number.isFinite(totalMs) ? totalMs : performance.now() - started;
        const timingParts = [];
        if (Number.isFinite(detMs)) timingParts.push("дет. " + Math.round(detMs));
        if (Number.isFinite(recMs)) timingParts.push("текст " + Math.round(recMs));
        timingParts.push(canvas.width + "×" + canvas.height);
        if (Number.isFinite(Number(metrics.recognizedCount))) {
          timingParts.push("стр. " + Number(metrics.recognizedCount));
        }
        $("latency").textContent = Math.round(measuredMs) + " мс · " + timingParts.join(" / ");

        if ($("debugOcr")?.open) {
          if (!cachedRuntimeReport) {
            if (result?.runtime) {
              try {
                cachedRuntimeReport = "Runtime: " + JSON.stringify({
                  bundle: "onnxruntime-web",
                  ...result.runtime,
                  mode: "known-good-wasm-v0.53",
                  detector: { model: "PP-OCRv5_mobile_det", thresh: 0.25, boxThresh: 0.35 }
                });
              } catch (_) {
                cachedRuntimeReport = "Runtime: метаданные получены";
              }
            } else {
              cachedRuntimeReport = "Runtime: metadata недоступна";
            }
          }
          $("rawText").textContent = parsed.report + "\n\n" + cachedRuntimeReport;
        }

        const now = Date.now();
        const subtitle = parsed.subtitle;
        if (!subtitle) {
          lastHadSubtitle = false;
          $("ocrState").textContent = "Ожидание реплики";
          $("lastText").textContent = "Чистая русская реплика пока не найдена.";
          captionController.observe({ text: "", confidence: 0 }, now);
        } else {
          lastHadSubtitle = true;
          $("ocrState").textContent = "Субтитры найдены";
          $("lastText").textContent = (subtitle.speaker ? subtitle.speaker + ": " : "") + subtitle.text;
          captionController.observe(subtitle, now);
        }
        pumpSpeechQueue();
      } catch (error) {
        consecutiveOcrErrors++;
        invalidateFrameGate();
        console.error("OCR error", error);
        const errorText = error && error.message ? error.message : String(error);
        $("ocrState").textContent = "Ошибка OCR · повторяю";
        $("lastText").textContent = "Сбой распознавания: " + errorText;
        if (consecutiveOcrErrors >= 2 && scanning) {
          $("ocrState").textContent = "Перезапускаю PaddleOCR…";
          try {
            const failedWorker = worker;
            worker = null;
            if (failedWorker) {
              try { await failedWorker.dispose(); } catch (terminateError) {
                console.warn("PaddleOCR dispose:", terminateError);
              }
            }
            if (scanning) {
              worker = await createOcrWorker();
              consecutiveOcrErrors = 0;
              $("ocrState").textContent = "PaddleOCR перезапущен";
              $("lastText").textContent = "Распознавание восстановлено. Жду субтитры…";
            }
          } catch (restartError) {
            console.error("OCR restart failed", restartError);
            $("ocrState").textContent = "Не удалось перезапустить OCR";
            $("lastText").textContent = "Ошибка перезапуска: " +
              (restartError && restartError.message ? restartError.message : String(restartError));
          }
        }
      }

      await wait(6);
    }

    loopRunning = false;
  }

  async function createOcrWorker() {
    $("ocrState").textContent = "Загружаю модель PaddleOCR…";
    $("lastText").textContent = "Загружаю проверенную русскую OCR-модель в штатном режиме WASM.";
    const modelBase = new URL(import.meta.env.BASE_URL, window.location.origin);
    const engine = await PaddleOCR.create({
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textRecognitionModelName: "eslav_PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: {
        url: new URL("models/eslav_PP-OCRv5_mobile_rec.tar", modelBase).href
      },
      worker: true,
      ortOptions: {
        backend: "wasm",
        numThreads: 1,
        simd: true
      }
    });
    return engine;
  }

  $("startCamera").addEventListener("click", async () => {
    audioUnlocked = true;
    startAudioKeepAlive();
    updateSpeechButton();
    if ("speechSynthesis" in window) {
      try {
        speechSynthesis.resume();
        const unlockUtterance = new SpeechSynthesisUtterance(" ");
        unlockUtterance.lang = "ru-RU";
        unlockUtterance.volume = 0;
        speechSynthesis.speak(unlockUtterance);
      } catch (_) {}
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Открой страницу через HTTPS в Chrome и разреши камеру.");
      setStatus("Запуск камеры…");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      });

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack?.getCapabilities && videoTrack?.applyConstraints) {
        try {
          const caps = videoTrack.getCapabilities();
          const advanced = {};
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
            advanced.focusMode = "continuous";
          }
          if (Object.keys(advanced).length) {
            await videoTrack.applyConstraints({ advanced: [advanced] });
          }
        } catch (_) {}
      }

      video.srcObject = stream;
      await video.play();
      if (video.videoWidth && video.videoHeight) {
        $("videoWrap").style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
      }
      $("videoWrap").classList.add("camera-active");
      $("placeholder").hidden = true;
      $("startCamera").disabled = true;
      $("stopCamera").disabled = false;
      $("speechState").textContent = speechEnabled ? "Озвучка готова" : "Остановлена";
      setStatus("Загрузка OCR…");
      $("ocrState").textContent = "Загрузка русского OCR…";

      invalidateFrameGate();
      lastHadSubtitle = false;
      captionController.reset();
      updateDiagnostics();
      worker = await createOcrWorker();
      scanning = true;
      document.body.classList.add("running");
      setStatus("Камера работает");
      scanLoop();
    } catch (error) {
      console.error(error);
      stopAudioKeepAlive();
      setStatus("Не удалось запустить");
      $("lastText").textContent = "Ошибка: " + (error.message || String(error));
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null;
      $("videoWrap").classList.remove("camera-active");
      $("placeholder").hidden = false;
      $("startCamera").disabled = false;
      $("stopCamera").disabled = true;
    }
  });

  $("stopCamera").addEventListener("click", async () => {
    scanning = false;
    stopAudioKeepAlive();
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    $("videoWrap").classList.remove("camera-active");
    if (worker) {
      const oldWorker = worker;
      worker = null;
      try { await oldWorker.dispose(); } catch (_) {}
    }
    while (loopRunning) await wait(25);
    cancelSpeechAndQueue();
    captionController.reset();
    invalidateFrameGate();
    updateDiagnostics();
    $("placeholder").hidden = false;
    $("startCamera").disabled = false;
    $("stopCamera").disabled = true;
    $("ocrState").textContent = "Остановлено";
    $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена";
    document.body.classList.remove("running");
    setStatus("Остановлено");
  });

  $("toggleRecognition").addEventListener("click", () => {
    recognitionEnabled = !recognitionEnabled;
    captionController.clearQueueAndSpeech();
    invalidateFrameGate();
    updateDiagnostics();
    updateRecognitionButton();
    $("ocrState").textContent = recognitionEnabled
      ? (scanning ? "Распознавание включено" : "Ожидание")
      : "Распознавание остановлено";
    if (recognitionEnabled && scanning) {
      $("lastText").textContent = "Жду новые субтитры…";
    }
  });

  $("toggleSpeech").addEventListener("click", () => {
    audioUnlocked = true;
    speechEnabled = !speechEnabled;
    updateSpeechButton();
    if (!speechEnabled) {
      cancelSpeechAndQueue();
      $("speechState").textContent = "Остановлена";
    } else {
      startAudioKeepAlive();
      $("speechState").textContent = "Включена";
      if ("speechSynthesis" in window) {
        try { speechSynthesis.resume(); } catch (_) {}
      }
      pumpSpeechQueue();
    }
  });

  function speakStandalone(text) {
    if (!("speechSynthesis" in window) || !text) return;
    audioUnlocked = true;
    startAudioKeepAlive();
    cancelSpeechAndQueue();
    activeSpeech = true;
    activeSpeechStartedAt = Date.now();
    let done = false;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = Number($("rate").value);
    utterance.volume = Number($("volume").value);
    const voice = voiceFor("");
    if (voice) utterance.voice = voice;

    const finish = () => {
      if (done) return;
      done = true;
      if (speechWatchdog) window.clearTimeout(speechWatchdog);
      speechWatchdog = null;
      activeSpeech = false;
      activeSpeechStartedAt = 0;
      $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена";
      updateDiagnostics();
      pumpSpeechQueue();
    };
    const armWatchdog = () => {
      if (speechWatchdog) window.clearTimeout(speechWatchdog);
      speechWatchdog = window.setTimeout(() => {
        try { speechSynthesis.cancel(); } catch (_) {}
        finish();
      }, 12000);
    };

    utterance.onstart = () => {
      activeSpeechStartedAt = Date.now();
      $("speechState").textContent = "Говорит";
      armWatchdog();
    };
    utterance.onboundary = armWatchdog;
    utterance.onend = finish;
    utterance.onerror = finish;
    try {
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(utterance);
      armWatchdog();
    } catch (error) {
      console.error(error);
      $("speechState").textContent = "Ошибка TTS";
      finish();
    }
  }

  $("testSpeech").addEventListener("click", () => {
    refreshVoices();
    speakStandalone("Проверка русского голоса. GTA шесть, слышишь меня?");
  });

  $("speakManual").addEventListener("click", () => {
    speakStandalone(cleanText($("manualText").value));
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && scanning && "speechSynthesis" in window) {
      if (keepAliveAudioCtx?.state === "suspended") {
        keepAliveAudioCtx.resume().catch(() => {});
      }
      try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch (_) {}
      pumpSpeechQueue();
    }
  });

  $("rate").addEventListener("input", event => $("rateValue").textContent = Number(event.target.value).toFixed(2) + "×");
  $("volume").addEventListener("input", event => $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%");
})();
