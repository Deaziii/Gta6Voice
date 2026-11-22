import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptionController,
  analyzeCaptionRelation,
  evaluateFrameGate,
  isRussianSubtitleLine,
  normalizeRussianHomoglyphs
} from "./captionController.js";

test("homoglyphs and mid-word OCR uppercase glitches are normalized without touching acronyms", () => {
  assert.equal(
    normalizeRussianHomoglyphs("Мне отмщение, я воздам - ровОрИТ Господь."),
    "Мне отмщение, я воздам - роворит Господь."
  );
  assert.equal(
    normalizeRussianHomoglyphs("Агенты США уже B городе"),
    "Агенты США уже В городе"
  );
  assert.equal(isRussianSubtitleLine("А я и не в курсе"), true);
  assert.equal(isRussianSubtitleLine("Press X to continue"), false);
});

test("short 1-2 word subtitles without punctuation promote immediately on frame 1 (zero extra OCR pass)", () => {
  const ctrl = new CaptionController();

  ctrl.observe({ text: "Пошли отсюда", confidence: 54, lineCount: 1 }, 1000);
  const first = ctrl.pullNextUtterance(1000);
  assert.ok(first);
  assert.equal(first.speechText, "Пошли отсюда");
  assert.equal(first.lagMs, 0);
});

test("two-line extension speaks row 1 at 0ms and queues only row 2 without repeating either row", () => {
  const ctrl = new CaptionController();

  ctrl.observe({ text: "Мне отмщение, я воздам - ровОрИТ", confidence: 76, lineCount: 1 }, 1000);
  const first = ctrl.pullNextUtterance(1000);
  assert.equal(first?.speechText, "Мне отмщение, я воздам - роворит");

  ctrl.observe({ text: "Мне отмщение, я воздам - говорит Господь.", confidence: 82, lineCount: 2 }, 1450);
  // Preemption must NEVER cut off row 1 for its own row-2 continuation
  assert.equal(ctrl.shouldPreemptActive(4500), false);

  // Camera shake back to row 1 must not overwrite pending row 2
  ctrl.observe({ text: "Мне отмщение, я воздам - говорит", confidence: 74, lineCount: 1 }, 1650);

  ctrl.onSpeechEnd(2100);
  const second = ctrl.pullNextUtterance(2100);
  assert.equal(second?.speechText, "Господь.");

  // Camera shift showing only row 2 is suppressed as partial
  ctrl.onSpeechEnd(2500);
  ctrl.observe({ text: "Господь.", confidence: 88, lineCount: 1 }, 2600);
  assert.equal(ctrl.pullNextUtterance(2600), null);
});

test("preempts dragging long speech when a brand-new dialogue line is waiting on screen", () => {
  const ctrl = new CaptionController({ preemptSingleAfterActiveMs: 3100 });

  ctrl.observe({ text: "Очень длинная предыдущая реплика героя", confidence: 85, lineCount: 2 }, 1000);
  assert.ok(ctrl.pullNextUtterance(1000));

  ctrl.observe({ text: "Новая реплика другого персонажа!", confidence: 88, lineCount: 1 }, 3600);
  ctrl.observe({ text: "Новая реплика другого персонажа!", confidence: 88, lineCount: 1 }, 4150);
  assert.equal(ctrl.shouldPreemptActive(4150), true);
});

test("evaluateFrameGate skips blank/unchanged ROI and triggers immediately on faint text strokes", () => {
  const W = 128;
  const H = 40;
  const makeBuffer = fill => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H * 4; i += 4) {
      rgba[i] = fill;
      rgba[i + 1] = fill;
      rgba[i + 2] = fill;
      rgba[i + 3] = 255;
    }
    return rgba;
  };

  // Initial pass always runs
  const blank1 = makeBuffer(60);
  const g1 = evaluateFrameGate(blank1, W, H, {}, 1000);
  assert.equal(g1.run, true);

  // Unchanged frame skips
  const g2 = evaluateFrameGate(blank1, W, H, { prevGray: g1.gray, lastFullOcrAt: 1000, lastHadSubtitle: false }, 1050);
  assert.equal(g2.run, false);
  assert.equal(g2.reason, "unchanged");

  // Uniform brightness shift without any vertical strokes (camera pan on blank wall) skips
  const blankShifted = makeBuffer(80);
  const g3 = evaluateFrameGate(blankShifted, W, H, { prevGray: g1.gray, lastFullOcrAt: 1000, lastHadSubtitle: false }, 1100);
  assert.equal(g3.run, false);
  assert.equal(g3.reason, "empty-scene");

  // Faint 2-letter text strokes (+16 luma above background) immediately trigger OCR
  const withFaintSubtitle = makeBuffer(60);
  for (let y = 16; y <= 24; y++) {
    for (const stemX of [50, 54, 60, 64]) {
      const idx = (y * W + stemX) * 4;
      withFaintSubtitle[idx] = 82;
      withFaintSubtitle[idx + 1] = 82;
      withFaintSubtitle[idx + 2] = 82;
    }
  }
  const g4 = evaluateFrameGate(withFaintSubtitle, W, H, { prevGray: g1.gray, lastFullOcrAt: 1000, lastHadSubtitle: false }, 1130);
  assert.equal(g4.run, true);
  assert.equal(g4.reason, "changed");
});
