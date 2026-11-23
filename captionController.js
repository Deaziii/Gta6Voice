const HOMOGLYPH_MAP = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У",
  a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у"
};

const NON_HOMOGLYPH_LATIN = /[DFGIJLNQRSUVWZbdfghijklmnqrstuvwz]/;
const VALID_SINGLE_LETTER_WORDS = new Set(["а", "и", "о", "у", "я", "в", "к", "с", "ж", "б"]);

const UNAMBIGUOUS_HOMOGLYPH_RUSSIAN = new Set([
  "ну", "неа", "ух", "хех", "ха", "хаха", "хохо", "как", "так", "там", "тут", "кто", "сто", "ау", "ее"
]);
const CONTEXTUAL_HOMOGLYPH_EXCLAMATIONS = new Set([
  "вау", "ах", "ох", "не", "вот", "кот", "рот", "пот", "тот"
]);

export const ROLES = {
  JASON: "jason",
  LUCIA: "lucia",
  MALE_NPC: "male_npc",
  FEMALE_NPC: "female_npc"
};

export const ROLE_META = {
  jason: { id: "jason", label: "Джейсон · ГГ (М)", short: "Джейсон", gender: "m", main: true },
  lucia: { id: "lucia", label: "Люсия · ГГ (Ж)", short: "Люсия", gender: "f", main: true },
  male_npc: { id: "male_npc", label: "Персонаж · 2 план (М)", short: "Персонаж М", gender: "m", main: false },
  female_npc: { id: "female_npc", label: "Персонаж · 2 план (Ж)", short: "Персонаж Ж", gender: "f", main: false }
};

export const DEFAULT_ROLE_DEFINITIONS = [
  { id: ROLES.JASON, name: "Джейсон", aliases: ["Jason", "Джейсон"], gender: "m", main: true, builtin: true },
  { id: ROLES.LUCIA, name: "Люсия", aliases: ["Lucia", "Люсия", "Лусия"], gender: "f", main: true, builtin: true },
  { id: ROLES.MALE_NPC, name: "Второстепенный (М)", aliases: ["Охранник", "Полицейский", "Мужчина"], gender: "m", main: false, builtin: true },
  { id: ROLES.FEMALE_NPC, name: "Второстепенная (Ж)", aliases: ["Девушка", "Женщина", "Дама"], gender: "f", main: false, builtin: true }
];

const normalizeSpeakerName = value => cleanText(value).toLocaleLowerCase("ru-RU").replace(/[.]/g, "");

const FEMALE_SPEAKER_KEYWORDS = new Set([
  "lucia", "люсия", "лусия", "лиза", "lisa", "сара", "sarah", "мария", "маша", "анна", "аня",
  "катя", "елена", "лена", "ольга", "оля", "наташа", "таня", "юля", "даша", "ксюша", "вика",
  "нина", "вера", "соня", "алиса", "ева", "эмма", "рейчел", "лора", "стефани", "тамара",
  "девушка", "женщина", "дама", "леди", "мама", "мать", "сестра", "бабушка", "тётя", "тетя",
  "жена", "подруга", "невеста", "хозяйка", "продавщица", "официантка", "медсестра", "ведущая",
  "актриса", "певица", "соседка", "старуха", "девчонка", "блондинка", "брюнетка", "диспетчерша"
]);

const MALE_A_EXCEPTIONS = new Set([
  "никита", "илья", "лука", "фома", "кузьма", "савва", "данила", "гаврила", "миша", "гриша",
  "ваня", "петя", "коля", "вася", "федя", "стёпа", "степа", "лёша", "леша", "паша", "даня",
  "серёжа", "сережа", "дима", "костя", "толя", "боря", "витя", "гена", "жора", "гоша", "сёма",
  "папа", "батя", "дядя", "дедушка", "мужчина", "парнишка", "мальчишка", "судья", "староста",
  "убийца", "вышибала", "заводила", "коллега", "бедолага", "бродяга", "работяга", "пьяница"
]);

const NON_VERB_LA_WORDS = new Set([
  "дела", "слова", "тела", "стекла", "стёкла", "числа", "кресла", "зеркала",
  "правила", "крыла", "села", "угла", "стола", "ствола", "узла", "орла", "козла", "осла"
]);

const MASC_FIRST_PERSON_RE = /(?:^|[^A-Za-zА-Яа-яЁё])я\s+(?:не\s+|бы\s+|уже\s+|же\s+|ведь\s+|просто\s+|так\s+|тут\s+|там\s+|сам\s+|тоже\s+|сейчас\s+|чуть\s+|ещё\s+|еще\s+){0,2}(?:понял|сказал|сделал|видел|увидел|слышал|услышал|знал|узнал|думал|подумал|решил|пришёл|пришел|ушёл|ушел|вышел|зашёл|зашел|нашёл|нашел|взял|отдал|купил|продал|украл|смог|хотел|забыл|успел|ждал|попал|упал|встал|сел|лёг|лег|дал|стал|жил|был|стрелял|ехал|приехал|уехал|бежал|обещал|просил|спросил|ответил|звонил|проверил|оставил|потерял|бросил|готов|сам|должен|обязан|занят|свободен|уверен|согласен|прав|виноват|устал|жив|здоров|пьян|один)(?![A-Za-zА-Яа-яЁё])/i;

const FEM_SHORT_ADJ_RE = /(?:^|[^A-Za-zА-Яа-яЁё])я\s+(?:не\s+|бы\s+|уже\s+|же\s+|ведь\s+|просто\s+|так\s+|очень\s+|совсем\s+|тоже\s+){0,2}(?:сама|готова|рада|должна|обязана|занята|свободна|уверена|согласна|права|виновата|устала|жива|здорова|пьяна|одна)(?![A-Za-zА-Яа-яЁё])/i;

