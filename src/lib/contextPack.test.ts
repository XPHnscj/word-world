import { describe, expect, it } from "vitest";
import { countEnglishWords, findDuplicateTarget, findMissingTargets, hasCompleteTranslationAnnotations, normalizeTranslationChunk, parseContextPack } from "./contextPack";

const WORDS = ["adapt", "allocate", "resilient"];

describe("parseContextPack", () => {
  it("parses a clean JSON reply into passage, translation and meanings", () => {
    const reply = JSON.stringify({
      passage: "Cities adapt to change.",
      translation: "城市适应变化。",
      words: [
        { lemma: "Adapt", phonetic: "/əˈdæpt/", meaningZh: "适应", morphology: "ad-（向）+ apt（适合）", partOfSpeech: "verb", collocation: "adapt to change", phraseFrame: "adapt to + noun", rhetoricalFunction: "动作推进", register: "formal", confusables: ["adopt"] },
        { lemma: "resilient", meaningZh: "有韧性的", partOfSpeech: "adj", collocation: "resilient system" },
      ],
    });
    const parsed = parseContextPack(reply, WORDS);
    expect(parsed.passage).toBe("Cities adapt to change.");
    expect(parsed.translation).toBe("城市适应变化。");
    expect(parsed.meanings).toHaveLength(2);
    expect(parsed.meanings?.[0]).toMatchObject({ lemma: "adapt", phonetic: "/əˈdæpt/", meaningZh: "适应", morphology: "ad-（向）+ apt（适合）", partOfSpeech: "verb" });
    expect(parsed.meanings?.[0]).toMatchObject({ phraseFrame: "adapt to + noun", rhetoricalFunction: "动作推进", register: "formal", confusables: ["adopt"] });
  });

  it("extracts the key sentence with its pattern and explanation", () => {
    const reply = JSON.stringify({
      passage: "The more cities expand, the more they must adapt.",
      translation: "城市扩张越厉害，就越必须适应。",
      words: [],
      keySentence: {
        sentence: "The more cities expand, the more they must adapt.",
        pattern: "The more ..., the more ...",
        explanation: "表示两种变化同步加剧。",
        writingTopic: "城市化 / 环境",
      },
    });
    const parsed = parseContextPack(reply, WORDS);
    expect(parsed.keySentence).toEqual({
      sentence: "The more cities expand, the more they must adapt.",
      pattern: "The more ..., the more ...",
      explanation: "表示两种变化同步加剧。",
      writingTopic: "城市化 / 环境",
    });
  });

  it("keeps exact Chinese translation spans and truthful passage metadata", () => {
    const reply = JSON.stringify({
      passage: "In a kitchen, a handy whisk rested beside the bowl.",
      translation: "厨房里，一个顺手的搅拌器放在碗边。",
      passageMeta: { contentType: "场景故事", sceneTopic: "厨房备餐" },
      words: [
        { lemma: "adapt", meaningZh: "适应", translationZh: "译文中不存在", partOfSpeech: "verb", collocation: "adapt to" },
        { lemma: "resilient", meaningZh: "有韧性的", translationZh: "顺手的", partOfSpeech: "adj", collocation: "a handy whisk" },
      ],
    });
    const parsed = parseContextPack(reply, WORDS);
    expect(parsed.passageMeta).toEqual({ contentType: "场景故事", sceneTopic: "厨房备餐" });
    expect(parsed.meanings?.[0].translationZh).toBeUndefined();
    expect(parsed.meanings?.[1].translationZh).toBe("顺手的");
  });

  it("drops a key sentence without a sentence text", () => {
    const reply = JSON.stringify({
      passage: "Adapt quickly.",
      translation: "快速适应。",
      words: [],
      keySentence: { pattern: "no sentence", explanation: "缺句" },
    });
    expect(parseContextPack(reply, WORDS).keySentence).toBeUndefined();
  });

  it("strips markdown fences and stray prose around the JSON", () => {
    const reply = "Sure! Here is the pack:\n```json\n{\"passage\":\"A resilient city allocates funds.\",\"translation\":\"有韧性的城市分配资金。\",\"words\":[]}\n```\nHope that helps.";
    const parsed = parseContextPack(reply, WORDS);
    expect(parsed.passage).toBe("A resilient city allocates funds.");
    expect(parsed.translation).toBe("有韧性的城市分配资金。");
  });

  it("drops meanings for words not in the requested list", () => {
    const reply = JSON.stringify({
      passage: "Adapt quickly.",
      translation: "快速适应。",
      words: [
        { lemma: "adapt", meaningZh: "适应", partOfSpeech: "verb", collocation: "adapt to" },
        { lemma: "unrelated", meaningZh: "无关词", partOfSpeech: "noun", collocation: "not requested" },
      ],
    });
    const parsed = parseContextPack(reply, WORDS);
    expect(parsed.meanings).toHaveLength(1);
    expect(parsed.meanings?.[0].lemma).toBe("adapt");
  });

  it("falls back to a plain passage when the reply is not JSON", () => {
    const reply = "Adapt to the new climate policy and allocate resources wisely.";
    const parsed = parseContextPack(reply, WORDS);
    expect(parsed.passage).toBe(reply);
    expect(parsed.translation).toBeUndefined();
    expect(parsed.meanings).toBeUndefined();
  });

  it("returns an empty result for an unusable reply", () => {
    expect(parseContextPack("", WORDS)).toEqual({});
    expect(parseContextPack("```\n\n```", WORDS)).toEqual({});
  });
});

