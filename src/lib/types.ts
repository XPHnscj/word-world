export type ReviewTask = "meaning" | "cloze" | "collocation" | "transfer" | "sentence";
export type MasteryStage = "new" | "encountered" | "understood" | "recalled" | "transferred" | "stable";
export type MasteryLevel = 0 | 1 | 2 | 3 | 4;
export type ReviewPhase = "recognition" | "semantic" | "generation" | "transfer";
export type ReviewRating = "known" | "fuzzy" | "forgot";

/**
 * 八项能力维度（Paul Nation 词汇知识框架 + 流利度）。
 * 一个词不再只有一个等级，而是多项独立能力状态。
 */
export type CapabilityDimension =
  | "formRecognition" // 看见/听见后能否识别词形
  | "meaningRecall"   // 能否主动回忆核心词义
  | "spelling"        // 能否脱离原文正确拼写
  | "collocation"     // 能否使用自然搭配
  | "grammarUse"      // 能否使用正确词性与语法形式
  | "production"      // 能否在指定情境中主动造句
  | "transfer"        // 能否跨语境保持含义和用法
  | "fluency";        // 能否快速且稳定地调用

/** 提示层级：0 无提示 → 5 完整答案；使用完整答案不等于独立掌握。 */
export type HintLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** 单个能力维度的掌握状态。 */
export interface DimensionState {
  /** 当前掌握概率/强度（0-1）。 */
  strength: number;
  /** 记忆稳定天数。 */
  stability: number;
  /** 难度（1-10）。 */
  difficulty: number;
  /** 下次到期时间（null=尚未安排）。 */
  nextDueAt: string | null;
  /** 有效证据数量。 */
  evidenceCount: number;
  /** 最近一次成功时间。 */
  lastSuccessAt: string | null;
  /** 最近一次无提示成功时间。 */
  lastHintFreeSuccessAt: string | null;
}

/** 学习证据：每次有意义的练习操作追加一条，不可变，不覆盖历史。 */
export interface LearningEvidence {
  id: string;
  cardId: string;
  dimension: CapabilityDimension;
  /** 任务类型（meaning/cloze/collocation/transfer/sentence/spell/read 等）。 */
  taskType: string;
  correct: boolean;
  /** 0-100。 */
  score: number;
  /** 1-5 自信度。 */
  confidence: number;
  hintLevel: HintLevel;
  elapsedMs: number;
  answer?: string;
  contextId?: string;
  contextTopic?: string;
  /** 判定来源：AI 只负责自然度/语义/搭配，拼写与时间由本地确定。 */
  evaluator: "ai" | "local";
  createdAt: string;
}

export interface ContextWordUse {
  lemma: string;
  surfaceForm: string;
  meaningZh: string;
  translationZh?: string;
  phonetic?: string;
  morphology?: string;
  partOfSpeech: string;
  collocation: string;
  phraseFrame?: string;
  rhetoricalFunction?: string;
  register?: string;
  confusables?: string[];
  sentenceIndex: number;
}

export interface ContextTask {
  id: string;
  type: "comprehension" | "inference" | "cloze" | "transfer";
  prompt: string;
  choices: string[];
  answer: string;
  explanation: string;
}

/** 值得学习的关键句型：原文原句 + 句型结构 + 中文说明。 */
export interface KeySentence {
  sentence: string;
  pattern: string;
  explanation: string;
  /** 该句适合迁移到的 IELTS Writing 话题。 */
  writingTopic?: string;
}

export interface ContextPack {
  id: string;
  title: string;
  topic: string;
  difficulty: "IELTS standard" | "IELTS advanced";
  passage: string;
  translation: string;
  targetWords: ContextWordUse[];
  sentenceNotes: { sentence: string; core: string; translation: string }[];
  tasks: ContextTask[];
  qualityReport: { passed: boolean; score: number; notes: string[] };
  /** 本篇文章值得学习的关键句型（蓝色高亮）。 */
  keySentence?: KeySentence;
  /** 这篇短文对应的学习日（计划表第 N 天）。 */
  planDay?: number;
  /** 短文来源：AI 生成或本地模板。 */
  generatedBy?: "ai" | "local";
  createdAt: string;
}

export interface ScheduleState {
  difficulty: number;
  stability: number;
  lastReviewedAt: string | null;
  nextDueAt: string | null;
}

export interface WordCard {
  id: string;
  lemma: string;
  planDay?: number;
  sourceTitle?: string;
  definitionEn?: string;
  meaningZh: string;
  partOfSpeech: string;
  collocations: string[];
  packIds: string[];
  stage: MasteryStage;
  /** 分层复习等级：0 初见，1 识别，2 理解，3 调用，4 融入。旧卡没有该字段时按 stage 推导。 */
  masteryLevel?: MasteryLevel;
  /**
   * 多维能力状态：每张词卡八项能力独立保存。
   * 旧卡没有该字段时，由 masteryLevel/stage/dimensions 推导（只读兼容层）。
   */
  capabilities?: Record<CapabilityDimension, DimensionState>;
  /** 最近一次迁移复习使用的场景，避免连续抽到同一场景。 */
  transferTopics?: string[];
  schedule: ScheduleState;
  correct: number;
  lapses: number;
  hints: number;
  dimensions: { recognition: number; recall: number; collocation: number; reading: number; transfer: number };
  updatedAt: string;
}

export interface ReviewAttempt {
  id: string;
  cardId: string;
  task: ReviewTask;
  correct: boolean;
  hintLevel: number;
  confidence: number;
  elapsedMs: number;
  reviewedAt: string;
  /** 本次练习对应的能力维度（新证据模型的关联字段，旧记录可缺省）。 */
  dimension?: CapabilityDimension;
  /** 新版三态回忆判断；旧记录仅保留 correct/confidence。 */
  rating?: ReviewRating;
  phase?: ReviewPhase;
  answer?: string;
  evaluation?: ReviewEvaluation;
}

export interface ReviewEvaluation {
  passed: boolean;
  score: number;
  feedback: string;
  correction?: string;
  source: "ai" | "local";
}

/** 用户在本机创建或导入的词书。 */
export interface UserWordbook {
  id: string;
  name: string;
  words: string;
  createdAt: string;
}

/** 一次完整的首次学习或艾宾浩斯复习会话。 */
export interface StudySession {
  id: string;
  sourceDay: number;
  scheduleDay: number;
  kind: "learn" | "review";
  columnLabel: string;
  packId: string;
  wordCount: number;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
}