const FEM_PAST_VERB_RE = /(?:^|[^A-Za-zА-Яа-яЁё])я\s+(?:не\s+|бы\s+|уже\s+|же\s+|ведь\s+|просто\s+|так\s+|тут\s+|там\s+|сама\s+|тоже\s+|сейчас\s+|чуть\s+|ещё\s+|еще\s+){0,2}([а-яё]{3,}(?:ла|лась))(?![A-Za-zА-Яа-яЁё])/i;

export const cleanText = value => (value || "").replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();

export function fixMidWordCase(text) {
  return text.replace(/[А-Яа-яЁё]{2,}/g, word => {
    const hasLower = /[а-яё]/.test(word);
    const hasUpperAfterFirst = /[А-ЯЁ]/.test(word.slice(1));
    if (hasLower && hasUpperAfterFirst) {
      return word[0] + word.slice(1).toLocaleLowerCase("ru-RU");
    }
    return word;
  });
}

function mapHomoglyphToken(token) {
  return token.replace(/[ABCEHKMOPTXYaceopxy]/g, ch => HOMOGLYPH_MAP[ch] || ch);
}

export function normalizeRussianHomoglyphs(value, options = {}) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const frameHasCyrillic = Boolean(options.frameHasCyrillic);
  const cyrillicCount = (cleaned.match(/[А-Яа-яЁё]/g) || []).length;
  const hasDialoguePunct = /^[-—–]/.test(cleaned) || /[!?…]/.test(cleaned);

  const mapped = cleaned.split(" ").map(token => {
    const core = token.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    if (!core || NON_HOMOGLYPH_LATIN.test(core)) return token;

    const hasCyrillic = /[А-Яа-яЁё]/.test(core);
    if (hasCyrillic) return mapHomoglyphToken(token);

    if (/^[ABCEHKMOPTXYaceopxy]+$/.test(core)) {
      const candidateRu = mapHomoglyphToken(core).toLocaleLowerCase("ru-RU");
      if (cyrillicCount >= 2 && core.length <= 2) return mapHomoglyphToken(token);
      if (UNAMBIGUOUS_HOMOGLYPH_RUSSIAN.has(candidateRu)) return mapHomoglyphToken(token);
      if (
        CONTEXTUAL_HOMOGLYPH_EXCLAMATIONS.has(candidateRu) &&
        (frameHasCyrillic || cyrillicCount >= 1 || hasDialoguePunct)
      ) {
        return mapHomoglyphToken(token);
      }
    }
    return token;
  }).join(" ");

  return fixMidWordCase(mapped);
}

/**
 * Fast speech formatter for offline SpeechSynthesis: strips artificial 400ms pauses
 * on dashes/ellipses/mid-sentence stops while keeping question intonation.
 */
export function formatForFastSpeech(text) {
  let out = cleanText(text);
  if (!out) return "";

  out = out.replace(/^[-—–]+\s*/, "");
  out = out.replace(/\s+[-—–]+\s+/g, ", ");
  out = out.replace(/\.{2,}|…+/g, ", ");

  const endsWithQuestion = /\?\s*$/.test(out);
  out = out.replace(/[.!?]+(?=\s*,)/g, "");
  out = out.replace(/[.!?]+\s+(?=[А-Яа-яЁёA-Za-z0-9])/g, ", ");
  out = out.replace(/[,;:]+\s*,+/g, ", ");
  out = out.replace(/\s+,/g, ",");
  out = out.replace(/[.!,;:\s]+$/, "").trim();

  if (endsWithQuestion && out && !out.endsWith("?")) {
    out += "?";
  }
  return out;
}

/**
 * Natural speech formatter for neural AI TTS (ElevenLabs): keeps emotional ! and ?
 * cues that drive expressive voice acting while cleaning OCR dashes and artifacts.
 */
export function formatForAiSpeech(text) {
  let out = cleanText(text);
  if (!out) return "";
  out = out.replace(/^[-—–]+\s*/, "");
  out = out.replace(/\s+[-—–]+\s+/g, ", ");
  out = out.replace(/\.{3,}/g, "…");
  return out.trim();
}

export const normalizeKey = value => normalizeRussianHomoglyphs(value)
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[^а-яa-z0-9 ]/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

