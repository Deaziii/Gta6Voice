import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptionController,
  evaluateFrameGate,
  formatForFastSpeech,
  isRussianSubtitleLine,
  normalizeRussianHomoglyphs
} from "./captionController.js";

test("recovers pure-homoglyph Russian exclamations like '- Bay!' -> '- Вау!' and fixes mid-word caps", () => {
  assert.equal(
    normalizeRussianHomoglyphs("- Bay!", { frameHasCyrillic: true }),
    "- Вау!"
  );
  assert.equal(isRussianSubtitleLine("- Bay!", { frameHasCyrillic: true }), true);
  assert.equal(
    normalizeRussianHomoglyphs("Hy kak tam?"),
    "Ну как там?"
  );
  assert.equal(
    normalizeRussianHomoglyphs("Мне отмщение, я воздам - ровОрИТ Господь."),
    "Мне отмщение, я воздам - роворит Господь."
  );
  assert.equal(isRussianSubtitleLine("Press X to continue", { frameHasCyrillic: false }), false);
});

test("formatForFastSpeech removes robotic pauses on dashes, ellipses, and mid-line exclamation marks", () => {
  assert.equal(
    formatForFastSpeech("- Вау! - Офигенно! Круто!"),
    "Вау, Офигенно, Круто"
  );
  assert.equal(
    formatForFastSpeech("Мне отмщение, я воздам - говорит Господь..."),
    "Мне отмщение, я воздам, говорит Господь"
  );
  assert.equal(
    formatForFastSpeech("Я заняла это место. Для кого?"),
    "Я заняла это место, Для кого?"
  );
});

test("two-line extension speaks row 1 at 0ms and queues only row 2 without repeating either row", () => {
  const ctrl = new CaptionController();

  ctrl.observe({ text: "Как сказала бы моя Лиза", confidence: 97, lineCount: 1 }, 1000);
  const first = ctrl.pullNextUtterance(1000);
  assert.equal(first?.speechText, "Как сказала бы моя Лиза");

  ctrl.observe({ text: "Как сказала бы моя Лиза, вот это я понимаю, конура!", confidence: 96, lineCount: 2 }, 1350);
  assert.equal(ctrl.shouldPreemptActive(2500), false);

  ctrl.onSpeechEnd(1900);
  const second = ctrl.pullNextUtterance(1900);
  assert.equal(second?.speechText, "вот это я понимаю, конура!");

  ctrl.onSpeechEnd(2400);
  ctrl.observe({ text: "вот это я понимаю, конура!", confidence: 96, lineCount: 1 }, 2500);
  assert.equal(ctrl.pullNextUtterance(2500), null);
});

test("Bilateral Stem Gate ignores DLP rainbow waves & step edges, locks onto same subtitle, and triggers on change", () => {
  const W = 192;
  const H = 48;

  // Helper: background with DLP smooth brightness wave + bright step edge on left (orange vest / wall)
  const makeScene = (waveShift = 0, stems = []) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Step edge at x=30 (bright vest on left, dark background on right) + smooth DLP wave
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

  // 1. Blank moving scene (with step edge + DLP wave) skips after initial frame
  const f0 = makeScene(0, []);
  const g0 = evaluateFrameGate(f0, W, H, {}, 1000);
  assert.equal(g0.run, true);

  const f1 = makeScene(12, []);
  const g1 = evaluateFrameGate(f1, W, H, { lastFullOcrAt: 1000, lastHadSubtitle: false }, 1040);
  assert.equal(g1.run, false);
  assert.equal(g1.reason, "empty-scene");

  // 2. Subtitle A appears in center -> triggers immediately and produces tight horizontal crop
  const subAStems = [[76, 18, 28], [82, 18, 28], [90, 18, 28], [96, 18, 28], [104, 18, 28], [110, 18, 28]];
  const fSubA1 = makeScene(15, subAStems);
  const gSubA1 = evaluateFrameGate(fSubA1, W, H, { lastFullOcrAt: 1000, lastHadSubtitle: false }, 1080);
  assert.equal(gSubA1.run, true);
  assert.equal(gSubA1.reason, "subtitle-appeared");
  assert.ok(gSubA1.crop.x0 > 0.15 && gSubA1.crop.x1 < 0.85);

  // 3. Same Subtitle A stays on screen while DLP wave shifts & hand shakes by +3px -> SKIPPED (0ms wasted!)
  const subAShaken = subAStems.map(([x, y0, y1]) => [x + 3, y0 + 1, y1 + 1]);
  const fSubA2 = makeScene(35, subAShaken);
  const gSubA2 = evaluateFrameGate(
    fSubA2,
    W,
    H,
    {
      lastFullOcrAt: 1100,
      lastHadSubtitle: true,
      prevStemNorm: gSubA1.stemNorm,
      prevActiveCells: gSubA1.activeCells
    },
    1250
  );
  assert.equal(gSubA2.run, false);
  assert.equal(gSubA2.reason, "same-subtitle");

  // 4. Subtitle changes to wider 2-line Subtitle B -> triggers IMMEDIATELY
  const subBStems = [
    ...subAStems,
    [60, 32, 41], [67, 32, 41], [122, 32, 41], [130, 32, 41], [138, 32, 41]
  ];
  const fSubB = makeScene(40, subBStems);
  const gSubB = evaluateFrameGate(
    fSubB,
    W,
    H,
    {
      lastFullOcrAt: 1100,
      lastHadSubtitle: true,
      prevStemNorm: gSubA1.stemNorm,
      prevActiveCells: gSubA1.activeCells
    },
    1300
  );
  assert.equal(gSubB.run, true);
  assert.equal(gSubB.reason, "subtitle-changed");
});