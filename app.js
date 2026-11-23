import { PaddleOCR } from "@paddleocr/paddleocr-js";
import {
  CaptionController,
  ROLES,
  ROLE_META,
  DEFAULT_ROLE_DEFINITIONS,
  buildDialogueTurns,
  cleanText,
  evaluateFrameGate,
  extractSpeakerTag,
  isRussianSubtitleLine,
  normalizeRussianHomoglyphs
} from "./captionController.js";
import { DEFAULT_AI_ROLE_VOICES, VoiceEngine } from "./voiceEngine.js";

(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("camera");
  const canvas = $("frame");
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });

  const GATE_W = 192;
  const GATE_H = 48;
  const gateCanvas = document.createElement("canvas");
  gateCanvas.width = GATE_W;
  gateCanvas.height = GATE_H;
  const gateCtx = gateCanvas.getContext("2d", { willReadFrequently: true, alpha: false });

  const SPEED_PRESETS = {
    lightning: { maxW: 416, maxH: 192, detLimit: 416, minUpscale: 1.08, aspectX: 0.80 },
    ultra: { maxW: 480, maxH: 224, detLimit: 448, minUpscale: 1.15, aspectX: 0.85 },
    turbo: { maxW: 576, maxH: 256, detLimit: 512, minUpscale: 1.25, aspectX: 0.92 },
    balanced: { maxW: 704, maxH: 320, detLimit: 640, minUpscale: 1.45, aspectX: 1.00 }
  };

  const ROLE_TEST_PHRASES = {
    [ROLES.JASON]: "Я проверил чёрный вход. Держись за мной, уходим!",
    [ROLES.LUCIA]: "Я сама разберусь! Джейсон, заводи машину!",
    [ROLES.MALE_NPC]: "Стоять! Ни с места, руки за голову!",
    [ROLES.FEMALE_NPC]: "Вы с ума сошли? Немедленно убирайтесь отсюда!"
  };

  const PREFS_KEY = "gta6voice_prefs_v55";

  let stream = null;
  let worker = null;
  let workerWarm = false;
  let workerInitPromise = null;
  let scanning = false;
  let loopRunning = false;
  let speechEnabled = true;
  let recognitionEnabled = true;
  let activeSpeech = false;
  let activeSpeechStartedAt = 0;
  let cachedRuntimeReport = "";
  let consecutiveOcrErrors = 0;
  let lastProcessedVideoTime = -1;
  let lastRoiSignature = "";
  let prevStemNorm = null;
  let prevActiveCells = 0;
  let lastFullOcrAt = 0;
  let lastHadSubtitle = false;
  let deferredInstallPrompt = null;

  let roleDefinitions = DEFAULT_ROLE_DEFINITIONS.map(role => ({ ...role, aliases: [...role.aliases] }));
  const captionController = new CaptionController({ roleDefinitions });
  const voiceEngine = new VoiceEngine({
    audioElement: $("aiAudio"),
    onStateChange: info => {
      renderRoleBadge(info.role, info.engine);
      const engineLabel = info.engine === "ai"
        ? "ИИ Live"
        : info.engine === "ai-cache"
          ? "ИИ Кэш"
          : info.engine === "fallback"
            ? "Офлайн-подхват"
            : "Офлайн";
      $("speechState").textContent = "Говорит · " + engineLabel + " (" + info.rate.toFixed(2) + "×)";
    }
  });
  voiceEngine.setRoleDefinitions(roleDefinitions);

  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round32 = (value, min = 32) => Math.max(min, Math.round(value / 32) * 32);
  const setStatus = value => { $("status").textContent = value; };

  function waitNextVideoFrame(maxWaitMs = 20) {
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = window.setTimeout(done, maxWaitMs);
      if (typeof video.requestVideoFrameCallback === "function") {
        try {
          video.requestVideoFrameCallback(() => {
            window.clearTimeout(timer);
            done();
          });
        } catch (_) {}
      }
    });
  }

  function renderRoleBadge(role, engineType = "") {
    const badge = $("activeRoleBadge");
    const engineChip = $("activeEngineChip");
    if (badge) {
      const meta = roleDefinitions.find(item => item.id === role) || ROLE_META[role];
      badge.className = "role-badge " + (meta ? "role-" + meta.id : "role-idle");
      badge.textContent = meta ? (meta.name || meta.label || meta.short || role) : "Персонаж: авто";
    }
    if (engineChip) {
      if (!engineType) {
        engineChip.textContent = voiceEngine.mode === "elevenlabs" ? "ИИ ГОТОВ" : "ОФЛАЙН";
        engineChip.className = "engine-chip " + (voiceEngine.mode === "elevenlabs" ? "chip-ai" : "chip-offline");
      } else if (engineType === "ai" || engineType === "ai-cache") {
        engineChip.textContent = engineType === "ai-cache" ? "ИИ · КЭШ" : "ИИ · LIVE";
        engineChip.className = "engine-chip chip-ai";
      } else if (engineType === "fallback") {
        engineChip.textContent = "ПОДХВАТ";
        engineChip.className = "engine-chip chip-warn";
      } else {
        engineChip.textContent = "ОФЛАЙН";
        engineChip.className = "engine-chip chip-offline";
      }
    }
  }

  function syncEngineTabsUI() {
    const isAi = voiceEngine.mode === "elevenlabs";
    $("modeOfflineBtn").classList.toggle("active", !isAi);
    $("modeOfflineBtn").setAttribute("aria-selected", !isAi ? "true" : "false");
    $("modeAiBtn").classList.toggle("active", isAi);
    $("modeAiBtn").setAttribute("aria-selected", isAi ? "true" : "false");
    $("offlineVoicePanel").hidden = isAi;
    $("aiVoicePanel").hidden = !isAi;
    renderRoleBadge(captionController.getSnapshot().activeRole || "", "");
  }

  function escapeRoleText(value) {
    return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function renderRoleManager() {
    const host = $("roleManagerList");
    if (!host) return;
    const offline = voiceEngine.refreshSystemVoices();
    const ai = voiceEngine.getAllAiVoices();
    host.innerHTML = "";
    for (const role of roleDefinitions) {
      const row = document.createElement("div");
      row.className = "role-manager-card";
      const offlineOptions = ['<option value="">Авто по полу</option>', ...offline.map(item =>
        '<option value="' + escapeRoleText(item.voice.voiceURI || item.voice.name) + '">' +
        escapeRoleText(item.voice.name + (item.gender === "f" ? " (Ж)" : item.gender === "m" ? " (М)" : "")) + '</option>'
      )].join("");
      const aiOptions = ['<option value="">Не выбран</option>', ...ai.map(item =>
        '<option value="' + escapeRoleText(item.id) + '">' + escapeRoleText(item.name) + '</option>'
      )].join("");
      row.innerHTML = `
        <div class="role-manager-head">
          <strong>${escapeRoleText(role.name)}</strong>
          ${role.builtin ? '<span class="hint">Встроенная</span>' : '<button type="button" class="secondary compact-btn" data-delete-role="' + escapeRoleText(role.id) + '">Удалить</button>'}
        </div>
        <label>Имя роли<input type="text" maxlength="40" data-role-field="name" data-role-id="${escapeRoleText(role.id)}" value="${escapeRoleText(role.name)}"></label>
        <label>Имена и псевдонимы для OCR<textarea rows="2" maxlength="300" data-role-field="aliases" data-role-id="${escapeRoleText(role.id)}" placeholder="Например: Джейсон, Jason, Джей">${escapeRoleText((role.aliases || []).join(", "))}</textarea></label>
        <label>Пол для автоматического определения<select data-role-field="gender" data-role-id="${escapeRoleText(role.id)}"><option value="m" ${role.gender === "m" ? "selected" : ""}>Мужской</option><option value="f" ${role.gender === "f" ? "selected" : ""}>Женский</option></select></label>
        <label>Офлайн-голос<select data-role-voice="offline" data-role-id="${escapeRoleText(role.id)}">${offlineOptions}</select></label>
        <label>Голос ElevenLabs<select data-role-voice="ai" data-role-id="${escapeRoleText(role.id)}">${aiOptions}</select></label>
        <label class="range-label">Громкость <output data-role-volume-value="${escapeRoleText(role.id)}">${Math.round((voiceEngine.roleVolumes[role.id] ?? 1) * 100)}%</output><input type="range" min="0" max="1" step="0.05" data-role-volume="${escapeRoleText(role.id)}" value="${voiceEngine.roleVolumes[role.id] ?? 1}"></label>
      `;
      const offlineSelect = row.querySelector('[data-role-voice="offline"]');
      const aiSelect = row.querySelector('[data-role-voice="ai"]');
      offlineSelect.value = voiceEngine.offlineSelections[role.id] || "";
      aiSelect.value = voiceEngine.aiSelections[role.id] || "";
      host.appendChild(row);
    }
  }

  function applyRoleDefinitions() {
    voiceEngine.setRoleDefinitions(roleDefinitions);
    captionController.setRoleDefinitions(roleDefinitions);
    renderRoleManager();
    savePrefs();
  }

  $("addRoleBtn").addEventListener("click", () => {
    const id = "custom_" + Date.now().toString(36);
    roleDefinitions.push({
      id,
      name: "Новая роль",
      aliases: ["Новая роль"],
      gender: "m",
      main: false,
      builtin: false
    });
    applyRoleDefinitions();
  });

  $("roleManagerList").addEventListener("input", event => {
    const id = event.target.dataset.roleId;
    const field = event.target.dataset.roleField;
    if (id && field) {
      const role = roleDefinitions.find(item => item.id === id);
      if (!role) return;
      if (field === "aliases") role.aliases = event.target.value.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
      else role[field] = event.target.value;
      voiceEngine.setRoleDefinitions(roleDefinitions);
      captionController.setRoleDefinitions(roleDefinitions);
      savePrefs();
    }
    const volumeRole = event.target.dataset.roleVolume;
    if (volumeRole) {
      const value = clamp(Number(event.target.value), 0, 1);
      voiceEngine.roleVolumes[volumeRole] = value;
      const output = document.querySelector('[data-role-volume-value="' + volumeRole + '"]');
      if (output) output.textContent = Math.round(value * 100) + "%";
      savePrefs();
    }
  });

  $("roleManagerList").addEventListener("change", event => {
    const id = event.target.dataset.roleId;
    if (!id) return;
    if (event.target.dataset.roleVoice === "offline") voiceEngine.offlineSelections[id] = event.target.value;
    if (event.target.dataset.roleVoice === "ai") voiceEngine.aiSelections[id] = event.target.value;
    if (event.target.dataset.roleField === "gender") {
      const role = roleDefinitions.find(item => item.id === id);
      if (role) role.gender = event.target.value;
      applyRoleDefinitions();
    } else if (event.target.dataset.roleField === "name") {
      const role = roleDefinitions.find(item => item.id === id);
      if (role && !role.aliases.includes(role.name)) role.aliases.unshift(role.name);
      applyRoleDefinitions();
    } else savePrefs();
  });

  $("roleManagerList").addEventListener("click", event => {
    const id = event.target.dataset.deleteRole;
    if (!id) return;
    roleDefinitions = roleDefinitions.filter(role => role.id !== id || role.builtin);
    delete voiceEngine.roleVolumes[id];
    delete voiceEngine.offlineSelections[id];
    delete voiceEngine.aiSelections[id];
    applyRoleDefinitions();
  });

  function savePrefs() {
    try {
      const prefs = {
        roiLeft: Number($("roiLeft").value),
        roiTop: Number($("roiTop").value),
        roiWidth: Number($("roiWidth").value),
        roiHeight: Number($("roiHeight").value),
        ocrSpeed: $("ocrSpeed").value,
        rate: Number($("rate").value),
        roleVolumes: { ...voiceEngine.roleVolumes },
        roleDefinitions: roleDefinitions.map(role => ({ ...role, aliases: [...(role.aliases || [])] })),
        castMode: $("castMode").value,
        voiceMode: voiceEngine.mode,
        aiModel: $("aiModel").value,
        aiFallback: Boolean($("aiFallback").checked),
        elevenApiKey: $("elevenApiKey").value.trim(),
        offlineVoices: { ...voiceEngine.offlineSelections },
        aiVoices: { ...voiceEngine.aiSelections }
      };
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {}
  }

  function syncVoicePacePreset(rateVal) {
    const paceSelect = $("voicePace");
    const match = [...paceSelect.options].find(
      opt => opt.value !== "custom" && Math.abs(Number(opt.value) - rateVal) < 0.03
    );
    paceSelect.value = match ? match.value : "custom";
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (Array.isArray(prefs.roleDefinitions) && prefs.roleDefinitions.length) {
        const valid = prefs.roleDefinitions.filter(role =>
          role && typeof role.id === "string" && typeof role.name === "string" &&
          (role.gender === "m" || role.gender === "f") && Array.isArray(role.aliases)
        );
        if (valid.length) {
          roleDefinitions = valid.map(role => ({ ...role, aliases: role.aliases.map(String).filter(Boolean) }));
          voiceEngine.setRoleDefinitions(roleDefinitions);
          captionController.setRoleDefinitions(roleDefinitions);
        }
      }

      if (Number.isFinite(prefs.roiLeft)) $("roiLeft").value = String(prefs.roiLeft);
      if (Number.isFinite(prefs.roiTop)) $("roiTop").value = String(prefs.roiTop);
      if (Number.isFinite(prefs.roiWidth)) $("roiWidth").value = String(prefs.roiWidth);
      if (Number.isFinite(prefs.roiHeight)) $("roiHeight").value = String(prefs.roiHeight);
      if (prefs.ocrSpeed && SPEED_PRESETS[prefs.ocrSpeed]) $("ocrSpeed").value = prefs.ocrSpeed;

      if (Number.isFinite(prefs.rate)) {
        const r = clamp(prefs.rate, 0.85, 2.2);
        $("rate").value = String(r);
        $("rateValue").textContent = r.toFixed(2) + "×";
        voiceEngine.rate = r;
        syncVoicePacePreset(r);
      }
      if (prefs.roleVolumes && typeof prefs.roleVolumes === "object") {
        for (const role of Object.keys(voiceEngine.roleVolumes)) {
          if (Number.isFinite(prefs.roleVolumes[role])) {
            const value = clamp(prefs.roleVolumes[role], 0, 1);
            voiceEngine.roleVolumes[role] = value;
            const slider = document.querySelector('[data-role-volume="' + role + '"]');
            const output = document.querySelector('[data-role-volume-value="' + role + '"]');
            if (slider) slider.value = String(value);
            if (output) output.textContent = Math.round(value * 100) + "%";
          }
        }
      }
      if (prefs.castMode === "cinema_quad" || prefs.castMode === "gta_duo") {
        $("castMode").value = prefs.castMode;
        captionController.setCastMode(prefs.castMode);
      }
      if (prefs.voiceMode === "elevenlabs" || prefs.voiceMode === "offline") {
        voiceEngine.mode = prefs.voiceMode;
      }
      if (prefs.aiModel) {
        $("aiModel").value = prefs.aiModel;
        voiceEngine.aiModel = prefs.aiModel;
      }
      if (typeof prefs.aiFallback === "boolean") {
        $("aiFallback").checked = prefs.aiFallback;
        voiceEngine.fallbackToOffline = prefs.aiFallback;
      }
      if (typeof prefs.elevenApiKey === "string") {
        $("elevenApiKey").value = prefs.elevenApiKey;
        voiceEngine.apiKey = prefs.elevenApiKey;
      }
      if (prefs.offlineVoices && typeof prefs.offlineVoices === "object") {
        Object.assign(voiceEngine.offlineSelections, prefs.offlineVoices);
      }
      if (prefs.aiVoices && typeof prefs.aiVoices === "object") {
        Object.assign(voiceEngine.aiSelections, prefs.aiVoices);
      }
    } catch (_) {}
  }

  function populateOfflineVoiceSelects() {
    const ruVoices = voiceEngine.refreshSystemVoices();
    const map = [
      [ROLES.JASON, "offlineJasonVoice", "Авто · Глубокий мужской"],
      [ROLES.LUCIA, "offlineLuciaVoice", "Авто · Живой женский"],
      [ROLES.MALE_NPC, "offlineMaleNpcVoice", "Авто · Мужской 2 план"],
      [ROLES.FEMALE_NPC, "offlineFemaleNpcVoice", "Авто · Женский 2 план"]
    ];

    for (const [role, selectId, autoLabel] of map) {
      const select = $(selectId);
      const saved = voiceEngine.offlineSelections[role] || "";
      select.innerHTML = "";

      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = autoLabel;
      select.appendChild(autoOpt);

      for (const entry of ruVoices) {
        const opt = document.createElement("option");
        opt.value = entry.voice.voiceURI || entry.voice.name;
        const localTag = entry.voice.localService ? " · офлайн" : " · сеть";
        const gTag = entry.gender === "f" ? " (Ж)" : entry.gender === "m" ? " (М)" : "";
        opt.textContent = entry.voice.name + gTag + localTag;
        select.appendChild(opt);
      }

      if (saved && [...select.options].some(o => o.value === saved)) {
        select.value = saved;
      }
      voiceEngine.offlineSelections[role] = select.value;
    }

    const localCount = ruVoices.filter(v => v.voice.localService).length;
    $("offlineVoiceSummary").textContent = ruVoices.length
      ? ("Найдено русских голосов: " + ruVoices.length + " (офлайн: " + localCount + ")")
      : "Русские голоса загружаются системой Android…";
  }

  function populateAiVoiceSelects() {
    const allAi = voiceEngine.getAllAiVoices();
    const map = [
      [ROLES.JASON, "aiJasonVoice"],
      [ROLES.LUCIA, "aiLuciaVoice"],
      [ROLES.MALE_NPC, "aiMaleNpcVoice"],
      [ROLES.FEMALE_NPC, "aiFemaleNpcVoice"]
    ];

    for (const [role, selectId] of map) {
      const select = $(selectId);
      const desired = voiceEngine.aiSelections[role] || DEFAULT_AI_ROLE_VOICES[role];
      select.innerHTML = "";

      for (const item of allAi) {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.textContent = item.name;
        select.appendChild(opt);
      }
      if ([...select.options].some(o => o.value === desired)) {
        select.value = desired;
      }
      voiceEngine.aiSelections[role] = select.value;
    }
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

  function invalidateFrameGate() {
    prevStemNorm = null;
    prevActiveCells = 0;
    lastFullOcrAt = 0;
    lastProcessedVideoTime = -1;
  }

  function updateRoi(persist = false) {
    let left = clamp(Number($("roiLeft").value), 0, 80);
    let top = clamp(Number($("roiTop").value), 0, 88);
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
    if (persist) savePrefs();
  }

  // Initialize saved preferences & voice lists
  loadPrefs();
  populateOfflineVoiceSelects();
  populateAiVoiceSelects();
  renderRoleManager();
  syncEngineTabsUI();
  updateSpeechButton();
  updateRecognitionButton();
  updateRoi(false);
  updateDiagnostics();

  if ("speechSynthesis" in window) {
    speechSynthesis.onvoiceschanged = populateOfflineVoiceSelects;
  }

  // Bind ROI inputs & handles
  ["roiLeft", "roiTop", "roiWidth", "roiHeight"].forEach(id => {
    $(id).addEventListener("input", () => updateRoi(true));
  });

  $("slimRoi").addEventListener("click", () => {
    const currentTop = Number($("roiTop").value);
    const currentHeight = Number($("roiHeight").value);
    const center = currentTop + currentHeight / 2;
    const targetHeight = 12;
    $("roiLeft").value = "8";
    $("roiWidth").value = "84";
    $("roiHeight").value = String(targetHeight);
    $("roiTop").value = String(clamp(Math.round(center - targetHeight / 2), 0, 100 - targetHeight));
    updateRoi(true);
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
    updateRoi(false);
  });

  function finishRoiPointer(event) {
    if (!roiPointer || roiPointer.id !== event.pointerId) return;
    roiPointer = null;
    guide.classList.remove("dragging");
    savePrefs();
    try {
      if (guide.hasPointerCapture(event.pointerId)) guide.releasePointerCapture(event.pointerId);
    } catch (_) {}
  }
  guide.addEventListener("pointerup", finishRoiPointer);
  guide.addEventListener("pointercancel", finishRoiPointer);

  // Voice Studio & Engine bindings
  $("modeOfflineBtn").addEventListener("click", () => {
    voiceEngine.mode = "offline";
    syncEngineTabsUI();
    savePrefs();
  });

  $("modeAiBtn").addEventListener("click", () => {
    voiceEngine.mode = "elevenlabs";
    syncEngineTabsUI();
    savePrefs();
  });

  $("castMode").addEventListener("change", event => {
    captionController.setCastMode(event.target.value);
    savePrefs();
  });

  $("ocrSpeed").addEventListener("change", () => {
    invalidateFrameGate();
    savePrefs();
  });

  $("voicePace").addEventListener("change", event => {
    if (event.target.value === "custom") return;
    const rateVal = clamp(Number(event.target.value), 0.85, 2.2);
    voiceEngine.rate = rateVal;
    $("rate").value = String(rateVal);
    $("rateValue").textContent = rateVal.toFixed(2) + "×";
    savePrefs();
  });

  $("rate").addEventListener("input", event => {
    const val = Number(event.target.value);
    voiceEngine.rate = val;
    $("rateValue").textContent = val.toFixed(2) + "×";
    syncVoicePacePreset(val);
    savePrefs();
  });

  document.querySelectorAll("[data-role-volume]").forEach(slider => {
    slider.addEventListener("input", event => {
      const role = event.target.dataset.roleVolume;
      const value = clamp(Number(event.target.value), 0, 1);
      voiceEngine.roleVolumes[role] = value;
      const output = document.querySelector('[data-role-volume-value="' + role + '"]');
      if (output) output.textContent = Math.round(value * 100) + "%";
      savePrefs();
    });
  });


  [
    [ROLES.JASON, "offlineJasonVoice"],
    [ROLES.LUCIA, "offlineLuciaVoice"],
    [ROLES.MALE_NPC, "offlineMaleNpcVoice"],
    [ROLES.FEMALE_NPC, "offlineFemaleNpcVoice"]
  ].forEach(([role, id]) => {
    $(id).addEventListener("change", event => {
      voiceEngine.offlineSelections[role] = event.target.value;
      savePrefs();
    });
  });

  [
    [ROLES.JASON, "aiJasonVoice"],
    [ROLES.LUCIA, "aiLuciaVoice"],
    [ROLES.MALE_NPC, "aiMaleNpcVoice"],
    [ROLES.FEMALE_NPC, "aiFemaleNpcVoice"]
  ].forEach(([role, id]) => {
    $(id).addEventListener("change", event => {
      voiceEngine.aiSelections[role] = event.target.value;
      savePrefs();
    });
  });

  $("elevenApiKey").addEventListener("input", event => {
    voiceEngine.apiKey = event.target.value.trim();
    savePrefs();
  });

  $("toggleKeyVis").addEventListener("click", () => {
    const input = $("elevenApiKey");
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    $("toggleKeyVis").textContent = hidden ? "Скрыть" : "Показать";
  });

  $("aiModel").addEventListener("change", event => {
    voiceEngine.aiModel = event.target.value;
    savePrefs();
  });

  $("aiFallback").addEventListener("change", event => {
    voiceEngine.fallbackToOffline = event.target.checked;
    savePrefs();
  });

  $("loadAiVoices").addEventListener("click", async () => {
    const btn = $("loadAiVoices");
    btn.disabled = true;
    $("aiStatusText").textContent = "Загружаю голоса ElevenLabs…";
    try {
      const list = await voiceEngine.fetchAccountVoices($("elevenApiKey").value);
      populateAiVoiceSelects();
      savePrefs();
      $("aiStatusText").textContent = "Голоса загружены (" + list.length + " доступно).";
    } catch (err) {
      $("aiStatusText").textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll("[data-preview-role]").forEach(btn => {
    btn.addEventListener("click", () => {
      const role = btn.getAttribute("data-preview-role") || ROLES.JASON;
      speakStandalone(ROLE_TEST_PHRASES[role] || ROLE_TEST_PHRASES[ROLES.JASON], role);
    });
  });

  function cancelSpeechAndQueue() {
    captionController.clearQueueAndSpeech();
    voiceEngine.cancel();
    activeSpeech = false;
    activeSpeechStartedAt = 0;
    renderRoleBadge("", "");
    updateDiagnostics();
  }

  function pumpSpeechQueue() {
    const now = Date.now();
    if (!speechEnabled || !voiceEngine.audioUnlocked) {
      updateDiagnostics(now);
      return;
    }

    const pendingPreview = captionController.peekPending();
    if (activeSpeech && pendingPreview) {
      voiceEngine.prefetch(pendingPreview);
    }

    if (activeSpeech) {
      if (captionController.shouldPreemptActive(now)) {
        voiceEngine.cancel();
        captionController.onSpeechEnd(now);
        activeSpeech = false;
        activeSpeechStartedAt = 0;
        window.setTimeout(pumpSpeechQueue, 10);
        return;
      }
      updateDiagnostics(now);
      return;
    }

    const item = captionController.pullNextUtterance(now);
    if (!item) {
      updateDiagnostics(now);
      return;
    }

    activeSpeech = true;
    activeSpeechStartedAt = now;
    renderRoleBadge(item.role, voiceEngine.mode === "elevenlabs" ? "ai" : "offline");
    updateDiagnostics(now);

    const snap = captionController.getSnapshot(now);
    const catchUpBoost = (snap.hasPending || item.lagMs > 1100)
      ? 0.24
      : item.lagMs > 450
        ? 0.12
        : 0;

    // If another line is already pending right behind, prefetch its AI audio immediately
    const nextWaiting = captionController.peekPending();
    if (nextWaiting) voiceEngine.prefetch(nextWaiting);

    voiceEngine.speakItem(item, {
      catchUpBoost,
      onStart: () => {
        activeSpeechStartedAt = Date.now();
        updateDiagnostics(activeSpeechStartedAt);
      }
    }).catch(err => {
      console.warn("Playback error:", err);
      $("speechState").textContent = "Ошибка озвучки";
    }).finally(() => {
      const endedAt = Date.now();
      captionController.onSpeechEnd(endedAt);
      activeSpeech = false;
      activeSpeechStartedAt = 0;
      if (speechEnabled) {
        $("speechState").textContent = "Готова";
      } else {
        $("speechState").textContent = "Остановлена";
      }
      if (!captionController.peekPending()) {
        renderRoleBadge("", "");
      }
      updateDiagnostics(endedAt);
      pumpSpeechQueue();
    });
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
    const lines = Array.isArray(data.lines) && data.lines.length
      ? data.lines.map(line => ({ text: cleanText(line.text), confidence: Number(line.confidence) }))
      : (data.text || "").split(/\r?\n/).map(text => ({ text: cleanText(text), confidence: Number(data.confidence) }));

    const frameHasCyrillic = lines.some(line => /[А-Яа-яЁё]/.test(line.text));
    let primarySpeaker = "";
    const accepted = [];
    const report = [];

    for (const line of lines) {
      if (!line.text) continue;
      let lineText = line.text;
      let lineSpeaker = "";
      const extracted = extractSpeakerTag(lineText, roleDefinitions);
      if (extracted.speaker) {
        lineSpeaker = extracted.speaker;
        if (!primarySpeaker) primarySpeaker = lineSpeaker;
        lineText = extracted.text;
        if (!lineText) {
          report.push("NAME · " + line.text);
          continue;
        }
      }

      lineText = normalizeRussianHomoglyphs(lineText, { frameHasCyrillic });
      const ok = isRussianSubtitleLine(lineText, { frameHasCyrillic });
      report.push((ok ? "OK" : "SKIP") + " [" +
        (Number.isFinite(line.confidence) ? Math.round(line.confidence) : "?") +
        "%] " + (lineSpeaker ? lineSpeaker + ": " : "") + lineText);

      if (ok) {
        const sanitized = lineText
          .replace(/[^А-Яа-яЁё0-9 .,!?…:;()'’«»—–\-]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (sanitized.length >= 2) {
          accepted.push({ text: sanitized, speaker: lineSpeaker, confidence: line.confidence });
        }
      }
    }

    const text = cleanText(accepted.map(line => line.text).join(" "));
    if (text.length < 2 || text.length > 190) {
      return { subtitle: null, report: report.join("\n") || "Нет текстовых строк в зоне сканирования." };
    }

    const confidences = accepted.map(line => line.confidence).filter(Number.isFinite);
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : Number(data.confidence) || 0;

    const turns = buildDialogueTurns(accepted, {
      previousRole: captionController.lastRole,
      castMode: $("castMode").value,
      roleDefinitions
    });

    return {
      subtitle: {
        text,
        speaker: primarySpeaker,
        confidence,
        lineCount: accepted.length,
        turns
      },
      report: report.join("\n")
    };
  }

  function currentSpeedPreset() {
    const key = $("ocrSpeed").value || "ultra";
    return SPEED_PRESETS[key] || SPEED_PRESETS.ultra;
  }

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
      { prevStemNorm, prevActiveCells, lastFullOcrAt, lastHadSubtitle },
      now
    );
    if (!gate.run) {
      return { kind: "skip", reason: gate.reason, becameEmpty: Boolean(gate.becameEmpty) };
    }

    const preset = currentSpeedPreset();
    const baseScale = Math.min(preset.minUpscale, preset.maxW / sw, preset.maxH / sh);
    const crop = gate.crop || { x0: 0, x1: 1, y0: 0, y1: 1 };

    const csx = sx + Math.floor(sw * crop.x0);
    const csy = sy + Math.floor(sh * crop.y0);
    const csw = Math.max(24, Math.min(vw - csx, Math.ceil(sw * (crop.x1 - crop.x0))));
    const csh = Math.max(16, Math.min(vh - csy, Math.ceil(sh * (crop.y1 - crop.y0))));

    const outW = round32(Math.min(preset.maxW, csw * baseScale * preset.aspectX), 128);
    const outH = round32(Math.min(preset.maxH, csh * baseScale), 64);

    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.filter = "grayscale(1) contrast(1.36)";
    ctx.drawImage(video, csx, csy, csw, csh, 0, 0, outW, outH);
    ctx.filter = "none";

    return {
      kind: "ready",
      image: canvas,
      stemNorm: gate.stemNorm,
      activeCells: gate.activeCells,
      preset
    };
  }

  async function ensureOcrWorker() {
    if (worker) return worker;
    if (workerInitPromise) return workerInitPromise;

    workerInitPromise = (async () => {
      $("ocrState").textContent = "Загрузка OCR…";
      const modelBase = new URL(import.meta.env.BASE_URL, window.location.origin);
      const safeThreads = window.crossOriginIsolated
        ? Math.min(4, Math.max(1, Number(navigator.hardwareConcurrency) || 1))
        : 1;
      const engine = await PaddleOCR.create({
        textDetectionModelName: "PP-OCRv5_mobile_det",
        textRecognitionModelName: "eslav_PP-OCRv5_mobile_rec",
        textRecognitionModelAsset: {
          url: new URL("models/eslav_PP-OCRv5_mobile_rec.tar", modelBase).href
        },
        worker: true,
        ortOptions: {
          backend: "wasm",
          numThreads: safeThreads,
          simd: true
        }
      });

      // One-time 64x32 WASM JIT warm-up eliminates 500ms spike on first real subtitle
      if (!workerWarm) {
        try {
          const warm = document.createElement("canvas");
          warm.width = 96;
          warm.height = 32;
          const wctx = warm.getContext("2d");
          wctx.fillStyle = "#111";
          wctx.fillRect(0, 0, 96, 32);
          wctx.fillStyle = "#fff";
          wctx.font = "bold 18px sans-serif";
          wctx.fillText("Да", 12, 22);
          await engine.predict(warm, {
            textDetLimitSideLen: 128,
            textDetLimitType: "max",
            textDetThresh: 0.28,
            textDetBoxThresh: 0.45
          });
          workerWarm = true;
        } catch (_) {}
      }

      worker = engine;
      refreshOfflineCacheStatus();
      return engine;
    })();

    try {
      return await workerInitPromise;
    } finally {
      workerInitPromise = null;
    }
  }

  async function scanLoop() {
    if (loopRunning) return;
    loopRunning = true;

    while (scanning) {
      if (!recognitionEnabled) {
        $("ocrState").textContent = "Пауза OCR";
        await wait(110);
        continue;
      }
      if (!worker || video.readyState < 2 || !video.videoWidth) {
        $("ocrState").textContent = "Жду кадр…";
        await wait(80);
        continue;
      }

      const started = performance.now();
      const captureNow = Date.now();
      try {
        const prepared = prepareRecognitionImage(captureNow);
        if (prepared.kind === "invalid") {
          $("ocrState").textContent = "Проверь рамку";
          await wait(150);
          continue;
        }
        if (prepared.kind === "skip") {
          if (prepared.reason === "empty-scene") {
            if (prepared.becameEmpty) {
              lastHadSubtitle = false;
              prevStemNorm = null;
              prevActiveCells = 0;
              $("ocrState").textContent = "Жду реплику";
            }
            captionController.observe({ text: "", confidence: 0 }, captureNow);
            pumpSpeechQueue();
          }
          await waitNextVideoFrame(20);
          continue;
        }

        const [result] = await worker.predict(prepared.image, {
          textDetLimitSideLen: prepared.preset.detLimit,
          textDetLimitType: "max",
          textRecScoreThresh: 0.22,
          textDetThresh: 0.28,
          textDetBoxThresh: 0.48
        });
        const parsed = parsePaddleResult(result);

        prevStemNorm = prepared.stemNorm;
        prevActiveCells = prepared.activeCells;
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
                  mode: "known-good-wasm-v0.59",
                  detector: { model: "PP-OCRv5_mobile_det", thresh: 0.28, boxThresh: 0.48 }
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
          $("ocrState").textContent = "Жду реплику";
          captionController.observe({ text: "", confidence: 0 }, now);
        } else {
          lastHadSubtitle = true;
          $("ocrState").textContent = "Субтитры найдены";
          const displayRole = subtitle.turns?.[0]?.role;
          const speakerPrefix = subtitle.speaker
            ? subtitle.speaker + ": "
            : "";
          $("lastText").textContent = speakerPrefix + subtitle.text;
          if (!activeSpeech && displayRole) {
            renderRoleBadge(displayRole, "");
          }
          captionController.observe(subtitle, now);
        }
        pumpSpeechQueue();
      } catch (error) {
        consecutiveOcrErrors++;
        invalidateFrameGate();
        console.error("OCR error", error);
        const errorText = error && error.message ? error.message : String(error);
        $("ocrState").textContent = "Ошибка OCR · повтор";
        $("lastText").textContent = "Сбой распознавания: " + errorText;
        if (consecutiveOcrErrors >= 2 && scanning) {
          $("ocrState").textContent = "Перезапуск OCR…";
          try {
            const failedWorker = worker;
            worker = null;
            workerWarm = false;
            if (failedWorker) {
              try { await failedWorker.dispose(); } catch (_) {}
            }
            if (scanning) {
              await ensureOcrWorker();
              consecutiveOcrErrors = 0;
              $("ocrState").textContent = "OCR восстановлен";
            }
          } catch (restartError) {
            console.error("OCR restart failed", restartError);
            $("ocrState").textContent = "Сбой перезапуска OCR";
          }
        }
      }

      await wait(2);
    }

    loopRunning = false;
  }

  $("startCamera").addEventListener("click", async () => {
    voiceEngine.unlockAudio();
    updateSpeechButton();
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Открой страницу через HTTPS в Chrome и разреши камеру.");
      }
      setStatus("Запуск камеры…");
      const cameraPromise = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      });

      // Start camera & OCR worker initialization concurrently for instant boot!
      const [mediaStream] = await Promise.all([cameraPromise, ensureOcrWorker()]);
      stream = mediaStream;

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack?.getCapabilities && videoTrack?.applyConstraints) {
        try {
          const caps = videoTrack.getCapabilities();
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
            await videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
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
      $("speechState").textContent = speechEnabled ? "Готова" : "Остановлена";

      invalidateFrameGate();
      lastHadSubtitle = false;
      captionController.reset();
      captionController.setCastMode($("castMode").value);
      updateDiagnostics();

      scanning = true;
      document.body.classList.add("running");
      setStatus("Сканирует");
      scanLoop();
    } catch (error) {
      console.error(error);
      setStatus("Ошибка запуска");
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
    while (loopRunning) await wait(20);
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
    setStatus("Готов");
  });

  $("toggleRecognition").addEventListener("click", () => {
    recognitionEnabled = !recognitionEnabled;
    captionController.clearQueueAndSpeech();
    invalidateFrameGate();
    updateDiagnostics();
    updateRecognitionButton();
    $("ocrState").textContent = recognitionEnabled
      ? (scanning ? "Активно" : "Ожидание")
      : "Пауза OCR";
  });

  $("toggleSpeech").addEventListener("click", () => {
    voiceEngine.unlockAudio();
    speechEnabled = !speechEnabled;
    updateSpeechButton();
    if (!speechEnabled) {
      cancelSpeechAndQueue();
      $("speechState").textContent = "Остановлена";
    } else {
      $("speechState").textContent = "Готова";
      pumpSpeechQueue();
    }
  });

  function speakStandalone(text, role = ROLES.JASON) {
    const lines = String(text || "").split(/\r?\n/).map(cleanText).filter(Boolean);
    if (!lines.length) {
      $("manualTestStatus").textContent = "Введи текст для озвучки.";
      return;
    }

    voiceEngine.unlockAudio();
    cancelSpeechAndQueue();
    activeSpeech = true;
    activeSpeechStartedAt = Date.now();

    // Each non-empty line is a separate dialogue turn. Role assignment comes
    // from automatic speaker tags, text cues, and the selected cast mode.
    const dialogueLines = lines.map(line => {
      const extracted = extractSpeakerTag(line, roleDefinitions);
      const spokenLine = extracted.text || line;
      return {
        text: /^[-—–]/.test(spokenLine) ? spokenLine : "- " + spokenLine,
        speaker: extracted.speaker
      };
    });
    const turns = buildDialogueTurns(dialogueLines, {
      previousRole: "",
      castMode: $("castMode").value,
      roleDefinitions
    });
    const firstRole = turns[0]?.role || role;
    renderRoleBadge(firstRole, voiceEngine.mode === "elevenlabs" ? "ai" : "offline");
    $("manualTestStatus").textContent =
      "Тест: " + (voiceEngine.mode === "elevenlabs" ? "ElevenLabs" : "Офлайн") +
      " · " + ($("castMode").value === "cinema_quad" ? "4 роли" : "GTA Duo") +
      " · реплик: " + turns.length;

    const item = {
      speechText: lines.join(" "),
      role: firstRole,
      turns: turns.length ? turns : [{ text: lines.join(" "), role }]
    };

    voiceEngine.speakItem(item, { catchUpBoost: 0 })
      .catch(err => {
        console.warn("Standalone speech error:", err);
        $("manualTestStatus").textContent = "Ошибка озвучки: " + (err.message || String(err));
        $("speechState").textContent = "Ошибка озвучки";
      })
      .finally(() => {
        activeSpeech = false;
        activeSpeechStartedAt = 0;
        $("speechState").textContent = speechEnabled ? "Готова" : "Остановлена";
        updateDiagnostics();
        pumpSpeechQueue();
      });
  }

  $("testSpeech").addEventListener("click", () => {
    populateOfflineVoiceSelects();
    speakStandalone(
      "- Джейсон, уходим скорее!\n- Я понял, прыгай в машину!",
      ROLES.LUCIA
    );
  });

  $("speakManual").addEventListener("click", () => {
    const text = $("manualText").value;
    if (voiceEngine.mode === "elevenlabs" && !voiceEngine.apiKey.trim()) {
      $("manualTestStatus").textContent = "Для теста ElevenLabs сначала введи API-ключ выше.";
      $("elevenApiKey").focus();
      return;
    }
    speakStandalone(text, ROLES.JASON);
  });

  // PWA Service Worker + Offline Model Pre-Caching
  async function refreshOfflineCacheStatus() {
    const badge = $("offlineBadge");
    if (!("caches" in window)) {
      badge.textContent = "Без кэша";
      return;
    }
    try {
      const keys = await caches.keys();
      let hasModel = false;
      for (const key of keys) {
        const cache = await caches.open(key);
        const reqs = await cache.keys();
        if (reqs.some(r => /\.(tar|onnx|wasm)(\?|$)/i.test(r.url))) {
          hasModel = true;
          break;
        }
      }
      if (hasModel) {
        badge.textContent = navigator.onLine === false ? "Офлайн-режим ✓" : "Офлайн готов ✓";
        badge.classList.add("ready");
        $("prepareOfflineBtn").textContent = "Офлайн-пакет сохранён ✓";
      } else {
        badge.textContent = navigator.onLine === false ? "Нет сети" : "Онлайн";
        badge.classList.remove("ready");
      }
    } catch (_) {}
  }

  $("prepareOfflineBtn").addEventListener("click", async () => {
    const btn = $("prepareOfflineBtn");
    btn.disabled = true;
    btn.textContent = "Скачиваю OCR-модели в память…";
    try {
      await ensureOcrWorker();
      await refreshOfflineCacheStatus();
      btn.textContent = "Офлайн-пакет готов к работе без сети ✓";
    } catch (err) {
      btn.textContent = "Ошибка загрузки: " + (err.message || "проверь интернет");
      btn.disabled = false;
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js?v=0.58").then(() => {
        refreshOfflineCacheStatus();
      }).catch(err => {
        console.warn("SW registration skipped:", err);
      });
    });
  }

  window.addEventListener("online", refreshOfflineCacheStatus);
  window.addEventListener("offline", refreshOfflineCacheStatus);
  refreshOfflineCacheStatus();

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("installAppBtn").hidden = false;
  });

  $("installAppBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try { await deferredInstallPrompt.userChoice; } catch (_) {}
    deferredInstallPrompt = null;
    $("installAppBtn").hidden = true;
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && scanning) {
      voiceEngine.resumeIfSuspended();
      pumpSpeechQueue();
    }
  });
})();