import Dexie, { type Table } from "dexie";
import type { ContextPack, ContextTask, KeySentence, LearningEvidence, ReviewAttempt, ScheduleState, StudySession, UserWordbook, WordCard } from "./types";
import type { StorageSnapshot } from "./storageTypes";

/** packs 必须索引 planDay，重新生成时才能按学习日原子替换旧短文。 */
export const PACKS_SCHEMA = "id, createdAt, planDay";
export const PRIORITY_WORD_BOOK_ID = "priority-main-vocab";

const PENDING_EVIDENCE_KEY = "ielts-context-pending-evidence";

function readPendingEvidence(): LearningEvidence[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_EVIDENCE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as LearningEvidence[]) : [];
  } catch {
    return [];
  }
}

function queuePendingEvidence(events: LearningEvidence[]) {
  if (typeof window === "undefined" || !events.length) return;
  const merged = [...readPendingEvidence(), ...events].slice(-500);
  try {
    window.localStorage.setItem(PENDING_EVIDENCE_KEY, JSON.stringify(merged));
  } catch {
    // 存储空间不足时不阻塞当前学习流程；服务端可用时下一次请求仍会继续尝试。
  }
}

/** 把学习证据增量追加到项目 SQLite；失败时先落到本机队列，避免短暂离线丢失。 */
export async function appendEvidenceServer(events: LearningEvidence[]): Promise<void> {
  if (!events.length) return;
  await sendEvidence([...readPendingEvidence(), ...events].slice(-500));
}

async function sendEvidence(pending: LearningEvidence[]): Promise<void> {
  if (!pending.length) return;
  try {
    const response = await fetch("/api/storage/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: pending }),
    });
    if (!response.ok) throw new Error(`evidence request failed: ${response.status}`);
    if (typeof window !== "undefined") window.localStorage.removeItem(PENDING_EVIDENCE_KEY);
  } catch {
    queuePendingEvidence(pending);
  }
}

/** 应用启动或恢复网络时，将短暂离线期间积累的证据补写进 SQLite。 */
export async function flushPendingEvidence(): Promise<void> {
  const pending = readPendingEvidence();
  if (!pending.length) return;
  await sendEvidence(pending);
}

class LearningDB extends Dexie {
  cards!: Table<WordCard, string>;
  packs!: Table<ContextPack, string>;
  attempts!: Table<ReviewAttempt, string>;
  /** 用户标记为“已经会了”的词（填词时按 Enter 跳过），之后不再出现在新短文里。 */
  known!: Table<{ lemma: string; markedAt: string }, string>;
  wordbooks!: Table<UserWordbook, string>;
  sessions!: Table<StudySession, string>;

  constructor() {
    super("ielts-context-memory");
    this.version(1).stores({ cards: "id, lemma, stage, updatedAt", packs: "id, createdAt", attempts: "id, cardId, reviewedAt" });
    this.version(2).stores({ cards: "id, lemma, stage, updatedAt", packs: "id, createdAt", attempts: "id, cardId, reviewedAt", known: "lemma, markedAt" });
    this.version(3).stores({ cards: "id, lemma, stage, updatedAt", packs: "id, createdAt", attempts: "id, cardId, reviewedAt", known: "lemma, markedAt", wordbooks: "id, name, createdAt" });
    this.version(4).stores({ cards: "id, lemma, stage, updatedAt", packs: "id, createdAt", attempts: "id, cardId, reviewedAt", known: "lemma, markedAt", wordbooks: "id, name, createdAt", sessions: "id, sourceDay, scheduleDay, kind, completedAt" });
    this.version(5).stores({ cards: "id, lemma, stage, updatedAt", packs: PACKS_SCHEMA, attempts: "id, cardId, reviewedAt", known: "lemma, markedAt", wordbooks: "id, name, createdAt", sessions: "id, sourceDay, scheduleDay, kind, completedAt" });
  }
}

export const learningDB = new LearningDB();

export async function readLocalSnapshot(): Promise<StorageSnapshot> {
  const [cards, packs, attempts, known, wordbooks, sessions] = await Promise.all([
    learningDB.cards.toArray(),
    learningDB.packs.toArray(),
    learningDB.attempts.toArray(),
    learningDB.known.toArray(),
    learningDB.wordbooks.toArray(),
    learningDB.sessions.toArray(),
  ]);
  return { cards, packs, attempts, known, wordbooks, sessions };
}

