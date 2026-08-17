import type {
  MasteryLevel,
  MasteryStage,
  ReviewAttempt,
  ReviewPhase,
  ReviewRating,
  ScheduleState,
  WordCard,
} from "./types";

const DAY = 86_400_000;
const BASE_INTERVALS = [0.5, 1, 2, 4, 8] as const;

export function levelFromStage(stage: MasteryStage): MasteryLevel {
  switch (stage) {
    case "new":
      return 0;
    case "encountered":
      return 1;
    case "understood":
      return 2;
    case "recalled":
      return 3;
    case "transferred":
    case "stable":
      return 4;
  }
}

export function getMasteryLevel(card: Pick<WordCard, "stage" | "masteryLevel">): MasteryLevel {
  return card.masteryLevel ?? levelFromStage(card.stage);
}

export function phaseForLevel(level: MasteryLevel): ReviewPhase {
  if (level <= 1) return "recognition";
  if (level === 2) return "semantic";
  if (level === 3) return "generation";
  return "transfer";
}

export function phaseLabel(phase: ReviewPhase): string {
  return {
    recognition: "Lv1 · 识别",
    semantic: "Lv2 · 理解",
    generation: "Lv3 · 调用",
    transfer: "Lv4 · 融入",
  }[phase];
}

function safeDate(value: string | null | undefined, fallback: number) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

export function reviewRisk(
  card: Pick<WordCard, "schedule" | "lapses">,
  attempts: ReviewAttempt[],
  now = Date.now(),
): number {
  const recent = attempts
    .filter((attempt) => attempt.reviewedAt)
    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
    .slice(0, 8);
  const fuzzy = recent.filter((attempt) => attempt.rating === "fuzzy").length;
  const forgot = recent.filter((attempt) => attempt.rating === "forgot" || !attempt.correct).length;
  const reviewedAt = safeDate(card.schedule.lastReviewedAt, now);
  const dueAt = safeDate(card.schedule.nextDueAt, now);
  const overdueDays = Math.max(0, (now - dueAt) / DAY);
  const staleDays = Math.max(0, (now - reviewedAt) / DAY);
  return overdueDays * 3 + staleDays * 0.35 + forgot * 12 + fuzzy * 6 + card.lapses * 2 + Math.max(0, 8 - card.schedule.stability);
}

/** 只从已到期词中取队列，最多30词；高风险词永远排在前面。 */
export function buildAdaptiveQueue(
  cards: WordCard[],
  attempts: ReviewAttempt[],
  now = Date.now(),
  max = 30,
): WordCard[] {
  const due = cards.filter((card) => {
    const dueAt = card.schedule.nextDueAt ? new Date(card.schedule.nextDueAt).getTime() : now;
    return !Number.isFinite(dueAt) || dueAt <= now;
  });
  const grouped = due.map((card, index) => ({
    card,
    index,
    risk: reviewRisk(card, attempts.filter((attempt) => attempt.cardId === card.id), now),
  }));
  return grouped
    .sort((a, b) => b.risk - a.risk || a.index - b.index)
    .slice(0, Math.max(1, Math.min(30, max)))
    .map(({ card }) => card);
}

export function nextLevel(
  level: MasteryLevel,
  rating: ReviewRating,
  phase: ReviewPhase,
  evaluationPassed = true,
): MasteryLevel {
  if (rating !== "known" || (phase === "generation" || phase === "transfer") && !evaluationPassed) return level;
  return Math.min(4, level + 1) as MasteryLevel;
}

export function adaptiveSchedule(
  state: ScheduleState,
  level: MasteryLevel,
  rating: ReviewRating,
  reviewedAt: string,
): ScheduleState {
  const now = new Date(reviewedAt).getTime();
  const stability = Math.max(0.5, state.stability || 0.5);
  if (rating === "forgot") {
    const next = new Date(now + DAY).toISOString();
    return {
      difficulty: Math.min(10, state.difficulty + 0.8),
      stability: Math.max(0.5, Math.round(stability * 0.45 * 100) / 100),
      lastReviewedAt: reviewedAt,
      nextDueAt: next,
    };
  }
  const factor = rating === "fuzzy" ? 0.8 : 1.85 + level * 0.12;
  const interval = Math.max(BASE_INTERVALS[level], stability * factor);
  const bounded = Math.min(180, Math.max(1, Math.round(interval * 100) / 100));
  return {
    difficulty: Math.max(1, Math.min(10, state.difficulty + (rating === "fuzzy" ? 0.15 : -0.2))),
    stability: bounded,
    lastReviewedAt: reviewedAt,
    nextDueAt: new Date(now + bounded * DAY).toISOString(),
  };
}

export function localEvaluateSentence(lemma: string, answer: string): { passed: boolean; score: number; feedback: string; correction?: string } {
  const text = answer.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const target = new RegExp(`\\b${lemma.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:s|es|ed|ing)?\\b`, "i");
  const hasTarget = target.test(text);
  const validLength = words.length >= 5 && words.length <= 35;
  const hasSentenceShape = /[A-Za-z]/.test(text) && /[.!?]?$/.test(text);
  const score = Math.max(0, Math.min(100, (hasTarget ? 55 : 0) + (validLength ? 25 : 8) + (hasSentenceShape ? 20 : 5)));
  return hasTarget && validLength
    ? { passed: true, score, feedback: "本地初筛通过：目标词已自然放入完整句子。请确认你是否能在不看提示时调用它。" }
    : { passed: false, score, feedback: !hasTarget ? `句子中没有检测到目标词“${lemma}”。` : "句子还不够完整，建议补充主语、谓语和具体情境。" };
}
