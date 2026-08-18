"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { useLiveQuery } from "dexie-react-hooks";
import {
  DEMO_LEMMAS,
  appendEvidenceServer,
  ensurePersistentStorage,
  flushPendingEvidence,
  isoNow,
  learningDB,
  makePack,
  readLocalSnapshot,
  readServerSnapshot,
  replaceLocalSnapshot,
  replacePackForDay,
  resetEntireSystem,
  resetStudyProgress,
  scheduleServerSnapshotSync,
  toggleWordKnown,
  writeServerSnapshot,
} from "@/lib/db";
import type { CapabilityDimension, ContextPack, HintLevel, LearningEvidence, UserWordbook, WordbookPlan, WordCard } from "@/lib/types";
import { applyDimensionEvidence, capabilitiesOf, CAPABILITY_DIMENSIONS, emptyDimensionState } from "@/lib/reviewEngine";
import {
  pickDiverseVocabulary,
  type IeltsEntry,
} from "@/lib/ieltsVocab";
import { BUILTIN_WORDBOOKS, getBuiltinWordbook, isBuiltinWordbookId } from "@/lib/builtinWordbooks";
import { loadWordbookVocab } from "@/lib/wordbookVocab";
import {
  EXTERNAL_VOCABULARY_ID,
  EXTERNAL_VOCABULARY_NAME,
  parseExternalWords,
} from "@/lib/externalVocabulary";
import { countEnglishWords, findDuplicateTarget, findMissingTargets, findMissingTranslationAnnotations, hasCompleteTranslationAnnotations, normalizeTranslationChunk, parseContextPack } from "@/lib/contextPack";
import { buildLocalPassage } from "@/lib/localPassage";
import { TodayView } from "./components/TodayView";
import { ProgressView } from "./components/ProgressView";
import { StatisticsView } from "./components/StatisticsView";
import {
  buildDayGroups,
  buildReviewColumns,
  DEFAULT_AI_SETTINGS,
  DEFINITIONS,
  PROVIDER_PRESETS,
  TABS,
  type AISettings,
  type AppTab,
  type PlanEntry,
  planEntryKey,
} from "./learning-config";
/** 全局轻提示：生成完成等后台结果的通知。 */
type Toast = {
  message: string;
  action?: { label: string; onClick: () => void };
};

let typingAudioContext: AudioContext | null = null;
let typingNoiseBuffer: AudioBuffer | null = null;
const lastPhysicalKeySound = new WeakMap<HTMLInputElement, number>();
type SpellingResult = "correct" | "wrong";
type TypingFeedbackConfig = Pick<AISettings, "typingShake" | "particleSize" | "particleFrequency" | "typingSound">;

function ensureTypingAudio() {
  typingAudioContext ??= new AudioContext({ latencyHint: "interactive" });
  if (typingAudioContext.state === "suspended") void typingAudioContext.resume();
  return typingAudioContext;
}

/** 机械键感由高频触点声和低频落键声叠加，起音不做延迟调度。 */
function playTypingKeySound(kind: "character" | "space" | "delete", sound: AISettings["typingSound"]) {
  if (sound === "muted") return;
  try {
    const context = ensureTypingAudio();
    const now = context.currentTime;
    if (!typingNoiseBuffer || typingNoiseBuffer.sampleRate !== context.sampleRate) {
      const frameCount = Math.ceil(context.sampleRate * 0.032);
      typingNoiseBuffer = context.createBuffer(1, frameCount, context.sampleRate);
      const channel = typingNoiseBuffer.getChannelData(0);
      for (let index = 0; index < frameCount; index += 1) {
        const decay = Math.pow(1 - index / frameCount, 3.2);
        channel[index] = (Math.random() * 2 - 1) * decay;
      }
    }

    const click = context.createBufferSource();
    const clickFilter = context.createBiquadFilter();
    const clickGain = context.createGain();
    click.buffer = typingNoiseBuffer;
    click.playbackRate.setValueAtTime(
      kind === "delete" ? 0.78 : kind === "space" ? 0.9 : 0.98 + Math.random() * 0.14,
      now,
    );
    clickFilter.type = "bandpass";
    clickFilter.frequency.setValueAtTime(
      sound === "soft" ? 820 + Math.random() * 120 : kind === "delete" ? 1250 : 1850 + Math.random() * 280,
      now,
    );
    clickFilter.Q.setValueAtTime(0.75, now);
    clickGain.gain.setValueAtTime(sound === "soft" ? 0.046 : kind === "space" ? 0.075 : 0.09, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(context.destination);
    click.start(now);
    click.stop(now + 0.035);

    const thock = context.createOscillator();
    const thockGain = context.createGain();
    thock.type = sound === "soft" ? "sine" : "triangle";
    const base = kind === "delete" ? 82 : kind === "space" ? 104 : 118 + Math.random() * 14;
    thock.frequency.setValueAtTime(base * 1.35, now);
    thock.frequency.exponentialRampToValueAtTime(base, now + 0.032);
    thockGain.gain.setValueAtTime(kind === "space" ? 0.045 : 0.036, now);
    thockGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.052);
    thock.connect(thockGain);
    thockGain.connect(context.destination);
    thock.start(now);
    thock.stop(now + 0.055);
  } catch {
    // 浏览器禁用音频时保留其他反馈。
  }
}

function handlePhysicalTypingKey(event: React.KeyboardEvent<HTMLInputElement>, config: TypingFeedbackConfig) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const kind = event.key === "Backspace" || event.key === "Delete"
    ? "delete"
    : event.key === " "
      ? "space"
      : event.key.length === 1
        ? "character"
        : null;
  if (!kind) return;
  lastPhysicalKeySound.set(event.currentTarget, performance.now());
  playTypingKeySound(kind, config.typingSound);
}

/** 行内拼写的轻量键感：短促合成键音 + 输入框微回弹，不依赖外部音频资源。 */
function triggerTypingFeedback(
  event: React.FormEvent<HTMLInputElement>,
  config: TypingFeedbackConfig,
) {
  const input = event.currentTarget;
  const nativeEvent = event.nativeEvent as InputEvent;
  const inputType = nativeEvent.inputType ?? "insertText";
  const isDelete = inputType.startsWith("delete");
  const isSpace = nativeEvent.data === " ";
  const isInsertion = inputType.startsWith("insert");
  if (!isInsertion && !isDelete) return;

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    input.style.setProperty("--typing-shake", `${0.5 + config.typingShake / 28}px`);
    input.classList.remove("typing-hit");
    void input.offsetWidth;
    input.classList.add("typing-hit");

    // 偶发的“重键”会抖一下并落下少量碎屑，保持惊喜感而不干扰连续输入。
    if (isInsertion && !isSpace && Math.random() < config.particleFrequency / 100) {
      input.classList.remove("typing-impact");
      void input.offsetWidth;
      input.classList.add("typing-impact");
      const host = input.parentElement;
      if (host) {
        const originX = input.offsetLeft + Math.min(
          input.clientWidth - 5,
          6 + input.value.length * 9,
        );
        const originY = input.offsetTop + input.clientHeight - 3;
        const count = 4 + Math.floor(Math.random() * 4);
        const colors = ["#087d6d", "#18a58d", "#b47b25", "#d5a84f", "#315e57"];
        for (let index = 0; index < count; index += 1) {
          const particle = document.createElement("i");
          particle.className = "typing-particle";
          particle.setAttribute("aria-hidden", "true");
          particle.style.left = `${originX}px`;
          particle.style.top = `${originY}px`;
          particle.style.setProperty("--particle-x", `${-24 + Math.random() * 48}px`);
          particle.style.setProperty("--particle-y", `${16 + Math.random() * 26}px`);
          particle.style.setProperty("--particle-r", `${-160 + Math.random() * 320}deg`);
          particle.style.setProperty("--particle-scale", `${0.8 + Math.random() * 0.75}`);
          particle.style.setProperty("--particle-delay", `${index * 10}ms`);
          particle.style.background = colors[index % colors.length];
          const particleSize = 3 + config.particleSize / 16;
          particle.style.width = `${particleSize * (0.85 + Math.random() * 0.35)}px`;
          particle.style.height = `${particleSize * (0.62 + Math.random() * 0.24)}px`;
          host.appendChild(particle);
          window.setTimeout(() => particle.remove(), 760);
        }
      }
    }
  }

  const lastKeyAt = lastPhysicalKeySound.get(input) ?? 0;
  if (performance.now() - lastKeyAt > 90)
    playTypingKeySound(isDelete ? "delete" : isSpace ? "space" : "character", config.typingSound);
}

function playSpellingOutcome(kind: "wrong" | "success", sound: AISettings["typingSound"]) {
  if (sound === "muted") return;
  try {
    const context = ensureTypingAudio();
    const notes = kind === "success" ? [523.25, 659.25, 783.99] : [150, 105];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * (kind === "success" ? 0.075 : 0.055);
      oscillator.type = kind === "success" ? "sine" : "sawtooth";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(kind === "success" ? 0.032 : 0.022, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.12);
    });
  } catch {
    // 音频不可用时不影响检查结果。
  }
}

