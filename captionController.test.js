import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptionController,
  ROLES,
  buildDialogueTurns,
  evaluateFrameGate,
  extractSpeakerTag,
  formatForFastSpeech,
  inferSpeakerRole,
  isRussianSubtitleLine,
  normalizeRussianHomoglyphs
} from "./captionController.js";

test("extractSpeakerTag and inferSpeakerRole classify main & secondary male/female speakers accurately", () => {
  const t1 = extractSpeakerTag("Jason: Держись крепче!");
  assert.equal(t1.speaker, "Jason");
  assert.equal(inferSpeakerRole({ text: t1.text, speaker: t1.speaker }), ROLES.JASON);

  const t2 = extractSpeakerTag("Люсия: Я сама поведу машину!");
  assert.equal(t2.speaker, "Люсия");
  assert.equal(inferSpeakerRole({ text: t2.text, speaker: t2.speaker }), ROLES.LUCIA);

  const t3 = extractSpeakerTag("Лиза: Куда вы собрались?");
  assert.equal(inferSpeakerRole({ text: t3.text, speaker: t3.speaker }), ROLES.FEMALE_NPC);

  const t4 = extractSpeakerTag("Охранник: Стой на месте!");
  assert.equal(inferSpeakerRole({ text: t4.text, speaker: t4.speaker }), ROLES.MALE_NPC);

  // Hidden speaker names inferred from Russian verb morphology & vocative address
  assert.equal(
    inferSpeakerRole({ text: "Я заняла это место ещё утром!", previousRole: ROLES.JASON }),
    ROLES.LUCIA
  );
  assert.equal(
    inferSpeakerRole({ text: "Я уже проверил чёрный ход.", previousRole: ROLES.LUCIA }),
    ROLES.JASON
  );
  assert.equal(
    inferSpeakerRole({ text: "Джейсон, уходим отсюда!", previousRole: ROLES.JASON }),
    ROLES.LUCIA
  );
});

test("buildDialogueTurns splits two-line dash dialogues into distinct alternating character voices", () => {
  const turns = buildDialogueTurns([
    { text: "- Вау!", speaker: "" },
    { text: "- Офигенно! Круто!", speaker: "" }
  ], { previousRole: ROLES.JASON, castMode: "gta_duo" });

  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, ROLES.LUCIA);
  assert.equal(turns[1].role, ROLES.JASON);
});

test("homoglyphs, fast speech formatting, and two-line extension delta with role switch work cleanly", () => {
  assert.equal(
    normalizeRussianHomoglyphs("- Bay!", { frameHasCyrillic: true }),
    "- Вау!"
  );
  assert.equal(isRussianSubtitleLine("- Bay!", { frameHasCyrillic: true }), true);
  assert.equal(
    formatForFastSpeech("- Вау! - Офигенно! Круто!"),
    "Вау, Офигенно, Круто"
  );

  const ctrl = new CaptionController();
  ctrl.observe({ text: "- Я готова!", confidence: 92, lineCount: 1 }, 1000);
  const first = ctrl.pullNextUtterance(1000);
  assert.equal(first?.role, ROLES.LUCIA);

  // Second speaker line arrives as extension starting with dash -> switches to Jason!
  ctrl.observe({ text: "- Я готова! - Погнали скорее!", confidence: 94, lineCount: 2 }, 1350);
  ctrl.onSpeechEnd(1800);
  const second = ctrl.pullNextUtterance(1800);
  assert.equal(second?.speechText, "- Погнали скорее!");
  assert.equal(second?.role, ROLES.JASON);
});

test("Bilateral Stem Gate skips DLP waves and unchanged subtitles while triggering on new text", () => {
  const W = 192;
  const H = 48;
  const makeScene = (waveShift = 0, stems = []) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const step = x < 30 ? 150 : 45;
        const wave = Math.round(25 * Math.sin((x + waveShift) / 18));
        const v = Math.max(0, Math.min(255, step + wave));
        const idx = (y * W + x) * 4;
        rgba[idx] = v;
        rgba[idx + 1] = v;
        rgba[idx + 2] = v;
        rgba[idx + 3] = 255;
      }
    }
    for (const [sx, y0, y1] of stems) {
      for (let y = y0; y <= y1; y++) {
        for (let dx = 0; dx < 2; dx++) {
          const idx = (y * W + sx + dx) * 4;
          rgba[idx] = 235;
          rgba[idx + 1] = 235;
          rgba[idx + 2] = 235;
        }
      }
    }
    return rgba;
  };

  const g0 = evaluateFrameGate(makeScene(0, []), W, H, {}, 1000);
  assert.equal(g0.run, true);

  const gEmpty = evaluateFrameGate(makeScene(15, []), W, H, { lastFullOcrAt: 1000, lastHadSubtitle: false }, 1050);
  assert.equal(gEmpty.run, false);

  const stemsA = [[76, 18, 28], [82, 18, 28], [90, 18, 28], [96, 18, 28], [104, 18, 28], [110, 18, 28]];
  const gSubA = evaluateFrameGate(makeScene(20, stemsA), W, H, { lastFullOcrAt: 1000, lastHadSubtitle: false }, 1100);
  assert.equal(gSubA.run, true);

  const gSame = evaluateFrameGate(
    makeScene(35, stemsA),
    W,
    H,
    { lastFullOcrAt: 1100, lastHadSubtitle: true, prevStemNorm: gSubA.stemNorm, prevActiveCells: gSubA.activeCells },
    1250
  );
  assert.equal(gSame.run, false);
});