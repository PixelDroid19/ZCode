import type { DatabaseSync } from "node:sqlite";

export const EXPERIENCE_MEMORY_SCHEMA_VERSION = 1;
export const EXPERIENCE_MEMORY_BUSY_TIMEOUT_MS = 5_000;

export function initializeExperienceMemoryDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${EXPERIENCE_MEMORY_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  const journalMode = db.prepare("PRAGMA journal_mode = WAL").get() as
    | { journal_mode?: string }
    | undefined;
  if (journalMode?.journal_mode?.toLowerCase() !== "wal") {
    throw new Error("Experience memory SQLite database could not enable WAL mode");
  }

  const currentVersion = readSchemaVersion(db);
  if (currentVersion > EXPERIENCE_MEMORY_SCHEMA_VERSION) {
    throw new Error(
      `Experience memory schema ${currentVersion} is newer than supported schema ${EXPERIENCE_MEMORY_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === EXPERIENCE_MEMORY_SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const lockedVersion = readSchemaVersion(db);
    if (lockedVersion > EXPERIENCE_MEMORY_SCHEMA_VERSION) {
      throw new Error(
        `Experience memory schema ${lockedVersion} is newer than supported schema ${EXPERIENCE_MEMORY_SCHEMA_VERSION}`,
      );
    }
    if (lockedVersion === 0) {
      assertNoUnversionedTables(db);
      createInitialSchema(db);
      db.exec(`PRAGMA user_version = ${EXPERIENCE_MEMORY_SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the schema error that caused the rollback.
    }
    throw error;
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Experience memory SQLite schema version is invalid");
  }
  return version;
}

function assertNoUnversionedTables(db: DatabaseSync): void {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get() as { name?: string } | undefined;
  if (row?.name) {
    throw new Error("Experience memory database contains unversioned tables");
  }
}

function createInitialSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('project', 'user')),
      project_key TEXT,
      origin_project_key TEXT NOT NULL,
      topic_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      CHECK ((scope = 'project' AND project_key IS NOT NULL) OR
             (scope = 'user' AND project_key IS NULL))
    );
    CREATE UNIQUE INDEX memory_records_active_topic
      ON memory_records(scope, ifnull(project_key, ''), topic_key)
      WHERE status = 'active';
    CREATE INDEX memory_records_recent
      ON memory_records(scope, project_key, status, updated_at DESC);

    CREATE TABLE memory_revisions (
      record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      operation TEXT NOT NULL CHECK (operation IN ('save', 'update', 'supersede')),
      reason TEXT,
      session_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (record_id, revision)
    );
    CREATE TABLE memory_supersede_links (
      old_record_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
      new_record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      CHECK (old_record_id <> new_record_id)
    );
    CREATE TABLE memory_evidence_sources (
      record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('tool', 'user')),
      session_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (record_id, kind, session_id, source_id)
    );

    CREATE VIRTUAL TABLE memory_fts USING fts5(
      record_id UNINDEXED,
      search_text,
      tokenize = 'unicode61'
    );

    CREATE TABLE memory_mutation_receipts (
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, operation_id)
    );
    CREATE TABLE memory_receipt_records (
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, operation_id, record_id),
      FOREIGN KEY (session_id, operation_id)
        REFERENCES memory_mutation_receipts(session_id, operation_id) ON DELETE CASCADE
    );
    CREATE TABLE memory_operation_tombstones (
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, operation_id)
    );
  `);
}
