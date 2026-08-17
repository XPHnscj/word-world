import { NextResponse } from "next/server";
import { readStorageSnapshot, replaceStorageSnapshot } from "@/lib/serverStore";
import type { StorageSnapshot } from "@/lib/storageTypes";

export const runtime = "nodejs";

function isSnapshot(value: unknown): value is StorageSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["cards", "packs", "attempts", "known", "wordbooks", "sessions"].every((key) => Array.isArray(candidate[key]));
}

export async function GET() {
  return NextResponse.json({ snapshot: readStorageSnapshot() });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  if (!isSnapshot(body)) {
    return NextResponse.json({ error: { code: "INVALID_SNAPSHOT", message: "本地学习数据格式无效。" } }, { status: 422 });
  }
  return NextResponse.json({ snapshot: replaceStorageSnapshot(body) });
}
