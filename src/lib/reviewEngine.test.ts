import { describe, expect, it } from "vitest";
import { adaptiveSchedule, buildAdaptiveQueue, getMasteryLevel, localEvaluateSentence, nextLevel, phaseForLevel } from "./reviewEngine";
import type { ReviewAttempt, WordCard } from "./types";

const card = (id: string, nextDueAt: string, stage: WordCard["stage"] = "understood"): WordCard => ({
  id, lemma: id, meaningZh: "含义", partOfSpeech: "noun", collocations: [], packIds: [], stage,
  schedule: { difficulty: 5, stability: 2, lastReviewedAt: "2026-08-01T00:00:00.000Z", nextDueAt },
  correct: 0, lapses: 0, hints: 0, dimensions: { recognition: 0, recall: 0, collocation: 0, reading: 0, transfer: 0 }, updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("adaptive review engine", () => {
  it("maps legacy stages to the five-level ladder", () => {
    expect(getMasteryLevel({ stage: "transferred" })).toBe(4);
    expect(phaseForLevel(2)).toBe("semantic");
  });
  it("prioritizes overdue forgotten words and caps the queue", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const forgotten = card("flash", "2026-08-01T00:00:00.000Z");
    const fresh = card("adapt", "2026-08-09T00:00:00.000Z");
    const attempts: ReviewAttempt[] = [{ id: "a", cardId: "flash", task: "meaning", correct: false, hintLevel: 0, confidence: 1, elapsedMs: 1, reviewedAt: "2026-08-09T00:00:00.000Z", rating: "forgot" }];
    expect(buildAdaptiveQueue([fresh, forgotten], attempts, now, 30).map((item) => item.id)).toEqual(["flash", "adapt"]);
  });
  it("keeps the level until a generation evaluation passes", () => {
    expect(nextLevel(3, "known", "generation", false)).toBe(3);
    expect(nextLevel(3, "known", "generation", true)).toBe(4);
  });
  it("requeues forgotten words for tomorrow", () => {
    const next = adaptiveSchedule(card("flash", "2026-08-01T00:00:00.000Z").schedule, 2, "forgot", "2026-08-10T00:00:00.000Z");
    expect(next.nextDueAt).toBe("2026-08-11T00:00:00.000Z");
  });
  it("locally checks target use in a sentence", () => {
    expect(localEvaluateSentence("flash", "A flash appeared when I took a photo.").passed).toBe(true);
    expect(localEvaluateSentence("flash", "A camera appeared.").passed).toBe(false);
  });
});
