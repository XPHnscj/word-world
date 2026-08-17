import { describe, expect, it } from "vitest";
import {
  adaptiveSchedule,
  applyDimensionEvidence,
  buildAdaptiveQueue,
  capabilitiesOf,
  CAPABILITY_DIMENSIONS,
  deriveMasteryLevel,
  emptyDimensionState,
  getMasteryLevel,
  initCapabilitiesFromLegacy,
  localEvaluateSentence,
  nextLevel,
  phaseForLevel,
  replayCapabilitiesFromEvidence,
  routeNextTask,
  weakestDimension,
} from "./reviewEngine";
import type { DimensionState, ReviewAttempt, WordCard } from "./types";

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

describe("multi-dimensional capability model", () => {
  it("derives eight capability states from a legacy card without regenerating it", () => {
    const legacy = card("legacy", "2026-08-01T00:00:00.000Z", "recalled");
    legacy.masteryLevel = 3;
    legacy.dimensions = { recognition: 80, recall: 60, collocation: 40, reading: 70, transfer: 30 };
    legacy.schedule.stability = 4;
    const caps = initCapabilitiesFromLegacy(legacy);
    expect(CAPABILITY_DIMENSIONS).toHaveLength(8);
    expect(caps.spelling.strength).toBeCloseTo(0.7, 5);
    expect(caps.transfer.strength).toBeCloseTo(0.3, 5);
    expect(caps.meaningRecall.strength).toBeCloseTo(0.6, 5);
    expect(caps.formRecognition.evidenceCount).toBeGreaterThanOrEqual(1);
    // 旧卡不写回 capabilities，读取路径仍然可用
    expect(capabilitiesOf(legacy)).toEqual(caps);
  });

  it("keeps an existing capabilities record untouched", () => {
    const caps: Record<typeof CAPABILITY_DIMENSIONS[number], DimensionState> = Object.fromEntries(
      CAPABILITY_DIMENSIONS.map((d) => [d, { ...emptyDimensionState(), strength: 0.9 }]),
    ) as Record<typeof CAPABILITY_DIMENSIONS[number], DimensionState>;
    const modern = { ...card("modern", "2026-08-01T00:00:00.000Z"), capabilities: caps };
    expect(capabilitiesOf(modern)).toBe(caps);
  });

  it("rewards hint-free success more than hinted success", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const start = emptyDimensionState();
    const free = applyDimensionEvidence(start, { correct: true, hintLevel: 0, confidence: 4, elapsedMs: 900 }, now);
    const hinted = applyDimensionEvidence(start, { correct: true, hintLevel: 2, confidence: 4, elapsedMs: 900 }, now);
    expect(free.strength).toBeGreaterThan(hinted.strength);
    expect(free.nextDueAt! > hinted.nextDueAt!).toBe(true); // 无提示间隔更长
    expect(free.lastHintFreeSuccessAt).toBeTruthy();
    expect(hinted.lastHintFreeSuccessAt).toBeNull(); // 提示后答对不算独立掌握
  });

  it("lowers strength and shortens the interval on error", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const start = { ...emptyDimensionState(), strength: 0.6, stability: 6 };
    const failed = applyDimensionEvidence(start, { correct: false, hintLevel: 0, confidence: 2, elapsedMs: 2000 }, now);
    expect(failed.strength).toBeLessThan(start.strength);
    expect(failed.difficulty).toBeGreaterThan(start.difficulty);
    expect(failed.nextDueAt).toBe("2026-08-11T00:00:00.000Z");
    expect(failed.evidenceCount).toBe(1);
  });

  it("punishes overconfident mistakes as a calibration risk", () => {
    const start = { ...emptyDimensionState(), strength: 0.6 };
    const calm = applyDimensionEvidence(start, { correct: false, hintLevel: 0, confidence: 2, elapsedMs: 1000 });
    const overconfident = applyDimensionEvidence(start, { correct: false, hintLevel: 0, confidence: 5, elapsedMs: 1000 });
    expect(overconfident.strength).toBeLessThan(calm.strength);
    expect(overconfident.difficulty).toBeGreaterThan(calm.difficulty);
  });

  it("picks the weakest due dimension for routing", () => {
    const caps = initCapabilitiesFromLegacy(card("w", "2026-08-01T00:00:00.000Z", "understood"));
    caps.spelling.strength = 0.15; // 会认但不会拼
    expect(weakestDimension(caps, Date.parse("2026-08-10T00:00:00.000Z"))).toBe("spelling");
  });

  it("derives a legacy-compatible mastery level from capabilities", () => {
    const base = emptyDimensionState();
    const weak = Object.fromEntries(CAPABILITY_DIMENSIONS.map((d) => [d, { ...base }])) as Record<typeof CAPABILITY_DIMENSIONS[number], DimensionState>;
    expect(deriveMasteryLevel(weak)).toBe(0);
    weak.formRecognition.strength = 0.6;
    expect(deriveMasteryLevel(weak)).toBe(1);
    weak.meaningRecall.strength = 0.7;
    expect(deriveMasteryLevel(weak)).toBe(2);
    weak.production.strength = 0.8;
    expect(deriveMasteryLevel(weak)).toBe(3);
    weak.transfer.strength = 0.9;
    expect(deriveMasteryLevel(weak)).toBe(4);
  });
});

