(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("camera"), canvas = $("frame");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null, worker = null, scanning = false, busy = false;
  let speechEnabled = true, audioUnlocked = false;
  let previousCandidate = "", candidateCount = 0, lastSpoken = "";
  let lastScanAt = 0;
  const queue = [];
  let voices = [];

  const clean = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();
  const setStatus = value => { $("status").textContent = value; };
  const normalize = value => clean(value).toLocaleLowerCase("ru-RU").replace(/[^а-яёa-z0-9 ]/gi, "").replace(/\s+/g, " ").trim();

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aa = a.split(" "), bb = b.split(" ");
    const common = aa.filter(word => bb.includes(word)).length;
    return common / Math.max(aa.length, bb.length);
  }

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
    const requested = $(id).value || (id !== "defaultVoice" ? $("defaultVoice").value : "");
    if (requested) return voices[Number(requested)] || null;
    const russian = voices.filter(voice => /^ru/i.test(voice.lang));
    return russian[0] || null;
  }

  function speak(text, speaker = "", onDone = () => {}) {
    if (!("speechSynthesis" in window)) {
      $("speechState").textContent = "Нет TTS в браузере";
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = Number($("rate").value);
    utterance.volume = Number($("volume").value);
    const voice = voiceFor(speaker);
    if (voice) utterance.voice = voice;
    utterance.onstart = () => { $("speechState").textContent = "Говорит"; };
    utterance.onend = () => { $("speechState").textContent = speechEnabled ? "Включена" : "Остановлена"; onDone(); };
    utterance.onerror = event => {
      console.warn("TTS error", event);
      $("speechState").textContent = "Ошибка озвучки";
      onDone();
    };
    try { speechSynthesis.speak(utterance); }
    catch (error) { console.error(error); $("speechState").textContent = "Ошибка озвучки"; onDone(); }
  }

  function playQueue() {
    if (!speechEnabled || !audioUnlocked || !queue.length || !("speechSynthesis" in window) || speechSynthesis.speaking) return;
    const item = queue.shift();
    $("queueState").textContent = String(queue.length);
    speak(item.text, item.speaker, playQueue);
  }

  function validRussianSubtitle(text, confidence) {
    const value = clean(text);
    const letters = value.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    const cyrillic = value.match(/[А-Яа-яЁё]/g) || [];
    const words = value.split(/\s+/).filter(Boolean);
    const substantial = words.filter(word => (word.match(/[А-Яа-яЁёA-Za-z]/g) || []).length >= 3);
    const oneLetter = words.filter(word => /^[А-Яа-яЁёA-Za-z]$/i.test(word)).length;
    if (value.length < 5 || value.length > 220) return false;
    if (letters.length < 5 || cyrillic.length / letters.length < 0.72) return false;
    if (substantial.length < 2) return false;
    if (oneLetter > 1 || oneLetter / words.length > 0.18) return false;
    if (Number.isFinite(confidence) && confidence < 48) return false;
    return true;
  }

  function parseSubtitle(rawText, confidence) {
    const lines = (rawText || "").split(/\r?\n/).map(clean).filter(Boolean);
    const useful = lines.filter(line => /[А-Яа-яЁё]/.test(line));
    if (!useful.length) return null;
    const namePattern = /^(Jason|Lucia|Tourist)\s*[:：-]?\s*/i;
    let speaker = "";
    let text = useful.join(" ");
    if ($("showNames").checked) {
      const joined = useful.join(" ");
      const match = joined.match(namePattern);
      if (match) { speaker = match[1]; text = joined.slice(match[0].length); }
      else {
        const index = useful.findIndex(line => namePattern.test(line));
        if (index >= 0) {
          speaker = useful[index].match(namePattern)[1];
          useful[index] = useful[index].replace(namePattern, "");
          text = useful.filter(Boolean).join(" ");
        }
      }
    }
    text = clean(text).replace(/[^А-Яа-яЁёA-Za-z0-9 .,!?…:;()'’\-]/g, "").trim();
    if (!validRussianSubtitle(text, confidence)) return null;
    return { text, speaker, confidence: Number(confidence) || 0 };
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

      // GTA dialogue subtitles are normally close to the bottom edge.
      // Ignore most of the scene and scan only the lower central strip.
      const cropX = Math.floor(canvas.width * 0.06);
      const cropY = Math.floor(canvas.height * 0.70);
      const cropWidth = Math.floor(canvas.width * 0.88);
      const cropHeight = Math.floor(canvas.height * 0.27);
      const crop = document.createElement("canvas");
      crop.width = cropWidth;
      crop.height = cropHeight;
      const cropCtx = crop.getContext("2d", { willReadFrequently: true });
      cropCtx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

      // Enlarge and boost contrast to help small projected captions.
      const processed = document.createElement("canvas");
      processed.width = cropWidth * 2;
      processed.height = cropHeight * 2;
      const pctx = processed.getContext("2d", { willReadFrequently: true });
      pctx.filter = "grayscale(1) contrast(1.7)";
      pctx.drawImage(crop, 0, 0, processed.width, processed.height);
      pctx.filter = "none";

      const result = await worker.recognize(processed);
      const subtitle = parseSubtitle(result.data.text, result.data.confidence);
      $("latency").textContent = Math.round(performance.now() - started) + " мс OCR";
      $("ocrState").textContent = "Активно";

      if (!subtitle) {
        previousCandidate = "";
        candidateCount = 0;
        return;
      }

      $("lastText").textContent = subtitle.text;
      const key = normalize(subtitle.text);
      if (similarity(key, previousCandidate) >= 0.78) candidateCount++;
      else { previousCandidate = key; candidateCount = 1; }

      if (candidateCount >= 2 && similarity(key, lastSpoken) < 0.82) {
        lastSpoken = key;
        queue.push(subtitle);
        $("queueState").textContent = String(queue.length);
        playQueue();
      }
    } catch (error) {
      console.error(error);
      $("ocrState").textContent = "Ошибка OCR";
    } finally {
      busy = false;
      if (scanning) window.setTimeout(scanOnce, 60);
    }
  }

  $("startCamera").addEventListener("click", async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Открой страницу через HTTPS в Chrome и разреши камеру.");
      setStatus("Запуск камеры…");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      video.srcObject = stream;
      await video.play();
      $("placeholder").hidden = true;
      $("startCamera").disabled = true;
      $("stopCamera").disabled = false;
      $("toggleSpeech").disabled = false;
      $("speechState").textContent = audioUnlocked ? "Включена" : "Нажми «Тест голоса»";
      setStatus("Загрузка OCR…");
      $("ocrState").textContent = "Загрузка языка…";
      worker = await Tesseract.createWorker("rus+eng", 1, {
        logger: message => {
          if (message.status === "recognizing text") $("ocrState").textContent = "Читаю…";
        }
      });
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
    }
  });

  $("stopCamera").addEventListener("click", async () => {
    scanning = false;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
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
      speechSynthesis.cancel();
      $("toggleSpeech").textContent = "Включить озвучку";
      $("speechState").textContent = "Остановлена";
    } else {
      $("toggleSpeech").textContent = "Остановить озвучку";
      $("speechState").textContent = "Включена";
      playQueue();
    }
    $("queueState").textContent = String(queue.length);
  });

  function unlockAndTest() {
    if (!("speechSynthesis" in window)) {
      $("speechState").textContent = "Нет TTS в браузере";
      return;
    }
    audioUnlocked = true;
    speechSynthesis.cancel();
    refreshVoices();
    speak("Проверка русского голоса. GTA шесть, слышишь меня?", "", () => playQueue());
  }
  $("testSpeech").addEventListener("click", unlockAndTest);
  $("speakManual").addEventListener("click", () => {
    const text = clean($("manualText").value);
    if (!text) return;
    audioUnlocked = true;
    speechSynthesis.cancel();
    speak(text);
  });
  $("rate").addEventListener("input", event => $("rateValue").textContent = Number(event.target.value).toFixed(2) + "×");
  $("volume").addEventListener("input", event => $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%");
})();