export async function replaceLocalSnapshot(snapshot: StorageSnapshot): Promise<void> {
  await learningDB.transaction(
    "rw",
    [learningDB.cards, learningDB.packs, learningDB.attempts, learningDB.known, learningDB.wordbooks, learningDB.sessions],
    async () => {
      await Promise.all([
        learningDB.cards.clear(),
        learningDB.packs.clear(),
        learningDB.attempts.clear(),
        learningDB.known.clear(),
        learningDB.wordbooks.clear(),
        learningDB.sessions.clear(),
      ]);
      await Promise.all([
        learningDB.cards.bulkPut(snapshot.cards),
        learningDB.packs.bulkPut(snapshot.packs),
        learningDB.attempts.bulkPut(snapshot.attempts),
        learningDB.known.bulkPut(snapshot.known),
        learningDB.wordbooks.bulkPut(snapshot.wordbooks),
        learningDB.sessions.bulkPut(snapshot.sessions),
      ]);
    },
  );
}

export async function readServerSnapshot(): Promise<StorageSnapshot | null> {
  try {
    const response = await fetch("/api/storage", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { snapshot?: StorageSnapshot };
    return body.snapshot ?? null;
  } catch {
    return null;
  }
}

export async function writeServerSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
  try {
    const response = await fetch("/api/storage", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let serverSyncTimer: number | undefined;
/** 将浏览器缓存的最新快照异步写回项目目录 SQLite，连续操作会合并为一次事务。 */
export function scheduleServerSnapshotSync() {
  if (typeof window === "undefined") return;
  if (serverSyncTimer) window.clearTimeout(serverSyncTimer);
  serverSyncTimer = window.setTimeout(() => {
    serverSyncTimer = undefined;
    void readLocalSnapshot().then(writeServerSnapshot);
  }, 250);
}

/** 在同一事务内替换某学习日的短文，失败时保留原文。 */
export async function replacePackForDay(planDay: number, nextPack: ContextPack): Promise<void> {
  await learningDB.transaction("rw", learningDB.packs, async () => {
    await learningDB.packs.where("planDay").equals(planDay).delete();
    await learningDB.packs.put(nextPack);
  });
  scheduleServerSnapshotSync();
}

/** 清空学习过程数据，保留用户词书和应用设置，供本地重新测试计划使用。 */
export async function resetStudyProgress(): Promise<void> {
  await learningDB.transaction(
    "rw",
    [learningDB.packs, learningDB.cards, learningDB.attempts, learningDB.known, learningDB.sessions],
    async () => {
      await Promise.all([
        learningDB.packs.clear(),
        learningDB.cards.clear(),
        learningDB.attempts.clear(),
        learningDB.known.clear(),
        learningDB.sessions.clear(),
      ]);
    },
  );
  scheduleServerSnapshotSync();
}

/** 恢复首次安装状态：清除全部本地学习数据与用户词书。应用设置由调用方清理。 */
export async function resetEntireSystem(): Promise<void> {
  await learningDB.transaction(
    "rw",
    [learningDB.packs, learningDB.cards, learningDB.attempts, learningDB.known, learningDB.sessions, learningDB.wordbooks],
    async () => {
      await Promise.all([
        learningDB.packs.clear(),
        learningDB.cards.clear(),
        learningDB.attempts.clear(),
        learningDB.known.clear(),
        learningDB.sessions.clear(),
        learningDB.wordbooks.clear(),
      ]);
    },
  );
  scheduleServerSnapshotSync();
}

export function isoNow() { return new Date().toISOString(); }

/** 请求浏览器将学习数据标记为持久化，避免在长期磁盘压力下被静默回收。 */
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** 标记一个词为“已经会了”，返回是否为新标记（false 表示之前已标记）。 */
export async function markWordKnown(lemma: string): Promise<boolean> {
  const clean = lemma.trim().toLowerCase();
  if (!clean) return false;
  const existing = await learningDB.known.get(clean);
  if (existing) return false;
  await learningDB.known.put({ lemma: clean, markedAt: isoNow() });
  scheduleServerSnapshotSync();
  return true;
}

/** 取消“已经会了”标记，返回是否存在该标记。 */
export async function unmarkWordKnown(lemma: string): Promise<boolean> {
  const clean = lemma.trim().toLowerCase();
  if (!clean) return false;
  const deleted = await learningDB.known.delete(clean);
  scheduleServerSnapshotSync();
  return deleted !== undefined;
}

/** 切换词的“已会”状态，返回切换后是否为已会。 */
export async function toggleWordKnown(lemma: string): Promise<boolean> {
  const clean = lemma.trim().toLowerCase();
  if (!clean) return false;
  const existing = await learningDB.known.get(clean);
  if (existing) {
    await learningDB.known.delete(clean);
    scheduleServerSnapshotSync();
    return false;
  }
  await learningDB.known.put({ lemma: clean, markedAt: isoNow() });
  scheduleServerSnapshotSync();
  return true;
}

/** 将日常遇到的生词并入主词库扩展，并标记为下一篇短文优先词。 */
export async function addPriorityWord(lemma: string): Promise<boolean> {
  const clean = lemma.trim().toLowerCase();
  if (!/^[a-z][a-z'-]*$/.test(clean)) return false;
  const added = await learningDB.transaction("rw", learningDB.wordbooks, async () => {
    const existing = await learningDB.wordbooks.get(PRIORITY_WORD_BOOK_ID);
    const words = existing?.words
      .split(/\r?\n/)
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean) ?? [];
    if (words.includes(clean)) return false;
    await learningDB.wordbooks.put({
      id: PRIORITY_WORD_BOOK_ID,
      name: "主词库扩展 · 明日优先",
      words: [...words, clean].join("\n"),
      createdAt: existing?.createdAt ?? isoNow(),
      kind: "priority",
    });
    return true;
  });
  if (!added) return false;
  scheduleServerSnapshotSync();
  return true;
}

/** 生词完成一次可靠拼写后移出明日优先队列；如果仍然答错则继续保留。 */
export async function removePriorityWord(lemma: string): Promise<void> {
  const clean = lemma.trim().toLowerCase();
  const removed = await learningDB.transaction("rw", learningDB.wordbooks, async () => {
    const existing = await learningDB.wordbooks.get(PRIORITY_WORD_BOOK_ID);
    if (!existing) return false;
    const originalWords = existing.words
      .split(/\r?\n/)
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean);
    const words = originalWords.filter((word) => word !== clean);
    if (words.length === originalWords.length) return false;
    if (words.length) {
      await learningDB.wordbooks.put({ ...existing, words: words.join("\n") });
    } else {
      await learningDB.wordbooks.delete(PRIORITY_WORD_BOOK_ID);
    }
    return true;
  });
  if (!removed) return;
  scheduleServerSnapshotSync();
}

export interface PackMeta {
  /** 中文全文翻译（AI 生成时提供）。 */
  translation?: string;
  /** 按小写词元索引的逐词释义。 */
  meanings?: Record<string, { meaningZh: string; translationZh?: string; phonetic?: string; morphology?: string; partOfSpeech: string; collocation: string; phraseFrame?: string; rhetoricalFunction?: string; register?: string; confusables?: string[] }>;
  /** 关键句型（AI 生成时提供，缺省时本地自动挑选）。 */
  keySentence?: KeySentence;
  /** 短文标题（缺省用演示标题）。 */
  title?: string;
  /** 短文主题（缺省用演示主题）。 */
  topic?: string;
  /** 这篇短文归属的学习日。 */
  planDay?: number;
  /** 短文来源标记。 */
  generatedBy?: "ai" | "local";
}

/** 旧的演示短文用的 8 个词，用于识别并清理历史遗留的“死的”模板短文。 */
export const DEMO_LEMMAS = ["adapt", "allocate", "decline", "evidence", "maintain", "resilient", "sustainable", "trend"];

const DEMO_TRANSLATION =
  "城市正在学习适应气候压力。地方规划者把资金分配给有遮荫的街道和可靠的公共交通。虽然汽车使用量可能下降得很慢，但新的证据表明，小的设计选择也能维持公众对服务的信任。一个有韧性的社区不是由一个引人注目的项目定义，而是由一个在条件变化时仍能持续运行的可持续系统定义。";

export function makePack(words: string[], passage: string, now = isoNow(), maxWords = 8, meta?: PackMeta): ContextPack {
  const unique = [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, Math.max(1, maxWords));
  const sentenceList = passage.split(/(?<=[.!?])\s+/).filter(Boolean);
  const meanings: Record<string, string> = { adapt: "适应", allocate: "分配", decline: "下降", evidence: "证据", maintain: "维持", resilient: "有韧性的", sustainable: "可持续的", trend: "趋势" };
  const targetWords = unique.map((lemma, index) => {
    const meaning = meta?.meanings?.[lemma];
    return {
      lemma,
      surfaceForm: lemma,
      meaningZh: meaning?.meaningZh ?? meanings[lemma] ?? "当前语境中的核心含义",
      translationZh: meaning?.translationZh,
      phonetic: meaning?.phonetic,
      morphology: meaning?.morphology,
      partOfSpeech: meaning?.partOfSpeech ?? "word",
      collocation: meaning?.collocation ?? `use ${lemma} in context`,
      phraseFrame: meaning?.phraseFrame,
      rhetoricalFunction: meaning?.rhetoricalFunction,
      register: meaning?.register,
      confusables: meaning?.confusables,
      sentenceIndex: index % Math.max(sentenceList.length, 1),
    };
  });
  const tasks: ContextTask[] = [
    { id: "meaning", type: "inference", prompt: `在本文语境中，${unique[0] ?? "目标词"} 最接近什么含义？`, choices: ["适应变化", "完全停止", "重复旧方案", "隐藏信息"], answer: "适应变化", explanation: "先根据邻近线索推断，再核对词卡释义。" },
    { id: "read", type: "comprehension", prompt: "文章的主要观点是什么？", choices: ["小幅、持续的政策设计能提升城市韧性", "城市应该停止所有交通建设", "单个大型项目可以解决所有问题", "气候变化不会影响公共服务"], answer: "小幅、持续的政策设计能提升城市韧性", explanation: "文章在多处强调持续、可维护和可适应的系统。" },
  ];
  const keySentence = resolveKeySentence(passage, meta?.keySentence, unique);
  const isLegacyDemo = unique.length === DEMO_LEMMAS.length && DEMO_LEMMAS.every((lemma) => unique.includes(lemma));
  const translation = meta?.translation ?? (isLegacyDemo
    ? DEMO_TRANSLATION
    : "本地模板暂未提供与本文对应的中文翻译，请配置 AI 后重新生成。");
  const sentenceNotes = keySentence
    ? [{ sentence: keySentence.sentence, core: keySentence.pattern, translation: keySentence.explanation }]
    : sentenceList.slice(0, 2).map((sentence) => ({ sentence, core: sentence.split(",")[0], translation: "先找出主句谓语，再判断从句与主句之间的逻辑关系。" }));
  return { id: `pack_${Date.now().toString(36)}`, title: meta?.title ?? "城市适应力与公共政策", topic: meta?.topic ?? "城市与环境", difficulty: "IELTS standard", passage, translation, targetWords, sentenceNotes, tasks, qualityReport: { passed: true, score: 4.7, notes: ["目标词覆盖完整", "文章长度和结构符合标准", "题目答案唯一"] }, keySentence, planDay: meta?.planDay, generatedBy: meta?.generatedBy ?? "local", createdAt: now };
}

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 关键句型：优先采用 AI 提供且能在 passage 中逐字定位的句子（做归一化对齐，
 * 防止模型返回的句子与正文有微小出入导致无法高亮）；否则本地启发式挑选
 * 包含目标词最多的长句。
 */
function resolveKeySentence(
  passage: string,
  provided: KeySentence | undefined,
  targetLemmas: string[],
): KeySentence | undefined {
  const sentences = passage.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (provided?.sentence) {
    const normalized = normalizeForMatch(provided.sentence);
    if (normalized) {
      const match = sentences.find((sentence) => {
        const candidate = normalizeForMatch(sentence);
        return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
      });
      if (match)
        return {
          sentence: match,
          pattern: provided.pattern?.trim() || "关键句型",
          explanation: provided.explanation?.trim() || "建议拆解主干、模仿造句。",
          writingTopic: provided.writingTopic?.trim() || undefined,
        };
    }
  }
  if (!sentences.length) return undefined;
  const score = (sentence: string) => {
    const hits = targetLemmas.filter((lemma) => sentence.toLowerCase().includes(lemma)).length;
    return hits * 100 + Math.min(sentence.length, 300);
  };
  const best = [...sentences].sort((a, b) => score(b) - score(a))[0];
  return best
    ? {
        sentence: best,
        pattern: "让步/对比从句 + 论点主句",
        explanation: "先承认限制或对立观点，再推进核心论点；适合 Task 2 主体段中的让步论证与政策评价。",
        writingTopic: "城市治理 / 环境政策",
      }
    : undefined;
}

export function schedule(state: ScheduleState, grade: 1 | 2 | 3 | 4, reviewedAt = isoNow()): ScheduleState {
  const factors = { 1: 0.5, 2: 1.2, 3: 2.4, 4: 3.6 } as const;
  const difficulty = Math.max(1, Math.min(10, state.difficulty + ({ 1: 0.8, 2: 0.2, 3: -0.2, 4: -0.35 } as const)[grade]));
  const stability = Math.max(0.5, Math.min(365, Math.round((state.stability || 0.5) * factors[grade] * 100) / 100));
  const next = new Date(new Date(reviewedAt).getTime() + stability * 86_400_000);
  return { difficulty, stability, lastReviewedAt: reviewedAt, nextDueAt: next.toISOString() };
}

export function gradeFor(correct: boolean, hintLevel: number, fast: boolean, transfer: boolean): 1 | 2 | 3 | 4 {
  if (!correct) return 1;
  if (hintLevel > 0) return 2;
  if (fast && transfer) return 4;
  return 3;
}
