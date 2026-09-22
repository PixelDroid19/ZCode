import type { DatabaseSync } from "node:sqlite";
import type { MemoryAccess, MemoryRecord, MemoryRevision, MemoryScope } from "@zcode/contracts";
import { decodeRecord, encodeRecord, recordSearchText, sqlString } from "./internal.js";

export function readRecord(db: DatabaseSync, id: string): MemoryRecord | undefined {
  const row = db.prepare("SELECT record_json FROM memory_records WHERE id = ?").get(id);
  return row ? decodeRecord(sqlString(row, "record_json")) : undefined;
}

export function readVisibleRecord(
  db: DatabaseSync,
  access: MemoryAccess,
  id: string,
): MemoryRecord | undefined {
  const record = readRecord(db, id);
  if (record?.scope === "project" && record.projectKey !== access.projectKey) return undefined;
  return record;
}

export function findActiveTopic(
  db: DatabaseSync,
  scope: MemoryScope,
  projectKey: string | null,
  topicKey: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM memory_records
       WHERE scope = ? AND ifnull(project_key, '') = ifnull(?, '')
         AND topic_key = ? AND status = 'active' LIMIT 1`,
    )
    .get(scope, projectKey, topicKey);
  return row ? sqlString(row, "id") : undefined;
}

export function readEvidenceSourceKeys(db: DatabaseSync, recordId: string): Set<string> {
  const rows = db
    .prepare(
      `WITH RECURSIVE lineage(record_id) AS (
         SELECT ?
         UNION
         SELECT links.old_record_id FROM memory_supersede_links AS links
         JOIN lineage ON links.new_record_id = lineage.record_id
       )
       SELECT sources.kind, sources.session_id, sources.source_id FROM lineage
       JOIN memory_evidence_sources AS sources ON sources.record_id = lineage.record_id`,
    )
    .all(recordId);
  return new Set(
    rows.map((row) => {
      const kind = sqlString(row, "kind");
      if (kind !== "tool" && kind !== "user") {
        throw new Error("SQLite contained an unknown memory evidence source kind");
      }
      return evidenceSourceKey(kind, sqlString(row, "session_id"), sqlString(row, "source_id"));
    }),
  );
}

export function evidenceSourceKey(kind: string, sessionId: string, sourceId: string): string {
  return JSON.stringify([kind, sessionId, sourceId]);
}

export function insertSupersedeLink(
  db: DatabaseSync,
  oldRecordId: string,
  newRecordId: string,
): void {
  db.prepare("INSERT INTO memory_supersede_links(old_record_id, new_record_id) VALUES (?, ?)").run(
    oldRecordId,
    newRecordId,
  );
}

export function insertCurrentRecord(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare(
    `INSERT INTO memory_records
      (id, scope, project_key, origin_project_key, topic_key, status, revision, updated_at, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.scope,
    record.projectKey,
    record.originProjectKey,
    record.content.topicKey,
    record.status,
    record.revision,
    record.updatedAt,
    encodeRecord(record),
  );
  insertFtsRow(db, record);
  persistEvidenceSources(db, record);
}

export function updateCurrentRecord(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare(
    `UPDATE memory_records SET topic_key = ?, status = ?, revision = ?, updated_at = ?, record_json = ?
     WHERE id = ?`,
  ).run(
    record.content.topicKey,
    record.status,
    record.revision,
    record.updatedAt,
    encodeRecord(record),
    record.id,
  );
  replaceFtsRow(db, record);
  persistEvidenceSources(db, record);
}

export function appendRevision(db: DatabaseSync, revision: MemoryRevision): void {
  db.prepare(
    `INSERT INTO memory_revisions
      (record_id, revision, operation, reason, session_id, record_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    revision.record.id,
    revision.revision,
    revision.operation,
    revision.reason ?? null,
    revision.sessionId,
    encodeRecord(revision.record),
  );
}

export function replaceFtsRow(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare("DELETE FROM memory_fts WHERE record_id = ?").run(record.id);
  insertFtsRow(db, record);
}

function insertFtsRow(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare("INSERT INTO memory_fts (record_id, search_text) VALUES (?, ?)").run(
    record.id,
    recordSearchText(record),
  );
}

function persistEvidenceSources(db: DatabaseSync, record: MemoryRecord): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_evidence_sources(record_id, kind, session_id, source_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const item of record.evidence) {
    const sourceId =
      item.kind === "tool" ? item.toolCallId : item.kind === "user" ? item.messageId : undefined;
    if (!sourceId) continue;
    insert.run(record.id, item.kind, item.sessionId, sourceId);
  }
}
