import { NextResponse } from "next/server";
import { appendLearningEvents, readLearningEvents } from "@/lib/serverStore";
import type { LearningEvidence } from "@/lib/types";
import { CAPABILITY_DIMENSIONS } from "@/lib/reviewEngine";

export const runtime = "nodejs";

function isEvidence(value: unknown): value is LearningEvidence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.cardId === "string" &&
    typeof candidate.dimension === "string" && CAPABILITY_DIMENSIONS.includes(candidate.dimension as LearningEvidence["dimension"]) &&
    typeof candidate.taskType === "string" &&
    typeof candidate.correct === "boolean" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.score === "number" && candidate.score >= 0 && candidate.score <= 100 &&
    typeof candidate.confidence === "number" && candidate.confidence >= 1 && candidate.confidence <= 5 &&
    typeof candidate.hintLevel === "number" && candidate.hintLevel >= 0 && candidate.hintLevel <= 5 &&
    typeof candidate.elapsedMs === "number" && candidate.elapsedMs >= 0
  );
}

export async function GET(request: Request) {
  const cardId = new URL(request.url).searchParams.get("cardId")?.slice(0, 200) || undefined;
  try {
    return NextResponse.json({ events: readLearningEvents(cardId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: { code: "STORE_ERROR", message } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { events?: unknown[] } | null;
  if (!body || !Array.isArray(body.events)) {
    return NextResponse.json({ error: { code: "INVALID_EVENTS", message: "学习证据格式无效。" } }, { status: 422 });
  }
  const events = body.events.filter(isEvidence).slice(0, 200);
  if (!events.length) {
    return NextResponse.json({ error: { code: "INVALID_EVENTS", message: "没有可保存的有效学习证据。" } }, { status: 422 });
  }
  try {
    appendLearningEvents(events);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: { code: "STORE_ERROR", message } }, { status: 500 });
  }
  return NextResponse.json({ saved: events.length });
}