export default function Page() {
  const [tab, setTab] = useState<AppTab>("today");
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [selectedDay, setSelectedDay] = useState(1);
  const [completedDays, setCompletedDays] = useState<number[]>([]);
  const [completedReviewEntries, setCompletedReviewEntries] = useState<string[]>([]);
  const [activePlanEntry, setActivePlanEntry] = useState<PlanEntry | null>(null);
  const [activeGroup, setActiveGroup] = useState(0);
  const [readingMode, setReadingMode] = useState<"show" | "spell">("show");
  const [readingStartedAt, setReadingStartedAt] = useState(() => Date.now());
  const [spellingAnswers, setSpellingAnswers] = useState<
    Record<string, string>
  >({});
  const [spellingPassed, setSpellingPassed] = useState(false);
  const [spellingScore, setSpellingScore] = useState<number | null>(null);
  const [spellingResults, setSpellingResults] = useState<Record<string, SpellingResult>>({});
  const [hoveredWord, setHoveredWord] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS);
  /** 当前内置词书的词条；切换词书时按需加载，不一次性读取全部词库。 */
  const [vocab, setVocab] = useState<IeltsEntry[]>([]);
  const [vocabLoading, setVocabLoading] = useState(true);
  /** 是否正在后台生成短文（防止重复点击触发多次生成）。 */
  const [generating, setGenerating] = useState(false);
  /** 后台生成完成等结果的通知条。 */
  const [toast, setToast] = useState<Toast | null>(null);
  /** 阅读页右上角的调整意见（重新生成时发给 AI）。 */
  const [adjustmentText, setAdjustmentText] = useState("");
  /** 流式生成进度节流：避免每收到几个字就重渲染一次。 */
  const progressRef = useRef(0);
  const [storageReady, setStorageReady] = useState(false);
  const [activeWordbookId, setActiveWordbookId] = useState("builtin-ielts");
  const activeBuiltinWordbook = getBuiltinWordbook(activeWordbookId);

  const liveCards = useLiveQuery(() => learningDB.cards.toArray(), []);
  const livePacks = useLiveQuery(() => learningDB.packs.toArray(), []);
  const liveAttempts = useLiveQuery(() => learningDB.attempts.toArray(), []);
  const liveKnown = useLiveQuery(() => learningDB.known.toArray(), []);
  const liveWordbooks = useLiveQuery(() => learningDB.wordbooks.toArray(), []);
  const activeWordbookName = useMemo(
    () => activeBuiltinWordbook?.name ?? liveWordbooks?.find((book) => book.id === activeWordbookId)?.name ?? "自定义词书",
    [activeBuiltinWordbook, activeWordbookId, liveWordbooks],
  );
  const cards = useMemo(() => liveCards ?? [], [liveCards]);
  const packs = useMemo(() => livePacks ?? [], [livePacks]);
  const attempts = useMemo(() => liveAttempts ?? [], [liveAttempts]);
  const activePacks = useMemo(
    () => packs.filter((item) => (item.wordbookId ?? "builtin-ielts") === activeWordbookId),
    [activeWordbookId, packs],
  );
  const externalWords = useMemo(() => {
    const book = (liveWordbooks ?? []).find((item) => item.id === EXTERNAL_VOCABULARY_ID);
    return book ? parseExternalWords(book.words) : [];
  }, [liveWordbooks]);
  /** 用户标记为“已经会了”的词元：填词时显示橙色跳过，且不再出现在新短文里。 */
  const knownSet = useMemo(
    () => new Set((liveKnown ?? []).map((entry) => entry.lemma)),
    [liveKnown],
  );
  /** 内置词库与外部积累词库查找表：lemma -> 英文释义。外部词暂无中文也可以先学习。 */
  const mergedVocab = useMemo(() => {
    const entries = [...vocab];
    const existing = new Set(entries.map((entry) => entry.lemma.toLowerCase()));
    for (const lemma of externalWords) {
      if (!existing.has(lemma)) entries.push({ lemma, definition: "" });
    }
    return entries;
  }, [vocab, externalWords]);
  const vocabMap = useMemo(
    () => new Map(mergedVocab.map((entry) => [entry.lemma, entry.definition])),
    [mergedVocab],
  );
  /** 已学（出现在词卡或已生成短文里）的词元，用于从词库顺序取下一组。 */
  const studiedLemmas = useMemo(() => {
    const studied = new Set<string>();
    for (const card of cards) studied.add(card.lemma.toLowerCase());
    for (const pack of activePacks)
      for (const use of pack.targetWords) studied.add(use.lemma.toLowerCase());
    return studied;
  }, [activePacks, cards]);
  /** 外部积累词优先，其余从内置词库随机抽取并分散首字母。 */
  const nextLibraryWords = useMemo(() => {
    const excluded = new Set([...studiedLemmas, ...knownSet]);
    const priority = externalWords.filter((word) => !excluded.has(word));
    const remainingCount = Math.max(0, aiSettings.dailyNewWords - priority.length);
    const fallbackExcluded = new Set([...excluded, ...priority]);
    const fallback = pickDiverseVocabulary(mergedVocab, fallbackExcluded, remainingCount);
    return [...priority.slice(0, aiSettings.dailyNewWords), ...fallback].slice(
      0,
      aiSettings.dailyNewWords,
    );
  }, [mergedVocab, externalWords, studiedLemmas, knownSet, aiSettings.dailyNewWords]);
  const totalDays = Math.max(1, aiSettings.targetDays);
  const dayGroups = useMemo(() => buildDayGroups(totalDays), [totalDays]);
  const reviewColumns = useMemo(
    () => buildReviewColumns(totalDays),
    [totalDays],
  );
  const nextDay =
    Array.from({ length: totalDays }, (_, index) => index + 1).find(
      (day) => !completedDays.includes(day),
    ) ?? totalDays;
  const accuracy = attempts.length
    ? Math.round(
        (attempts.filter((a) => a.correct).length / attempts.length) * 100,
      )
    : 0;

  const wordbookPlanFor = useCallback((book: UserWordbook | undefined, vocabularyCount: number, settings = aiSettings): WordbookPlan => {
    const fallbackTotal = Math.max(1, vocabularyCount || settings.totalVocabulary);
    const dailyNewWords = Math.max(1, book?.plan?.dailyNewWords ?? settings.dailyNewWords);
    const totalVocabulary = Math.max(1, book?.plan?.totalVocabulary ?? fallbackTotal);
    return {
      totalVocabulary,
      dailyNewWords,
      targetDays: Math.max(1, book?.plan?.targetDays ?? Math.ceil(totalVocabulary / dailyNewWords)),
      completedDays: [...new Set(book?.plan?.completedDays ?? [])].sort((a, b) => a - b),
      completedReviewEntries: [...new Set(book?.plan?.completedReviewEntries ?? [])],
      updatedAt: book?.plan?.updatedAt ?? isoNow(),
    };
  }, [aiSettings]);

  const persistWordbookPlan = useCallback(async (
    plan: Partial<WordbookPlan>,
    settings = aiSettings,
  ) => {
    const current = await learningDB.wordbooks.get(activeWordbookId);
    const base = wordbookPlanFor(current, isBuiltinWordbookId(activeWordbookId) ? mergedVocab.length : parseExternalWords(current?.words ?? "").length, settings);
    const nextPlan: WordbookPlan = { ...base, ...plan, updatedAt: isoNow() };
    const book: UserWordbook = current ?? {
      id: activeWordbookId,
      name: activeBuiltinWordbook?.name ?? "自定义词书",
      words: "",
      createdAt: isoNow(),
    };
    await learningDB.wordbooks.put({ ...book, plan: nextPlan });
    scheduleServerSnapshotSync();
  }, [activeWordbookId, activeBuiltinWordbook, aiSettings, mergedVocab.length, wordbookPlanFor]);

  const selectWordbook = useCallback(async (id: string, vocabularyCount: number) => {
    const current = await learningDB.wordbooks.get(id);
    const plan = wordbookPlanFor(current, vocabularyCount);
    const book: UserWordbook = current ?? {
      id,
      name: getBuiltinWordbook(id)?.name ?? "自定义词书",
      words: "",
      createdAt: isoNow(),
    };
    await learningDB.wordbooks.put({ ...book, plan });
    setActiveWordbookId(id);
    window.localStorage.setItem("ielts-context-active-wordbook", id);
    // 切换词书后，旧词书的阅读文章和当前任务不能继续留在界面上。
    // 否则计划已经切换，阅读页仍会显示旧的“IELTS 词库 · 第 N 天”。
    setPack(null);
    setActivePlanEntry(null);
    setSpellingAnswers({});
    setSpellingPassed(false);
    setSpellingScore(null);
    setSpellingResults({});
    setFeedback(null);
    setAiSettings((previous) => ({
      ...previous,
      totalVocabulary: plan.totalVocabulary,
      dailyNewWords: plan.dailyNewWords,
      targetDays: plan.targetDays,
    }));
    setCompletedDays(plan.completedDays);
    setCompletedReviewEntries(plan.completedReviewEntries);
    const nextDay = Array.from({ length: plan.targetDays }, (_, index) => index + 1)
      .find((day) => !plan.completedDays.includes(day)) ?? plan.targetDays;
    setSelectedDay(nextDay);
    window.localStorage.setItem("ielts-context-completed-days", JSON.stringify(plan.completedDays));
    window.localStorage.setItem("ielts-context-completed-reviews", JSON.stringify(plan.completedReviewEntries));
  }, [wordbookPlanFor]);

  const wordbookInitRef = useRef(false);
  useEffect(() => {
    if (!storageReady || wordbookInitRef.current || liveWordbooks === undefined) return;
    wordbookInitRef.current = true;
    const storedId = window.localStorage.getItem("ielts-context-active-wordbook");
    const storedBook = storedId && liveWordbooks.some((book) => book.id === storedId) ? storedId : null;
    const initialId = storedBook ?? (storedId && isBuiltinWordbookId(storedId) ? storedId : "builtin-ielts");
    const builtin = getBuiltinWordbook(initialId);
    const custom = liveWordbooks.find((book) => book.id === initialId);
    const vocabularyCount = builtin?.wordCount ?? (custom ? parseExternalWords(custom.words).length : mergedVocab.length || 4000);
    void selectWordbook(initialId, vocabularyCount);
  }, [liveWordbooks, mergedVocab.length, selectWordbook, storageReady]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = await readLocalSnapshot();
      const remote = await readServerSnapshot();
      const remoteHasData = Object.values(remote ?? {}).some((collection) => collection.length > 0);
      const localHasData = Object.values(local).some((collection) => collection.length > 0);
      if (remoteHasData) await replaceLocalSnapshot(remote!);
      else if (localHasData) await writeServerSnapshot(local);
      if (!cancelled) setStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    // 清除旧的“演示短文”：第 1 天应使用 AI 生成的正确短文，而不是固定模板。
    void learningDB.packs
      .toArray()
      .then((allPacks) =>
        Promise.all(
          allPacks
            .filter(
              (p) =>
                p.generatedBy === "local" &&
                p.planDay === 1 &&
                p.targetWords.length === DEMO_LEMMAS.length &&
                DEMO_LEMMAS.every((lemma) =>
                  p.targetWords.some((word) => word.lemma === lemma),
                ),
            )
            .map((p) => learningDB.packs.delete(p.id)),
        ),
      )
      .then(() => scheduleServerSnapshotSync());
  }, [activeWordbookId]);
  useEffect(() => {
    // 移除旧版本“随机复习体验”写入的演示数据，避免它覆盖计划日的正式语境短文。
    void learningDB
      .transaction("rw", [learningDB.cards, learningDB.packs], async () => {
        const legacyPacks = await learningDB.packs
          .where("id")
          .startsWith("review_demo_pack_")
          .primaryKeys();
        const legacyCards = await learningDB.cards
          .where("id")
          .startsWith("review_demo_")
          .primaryKeys();
        if (legacyPacks.length) await learningDB.packs.bulkDelete(legacyPacks);
        if (legacyCards.length) await learningDB.cards.bulkDelete(legacyCards);
        return legacyPacks.length > 0 || legacyCards.length > 0;
      })
      .then((removed) => {
        if (removed) scheduleServerSnapshotSync();
      });
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!isBuiltinWordbookId(activeWordbookId)) {
      setVocab([]);
      setVocabLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setVocabLoading(true);
    void loadWordbookVocab(activeWordbookId)
      .then((entries) => {
        if (cancelled) return;
        setVocab(entries);
        setVocabLoading(false);
      })
      .catch(() => {
        if (!cancelled) setVocabLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWordbookId]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("reset-study") !== "1") return;
    url.searchParams.delete("reset-study");
    void resetStudyProgress()
      .then(() => persistWordbookPlan({ completedDays: [], completedReviewEntries: [] }))
      .then(() => {
        window.localStorage.removeItem("ielts-context-completed-days");
        window.localStorage.removeItem("ielts-context-completed-reviews");
        setPack(null);
        setSelectedDay(1);
        setCompletedDays([]);
        setCompletedReviewEntries([]);
        setToast({ message: "每日短文和学习进度已清空，可以从第 1 天重新测试。" });
      })
      .catch(() => setToast({ message: "本地学习数据重置失败，请刷新后重试。" }))
      .finally(() => window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`));
  }, [persistWordbookPlan]);
  useEffect(() => {
    void ensurePersistentStorage();
    void flushPendingEvidence();
  }, []);
  useEffect(() => {
    const stored = window.localStorage.getItem("ielts-context-completed-days");
    if (stored) setCompletedDays(JSON.parse(stored) as number[]);
    const reviews = window.localStorage.getItem("ielts-context-completed-reviews");
    if (reviews) setCompletedReviewEntries(JSON.parse(reviews) as string[]);
  }, []);
  useEffect(() => {
    const stored = window.localStorage.getItem("ielts-context-ai-settings");
    const sessionApiKey =
      window.sessionStorage.getItem("ielts-context-api-key") ?? "";
    if (stored) {
      try {
        const saved = JSON.parse(stored) as Partial<AISettings>;
        const totalVocabulary = saved.totalVocabulary ?? DEFAULT_AI_SETTINGS.totalVocabulary;
        const dailyNewWords = saved.dailyNewWords ?? DEFAULT_AI_SETTINGS.dailyNewWords;
        setAiSettings({
          ...DEFAULT_AI_SETTINGS,
          ...saved,
          totalVocabulary,
          dailyNewWords,
          targetDays: Math.max(1, Math.ceil(totalVocabulary / dailyNewWords)),
          apiKey: sessionApiKey,
        });
      } catch {
        /* keep defaults */
      }
    }
  }, []);
  useEffect(() => {
    if (activeGroup >= dayGroups.length)
      setActiveGroup(Math.max(0, dayGroups.length - 1));
  }, [activeGroup, dayGroups.length]);

  /** 打开某一天：显示该天专属短文（取最新一篇，没有则引导去导入生成）。 */
  const openDay = (entry: PlanEntry) => {
    const day = entry.sourceDay;
    if (day < 1 || day > totalDays) return;
    const dayPack =
      [...packs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .find(
          (pack) =>
            pack.planDay === day &&
            (pack.wordbookId ?? "builtin-ielts") === activeWordbookId &&
            !pack.id.startsWith("review_demo_pack_") &&
            pack.title !== "随机复习体验",
        ) ?? null;
    setPack(dayPack);
    startReading(day, entry.kind === "review" ? "spell" : "show");
    setActivePlanEntry(entry);
    setTab("read");
  };

  /**
   * 用给定词列表在后台生成当天短文并归档到 selectedDay。
   * 生成期间按钮显示“正在生成请稍后…”，完成后弹出通知条（可一键查看），
   * 不会打断用户当前所在的页面。
   */
  const generatePackFor = async (
    words: string[],
    source: "paste" | "library",
  ) => {
    if (generating) return; // 防止重复点击触发多次生成
    const cleaned = [
      ...new Set(
        words
          .map((word) => word.trim().toLowerCase())
          .filter((word) => /^[a-z][a-z'-]*$/.test(word)),
      ),
    ];
    const droppedKnown = cleaned.filter((word) => knownSet.has(word)).length;
    // 已标记“会了”的词不再出现在新短文里。
    const selectedWords = cleaned
      .filter((word) => !knownSet.has(word))
      .slice(0, aiSettings.dailyNewWords);
    if (!selectedWords.length) {
      setToast({
        message:
          droppedKnown > 0
            ? "这些词你都已标记为会了，无需生成短文。"
            : "没有可生成的词，请检查词表。",
      });
      return;
    }
    const targetDay = selectedDay;
    setGenerating(true);
    setUploadStatus(
      `正在生成第 ${targetDay} 天短文（AI 生成中）${droppedKnown > 0 ? `，已排除 ${droppedKnown} 个已会的词` : ""}，请稍后…`,
    );
    progressRef.current = 0;
    setToast({ message: `正在生成第 ${targetDay} 天短文（AI 生成中）…` });
    const onProgress = (chars: number) => {
      if (chars - progressRef.current >= 20) {
        progressRef.current = chars;
        setToast({
          message: `正在生成第 ${targetDay} 天短文（AI 生成中）… 已生成 ${chars} 字`,
        });
      }
    };
    let generated: Awaited<ReturnType<typeof fetchGeneratedPack>>;
    try {
      generated = await fetchGeneratedPack(selectedWords, "", onProgress);
    } catch {
      setToast({ message: `第 ${targetDay} 天短文生成超时或中断，已恢复按钮，可以稍后重试。` });
      setGenerating(false);
      return;
    }
    const { passage, translation, meanings, keySentence, passageMeta, generatedBy, modeNote } = generated;
    let nextPackValue: ContextPack;
    try {
      nextPackValue = makePack(
        selectedWords,
        passage,
        undefined,
        aiSettings.dailyNewWords,
        {
          translation,
          meanings,
          keySentence,
          generatedBy,
          planDay: targetDay,
          wordbookId: activeWordbookId,
          title:
            source === "library"
              ? `${activeWordbookName} · 第 ${targetDay} 天`
              : undefined,
          topic: passageMeta ? `${passageMeta.contentType} · ${passageMeta.sceneTopic}` : source === "library" ? `${activeWordbookName}词书` : undefined,
        },
      );
      await replacePackForDay(targetDay, nextPackValue, activeWordbookId);
      setPack(nextPackValue);
      setUploadStatus(modeNote);
      setToast({
        message: `第 ${targetDay} 天短文已生成（${generatedBy === "ai" ? "AI" : "本地模板"}）${generatedBy === "local" ? "，可稍后配置 AI 重新生成" : ""}。`,
        action: {
          label: "查看",
          onClick: () => {
            setPack(nextPackValue);
            startReading(targetDay);
            setTab("read");
          },
        },
      });
    } catch {
      setToast({ message: `第 ${targetDay} 天短文生成失败，请稍后重试。` });
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 调用生成接口（可带调整意见），返回短文、翻译、释义与来源标记。
   * 接口为流式响应：收到第一个字即可回调进度；重复目标词自动带 fixDuplicate 重写一次。
   * AI 不可用或失败时回退本地模板；本地模式用内置词库英文释义兜底。
   */
  const fetchGeneratedPack = async (
    words: string[],
    adjustment: string,
    onProgress?: (chars: number) => void,
  ): Promise<{
    passage: string;
    translation?: string;
    meanings: Record<
      string,
      { meaningZh: string; translationZh?: string; phonetic?: string; morphology?: string; partOfSpeech: string; collocation: string; phraseFrame?: string; rhetoricalFunction?: string; register?: string; confusables?: string[] }
    >;
    keySentence?: import("@/lib/types").KeySentence;
    passageMeta?: { contentType: string; sceneTopic: string };
    generatedBy: "ai" | "local";
    modeNote: string;
  }> => {
    let passage = buildLocalPassage(words, aiSettings.planning);
    let translation: string | undefined;
    let meanings:
      | Record<
          string,
          { meaningZh: string; translationZh?: string; phonetic?: string; morphology?: string; partOfSpeech: string; collocation: string; phraseFrame?: string; rhetoricalFunction?: string; register?: string; confusables?: string[] }
        >
      | undefined;
    let generatedBy: "ai" | "local" = "local";
    let modeNote = "本地模板短文（未配置 AI 或生成失败，可稍后重试）";

    const first = await streamAIText(words, adjustment, "", onProgress);
    let parsed = first.text ? parseContextPack(first.text, words) : undefined;
    if (parsed?.passage) {
      // 质量门：重复目标词、明显超长、漏词、或逐词中文翻译标注不完整时重写。
      // 翻译标注失败时最多补一次，避免一次生成被重复请求拖到很久。
      for (let attempt = 0; attempt < 1; attempt++) {
        const candidate = parsed.passage;
        if (!candidate) break;
        const duplicated = findDuplicateTarget(candidate, words);
        const tooLong = countEnglishWords(candidate) > 110;
        const missing = findMissingTargets(candidate, words);
        const missingAnnotations = findMissingTranslationAnnotations(parsed.translation, parsed.meanings, words);
        if (!duplicated && !tooLong && missing.length === 0 && missingAnnotations.length === 0) break;
        const retryParts = [
          adjustment,
          tooLong ? "上一版明显过长。请写成约 75-95 个英文词、4-6 句，最多不超过 110 词。" : "",
          missing.length ? `上一版遗漏或改变了这些目标词的词形：${missing.join(", ")}。正文必须逐字使用其原形各一次，保证每个词都能生成一个填词框。` : "",
          missingAnnotations.length
            ? attempt === 0
              ? `上一版中文翻译或逐词标注不完整，以下词的标注无法在 translation 中逐字定位：${missingAnnotations.join("、")}。请打开你刚写的 translation，找到每个词对应的连续中文片段并原样复制为 translationZh（例如 translation 中是“准确读数”，translationZh 就写“准确读数”，不要写词典义“准确的”）。`
              : `翻译仍不完整：再次核对 ${missingAnnotations.join("、")}。先写完整中文翻译，再从翻译中逐字复制每个目标词对应的连续片段作为 translationZh；禁止改写、增删字词、加括号或引号、换用同义词。`
            : "",
          "将目标词分散到自然句子中，禁止用逗号连续罗列。",
        ].filter(Boolean).join("；");
        const retry = await streamAIText(words, retryParts, duplicated ?? "", onProgress);
        if (!retry.text) break;
        const retried = parseContextPack(retry.text, words);
        if (!retried.passage) break;
        parsed = retried;
      }
      const candidatePassage = parsed.passage;
      const isCompact = Boolean(candidatePassage) && countEnglishWords(candidatePassage ?? "") <= 110;
      const hasNoDuplicate = Boolean(candidatePassage) && !findDuplicateTarget(candidatePassage ?? "", words);
      const hasFullCoverage = Boolean(candidatePassage) && findMissingTargets(candidatePassage ?? "", words).length === 0;
      const hasAnnotatedTranslation = hasCompleteTranslationAnnotations(parsed.translation, parsed.meanings, words);
      if (candidatePassage && isCompact && hasNoDuplicate && hasFullCoverage && hasAnnotatedTranslation) {
        passage = candidatePassage;
        translation = parsed.translation;
      }
      if (isCompact && hasNoDuplicate && hasFullCoverage && hasAnnotatedTranslation && parsed.meanings?.length) {
        meanings = Object.fromEntries(
          parsed.meanings.map((item) => [
            item.lemma.toLowerCase(),
            {
                meaningZh: item.meaningZh,
                translationZh: item.translationZh,
                phonetic: item.phonetic,
                morphology: item.morphology,
              partOfSpeech: item.partOfSpeech,
              collocation: item.collocation,
              phraseFrame: item.phraseFrame,
              rhetoricalFunction: item.rhetoricalFunction,
              register: item.register,
              confusables: item.confusables,
            },
          ]),
        );
      }
      if (isCompact && hasNoDuplicate && hasFullCoverage && hasAnnotatedTranslation) {
        generatedBy = "ai";
        modeNote = `AI 已生成短文、翻译与逐词释义 · ${countEnglishWords(passage)} 词`;
      } else {
        modeNote = "AI 两次输出仍有超长、重复、漏词或翻译标注不完整，已改用本地场景短文";
      }
    } else if (first.warning) {
      modeNote = first.warning;
    }
    // 本地模式无法可靠提供中文、音标和词根信息时明确留空，不把英文释义冒充中文。
    if (!meanings) {
      meanings = Object.fromEntries(
        words.map((lemma) => {
          return [
            lemma,
            {
              meaningZh: "暂无中文释义（请使用 AI 生成）",
              phonetic: undefined,
              morphology: undefined,
              partOfSpeech: "word",
              collocation: `use ${lemma} in context`,
            },
          ];
        }),
      );
    }
    return { passage, translation, meanings, keySentence: parsed?.keySentence, passageMeta: parsed?.passageMeta, generatedBy, modeNote };
  };

  /**
   * 流式调用生成接口并累积文本。接口返回 text/event-stream 时边收边转发；
   * 返回 JSON（本地回退）时携带 warning。fixDuplicate 用于告诉服务端重写。
   */
  const streamAIText = async (
    words: string[],
    adjustment: string,
    fixDuplicate: string,
    onProgress?: (chars: number) => void,
  ): Promise<{ text: string | null; warning?: string }> => {
    try {
      const response = await fetch("/api/context-packs/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          words,
          planning: aiSettings.planning,
          adjustment: adjustment || undefined,
          fixDuplicate: fixDuplicate || undefined,
          model: aiSettings.model,
          baseUrl: aiSettings.baseUrl,
          apiKey: aiSettings.apiKey,
          protocol: aiSettings.protocol,
          extraHeaders: aiSettings.headers,
        }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const result = (await response.json()) as { warning?: string };
        return { text: null, warning: result.warning };
      }
      const reader = response.body?.getReader();
      if (!reader) return { text: null, warning: "无法读取生成结果，已回退本地短文。" };
      const decoder = new TextDecoder();
      let full = "";
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as { type?: string; text?: string };
            if (msg.type === "delta") {
              full += msg.text ?? "";
              onProgress?.(full.length);
            } else if (msg.type === "done") {
              full = msg.text ?? full;
            }
          } catch {
            /* 忽略 keepalive 等非 JSON 行 */
          }
        }
      }
      return { text: full.trim() || null };
    } catch {
      return { text: null, warning: "AI 服务不可用，已回退本地短文。" };
    }
  };

  /** 按用户调整意见重新生成当天短文：替换原文，保留同一天的词表（排除已会的词）。 */
  const regeneratePack = async () => {
    if (!pack || generating) return;
    const adjustment = adjustmentText.trim();
    if (!adjustment) {
      setToast({
        message: "请先填写调整意见，例如：换成科技话题、缩短到 60 词、换个故事场景。",
      });
      return;
    }
    const targetDay = pack.planDay ?? selectedDay;
    const words = pack.targetWords
      .map((word) => word.lemma)
      .filter((word) => !knownSet.has(word));
    if (!words.length) {
      setToast({ message: "这篇短文的目标词都已标记为会了，无需重新生成。" });
      return;
    }
    setGenerating(true);
    setUploadStatus(`正在按你的意见重新生成第 ${targetDay} 天短文（AI 生成中），请稍后…`);
    progressRef.current = 0;
    setToast({ message: `正在按你的意见重新生成第 ${targetDay} 天短文（AI 生成中）…` });
    const onProgress = (chars: number) => {
      if (chars - progressRef.current >= 20) {
        progressRef.current = chars;
        setToast({
          message: `正在按你的意见重新生成第 ${targetDay} 天短文（AI 生成中）… 已生成 ${chars} 字`,
        });
      }
    };
    let generated: Awaited<ReturnType<typeof fetchGeneratedPack>>;
    try {
      generated = await fetchGeneratedPack(words, adjustment, onProgress);
    } catch {
      setToast({ message: `第 ${targetDay} 天短文重新生成超时或中断，已恢复按钮，可以稍后重试。` });
      setGenerating(false);
      return;
    }
    const { passage, translation, meanings, keySentence, passageMeta, generatedBy, modeNote } = generated;
    try {
      // 替换该天旧短文，避免同一学习日出现多份版本。
      const nextPackValue = makePack(
        words,
        passage,
        undefined,
        aiSettings.dailyNewWords,
        {
          translation,
          meanings,
          keySentence,
          generatedBy,
          planDay: targetDay,
          wordbookId: activeWordbookId,
          title: `${activeWordbookName} · 第 ${targetDay} 天`,
          topic: passageMeta ? `${passageMeta.contentType} · ${passageMeta.sceneTopic}` : pack.topic,
        },
      );
      await replacePackForDay(targetDay, nextPackValue, activeWordbookId);
      setPack(nextPackValue);
      setAdjustmentText("");
      setSpellingAnswers({});
      setSpellingPassed(false);
      setSpellingScore(null);
      setSpellingResults({});
      setFeedback(null);
      setUploadStatus(modeNote);
      setToast({ message: `已按你的意见重新生成第 ${targetDay} 天短文（${generatedBy === "ai" ? "AI" : "本地模板"}）。` });
    } catch {
      setToast({ message: `第 ${targetDay} 天短文重新生成失败，请稍后重试。` });
    } finally {
      setGenerating(false);
    }
  };

  /** 从当前内置词书取下一组未学过的词，直接生成当天短文。 */
  const generateLibraryPack = async () => {
    if (!nextLibraryWords.length) {
      setUploadStatus(
        vocabLoading
          ? `${activeWordbookName}词库加载中，请稍候…`
          : "可用词库中没有未学过的词了；可在设置中调整每日新词，或加入外部词汇。",
      );
      return;
    }
    await generatePackFor(nextLibraryWords, "library");
  };

  const applySettings = (nextSettings: AISettings) => {
    setAiSettings(nextSettings);
    void persistWordbookPlan({
      totalVocabulary: nextSettings.totalVocabulary,
      dailyNewWords: nextSettings.dailyNewWords,
      targetDays: nextSettings.targetDays,
    }, nextSettings);
  };

  /** 构建一条学习证据（任务结果 → 不可变记录，增量写入 SQLite）。 */
  const makeEvidence = (
    lemma: string,
    dimension: CapabilityDimension,
    taskType: string,
    correct: boolean,
    score: number,
    opts: { hintLevel?: HintLevel; confidence?: number } = {},
  ): LearningEvidence => {
    const now = Date.now();
    return {
      id: `evt_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      cardId: `card_${lemma}`,
      dimension,
      taskType,
      correct,
      score,
      confidence: opts.confidence ?? (correct ? 3 : 2),
      hintLevel: opts.hintLevel ?? 0,
      elapsedMs: Math.max(0, now - readingStartedAt),
      contextId: pack?.id,
      contextTopic: pack?.topic,
      evaluator: "local",
      createdAt: new Date(now).toISOString(),
    };
  };

  /**
   * 记录一批学习证据：增量写入 SQLite，并把客观任务结果应用到已存在词卡的能力状态。
   * 曝光（read）与主观跳过（skip-known）只记录、不参与能力计算（避免“看过=掌握”）。
   */
  const recordEvidenceBatch = async (events: LearningEvidence[]) => {
    if (!events.length) return;
    void appendEvidenceServer(events);
    for (const event of events) {
      if (event.taskType === "read" || event.taskType === "skip-known") continue;
      const card = await learningDB.cards.get(event.cardId);
      if (!card) continue;
      const capabilities = capabilitiesOf(card);
      const next = applyDimensionEvidence(
        capabilities[event.dimension],
        event,
        new Date(event.createdAt).getTime(),
      );
      await learningDB.cards.update(card.id, {
        capabilities: { ...capabilities, [event.dimension]: next },
        updatedAt: isoNow(),
      });
    }
  };

  /** 切换一个词的“已经会了”状态：橙色跳过，不再出现在新短文。 */
  const toggleSkipWord = async (lemma: string) => {
    const nowKnown = await toggleWordKnown(lemma);
    // 主观“会了”证据：只记录，不作为客观掌握依据。
    if (nowKnown) {
      const event = makeEvidence(lemma, "formRecognition", "skip-known", true, 100, {
        hintLevel: 0,
        confidence: 5,
      });
      void appendEvidenceServer([event]);
    }
  };

  const startReading = (day: number, initialMode: "show" | "spell" = "show") => {
    if (day < 1 || day > totalDays) return;
    setSelectedDay(day);
    setActivePlanEntry(null);
    setReadingStartedAt(Date.now());
    setReadingMode(initialMode);
    setSpellingAnswers({});
    setSpellingPassed(false);
    setSpellingScore(null);
    setSpellingResults({});
    setHoveredWord(null);
    setFeedback(null);
    setAdjustmentText("");
  };

  const finishDay = async () => {
    if (!pack || !spellingPassed) return;
    for (const use of pack.targetWords) {
      // 已标记“会了”的词不进入复习队列。
      if (knownSet.has(use.lemma)) continue;
      const existing = await learningDB.cards.get(`card_${use.lemma}`);
      const card: WordCard = existing ?? {
        id: `card_${use.lemma}`,
        lemma: use.lemma,
        definitionEn: vocabMap.get(use.lemma) ?? DEFINITIONS[use.lemma],
        meaningZh: use.meaningZh,
        partOfSpeech: use.partOfSpeech,
        collocations: [use.collocation],
        packIds: [],
        stage: "new",
        masteryLevel: 0,
        schedule: {
          difficulty: 5,
          stability: 0.5,
          lastReviewedAt: null,
          nextDueAt: isoNow(),
        },
        correct: 0,
        lapses: 0,
        hints: 0,
        dimensions: {
          recognition: 0,
          recall: 0,
          collocation: 0,
          reading: 0,
          transfer: 0,
        },
        updatedAt: isoNow(),
      };
      card.packIds = [...new Set([...card.packIds, pack.id])];
      card.planDay = selectedDay;
      card.sourceTitle = pack.title;
      card.definitionEn ??= vocabMap.get(use.lemma) ?? DEFINITIONS[use.lemma];
      if (!existing) {
        card.stage = "encountered";
        card.masteryLevel = 1;
        // 用本次会话的客观拼写结果初始化多维能力状态（完成文章不等于掌握：
        // 答对只按“使用提示后正确”小幅提升，答错则拼写维度下降；其余维度保持基线）。
        const capabilities = Object.fromEntries(
          CAPABILITY_DIMENSIONS.map((dimension) => [dimension, emptyDimensionState()]),
        ) as Record<CapabilityDimension, ReturnType<typeof emptyDimensionState>>;
        const now = Date.now();
        const spellResult = spellingResults[use.lemma];
        if (spellResult === "correct") {
          capabilities.spelling = applyDimensionEvidence(
            capabilities.spelling,
            { correct: true, hintLevel: 2, confidence: 4, elapsedMs: 0 },
            now,
          );
        } else if (spellResult === "wrong") {
          capabilities.spelling = applyDimensionEvidence(
            capabilities.spelling,
            { correct: false, hintLevel: 2, confidence: 1, elapsedMs: 0 },
            now,
          );
        }
        card.capabilities = capabilities;
      }
      card.updatedAt = isoNow();
      await learningDB.cards.put(card);
    }
    // 阅读曝光证据：只记录（任务类型 read），不提升任何能力维度。
    const exposureEvents = pack.targetWords
      .filter((use) => !knownSet.has(use.lemma))
      .map((use) =>
        makeEvidence(use.lemma, "formRecognition", "read", true, 40, {
          hintLevel: 0,
          confidence: 2,
        }),
      );
    void recordEvidenceBatch(exposureEvents);
    const completedAt = new Date();
    await learningDB.sessions.add({
      id: `session_${completedAt.getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      sourceDay: selectedDay,
      scheduleDay: activePlanEntry?.scheduleDay ?? selectedDay,
      kind: activePlanEntry?.kind ?? "learn",
      columnLabel: activePlanEntry?.columnLabel ?? "First",
      packId: pack.id,
      wordCount: pack.targetWords.length,
      startedAt: new Date(readingStartedAt).toISOString(),
      completedAt: completedAt.toISOString(),
      durationSeconds: Math.max(1, Math.round((completedAt.getTime() - readingStartedAt) / 1000)),
    });
    scheduleServerSnapshotSync();
    if (activePlanEntry?.kind === "review") {
      const updatedReviews = [
        ...new Set([...completedReviewEntries, planEntryKey(activePlanEntry)]),
      ];
      setCompletedReviewEntries(updatedReviews);
      await persistWordbookPlan({ completedReviewEntries: updatedReviews });
      window.localStorage.setItem(
        "ielts-context-completed-reviews",
        JSON.stringify(updatedReviews),
      );
    } else {
      const updated = [...new Set([...completedDays, selectedDay])].sort(
        (a, b) => a - b,
      );
      setCompletedDays(updated);
      await persistWordbookPlan({ completedDays: updated });
      window.localStorage.setItem(
        "ielts-context-completed-days",
        JSON.stringify(updated),
      );
    }
    setActivePlanEntry(null);
    setTab("today");
  };

  const checkSpelling = () => {
    if (!pack) return;
    // 已标记为“会了”的词不参与填词检查（橙色跳过）。
    const checkable = pack.targetWords.filter(
      (word) => !knownSet.has(word.lemma),
    );
    const skippedCount = pack.targetWords.length - checkable.length;
    const correct = checkable.filter(
      (word) =>
        spellingAnswers[word.lemma]?.trim().toLowerCase() ===
        word.lemma.toLowerCase(),
    ).length;
    const results = Object.fromEntries(
      checkable.map((word) => [
        word.lemma,
        spellingAnswers[word.lemma]?.trim().toLowerCase() === word.lemma.toLowerCase()
          ? "correct"
          : "wrong",
      ]),
    ) as Record<string, SpellingResult>;
    setSpellingResults(results);
    setSpellingScore(correct);
    setSpellingPassed(correct === checkable.length);
    // 学习证据：每个可填词生成一条拼写证据（正确/错误分别记录；填词框旁有中文提示，
    // 因此归为“使用提示后”的结果，hintLevel=2，不记为无提示独立掌握）。
    const evidence = checkable.map((word) => {
      const ok = results[word.lemma] === "correct";
      return makeEvidence(word.lemma, "spelling", "spell", ok, ok ? 100 : 0, {
        hintLevel: 2,
        confidence: ok ? 4 : 1,
      });
    });
    void recordEvidenceBatch(evidence);
    window.requestAnimationFrame(() => {
      if (correct === checkable.length) {
        playSpellingOutcome("success", aiSettings.typingSound);
      } else {
        playSpellingOutcome("wrong", aiSettings.typingSound);
        document.querySelectorAll<HTMLInputElement>('.inline-spell input[data-spelling-result="wrong"]').forEach((input) => {
          input.style.setProperty("--typing-shake", `${1 + aiSettings.typingShake / 14}px`);
          input.classList.remove("spelling-error-shake");
          void input.offsetWidth;
          input.classList.add("spelling-error-shake");
        });
      }
    });
    setFeedback(
      checkable.length === 0
        ? "这些词都已标记为会了，可以完成今天的学习。"
        : correct === checkable.length
          ? skippedCount > 0
            ? `已跳过 ${skippedCount} 个已会的词；其余全部正确，可以完成今天的学习。`
            : "全部拼写正确，可以完成今天的学习。"
          : `已答对 ${correct}/${checkable.length}${skippedCount ? `（已跳过 ${skippedCount} 个）` : ""}，再检查带标记的词。`,
    );
  };

  const exportLearningData = async () => {
    const [exportCards, exportPacks, exportAttempts, exportKnown, exportWordbooks, exportSessions] = await Promise.all([
      learningDB.cards.toArray(),
      learningDB.packs.toArray(),
      learningDB.attempts.toArray(),
      learningDB.known.toArray(),
      learningDB.wordbooks.toArray(),
      learningDB.sessions.toArray(),
    ]);
    const { apiKey: _apiKey, ...safeSettings } = aiSettings;
    void _apiKey;
    const payload = {
      format: "ielts-context-memory",
      version: 2,
      exportedAt: isoNow(),
      settings: safeSettings,
      completedDays,
      completedReviewEntries,
      cards: exportCards,
      packs: exportPacks,
      attempts: exportAttempts,
      knownWords: exportKnown,
      wordbooks: exportWordbooks,
      sessions: exportSessions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `context-memory-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const resetApplication = async () => {
    await resetEntireSystem();
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith("ielts-context-")) window.localStorage.removeItem(key);
    }
    window.sessionStorage.removeItem("ielts-context-api-key");
    setAiSettings(DEFAULT_AI_SETTINGS);
    setPack(null);
    setSelectedDay(1);
    setCompletedDays([]);
    setCompletedReviewEntries([]);
    setActivePlanEntry(null);
    setActiveGroup(0);
    setUploadStatus(null);
    setSpellingAnswers({});
    setSpellingResults({});
    setFeedback(null);
    setTab("today");
    setToast({ message: "系统已完全重置，所有学习日均恢复为未生成状态。" });
  };

  if (!storageReady) {
    return (
      <main className="shell" id="main-content">
        <div className="app-frame">
          <section className="page-view panel review-empty storage-loading" role="status" aria-live="polite">
            <span className="review-empty-mark" aria-hidden="true">·</span>
            <h2>正在打开本地学习数据</h2>
            <p className="lede" style={{ marginTop: 8 }}>正在连接项目数据库，词书和复习记录不会只依赖浏览器。</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className={`shell ${tab === "read" ? "is-reading" : ""}`} id="main-content">
      <div className={`app-frame ${tab === "read" ? "reading-active" : ""}`}>
        {tab !== "read" && <header className="topbar">
          <div className="brand">
            <Image
              className="brand-logo"
              src="/brand/context-memory-logo.png"
              alt=""
              width={30}
              height={30}
              priority
            />
            <strong>语境记忆</strong>
            <span>Context Memory</span>
          </div>
          <div className="topbar-actions">
            <span className="topbar-note">按计划逐日学习，短文与词卡保存在本机</span>
          </div>
        </header>}
        {tab !== "read" && <nav className="nav" aria-label="主导航">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>}
        {tab === "today" && (
          <TodayView
            activeWordbookName={activeWordbookName}
            activeGroup={activeGroup}
            setActiveGroup={setActiveGroup}
            dayGroups={dayGroups}
            reviewColumns={reviewColumns}
            totalDays={totalDays}
            completedDays={completedDays}
            completedReviewEntries={completedReviewEntries}
            nextDay={nextDay}
            dailyNewWords={aiSettings.dailyNewWords}
            onOpenDay={openDay}
            cards={cards}
            packs={activePacks}
            accuracy={accuracy}
          />
        )}
        {tab === "import" && (
          <Import
            uploadStatus={uploadStatus}
            onConfirmWordbook={() => setTab("today")}
            activeWordbookId={activeWordbookId}
            onSelectWordbook={selectWordbook}
            externalWordCount={externalWords.length}
          />
        )}
        {tab === "read" && (
          <Reading
            key={pack?.id ?? `empty-${selectedDay}`}
            pack={pack}
            day={selectedDay}
            mode={readingMode}
            setMode={setReadingMode}
            hoveredWord={hoveredWord}
            setHoveredWord={setHoveredWord}
            answers={spellingAnswers}
            setAnswers={(answers) => {
              setSpellingAnswers(answers);
              setSpellingPassed(false);
            }}
            spellingResults={spellingResults}
            setSpellingResults={setSpellingResults}
            typingFeedback={aiSettings}
            spellingPassed={spellingPassed}
            spellingScore={spellingScore}
            feedback={feedback}
            onCheck={checkSpelling}
            onFinish={finishDay}
            onGoImport={() => setTab("import")}
            onGenerateLibrary={generateLibraryPack}
            vocabLoading={vocabLoading}
            generating={generating}
            knownSet={knownSet}
            onToggleSkip={toggleSkipWord}
            adjustment={adjustmentText}
            setAdjustment={setAdjustmentText}
            onRegenerate={regeneratePack}
            definitionOf={(lemma) => vocabMap.get(lemma) ?? DEFINITIONS[lemma]}
            activeWordbookName={activeWordbookName}
            onExit={() => setTab("today")}
          />
        )}
        {tab === "progress" && (
          <ProgressView cards={cards} attempts={attempts} accuracy={accuracy} />
        )}
        {tab === "statistics" && (
          <StatisticsView
            cards={cards}
            attempts={attempts}
            packs={activePacks}
            completedDays={completedDays}
          />
        )}
        {tab === "settings" && (
          <Settings
            settings={aiSettings}
            setSettings={applySettings}
            onExport={exportLearningData}
            onReset={resetApplication}
            libraryCount={mergedVocab.length}
            vocabLoading={vocabLoading}
            activeWordbookName={activeWordbookName}
          />
        )}
        {toast && (
          <div className="toast" role="status" aria-live="polite">
            <span className="toast-message">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  toast.action?.onClick();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              aria-label="关闭通知"
              onClick={() => setToast(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

type WordbookRailState = {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
};

function HorizontalWordbookRail({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [railState, setRailState] = useState<WordbookRailState>({
    clientWidth: 0,
    scrollLeft: 0,
    scrollWidth: 0,
  });

  const syncRailState = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    setRailState({
      clientWidth: rail.clientWidth,
      scrollLeft: rail.scrollLeft,
      scrollWidth: rail.scrollWidth,
    });
  }, []);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    syncRailState();
    rail.addEventListener("scroll", syncRailState, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncRailState);
    resizeObserver?.observe(rail);
    return () => {
      rail.removeEventListener("scroll", syncRailState);
      resizeObserver?.disconnect();
    };
  }, [syncRailState, children]);

  const scrollRail = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({
      left: direction * Math.max(rail.clientWidth * 0.72, 240),
      behavior: "smooth",
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rail = railRef.current;
    if (!rail) return;
    dragRef.current = {
      startX: event.clientX,
      startScrollLeft: rail.scrollLeft,
      moved: false,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (!drag || !rail) return;
    const distance = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(distance) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      suppressClickRef.current = true;
      setDragging(true);
      rail.setPointerCapture(event.pointerId);
    }
    rail.scrollLeft = drag.startScrollLeft - distance;
    event.preventDefault();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (rail?.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };

  const maxScroll = Math.max(railState.scrollWidth - railState.clientWidth, 0);

  return (
    <div className="wordbook-rail-wrap">
      <div className="wordbook-rail-shell">
        <button
          type="button"
          className="wordbook-rail-control"
          aria-label={`向左浏览${label}`}
          disabled={railState.scrollLeft <= 1}
          onClick={() => scrollRail(-1)}
        >
          <span aria-hidden="true">←</span>
        </button>
        <div
          ref={railRef}
          className={`wordbook-rail${dragging ? " is-dragging" : ""}`}
          role="region"
          aria-label={label}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClickCapture={handleClickCapture}
        >
          {children}
        </div>
        <button
          type="button"
          className="wordbook-rail-control"
          aria-label={`向右浏览${label}`}
          disabled={railState.scrollLeft >= maxScroll - 1}
          onClick={() => scrollRail(1)}
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
function Import({
  uploadStatus,
  onConfirmWordbook,
  activeWordbookId,
  onSelectWordbook,
  externalWordCount,
}: {
  uploadStatus: string | null;
  onConfirmWordbook: () => void;
  activeWordbookId: string;
  onSelectWordbook: (id: string, wordCount: number) => void | Promise<void>;
  externalWordCount: number;
}) {
  const customWordbooks = useLiveQuery(
    () => learningDB.wordbooks.orderBy("createdAt").toArray(),
    [],
  ) ?? [];
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [newBookName, setNewBookName] = useState("");
  const [newBookWords, setNewBookWords] = useState("");
  const [newBookFile, setNewBookFile] = useState<File | null>(null);
  const [extractingFile, setExtractingFile] = useState(false);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [externalInput, setExternalInput] = useState("");
  const [externalStatus, setExternalStatus] = useState<string | null>(null);
  const activeBuiltinWordbook = getBuiltinWordbook(activeWordbookId);

  const visibleWordbooks = customWordbooks.filter(
    (book) => book.id !== EXTERNAL_VOCABULARY_ID && !isBuiltinWordbookId(book.id),
  );

  const builtinGroups = [
    {
      category: "domestic-exam" as const,
      label: "国内考试",
      description: "大学英语、专四专八与考研词汇",
    },
    {
      category: "international-exam" as const,
      label: "国际考试",
      description: "留学与商科申请常用词汇",
    },
  ];

  const selectCustomWordbook = (book: UserWordbook) => {
    void onSelectWordbook(book.id, parseExternalWords(book.words).length);
  };

  const createWordbook = async () => {
    const name = newBookName.trim();
    const words = parseExternalWords(newBookWords);
    if (!name) {
      setCreatorError("请填写词书名称。");
      return;
    }
    if (["IELTS 核心词库", "内置 IELTS 词库"].includes(name) || visibleWordbooks.some((book) => book.name.trim().toLowerCase() === name.toLowerCase())) {
      setCreatorError("已有同名词书，请换一个名称，避免计划和进度混淆。");
      return;
    }
    if (!words.length) {
      setCreatorError("请至少加入一个英文单词。");
      return;
    }
    const book: UserWordbook = {
      id: `custom-${Date.now().toString(36)}`,
      name,
      words: words.join("\n"),
      createdAt: new Date().toISOString(),
    };
    await learningDB.wordbooks.put(book);
    scheduleServerSnapshotSync();
    selectCustomWordbook(book);
    setCreatorOpen(false);
    setNewBookName("");
    setNewBookWords("");
    setNewBookFile(null);
    setCreatorError(null);
  };

  return (
    <div className="page-view import-page">
      <section className="wordbook-shelf" aria-labelledby="wordbook-heading">
        <div className="wordbook-shelf-head">
          <div>
            <p className="eyebrow">My wordbooks / 我的词书</p>
            <h1 id="wordbook-heading">选择这次学习的词书。</h1>
          </div>
          <button
            type="button"
            className="wordbook-add"
            onClick={() => setCreatorOpen(true)}
          >
            <span aria-hidden="true">＋</span> 新建词书
          </button>
        </div>
        <div className="wordbook-groups">
          {builtinGroups.map((group) => {
            const books = BUILTIN_WORDBOOKS.filter((book) => book.category === group.category);
            return (
              <section className="wordbook-category-group" key={group.category} aria-labelledby={`wordbook-${group.category}`}>
                <div className="wordbook-category-head">
                  <div>
                    <p className="eyebrow">{group.label}</p>
                    <h2 id={`wordbook-${group.category}`}>{group.description}</h2>
                  </div>
                  <span>{books.length} 本内置词书</span>
                </div>
                <HorizontalWordbookRail label={`${group.label}词书`}>
                  {books.map((book) => {
                    const isActive = activeWordbookId === book.id;
                    return (
                      <button
                        type="button"
                        key={book.id}
                        title={book.sourceLabel}
                        className={`wordbook-card ${isActive ? "active" : ""}`}
                        onClick={() => void onSelectWordbook(book.id, book.wordCount)}
                      >
                        <span className="wordbook-index">内置 · {book.shortName}</span>
                        <strong>{book.name}</strong>
                        <span>{book.wordCount.toLocaleString()} 个词条</span>
                        <i>{isActive ? "✓ 已选中" : "选择词书"}</i>
                      </button>
                    );
                  })}
                </HorizontalWordbookRail>
              </section>
            );
          })}
          <section className="wordbook-category-group" aria-labelledby="wordbook-custom">
            <div className="wordbook-category-head">
              <div>
                <p className="eyebrow">本地词库</p>
                <h2 id="wordbook-custom">你的积累与自定义词书</h2>
              </div>
              <span>{visibleWordbooks.length} 本已保存</span>
            </div>
            <HorizontalWordbookRail label="本地与自定义词书">
              {visibleWordbooks.map((book, index) => (
                <button
                  type="button"
                  key={book.id}
                  className={`wordbook-card custom ${activeWordbookId === book.id ? "active" : ""}`}
                  onClick={() => selectCustomWordbook(book)}
                >
                  <span className="wordbook-index">自定义 · {String(index + 1).padStart(2, "0")}</span>
                  <strong>{book.name}</strong>
                  <span>{parseExternalWords(book.words).length} 个词条</span>
                  <i>{activeWordbookId === book.id ? "当前词书" : "选择词书"}</i>
                </button>
              ))}
              <button
                type="button"
                className="wordbook-card wordbook-empty-card"
                onClick={() => setCreatorOpen(true)}
              >
                <span className="wordbook-plus" aria-hidden="true">＋</span>
                <strong>建立自己的词书</strong>
                <span>上传 Word、TXT 或 PDF 后保存在本机</span>
              </button>
            </HorizontalWordbookRail>
          </section>
        </div>
        <div className="wordbook-current-bar">
          <div>
            <span>当前词书</span>
            <strong>
              {activeBuiltinWordbook?.name ?? customWordbooks.find((book) => book.id === activeWordbookId)?.name ?? "自定义词书"}
            </strong>
          </div>
          <button
            type="button"
            className="button"
            onClick={onConfirmWordbook}
          >
            选中词书
          </button>
        </div>
        {uploadStatus && <p className="small upload-status">{uploadStatus}</p>}
      </section>

      <section className="external-vocab-panel" aria-labelledby="external-vocab-heading">
        <div className="external-vocab-copy">
          <p className="eyebrow">Daily capture / 外部词汇</p>
          <h2 id="external-vocab-heading">遇到不会的词，先放进你的词库。</h2>
          <p className="lede">
            只输入英文单词即可，支持空格、换行、逗号或复制整段文字。已有词会优先进入下一篇语境短文，新词会加入本地大词库。
          </p>
        </div>
        <div className="external-vocab-form">
          <label htmlFor="external-vocab-input">单词列表</label>
          <textarea
            id="external-vocab-input"
            value={externalInput}
            onChange={(event) => {
              setExternalInput(event.target.value);
              setExternalStatus(null);
            }}
            placeholder="例如：feasible, allocate\n或者每行输入一个单词"
            rows={4}
          />
          <div className="external-vocab-actions">
            <span className="small muted">已积累 {externalWordCount} 个外部词</span>
            <button
              type="button"
              className="button"
              disabled={!externalInput.trim()}
              onClick={async () => {
                const incoming = parseExternalWords(externalInput);
                if (!incoming.length) {
                  setExternalStatus("没有识别到英文单词，请检查输入。 ");
                  return;
                }
                const existing = await learningDB.wordbooks.get(EXTERNAL_VOCABULARY_ID);
                const existingWords = existing?.words ?? "";
                const previous = new Set(parseExternalWords(existingWords));
                const added = incoming.filter((word) => !previous.has(word));
                await learningDB.wordbooks.put({
                  id: EXTERNAL_VOCABULARY_ID,
                  name: EXTERNAL_VOCABULARY_NAME,
                  words: [...previous, ...added].join("\n"),
                  createdAt: existing?.createdAt ?? new Date().toISOString(),
                });
                scheduleServerSnapshotSync();
                setExternalInput("");
                setExternalStatus(
                  added.length
                    ? `已加入 ${added.length} 个词；${added.length === 1 ? "它" : "它们"}会优先出现在下一次生成中。`
                    : "这些词已经在外部积累词库中，会按计划优先使用。",
                );
              }}
            >
              加入词库
            </button>
          </div>
          {externalStatus && <p className="small external-vocab-status" role="status">{externalStatus}</p>}
        </div>
      </section>

      {creatorOpen && (
        <div className="wordbook-dialog-backdrop" role="presentation" onMouseDown={() => setCreatorOpen(false)}>
          <section
            className="wordbook-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-wordbook-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-book-mark" aria-hidden="true">Aa</div>
            <div className="dialog-wordbook-form">
              <p className="eyebrow">Custom wordbook</p>
              <h2 id="create-wordbook-title">新建自定义词书</h2>
              <label>
                <span>词书名称</span>
                <input
                  autoFocus
                  value={newBookName}
                  onChange={(event) => setNewBookName(event.target.value)}
                  placeholder="例如：写作高频词"
                />
              </label>
              <label>
                <span>上传词书文件</span>
                <input
                  className="wordbook-file-input"
                  type="file"
                  accept=".txt,.csv,.md,.docx,.pdf,text/plain,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setNewBookFile(file);
                    setCreatorError(null);
                    setExtractingFile(true);
                    try {
                      const form = new FormData();
                      form.append("file", file);
                      const response = await fetch("/api/context-packs/extract", { method: "POST", body: form });
                      const result = (await response.json()) as { text?: string; message?: string; error?: string };
                      if (!response.ok) throw new Error(result.error ?? result.message ?? "文件解析失败");
                      const words = parseExternalWords(result.text ?? "");
                      if (!words.length) throw new Error("文件中没有识别到英文单词，请换一个词表文件。");
                      setNewBookWords(words.join("\n"));
                    } catch (error) {
                      setNewBookWords("");
                      setCreatorError(error instanceof Error ? error.message : "文件解析失败，请重试。");
                    } finally {
                      setExtractingFile(false);
                    }
                  }}
                />
                <span className="wordbook-file-hint">
                  {extractingFile ? "正在解析文件…" : newBookFile ? `${newBookFile.name} · 已识别 ${parseExternalWords(newBookWords).length} 个词` : "支持 .docx、.txt、.csv、.md、.pdf；旧版 .doc 请另存为 .docx"}
                </span>
              </label>
              {creatorError && <p className="wordbook-form-error">{creatorError}</p>}
              <div className="dialog-actions">
                <button type="button" className="button ghost" onClick={() => setCreatorOpen(false)}>取消</button>
                <button type="button" className="button" disabled={extractingFile} onClick={createWordbook}>保存并使用</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Settings({
  settings,
  setSettings,
  onExport,
  onReset,
  libraryCount,
  vocabLoading,
  activeWordbookName,
}: {
  settings: AISettings;
  setSettings: (value: AISettings) => void;
  onExport: () => void;
  onReset: () => Promise<void>;
  libraryCount: number;
  vocabLoading: boolean;
  activeWordbookName: string;
}) {
  type ServerConfigInfo = {
    serverConfigured: boolean;
    serverBaseUrl: string;
    serverModel: string | null;
  };

  const [draft, setDraft] = useState(settings);
  const [section, setSection] = useState<"plan" | "model" | "effects" | "reset">("plan");
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [serverConfig, setServerConfig] = useState<{
    serverConfigured: boolean;
    serverBaseUrl: string;
    serverModel: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/context-packs/config")
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setServerConfig(data);
        if (data.serverConfigured) {
          setDraft((current) => ({
            ...current,
            baseUrl: data.serverBaseUrl || current.baseUrl,
            model: data.serverModel || current.model,
            protocol: "openai_compatible_chat",
          }));
        }
      })
      .catch(() => {
        /* 探测失败时静默，界面按未配置处理 */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const serverOnly = Boolean(serverConfig?.serverConfigured);
  const save = async () => {
    setSettings(draft);
    const { apiKey, ...safeSettings } = draft;
    window.localStorage.setItem(
      "ielts-context-ai-settings",
      JSON.stringify(safeSettings),
    );
    if (apiKey) window.sessionStorage.setItem("ielts-context-api-key", apiKey);
    else window.sessionStorage.removeItem("ielts-context-api-key");
    if (section !== "model") {
      setTestStatus("设置已保存，计划表与后续生成将使用新配置。");
      return;
    }
    try {
      const response = await fetch("/api/context-packs/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim() || undefined,
          baseUrl: draft.baseUrl,
          model: draft.model,
        }),
      });
      const result = (await response.json()) as ServerConfigInfo | { error?: string };
      if (!response.ok || !("serverConfigured" in result)) {
        throw new Error("error" in result ? result.error : "服务端配置同步失败");
      }
      setServerConfig(result);
      setDraft((current) => ({
        ...current,
        baseUrl: result.serverBaseUrl,
        model: result.serverModel ?? current.model,
        protocol: "openai_compatible_chat",
      }));
      setTestStatus("前端设置已保存，并已同步到服务端；后续生成将使用这套配置。");
    } catch (error) {
      setTestStatus(error instanceof Error ? error.message : "服务端配置同步失败，请重试。");
    }
  };
  const testConnection = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      const response = await fetch("/api/context-packs/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          probe: true,
          words: ["adapt"],
          planning: draft.planning,
          model: draft.model,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          protocol: draft.protocol,
          extraHeaders: draft.headers,
        }),
      });
      const result = (await response.json()) as {
        mode?: string;
        warning?: string;
        model?: string;
        serverConfigured?: boolean;
      };
      setTestStatus(
        result.mode === "openai"
          ? `连接成功（${result.serverConfigured ? "服务端配置" : "客户端配置"}）· 模型 ${result.model ?? "未知"} 已返回内容。`
          : `${result.warning ?? "当前使用本地回退；请检查 API Key、地址和模型。"}${result.serverConfigured ? "（服务端已配置，但本次请求未成功）" : ""}`,
      );
    } catch {
      setTestStatus("连接失败，请检查网络和接口地址。");
    } finally {
      setTesting(false);
    }
  };
  const choosePreset = (preset: (typeof PROVIDER_PRESETS)[number]) =>
    setDraft({
      ...draft,
      provider: preset.name,
      displayName: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      protocol:
        preset.id === "openai" ? "openai_responses" : "openai_compatible_chat",
    });
  const docsUrl =
    draft.provider === "DeepSeek"
      ? "https://api-docs.deepseek.com/"
      : draft.provider === "通义千问"
        ? "https://help.aliyun.com/zh/dashscope/"
        : "https://platform.openai.com/docs";
  return (
    <section className="settings-page glass-panel" aria-labelledby="settings-title">
        <form
          className="settings-page-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <header className="settings-page-header">
            <div>
              <span className="eyebrow">PREFERENCES / 设置</span>
              <h1 id="settings-title">管理学习节奏、模型与效果。</h1>
              <p className="settings-subtitle">
                计划调整与模型接入集中在一个页面，所有配置仍保存在本机。
              </p>
            </div>
          </header>
          <div className="settings-page-layout">
            <nav className="settings-section-nav" aria-label="设置分类">
              <button type="button" className={section === "plan" ? "active" : ""} aria-current={section === "plan" ? "page" : undefined} onClick={() => setSection("plan")}>
                <strong>学习计划</strong><span>词量、天数与规划方式</span>
              </button>
              <button type="button" className={section === "model" ? "active" : ""} aria-current={section === "model" ? "page" : undefined} onClick={() => setSection("model")}>
                <strong>模型服务</strong><span>API、协议与数据导出</span>
              </button>
              <button type="button" className={section === "effects" ? "active" : ""} aria-current={section === "effects" ? "page" : undefined} onClick={() => setSection("effects")}>
                <strong>效果调整</strong><span>震动、碎屑与输入音效</span>
              </button>
              <button type="button" className={`settings-reset-tab ${section === "reset" ? "active" : ""}`} aria-current={section === "reset" ? "page" : undefined} onClick={() => setSection("reset")}>
                <strong>重置系统</strong><span>清空数据并回到初始状态</span>
              </button>
            </nav>
            <div className="settings-page-content">
          <div hidden={section !== "model"}>
          {serverOnly && (
            <div className="server-config-banner" role="status">
              <strong>✓ 服务端已配置模型服务</strong>
              <span>
                当前生效地址{" "}
                <code>
                  {serverConfig?.serverBaseUrl || "默认地址"}
                </code>{" "}
                · 模型{" "}
                <code>{serverConfig?.serverModel ?? "默认"}</code>
                。前端设置保存后会同步写入服务端；生成短文、图片 OCR 与复习评估共用这套配置。
              </span>
            </div>
          )}
          <div className="settings-form">
            <div className="provider-config-section">
              <span className="provider-config-label">快捷接入</span>
              <div className="provider-preset-grid">
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.id}
                    aria-pressed={draft.provider === preset.name}
                    className={`provider-preset ${draft.provider === preset.name ? "active" : ""}`}
                    onClick={() => choosePreset(preset)}
                  >
                    <span
                      className="provider-mark"
                      data-provider={preset.id}
                    >
                      {preset.icon ? (
                        <Image
                          src={preset.icon}
                          alt=""
                          width={26}
                          height={26}
                        />
                      ) : (
                        preset.mark
                      )}
                    </span>
                    <span>
                      <strong>{preset.name}</strong>
                      <small>{preset.note}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <label className="provider-input-group">
              <span>显示名称</span>
              <input
                id="provider-name"
                value={draft.displayName}
                onChange={(event) =>
                  setDraft({ ...draft, displayName: event.target.value })
                }
                placeholder="例如：语境记忆 AI"
              />
            </label>
            <div className="provider-config-section">
              <span className="provider-config-label">协议类型</span>
              <div className="protocol-grid">
                <button
                  type="button"
                  className={
                    draft.protocol === "openai_compatible_chat" ? "active" : ""
                  }
                  onClick={() =>
                    setDraft({ ...draft, protocol: "openai_compatible_chat" })
                  }
                >
                  <strong>OpenAI Compatible Chat</strong>
                  <small>适用于大多数中转与兼容服务</small>
                </button>
                <button
                  type="button"
                  className={
                    draft.protocol === "openai_responses" ? "active" : ""
                  }
                  onClick={() =>
                    setDraft({ ...draft, protocol: "openai_responses" })
                  }
                >
                  <strong>Responses API</strong>
                  <small>适用于 OpenAI 官方新接口</small>
                </button>
              </div>
              {
                <div className="provider-links">
                  <a href={docsUrl} target="_blank" rel="noreferrer">
                    官方文档 ↗
                  </a>
                  <span>保存后可测试真实能力</span>
                </div>
              }
            </div>
            <label className="provider-input-group">
              <span>
                Base URL
                {serverOnly && <span className="server-only-tag">保存后同步服务端</span>}
              </span>
              <input
                id="provider-url"
                value={draft.baseUrl}
                onChange={(event) =>
                  setDraft({ ...draft, baseUrl: event.target.value })
                }
                placeholder="https://api.openai.com/v1"
              />
              <small>支持官方 API、兼容网关或代理地址。</small>
            </label>
            <label className="provider-input-group">
              <span>默认模型</span>
              <input
                id="provider-model"
                value={draft.model}
                onChange={(event) =>
                  setDraft({ ...draft, model: event.target.value })
                }
                placeholder="gpt-4o-mini"
              />
            </label>
            <label className="provider-input-group">
              <span className="provider-label-row">
                <span>
                  API Key
                  {serverOnly && <span className="server-only-tag">留空则沿用服务端 Key</span>}
                </span>
                <a href={docsUrl} target="_blank" rel="noreferrer">
                  获取 API Key ↗
                </a>
              </span>
              <input
                id="provider-key"
                autoComplete="off"
                type="password"
                value={draft.apiKey}
                onChange={(event) =>
                  setDraft({ ...draft, apiKey: event.target.value })
                }
                placeholder={serverOnly ? "留空则沿用服务端 Key；填写可替换" : "填写后同步到本机服务端"}
              />
            </label>
            <label className="provider-input-group">
              <span>自定义请求头（可选，中转站用）</span>
              <textarea
                id="provider-headers"
                rows={3}
                value={draft.headers}
                onChange={(event) =>
                  setDraft({ ...draft, headers: event.target.value })
                }
                placeholder='{"X-Station-Token":"…"}'
              />
              <small>
                JSON 对象。Authorization / API Key
                请勿写在这里，统一使用上方密钥字段。
              </small>
            </label>
            <div className="provider-alert">
              <strong>安全提示</strong>
              <span>
                服务端环境变量优先。个人模式只在当前标签会话中保留密钥，关闭标签后即清除。
              </span>
            </div>
            <div className="provider-config-section data-portability">
              <span className="provider-config-label">你的学习数据</span>
              <div>
                <p className="small muted">
                  词卡、短文、复习记录和计划都保存在本机，可随时导出为 JSON。
                </p>
                <button
                  type="button"
                  className="button ghost"
                  onClick={onExport}
                >
                  导出学习数据
                </button>
              </div>
            </div>
          </div>
          </div>
          <div hidden={section !== "plan"}>
            <div className="settings-form">
            <div className="provider-section-divider">
              <span>学习计划</span>
            </div>
            <div className="settings-number-grid">
              <label className="provider-input-group">
                <span>总词汇量</span>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  value={draft.totalVocabulary}
                  onChange={(event) =>
                    setDraft((current) => {
                      const totalVocabulary = Math.max(1, Number(event.target.value) || 1);
                      return {
                        ...current,
                        totalVocabulary,
                        targetDays: Math.max(1, Math.ceil(totalVocabulary / current.dailyNewWords)),
                      };
                    })
                  }
                />
                <small>
                  {activeWordbookName}共{" "}
                  {vocabLoading
                    ? "…"
                    : libraryCount
                      ? libraryCount.toLocaleString()
                      : "0"}{" "}
                  词；计划会从未学词中随机抽取，并优先分散首字母。
                </small>
              </label>
              <label className="provider-input-group">
                <span>每日新词</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={draft.dailyNewWords}
                  onChange={(event) =>
                    setDraft((current) => {
                      const dailyNewWords = Math.max(1, Number(event.target.value) || 1);
                      return {
                        ...current,
                        dailyNewWords,
                        targetDays: Math.max(1, Math.ceil(current.totalVocabulary / dailyNewWords)),
                      };
                    })
                  }
                />
                <small>按当前词量预计 {draft.targetDays} 天完成。</small>
              </label>
              <label className="provider-input-group">
                <span>目标完成天数</span>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={draft.targetDays}
                  onChange={(event) =>
                    setDraft((current) => {
                      const targetDays = Math.max(1, Number(event.target.value) || 1);
                      return {
                        ...current,
                        targetDays,
                        dailyNewWords: Math.max(1, Math.ceil(current.totalVocabulary / targetDays)),
                      };
                    })
                  }
                />
                <small>系统将每天安排约 {draft.dailyNewWords} 个新词。</small>
              </label>
            </div>
            <div className="plan-recalculation-note">
              <strong>{draft.totalVocabulary.toLocaleString()} 词 · 约 {draft.dailyNewWords} 词/日 · {draft.targetDays} 个学习日</strong>
              <span>最后一天会自动安排剩余词量。保存后，计划表页数、学习日范围和 Day 1/2/4/7/15/30 复习节点会同步重算；已有学习记录不会删除。</span>
            </div>
            <div className="provider-config-section">
              <span className="provider-config-label">短文规划方式</span>
              <div className="planning-grid">
                <label className={draft.planning === "topic" ? "active" : ""}>
                  <input
                    type="radio"
                    checked={draft.planning === "topic"}
                    onChange={() => setDraft({ ...draft, planning: "topic" })}
                  />
                  <span>
                    <strong>主题单元</strong>
                    <small>按不同主题组织词汇</small>
                  </span>
                </label>
                <label className={draft.planning === "story" ? "active" : ""}>
                  <input
                    type="radio"
                    checked={draft.planning === "story"}
                    onChange={() => setDraft({ ...draft, planning: "story" })}
                  />
                  <span>
                    <strong>连续故事</strong>
                    <small>用前后连贯的小故事串联</small>
                  </span>
                </label>
              </div>
            </div>
          </div>
          </div>
          <div hidden={section !== "effects"}>
            <div className="settings-form effects-settings-panel">
              <div className="provider-section-divider"><span>效果调整</span></div>
              <div className="typing-feedback-heading">
                <div>
                  <h2>调整填词时的触感与声音。</h2>
                  <small>所有效果均在本机运行，不会加载外部音频。</small>
                </div>
              </div>
              <div className="sound-choice-grid" role="radiogroup" aria-label="输入音效">
                {([
                  ["mechanical", "清脆机械", "清晰咔哒与低频落键"],
                  ["soft", "柔和木质", "更圆润、较低刺激"],
                  ["muted", "静音", "保留震动与碎屑"],
                ] as const).map(([value, label, note]) => (
                  <label className={draft.typingSound === value ? "active" : ""} key={value}>
                    <input type="radio" name="typing-sound" value={value} checked={draft.typingSound === value} onChange={() => setDraft({ ...draft, typingSound: value })} />
                    <span><strong>{label}</strong><small>{note}</small></span>
                  </label>
                ))}
              </div>
              <div className="typing-feedback-grid">
                <label><span>震动强度 <output>{draft.typingShake}%</output></span><input type="range" min="0" max="100" step="5" value={draft.typingShake} onChange={(event) => setDraft({ ...draft, typingShake: Number(event.target.value) })} /></label>
                <label><span>碎屑大小 <output>{draft.particleSize}%</output></span><input type="range" min="0" max="100" step="5" value={draft.particleSize} onChange={(event) => setDraft({ ...draft, particleSize: Number(event.target.value) })} /></label>
                <label><span>触发频率 <output>{draft.particleFrequency}%</output></span><input type="range" min="0" max="100" step="5" value={draft.particleFrequency} onChange={(event) => setDraft({ ...draft, particleFrequency: Number(event.target.value) })} /></label>
              </div>
            </div>
          </div>
          <div hidden={section !== "reset"}>
            <section className="reset-settings-panel" aria-labelledby="reset-settings-title">
              <div>
                <span className="eyebrow">RESET / 本地重置</span>
                <h2 id="reset-settings-title">重新从第 1 天开始。</h2>
                <p>完全重置会删除本机中的全部短文、词卡、复习记录、已会标记、自建词书和应用设置。计划表中的每一天都会恢复为“未生成”。</p>
              </div>
              <ul>
                <li>所有学习日恢复为未生成、未完成</li>
                <li>清除艾宾浩斯复习进度与统计数据</li>
                <li>恢复默认计划与默认模型配置</li>
              </ul>
            </section>
          </div>
            </div>
          </div>
          <footer className="settings-actions">
            {testStatus && (
              <p className="connection-status" role="status">
                {testStatus}
              </p>
            )}
            <div className="button-row">
              {section === "model" && <button
                type="button"
                className="button secondary"
                disabled={testing || !draft.baseUrl || !draft.model}
                onClick={testConnection}
              >
                {testing ? "测试中…" : "测试连接"}
              </button>}
              {section !== "reset" && <button type="submit" className="button">
                {section === "plan" ? "保存并重新规划" : section === "model" ? "保存模型配置" : "保存效果设置"}
              </button>}
              {section === "reset" && <button type="button" className="button danger" onClick={() => setConfirmReset(true)}>
                重置整个系统
              </button>}
            </div>
          </footer>
          {confirmReset && (
            <div className="reset-confirm-backdrop" role="presentation">
              <section className="reset-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reset-confirm-title" aria-describedby="reset-confirm-description">
                <h2 id="reset-confirm-title">确认完全重置？</h2>
                <p id="reset-confirm-description">此操作无法撤销。本机保存的学习内容、进度、词书和设置都会被清除。</p>
                <div className="button-row">
                  <button type="button" className="button ghost" disabled={resetting} onClick={() => setConfirmReset(false)} autoFocus>取消</button>
                  <button type="button" className="button danger" disabled={resetting} onClick={async () => {
                    setResetting(true);
                    try {
                      await onReset();
                    } finally {
                      setResetting(false);
                    }
                  }}>{resetting ? "正在重置…" : "确认完全重置"}</button>
                </div>
              </section>
            </div>
          )}
        </form>
    </section>
  );
}

function Reading({
  pack,
  day,
  mode,
  setMode,
  hoveredWord,
  setHoveredWord,
  answers,
  setAnswers,
  spellingResults,
  setSpellingResults,
  typingFeedback,
  spellingPassed,
  spellingScore,
  feedback,
  onCheck,
  onFinish,
  onGoImport,
  onGenerateLibrary,
  vocabLoading,
  generating,
  knownSet,
  onToggleSkip,
  adjustment,
  setAdjustment,
  onRegenerate,
  definitionOf,
  onExit,
  activeWordbookName,
}: {
  pack: ContextPack | null;
  day: number;
  mode: "show" | "spell";
  setMode: (mode: "show" | "spell") => void;
  hoveredWord: string | null;
  setHoveredWord: (word: string | null) => void;
  answers: Record<string, string>;
  setAnswers: (answers: Record<string, string>) => void;
  spellingResults: Record<string, SpellingResult>;
  setSpellingResults: React.Dispatch<React.SetStateAction<Record<string, SpellingResult>>>;
  typingFeedback: TypingFeedbackConfig;
  spellingPassed: boolean;
  spellingScore: number | null;
  feedback: string | null;
  onCheck: () => void;
  onFinish: () => void;
  onGoImport: () => void;
  onGenerateLibrary: () => void;
  vocabLoading: boolean;
  generating: boolean;
  knownSet: Set<string>;
  onToggleSkip: (lemma: string) => void;
  adjustment: string;
  setAdjustment: (value: string) => void;
  onRegenerate: () => void;
  definitionOf: (lemma: string) => string | undefined;
  onExit: () => void;
  activeWordbookName: string;
}) {
  if (!pack)
    return (
      <div className="reading-page">
        <button type="button" className="reading-exit" onClick={onExit} aria-label="退出阅读，返回计划表">
          <span aria-hidden="true">←</span> 退出
        </button>
        <section className="reading-empty glass-panel">
          <p className="eyebrow">Day {day}</p>
          <h1>这一天还没有短文</h1>
          <p className="lede">
            从{activeWordbookName}生成当天短文，或导入你自己的词汇开始学习。
          </p>
          <div className="button-row">
            <button className="button" onClick={onGenerateLibrary} disabled={vocabLoading || generating}>
              {generating ? "正在生成请稍后…" : vocabLoading ? "词库加载中…" : `生成第 ${day} 天短文`}
            </button>
            <button className="button ghost" onClick={onGoImport}>去导入词汇</button>
          </div>
        </section>
      </div>
    );
  const skippedCount = pack.targetWords.filter((word) =>
    knownSet.has(word.lemma),
  ).length;
  const checkableCount = pack.targetWords.length - skippedCount;
  const displayDifficulty = pack.difficulty.replace(/^IELTS\s+/i, "") === "advanced"
    ? "进阶模式"
    : "通用标准";
  return (
    <>
      <div className="reading-page">
        <button type="button" className="reading-exit" onClick={onExit} aria-label="退出阅读，返回计划表">
          <span aria-hidden="true">←</span> 退出
        </button>
      <div className="reading-shell glass-panel">
        <section className="reading-header">
          <div>
            <p className="eyebrow">Day {day} / 语境短文</p>
            <h1>{pack.planDay ? `${activeWordbookName} · 第 ${pack.planDay} 天` : pack.title}</h1>
            <p className="small muted">
              {pack.topic} · {displayDifficulty} · 目标词{" "}
              {pack.targetWords.length} 个 ·{" "}
              <span className="status">
                {pack.generatedBy === "ai" ? "AI 生成" : "本地模板"}
              </span>
            </p>
          </div>
          <div className="reading-adjust">
            <input
              type="text"
              value={adjustment}
              onChange={(event) => setAdjustment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !generating) {
                  event.preventDefault();
                  onRegenerate();
                }
              }}
              placeholder="调整意见：如换成科技话题 / 缩短到 60 词"
              aria-label="文章调整意见"
              disabled={generating}
            />
            <button
              type="button"
              className="button ghost"
              onClick={onRegenerate}
              disabled={generating}
              title="按调整意见重新生成短文"
            >
              {generating ? "正在重新生成…" : "↻ 重新生成"}
            </button>
          </div>
        </section>
        <article className="reading-article">
          <p className="passage">
            {renderEnglish(
              pack,
              mode,
              hoveredWord,
              setHoveredWord,
              answers,
              setAnswers,
              spellingResults,
              setSpellingResults,
              typingFeedback,
              definitionOf,
              knownSet,
              onToggleSkip,
            )}
          </p>
          {pack.keySentence && (
            <div className="key-sentence-note">
              <span className="key-sentence-badge">好句型</span>
              <div>
                <strong>{pack.keySentence.pattern}</strong>
                {pack.keySentence.writingTopic && (
                  <span className="key-sentence-topic">
                    写作迁移 · {pack.keySentence.writingTopic}
                  </span>
                )}
                <span>{pack.keySentence.explanation}</span>
              </div>
            </div>
          )}
          <section className="translation-panel">
            <p className="small muted">中文翻译 · 对应词义同样划线</p>
            <p className="translation-text">
              {renderChinese(pack, definitionOf)}
            </p>
          </section>
        </article>
        {mode === "spell" && (
          <section className="spelling-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Recall / 拼写检测</p>
                <h2>直接在原文横线上填词。</h2>
                <p className="small muted" style={{ marginTop: 6 }}>
                  正确词保持绿色，错误词显示红色；点击中文提示可将该词标记为橙色跳过，再次点击可恢复。
                </p>
              </div>
              <span className="status">
                {spellingScore === null
                  ? "未提交"
                  : checkableCount === 0
                    ? "全部跳过"
                    : `${spellingScore}/${checkableCount}`}
              </span>
            </div>
            {spellingScore !== null && skippedCount > 0 && (
              <p className="small muted" style={{ marginTop: 8 }}>
                已跳过 {skippedCount} 个已会的词（不参与检查）。
              </p>
            )}
            {feedback && <p className="small spelling-feedback">{feedback}</p>}
          </section>
        )}
      </div></div>
      {/* 固定右下角操作栏：滚动时保持可见 */}
      <div className="reading-fab" role="toolbar" aria-label="阅读操作">
        <div className="reading-fab-modes">
          <button
            type="button"
            className={`mode-switch ${mode === "show" ? "active" : ""}`}
            onClick={() => setMode("show")}
          >
            显示划线词
          </button>
          <button
            type="button"
            className={`mode-switch ${mode === "spell" ? "active" : ""}`}
            onClick={() => setMode("spell")}
          >
            原文填词
          </button>
        </div>
        {mode === "spell" && (
          <div className="reading-fab-actions">
            <button type="button" className="button ghost" onClick={onCheck}>
              检查原文填词
            </button>
            {spellingPassed && (
              <button type="button" className="button" onClick={onFinish}>
                记录第 {day} 天
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function SpellInput({
  target,
  surfaceForm,
  answer,
  result,
  answers,
  setAnswers,
  setSpellingResults,
  typingFeedback,
  onToggleSkip,
}: {
  target: ContextPack["targetWords"][number];
  surfaceForm: string;
  answer: string;
  result?: SpellingResult;
  answers: Record<string, string>;
  setAnswers: (answers: Record<string, string>) => void;
  setSpellingResults: React.Dispatch<React.SetStateAction<Record<string, SpellingResult>>>;
  typingFeedback: TypingFeedbackConfig;
  onToggleSkip: (lemma: string) => void;
}) {
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;
    // 用同一套字体实际测量目标词，而不是用 `ch` 估算；不同字母宽度差异很大。
    setWidth(Math.max(12, Math.ceil(measure.getBoundingClientRect().width + 1)));
  }, [surfaceForm]);

  return (
    <span className="inline-spell">
      <span ref={measureRef} className="spell-input-measure" aria-hidden="true">
        {surfaceForm}
      </span>
      <input
        aria-label={`${target.meaningZh}，词性 ${formatPartOfSpeech(target.partOfSpeech)}`}
        style={width ? { width: `${width}px` } : undefined}
        value={answer}
        data-spelling-result={result}
        className={result ? `spelling-${result}` : undefined}
        onPointerDown={() => { try { ensureTypingAudio(); } catch { /* 音频不可用 */ } }}
        onFocus={() => { try { ensureTypingAudio(); } catch { /* 音频不可用 */ } }}
        onKeyDown={(event) => handlePhysicalTypingKey(event, typingFeedback)}
        onInput={(event) => triggerTypingFeedback(event, typingFeedback)}
        onChange={(event) => {
          setAnswers({ ...answers, [target.lemma]: event.target.value });
          setSpellingResults((current) => {
            if (!current[target.lemma]) return current;
            const next = { ...current };
            delete next[target.lemma];
            return next;
          });
        }}
        placeholder=""
        spellCheck={false}
      />
      {/* 点击词后的中文提示：标记为“已经会了”，单词变橙色跳过（再点恢复） */}
      <button
        type="button"
        className="spell-hint"
        title="暂时跳过这个词（橙色标记），之后不再出现在新短文；再点击可恢复"
        onClick={() => onToggleSkip(target.lemma)}
      >
        （{target.meaningZh} · {formatPartOfSpeech(target.partOfSpeech)}）
      </button>
    </span>
  );
}

function renderEnglish(
  pack: ContextPack,
  mode: "show" | "spell",
  hoveredWord: string | null,
  setHoveredWord: (word: string | null) => void,
  answers: Record<string, string>,
  setAnswers: (answers: Record<string, string>) => void,
  spellingResults: Record<string, SpellingResult>,
  setSpellingResults: React.Dispatch<React.SetStateAction<Record<string, SpellingResult>>>,
  typingFeedback: TypingFeedbackConfig,
  definitionOf: (lemma: string) => string | undefined,
  knownSet: Set<string>,
  onToggleSkip: (lemma: string) => void,
) {
  const keySentence = pack.keySentence
    ? normalizeForMatch(pack.keySentence.sentence)
    : null;
  const sentences = pack.passage.split(/(?<=[.!?])\s+/).filter(Boolean);
  const nodes: ReactNode[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    const isKey =
      keySentence !== null && normalizeForMatch(sentence) === keySentence;
    nodes.push(
      <span
        key={`s-${sentenceIndex}`}
        className={isKey ? "key-sentence" : undefined}
      >
        {sentence.split(/([A-Za-z'-]+)/).map((part, index) => {
          const target = pack.targetWords.find(
            (word) => word.lemma.toLowerCase() === part.toLowerCase(),
          );
          if (!target) return part;
          if (mode === "spell") {
            // 已标记“会了”的词：橙色显示，和拼写错误的红色明确区分。
            if (knownSet.has(target.lemma))
              return (
                <span
                  className="vocab-skipped"
                  role="button"
                  tabIndex={0}
                  key={`${sentenceIndex}-${index}`}
                  title="已跳过；点击恢复填词"
                  onClick={() => onToggleSkip(target.lemma)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggleSkip(target.lemma);
                    }
                  }}
                >
                  {part}
                </span>
              );
            return (
              <SpellInput
                key={`${sentenceIndex}-${index}`}
                target={target}
                surfaceForm={part}
                answer={answers[target.lemma] ?? ""}
                result={spellingResults[target.lemma]}
                answers={answers}
                setAnswers={setAnswers}
                setSpellingResults={setSpellingResults}
                typingFeedback={typingFeedback}
                onToggleSkip={onToggleSkip}
              />
            );
          }
          const isKnown = knownSet.has(target.lemma);
          const isOpen = hoveredWord === target.lemma;
          return (
            <span
              className="vocab-wrap"
              key={`${sentenceIndex}-${index}`}
              onMouseEnter={() => setHoveredWord(target.lemma)}
              onMouseLeave={() => setHoveredWord(null)}
              onClick={() => onToggleSkip(target.lemma)}
              title={
                isKnown
                  ? `“${part}”已标记为会了（橙色划线），点击恢复`
                  : `点击把“${part}”标记为会了（之后不再出现在新短文）`
              }
            >
              <span className={`vocab-target${isKnown ? " known" : ""}`}>
                {part}
              </span>
              {isOpen && (
                <span className="word-popover">
                  <strong>{target.lemma}</strong>
                  <span>音标：{target.phonetic || "暂无"}</span>
                  <span>中文：{/\p{Script=Han}/u.test(target.meaningZh) ? target.meaningZh : "暂无中文释义"}</span>
                  <span>词性：{target.partOfSpeech && target.partOfSpeech !== "word" ? formatPartOfSpeech(target.partOfSpeech) : "暂无"}</span>
                  <span>词根词缀：{target.morphology || "暂无可靠拆解"}</span>
                  <span>搭配：{target.collocation}</span>
                  {target.phraseFrame && <span>词块框架：{target.phraseFrame}</span>}
                  {target.rhetoricalFunction && <span>修辞功能：{target.rhetoricalFunction}</span>}
                  {target.register && <span>语域：{target.register}</span>}
                  {target.confusables?.length ? <span>易混词：{target.confusables.join("、")}</span> : null}
                </span>
              )}
            </span>
          );
        })}
      </span>,
    );
    if (sentenceIndex < sentences.length - 1) nodes.push(" ");
  });
  return nodes;
}

function renderChinese(pack: ContextPack, definitionOf: (lemma: string) => string | undefined) {
  const normalizedTranslation = normalizeTranslationChunk(pack.translation);
  const hasCompleteSpans = pack.targetWords.every(
    (word) =>
      word.translationZh &&
      normalizedTranslation.includes(normalizeTranslationChunk(word.translationZh)),
  );
  if (!hasCompleteSpans)
    return "这篇历史短文缺少与正文逐词对应的中文翻译，请点击上方“重新生成”修复。";
  const terms = [...pack.targetWords].sort(
    (a, b) => (b.translationZh ?? b.meaningZh).length - (a.translationZh ?? a.meaningZh).length,
  );
  const pattern = terms
    .map((word) => word.translationZh ?? word.meaningZh)
    .filter(
      (term): term is string =>
        Boolean(term && normalizedTranslation.includes(normalizeTranslationChunk(term))),
    )
    .map(escapeRegExp)
    .join("|");
  if (!pattern) return pack.translation;
  return pack.translation
    .split(new RegExp(`(${pattern})`, "g"))
    .map((part, index) => {
      const target = terms.find((word) => (word.translationZh ?? word.meaningZh) === part);
      return target ? (
        <span
          className="translation-target"
          key={index}
          title={`${target.lemma} · ${definitionOf(target.lemma) ?? "context meaning"}`}
        >
          {part}
        </span>
      ) : (
        part
      );
    });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 句子比对用归一化：小写、去标点、折叠空白。 */
function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPartOfSpeech(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  const labels: Record<string, string> = {
    verb: "v.",
    v: "v.",
    noun: "n.",
    n: "n.",
    adjective: "adj.",
    adj: "adj.",
    adverb: "adv.",
    adv: "adv.",
    preposition: "prep.",
    prep: "prep.",
    conjunction: "conj.",
    conj: "conj.",
    pronoun: "pron.",
    pron: "pron.",
  };
  return labels[normalized] ?? (normalized && normalized !== "word" ? normalized : "词");
}
