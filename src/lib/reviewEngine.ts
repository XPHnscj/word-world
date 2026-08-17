import type {
  CapabilityDimension,
  DimensionState,
  LearningEvidence,
  MasteryLevel,
  MasteryStage,
  ReviewAttempt,
  ReviewPhase,
  ReviewRating,
  ReviewTask,
  ScheduleState,
  WordCard,
} from "./types";

const DAY = 86_400_000;
const BASE_INTERVALS = [0.5, 1, 2, 4, 8] as const;

/** 八项能力维度的固定顺序（学习效果页展示与路由都按此顺序）。 */
export const CAPABILITY_DIMENSIONS: readonly CapabilityDimension[] = [
  "formRecognition",
  "meaningRecall",
  "spelling",
  "collocation",
  "grammarUse",
  "production",
  "transfer",
  "fluency",
];

/** 维度展示名（人类可读）。 */
export const DIMENSION_LABELS: Record<CapabilityDimension, string> = {
  formRecognition: "词形识别",
  meaningRecall: "词义回忆",
  spelling: "拼写",
  collocation: "搭配",
  grammarUse: "语法使用",
  production: "主动造句",
  transfer: "跨语境迁移",
  fluency: "流利度",
};

export function emptyDimensionState(): DimensionState {
  return {
    strength: 0.25,
    stability: 0.5,
    difficulty: 5,
    nextDueAt: null,
    evidenceCount: 0,
    lastSuccessAt: null,
    lastHintFreeSuccessAt: null,
  };
}

/**
 * 从旧字段推导初始能力状态（兼容层：旧词卡无需重新生成即可读取）。
 * 旧数据只做等价的初始估计，不删除原始记录。
 */
export function initCapabilitiesFromLegacy(card: {
  stage?: MasteryStage;
  masteryLevel?: MasteryLevel;
  dimensions?: WordCard["dimensions"];
  correct?: number;
  schedule?: ScheduleState;
}): Record<CapabilityDimension, DimensionState> {
  const level = card.masteryLevel ?? levelFromStage(card.stage ?? "new");
  const base = Math.min(0.95, 0.25 + level * 0.17);
  const old = card.dimensions ?? { recognition: 0, recall: 0, collocation: 0, reading: 0, transfer: 0 };
  const legacyPct: Record<CapabilityDimension, number> = {
    formRecognition: old.recognition,
    meaningRecall: old.recall,
    spelling: old.reading,
    collocation: old.collocation,
    grammarUse: (old.recognition + old.recall) / 2,
    production: old.recall,
    transfer: old.transfer,
    fluency: Math.max(old.recognition, old.recall),
  };
  const stability = Math.max(0.5, card.schedule?.stability ?? 0.5);
  const difficulty = card.schedule?.difficulty ?? 5;
  const lastReviewedAt = card.schedule?.lastReviewedAt ?? null;
  const out = {} as Record<CapabilityDimension, DimensionState>;
  for (const dimension of CAPABILITY_DIMENSIONS) {
    const pct = Math.max(0, Math.min(100, legacyPct[dimension]));
    const hasEvidence = pct > 0;
    out[dimension] = {
      strength: hasEvidence ? pct / 100 : base,
      stability,
      difficulty,
      nextDueAt: card.schedule?.nextDueAt ?? null,
      evidenceCount: hasEvidence ? Math.max(1, card.correct ?? 1) : 0,
      lastSuccessAt: hasEvidence ? lastReviewedAt : null,
      lastHintFreeSuccessAt: pct >= 60 ? lastReviewedAt : null,
    };
  }
  return out;
}

/** 读取词卡的多维能力状态；旧卡自动推导。 */
export function capabilitiesOf(
  card: Pick<WordCard, "capabilities" | "masteryLevel" | "stage" | "dimensions" | "correct" | "schedule">,
): Record<CapabilityDimension, DimensionState> {
  return card.capabilities ?? initCapabilitiesFromLegacy(card);
}

/** 任务路由结果：下一步练什么、练哪个维度、为什么。 */
export interface TaskRoute {
  dimension: CapabilityDimension;
  task: ReviewTask;
  /** 一行可解释的练习原因（复习页展示）。 */
  reason: string;
  /** 信心校准风险：需要降低提示层级。 */
  lowHint: boolean;
  /** 信心校准风险：需要缩短复习间隔。 */
  shortInterval: boolean;
}

