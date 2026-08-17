import { NextResponse } from "next/server";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseIelts4000, type IeltsEntry } from "@/lib/ieltsVocab";

export interface IeltsVocabResponse {
  entries: IeltsEntry[];
  count: number;
  source: string | null;
}

/** 词库源文件候选路径：优先仓库内的 nglsh-master 词库。 */
const CANDIDATE_PATHS = [
  path.join(process.cwd(), "nglsh-master", "IELTS-4000.txt"),
  path.join(process.cwd(), "IELTS-4000.txt"),
];

let cache: { key: string; entries: IeltsEntry[] } | null = null;

/**
 * 只读词库接口：解析 nglsh-master/IELTS-4000.txt 并返回词条列表。
 * 解析结果按文件 mtime + size 做进程内缓存，词库文件更新后自动重新解析。
 */
export async function GET(): Promise<NextResponse<IeltsVocabResponse>> {
  for (const file of CANDIDATE_PATHS) {
    try {
      const stat = statSync(file);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (!cache || cache.key !== key) {
        cache = { key, entries: parseIelts4000(readFileSync(file, "utf8")) };
      }
      return NextResponse.json({
        entries: cache.entries,
        count: cache.entries.length,
        source: file,
      });
    } catch {
      // try the next candidate path
    }
  }
  return NextResponse.json(
    { entries: [], count: 0, source: null },
    { status: 404 },
  );
}