export function isRussianSubtitleLine(line, options = {}) {
  const value = normalizeRussianHomoglyphs(line, options);
  const letters = value.match(/[A-Za-zА-Яа-яЁё]/g) || [];
  const cyrillic = value.match(/[А-Яа-яЁё]/g) || [];
  if (cyrillic.length < 2 || !letters.length) return false;
  if (cyrillic.length / letters.length < 0.80) return false;
  if (!/[аеёиоуыэюя]/i.test(value)) return false;
  if (/[бвгджзйклмнпрстфхцчшщъь]{6,}/i.test(value)) return false;

  const words = value
    .replace(/[^A-Za-zА-Яа-яЁё0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;

  const hasMultiLetterCyrillicWord = words.some(
    word => (word.match(/[А-Яа-яЁё]/g) || []).length >= 2
  );
  if (!hasMultiLetterCyrillicWord) return false;

  const invalidSingleWords = words.filter(
    word => /^[А-Яа-яЁё]$/i.test(word) && !VALID_SINGLE_LETTER_WORDS.has(word.toLocaleLowerCase("ru-RU"))
  ).length;
  if (invalidSingleWords >= 2 || invalidSingleWords / words.length > 0.25) return false;

  return true;
}

/**
 * Extract speaker prefix from a subtitle line (e.g. "Jason: ...", "Люсия: ...",
 * "Охранник: ...", "[Диспетчер] ...", "Лиза: ...") without false-matching normal prose.
 */
export function extractSpeakerTag(rawLine, roleDefinitions = DEFAULT_ROLE_DEFINITIONS) {
  const line = cleanText(rawLine);
  if (!line) return { speaker: "", text: "" };

  // User-configured speaker names/aliases are checked first, including colon and dash separators.
  const aliases = roleDefinitions.flatMap(role => [role.name, ...(role.aliases || [])]
    .filter(Boolean).map(name => ({ name: cleanText(name), roleId: role.id })))
    .sort((a, b) => b.name.length - a.name.length);
  for (const alias of aliases) {
    if (line.toLocaleLowerCase("ru-RU").startsWith(alias.name.toLocaleLowerCase("ru-RU"))) {
      const rest = line.slice(alias.name.length).match(/^\\s*[:：—–-]\\s*(.*)$/);
      if (rest) return { speaker: alias.name, text: cleanText(rest[1]) };
    }
  }

  // 1. Known GTA protagonists & recurring cast (allow colon or dash)");
    const match = line.match(new RegExp("^(" + escaped + ")\\s*[:：—–-]\\s*(.*)$", "i"));
    if (match) return { speaker: cleanText(match[1]), text: cleanText(match[2]) };
  }

  // 1. Known GTA protagonists & recurring cast (allow colon or dash)
  const heroMatch = line.match(
    /^(Jason|Lucia|Джейсон|Люсия|Лусия|Raul|Рауль|Cal|Кэл|Boobie|Буби|Brian|Брайан|Tourist|Турист)\s*[:：—–-]\s*(.*)$/i
  );
  if (heroMatch) {
    return { speaker: cleanText(heroMatch[1]), text: cleanText(heroMatch[2]) };
  }

  // 2. Bracketed speaker tag: [Коп] Текст / (Девушка) Текст
  const bracketMatch = line.match(/^(?:\[([^\]]{2,22})\]|\(([^)]{2,22})\))\s*[:：—–-]?\s*(.*)$/);
  if (bracketMatch) {
    const label = cleanText(bracketMatch[1] || bracketMatch[2]);
    if (/^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9\s'’-]*$/.test(label) && label.split(/\s+/).length <= 2) {
      return { speaker: label, text: cleanText(bracketMatch[3]) };
    }
  }

  // 3. Explicit "Имя:" or "Роль:" with colon (capitalized 1-2 word speaker label)
  const colonMatch = line.match(/^([A-ZА-ЯЁ][A-Za-zА-Яа-яЁё'’-]{1,16}(?:\s+[A-ZА-ЯЁa-zа-яё0-9'’-]{1,14})?)\s*[:：]\s*(.*)$/);
  if (colonMatch) {
    const candidate = cleanText(colonMatch[1]);
    const rest = cleanText(colonMatch[2]);
    // Ignore time-like or common introductory words like "Внимание:", "Вопрос:", "Ответ:", "Пример:"
    if (!/^(внимание|вопрос|ответ|итого|место|время|цель|задание|совет|подсказка)$/i.test(candidate)) {
      return { speaker: candidate, text: rest };
    }
  }

  return { speaker: "", text: line };
}

function classifyExplicitSpeakerName(speaker, roleDefinitions = DEFAULT_ROLE_DEFINITIONS) {
  const norm = normalizeSpeakerName(speaker);
  if (!norm) return null;
  for (const role of roleDefinitions) {
    const names = [role.name, ...(Array.isArray(role.aliases) ? role.aliases : [])]
      .map(normalizeSpeakerName).filter(Boolean);
    if (names.some(name => norm === name || norm.startsWith(name + " "))) return role.id;
  }
  // Keep the legacy gender heuristic only for the four built-in roles.
  if (/^(?:jason|джейсон)(?:$|\s)/.test(norm)) return ROLES.JASON;
  if (/^(?:lucia|люсия|лусия)(?:$|\s)/.test(norm)) return ROLES.LUCIA;
  const words = norm.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (FEMALE_SPEAKER_KEYWORDS.has(w)) return ROLES.FEMALE_NPC;
    if (MALE_A_EXCEPTIONS.has(w)) return ROLES.MALE_NPC;
  }
  const first = words[0] || "";
  if (/^[а-яё]{3,}(?:а|я|ия|ша|ка|ца|нья)$/.test(first) && !MALE_A_EXCEPTIONS.has(first)) return ROLES.FEMALE_NPC;
  return ROLES.MALE_NPC;
}

function detectTextGenderCue(text) {
  const value = cleanText(text);
  if (!value) return null;

  if (FEM_SHORT_ADJ_RE.test(value)) return "f";
  if (/^(?:сама|готова|рада|поняла|сказала|забыла|устала|согласна)(?![A-Za-zА-Яа-яЁё])/i.test(value)) return "f";

  const femVerbMatch = value.match(FEM_PAST_VERB_RE);
  if (femVerbMatch) {
    const verb = femVerbMatch[1].toLocaleLowerCase("ru-RU");
    if (!NON_VERB_LA_WORDS.has(verb)) return "f";
  }

  if (MASC_FIRST_PERSON_RE.test(value)) return "m";
  if (/^(?:сам\s+знаю|понял|согласен|готов)(?![A-Za-zА-Яа-яЁё])/i.test(value)) return "m";

  // Conversational address cues (if calling listener "детка/милая/красотка" -> likely male; "милый/красавчик" -> likely female)
  if (/(?:^|[^A-Za-zА-Яа-яЁё])(?:детка|милая|дорогая|красотка|сестрёнка|подруга)(?=$|[^A-Za-zА-Яа-яЁё])/i.test(value)) return "m";
  if (/(?:^|[^A-Za-zА-Яа-яЁё])(?:милый|дорогой|красавчик)(?=$|[^A-Za-zА-Яа-яЁё])/i.test(value)) return "f";

  return null;
}