/**
 * 可解释任务路由器：根据多维能力、到期状态、提示依赖与信心偏差，
 * 决定下一任务并返回用户可理解的原因。纯函数、确定性，相同输入必得相同结果。
 *
 * 路由规则（计划 §9.2）：
 * - 基础词义/词形未稳定 → 只做词义巩固，绝不进入迁移/造句；
 * - 会认但不会拼 → 拼写提取；
 * - 词义模糊 → 主动回忆词义；
 * - 词义稳定但搭配弱 → 搭配练习；
 * - 语法形式弱 → 词形/纠错；
 * - 搭配稳定但不会调用 → 控制造句；
 * - 基础稳定 → 新语境迁移；
 * - 各维度稳定但慢 → 限时流利度；
 * - 近几次自信但答错 → 低提示 + 短间隔。
 */
export function routeNextTask(
  card: Pick<WordCard, "capabilities" | "masteryLevel" | "stage" | "dimensions" | "correct" | "schedule" | "lapses">,
  attempts: ReviewAttempt[],
): TaskRoute {
  const caps = capabilitiesOf(card);
  const recent = attempts
    .filter((attempt) => attempt.reviewedAt)
    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
    .slice(0, 5);
  const overconfidentMisses = recent.filter((attempt) => attempt.confidence >= 4 && !attempt.correct).length;
  if (overconfidentMisses >= 2) {
    return {
      dimension: "meaningRecall",
      task: "meaning",
      reason: "最近几次你自信但答错了：先做无提示词义回忆，并缩短复习间隔。",
      lowHint: true,
      shortInterval: true,
    };
  }
  const { formRecognition: fr, meaningRecall: mr, spelling: sp, collocation: co, grammarUse: gu, production: pr, transfer: tr } = caps;
  if (mr.strength < 0.45 || fr.strength < 0.4) {
    return {
      dimension: "meaningRecall",
      task: "meaning",
      reason: "词义或词形还未稳定，先巩固核心含义，暂不进入迁移练习。",
      lowHint: false,
      shortInterval: false,
    };
  }
  if (fr.strength >= 0.5 && sp.strength < 0.45) {
    return {
      dimension: "spelling",
      task: "cloze",
      reason: "你能认出这个词，但拼写还不可靠：先做拼写提取。",
      lowHint: false,
      shortInterval: false,
    };
  }
  if (mr.strength < 0.55) {
    return {
      dimension: "meaningRecall",
      task: "meaning",
      reason: "词义回忆偏弱：做一次主动回忆，确认核心含义。",
      lowHint: false,
      shortInterval: false,
    };
  }
  if (co.strength < 0.5) {
    return {
      dimension: "collocation",
      task: "collocation",
      reason: "词义稳定但搭配偏弱：补一次自然搭配练习。",
      lowHint: false,
      shortInterval: false,
    };
  }
  if (gu.strength < 0.5) {
    return {
      dimension: "grammarUse",
      task: "collocation",
      reason: "语法形式使用偏弱：做词形与句子纠错。",
      lowHint: false,
      shortInterval: false,
    };
  }
  if (pr.strength < 0.55) {
    return {
      dimension: "production",
      task: "sentence",
      reason: "你已经能理解这个词，现在练习主动造句。",
      lowHint: false,
      shortInterval: false,
    };
  }
  if (tr.strength < 0.65) {
    return {
      dimension: "transfer",
      task: "transfer",
      reason: "基础能力已稳定：换一个新语境练习迁移使用。",
      lowHint: false,
      shortInterval: false,
    };
  }
  return {
    dimension: "fluency",
    task: "meaning",
    reason: "各维度都已稳定：做限时回忆，巩固调用速度。",
    lowHint: false,
    shortInterval: false,
  };
}

/**
 * 从学习证据回放初始能力状态（用于完成文章后才建卡的词）。
 * 只应用客观任务结果（spell 等）；曝光（read）和主观跳过（skip-known）只记录不参与能力计算。
 */
export function replayCapabilitiesFromEvidence(
  events: LearningEvidence[],
): Record<CapabilityDimension, DimensionState> {
  const caps = Object.fromEntries(
    CAPABILITY_DIMENSIONS.map((dimension) => [dimension, emptyDimensionState()]),
  ) as Record<CapabilityDimension, DimensionState>;
  for (const event of events) {
    if (event.taskType === "read" || event.taskType === "skip-known") continue;
    const current = caps[event.dimension];
    if (!current) continue;
    caps[event.dimension] = applyDimensionEvidence(
      current,
      event,
      new Date(event.createdAt).getTime(),
    );
  }
  return caps;
}

