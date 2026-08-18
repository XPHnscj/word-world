import { NextResponse } from "next/server";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getBuiltinWordbook } from "@/lib/builtinWordbooks";
import { parseSimpleTsv, type WordbookVocabResponse } from "@/lib/wordbookVocab";

const cache = new Map<string, { key: string; entries: WordbookVocabResponse["entries"] }>();

export async function GET(request: Request): Promise<NextResponse<WordbookVocabResponse | { error: string }>> {
  const bookId = new URL(request.url).searchParams.get("book") ?? "";
  const book = getBuiltinWordbook(bookId);
  if (!book) {
    return NextResponse.json({ error: "未知的内置词书" }, { status: 404 });
  }

  const file = path.join(process.cwd(), book.sourcePath);
  try {
    const stat = statSync(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    let record = cache.get(book.id);
    if (!record || record.key !== key) {
      record = { key, entries: parseSimpleTsv(readFileSync(file, "utf8")) };
      cache.set(book.id, record);
    }
    return NextResponse.json({ entries: record.entries, count: record.entries.length, source: file });
  } catch {
    return NextResponse.json({ error: "词书文件不存在或无法读取" }, { status: 404 });
  }
}