export function alternateRole(previousRole, castMode = "gta_duo", roleDefinitions = DEFAULT_ROLE_DEFINITIONS) {
  if (roleDefinitions.length > DEFAULT_ROLE_DEFINITIONS.length) {
    const ids = roleDefinitions.map(role => role.id);
    const index = ids.indexOf(previousRole);
    return ids[(index + 1 + ids.length) % ids.length] || ROLES.JASON;
  }
  if (castMode === "cinema_quad") {
    switch (previousRole) {
      case ROLES.JASON: return ROLES.LUCIA;
      case ROLES.LUCIA: return ROLES.MALE_NPC;
      case ROLES.MALE_NPC: return ROLES.FEMALE_NPC;
      default: return ROLES.JASON;
    }
  }
  switch (previousRole) {
    case ROLES.JASON: return ROLES.LUCIA;
    case ROLES.LUCIA: return ROLES.JASON;
    case ROLES.MALE_NPC: return ROLES.JASON;
    case ROLES.FEMALE_NPC: return ROLES.LUCIA;
    default: return ROLES.JASON;
  }
}

/**
 * Zero-latency character & gender inference for Russian subtitles:
 * maps speaker tags, Russian verb/adjective morphology, vocative exclusions,
 * and dialogue-dash turn switches to one of 4 distinct voice slots.
 */
export function inferSpeakerRole({
  text = "",
  speaker = "",
  previousRole = "",
  castMode = "gta_duo",
  forceSwitch = false,
  roleDefinitions = DEFAULT_ROLE_DEFINITIONS
} = {}) {
  // 1. Explicit speaker name always wins; user-defined aliases are checked before heuristics.
  const byName = classifyExplicitSpeakerName(speaker, roleDefinitions);
  if (byName) return byName;

  const cleaned = cleanText(text);
  const startsWithDash = /^[-—–]/.test(cleaned);
  const shouldSwitch = forceSwitch || (startsWithDash && Boolean(previousRole));

  // 2. Direct vocative address exclusion ("Джейсон, ..." means speaker is NOT Jason)
  const addressesJason = /(?:^|[,!?…\s])(?:джейсон|jason)(?:[,!?…]|$)/i.test(cleaned);
  const addressesLucia = /(?:^|[,!?…\s])(?:люсия|лусия|lucia)(?:[,!?…]|$)/i.test(cleaned);
  const genderCue = detectTextGenderCue(cleaned);

  if (addressesJason && !addressesLucia) {
    if (genderCue === "m") return ROLES.MALE_NPC;
    return ROLES.LUCIA;
  }
  if (addressesLucia && !addressesJason) {
    if (genderCue === "f") return ROLES.FEMALE_NPC;
    return ROLES.JASON;
  }

  // 3. Grammatical gender cue in Russian text
  if (genderCue === "f" || genderCue === "m") {
    if (roleDefinitions.length > DEFAULT_ROLE_DEFINITIONS.length) {
      const matching = roleDefinitions.filter(role => role.gender === genderCue);
      if (matching.length) {
        const current = matching.find(role => role.id === previousRole);
        const next = matching.find(role => role.main && role.id !== previousRole) ||
          matching.find(role => !role.main && role.id !== previousRole) || current || matching[0];
        return next.id;
      }
    }
    if (genderCue === "f") {
      if (shouldSwitch && previousRole === ROLES.LUCIA) return ROLES.FEMALE_NPC;
      if (!shouldSwitch && previousRole === ROLES.FEMALE_NPC) return ROLES.FEMALE_NPC;
      return ROLES.LUCIA;
    }
    if (shouldSwitch && previousRole === ROLES.JASON) return ROLES.MALE_NPC;
    if (!shouldSwitch && previousRole === ROLES.MALE_NPC) return ROLES.MALE_NPC;
    return ROLES.JASON;
  }

  // 4. Dialogue turn switch ("- Вау! / - Офигенно!")
  if (shouldSwitch && previousRole) {
    return alternateRole(previousRole, castMode, roleDefinitions);
  }

  // 5. Maintain current speaker continuity or default to Jason
  return previousRole || ROLES.JASON;
}

/**
 * Build spoken turns for a frame's accepted subtitle lines.
 * If a two-line frame contains a dash dialogue exchange ("- Вау!" / "- Офигенно! Круто!"),
 * returns two distinct role-tagged turns so two characters speak back-to-back.
 */
export function buildDialogueTurns(acceptedLines, { previousRole = "", castMode = "gta_duo", roleDefinitions = DEFAULT_ROLE_DEFINITIONS } = {}) {
  if (!Array.isArray(acceptedLines) || !acceptedLines.length) return [];

  const groups = [];
  for (let i = 0; i < acceptedLines.length; i++) {
    const line = acceptedLines[i];
    const lineStartsWithDash = /^[-—–]/.test(line.text);
    const hasNewSpeaker = Boolean(line.speaker) && groups.length > 0 && line.speaker !== groups[groups.length - 1].speaker;

    if (groups.length === 0 || (i > 0 && (lineStartsWithDash || hasNewSpeaker))) {
      groups.push({
        speaker: line.speaker || "",
        texts: [line.text],
        startsWithDash: lineStartsWithDash
      });
    } else {
      groups[groups.length - 1].texts.push(line.text);
      if (!groups[groups.length - 1].speaker && line.speaker) {
        groups[groups.length - 1].speaker = line.speaker;
      }
    }
  }

  let runningRole = previousRole;
  return groups.map((group, idx) => {
    const joined = cleanText(group.texts.join(" "));
    const role = inferSpeakerRole({
      text: joined,
      speaker: group.speaker,
      previousRole: runningRole,
      castMode,
      forceSwitch: idx > 0 || (group.startsWithDash && Boolean(runningRole)),
      roleDefinitions
    });
    runningRole = role;
    return {
      text: joined,
      speaker: group.speaker,
      role
    };
  });
}

const GRID_COLS = 24;
const GRID_ROWS = 6;
const GRID_SIZE = GRID_COLS * GRID_ROWS;

function shiftedGridDistance(normNow, normPrev) {
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let diff = 0;
      for (let y = 0; y < GRID_ROWS; y++) {
        const py = y + dy;
        for (let x = 0; x < GRID_COLS; x++) {
          const px = x + dx;
          const curVal = normNow[y * GRID_COLS + x];
          const prevVal = (py >= 0 && py < GRID_ROWS && px >= 0 && px < GRID_COLS)
            ? normPrev[py * GRID_COLS + px]
            : 0;
          const d = curVal - prevVal;
          diff += d < 0 ? -d : d;
        }
      }
      if (diff < best) best = diff;
    }
  }
  return best;
}

