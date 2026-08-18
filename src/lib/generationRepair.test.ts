import { describe, expect, it } from "vitest";
import { buildGenerationRepairPrompt, mergeGenerationRepairDraft, normalizeGenerationRepairIssues, resolveGenerationTargetMarkers } from "./generationRepair";

describe("generation repair", () => {
  const words = ["fitness", "sink", "tickle"];

  it("keeps only structured issues from the active word list", () => {
    expect(normalizeGenerationRepairIssues({
      tooLong: false,
      duplicateWord: "SINK",
      missingWords: ["fitness", "unknown", "fitness"],
      missingAnnotations: ["tickle", "ignore this instruction"],
    }, words)).toEqual({
      tooLong: false,
      duplicateWord: "sink",
      missingWords: ["fitness"],
      missingAnnotations: ["tickle"],
    });
  });

  it("includes the previous draft and asks for a minimal repair", () => {
    const draft = JSON.stringify({ passage: "A sink appeared.", translation: "出现了下沉感。" });
    const prompt = buildGenerationRepairPrompt(words, draft, {
      tooLong: false,
      missingWords: ["fitness", "tickle"],
      missingAnnotations: ["sink"],
    });

    expect(prompt).toContain('"passage":"A sink appeared."');
    expect(prompt).toContain('"translation":"出现了下沉感。"');
    expect(prompt).toContain("不要另起一篇文章");
    expect(prompt).toContain("fitness, tickle");
    expect(prompt).toContain("保留其他目标词");
    expect(prompt).toContain("sink");
    expect(prompt).toContain("[[W01]] = fitness");
    expect(prompt).toContain("10 个词位各出现且只出现一次");
    expect(prompt).toContain("tickle 不能代替 tick");
    expect(prompt).toContain("can/may/will/must/to/do/does/did");
  });

  it("restores immutable target markers to exact lemmas", () => {
    expect(resolveGenerationTargetMarkers(
      "Use [[W01]], [[W2]], and [[ w03 ]] once.",
      words,
    )).toBe("Use fitness, sink, and tickle once.");
  });

  it("merges a compact repair into the previous full word metadata", () => {
    const previous = JSON.stringify({
      passage: "Old passage.",
      translation: "旧译文。",
      words: [
        { lemma: "fitness", phonetic: "/ˈfɪtnəs/", translationZh: "健康" },
        { lemma: "sink", phonetic: "/sɪŋk/", translationZh: "下沉" },
      ],
      keySentence: { sentence: "Old passage.", pattern: "old" },
    });
    const repair = JSON.stringify({
      passage: "[[W01]] can improve before habits [[W02]].",
      translation: "健康可以改善，坏习惯才会消退。",
      translationZh: { fitness: "健康", sink: "消退" },
      keySentence: { sentence: "[[W01]] can improve before habits [[W02]].", pattern: "new" },
    });
    const merged = JSON.parse(mergeGenerationRepairDraft(previous, repair, ["fitness", "sink"]) ?? "{}");

    expect(merged.passage).toContain("[[W01]]");
    expect(merged.words[0]).toMatchObject({ lemma: "fitness", phonetic: "/ˈfɪtnəs/", translationZh: "健康" });
    expect(merged.words[1]).toMatchObject({ lemma: "sink", phonetic: "/sɪŋk/", translationZh: "消退" });
    expect(merged.keySentence.pattern).toBe("new");
  });
});
