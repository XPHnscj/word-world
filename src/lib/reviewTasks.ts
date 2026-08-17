import type { CapabilityDimension, WordCard } from "./types";
import { localEvaluateSentence } from "./reviewEngine";

/** 提示阶梯的一层：层级 1..5（0 表示无提示）。 */
export interface HintStep {
  label: string;
  content: (card: WordCard) => string;
}

export interface OfflineJudgement {
  correct: boolean;
  score: number;
}

/** 每个能力维度对应的复习任务规格：引导语 + 提示阶梯 + 本地基础判定。 */
export interface ReviewTaskSpec {
  dimension: CapabilityDimension;
  prompt: (card: WordCard) => string;
  hintLadder: HintStep[];
  judge: (card: WordCard, answer: string) => OfflineJudgement;
}

const escapeLemma = (lemma: string) => lemma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const lemmaBoundary = (lemma: string) => new RegExp(`\\b${escapeLemma(lemma)}\\b`, "i");
const lemmaWithForms = (lemma: string) =>
  new RegExp(`\\b${escapeLemma(lemma)}(?:s|es|ed|ing)?\\b`, "i");

const meaningMatches = (card: WordCard, answer: string) => {
  const expected = card.meaningZh.trim();
  const actual = answer.trim();
  return Boolean(expected) && actual.includes(expected);
};

