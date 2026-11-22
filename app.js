import { PaddleOCR } from "@paddleocr/paddleocr-js";

(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("camera"), canvas = $("frame");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let stream = null;
  let worker = null;
  let scanning = false;
  let loopRunning = false;
  let speechEnabled = true;
  let recognitionEnabled = true;
  let audioUnlocked = false;
  let activeSpeech = false;
  let speechWatchdog = null;
  let voices = [];
  let previousCandidate = "";
  let candidateCount = 0;
  let lastEnqueuedKey = "";
  let recentQueuedCaptions = [];
  let lastEmptyStartedAt = 0;
  let emptyCaptionReads = 0;
  let lastScanAt = 0;
  let consecutiveOcrErrors = 0;
  let consecutiveEmptyReads = 0;
  const queue = [];

  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const clean = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();
  const normalize = value => clean(value).toLocaleLowerCase("ru-RU")
    .replace(/[^а-яёa-z0-9 ]/gi, "").replace(/\s+/g, " ").trim();
  const setStatus = value => { $("status").textContent = value; };
  const setQueueCount = () => { $("queueState").textContent = String(queue.length + (activeSpeech ? 1 : 0)); };
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

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function updateRoi() {
    let left = clamp(Number($("roiLeft").value), 0, 80);
    let top = clamp(Number($("roiTop").value), 0, 80);
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
  }
  ["roiLeft", "roiTop", "roiWidth", "roiHeight"].forEach(id => {
    $(id).addEventListener("input", updateRoi);
  });

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
    if (!speechEnabled || !audioUnlocked || activeSpeech || !queue.length || !("speechSynthesis" in window)) {
      setQueueCount();
      return;
    }

    const item = queue.shift();
    activeSpeech = true;
    setQueueCount();

    let finished = false;
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = "ru-RU";
    utterance.rate = Number($("rate").value);
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
      }, 20000);
    };

    function finishSpeech() {
      if (finished) return;
      finished = true;
      if (speechWatchdog) window.clearTimeout(speechWatchdog);
      speechWatchdog = null;
      activeSpeech = false;
      $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена";
      setQueueCount();
      window.setTimeout(pumpSpeechQueue, 40);
    }

    utterance.onstart = () => {
      $("speechState").textContent = "Говорит";
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
      speechSynthesis.resume();
      speechSynthesis.speak(utterance);
      // Some Android WebViews do not fire onstart reliably. Keep a recovery timer from enqueue time.
      armWatchdog();
    } catch (error) {
      console.error(error);
      $("speechState").textContent = "Ошибка TTS";
      finishSpeech();
    }
  }

  function cancelSpeechAndQueue() {
    queue.length = 0;
    if (speechWatchdog) window.clearTimeout(speechWatchdog);
    speechWatchdog = null;
    activeSpeech = false;
    if ("speechSynthesis" in window) {
      try { speechSynthesis.cancel(); } catch (_) {}
    }
    setQueueCount();
  }

  const SHORT_RUSSIAN_WORDS = new Set([
    "а","и","о","у","я","ё","в","к","с","н","не","ни","на","но","ну","да","до","за","из","от","об",
    "во","вы","мы","ты","он","она","они","оно","по","под","при","про","то","те","это","эта","эти",
    "же","ли","бы","ах","ох","ой","эй","ух","их","им","ему","ей","её","всё","все","так","как",
    "там","тут","где","кто","что","чем","чей","мой","твой","ваш","наш"
  ]);
  const RUSSIAN_VOWELS = /[аеёиоуыэюя]/i;
  const RUSSIAN_CONSONANT_RUN = /[бвгджзйклмнпрстфхцчшщ]{5,}/i;

  function isRussianSubtitleLine(line, confidence) {
    const value = clean(line);
    const letters = value.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    const cyrillic = value.match(/[А-Яа-яЁё]/g) || [];
    if (cyrillic.length < 1 || !letters.length) return false;
    if (cyrillic.length / letters.length < 0.82) return false;
    // OCR может занижать confidence у верхней строки двухстрочного субтитра.
    // Не отбрасываем строку только из-за confidence: сначала проверяем сам русский текст.
    const words = value.split(/\s+/).filter(Boolean);
    const tinyWords = words.filter(word => /^[А-Яа-яЁё]$/i.test(word)).length;
    if (tinyWords > 2 || tinyWords / Math.max(1, words.length) > 0.3) return false;
    if (cyrillic.length > 1 && !/[аеёиоуыэюя]/i.test(value)) return false;
    return true;
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
        text: clean(item.text),
        confidence,
        left: minX,
        centerY: (minY + maxY) / 2,
        height: Math.max(1, maxY - minY),
        index
      };
    }).filter(item => item.text).sort((a, b) =>
      a.centerY - b.centerY || a.left - b.left
    );

    // Paddle returns detected text regions. Group horizontally adjacent regions
    // on the same visual row, then preserve the top-to-bottom reading order.
    const rows = [];
    for (const item of boxes) {
      let row = rows.find(candidate =>
        Math.abs(candidate.centerY - item.centerY) <=
        Math.max(candidate.height, item.height) * 0.55
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
        text: clean(ordered.map(item => item.text).join(" ")),
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
      ? data.lines.map(line => ({ text: clean(line.text), confidence: Number(line.confidence) }))
      : (data.text || "").split(/\r?\n/).map(text => ({ text: clean(text), confidence: Number(data.confidence) }));

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
          lineText = clean(lineText.slice(match[0].length));
          if (!lineText) {
            report.push("NAME · " + line.text);
            continue;
          }
        }
      }
      const ok = isRussianSubtitleLine(lineText, line.confidence);
      report.push((ok ? "OK" : "SKIP") + " [" +
        (Number.isFinite(line.confidence) ? Math.round(line.confidence) : "?") +
        "%] " + line.text);
      if (ok) accepted.push({ text: lineText, confidence: line.confidence });
    }

    const text = clean(accepted.map(line => line.text).join(" "))
      .replace(/[^А-Яа-яЁё0-9 .,!?…:;()'’\-]/g, "")
      .replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 180) {
      return { subtitle: null, report: report.join("\n") || "Нет текстовых строк в зоне сканирования." };
    }
    const confidences = accepted.map(line => line.confidence).filter(Number.isFinite);
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : Number(data.confidence) || 0;
    return {
      subtitle: { text, speaker, confidence },
      report: report.join("\n")
    };
  }

  function similarCaption(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const left = a.replace(/\s+/g, " ").trim();
    const right = b.replace(/\s+/g, " ").trim();
    const maxLength = Math.max(left.length, right.length);
    if (!maxLength || Math.abs(left.length - right.length) / maxLength > 0.22) return false;

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
    return 1 - previous[right.length] / maxLength >= 0.84;
  }

  function prepareRecognitionImage() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    canvas.width = Math.min(1280, width);
    canvas.height = Math.round(height * canvas.width / width);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const cropX = Math.floor(canvas.width * Number($("roiLeft").value) / 100);
    const cropY = Math.floor(canvas.height * Number($("roiTop").value) / 100);
    const cropWidth = Math.min(
      Math.floor(canvas.width * Number($("roiWidth").value) / 100),
      canvas.width - cropX
    );
    const cropHeight = Math.min(
      Math.floor(canvas.height * Number($("roiHeight").value) / 100),
      canvas.height - cropY
    );
    if (cropHeight < 10 || cropWidth < 10) return null;

    const processed = document.createElement("canvas");
    processed.width = Math.round(cropWidth * 1.8);
    processed.height = Math.round(cropHeight * 1.8);
    const pctx = processed.getContext("2d", { willReadFrequently: true });
    pctx.filter = "grayscale(1) contrast(1.35)";
    pctx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, processed.width, processed.height);
    pctx.filter = "none";
    return processed;
  }

  async function scanLoop() {
    if (loopRunning) return;
    loopRunning = true;

    while (scanning) {
      if (!recognitionEnabled) {
        $("ocrState").textContent = "Распознавание остановлено";
        await wait(200);
        continue;
      }
      // Never exit the scan loop just because the camera is between video frames.
      if (!worker || video.readyState < 2 || !video.videoWidth) {
        $("ocrState").textContent = "Жду кадр камеры…";
        await wait(250);
        continue;
      }

      const started = performance.now();
      try {
        const image = prepareRecognitionImage();
        if (!image) {
          $("ocrState").textContent = "Проверь рамку";
          await wait(250);
          continue;
        }

        const [result] = await worker.predict(image, {
          // Override PaddleOCR.js 0.4.2's internal 64px/min pipeline default.
          // Match the PP-OCRv5 mobile detector's official 960px/max inference setting.
          textDetLimitType: "max",
          textDetLimitSideLen: 960,
          // Keep borderline subtitle rows so the app can stabilize them across frames.
          textRecScoreThresh: 0.15,
          textDetThresh: 0.25,
          textDetBoxThresh: 0.35
        });
        const parsed = parsePaddleResult(result);

        consecutiveOcrErrors = 0;
        const metrics = result?.metrics || {};
        const totalMs = Number(metrics.totalMs);
        const detMs = Number(metrics.detMs);
        const recMs = Number(metrics.recMs);
        const measuredMs = Number.isFinite(totalMs) ? totalMs : performance.now() - started;
        const timingParts = [];
        if (Number.isFinite(detMs)) timingParts.push("дет. " + Math.round(detMs));
        if (Number.isFinite(recMs)) timingParts.push("текст " + Math.round(recMs));
        if (Number.isFinite(Number(metrics.detectedBoxes))) timingParts.push("области " + Number(metrics.detectedBoxes));
        if (Number.isFinite(Number(metrics.recognizedCount))) timingParts.push("строки " + Number(metrics.recognizedCount));
        $("latency").textContent = Math.round(measuredMs) + " мс OCR" +
          (timingParts.length ? " · " + timingParts.join(" / ") : "");

        const subtitle = parsed.subtitle;
        let runtimeReport = "Runtime: metadata недоступна";
        if (result?.runtime) {
          try {
            runtimeReport = "Runtime: " + JSON.stringify({
              bundle: "onnxruntime-web/webgpu",
              ...result.runtime,
              inputSize: result?.image ? result.image.width + "x" + result.image.height : "unknown",
              detector: { limitType: "max", limitSideLen: 960, thresh: 0.25, boxThresh: 0.35 }
            });
          } catch (_) {
            runtimeReport = "Runtime: метаданные получены";
          }
        }
        $("rawText").textContent = parsed.report + "\n\n" + runtimeReport;
        if (!subtitle) {
          $("ocrState").textContent = "Фильтр отсеял шум";
          $("lastText").textContent = "Чистая русская реплика пока не найдена.";
          previousCandidate = "";
          candidateCount = 0;
          emptyCaptionReads++;
          consecutiveEmptyReads++;
          if (!lastEmptyStartedAt) lastEmptyStartedAt = Date.now();
          // Only unlock the last spoken line after it has genuinely disappeared for 5 seconds.
          if (Date.now() - lastEmptyStartedAt >= 5000) {
            lastEnqueuedKey = "";
            lastEmptyStartedAt = 0;
          }
        } else {
          $("ocrState").textContent = "Субтитры найдены";
          $("lastText").textContent = (subtitle.speaker ? subtitle.speaker + ": " : "") + subtitle.text;
          emptyCaptionReads = 0;
          consecutiveEmptyReads = 0;
          lastEmptyStartedAt = 0;
          const key = normalize(subtitle.text);
          if (similarCaption(key, previousCandidate)) {
            candidateCount++;
            previousCandidate = key;
          } else {
            previousCandidate = key;
            candidateCount = 1;
          }

          const now = Date.now();
          // Короткое окно защищает от повторного чтения одного кадра,
          // но не блокирует похожую реплику, сказанную позже.
          recentQueuedCaptions = recentQueuedCaptions.filter(item => now - item.time < 3500);
          const wasQueuedRecently = recentQueuedCaptions.some(item => similarCaption(key, item.key));
          const isNewPhrase = (!lastEnqueuedKey || !similarCaption(key, lastEnqueuedKey)) && !wasQueuedRecently;
          // Fast subtitles may exist for only one OCR cycle.
          // Accept a single clear read; require two matching reads only when confidence is middling.
          const stableOrClear = subtitle.confidence >= 45 || candidateCount >= 2;

          if (isNewPhrase && stableOrClear) {
            lastEnqueuedKey = key;
            recentQueuedCaptions.push({ key, time: now });
            // FIFO: never discard a detected subtitle while Android is speaking.
            // Let the queue grow rather than silently skipping dialogue.
            queue.push({ ...subtitle, queuedAt: now });
            setQueueCount();
            pumpSpeechQueue();
          }
        }
      } catch (error) {
        consecutiveOcrErrors++;
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

      // OCR already takes most of the frame time; keep only a short cooldown.
      await wait(60);
    }

    loopRunning = false;
  }

  async function createOcrWorker() {
    $("ocrState").textContent = "Загружаю модель PaddleOCR…";
    $("lastText").textContent = "Загружаю русскую OCR-модель и включаю WebGPU; при ошибке будет WASM.";
    const modelBase = new URL(import.meta.env.BASE_URL, window.location.origin);
    const engine = await PaddleOCR.create({
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textRecognitionModelName: "eslav_PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: {
        url: new URL("models/eslav_PP-OCRv5_mobile_rec.tar", modelBase).href
      },
      worker: true,
      ortOptions: {
        // Prefer the dedicated native WebGPU bundle; fall back to WASM when
        // this browser cannot create a WebGPU inference session.
        backend: "auto",
        wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/",
        numThreads: 1,
        simd: true
      }
    });
    return engine;
  }

  $("startCamera").addEventListener("click", async () => {
    audioUnlocked = true;
    updateSpeechButton();
    // Unlock Android Chrome TTS directly inside the user's tap, before async camera setup.
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
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
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

      worker = await createOcrWorker();
      scanning = true;
      document.body.classList.add("running");
      setStatus("Камера работает");
      scanLoop();
    } catch (error) {
      console.error(error);
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
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    $("videoWrap").classList.remove("camera-active");
    if (worker) {
      const oldWorker = worker;
      worker = null;
      try { await oldWorker.dispose(); } catch (_) {}
    }
    while (loopRunning) await wait(40);
    cancelSpeechAndQueue();
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
    previousCandidate = "";
    candidateCount = 0;
    consecutiveEmptyReads = 0;
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
    cancelSpeechAndQueue();
    activeSpeech = true;
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
      $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена";
      pumpSpeechQueue();
    };
    const armWatchdog = () => {
      if (speechWatchdog) window.clearTimeout(speechWatchdog);
      speechWatchdog = window.setTimeout(() => {
        try { speechSynthesis.cancel(); } catch (_) {}
        finish();
      }, 20000);
    };

    utterance.onstart = () => {
      $("speechState").textContent = "Говорит";
      armWatchdog();
    };
    utterance.onboundary = armWatchdog;
    utterance.onend = finish;
    utterance.onerror = finish;
    try {
      speechSynthesis.resume();
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
    speakStandalone(clean($("manualText").value));
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && scanning && "speechSynthesis" in window) {
      try { speechSynthesis.resume(); } catch (_) {}
      pumpSpeechQueue();
    }
  });

  $("rate").addEventListener("input", event => $("rateValue").textContent = Number(event.target.value).toFixed(2) + "×");
  $("volume").addEventListener("input", event => $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%");
})();