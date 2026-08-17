export type ReviewTask = "meaning" | "cloze" | "collocation" | "transfer" | "sentence";
export type MasteryStage = "new" | "encountered" | "understood" | "recalled" | "transferred" | "stable";
export type MasteryLevel = 0 | 1 | 2 | 3 | 4;
export type ReviewPhase = "recognition" | "semantic" | "generation" | "transfer";
export type ReviewRating = "known" | "fuzzy" | "forgot";

export interface ContextWordUse {
  lemma: string;
  surfaceForm: string;
  meaningZh: string;
  translationZh?: string;
  phonetic?: string;
  morphology?: string;
  partOfSpeech: string;
  collocation: string;
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
