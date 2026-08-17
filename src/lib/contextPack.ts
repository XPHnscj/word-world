export interface WordMeta {
  lemma: string;
  meaningZh: string;
  translationZh?: string;
  phonetic?: string;
  morphology?: string;
  partOfSpeech: string;
  collocation: string;
  /** 可直接迁移的词块框架，例如 allocate resources to ...。 */
  phraseFrame?: string;
  /** 该词在正文中的修辞功能（让步、因果、举例等），不是泛化主题。 */
  rhetoricalFunction?: string;
  /** 正式、学术、口语等语域提示。 */
  register?: string;
  /** 适合在复习时对比的易混词。 */
  confusables?: string[];
}

export interface KeySentenceMeta {
  sentence: string;
  pattern: string;
  explanation: string;
  writingTopic?: string;
}

export function countEnglishWords(text: string): number {
  return text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g)?.length ?? 0;
}

/**
 * 找出在短文中出现超过一次的目标词（按词边界、不区分大小写）。
 * 原则：同一篇短文里每个目标词只能出现一次。无重复时返回 null。
 */
export function findDuplicateTarget(
  passage: string,
  words: string[],
): string | null {
  const lower = passage.toLowerCase();
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lower.match(new RegExp(`\\b${escaped}\\b`, "g"));
    if (matches && matches.length > 1) return word;
  }
  return null;
}

/** 返回正文中未按完整词边界出现的目标词；填词位置与目标计数必须一一对应。 */
export function findMissingTargets(passage: string, words: string[]): string[] {
  const lower = passage.toLowerCase();
  return words.filter((word) => {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`\\b${escaped}\\b`, "i").test(lower);
  });
}

/**
 * 归一化中文片段用于逐字定位：折叠全部空白，去掉首尾成对的引号/括号和句末标点。
 * 只容忍格式差异（多余空格、括注、引号），不改变字符的连续顺序，避免虚假划线。
 */
