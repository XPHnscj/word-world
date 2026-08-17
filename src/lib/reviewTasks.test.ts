import { describe, expect, it } from "vitest";
import { hintForLevel, TASK_SPECS } from "./reviewTasks";
import { CAPABILITY_DIMENSIONS } from "./reviewEngine";
import type { WordCard } from "./types";

const card = (lemma: string, meaningZh = "含义"): WordCard => ({
  id: `card_${lemma}`,
  lemma,
  meaningZh,
  partOfSpeech: "noun",
  definitionEn: `an English meaning of ${lemma}`,
  collocations: [`a natural ${lemma} phrase`],
  packIds: [],
  stage: "understood",
  schedule: { difficulty: 5, stability: 2, lastReviewedAt: null, nextDueAt: null },
  correct: 0,
  lapses: 0,
  hints: 0,
  dimensions: { recognition: 0, recall: 0, collocation: 0, reading: 0, transfer: 0 },
  updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("review task library", () => {
  it("provides a spec for every capability dimension with a five-level hint ladder", () => {
    for (const dimension of CAPABILITY_DIMENSIONS) {
      const spec = TASK_SPECS[dimension];
      expect(spec.dimension).toBe(dimension);
      expect(spec.hintLadder.length).toBeGreaterThanOrEqual(4);
      expect(spec.prompt(card("flash")).length).toBeGreaterThan(0);
      expect(hintForLevel(spec, card("flash"), 0)).toBeNull();
      expect(hintForLevel(spec, card("flash"), 5)).not.toBeNull();
    }
  });

  it("judges spelling offline by exact match", () => {
    const spec = TASK_SPECS.spelling;
    expect(spec.judge(card("flash"), "flash").correct).toBe(true);
    expect(spec.judge(card("flash"), "Flash").correct).toBe(true);
    expect(spec.judge(card("flash"), "flush").correct).toBe(false);
  });

  it("judges collocations offline by lemma presence and phrase length", () => {
    const spec = TASK_SPECS.collocation;
    expect(spec.judge(card("allocate"), "allocate funds").correct).toBe(true);
    expect(spec.judge(card("allocate"), "funds").correct).toBe(false);
    expect(spec.judge(card("allocate"), "allocate").correct).toBe(false);
  });

  it("judges grammar use by lemma or its inflected form", () => {
    const spec = TASK_SPECS.grammarUse;
    expect(spec.judge(card("adapt"), "she adapted the plan").correct).toBe(true);
    expect(spec.judge(card("adapt"), "a quick decision").correct).toBe(false);
  });

  it("judges production and transfer with the local sentence filter", () => {
    expect(TASK_SPECS.production.judge(card("flash"), "A flash lit the dark room.").correct).toBe(true);
    expect(TASK_SPECS.production.judge(card("flash"), "A camera.").correct).toBe(false);
    expect(TASK_SPECS.transfer.judge(card("flash"), "In the meeting, a flash of insight changed our plan.").correct).toBe(true);
  });

  it("judges meaning tasks offline by Chinese content", () => {
    const spec = TASK_SPECS.meaningRecall;
    expect(spec.judge(card("evidence", "证据"), "证据").correct).toBe(true);
    expect(spec.judge(card("evidence", "证据"), "天气很好").correct).toBe(false);
    expect(spec.judge(card("evidence", "证据"), "sure").correct).toBe(false);
  });
});
