      $("speechState").textContent = "Ошибка TTS";
      finish();
    }
  }

  $("testSpeech").addEventListener("click", () => {
    refreshVoices();
    speakStandalone("Проверка быстрого голоса. Теперь говорю живо, без лишних пауз!");
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

  $("rate").addEventListener("input", event => {
    const val = Number(event.target.value);
    $("rateValue").textContent = val.toFixed(2) + "×";
    syncVoicePacePreset(val);
    savePrefs();
  });
  $("volume").addEventListener("input", event => {
    $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%";
    savePrefs();
  });
})();
      $("speechState").textContent = "Ошибка TTS";
      finish();
    }
  }

  $("testSpeech").addEventListener("click", () => {
    refreshVoices();
    speakStandalone("Проверка быстрого голоса. Теперь говорю живо, без лишних пауз!");
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

  $("rate").addEventListener("input", event => {
    const val = Number(event.target.value);
    $("rateValue").textContent = val.toFixed(2) + "×";
    syncVoicePacePreset(val);
    savePrefs();
  });
  $("volume").addEventListener("input", event => {
    $("volumeValue").textContent = Math.round(Number(event.target.value) * 100) + "%";
    savePrefs();
  });
})();