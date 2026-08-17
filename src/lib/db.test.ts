import { describe, expect, it } from "vitest";
import { gradeFor, makePack, PACKS_SCHEMA, schedule } from "./db";

describe("learning engine", () => {
  it("indexes planDay so a regenerated passage can replace the day's old pack", () => {
    expect(PACKS_SCHEMA.split(/,\s*/)).toContain("planDay");
  });
  it("maps recall evidence to grades", () => {
    expect(gradeFor(false, 0, false, false)).toBe(1);
    expect(gradeFor(true, 1, true, true)).toBe(2);
    expect(gradeFor(true, 0, false, false)).toBe(3);
    expect(gradeFor(true, 0, true, true)).toBe(4);
  });

  it("grows successful intervals and shortens failed intervals", () => {
    const now = "2026-08-06T12:00:00.000Z";
    const start = { difficulty: 5, stability: 0.5, lastReviewedAt: null, nextDueAt: null };
    const failed = schedule(start, 1, now);
    const successful = schedule(start, 4, now);
    expect(successful.stability).toBeGreaterThan(failed.stability);
    expect(new Date(successful.nextDueAt!).getTime()).toBeGreaterThan(new Date(failed.nextDueAt!).getTime());
  });

  it("limits generated packs to eight unique target words", () => {
    const pack = makePack(["adapt", "adapt", "allocate", "decline", "evidence", "maintain", "resilient", "sustainable", "trend", "extra"], "Adapt and maintain a resilient system.");
    expect(pack.targetWords).toHaveLength(8);
    expect(new Set(pack.targetWords.map((word) => word.lemma)).size).toBe(8);
    expect(pack.qualityReport.passed).toBe(true);
  });

  it("enriches packs with AI meta when provided", () => {
    const pack = makePack(
      ["adapt", "unfamiliar"],
      "Adapt to the new system.",
      undefined,
      8,
      {
        translation: "适应新系统。",
        generatedBy: "ai",
        meanings: {
          adapt: { meaningZh: "适应", partOfSpeech: "verb", collocation: "adapt to changes" },
        },
      },
    );
    expect(pack.translation).toBe("适应新系统。");
    expect(pack.generatedBy).toBe("ai");
    expect(pack.targetWords[0]).toMatchObject({
      lemma: "adapt",
      meaningZh: "适应",
      partOfSpeech: "verb",
      collocation: "adapt to changes",
    });
    // 未提供释义的词保持本地回退占位。
    expect(pack.targetWords[1].meaningZh).toBe("当前语境中的核心含义");
  });

  it("keeps the local demo translation when no meta is provided", () => {
    const pack = makePack(["adapt"], "Adapt and maintain.");
    expect(pack.generatedBy).toBe("local");
    expect(pack.translation.length).toBeGreaterThan(10);
  });

  it("never attaches the unrelated demo translation to a different local passage", () => {
    const pack = makePack(["judgement", "tackle"], "A learner used judgement to tackle a problem.");
    expect(pack.translation).toContain("暂未提供与本文对应的中文翻译");
    expect(pack.translation).not.toContain("城市正在学习适应气候压力");
  });

  it("picks a local key sentence containing the most target words", () => {
    const passage =
      "Cities adapt to new climates. Although budgets decline slowly, evidence shows planners maintain resilient systems through sustainable design.";
    const pack = makePack(["adapt", "decline", "evidence", "maintain", "resilient", "sustainable"], passage);
    expect(pack.keySentence?.sentence).toBe(
      "Although budgets decline slowly, evidence shows planners maintain resilient systems through sustainable design.",
    );
    expect(pack.keySentence?.pattern).toBeTruthy();
    expect(pack.keySentence?.writingTopic).toBe("城市治理 / 环境政策");
  });

  it("aligns an AI key sentence to the exact passage sentence", () => {
    const passage = "Cities adapt to new climates. Although budgets decline, evidence remains strong.";
    const pack = makePack(["adapt", "decline", "evidence"], passage, undefined, 8, {
      keySentence: {
        sentence: "Although budgets decline, evidence remains strong!", // 标点略有出入
        pattern: "Although ..., ...",
        explanation: "让步转折",
      },
      planDay: 3,
      generatedBy: "ai",
    });
    expect(pack.keySentence?.sentence).toBe("Although budgets decline, evidence remains strong.");
    expect(pack.keySentence?.pattern).toBe("Although ..., ...");
    expect(pack.planDay).toBe(3);
    expect(pack.generatedBy).toBe("ai");
  });
});
