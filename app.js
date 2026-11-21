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
  let audioUnlocked = false;
  let activeSpeech = false;
  let speechWatchdog = null;
  let voices = [];
  let previousCandidate = "";
  let candidateCount = 0;
  let lastScanAt = 0;
  let consecutiveOcrErrors = 0;
  const queue = [];
  const recentSpoken = new Map();

  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const clean = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();
  const normalize = value => clean(value).toLocaleLowerCase("ru-RU")
    .replace(/[^а-яёa-z0-9 ]/gi, "").replace(/\s+/g, " ").trim();
  const setStatus = value => { $("status").textContent = value; };
  const setQueueCount = () => { $("queueState").textContent = String(queue.length + (activeSpeech ? 1 : 0)); };

  function updateRoi() {
    const top = Number($("roiTop").value);
    const height = Number($("roiHeight").value);
    document.documentElement.style.setProperty("--roi-top", top + "%");
    document.documentElement.style.setProperty("--roi-height", height + "%");
    $("roiTopValue").textContent = top + "%";
    $("roiHeightValue").textContent = height + "%";
    $("roiLabel").textContent = top + "% / " + height + "%";
  }
  $("roiTop").addEventListener("input", updateRoi);
  $("roiHeight").addEventListener("input", updateRoi);
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
      window.setTimeout(pumpSpeechQueue, 180);
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

  function isRussianSubtitleLine(line, confidence) {
    const value = clean(line);
    const letters = value.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    const cyrillic = value.match(/[А-Яа-яЁё]/g) || [];
    if (cyrillic.length < 2 || !letters.length) return false;
    if (cyrillic.length / letters.length < 0.82) return false;
    if (Number.isFinite(confidence) && confidence < 30) return false;
    const words = value.split(/\s+/).filter(Boolean);
    const tinyWords = words.filter(word => /^[А-Яа-яЁё]$/i.test(word)).length;
    if (tinyWords > 2 || tinyWords / Math.max(1, words.length) > 0.3) return false;
    if (!/[аеёиоуыэюя]/i.test(value)) return false;
    return true;
  }

  function parseSubtitle(data) {
    const namePattern = /^(Jason|Lucia|Tourist)\s*[:：-]?\s*/i;
    const lines = Array.isArray(data.lines) && data.lines.length
      ? data.lines.map(line => ({ text: clean(line.text), confidence: Number(line.confidence) }))
      : (data.text || "").split(/\r?\n/).map(text => ({ text: clean(text), confidence: Number(data.confidence) }));

    let speaker = "";
    const accepted = [];
    for (const line of lines) {
      if (!line.text) continue;
      if ($("showNames").checked) {
        const match = line.text.match(namePattern);
        if (match) {
          speaker = match[1];
          line.text = clean(line.text.slice(match[0].length));
          if (!line.text) continue;
        }
      }
      if (isRussianSubtitleLine(line.text, line.confidence)) accepted.push(line);
    }

    const text = clean(accepted.map(line => line.text).join(" "))
      .replace(/[^А-Яа-яЁё0-9 .,!?…:;()'’\-]/g, "")
      .replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 180) return null;

    const confidences = accepted.map(line => line.confidence).filter(Number.isFinite);
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : Number(data.confidence) || 0;
    return { text, speaker, confidence };
  }

  function prepareRecognitionImage() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    canvas.width = Math.min(1280, width);
    canvas.height = Math.round(height * canvas.width / width);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Keep crop geometry identical to the visible green rectangle (8% margins).
    const cropX = Math.floor(canvas.width * 0.08);
    const cropY = Math.floor(canvas.height * Number($("roiTop").value) / 100);
    const cropWidth = Math.floor(canvas.width * 0.84);
    const cropHeight = Math.min(
      Math.floor(canvas.height * Number($("roiHeight").value) / 100),
      canvas.height - cropY
    );
    if (cropHeight < 24) return null;

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

        const result = await worker.recognize(image);
        consecutiveOcrErrors = 0;
        const raw = clean(result.data.text || "");
        $("rawText").textContent = raw || "Внутри рамки нет распознанного текста.";
        $("latency").textContent = Math.round(performance.now() - started) + " мс OCR";

        const subtitle = parseSubtitle(result.data);
        if (!subtitle) {
          $("ocrState").textContent = "Ищу субтитры…";
          $("lastText").textContent = "Пока нет чистой русской реплики.";
          previousCandidate = "";
          candidateCount = 0;
        } else {
          $("ocrState").textContent = "Субтитры найдены";
          $("lastText").textContent = (subtitle.speaker ? subtitle.speaker + ": " : "") + subtitle.text;
          const key = normalize(subtitle.text);
          if (key === previousCandidate) candidateCount++;
          else {
            previousCandidate = key;
            candidateCount = 1;
          }

          const now = Date.now();
          const lastTime = recentSpoken.get(key) || 0;
          const isNewPhrase = now - lastTime > 4500;
          const stableOrClear = candidateCount >= 2 || subtitle.confidence >= 68;

          if (isNewPhrase && stableOrClear) {
            recentSpoken.set(key, now);
            queue.push(subtitle);
            setQueueCount();
            pumpSpeechQueue();
          }
        }
      } catch (error) {
        consecutiveOcrErrors++;
        console.error("OCR error", error);
        $("ocrState").textContent = "Повторяю сканирование…";
        $("lastText").textContent = "Ошибка OCR — цикл продолжится автоматически.";
        if (consecutiveOcrErrors >= 4 && scanning) {
          try {
            if (worker) await worker.terminate();
            worker = await Tesseract.createWorker("rus", 1, {
              logger: message => {
                if (message.status === "loading language traineddata") $("ocrState").textContent = "Перезапускаю русский OCR…";
              }
            });
            await worker.setParameters({
              tessedit_pageseg_mode: "6",
              preserve_interword_spaces: "1",
              tessedit_char_whitelist: "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя0123456789.,!?…:;()- "
            });
            consecutiveOcrErrors = 0;
          } catch (restartError) {
            console.error("OCR restart failed", restartError);
          }
        }
      }

      // The loop always schedules its next pass, whether OCR found text or not.
      await wait(180);
    }

    loopRunning = false;
  }

  async function createOcrWorker() {
    const newWorker = await Tesseract.createWorker("rus", 1, {
      logger: message => {
        if (message.status === "loading language traineddata") $("ocrState").textContent = "Загружаю русский OCR…";
      }
    });
    await newWorker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
      tessedit_char_whitelist: "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя0123456789.,!?…:;()- "
    });
    return newWorker;
  }

  $("startCamera").addEventListener("click", async () => {
    audioUnlocked = true;
    if ("speechSynthesis" in window) {
      try { speechSynthesis.resume(); } catch (_) {}
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
      $("toggleSpeech").disabled = false;
      $("speechState").textContent = "Озвучка готова";
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
      try { await oldWorker.terminate(); } catch (_) {}
    }
    cancelSpeechAndQueue();
    $("placeholder").hidden = false;
    $("startCamera").disabled = false;
    $("stopCamera").disabled = true;
    $("toggleSpeech").disabled = true;
    $("ocrState").textContent = "Остановлено";
    $("speechState").textContent = "Остановлена";
    document.body.classList.remove("running");
    setStatus("Остановлено");
  });

  $("toggleSpeech").addEventListener("click", () => {
    speechEnabled = !speechEnabled;
    if (!speechEnabled) {
      cancelSpeechAndQueue();
      $("toggleSpeech").textContent = "Включить озвучку";
      $("speechState").textContent = "Остановлена";
    } else {
      $("toggleSpeech").textContent = "Остановить озвучку";
      $("speechState").textContent = "Включена";
      pumpSpeechQueue();
    }
  });

  function speakStandalone(text) {
    if (!("speechSynthesis" in window) || !text) return;
    audioUnlocked = true;
    cancelSpeechAndQueue();
    speechEnabled = true;
    $("toggleSpeech").textContent = "Остановить озвучку";
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
      $("speechState").textContent = "Включена";
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