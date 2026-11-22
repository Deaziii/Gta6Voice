import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptionController,
  analyzeCaptionRelation,
  isRussianSubtitleLine,
  normalizeRussianHomoglyphs
} from "./captionController.js";

test("homoglyph fixer and Russian subtitle filter accept short Russian words and reject UI/noise", () => {
  assert.equal(
    normalizeRussianHomoglyphs("— Я заняла этo мecтo! B машину!"),
    "— Я заняла это место! В машину!"
  );
  assert.equal(isRussianSubtitleLine("А я и не в курсе"), true);
  assert.equal(isRussianSubtitleLine("B машину!"), true);
  assert.equal(isRussianSubtitleLine("Он у дома"), true);
  assert.equal(isRussianSubtitleLine("Press X to continue"), false);
  assert.equal(isRussianSubtitleLine("ш п ф ц"), false);
});

test("analyzeCaptionRelation handles two-line extension, missed first word, and rolling overlap", () => {
  const relTypo = analyzeCaptionRelation(
    "— Я заняпа этo место",
    "— Я заняла это место. Для кого?"
  );
  assert.equal(relTypo.type, "extension");
  assert.equal(relTypo.delta, "Для кого?");

  const relMissedFirst = analyzeCaptionRelation(
    "заняла это место",
    "Я заняла это место. Для кого?"
  );
  assert.equal(relMissedFirst.type, "extension");
  assert.equal(relMissedFirst.delta, "Для кого?");

  const relRolling = analyzeCaptionRelation(
    "Мы не успеем до рассвета.",
    "до рассвета. Жми на газ!"
  );
  assert.equal(relRolling.type, "extension");
  assert.equal(relRolling.delta, "Жми на газ!");
});

test("analyzeCaptionRelation suppresses row-2 suffix flicker without blocking genuine short replies", () => {
  const row2Only = analyzeCaptionRelation(
    "Я заняла это место. Для кого?",
    "Для кого?"
  );
  assert.equal(row2Only.type, "partial");

  const row1Only = analyzeCaptionRelation(
    "Я заняла это место. Для кого?",
    "Я заняла это место"
  );
  assert.equal(row1Only.type, "partial");

  const genuineReply = analyzeCaptionRelation(
    "Мы поедем туда завтра утром",
    "Завтра?"
  );
  assert.equal(genuineReply.type, "new");
});

test("zero-delay fast start on clear line + seamless row-2 delta without repeats on flicker", () => {
  const ctrl = new CaptionController();

  ctrl.observe({ text: "Я заняла это место", confidence: 84, lineCount: 1 }, 1000);
  const first = ctrl.pullNextUtterance(1000);
  assert.ok(first);
  assert.equal(first.speechText, "Я заняла это место");
  assert.equal(first.lagMs, 0);

  ctrl.observe({ text: "Я заняла это место. Для кого?", confidence: 88, lineCount: 2 }, 1180);
  ctrl.observe({ text: "Я заняла это место", confidence: 80, lineCount: 1 }, 1350);

  ctrl.onSpeechEnd(1700);
  const second = ctrl.pullNextUtterance(1700);
  assert.ok(second);
  assert.equal(second.speechText, "Для кого?");

  ctrl.observe({ text: "Для кого?", confidence: 86, lineCount: 1 }, 1850);
  ctrl.onSpeechEnd(2200);
  ctrl.observe({ text: "Для кого?", confidence: 86, lineCount: 1 }, 2300);
  assert.equal(ctrl.pullNextUtterance(2300), null);
});

test("latest-wins pending policy drops stale lines and unlocks legitimate repeat after empty screen", () => {
  const ctrl = new CaptionController({
    clearHistoryAfterEmptyMs: 1300,
    maxUnseenAgeMs: 1150,
    staleAfterUnseenTotalMs: 2000,
    maxPendingAgeMs: 3200
  });

  ctrl.observe({ text: "Первая длинная реплика", confidence: 90, lineCount: 1 }, 1000);
  assert.equal(ctrl.pullNextUtterance(1000)?.speechText, "Первая длинная реплика");

  ctrl.observe({ text: "Вторая реплика героя", confidence: 90, lineCount: 1 }, 1300);
  ctrl.observe({ text: "Третья свежая реплика", confidence: 90, lineCount: 1 }, 1600);
  assert.equal(ctrl.getSnapshot(1600).dropped, 1);

  ctrl.observe({ text: "", confidence: 0 }, 1900);
  ctrl.onSpeechEnd(4200);
  assert.equal(ctrl.pullNextUtterance(4200), null);
  assert.equal(ctrl.getSnapshot(4200).stale, 1);

  ctrl.observe({ text: "Стой на месте!", confidence: 90, lineCount: 1 }, 5000);
  assert.equal(ctrl.pullNextUtterance(5000)?.speechText, "Стой на месте!");
  ctrl.onSpeechEnd(5600);

  ctrl.observe({ text: "", confidence: 0 }, 5700);
  ctrl.observe({ text: "", confidence: 0 }, 7100);
  ctrl.observe({ text: "Стой на месте!", confidence: 90, lineCount: 1 }, 7200);
  assert.equal(ctrl.pullNextUtterance(7200)?.speechText, "Стой на месте!");
});
