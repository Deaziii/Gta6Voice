(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("camera"), canvas = $("frame");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null, worker = null, scanning = false, busy = false;
  let speechEnabled = true, audioUnlocked = false;
  let previousCandidate = "", candidateCount = 0, lastSpokenKey = "", lastSpokenAt = 0;
  let lastScanAt = 0, voices = [];
  const queue = [];

  const clean = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();
  const normalize = value => clean(value).toLocaleLowerCase("ru-RU").replace(/[^а-яёa-z0-9 ]/gi, "").replace(/\s+/g, " ").trim();
  const setStatus = value => { $("status").textContent = value; };

  function updateRoi() {
    const top = Number($("roiTop").value), height = Number($("roiHeight").value);
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
      const select = $(id), previous = select.value;
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
    const chosen = $(id).value || (id !== "defaultVoice" ? $("defaultVoice").value : "");
    if (chosen) return voices[Number(chosen)] || null;
    return voices.find(voice => /^ru/i.test(voice.lang)) || null;
  }

  function speak(text, speaker = "", onDone = () => {}) {
    if (!("speechSynthesis" in window)) {
      $("speechState").textContent = "Нет TTS в браузере";
      $("lastText").textContent = "Браузер не поддерживает системную озвучку.";
      onDone();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = Number($("rate").value);
    utterance.volume = Number($("volume").value);
    const voice = voiceFor(speaker);
    if (voice) utterance.voice = voice;
    utterance.onstart = () => { $("speechState").textContent = "Говорит"; };
    utterance.onend = () => {
      $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена";
      window.setTimeout(onDone, 120);
    };
    utterance.onerror = event => {
      console.warn("Speech synthesis error", event);
      $("speechState").textContent = "Ошибка TTS";
      window.setTimeout(onDone, 120);
    };
    try { speechSynthesis.speak(utterance); }
    catch (error) {
      console.error(error);
      $("speechState").textContent = "Ошибка TTS";
      onDone();
    }
  }

  function playQueue() {
    if (!speechEnabled || !audioUnlocked || !queue.length || !("speechSynthesis" in window) || speechSynthesis.speaking) return;
    const item = queue.shift();
    $("queueState").textContent = String(queue.length);
    speak(item.text, item.speaker, playQueue);
  }

  function unlockSpeechFromTap() {
    if (!("speechSynthesis" in window)) return;
    audioUnlocked = true;
    speechSynthesis.cancel();
    // The user tap on Start Camera / Test Voice authorizes speech playback in mobile browsers.
    const warmup = new SpeechSynthesisUtterance(" ");
    warmup.lang = "ru-RU";
    warmup.volume = 0;
    warmup.onend = () => window.setTimeout(playQueue, 120);
    warmup.onerror = () => window.setTimeout(playQueue, 120);
    speechSynthesis.speak(warmup);
    refreshVoices();
  }

  function isRussianLine(line, confidence) {
    const value = clean(line);
    const letters = value.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    const cyr = value.match(/[А-Яа-яЁё]/g) || [];
    if (cyr.length < 4 || !letters.length) return false;
    if (cyr.length / letters.length < 0.86) return false;
    if (Number.isFinite(confidence) && confidence < 24) return false;
    const words = value.split(/\s+/).filter(Boolean);
    const tinyWords = words.filter(word => /^[А-Яа-яЁё]$/i.test(word)).length;
    if (tinyWords > 2 || tinyWords / Math.max(1, words.length) > 0.28) return false;
    return true;
  }

  function parseSubtitle(data) {
    const namePattern = /^(Jason|Lucia|Tourist)\s*[:：-]?\s*/i;
    const rawLines = Array.isArray(data.lines) && data.lines.length
      ? data.lines.map(line => ({ text: clean(line.text), confidence: Number(line.confidence) }))
      : (data.text || "").split(/\r?\n/).map(text => ({ text: clean(text), confidence: Number(data.confidence) }));
    let speaker = "";
    const accepted = [];
    for (const line of rawLines) {
      if (!line.text) continue;
      if ($("showNames").checked) {
        const match = line.text.match(namePattern);
        if (match) {
          speaker = match[1];
          const rest = clean(line.text.slice(match[0].length));
          if (!rest) continue;
          line.text = rest;
        }
      }
      if (isRussianLine(line.text, line.confidence)) accepted.push(line);
    }
    let text = clean(accepted.map(line => line.text).join(" "));
    text = text.replace(/[^А-Яа-яЁё0-9 .,!?…:;()'’\-]/g, "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 180) return null;
    const confidences = accepted.map(line => line.confidence).filter(Number.isFinite);
    const confidence = confidences.length ? confidences.reduce((a,b) => a+b, 0) / confidences.length : Number(data.confidence) || 0;
    return { text, speaker, confidence };
  }

  async function scanOnce() {
    if (!scanning || busy || !worker || video.readyState < 2) return;
    if (performance.now() - lastScanAt < 450) return;
    lastScanAt = performance.now();
    busy = true;
    const started = performance.now();
    try {
      const width = video.videoWidth, height = video.videoHeight;
      if (!width || !height) return;
      canvas.width = Math.min(1280, width);
      canvas.height = Math.round(height * canvas.width / width);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // OCR uses exactly the rectangle drawn over the live camera preview.
      const cropX = Math.floor(canvas.width * 0.08);
      const cropY = Math.floor(canvas.height * Number($("roiTop").value) / 100);
      const cropWidth = Math.floor(canvas.width * 0.84);
      const cropHeight = Math.min(Math.floor(canvas.height * Number($("roiHeight").value) / 100), canvas.height - cropY);
      if (cropHeight < 24) return;

      const processed = document.createElement("canvas");
      processed.width = Math.round(cropWidth * 1.6);
      processed.height = Math.round(cropHeight * 1.6);
      const pctx = processed.getContext("2d", { willReadFrequently: true });
      pctx.filter = "grayscale(1) contrast(1.65)";
      pctx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, processed.width, processed.height);
      pctx.filter = "none";

      const result = await worker.recognize(processed);
      const raw = clean(result.data.text || "");
      $("rawText").textContent = raw || "OCR не нашёл символов внутри рамки.";
      const subtitle = parseSubtitle(result.data);
      $("latency").textContent = Math.round(performance.now() - started) + " мс OCR";

      if (!subtitle) {
        $("ocrState").textContent = "Нет чистой реплики";
        $("lastText").textContent = raw
          ? "OCR что-то увидел, но фильтр не принял это как чистую русскую реплику. Открой «Что OCR реально увидел» ниже."
          : "Внутри рамки OCR не нашёл текста. Проверь положение рамки и фокус камеры.";
        previousCandidate = "";
        candidateCount = 0;
        return;
      }

      $("ocrState").textContent = "Реплика найдена";
      $("lastText").textContent = (subtitle.speaker ? subtitle.speaker + ": " : "") + subtitle.text;
      const key = normalize(subtitle.text);
      if (key === previousCandidate) candidateCount++;
      else { previousCandidate = key; candidateCount = 1; }

      const repeatedRecently = key === lastSpokenKey && Date.now() - lastSpokenAt < 12000;
      const enoughConfidence = subtitle.confidence >= 42;
      if (!repeatedRecently && (enoughConfidence || candidateCount >= 2)) {
        lastSpokenKey = key;
        lastSpokenAt = Date.now();
        queue.push(subtitle);
        $("queueState").textContent = String(queue.length);
        if (!audioUnlocked) {
          $("speechState").textContent = "Нажми «Тест голоса» один раз";
        } else {
          playQueue();
        }
      }
    } catch (error) {
      console.error(error);
      $("ocrState").textContent = "Ошибка OCR";
      $("lastText").textContent = "Ошибка распознавания: " + (error.message || String(error));
    } finally {
      busy = false;
      if (scanning) window.setTimeout(scanOnce, 80);
    }
  }

  $("startCamera").addEventListener("click", async () => {
    unlockSpeechFromTap();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Открой страницу через HTTPS в Chrome и разреши камеру.");
      setStatus("Запуск камеры…");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      video.srcObject = stream;
      await video.play();
      $("videoWrap").classList.add("camera-active");
      $("placeholder").hidden = true;
      $("startCamera").disabled = true;
      $("stopCamera").disabled = false;
      $("toggleSpeech").disabled = false;
      $("speechState").textContent = "Озвучка готова";
      setStatus("Загрузка OCR…");
      $("ocrState").textContent = "Загрузка русского OCR…";
      worker = await Tesseract.createWorker("rus", 1, {
        logger: message => {
          if (message.status === "loading language traineddata") $("ocrState").textContent = "Загружаю русский язык…";
          if (message.status === "recognizing text") $("ocrState").textContent = "Читаю рамку…";
        }
      });
      await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
      scanning = true;
      document.body.classList.add("running");
      setStatus("Камера работает");
      scanOnce();
    } catch (error) {
      console.error(error);
      setStatus("Не удалось запустить");
      $("lastText").textContent = "Ошибка: " + (error.message || String(error));
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null;
      $("videoWrap").classList.remove("camera-active");
    }
  });

  $("stopCamera").addEventListener("click", async () => {
    scanning = false;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    $("videoWrap").classList.remove("camera-active");
    if (worker) { await worker.terminate(); worker = null; }
    $("placeholder").hidden = false;
    $("startCamera").disabled = false;
    $("stopCamera").disabled = true;
    $("toggleSpeech").disabled = true;
    $("ocrState").textContent = "Ожидание";
    document.body.classList.remove("running");
    setStatus("Остановлено");
  });

  $("toggleSpeech").addEventListener("click", () => {
    speechEnabled = !speechEnabled;
    if (!speechEnabled) {
      queue.length = 0;
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      $("toggleSpeech").textContent = "Включить озвучку";
      $("speechState").textContent = "Остановлена";
    } else {
      $("toggleSpeech").textContent = "Остановить озвучку";
      $("speechState").textContent = "Включена";
      playQueue();
    }
    $("queueState").textContent = String(queue.length);
  });

  $("testSpeech").addEventListener("click", () => {
    unlockSpeechFromTap();
    speechSynthesis.cancel();
    speak("Проверка русского голоса. GTA шесть, слышишь меня?");
  });

  $("speakManual").addEventListener("click", () => {
    const text = clean($("manualText").value);
    if (!text) return;
    unlockSpeechFromTap();
    speechSynthesis.cancel();
    speak(text);
  });

  $("rate").addEventListener("input", event => $("rateValue").textContent = Number(event.target.value).toFixed(2) + "×");
  $("volume").addEventListener("input", event => $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%");
})();