/** 由多维能力推导兼容的旧等级（仅用于旧页面展示，不参与新学习逻辑）。 */
export function deriveMasteryLevel(
  capabilities: Record<CapabilityDimension, DimensionState>,
): MasteryLevel {
  if (capabilities.transfer.strength >= 0.8 && capabilities.production.strength >= 0.7) return 4;
  if (capabilities.production.strength >= 0.6) return 3;
  if (capabilities.meaningRecall.strength >= 0.55) return 2;
  if (capabilities.formRecognition.strength >= 0.45) return 1;
  return 0;
}

function nextDueFor(correct: boolean, hintLevel: number, stability: number, now: number): string {
  if (!correct) return new Date(now + DAY).toISOString();
  // 无提示成功按稳定度安排；使用提示则缩短一半，避免“提示后答对”被当成独立掌握。
  const factor = hintLevel === 0 ? 1 : 0.5;
  return new Date(now + Math.max(1, stability * factor) * DAY).toISOString();
}

/**
 * 用一条学习证据更新某个维度状态（纯函数，可测试）。
 * 规则：
 * - 无提示且答对：强度提升最高，间隔按稳定度放大；
 * - 使用提示（hintLevel>0）答对：只算部分掌握，间隔减半，不等同于独立答对；
 * - 答错：强度与稳定度下降，难度上升，下次短间隔；
 * - 信心高（≥4）但答错：记录为信心校准风险，惩罚更重；
 * - evidenceCount 每次+1；只有无提示成功才更新 lastHintFreeSuccessAt。
 */
export function applyDimensionEvidence(
  state: DimensionState,
  evidence: Pick<LearningEvidence, "correct" | "hintLevel" | "confidence" | "elapsedMs">,
  now = Date.now(),
): DimensionState {
  const nowIso = new Date(now).toISOString();
  const confidenceFactor = (evidence.confidence - 3) / 5; // -0.4..0.4
  const hinted = evidence.hintLevel > 0;
  let strength = state.strength;
  let stability = state.stability;
  let difficulty = state.difficulty;
  if (evidence.correct) {
    const gain = hinted ? 0.08 : 0.18;
    strength = Math.min(1, strength + gain * (1 + confidenceFactor));
    stability = Math.max(0.5, Math.min(365, stability * (hinted ? 1.25 : 2.2)));
    difficulty = Math.max(1, difficulty - (hinted ? 0.1 : 0.3));
  } else {
    // 自信但答错：校准风险，惩罚更重、间隔更短；低信心答错惩罚相对温和。
    const overconfidence = evidence.confidence >= 4 ? 1.4 : 1;
    const calibrationRisk = 1 + Math.max(0, confidenceFactor);
    strength = Math.max(0.05, strength - 0.22 * overconfidence * calibrationRisk);
    stability = Math.max(0.5, stability * 0.4);
    difficulty = Math.min(10, difficulty + 0.6 * overconfidence);
  }
  return {
    strength: Math.round(strength * 1000) / 1000,
    stability: Math.round(stability * 100) / 100,
    difficulty: Math.round(difficulty * 10) / 10,
    nextDueAt: nextDueFor(evidence.correct, evidence.hintLevel, stability, now),
    evidenceCount: state.evidenceCount + 1,
    lastSuccessAt: evidence.correct ? nowIso : state.lastSuccessAt,
    lastHintFreeSuccessAt:
      evidence.correct && !hinted ? nowIso : state.lastHintFreeSuccessAt,
  };
}

/** 当前最薄弱且已到期的能力维度（供任务路由挑选任务）。 */
export function weakestDimension(
  capabilities: Record<CapabilityDimension, DimensionState>,
  now = Date.now(),
): CapabilityDimension {
  return CAPABILITY_DIMENSIONS
    .map((dimension) => ({ dimension, state: capabilities[dimension] }))
    .filter(({ state }) => {
      const dueAt = state.nextDueAt ? new Date(state.nextDueAt).getTime() : 0;
      return !Number.isFinite(dueAt) || dueAt <= now;
    })
    .sort((a, b) => a.state.strength - b.state.strength || a.state.evidenceCount - b.state.evidenceCount)[0]?.dimension
    ?? CAPABILITY_DIMENSIONS
      .map((dimension) => ({ dimension, state: capabilities[dimension] }))
      .sort((a, b) => a.state.strength - b.state.strength)[0].dimension;
}

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