describe("replayCapabilitiesFromEvidence", () => {
  const evt = (overrides: Partial<import("./types").LearningEvidence> = {}): import("./types").LearningEvidence => ({
    id: "e1",
    cardId: "card_flash",
    dimension: "spelling",
    taskType: "spell",
    correct: true,
    score: 100,
    confidence: 4,
    hintLevel: 0,
    elapsedMs: 900,
    evaluator: "local",
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  });

  it("builds an initial capability state from objective spelling evidence", () => {
    const caps = replayCapabilitiesFromEvidence([
      evt({ id: "ok", correct: true, hintLevel: 0 }),
      evt({ id: "bad", correct: false, hintLevel: 2, confidence: 1, createdAt: "2026-08-11T00:00:00.000Z" }),
    ]);
    expect(caps.spelling.evidenceCount).toBe(2);
    // 无提示答对先提升，随后答错拉低；无提示成功时间仍被记录。
    expect(caps.spelling.strength).toBeLessThan(0.5);
    expect(caps.spelling.strength).toBeGreaterThan(0.15);
    expect(caps.spelling.lastHintFreeSuccessAt).toBeTruthy();
  });

  it("ignores exposure and subjective skip evidence in capability calculation", () => {
    const caps = replayCapabilitiesFromEvidence([
      evt({ id: "read", taskType: "read", correct: true }),
      evt({ id: "skip", taskType: "skip-known", correct: true }),
    ]);
    expect(caps.spelling.evidenceCount).toBe(0);
    expect(caps.spelling.strength).toBe(0.25); // 仍为基线，不因“看过/主观跳过”上升
  });
});

describe("routeNextTask", () => {
  const baseCard = () => {
    const c = card("flash", "2026-08-01T00:00:00.000Z", "understood");
    c.capabilities = Object.fromEntries(
      CAPABILITY_DIMENSIONS.map((d) => [d, emptyDimensionState()]),
    ) as Record<typeof CAPABILITY_DIMENSIONS[number], DimensionState>;
    return c;
  };

  it("is deterministic for the same input", () => {
    const c = baseCard();
    c.capabilities!.meaningRecall.strength = 0.7;
    expect(routeNextTask(c, [])).toEqual(routeNextTask(c, []));
  });

  it("routes recognisable-but-unspellable words to spelling retrieval", () => {
    const c = baseCard();
    c.capabilities!.formRecognition.strength = 0.7;
    c.capabilities!.meaningRecall.strength = 0.7;
    c.capabilities!.spelling.strength = 0.3;
    const route = routeNextTask(c, []);
    expect(route.dimension).toBe("spelling");
    expect(route.task).toBe("cloze");
    expect(route.reason).toContain("拼写");
  });

  it("never routes to transfer or production when the base meaning is unstable", () => {
    const c = baseCard();
    c.capabilities!.meaningRecall.strength = 0.3;
    c.capabilities!.transfer.strength = 0.1; // 迁移最弱也不该进迁移
    const route = routeNextTask(c, []);
    expect(route.dimension).toBe("meaningRecall");
    expect(route.task).not.toBe("transfer");
    expect(route.task).not.toBe("sentence");
  });

  it("routes to collocation when meaning is stable but collocation is weak", () => {
    const c = baseCard();
    c.capabilities!.formRecognition.strength = 0.7;
    c.capabilities!.meaningRecall.strength = 0.8;
    c.capabilities!.spelling.strength = 0.7;
    c.capabilities!.collocation.strength = 0.3;
    expect(routeNextTask(c, []).dimension).toBe("collocation");
  });

  it("routes to controlled sentence production before transfer", () => {
    const c = baseCard();
    for (const dim of CAPABILITY_DIMENSIONS) c.capabilities![dim].strength = 0.75;
    c.capabilities!.production.strength = 0.4;
    expect(routeNextTask(c, []).task).toBe("sentence");
  });

  it("signals low hint and a short interval after repeated confident misses", () => {
    const c = baseCard();
    c.capabilities!.meaningRecall.strength = 0.9;
    const attempts: ReviewAttempt[] = [
      { id: "a1", cardId: c.id, task: "meaning", correct: false, hintLevel: 0, confidence: 5, elapsedMs: 1, reviewedAt: "2026-08-09T00:00:00.000Z", rating: "forgot" },
      { id: "a2", cardId: c.id, task: "meaning", correct: false, hintLevel: 0, confidence: 4, elapsedMs: 1, reviewedAt: "2026-08-10T00:00:00.000Z", rating: "forgot" },
    ];
    const route = routeNextTask(c, attempts);
    expect(route.lowHint).toBe(true);
    expect(route.shortInterval).toBe(true);
    expect(route.task).toBe("meaning");
  });
});
