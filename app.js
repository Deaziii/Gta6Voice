(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("camera");
  const canvas = $("frame");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null, worker = null, scanning = false, busy = false;
  let speechEnabled = true, lastCandidate = "", candidateCount = 0, lastSpoken = "";
  let lastScanAt = 0, lastSpeakAt = 0;
  const queue = [];
  let voices = [];

  const clean = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();
  const setStatus = value => { $("status").textContent = value; };

  function refreshVoices() {
    voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    ["defaultVoice", "jasonVoice", "luciaVoice"].forEach(id => {
      const select = $(id), previous = select.value;
      const automatic = id === "defaultVoice" ? "Русский голос Android по умолчанию" : "Автоматически";
      select.innerHTML = "";
      const first = document.createElement("option"); first.value = ""; first.textContent = automatic; select.appendChild(first);
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
    if (requested !== "") return voices[Number(requested)] || null;
    const russian = voices.filter(voice => /^ru/i.test(voice.lang));
    if (/lucia/i.test(speaker)) return russian[1] || russian[0] || null;
    return russian[0] || null;
  }

  function playQueue() {
    if (!speechEnabled || !queue.length || !("speechSynthesis" in window) || speechSynthesis.speaking) return;
    const item = queue.shift();
    $("queueState").textContent = String(queue.length);
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = "ru-RU";
    utterance.rate = Number($("rate").value);
    utterance.volume = Number($("volume").value);
    const voice = voiceFor(item.speaker);
    if (voice) utterance.voice = voice;
    utterance.onend = () => { lastSpeakAt = Date.now(); playQueue(); };
    utterance.onerror = () => playQueue();
    speechSynthesis.speak(utterance);
  }

  function parseSubtitle(rawText) {
    const lines = (rawText || "").split(/\r?\n/).map(clean).filter(Boolean);
    const useful = lines.filter(line => line.length >= 2 && /[А-Яа-яЁё]/.test(line));
    if (!useful.length) return null;
    const namePattern = /^(Jason|Lucia|Tourist)\s*[:：-]?\s*/i;
    let speaker = "";
    let text = useful.join(" ");
    if ($("showNames").checked) {
      const joined = useful.join(" ");
      const match = joined.match(namePattern);
      if (match) {
        speaker = match[1];
        text = joined.slice(match[0].length);
      } else {
        const index = useful.findIndex(line => namePattern.test(line));
        if (index >= 0) {
          const matchLine = useful[index].match(namePattern);
          speaker = matchLine[1];
          useful[index] = useful[index].replace(namePattern, "");
          text = useful.filter(Boolean).join(" ");
        }
      }
    }
    text = clean(text).replace(/[^А-Яа-яЁёA-Za-z0-9 .,!?…:;()'’\-]/g, "").trim();
    if (text.length < 3 || text.length > 260) return null;
    return { text, speaker };
  }

  async function scanOnce() {
    if (!scanning || busy || !worker || video.readyState < 2) return;
    const now = performance.now();
    if (now - lastScanAt < 600) return;
    lastScanAt = now;
    busy = true;
    const started = performance.now();
    try {
      const width = video.videoWidth, height = video.videoHeight;
      if (!width || !height) return;
      canvas.width = Math.min(1280, width);
      canvas.height = Math.round(height * canvas.width / width);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Wider test area: includes centered labels during calibration and lower game subtitles.
      const cropY = Math.floor(canvas.height * 0.22);
      const crop = document.createElement("canvas");
      crop.width = canvas.width;
      crop.height = canvas.height - cropY;
      crop.getContext("2d").drawImage(canvas, 0, cropY, canvas.width, crop.height, 0, 0, crop.width, crop.height);
      const result = await worker.recognize(crop);
      const subtitle = parseSubtitle(result.data.text);
      $("latency").textContent = Math.round(performance.now() - started) + " мс OCR";
      $("ocrState").textContent = "Активно";
      if (!subtitle) {
        lastCandidate = "";
        candidateCount = 0;
        return;
      }
      $("lastText").textContent = (subtitle.speaker ? subtitle.speaker + ": " : "") + subtitle.text;
      const key = subtitle.text.toLocaleLowerCase("ru-RU").replace(/[.!?…]+$/g, "").trim();
      if (key === lastCandidate) candidateCount += 1;
      else { lastCandidate = key; candidateCount = 1; }
      if (candidateCount >= 2 && key !== lastSpoken) {
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
      if (scanning) window.setTimeout(scanOnce, 80);
    }
  }

  $("startCamera").addEventListener("click", async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Браузер не дал доступ к камере. Открой страницу через HTTPS в Chrome.");
      }
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
      $("speechState").textContent = "Включена";
      setStatus("Загрузка OCR…");
      $("ocrState").textContent = "Загрузка языка…";
      worker = await Tesseract.createWorker("rus+eng", 1, {
        logger: message => {
          if (message.status === "loading tesseract core") $("ocrState").textContent = "Загрузка движка…";
          if (message.status === "loading language traineddata") $("ocrState").textContent = "Загрузка русского языка…";
          if (message.status === "recognizing text") $("ocrState").textContent = "Читаю…";
        }
      });
      scanning = true;
      document.body.classList.add("running");
      $("liveDot").classList.add("active");
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

  function say(text, speaker = "") {
    if (!("speechSynthesis" in window)) {
      $("lastText").textContent = "В этом браузере нет системной озвучки.";
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = Number($("rate").value);
    utterance.volume = Number($("volume").value);
    const voice = voiceFor(speaker);
    if (voice) utterance.voice = voice;
    speechSynthesis.speak(utterance);
  }

  $("testSpeech").addEventListener("click", () => say("Проверка русского голоса. GTA шесть, слышишь меня?"));
  $("speakManual").addEventListener("click", () => {
    const text = clean($("manualText").value);
    if (text) say(text);
  });
  $("rate").addEventListener("input", event => $("rateValue").textContent = Number(event.target.value).toFixed(2) + "×");
  $("volume").addEventListener("input", event => $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%");
})();