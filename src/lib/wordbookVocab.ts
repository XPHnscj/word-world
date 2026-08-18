import type { IeltsEntry } from "./ieltsVocab";

export interface WordbookVocabResponse {
  entries: IeltsEntry[];
  count: number;
  source: string | null;
}

/**
 * 解析 KyleBing simple TSV：word、translations、phrases。
 * 当前生成流程只需要 lemma 和可展示的释义，短语列由源文件保留但暂不注入提示词。
 */
export function parseSimpleTsv(text: string): IeltsEntry[] {
  const entries: IeltsEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").trimEnd();
    if (!line.trim()) continue;

    const [rawWord, rawTranslations = ""] = line.split("\t");
    const lemma = rawWord?.trim().toLowerCase();
    if (!lemma || !/^[a-z][a-z'-]*$/.test(lemma) || seen.has(lemma)) continue;

    const definition = rawTranslations
      .split("¦")
      .map((item) => item.replace(/^[^:]+::/, "").trim())
      .filter(Boolean)
      .join("；");
    if (!definition) continue;

    entries.push({ lemma, definition });
    seen.add(lemma);
  }

  return entries;
}

const cache = new Map<string, Promise<IeltsEntry[]>>();

/** 按需加载内置词书，避免打开应用时一次性读取十本词书。 */
export function loadWordbookVocab(wordbookId: string): Promise<IeltsEntry[]> {
  const existing = cache.get(wordbookId);
  if (existing) return existing;

  const promise = fetchWordbookVocab(wordbookId).finally(() => {
    cache.delete(wordbookId);
  });
  cache.set(wordbookId, promise);
  return promise;
}

async function fetchWordbookVocab(wordbookId: string): Promise<IeltsEntry[]> {
  const storageKey = `ielts-context-vocab-${wordbookId}-v1`;
  const cached = readCachedVocab(storageKey);
  try {
    const response = await fetch(`/api/wordbook-vocab?book=${encodeURIComponent(wordbookId)}`, {
      cache: "no-store",
    });
    if (!response.ok) return cached;
    const data = (await response.json()) as WordbookVocabResponse;
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) return cached;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // 缓存只是加速项，存储空间不足不应阻塞学习。
    }
    return entries;
  } catch {
    return cached;
  }
}

function readCachedVocab(storageKey: string): IeltsEntry[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
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