describe("findDuplicateTarget", () => {
  it("detects a target word used twice in the passage", () => {
    expect(
      findDuplicateTarget("Cats adapt to change and adapt again.", ["adapt"]),
    ).toBe("adapt");
  });

  it("returns null when every word appears once", () => {
    expect(
      findDuplicateTarget("Cats adapt to change and maintain balance.", [
        "adapt",
        "maintain",
      ]),
    ).toBeNull();
  });

  it("does not false-positive on inflected or longer words", () => {
    expect(
      findDuplicateTarget("Adaptation matters for learners who adapt.", [
        "adapt",
      ]),
    ).toBeNull();
  });
});

describe("findMissingTargets", () => {
  it("requires every requested lemma to appear as its own fillable word", () => {
    expect(findMissingTargets("They allocate funds and remained resilient.", ["allocate", "resilient", "trend"]))
      .toEqual(["trend"]);
  });

  it("does not accept a derived form as the requested fillable lemma", () => {
    expect(findMissingTargets("Adaptation takes time.", ["adapt"]))
      .toEqual(["adapt"]);
  });
});

describe("hasCompleteTranslationAnnotations", () => {
  it("accepts only a translation containing an exact span for every target word", () => {
    expect(hasCompleteTranslationAnnotations("城市适应变化并分配资金。", [
      { lemma: "adapt", meaningZh: "适应", translationZh: "适应", partOfSpeech: "verb", collocation: "adapt to" },
      { lemma: "allocate", meaningZh: "分配", translationZh: "分配", partOfSpeech: "verb", collocation: "allocate funds" },
    ], ["adapt", "allocate"])).toBe(true);
  });

  it("rejects an unrelated fallback translation or a missing word span", () => {
    expect(hasCompleteTranslationAnnotations("城市适应变化。", [
      { lemma: "adapt", meaningZh: "适应", translationZh: "适应", partOfSpeech: "verb", collocation: "adapt to" },
    ], ["adapt", "allocate"])).toBe(false);
    expect(hasCompleteTranslationAnnotations(undefined, [], ["adapt"])).toBe(false);
  });

  it("tolerates wrapping quotes, brackets and trailing punctuation in the span", () => {
    expect(hasCompleteTranslationAnnotations("城市适应变化并分配资金。", [
      { lemma: "adapt", meaningZh: "适应", translationZh: "「适应」", partOfSpeech: "verb", collocation: "adapt to" },
      { lemma: "allocate", meaningZh: "分配", translationZh: "（分配）", partOfSpeech: "verb", collocation: "allocate funds" },
    ], ["adapt", "allocate"])).toBe(true);
  });
});

describe("normalizeTranslationChunk", () => {
  it("collapses whitespace and strips wrapping punctuation", () => {
    expect(normalizeTranslationChunk("（适应）")).toBe("适应");
    expect(normalizeTranslationChunk(" 适应 。 ")).toBe("适应");
    expect(normalizeTranslationChunk("「分配资金」")).toBe("分配资金");
  });
});

describe("countEnglishWords", () => {
  it("counts contractions and hyphenated forms as single words", () => {
    expect(countEnglishWords("A rain-soaked street isn't silent." )).toBe(5);
  });
});
