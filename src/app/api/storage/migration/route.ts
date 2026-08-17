import { NextResponse } from "next/server";
import { storageMigrationInfo } from "@/lib/serverStore";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(storageMigrationInfo());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: { code: "MIGRATION_FAILED", message } }, { status: 500 });
  }
}
