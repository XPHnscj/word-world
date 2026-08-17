import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CapabilityDimension, DimensionState, LearningEvidence } from "./types";
import type { StorageSnapshot } from "./storageTypes";

const COLLECTIONS = ["cards", "packs", "attempts", "known", "wordbooks", "sessions"] as const;
type Collection = (typeof COLLECTIONS)[number];

declare global {
  var __ieltsSqlite: Database.Database | undefined;
}

function dataDirectory() {
  // 测试或特殊部署可用 IELTS_DATA_DIR 覆盖；默认项目目录 data/。
  const dir = process.env.IELTS_DATA_DIR?.trim() || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function databasePath() {
  return path.join(dataDirectory(), "learning.sqlite");
}

function backupsDirectory() {
  const dir = path.join(dataDirectory(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

/**
 * 增量持久化表：
 * - learning_events：不可变学习证据，只追加不覆盖；
 * - dimension_states：每张词卡每个能力维度的当前缓存状态；
 * - practice_tasks：已生成任务及其来源（计划节点/路由器/手动）；
 * - scheduler_state：调度参数与最近更新时间；
 * - schema_migrations：迁移版本记录。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS learning_events (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL,
          dimension TEXT NOT NULL,
          task_type TEXT NOT NULL,
          correct INTEGER NOT NULL,
          score INTEGER NOT NULL,
          confidence INTEGER NOT NULL,
          hint_level INTEGER NOT NULL,
          elapsed_ms INTEGER NOT NULL,
          answer TEXT,
          context_id TEXT,
          context_topic TEXT,
          evaluator TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS learning_events_card_idx ON learning_events(card_id, dimension);
        CREATE INDEX IF NOT EXISTS learning_events_created_idx ON learning_events(created_at);

        CREATE TABLE IF NOT EXISTS dimension_states (
          card_id TEXT NOT NULL,
          dimension TEXT NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (card_id, dimension)
        );

        CREATE TABLE IF NOT EXISTS practice_tasks (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL,
          dimension TEXT NOT NULL,
          task_type TEXT NOT NULL,
          source TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS practice_tasks_card_idx ON practice_tasks(card_id);

        CREATE TABLE IF NOT EXISTS scheduler_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
    },
  },
];

function database(): Database.Database {
  if (globalThis.__ieltsSqlite) return globalThis.__ieltsSqlite;
  const instance = new Database(databasePath());
  instance.pragma("journal_mode = WAL");
  instance.pragma("synchronous = NORMAL");
  instance.exec(`
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, record_id)
    );
    CREATE INDEX IF NOT EXISTS records_collection_idx ON records(collection);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  // 增量表与迁移：失败时抛明确错误，绝不创建空库覆盖旧数据。
  try {
    migrateDatabase(instance);
  } catch (error) {
    instance.close();
    globalThis.__ieltsSqlite = undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`学习数据库迁移失败，已保留原数据，未做任何覆盖：${message}`);
  }
  globalThis.__ieltsSqlite = instance;
  return instance;
}

/** 备份当前数据库（VACUUM INTO 生成一致快照，含 WAL 内容），返回备份文件路径。 */
export function backupDatabase(): string {
  const db = database();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupsDirectory(), `learning-${stamp}.sqlite`);
  vacuumInto(db, target);
  return target;
}

/** SQLite 字符串字面量必须用单引号；路径中的单引号按 SQL 规则转义。 */
function vacuumInto(db: Database.Database, target: string): void {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/** 按版本顺序应用未执行的迁移；每次迁移前自动备份，迁移在单一事务内完成。 */
function migrateDatabase(db: Database.Database): void {
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version),
  );
  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
  if (!pending.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupsDirectory(), `pre-migration-${stamp}.sqlite`);
  vacuumInto(db, backupPath);
  const apply = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    }
  });
  apply();
}

/** 当前迁移版本与最近备份文件（供设置页/启动诊断显示）。 */
export function storageMigrationInfo(): { version: number; backupsDirectory: string } {
  const db = database();
  const rows = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  return { version: rows.version ?? 0, backupsDirectory: backupsDirectory() };
}

function emptySnapshot(): StorageSnapshot {
  return { cards: [], packs: [], attempts: [], known: [], wordbooks: [], sessions: [] };
}

