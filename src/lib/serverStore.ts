import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { StorageSnapshot } from "./storageTypes";

const COLLECTIONS = ["cards", "packs", "attempts", "known", "wordbooks", "sessions"] as const;
type Collection = (typeof COLLECTIONS)[number];

declare global {
  var __ieltsSqlite: Database.Database | undefined;
}

function databasePath() {
  const dataDirectory = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  return path.join(dataDirectory, "learning.sqlite");
}

function database() {
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
  `);
  globalThis.__ieltsSqlite = instance;
  return instance;
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

export function storageFilePath() {
  return databasePath();
}