export function normalizeTranslationChunk(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/^[「『"“'‘（(\[{【]+/, "")
    .replace(/[」』"”'’)\]］}）】。，、；：！？]+$/, "");
}

/**
 * 中文全文与逐词标注必须成套存在：每个目标词都要有 translationZh，且该文本
 * 必须能在同一篇中文翻译中逐字定位。禁止用无关演示译文或词典义冒充对应标注。
 */
export function hasCompleteTranslationAnnotations(
  translation: string | undefined,
  meanings: WordMeta[] | undefined,
  words: string[],
): boolean {
  return findMissingTranslationAnnotations(translation, meanings, words).length === 0;
}

/** 返回缺少或无法在全文翻译中逐字定位 translationZh 的目标词（供重试时定向修复）。 */
export function findMissingTranslationAnnotations(
  translation: string | undefined,
  meanings: WordMeta[] | undefined,
  words: string[],
): string[] {
  if (!translation?.trim() || !meanings?.length) return [...words];
  const normalizedTranslation = normalizeTranslationChunk(translation);
  const byLemma = new Map(meanings.map((item) => [item.lemma.toLowerCase(), item]));
  return words.filter((word) => {
    const entry = byLemma.get(word.toLowerCase());
    return !(
      entry?.translationZh &&
      normalizedTranslation.includes(normalizeTranslationChunk(entry.translationZh))
    );
  });
}

export interface ParsedContextPack {
  passage?: string;
  translation?: string;
  meanings?: WordMeta[];
  keySentence?: KeySentenceMeta;
  passageMeta?: { contentType: string; sceneTopic: string };
}

/**
 * Parse the model's reply into a structured pack. The model is instructed to
 * return JSON, but tolerant parsing covers fence-wrapped JSON, stray prose,
 * and a plain-passage reply (older/weaker models) that still becomes a usable
 * passage with local fallback meanings.
 */
export function parseContextPack(
  text: string,
  expectedWords: string[],
): ParsedContextPack {
  const expected = new Set(expectedWords.map((word) => word.toLowerCase()));
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const asPlainPassage = (raw: string): ParsedContextPack => {
    const passage = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    return passage ? { passage } : {};
  };

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return asPlainPassage(cleaned);

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      passage?: unknown;
      translation?: unknown;
      words?: unknown;
      keySentence?: unknown;
      passageMeta?: unknown;
    };
    const passage = typeof parsed.passage === "string" ? parsed.passage.trim() : "";
    if (!passage) return asPlainPassage(cleaned);
    const translation =
      typeof parsed.translation === "string" && parsed.translation.trim()
        ? parsed.translation.trim()
        : undefined;
    const meanings: WordMeta[] = Array.isArray(parsed.words)
      ? parsed.words
          .map((word) => {
            const entry = (word ?? {}) as Record<string, unknown>;
            return {
              lemma:
                typeof entry.lemma === "string" ? entry.lemma.trim().toLowerCase() : "",
              meaningZh:
                typeof entry.meaningZh === "string" ? entry.meaningZh.trim() : "",
              translationZh: (() => {
                if (typeof entry.translationZh !== "string") return undefined;
                const cleaned = normalizeTranslationChunk(entry.translationZh);
                if (!cleaned || !translation) return undefined;
                return normalizeTranslationChunk(translation).includes(cleaned)
                  ? cleaned
                  : undefined;
              })(),
              phonetic:
                typeof entry.phonetic === "string" ? entry.phonetic.trim() : undefined,
              morphology:
                typeof entry.morphology === "string" ? entry.morphology.trim() : undefined,
              partOfSpeech:
                typeof entry.partOfSpeech === "string" ? entry.partOfSpeech.trim() : "",
              collocation:
                typeof entry.collocation === "string" ? entry.collocation.trim() : "",
              phraseFrame:
                typeof entry.phraseFrame === "string" ? entry.phraseFrame.trim() : undefined,
              rhetoricalFunction:
                typeof entry.rhetoricalFunction === "string" ? entry.rhetoricalFunction.trim() : undefined,
              register:
                typeof entry.register === "string" ? entry.register.trim() : undefined,
              confusables: Array.isArray(entry.confusables)
                ? entry.confusables.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 4)
                : undefined,
            };
          })
          .filter((word) => expected.has(word.lemma) && word.meaningZh)
      : [];
    const rawKey = parsed.keySentence;
    const keySentence: KeySentenceMeta | undefined =
      rawKey && typeof rawKey === "object"
        ? {
            sentence:
              typeof (rawKey as Record<string, unknown>).sentence === "string"
                ? ((rawKey as Record<string, unknown>).sentence as string).trim()
                : "",
            pattern:
              typeof (rawKey as Record<string, unknown>).pattern === "string"
                ? ((rawKey as Record<string, unknown>).pattern as string).trim()
                : "",
            explanation:
              typeof (rawKey as Record<string, unknown>).explanation === "string"
                ? ((rawKey as Record<string, unknown>).explanation as string).trim()
                : "",
            writingTopic:
              typeof (rawKey as Record<string, unknown>).writingTopic === "string"
                ? ((rawKey as Record<string, unknown>).writingTopic as string).trim()
                : undefined,
          }
        : undefined;
    const rawMeta = parsed.passageMeta;
    const passageMeta = rawMeta && typeof rawMeta === "object"
      ? {
          contentType: typeof (rawMeta as Record<string, unknown>).contentType === "string" ? ((rawMeta as Record<string, unknown>).contentType as string).trim() : "",
          sceneTopic: typeof (rawMeta as Record<string, unknown>).sceneTopic === "string" ? ((rawMeta as Record<string, unknown>).sceneTopic as string).trim() : "",
        }
      : undefined;
    return {
      passage,
      translation,
      meanings: meanings.length ? meanings : undefined,
      keySentence: keySentence?.sentence ? keySentence : undefined,
      passageMeta: passageMeta?.contentType && passageMeta.sceneTopic ? passageMeta : undefined,
    };
  } catch {
    return asPlainPassage(cleaned);
  }
}
