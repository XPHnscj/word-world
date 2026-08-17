/**
 * 内置雅思词库（IELTS-4000 Academic Word List）。
 *
 * 词库源文件位于仓库根目录的 nglsh-master/IELTS-4000.txt，由服务端路由
 * /api/ielts-vocab 解析后提供给客户端。本模块包含：
 *   - parseIelts4000：纯函数解析器（可测试、可复用，服务端/客户端都能用）；
 *   - indexVocab：把词条数组转成 lemma -> definition 的查找表；
 *   - loadBuiltinVocab：客户端加载（服务端路由优先，失败回退 localStorage 缓存）。
 *
 * 文件格式：
 *   - 每行一个词条 "word: definition"；
 *   - 释义可能跨行，续行直接追加到上一个词条末尾；
 *   - 大写字母行（A、B、C…）是分组标题，前两行是文件头，均跳过。
 */

export interface IeltsEntry {
  lemma: string;
  definition: string;
}

const HEADER_LINES = new Set(["ielts", "4000 academic word list"]);

export function parseIelts4000(text: string): IeltsEntry[] {
  const entries: IeltsEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[A-Z]$/.test(line)) continue; // 字母分组标题
    if (HEADER_LINES.has(line.toLowerCase())) continue; // 文件头
    const match = /^([a-z][a-z'-]*):\s*(.*)$/.exec(line);
    if (match) {
      entries.push({ lemma: match[1], definition: match[2].trim() });
    } else {
      // 释义续行：追加到上一个词条
      const last = entries[entries.length - 1];
      if (last) last.definition = `${last.definition} ${line}`.trim();
    }
  }
  return entries.filter((entry) => entry.lemma && entry.definition);
}

export function indexVocab(entries: IeltsEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) map.set(entry.lemma, entry.definition);
  return map;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/**
 * 从未学词中随机抽取一组，并按首字母轮询，避免连续拿到整组 a/b 开头词。
 * random 可注入，便于稳定测试；生产环境默认使用 Math.random。
 */
export function pickDiverseVocabulary(
  entries: IeltsEntry[],
  excluded: ReadonlySet<string>,
  count: number,
  random: () => number = Math.random,
): string[] {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const lemma = entry.lemma.trim().toLowerCase();
    if (!lemma || excluded.has(lemma)) continue;
    const initial = lemma[0];
    const group = groups.get(initial) ?? [];
    group.push(lemma);
    groups.set(initial, group);
  }

  const queues = shuffled([...groups.entries()], random).map(([initial, words]) => ({
    initial,
    words: shuffled(words, random),
  }));
  const picked: string[] = [];
  while (picked.length < Math.max(0, count) && queues.length) {
    for (let index = queues.length - 1; index >= 0; index -= 1) {
      const word = queues[index].words.pop();
      if (word) picked.push(word);
      if (!queues[index].words.length) queues.splice(index, 1);
      if (picked.length >= count) break;
    }
  }
  return picked;
}

/**
 * 先消费用户标记的明日优先词，再用内置词库补齐每日名额。
 * 优先词也会从补齐候选中排除，确保超过每日上限时能顺延到后续学习日。
 */
export function pickPriorityThenDiverseVocabulary(
  priorityWords: readonly string[],
  entries: IeltsEntry[],
  excluded: ReadonlySet<string>,
  count: number,
  random: () => number = Math.random,
): string[] {
  const normalizedPriority = [...new Set(priorityWords.map((word) => word.trim().toLowerCase()))]
    .filter((word) => word && !excluded.has(word));
  const selectedPriority = normalizedPriority.slice(0, Math.max(0, count));
  const freshExcluded = new Set([...excluded, ...normalizedPriority]);
  const fresh = pickDiverseVocabulary(
    entries,
    freshExcluded,
    Math.max(0, count - selectedPriority.length),
    random,
  );
  return [...selectedPriority, ...fresh].slice(0, Math.max(0, count));
}

const STORAGE_KEY = "ielts-context-vocab-v1";
let sharedPromise: Promise<IeltsEntry[]> | null = null;

/**
 * 加载内置 IELTS 词库。同一会话内多次调用复用同一个请求；
 * 失败时回退到本地缓存，仍失败则返回空数组（界面按无内置词库处理）。
 */
export function loadBuiltinVocab(): Promise<IeltsEntry[]> {
  if (!sharedPromise) {
    sharedPromise = fetchBuiltinVocab().finally(() => {
      sharedPromise = null; // 允许后续调用重试
    });
  }
  return sharedPromise;
}

async function fetchBuiltinVocab(): Promise<IeltsEntry[]> {
  const cached = readCachedVocab();
  try {
    const response = await fetch("/api/ielts-vocab", { cache: "no-store" });
    if (!response.ok) return cached;
    const data = (await response.json()) as { entries?: IeltsEntry[] };
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) return cached;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* 存储满/不可用：忽略，缓存只是加速项 */
    }
    return entries;
  } catch {
    return cached;
  }
}

function readCachedVocab(): IeltsEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is IeltsEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as IeltsEntry).lemma === "string" &&
        typeof (item as IeltsEntry).definition === "string",
    );
  } catch {
    return [];
  }
}