export const TASK_SPECS: Record<CapabilityDimension, ReviewTaskSpec> = {
  formRecognition: {
    dimension: "formRecognition",
    prompt: (card) => `看到 “${card.lemma}” 你能立刻想到它的含义吗？写出来。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "词形提示", content: (card) => `首字母：${card.lemma[0] ?? ""} · 共 ${card.lemma.length} 个字母` },
      { label: "搭配提示", content: (card) => `常用搭配：${card.collocations[0] ?? "暂无"}` },
      { label: "英文释义", content: (card) => `英文释义：${card.definitionEn ?? "暂无"}` },
      { label: "完整答案", content: (card) => `答案：${card.lemma} — ${card.meaningZh}` },
    ],
    judge: (card, answer) => {
      const text = answer.trim();
      return meaningMatches(card, text)
        ? { correct: true, score: 90 }
        : { correct: false, score: 0 };
    },
  },
  meaningRecall: {
    dimension: "meaningRecall",
    prompt: (card) => `不用看答案，回忆 “${card.lemma}” 的核心含义。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "词形提示", content: (card) => `首字母：${card.lemma[0] ?? ""} · 共 ${card.lemma.length} 个字母` },
      { label: "搭配提示", content: (card) => `常用搭配：${card.collocations[0] ?? "暂无"}` },
      { label: "英文释义", content: (card) => `英文释义：${card.definitionEn ?? "暂无"}` },
      { label: "完整答案", content: (card) => `答案：${card.meaningZh}` },
    ],
    judge: (card, answer) => {
      const text = answer.trim();
      return meaningMatches(card, text)
        ? { correct: true, score: 90 }
        : { correct: false, score: 0 };
    },
  },
  spelling: {
    dimension: "spelling",
    prompt: (card) => `不看原文，拼写 “${card.meaningZh}” 对应的英文单词。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "首字母", content: (card) => `首字母：${card.lemma[0] ?? ""}` },
      { label: "音节提示", content: (card) => `共 ${card.lemma.length} 个字母` },
      { label: "英文释义", content: (card) => `释义：${card.definitionEn ?? "暂无"}` },
      { label: "完整拼写", content: (card) => `答案：${card.lemma}` },
    ],
    judge: (card, answer) =>
      answer.trim().toLowerCase() === card.lemma.toLowerCase()
        ? { correct: true, score: 100 }
        : { correct: false, score: 0 },
  },
  collocation: {
    dimension: "collocation",
    prompt: (card) => `写出一个包含 “${card.lemma}” 的自然搭配（2-6 个词）。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "常见搭配", content: (card) => `参考搭配：${card.collocations[0] ?? "暂无"}` },
      { label: "英文释义", content: (card) => `释义：${card.definitionEn ?? "暂无"}` },
      { label: "完整答案", content: (card) => `答案：${card.collocations[0] ?? `use ${card.lemma} in context`}` },
      { label: "例句", content: (card) => `例句：The team decided to ${card.lemma} the budget.（仅供参考）` },
    ],
    judge: (card, answer) => {
      const words = answer.trim().split(/\s+/).filter(Boolean);
      const ok = lemmaBoundary(card.lemma).test(answer) && words.length >= 2 && words.length <= 6;
      return ok ? { correct: true, score: 90 } : { correct: false, score: 0 };
    },
  },
  grammarUse: {
    dimension: "grammarUse",
    prompt: (card) => `用 “${card.lemma}” 的正确形式（词性/时态）写一个短语或短句。`,
    hintLadder: [
      { label: "词性", content: (card) => `目标词性：${card.partOfSpeech || "未知"}` },
      { label: "基础形式", content: (card) => `基础形式：${card.lemma}` },
      { label: "英文释义", content: (card) => `释义：${card.definitionEn ?? "暂无"}` },
      { label: "完整答案", content: (card) => `答案示例：${card.collocations[0] ?? `a ${card.lemma}`}` },
      { label: "例句", content: (card) => `例句：The plan requires careful ${card.lemma}.（仅供参考）` },
    ],
    judge: (card, answer) =>
      lemmaWithForms(card.lemma).test(answer) && answer.trim().split(/\s+/).length >= 2
        ? { correct: true, score: 85 }
        : { correct: false, score: 0 },
  },
  production: {
    dimension: "production",
    prompt: (card) => `用 “${card.lemma}” 写一句完整、自然的英文句子。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "搭配", content: (card) => `搭配：${card.collocations[0] ?? "暂无"}` },
      { label: "句型", content: () => "尝试“主语 + 动词 + 具体情境”的结构。" },
      { label: "英文释义", content: (card) => `释义：${card.definitionEn ?? "暂无"}` },
      { label: "例句", content: (card) => `例句：The ${card.lemma} helped the team move forward.（仅供参考）` },
    ],
    judge: (card, answer) => {
      const result = localEvaluateSentence(card.lemma, answer);
      return { correct: result.passed, score: result.score };
    },
  },
  transfer: {
    dimension: "transfer",
    prompt: (card) => `换一个全新场景（工作、校园、旅行等）写一句包含 “${card.lemma}” 的英文。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "搭配", content: (card) => `搭配：${card.collocations[0] ?? "暂无"}` },
      { label: "场景示例", content: () => "场景示例：在办公室讨论预算、在车站规划行程。" },
      { label: "英文释义", content: (card) => `释义：${card.definitionEn ?? "暂无"}` },
      { label: "例句", content: (card) => `例句：We can ${card.lemma} the plan after the meeting.（仅供参考）` },
    ],
    judge: (card, answer) => {
      const result = localEvaluateSentence(card.lemma, answer);
      return { correct: result.passed, score: result.score };
    },
  },
  fluency: {
    dimension: "fluency",
    prompt: (card) => `限时回忆：看到 “${card.lemma}” 立刻说出或写出含义（越快越好）。`,
    hintLadder: [
      { label: "词性", content: (card) => `词性：${card.partOfSpeech || "未知"}` },
      { label: "首字母", content: (card) => `首字母：${card.lemma[0] ?? ""}` },
      { label: "搭配", content: (card) => `搭配：${card.collocations[0] ?? "暂无"}` },
      { label: "英文释义", content: (card) => `释义：${card.definitionEn ?? "暂无"}` },
      { label: "完整答案", content: (card) => `答案：${card.meaningZh}` },
    ],
    judge: (card, answer) => {
      const text = answer.trim();
      return meaningMatches(card, text)
        ? { correct: true, score: 95 }
        : { correct: false, score: 0 };
    },
  },
};

/** 取某一维度任务在某提示层级下显示的内容（0 = 无提示 → null）。 */
export function hintForLevel(
  spec: ReviewTaskSpec,
  card: WordCard,
  hintLevel: number,
): { label: string; content: string } | null {
  if (hintLevel <= 0) return null;
  const step = spec.hintLadder[hintLevel - 1];
  return step ? { label: step.label, content: step.content(card) } : null;
}