export function evaluateFrameGate(rgba, width, height, state = {}, now = Date.now()) {
  const pixelCount = width * height;
  if (!rgba || rgba.length < pixelCount * 4) {
    return { run: true, reason: "no-buffer", stemNorm: null, activeCells: 0, crop: null };
  }

  const gray = new Uint8Array(pixelCount);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }

  const cellW = Math.max(1, Math.floor(width / GRID_COLS));
  const cellH = Math.max(1, Math.floor(height / GRID_ROWS));
  const stemGrid = new Float32Array(GRID_SIZE);
  const hitGrid = new Uint16Array(GRID_SIZE);

  for (let y = 2; y < height - 2; y++) {
    const row = y * width;
    const cy = Math.min(GRID_ROWS - 1, Math.floor(y / cellH));
    for (let x = 5; x < width - 5; x++) {
      const g = gray[row + x];
      if (g < 38) continue;

      let minL = gray[row + x - 1];
      if (gray[row + x - 2] < minL) minL = gray[row + x - 2];
      if (gray[row + x - 3] < minL) minL = gray[row + x - 3];
      if (gray[row + x - 4] < minL) minL = gray[row + x - 4];
      if (gray[row + x - 5] < minL) minL = gray[row + x - 5];

      let minR = gray[row + x + 1];
      if (gray[row + x + 2] < minR) minR = gray[row + x + 2];
      if (gray[row + x + 3] < minR) minR = gray[row + x + 3];
      if (gray[row + x + 4] < minR) minR = gray[row + x + 4];
      if (gray[row + x + 5] < minR) minR = gray[row + x + 5];

      const base = minL > minR ? minL : minR;
      const stem = g - base;
      if (stem >= 13) {
        const cx = Math.min(GRID_COLS - 1, Math.floor(x / cellW));
        const idx = cy * GRID_COLS + cx;
        stemGrid[idx] += stem;
        hitGrid[idx] += 1;
      }
    }
  }

  let activeCells = 0;
  let totalStem = 0;
  let minCol = GRID_COLS;
  let maxCol = -1;
  let minRow = GRID_ROWS;
  let maxRow = -1;

  for (let cy = 0; cy < GRID_ROWS; cy++) {
    for (let cx = 0; cx < GRID_COLS; cx++) {
      const idx = cy * GRID_COLS + cx;
      if (hitGrid[idx] >= 3 && stemGrid[idx] >= 52) {
        activeCells++;
        totalStem += stemGrid[idx];
        if (cx < minCol) minCol = cx;
        if (cx > maxCol) maxCol = cx;
        if (cy < minRow) minRow = cy;
        if (cy > maxRow) maxRow = cy;
      } else {
        stemGrid[idx] = 0;
      }
    }
  }

  const lastFullOcrAt = Number(state.lastFullOcrAt) || 0;
  const lastHadSubtitle = Boolean(state.lastHadSubtitle);
  const prevStemNorm = state.prevStemNorm || null;
  const prevActiveCells = Number(state.prevActiveCells) || 0;

  if (activeCells < 2 || totalStem <= 0) {
    if (!lastFullOcrAt) {
      return { run: true, reason: "initial", stemNorm: null, activeCells: 0, crop: null };
    }
    return {
      run: false,
      reason: "empty-scene",
      becameEmpty: lastHadSubtitle,
      stemNorm: null,
      activeCells: 0,
      crop: null
    };
  }

  const stemNorm = new Float32Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) {
    stemNorm[i] = stemGrid[i] / totalStem;
  }

  const crop = {
    x0: Math.max(0, (minCol - 3) / GRID_COLS),
    x1: Math.min(1, (maxCol + 4) / GRID_COLS),
    y0: Math.max(0, (minRow - 2) / GRID_ROWS),
    y1: Math.min(1, (maxRow + 3) / GRID_ROWS)
  };
  if (crop.x1 - crop.x0 < 0.38) {
    const mid = (crop.x0 + crop.x1) / 2;
    crop.x0 = Math.max(0, mid - 0.19);
    crop.x1 = Math.min(1, crop.x0 + 0.38);
  }
  if (crop.y1 - crop.y0 < 0.65) {
    crop.y0 = 0;
    crop.y1 = 1;
  }

  if (!prevStemNorm || prevActiveCells < 2) {
    return { run: true, reason: "subtitle-appeared", stemNorm, activeCells, crop };
  }

  const cellRatio = activeCells / Math.max(1, prevActiveCells);
  const dist = shiftedGridDistance(stemNorm, prevStemNorm);
  const forceEveryMs = lastHadSubtitle ? 1900 : 1200;

  if (
    cellRatio >= 0.74 &&
    cellRatio <= 1.34 &&
    dist < 0.24 &&
    now - lastFullOcrAt < forceEveryMs
  ) {
    return {
      run: false,
      reason: lastHadSubtitle ? "same-subtitle" : "same-clutter",
      stemNorm: prevStemNorm,
      activeCells: prevActiveCells,
      crop
    };
  }

  return { run: true, reason: "subtitle-changed", stemNorm, activeCells, crop };
}

function levenshteinSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / maxLength;
}

function tokenizeWithNormalizedMap(text) {
  const fixed = normalizeRussianHomoglyphs(text);
  const rawTokens = fixed.split(/\s+/).filter(Boolean);
  const normTokens = [];
  for (let rawIndex = 0; rawIndex < rawTokens.length; rawIndex++) {
    const norm = normalizeKey(rawTokens[rawIndex]);
    if (!norm) continue;
    for (const part of norm.split(/\s+/)) {
      if (part) normTokens.push({ norm: part, rawIndex });
    }
  }
  return { clean: fixed, rawTokens, normTokens };
}

