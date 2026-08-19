import type { ReviewTask, WordCard } from "@/lib/types";

export type AppTab =
  | "today"
  | "import"
  | "read"
  | "progress"
  | "statistics"
  | "settings";
export type PlanningMode = "topic" | "story";

export type AISettings = {
  provider: string;
  displayName: string;
  protocol: "openai_compatible_chat" | "openai_responses";
  baseUrl: string;
  apiKey: string;
  headers: string;
  model: string;
  planning: PlanningMode;
  totalVocabulary: number;
  dailyNewWords: number;
  targetDays: number;
  typingShake: number;
  particleSize: number;
  particleFrequency: number;
  particleStyle: "chips" | "sparks" | "ink" | "confetti";
  typingSound: "mechanical" | "soft" | "thock" | "typewriter" | "arcade" | "muted";
};

export const TABS: Array<[AppTab, string]> = [
  ["today", "计划表"],
  ["import", "导入词汇"],
  ["progress", "学习效果"],
  ["statistics", "学习统计"],
  ["settings", "设置"],
];

export const DEMO_WORDS =
  "adapt allocate decline evidence maintain resilient sustainable trend";

const REVIEW_OFFSETS = [
  { label: "First", offset: 0 },
  { label: "Day 1", offset: 1 },
  { label: "Day 2", offset: 2 },
  { label: "Day 4", offset: 4 },
  { label: "Day 7", offset: 7 },
  { label: "Day 15", offset: 15 },
  { label: "Day 30", offset: 30 },
] as const;

export type PlanEntryKind = "learn" | "review";
export type ReviewColumn = {
  label: string;
  start: number;
  end: number;
  kind: PlanEntryKind;
};
export type PlanEntry = {
  sourceDay: number;
  scheduleDay: number;
  columnLabel: string;
  kind: PlanEntryKind;
};

export const TASK_CYCLE: ReviewTask[] = [
  "meaning",
  "cloze",
  "collocation",
  "transfer",
  "sentence",
];

export const DIMENSION_BY_TASK: Record<
  ReviewTask,
  keyof WordCard["dimensions"]
> = {
  meaning: "recognition",
  cloze: "reading",
  collocation: "collocation",
  transfer: "transfer",
  sentence: "recall",
};

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "OpenAI",
  displayName: "OpenAI",
  protocol: "openai_compatible_chat",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  headers: "",
  model: "gpt-4o-mini",
  planning: "topic",
  totalVocabulary: 4000,
  dailyNewWords: 10,
  targetDays: 400,
  typingShake: 55,
  particleSize: 60,
  particleFrequency: 40,
  particleStyle: "chips",
  typingSound: "mechanical",
};

export const PROVIDER_PRESETS = [
  {
    id: "openai",
    name: "OpenAI",
    note: "官方兼容接口",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    mark: "OA",
    icon: "/providers/openai.svg",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    note: "OpenAI Chat 协议",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    mark: "DS",
    icon: "/providers/deepseek.png",
  },
  {
    id: "qwen",
    name: "通义千问",
    note: "DashScope 兼容模式",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    mark: "QW",
    icon: "/providers/qwen.png",
  },
  {
    id: "custom",
    name: "自定义兼容",
    note: "代理或中转服务",
    baseUrl: "",
    model: "",
    mark: "API",
    icon: undefined,
  },
] as const;

export const DEFINITIONS: Record<string, string> = {
  adapt: "to adjust to a new condition",
  allocate: "to give resources for a particular purpose",
  decline: "to become lower or weaker",
  evidence: "facts that show something is true",
  maintain: "to keep something at the same level",
  resilient: "able to recover after difficulty",
  sustainable: "able to continue without exhausting resources",
  trend: "a general direction of change",
};

export function buildReviewColumns(totalDays: number): ReviewColumn[] {
  return REVIEW_OFFSETS.map((column) => ({
    label: column.label,
    start: column.offset + 1,
    end: totalDays,
    kind: column.offset === 0 ? "learn" : "review",
  }));
}

export function getPlanEntry(row: number, column: ReviewColumn): PlanEntry | null {
  if (row < column.start || row > column.end) return null;
  return {
    sourceDay: row - column.start + 1,
    scheduleDay: row,
    columnLabel: column.label,
    kind: column.kind,
  };
}

export function planEntryKey(entry: PlanEntry) {
  return `${entry.scheduleDay}:${entry.columnLabel}:${entry.sourceDay}`;
}

export function isPlanEntryComplete(
  entry: PlanEntry,
  completedDays: number[],
  completedReviewEntries: string[],
) {
  return entry.kind === "learn"
    ? completedDays.includes(entry.sourceDay)
    : completedReviewEntries.includes(planEntryKey(entry));
}

/** 一横排代表一个实际学习日；该日所有有效的新学/复习任务都完成才算完成。 */
export function isPlanRowComplete(
  row: number,
  columns: ReviewColumn[],
  completedDays: number[],
  completedReviewEntries: string[],
) {
  const entries = columns
    .map((column) => getPlanEntry(row, column))
    .filter((entry): entry is PlanEntry => entry !== null);
  return entries.length > 0 && entries.every((entry) =>
    isPlanEntryComplete(entry, completedDays, completedReviewEntries),
  );
}

/** 第一天默认解锁；后续每一排必须等上一排全部完成。 */
export function isPlanRowUnlocked(
  row: number,
  columns: ReviewColumn[],
  completedDays: number[],
  completedReviewEntries: string[],
) {
  return row <= 1 || isPlanRowComplete(row - 1, columns, completedDays, completedReviewEntries);
}

export function buildDayGroups(totalDays: number) {
  const groups: Array<{ label: string; start: number; end: number }> = [];
  for (let start = 1; start <= totalDays; start += 21) {
    const end = Math.min(totalDays, start + 20);
    groups.push({
      label: `${String(start).padStart(2, "0")}–${String(end).padStart(2, "0")}`,
      start,
      end,
    });
  }
  return groups;
}