export function readStorageSnapshot(): StorageSnapshot {
  const rows = database().prepare("SELECT collection, value_json FROM records").all() as Array<{ collection: Collection; value_json: string }>;
  const snapshot = emptySnapshot();
  for (const row of rows) {
    if (!COLLECTIONS.includes(row.collection)) continue;
    try {
      snapshot[row.collection].push(JSON.parse(row.value_json) as never);
    } catch {
      // A malformed row must not hide every other local collection.
    }
  }
  return snapshot;
}

function recordsFor(snapshot: StorageSnapshot) {
  return COLLECTIONS.flatMap((collection) => snapshot[collection].map((value) => ({
    collection,
    record_id: String((value as { id?: string; lemma?: string }).id ?? (value as { lemma?: string }).lemma ?? crypto.randomUUID()),
    value_json: JSON.stringify(value),
  })));
}

export function replaceStorageSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  const db = database();
  const rows = recordsFor(snapshot);
  const now = new Date().toISOString();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM records").run();
    const insert = db.prepare("INSERT INTO records (collection, record_id, value_json, updated_at) VALUES (?, ?, ?, ?)");
    for (const row of rows) insert.run(row.collection, row.record_id, row.value_json, now);
  });
  replace();
  return readStorageSnapshot();
}

/** 追加不可变学习证据（同一事务内批量写入，不覆盖历史）。 */
export function appendLearningEvents(events: LearningEvidence[]): void {
  if (!events.length) return;
  const db = database();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO learning_events (
      id, card_id, dimension, task_type, correct, score, confidence,
      hint_level, elapsed_ms, answer, context_id, context_topic, evaluator, created_at
    ) VALUES (
      @id, @cardId, @dimension, @taskType, @correct, @score, @confidence,
      @hintLevel, @elapsedMs, @answer, @contextId, @contextTopic, @evaluator, @createdAt
    )
  `);
  const write = db.transaction((items: LearningEvidence[]) => {
    for (const event of items) {
      insert.run({
        id: event.id,
        cardId: event.cardId,
        dimension: event.dimension,
        taskType: event.taskType,
        correct: event.correct ? 1 : 0,
        score: Math.round(event.score),
        confidence: event.confidence,
        hintLevel: event.hintLevel,
        elapsedMs: Math.round(event.elapsedMs),
        answer: event.answer ?? null,
        contextId: event.contextId ?? null,
        contextTopic: event.contextTopic ?? null,
        evaluator: event.evaluator,
        createdAt: event.createdAt,
      });
    }
  });
  write(events);
}

export function readLearningEvents(cardId?: string): LearningEvidence[] {
  const db = database();
  const rows = cardId
    ? (db.prepare("SELECT * FROM learning_events WHERE card_id = ? ORDER BY created_at ASC").all(cardId) as unknown[])
    : (db.prepare("SELECT * FROM learning_events ORDER BY created_at ASC").all() as unknown[]);
  return rows.map((row) => rowToEvidence(row as Record<string, unknown>));
}

function rowToEvidence(row: Record<string, unknown>): LearningEvidence {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    dimension: String(row.dimension) as CapabilityDimension,
    taskType: String(row.task_type),
    correct: Boolean(row.correct),
    score: Number(row.score),
    confidence: Number(row.confidence),
    hintLevel: Number(row.hint_level) as LearningEvidence["hintLevel"],
    elapsedMs: Number(row.elapsed_ms),
    answer: row.answer == null ? undefined : String(row.answer),
    contextId: row.context_id == null ? undefined : String(row.context_id),
    contextTopic: row.context_topic == null ? undefined : String(row.context_topic),
    evaluator: String(row.evaluator) as LearningEvidence["evaluator"],
    createdAt: String(row.created_at),
  };
}

/** 写入某词卡某维度的当前状态缓存（按 (cardId, dimension) 覆盖）。 */
export function upsertDimensionState(cardId: string, dimension: CapabilityDimension, state: DimensionState): void {
  database()
    .prepare(`
      INSERT INTO dimension_states (card_id, dimension, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(card_id, dimension) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `)
    .run(cardId, dimension, JSON.stringify(state), new Date().toISOString());
}

export function readDimensionStates(): Array<{ cardId: string; dimension: CapabilityDimension; state: DimensionState }> {
  const rows = database().prepare("SELECT card_id, dimension, state_json FROM dimension_states").all() as Array<{
    card_id: string;
    dimension: string;
    state_json: string;
  }>;
  return rows.map((row) => ({
    cardId: row.card_id,
    dimension: row.dimension as CapabilityDimension,
    state: JSON.parse(row.state_json) as DimensionState,
  }));
}

export function storageFilePath() {
  return databasePath();
}