export function analyzeCaptionRelation(previousText, nextText) {
  const prev = tokenizeWithNormalizedMap(previousText);
  const next = tokenizeWithNormalizedMap(nextText);

  if (!prev.normTokens.length || !next.normTokens.length) {
    return { type: "new", delta: next.clean };
  }

  const prevWords = prev.normTokens.map(item => item.norm);
  const nextWords = next.normTokens.map(item => item.norm);
  const prevJoined = prevWords.join(" ");
  const nextJoined = nextWords.join(" ");

  if (prevWords.length === nextWords.length) {
    if (levenshteinSimilarity(prevJoined, nextJoined) >= 0.82) {
      return { type: "same", delta: "" };
    }
  } else if (
    Math.abs(prevJoined.length - nextJoined.length) / Math.max(prevJoined.length, nextJoined.length) <= 0.20 &&
    levenshteinSimilarity(prevJoined, nextJoined) >= 0.85
  ) {
    return { type: "same", delta: "" };
  }

  if (nextWords.length > prevWords.length) {
    const maxOffset = prevWords.length >= 2 ? Math.min(2, nextWords.length - prevWords.length) : 0;
    for (let offset = 0; offset <= maxOffset; offset++) {
      const candidateSlice = nextWords.slice(offset, offset + prevWords.length).join(" ");
      if (levenshteinSimilarity(prevJoined, candidateSlice) >= 0.80) {
        const endNormIndex = offset + prevWords.length - 1;
        if (endNormIndex >= nextWords.length - 1) {
          return { type: "same", delta: "" };
        }
        const lastMatchedRawIndex = next.normTokens[endNormIndex].rawIndex;
        const delta = next.rawTokens.slice(lastMatchedRawIndex + 1).join(" ").trim();
        return {
          type: delta ? "extension" : "same",
          delta
        };
      }
    }
  }

  if (nextWords.length < prevWords.length) {
    const winLen = nextWords.length;
    if (winLen >= 2) {
      for (let start = 0; start <= prevWords.length - winLen; start++) {
        const sliceJoined = prevWords.slice(start, start + winLen).join(" ");
        if (levenshteinSimilarity(nextJoined, sliceJoined) >= 0.82) {
          return { type: "partial", delta: "" };
        }
      }
    } else if (winLen === 1) {
      const word = nextWords[0];
      if (word.length >= 4 || prevWords.length <= 3) {
        const firstSim = levenshteinSimilarity(word, prevWords[0]);
        const lastSim = levenshteinSimilarity(word, prevWords[prevWords.length - 1]);
        if (firstSim >= 0.86 || lastSim >= 0.86) {
          return { type: "partial", delta: "" };
        }
      }
    }
  }

  const maxOverlap = Math.min(prevWords.length, nextWords.length - 1);
  for (let k = maxOverlap; k >= 1; k--) {
    const prevTail = prevWords.slice(prevWords.length - k);
    if (k === 1 && prevTail[0].length < 6) continue;
    const nextHead = nextWords.slice(0, k);
    if (levenshteinSimilarity(prevTail.join(" "), nextHead.join(" ")) >= 0.84) {
      const lastMatchedRawIndex = next.normTokens[k - 1].rawIndex;
      const delta = next.rawTokens.slice(lastMatchedRawIndex + 1).join(" ").trim();
      if (delta) return { type: "extension", delta };
    }
  }

  return { type: "new", delta: next.clean };
}

function isSpeakableFragment(text) {
  if (!text) return false;
  if (normalizeKey(text).length >= 2) return true;
  return /[А-Яа-яЁё]/.test(text) && /[!?…]/.test(text);
}

export class CaptionController {
  constructor(options = {}) {
    this.options = {
      fastStartConfidence: 40,
      emptyGraceMs: 180,
      clearHistoryAfterEmptyMs: 1150,
      historyWindowMs: 4400,
      extensionAfterDoneWindowMs: 2200,
      maxUnseenAgeMs: 1000,
      staleAfterUnseenTotalMs: 1750,
      maxPendingAgeMs: 2600,
      preemptAfterActiveMs: 1450,
      preemptSingleAfterActiveMs: 1950,
      castMode: "gta_duo",
      roleDefinitions: DEFAULT_ROLE_DEFINITIONS,
      ...options
    };
    this.reset();
  }

  setCastMode(mode) {
    this.options.castMode = mode === "cinema_quad" ? "cinema_quad" : "gta_duo";
  }

  setRoleDefinitions(definitions) {
    if (Array.isArray(definitions) && definitions.length) this.options.roleDefinitions = definitions;
  }

  reset() {
    this.candidate = null;
    this.pending = null;
    this.active = null;
    this.history = [];
    this.lastRole = "";
    this.emptySince = null;
    this.droppedDuringActive = 0;
    this.stats = {
      dropped: 0,
      stale: 0,
      spoken: 0,
      lastLagMs: null,
      lastSpeechMs: null
    };
  }

  peekPending() {
    return this.pending;
  }

