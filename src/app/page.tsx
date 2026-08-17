"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { useLiveQuery } from "dexie-react-hooks";
import {
  DEMO_LEMMAS,
  ensurePersistentStorage,
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
import type { ContextPack, ReviewEvaluation, ReviewPhase, ReviewRating, ReviewTask, UserWordbook, WordCard } from "@/lib/types";
import { adaptiveSchedule, buildAdaptiveQueue, getMasteryLevel, localEvaluateSentence, nextLevel, phaseForLevel, phaseLabel } from "@/lib/reviewEngine";
import { makeReviewDemoBundle } from "@/lib/reviewDemo";
import {
  loadBuiltinVocab,
  pickDiverseVocabulary,
  type IeltsEntry,
} from "@/lib/ieltsVocab";
import { countEnglishWords, findDuplicateTarget, findMissingTargets, findMissingTranslationAnnotations, hasCompleteTranslationAnnotations, normalizeTranslationChunk, parseContextPack } from "@/lib/contextPack";
import { TodayView } from "./components/TodayView";
import { ProgressView } from "./components/ProgressView";
import { StatisticsView } from "./components/StatisticsView";
import {
  buildDayGroups,
  buildReviewColumns,
  DEFAULT_AI_SETTINGS,
  DEFINITIONS,
  DIMENSION_BY_TASK,
  PROVIDER_PRESETS,
  TABS,
  type AISettings,
  type AppTab,
  type PlanEntry,
  type PlanningMode,
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
  const [raw, setRaw] = useState("");
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
  const [reviewCard, setReviewCard] = useState<WordCard | null>(null);
  const [reviewTask, setReviewTask] = useState<ReviewTask>("meaning");
  const [reviewPhase, setReviewPhase] = useState<ReviewPhase>("recognition");
  const [reviewQueueCards, setReviewQueueCards] = useState<WordCard[]>([]);
  const [reviewInput, setReviewInput] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reviewRevealed, setReviewRevealed] = useState(false);
  const [pendingReviewRating, setPendingReviewRating] = useState<ReviewRating | null>(null);
  const [reviewEvaluation, setReviewEvaluation] = useState<ReviewEvaluation | null>(null);
  const [reviewEvaluating, setReviewEvaluating] = useState(false);
  const [reviewSessionDone, setReviewSessionDone] = useState(0);
  const [reviewComplete, setReviewComplete] = useState(false);
  const [reviewStartedAt, setReviewStartedAt] = useState(() => Date.now());
  const [aiSettings, setAiSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS);
  /** 内置 IELTS 词库（nglsh-master/IELTS-4000.txt，经 /api/ielts-vocab 加载）。 */
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

  const liveCards = useLiveQuery(() => learningDB.cards.toArray(), []);
  const livePacks = useLiveQuery(() => learningDB.packs.toArray(), []);
  const liveAttempts = useLiveQuery(() => learningDB.attempts.toArray(), []);
  const liveKnown = useLiveQuery(() => learningDB.known.toArray(), []);
  const cards = useMemo(() => liveCards ?? [], [liveCards]);
  const packs = useMemo(() => livePacks ?? [], [livePacks]);
  const attempts = useMemo(() => liveAttempts ?? [], [liveAttempts]);
  /** 用户标记为“已经会了”的词元：填词时显示橙色跳过，且不再出现在新短文里。 */
  const knownSet = useMemo(
    () => new Set((liveKnown ?? []).map((entry) => entry.lemma)),
    [liveKnown],
  );
  /** 内置词库查找表：lemma -> 英文释义。 */
  const vocabMap = useMemo(
    () => new Map(vocab.map((entry) => [entry.lemma, entry.definition])),
    [vocab],
  );
  /** 已学（出现在词卡或已生成短文里）的词元，用于从词库顺序取下一组。 */
  const studiedLemmas = useMemo(() => {
    const studied = new Set<string>();
    for (const card of cards) studied.add(card.lemma.toLowerCase());
    for (const pack of packs)
      for (const use of pack.targetWords) studied.add(use.lemma.toLowerCase());
    return studied;
  }, [cards, packs]);
  /** 内置词库中下一组未学过的词：随机抽取并分散首字母。 */
  const nextLibraryWords = useMemo(() => {
    const excluded = new Set([...studiedLemmas, ...knownSet]);
    return pickDiverseVocabulary(vocab, excluded, aiSettings.dailyNewWords);
  }, [vocab, studiedLemmas, knownSet, aiSettings.dailyNewWords]);
  const totalDays = Math.max(1, aiSettings.targetDays);
  const dayGroups = useMemo(() => buildDayGroups(totalDays), [totalDays]);
  const reviewColumns = useMemo(
    () => buildReviewColumns(totalDays),
    [totalDays],
  );
  const nowTimestamp = Date.now();
  const dueCards = useMemo(
    () => buildAdaptiveQueue(cards, attempts, nowTimestamp, 30),
    [cards, attempts, nowTimestamp],
  );
  const nextDay =
    Array.from({ length: totalDays }, (_, index) => index + 1).find(
      (day) => !completedDays.includes(day),
    ) ?? totalDays;
  const reviewContext = useMemo(() => {
    if (!reviewCard) return undefined;
    const pack =
      packs.find((p) => reviewCard.packIds.includes(p.id)) ?? packs.at(-1);
    if (!pack) return undefined;
    const use = pack.targetWords.find(
      (word) => word.lemma === reviewCard.lemma,
    );
    const sentences = pack.passage.split(/(?<=[.!?])\s+/).filter(Boolean);
    return (
      sentences.find((sentence) =>
        sentence.toLowerCase().includes(reviewCard.lemma.toLowerCase()),
      ) ??
      (use ? sentences[use.sentenceIndex] : undefined) ??
      sentences[0]
    );
  }, [reviewCard, packs]);
  const accuracy = attempts.length
    ? Math.round(
        (attempts.filter((a) => a.correct).length / attempts.length) * 100,
      )
    : 0;

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
  }, []);
  useEffect(() => {
    let cancelled = false;
    void loadBuiltinVocab()
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
  }, []);
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
  }, []);
  useEffect(() => {
    void ensurePersistentStorage();
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
        .find((pack) => pack.planDay === day) ?? null;
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
    const { passage, translation, meanings, keySentence, passageMeta, generatedBy, modeNote } =
      await fetchGeneratedPack(selectedWords, "", onProgress);
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
          title:
            source === "library"
              ? `IELTS 词库 · 第 ${targetDay} 天`
              : undefined,
          topic: passageMeta ? `${passageMeta.contentType} · ${passageMeta.sceneTopic}` : source === "library" ? "内置 IELTS 词库" : undefined,
        },
      );
      await learningDB.packs.put(nextPackValue);
      scheduleServerSnapshotSync();
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
      { meaningZh: string; translationZh?: string; phonetic?: string; morphology?: string; partOfSpeech: string; collocation: string }
    >;
    keySentence?: import("@/lib/types").KeySentence;
    passageMeta?: { contentType: string; sceneTopic: string };
    generatedBy: "ai" | "local";
    modeNote: string;
  }> => {
    let passage = buildPassage(words, aiSettings.planning);
    let translation: string | undefined;
    let meanings:
      | Record<
          string,
          { meaningZh: string; translationZh?: string; phonetic?: string; morphology?: string; partOfSpeech: string; collocation: string }
        >
      | undefined;
    let generatedBy: "ai" | "local" = "local";
    let modeNote = "本地模板短文（未配置 AI 或生成失败，可稍后重试）";

    const first = await streamAIText(words, adjustment, "", onProgress);
    let parsed = first.text ? parseContextPack(first.text, words) : undefined;
    if (parsed?.passage) {
      // 质量门：重复目标词、明显超长、漏词、或逐词中文翻译标注不完整时重写。
      // 翻译标注是最容易失败的环节，最多补两次（共三次尝试），并逐次给出更明确的指令。
      for (let attempt = 0; attempt < 2; attempt++) {
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
    const { passage, translation, meanings, keySentence, passageMeta, generatedBy, modeNote } =
      await fetchGeneratedPack(words, adjustment, onProgress);
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
          title: pack.title,
          topic: passageMeta ? `${passageMeta.contentType} · ${passageMeta.sceneTopic}` : pack.topic,
        },
      );
      await replacePackForDay(targetDay, nextPackValue);
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

  const importWords = async () => {
    const words = [
      ...new Set(
        (raw.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).map((word) =>
          word.toLowerCase(),
        ),
      ),
    ];
    if (!words.length) return;
    await generatePackFor(words, "paste");
  };

  /** 从内置 IELTS 词库取下一组未学过的词，直接生成当天短文。 */
  const generateLibraryPack = async () => {
    if (!nextLibraryWords.length) {
      setUploadStatus(
        vocabLoading
          ? "内置 IELTS 词库加载中，请稍候…"
          : "内置词库中没有未学过的词了；可在设置中调整每日新词，或导入自己的词表。",
      );
      return;
    }
    await generatePackFor(nextLibraryWords, "library");
  };

  const updatePlanVocabulary = (totalVocabulary: number) => {
    const nextSettings = {
      ...aiSettings,
      totalVocabulary: Math.max(1, totalVocabulary),
      targetDays: Math.max(
        1,
        Math.ceil(totalVocabulary / Math.max(1, aiSettings.dailyNewWords)),
      ),
    };
    setAiSettings(nextSettings);
    const { apiKey: _apiKey, ...safeSettings } = nextSettings;
    void _apiKey;
    window.localStorage.setItem(
      "ielts-context-ai-settings",
      JSON.stringify(safeSettings),
    );
  };

  /** 切换一个词的“已经会了”状态：橙色跳过，不再出现在新短文。 */
  const toggleSkipWord = (lemma: string) => {
    void toggleWordKnown(lemma);
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
      }
      card.updatedAt = isoNow();
      await learningDB.cards.put(card);
    }
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
      window.localStorage.setItem(
        "ielts-context-completed-reviews",
        JSON.stringify(updatedReviews),
      );
    } else {
      const updated = [...new Set([...completedDays, selectedDay])].sort(
        (a, b) => a - b,
      );
      setCompletedDays(updated);
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

  const beginReview = (queueOverride?: WordCard[]) => {
    const queue = queueOverride ?? dueCards;
    const card = queue[0] ?? null;
    setReviewQueueCards(queue);
    setReviewCard(card ?? null);
    if (card) {
      const phase = phaseForLevel(getMasteryLevel(card));
      setReviewPhase(phase);
      setReviewTask(taskForPhase(phase));
    }
    setReviewInput("");
    setFeedback(null);
    setReviewRevealed(false);
    setPendingReviewRating(null);
    setReviewEvaluation(null);
    setReviewEvaluating(false);
    setReviewSessionDone(0);
    setReviewComplete(false);
    setReviewStartedAt(Date.now());
    setTab("review");
  };
  const seedReviewDemo = async () => {
    const { cards: demoCards, pack: demoPack } = makeReviewDemoBundle();
    await learningDB.transaction("rw", [learningDB.cards, learningDB.packs], async () => {
      await learningDB.packs.where("id").startsWith("review_demo_pack_").delete();
      await learningDB.cards.bulkPut(demoCards);
      await learningDB.packs.put(demoPack);
    });
    scheduleServerSnapshotSync();
    setFeedback("随机体验词卡已载入，共 4 张，包含 Lv1–Lv4。正在打开复习队列。");
    beginReview(buildAdaptiveQueue(demoCards, attempts, Date.now(), 30));
  };
  const evaluateReviewAnswer = async () => {
    if (!reviewCard || !reviewInput.trim() || (reviewPhase !== "generation" && reviewPhase !== "transfer")) return;
    setReviewEvaluating(true);
    const local = localEvaluateSentence(reviewCard.lemma, reviewInput);
    setReviewEvaluation({ ...local, source: "local" });
    try {
      const response = await fetch("/api/reviews/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lemma: reviewCard.lemma,
          answer: reviewInput,
          phase: reviewPhase,
          meaningZh: reviewCard.meaningZh,
          sceneTopic: reviewPhase === "transfer" ? migrationTopic(reviewCard, reviewCard.correct) : "日常具体情境",
          ...aiSettings,
        }),
      });
      const payload = (await response.json()) as { evaluation?: ReviewEvaluation };
      if (payload.evaluation) setReviewEvaluation(payload.evaluation);
    } catch {
      // 本地初筛结果已经可以继续复习。
    } finally {
      setReviewEvaluating(false);
      setReviewRevealed(true);
    }
  };
  const chooseReviewRating = (rating: ReviewRating) => {
    if (!reviewCard) return;
    if (rating === "known" && (reviewPhase === "generation" || reviewPhase === "transfer") && !reviewEvaluation?.passed) {
      setFeedback("先完成一句包含目标词的自然表达；模型通过后才能升级。你也可以选择“模糊”或“忘记”。");
      return;
    }
    setPendingReviewRating(rating);
    setReviewRevealed(true);
  };
  const commitReviewRating = async () => {
    if (!reviewCard || !pendingReviewRating) return;
    const rating = pendingReviewRating;
    const reviewedAt = isoNow();
    const evaluationPassed = reviewPhase === "generation" || reviewPhase === "transfer" ? Boolean(reviewEvaluation?.passed) : true;
    const level = getMasteryLevel(reviewCard);
    const promotedLevel = nextLevel(level, rating, reviewPhase, evaluationPassed);
    const nextSchedule = adaptiveSchedule(reviewCard.schedule, level, rating, reviewedAt);
    const correct = rating === "known";
    const nextStage = promotedLevel >= 4 ? "stable" : promotedLevel === 3 ? "recalled" : promotedLevel === 2 ? "understood" : "encountered";
    const updated = {
      ...reviewCard,
      schedule: nextSchedule,
      correct: reviewCard.correct + (correct ? 1 : 0),
      lapses: reviewCard.lapses + (correct ? 0 : 1),
      hints: reviewCard.hints + (rating === "fuzzy" ? 1 : 0),
      stage: nextStage,
      masteryLevel: promotedLevel,
      updatedAt: reviewedAt,
    } as WordCard;
    if (reviewPhase === "transfer") {
      const topic = migrationTopic(reviewCard, reviewCard.correct);
      updated.transferTopics = [...new Set([...(reviewCard.transferTopics ?? []), topic])].slice(-6);
    }
    const dimension = DIMENSION_BY_TASK[reviewTask];
    updated.dimensions = {
      ...updated.dimensions,
      [dimension]: Math.min(100, updated.dimensions[dimension] + (rating === "known" ? 18 : rating === "fuzzy" ? 6 : 0)),
    };
    await learningDB.cards.put(updated);
    await learningDB.attempts.add({
      id: `attempt_${Date.now()}`,
      cardId: updated.id,
      task: reviewTask,
      correct,
      hintLevel: rating === "fuzzy" ? 1 : 0,
      confidence: rating === "known" ? 4 : rating === "fuzzy" ? 2 : 1,
      elapsedMs: Math.max(0, Date.now() - reviewStartedAt),
      reviewedAt,
      rating,
      phase: reviewPhase,
      answer: reviewInput.trim() || undefined,
      evaluation: reviewEvaluation ?? undefined,
    });
    scheduleServerSnapshotSync();
    const remaining = rating === "forgot"
      ? [...reviewQueueCards.slice(1), updated]
      : reviewQueueCards.slice(1);
    const nextCard = remaining[0] ?? null;
    setReviewQueueCards(remaining);
    setReviewSessionDone((value) => value + 1);
    setReviewInput("");
    setReviewRevealed(false);
    setPendingReviewRating(null);
    setReviewEvaluation(null);
    setFeedback(null);
    if (nextCard) {
      setReviewCard(nextCard);
      const nextPhase = phaseForLevel(getMasteryLevel(nextCard));
      setReviewPhase(nextPhase);
      setReviewTask(taskForPhase(nextPhase));
      setReviewStartedAt(Date.now());
    } else {
      setReviewCard(null);
      setReviewComplete(true);
    }
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
    setRaw("");
    setUploadStatus(null);
    setSpellingAnswers({});
    setSpellingResults({});
    setFeedback(null);
    setTab("today");
    setToast({ message: "系统已完全重置，所有学习日均恢复为未生成状态。" });
  };

  const taskForPhase = (phase: ReviewPhase): ReviewTask =>
    phase === "recognition" ? "cloze" : phase === "semantic" ? "meaning" : phase === "generation" ? "sentence" : "transfer";

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
            <strong>雅思语境记忆</strong>
            <span>Context Memory</span>
          </div>
          <div className="topbar-actions">
            <span className="topbar-note">计划可随时调整，复习按表现安排</span>
          </div>
        </header>}
        {tab !== "read" && <nav className="nav" aria-label="主导航">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => (id === "review" ? beginReview() : setTab(id))}
            >
              {label}
            </button>
          ))}
        </nav>}
        {tab === "today" && (
          <TodayView
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
            onReview={beginReview}
            due={dueCards.length}
            cards={cards}
            packs={packs}
            accuracy={accuracy}
          />
        )}
        {tab === "import" && (
          <Import
            setRaw={setRaw}
            onImport={importWords}
            uploadStatus={uploadStatus}
            onGenerateLibrary={generateLibraryPack}
            onPlanWordbook={updatePlanVocabulary}
            libraryCount={vocab.length}
            vocabLoading={vocabLoading}
            generating={generating}
          />
        )}
        {tab === "read" && (
          <Reading
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
            onExit={() => setTab("today")}
          />
        )}
        {tab === "review" && (
          <Review
            card={reviewCard}
            phase={reviewPhase}
            input={reviewInput}
            setInput={setReviewInput}
            feedback={feedback}
            revealed={reviewRevealed}
            pendingRating={pendingReviewRating}
            evaluation={reviewEvaluation}
            definitionEn={reviewCard ? vocabMap.get(reviewCard.lemma) ?? reviewCard.definitionEn : undefined}
            evaluating={reviewEvaluating}
            sessionDone={reviewSessionDone}
            complete={reviewComplete}
            context={reviewContext}
            onEvaluate={evaluateReviewAnswer}
            onRate={chooseReviewRating}
            onContinue={commitReviewRating}
            onSeedDemo={seedReviewDemo}
          />
        )}
        {tab === "progress" && (
          <ProgressView cards={cards} attempts={attempts} accuracy={accuracy} />
        )}
        {tab === "statistics" && (
          <StatisticsView
            cards={cards}
            attempts={attempts}
            packs={packs}
            completedDays={completedDays}
          />
        )}
        {tab === "settings" && (
          <Settings
            settings={aiSettings}
            setSettings={setAiSettings}
            onExport={exportLearningData}
            onReset={resetApplication}
            libraryCount={vocab.length}
            vocabLoading={vocabLoading}
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

function Import({
  setRaw,
  onImport,
  uploadStatus,
  onGenerateLibrary,
  onPlanWordbook,
  libraryCount,
  vocabLoading,
  generating,
}: {
  setRaw: (v: string) => void;
  onImport: () => void;
  uploadStatus: string | null;
  onGenerateLibrary: () => void;
  onPlanWordbook: (wordCount: number) => void;
  libraryCount: number;
  vocabLoading: boolean;
  generating: boolean;
}) {
  const customWordbooks = useLiveQuery(
    () => learningDB.wordbooks.orderBy("createdAt").toArray(),
    [],
  ) ?? [];
  const [activeWordbook, setActiveWordbook] = useState("builtin-ielts");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [newBookName, setNewBookName] = useState("");
  const [newBookWords, setNewBookWords] = useState("");
  const [creatorError, setCreatorError] = useState<string | null>(null);

  const selectCustomWordbook = (book: UserWordbook) => {
    setActiveWordbook(book.id);
    setRaw(book.words);
    onPlanWordbook(book.words.split("\n").length);
  };

  const createWordbook = async () => {
    const name = newBookName.trim();
    const words = [
      ...new Set(
        (newBookWords.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).map((word) =>
          word.toLowerCase(),
        ),
      ),
    ];
    if (!name) {
      setCreatorError("请填写词书名称。");
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
        <div className="wordbook-rail">
          <button
            type="button"
            className={`wordbook-card ${activeWordbook === "builtin-ielts" ? "active" : ""}`}
            onClick={() => {
              setActiveWordbook("builtin-ielts");
              onPlanWordbook(libraryCount || 4000);
            }}
          >
            <span className="wordbook-index">内置 · Academic</span>
            <strong>IELTS 核心词库</strong>
            <span>{vocabLoading ? "正在读取词库" : `${libraryCount.toLocaleString()} 个词条`}</span>
            <i>{activeWordbook === "builtin-ielts" ? "当前词书" : "选择词书"}</i>
          </button>
          {customWordbooks.map((book, index) => (
            <button
              type="button"
              key={book.id}
              className={`wordbook-card custom ${activeWordbook === book.id ? "active" : ""}`}
              onClick={() => selectCustomWordbook(book)}
            >
              <span className="wordbook-index">自定义 · {String(index + 1).padStart(2, "0")}</span>
              <strong>{book.name}</strong>
              <span>{book.words.split("\n").length} 个词条</span>
              <i>{activeWordbook === book.id ? "当前词书" : "选择词书"}</i>
            </button>
          ))}
          <button
            type="button"
            className="wordbook-card wordbook-empty-card"
            onClick={() => setCreatorOpen(true)}
          >
            <span className="wordbook-plus" aria-hidden="true">＋</span>
            <strong>建立自己的词书</strong>
            <span>粘贴词表后保存在本机</span>
          </button>
        </div>
        <div className="wordbook-current-bar">
          <div>
            <span>当前词书</span>
            <strong>
              {activeWordbook === "builtin-ielts"
                ? "IELTS 核心词库"
                : customWordbooks.find((book) => book.id === activeWordbook)?.name ?? "自定义词书"}
            </strong>
          </div>
          <button
            type="button"
            className="button"
            disabled={generating || vocabLoading}
            onClick={activeWordbook === "builtin-ielts" ? onGenerateLibrary : onImport}
          >
            {generating ? "正在生成请稍后…" : "开始今日学习"}
          </button>
        </div>
        {uploadStatus && <p className="small upload-status">{uploadStatus}</p>}
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
                <span>词书内容</span>
                <textarea
                  rows={5}
                  value={newBookWords}
                  onChange={(event) => setNewBookWords(event.target.value)}
                  placeholder="每行一个单词，或使用逗号分隔"
                />
              </label>
              {creatorError && <p className="wordbook-form-error">{creatorError}</p>}
              <div className="dialog-actions">
                <button type="button" className="button ghost" onClick={() => setCreatorOpen(false)}>取消</button>
                <button type="button" className="button" onClick={createWordbook}>保存并使用</button>
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
}: {
  settings: AISettings;
  setSettings: (value: AISettings) => void;
  onExport: () => void;
  onReset: () => Promise<void>;
  libraryCount: number;
  vocabLoading: boolean;
}) {
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
        if (!cancelled) setServerConfig(data);
      })
      .catch(() => {
        /* 探测失败时静默，界面按未配置处理 */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const serverOnly = Boolean(serverConfig?.serverConfigured);
  const save = () => {
    setSettings(draft);
    const { apiKey, ...safeSettings } = draft;
    window.localStorage.setItem(
      "ielts-context-ai-settings",
      JSON.stringify(safeSettings),
    );
    if (apiKey) window.sessionStorage.setItem("ielts-context-api-key", apiKey);
    else window.sessionStorage.removeItem("ielts-context-api-key");
    setTestStatus("设置已保存，计划表与后续生成将使用新配置。");
  };
  const testConnection = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      const response = await fetch("/api/context-packs/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          words: ["adapt"],
          planning: draft.planning,
          model: draft.model,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          protocol: draft.protocol,
          extraHeaders: draft.headers,
        }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const streamed = await response.text();
        const completed = response.ok && streamed.includes('"type":"done"');
        setTestStatus(
          completed
            ? `连接成功（${serverOnly ? "服务端配置" : "客户端配置"}）· 模型 ${serverConfig?.serverModel ?? draft.model} 已返回内容。`
            : "模型已连接，但返回流不完整，请稍后重试。",
        );
        return;
      }
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
            save();
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
                地址{" "}
                <code>
                  {serverConfig?.serverBaseUrl || "默认地址"}
                </code>{" "}
                · 模型{" "}
                <code>{serverConfig?.serverModel ?? "默认"}</code>
                。生成短文与图片 OCR 将优先使用服务端配置；下方 Base URL /
                API Key 仅在服务端未配置时生效（避免服务器密钥被转发到任意地址）。
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
                placeholder="例如：雅思语境 AI"
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
                {serverOnly && <span className="server-only-tag">服务端已配置，此项被忽略</span>}
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
                  {serverOnly && <span className="server-only-tag">服务端已配置，此项被忽略</span>}
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
                placeholder="仅在调用时提交"
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
                  内置 IELTS 词库共{" "}
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
                    <small>按不同雅思主题组织词汇</small>
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
            从内置 IELTS 词库生成当天短文，或导入你自己的词汇开始学习。
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
            <h1>{pack.title}</h1>
            <p className="small muted">
              {pack.topic} · {pack.difficulty} · 目标词{" "}
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
              <span className="inline-spell" key={`${sentenceIndex}-${index}`}>
                <input
                  aria-label={`${target.meaningZh}，词性 ${formatPartOfSpeech(target.partOfSpeech)}`}
                  style={{ width: `${Math.max(target.lemma.length + 0.5, 3)}ch` }}
                  value={answers[target.lemma] ?? ""}
                  data-spelling-result={spellingResults[target.lemma]}
                  className={spellingResults[target.lemma] ? `spelling-${spellingResults[target.lemma]}` : undefined}
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
                {/* 点击词后的中文提示：标记为“已经会了”，单词变红跳过（再点恢复） */}
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

const MIGRATION_TOPICS = ["摄影现场", "商业会议", "校园课堂", "科技产品", "公共服务", "旅行途中"];

function migrationTopic(card: Pick<WordCard, "transferTopics" | "sourceTitle"> , seed: number) {
  const used = new Set(card.transferTopics ?? []);
  const source = card.sourceTitle ?? "";
  return MIGRATION_TOPICS.find((topic) => !used.has(topic) && !source.includes(topic))
    ?? MIGRATION_TOPICS[Math.abs(seed) % MIGRATION_TOPICS.length];
}

function migrationPrompt(lemma: string, topic: string) {
  const prompts: Record<string, string> = {
    "摄影现场": `Describe a photography scene where you could naturally use “${lemma}”.`,
    "商业会议": `Write one sentence about a business meeting where “${lemma}” fits naturally.`,
    "校园课堂": `Describe a classroom moment where “${lemma}” helps explain what happened.`,
    "科技产品": `Describe a technology scene where “${lemma}” would be a natural word choice.`,
    "公共服务": `Write one sentence about a public service situation where “${lemma}” fits naturally.`,
    "旅行途中": `Describe a travel moment where “${lemma}” would naturally describe the scene.`,
  };
  return prompts[topic] ?? `Describe a new situation where you could naturally use “${lemma}”.`;
}

function reviewRiskLabel(card: Pick<WordCard, "schedule" | "lapses">) {
  const overdue = card.schedule.nextDueAt
    ? Date.now() - new Date(card.schedule.nextDueAt).getTime()
    : 0;
  if (card.lapses >= 2 || overdue > 3 * 86_400_000) return "高";
  if (card.lapses > 0 || overdue > 0) return "中";
  return "低";
}

function Review({
  card,
  phase,
  input,
  setInput,
  feedback,
  revealed,
  pendingRating,
  evaluation,
  definitionEn,
  evaluating,
  sessionDone,
  complete,
  context,
  onEvaluate,
  onRate,
  onContinue,
  onSeedDemo,
}: {
  card: WordCard | null;
  phase: ReviewPhase;
  input: string;
  setInput: (v: string) => void;
  feedback: string | null;
  revealed: boolean;
  pendingRating: ReviewRating | null;
  evaluation: ReviewEvaluation | null;
  definitionEn?: string;
  evaluating: boolean;
  sessionDone: number;
  complete: boolean;
  context?: string;
  onEvaluate: () => void;
  onRate: (rating: ReviewRating) => void;
  onContinue: () => void;
  onSeedDemo: () => void;
}) {
  if (!card)
    return (
      <section className="page-view panel review-empty">
        <span className="review-empty-mark" aria-hidden="true">
          {complete ? "✓" : "·"}
        </span>
        <h2>{complete ? "本轮复习完成" : "复习队列为空"}</h2>
        <p className="lede" style={{ marginTop: 8 }}>
          {complete
            ? `已处理 ${sessionDone} 张词卡。高风险词会优先在下一次到期时回来。`
            : "完成一篇阅读后，词卡会进入自适应复习队列。"}
        </p>
        {!complete && (
          <div className="review-demo-actions">
            <button type="button" className="button" onClick={onSeedDemo}>
              载入随机体验组
            </button>
            <small>仅写入本机，包含 Lv1–Lv4 各一张词卡</small>
          </div>
        )}
      </section>
    );
  const level = getMasteryLevel(card);
  const topic = migrationTopic(card, card.correct);
  const englishDefinition = definitionEn ?? "an English meaning is not available for this imported word yet";
  const prompt = phase === "recognition"
    ? `先回到原来的场景，你还记得 “${card.lemma}” 在这里表达什么吗？`
    : phase === "semantic"
      ? `理解这个词：${card.lemma}`
      : phase === "generation"
        ? `Describe a situation where you could naturally use “${card.lemma}”.`
        : migrationPrompt(card.lemma, topic);
  const ratingOptions: Array<{ rating: ReviewRating; label: string; note: string }> = [
    { rating: "known", label: "认识", note: "我能理解并调用" },
    { rating: "fuzzy", label: "模糊", note: "有印象但不稳定" },
    { rating: "forgot", label: "忘记", note: "需要重新学习" },
  ];
  return (
    <section className="page-view panel review-session">
      <div className="review-session-head">
        <div>
          <p className="eyebrow">Review / 自适应复习</p>
          <span className="review-stage-badge">{phaseLabel(phase)}</span>
        </div>
        <span className="small muted">本轮已完成 {sessionDone}</span>
      </div>
      <div className="review-ladder" aria-label="词汇掌握阶段">
        {["Lv0 初见", "Lv1 识别", "Lv2 理解", "Lv3 调用", "Lv4 融入"].map((label, index) => (
          <span key={label} className={index <= level ? "active" : ""}>{label}</span>
        ))}
      </div>
      <p className="review-card-meta">
        第 {card.planDay ?? "未分配"} 天 · {card.sourceTitle ?? "语境词卡"} · 当前风险 {reviewRiskLabel(card)} · 下次
        {card.schedule.nextDueAt
          ? new Date(card.schedule.nextDueAt).toLocaleDateString("zh-CN")
          : "待安排"}
      </p>
      <h1 className="review-prompt-title">{prompt}</h1>
      {phase === "recognition" && context && (
        <p className="small muted" style={{ marginTop: 10 }}>
          原始语境：{context}
        </p>
      )}
      {phase === "semantic" && (
        <div className="semantic-definition">
          <span>English meaning</span>
          <strong>{englishDefinition}</strong>
          <small>暂不显示中文，先判断你是否能从英文释义理解它。</small>
        </div>
      )}
      {(phase === "generation" || phase === "transfer") && (
        <>
          {phase === "transfer" && <span className="review-topic-chip">迁移场景 · {topic}</span>}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="写一句完整、自然的英文句子……"
            className="review-answer-input"
            disabled={Boolean(evaluation)}
          />
          {!evaluation && <button className="button" style={{ marginTop: 14 }} onClick={onEvaluate} disabled={!input.trim() || evaluating}>{evaluating ? "正在检查表达…" : "检查这句话"}</button>}
          {evaluation && (
            <div className={`review-evaluation ${evaluation.passed ? "passed" : "failed"}`}>
              <strong>{evaluation.passed ? "表达自然度通过" : "还需要调整"} · {evaluation.score}分</strong>
              <p>{evaluation.feedback}</p>
              {evaluation.correction && <small>参考改写：{evaluation.correction}</small>}
            </div>
          )}
        </>
      )}
      <div className="review-rating-block">
        <span className="small muted">这次你对这个词的真实感觉</span>
        <div className="rating-grid rating-grid-three" role="group" aria-label="选择认识程度">
          {ratingOptions.map((option) => (
            <button
              type="button"
              key={option.rating}
              className={`rating-option rating-${option.rating} ${pendingRating === option.rating ? "selected" : ""}`}
              onClick={() => onRate(option.rating)}
              disabled={phase === "generation" || phase === "transfer" ? !evaluation : false}
            >
              <strong>{option.label}</strong>
              <small>{option.note}</small>
            </button>
          ))}
        </div>
      </div>
      {revealed && pendingRating && (
        <div className="review-reveal" aria-live="polite">
          <div className="answer-comparison">
            <div><span>词义确认</span><p>{card.meaningZh} · {card.partOfSpeech}</p></div>
            <div><span>自然搭配</span><p>{card.collocations[0] ?? `use ${card.lemma} in context`}</p></div>
          </div>
          <button className="button" style={{ marginTop: 14 }} onClick={onContinue}>继续下一个词</button>
        </div>
      )}
      {feedback && (
        <div className="hint" style={{ marginTop: 16 }}>
          {feedback}
        </div>
      )}
    </section>
  );
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

function buildPassage(
  words: string[],
  planning: PlanningMode = "topic",
): string {
  const seed =
    "Rain streaked the library window as a learner opened a worn notebook. Each term became a clue inside one unfolding argument. At dusk, the page still held a clear scene, making every word easier to recall.";
  if (!words.length) return seed;
  // 原则：同一篇短文里每个目标词只能出现一次。seed 里已含 adapt / allocate /
  // decline / evidence / maintain / resilient / sustainable / trend，尾部只列出
  // seed 中没出现过的词，避免同一个词在上面和下面各出现一次。
  const seedLower = seed.toLowerCase();
  const freshWords = words.filter((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`\\b${escaped}\\b`).test(seedLower);
  });
  if (!freshWords.length) return seed;
  const chunks = Array.from(
    { length: Math.ceil(freshWords.length / 3) },
    (_, index) => freshWords.slice(index * 3, index * 3 + 3),
  );
  const places = planning === "story"
    ? ["station map", "platform notice", "evening timetable", "conductor's notebook"]
    : ["city sketch", "policy note", "library display", "margin of the report"];
  const links = chunks.map((chunk, index) => {
    const terms = chunk.length === 1
      ? chunk[0]
      : `${chunk.slice(0, -1).join(", ")} and ${chunk.at(-1)}`;
    return `The learner connected ${terms} with a detail in the ${places[index % places.length]}, so the vocabulary served the idea rather than interrupting it.`;
  });
  return [
    planning === "story"
      ? "Rain streaked the station window as a learner opened a worn notebook while trains hummed beyond the glass."
      : "Rain streaked the library window as a learner opened a worn notebook while quiet footsteps crossed the hall.",
    ...links,
    "By dusk, the page had become a coherent scene and a usable argument, making each expression easier to recall in future writing.",
  ].join(" ");
}
