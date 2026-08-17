import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendLearningEvents,
  backupDatabase,
  readDimensionStates,
  readLearningEvents,
  readStorageSnapshot,
  replaceStorageSnapshot,
  storageMigrationInfo,
  upsertDimensionState,
} from "./serverStore";
import type { LearningEvidence } from "./types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ielts-sqlite-test-"));
  process.env.IELTS_DATA_DIR = dir;
  delete (globalThis as { __ieltsSqlite?: unknown }).__ieltsSqlite;
});
afterEach(() => {
  const handle = (globalThis as { __ieltsSqlite?: { close: () => void } }).__ieltsSqlite;
  if (handle) {
    try {
      handle.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
  delete (globalThis as { __ieltsSqlite?: unknown }).__ieltsSqlite;
  delete process.env.IELTS_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const event = (id: string, overrides: Partial<LearningEvidence> = {}): LearningEvidence => ({
  id,
  cardId: "card_flash",
  dimension: "spelling",
  taskType: "spell",
  correct: true,
  score: 100,
  confidence: 4,
  hintLevel: 0,
  elapsedMs: 1200,
  contextId: "pack_1",
  contextTopic: "摄影现场",
  evaluator: "local",
  createdAt: "2026-08-10T00:00:00.000Z",
  ...overrides,
});

describe("serverStore incremental evidence storage", () => {
  it("applies the first migration with a backup and records the version", () => {
    const info = storageMigrationInfo();
    expect(info.version).toBe(1);
    const backups = fs.readdirSync(path.join(dir, "backups"));
    expect(backups.some((name) => name.startsWith("pre-migration-"))).toBe(true);
  });

  it("appends learning events without overwriting history", () => {
    appendLearningEvents([event("e1"), event("e2", { correct: false, dimension: "meaningRecall" })]);
    appendLearningEvents([event("e3", { taskType: "meaning" })]);
    expect(readLearningEvents()).toHaveLength(3);
    expect(readLearningEvents("card_flash")).toHaveLength(3);
    expect(readLearningEvents("card_other")).toHaveLength(0);
  });

  it("persists and updates the dimension state cache", () => {
    const base = {
      strength: 0.6,
      stability: 4,
      difficulty: 3,
      nextDueAt: null,
      evidenceCount: 2,
      lastSuccessAt: null,
      lastHintFreeSuccessAt: null,
    };
    upsertDimensionState("card_flash", "spelling", base);
    upsertDimensionState("card_flash", "spelling", {
      ...base,
      strength: 0.8,
      stability: 8,
      evidenceCount: 3,
      lastSuccessAt: "2026-08-10T00:00:00.000Z",
      lastHintFreeSuccessAt: "2026-08-10T00:00:00.000Z",
      nextDueAt: "2026-08-20T00:00:00.000Z",
    });
    const states = readDimensionStates();
    expect(states).toHaveLength(1);
    expect(states[0].state.strength).toBe(0.8);
    expect(states[0].state.evidenceCount).toBe(3);
  });

  it("keeps snapshot replace working alongside incremental tables", () => {
    replaceStorageSnapshot({ cards: [], packs: [], attempts: [], known: [], wordbooks: [], sessions: [] });
    appendLearningEvents([event("e1")]);
    expect(readStorageSnapshot().cards).toHaveLength(0);
    expect(readLearningEvents()).toHaveLength(1);
  });

  it("creates a consistent VACUUM backup file on demand", () => {
    appendLearningEvents([event("e1")]);
    const backupPath = backupDatabase();
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);
  });
});