  observe(observation, now = Date.now()) {
    this.history = this.history.filter(entry => now - entry.completedAt <= this.options.historyWindowMs);

    const rawText = normalizeRussianHomoglyphs(observation?.text || "", { frameHasCyrillic: true });
    const speaker = observation?.speaker || "";
    const confidence = Number(observation?.confidence) || 0;
    const lineCount = Math.max(1, Number(observation?.lineCount) || 1);
    const inputTurns = Array.isArray(observation?.turns) ? observation.turns : null;

    if (!rawText) {
      if (this.emptySince === null) this.emptySince = now;
      const emptyElapsed = now - this.emptySince;

      if (this.candidate && emptyElapsed >= this.options.emptyGraceMs) {
        if (this.candidate.hits >= 2 || this.candidate.confidence >= this.options.fastStartConfidence) {
          this.#promoteCandidate(now);
        } else {
          this.candidate = null;
        }
      }

      if (
        emptyElapsed >= this.options.clearHistoryAfterEmptyMs &&
        !this.active &&
        !this.pending
      ) {
        this.history = [];
      }

      return this.getSnapshot(now);
    }

    this.emptySince = null;
    const key = normalizeKey(rawText);
    if (key.length < 2) return this.getSnapshot(now);

    let suppressPrefixText = "";
    let speechText = rawText;
    let basePreviousRole = this.active?.role || this.pending?.role || this.lastRole;

    if (this.active) {
      const sameSpeakerOrUnknown = !speaker || !this.active.speaker || speaker === this.active.speaker;
      const relActive = analyzeCaptionRelation(this.active.sourceText, rawText);
      if (sameSpeakerOrUnknown && (relActive.type === "same" || relActive.type === "partial")) {
        return this.getSnapshot(now);
      }
      if (sameSpeakerOrUnknown && relActive.type === "extension") {
        suppressPrefixText = this.active.sourceText;
        speechText = relActive.delta;
        basePreviousRole = this.active.role;
      }
    }

    if (this.pending) {
      const sameSpeakerOrUnknown = !speaker || !this.pending.speaker || speaker === this.pending.speaker;
      const relPending = analyzeCaptionRelation(this.pending.sourceText, rawText);
      if (sameSpeakerOrUnknown && relPending.type === "same") {
        this.pending.lastSeenAt = now;
        if (confidence >= this.pending.confidence && rawText.length >= this.pending.sourceText.length) {
          const updatedSpeech = this.pending.suppressPrefixText
            ? analyzeCaptionRelation(this.pending.suppressPrefixText, rawText).delta
            : rawText;
          if (isSpeakableFragment(updatedSpeech)) {
            this.pending.sourceText = rawText;
            this.pending.speechText = updatedSpeech;
            this.pending.key = key;
            this.pending.confidence = confidence;
            this.pending.lineCount = Math.max(this.pending.lineCount, lineCount);
            this.pending.turns = this.#resolveTurns(updatedSpeech, speaker, inputTurns, suppressPrefixText, basePreviousRole);
            this.pending.role = this.pending.turns[0]?.role || this.pending.role;
          }
        }
        this.candidate = null;
        return this.getSnapshot(now);
      }
      if (sameSpeakerOrUnknown && relPending.type === "extension") {
        const updatedSpeech = this.pending.suppressPrefixText
          ? analyzeCaptionRelation(this.pending.suppressPrefixText, rawText).delta
          : rawText;
        if (isSpeakableFragment(updatedSpeech)) {
          this.pending.sourceText = rawText;
          this.pending.speechText = updatedSpeech;
          this.pending.key = key;
          this.pending.lastSeenAt = now;
          this.pending.confidence = Math.max(this.pending.confidence, confidence);
          this.pending.lineCount = Math.max(this.pending.lineCount, lineCount);
          this.pending.turns = this.#resolveTurns(
            updatedSpeech,
            speaker,
            this.pending.suppressPrefixText ? null : inputTurns,
            this.pending.suppressPrefixText,
            basePreviousRole
          );
          this.pending.role = this.pending.turns[0]?.role || this.pending.role;
          this.candidate = null;
          return this.getSnapshot(now);
        }
      }
      if (sameSpeakerOrUnknown && relPending.type === "partial") {
        this.pending.lastSeenAt = now;
        return this.getSnapshot(now);
      }
    }

    if (!suppressPrefixText && this.history.length) {
      for (let i = 0; i < this.history.length; i++) {
        const entry = this.history[i];
        const sameSpeakerOrUnknown = !speaker || !entry.speaker || speaker === entry.speaker;
        if (!sameSpeakerOrUnknown) continue;

        const relHist = analyzeCaptionRelation(entry.text, rawText);
        if (relHist.type === "same" || relHist.type === "partial") {
          return this.getSnapshot(now);
        }
        if (
          i === 0 &&
          relHist.type === "extension" &&
          now - entry.completedAt <= this.options.extensionAfterDoneWindowMs
        ) {
          suppressPrefixText = entry.text;
          speechText = relHist.delta;
          basePreviousRole = entry.role || basePreviousRole;
          break;
        }
      }
    }

    if (!isSpeakableFragment(speechText)) {
      return this.getSnapshot(now);
    }

    const resolvedTurns = this.#resolveTurns(
      speechText,
      speaker,
      suppressPrefixText ? null : inputTurns,
      suppressPrefixText,
      basePreviousRole
    );
    const primaryRole = resolvedTurns[0]?.role || ROLES.JASON;

    if (!this.candidate) {
      this.candidate = {
        sourceText: rawText,
        speechText,
        suppressPrefixText,
        key,
        speaker,
        role: primaryRole,
        turns: resolvedTurns,
        confidence,
        lineCount,
        firstSeenAt: now,
        lastSeenAt: now,
        hits: 1
      };
    } else {
      const relCand = analyzeCaptionRelation(this.candidate.sourceText, rawText);
      if (relCand.type === "same") {
        this.candidate.hits += 1;
        this.candidate.lastSeenAt = now;
        this.candidate.lineCount = Math.max(this.candidate.lineCount, lineCount);
        if (confidence >= this.candidate.confidence) {
          this.candidate.sourceText = rawText;
          this.candidate.speechText = speechText;
          this.candidate.suppressPrefixText = suppressPrefixText;
          this.candidate.key = key;
          this.candidate.confidence = confidence;
          this.candidate.role = primaryRole;
          this.candidate.turns = resolvedTurns;
          if (speaker) this.candidate.speaker = speaker;
        }
      } else if (relCand.type === "extension") {
        this.candidate.sourceText = rawText;
        this.candidate.speechText = speechText;
        this.candidate.suppressPrefixText = suppressPrefixText;
        this.candidate.key = key;
        this.candidate.lastSeenAt = now;
        this.candidate.hits += 1;
        this.candidate.lineCount = Math.max(this.candidate.lineCount, lineCount);
        this.candidate.confidence = Math.max(this.candidate.confidence, confidence);
        this.candidate.role = primaryRole;
        this.candidate.turns = resolvedTurns;
        if (speaker) this.candidate.speaker = speaker;
      } else if (relCand.type === "partial") {
        this.candidate.lastSeenAt = now;
        this.candidate.hits += 1;
      } else {
        if (this.candidate.hits >= 2) {
          this.stats.dropped += 1;
          if (this.active) this.droppedDuringActive += 1;
        }
        this.candidate = {
          sourceText: rawText,
          speechText,
          suppressPrefixText,
          key,
          speaker,
          role: primaryRole,
          turns: resolvedTurns,
          confidence,
          lineCount,
          firstSeenAt: now,
          lastSeenAt: now,
          hits: 1
        };
      }
    }

    if (this.#isCandidateReady(this.candidate)) {
      this.#promoteCandidate(now);
    }

    return this.getSnapshot(now);
  }

  pullNextUtterance(now = Date.now()) {
    if (this.active || !this.pending) return null;

    const totalAge = now - this.pending.firstSeenAt;
    const unseenAge = now - this.pending.lastSeenAt;
    const isStale =
      (unseenAge > this.options.maxUnseenAgeMs && totalAge > this.options.staleAfterUnseenTotalMs) ||
      totalAge > this.options.maxPendingAgeMs;

    if (isStale) {
      this.stats.stale += 1;
      this.pending = null;
      return null;
    }

    const lagMs = Math.max(0, now - this.pending.firstSeenAt);
    this.active = {
      ...this.pending,
      startedAt: now,
      lagMs
    };
    const lastTurnRole = this.active.turns?.[this.active.turns.length - 1]?.role || this.active.role;
    if (lastTurnRole) this.lastRole = lastTurnRole;
    this.pending = null;
    this.droppedDuringActive = 0;
    this.stats.lastLagMs = lagMs;
    return this.active;
  }

  shouldPreemptActive(now = Date.now()) {
    if (!this.active || !this.pending) return false;
    if (this.pending.suppressPrefixText) return false;

    const activeElapsed = now - this.active.startedAt;
    const pendingFresh = now - this.pending.lastSeenAt <= 550;
    if (!pendingFresh) return false;

    if (activeElapsed >= this.options.preemptAfterActiveMs && this.droppedDuringActive >= 1) {
      return true;
    }
    if (activeElapsed >= this.options.preemptSingleAfterActiveMs && now - this.pending.firstSeenAt >= 200) {
      return true;
    }
    return false;
  }

  onSpeechEnd(now = Date.now()) {
    if (!this.active) return;
    const finished = this.active;
    this.stats.spoken += 1;
    this.stats.lastSpeechMs = Math.max(0, now - finished.startedAt);
    const finalRole = finished.turns?.[finished.turns.length - 1]?.role || finished.role || "";
    if (finalRole) this.lastRole = finalRole;
    this.history.unshift({
      text: finished.sourceText,
      key: finished.key,
      speaker: finished.speaker || "",
      role: finalRole,
      completedAt: now
    });
    if (this.history.length > 4) this.history.length = 4;
    this.active = null;
    this.droppedDuringActive = 0;
  }

  clearQueueAndSpeech() {
    this.candidate = null;
    this.pending = null;
    this.active = null;
    this.droppedDuringActive = 0;
  }

  getSnapshot(now = Date.now()) {
    const state = this.active
      ? "SPEAKING"
      : this.pending
        ? "QUEUED"
        : this.candidate
          ? "STABILIZING"
          : "IDLE";
    return {
      state,
      hasActive: Boolean(this.active),
      hasPending: Boolean(this.pending),
      hasCandidate: Boolean(this.candidate),
      activeRole: this.active?.role || null,
      activeElapsedMs: this.active ? Math.max(0, now - this.active.startedAt) : null,
      pendingAgeMs: this.pending ? Math.max(0, now - this.pending.firstSeenAt) : null,
      lastLagMs: this.stats.lastLagMs,
      lastSpeechMs: this.stats.lastSpeechMs,
      dropped: this.stats.dropped,
      stale: this.stats.stale,
      spoken: this.stats.spoken
    };
  }

  #resolveTurns(speechText, speaker, inputTurns, suppressPrefixText, previousRole) {
    if (Array.isArray(inputTurns) && inputTurns.length > 0 && !suppressPrefixText) {
      let prev = previousRole;
      return inputTurns.map((turn, index) => {
        const role = turn.role || inferSpeakerRole({
          text: turn.text,
          speaker: turn.speaker || speaker,
          previousRole: prev,
          castMode: this.options.castMode,
          forceSwitch: index > 0,
          roleDefinitions: this.options.roleDefinitions
        });
        prev = role;
        return { text: turn.text, speaker: turn.speaker || speaker, role };
      });
    }

    const deltaStartsWithDash = Boolean(suppressPrefixText) && /^[-—–]/.test(cleanText(speechText));
    const role = inferSpeakerRole({
      text: speechText,
      speaker,
      previousRole,
      castMode: this.options.castMode,
      forceSwitch: deltaStartsWithDash,
      roleDefinitions: this.options.roleDefinitions
    });
    return [{ text: speechText, speaker, role }];
  }

  #isCandidateReady(cand) {
    if (!cand) return false;
    if (cand.confidence >= this.options.fastStartConfidence) return true;
    if (cand.hits >= 2 && cand.confidence >= 28) return true;
    return false;
  }

  #promoteCandidate(now) {
    if (!this.candidate) return;
    if (this.pending) {
      this.stats.dropped += 1;
      if (this.active) this.droppedDuringActive += 1;
    }
    this.pending = {
      ...this.candidate,
      queuedAt: now
    };
    this.candidate = null;
  }
}