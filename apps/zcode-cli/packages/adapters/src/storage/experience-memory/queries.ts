import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_SEARCH_LIMIT,
  type MemoryAccess,
  type MemoryRecord,
  type MemoryRevision,
  type MemorySearch,
} from "@zcode/contracts";
import {
  decodeRecord,
  sqlNullableString,
  sqlNumber,
  sqlString,
  throwIfAborted,
} from "./internal.js";
import { readVisibleRecord } from "./repository.js";
import {
  validateAccess,
  validateHistoryLimit,
  validateQueryTokens,
  validateRecordId,
  validateSearch,
} from "./validation.js";

export function searchRecords(
  db: DatabaseSync,
  rawAccess: MemoryAccess,
  rawInput: MemorySearch,
): MemoryRecord[] {
  const access = validateAccess(rawAccess);
  const input = validateSearch(rawInput);
  throwIfAborted(access);
  const limit = input.limit ?? MEMORY_SEARCH_LIMIT;
  const tokens = validateQueryTokens(input.query);
  const hasQuery = Boolean(input.query?.trim());
  if (hasQuery && tokens.length === 0) return [];
  const where: string[] = [
    "((memory_records.scope = 'project' AND memory_records.project_key = ?) OR memory_records.scope = 'user')",
  ];
  const params: (string | number)[] = [access.projectKey];

  if (input.scope === "project") where.push("memory_records.scope = 'project'");
  if (input.scope === "user") where.push("memory_records.scope = 'user'");
  if (!input.includeInactive) where.push("memory_records.status = 'active'");

  const indexJoin = hasQuery ? "JOIN memory_fts ON memory_fts.record_id = memory_records.id" : "";
  if (hasQuery) {
    where.push("memory_fts MATCH ?");
    params.push(tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR "));
  }
  params.push(limit);
  const ordering = hasQuery
    ? "bm25(memory_fts) ASC, memory_records.updated_at DESC, memory_records.id ASC"
    : "memory_records.updated_at DESC, memory_records.id ASC";
  const rows = db
    .prepare(
      `SELECT memory_records.record_json FROM memory_records ${indexJoin}
       WHERE ${where.join(" AND ")} ORDER BY ${ordering} LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => decodeRecord(sqlString(row, "record_json")));
}

export function getRecord(
  db: DatabaseSync,
  rawAccess: MemoryAccess,
  rawId: string,
): MemoryRecord | undefined {
  const access = validateAccess(rawAccess);
  const id = validateRecordId(rawId);
  throwIfAborted(access);
  return readVisibleRecord(db, access, id);
}

export function getRecordHistory(
  db: DatabaseSync,
  rawAccess: MemoryAccess,
  rawId: string,
  rawLimit?: number,
): MemoryRevision[] {
  const access = validateAccess(rawAccess);
  const id = validateRecordId(rawId);
  const limit = validateHistoryLimit(rawLimit);
  throwIfAborted(access);
  if (!readVisibleRecord(db, access, id)) return [];

  const rows = db
    .prepare(
      `SELECT revision, operation, reason, session_id, record_json
       FROM memory_revisions WHERE record_id = ? ORDER BY revision DESC LIMIT ?`,
    )
    .all(id, limit);
  return rows
    .map((row) => ({
      revision: sqlNumber(row, "revision"),
      operation: parseRevisionOperation(sqlString(row, "operation")),
      ...(sqlNullableString(row, "reason") ? { reason: sqlNullableString(row, "reason")! } : {}),
      sessionId: sqlString(row, "session_id"),
      record: decodeRecord(sqlString(row, "record_json")),
    }))
    .reverse();
}

function parseRevisionOperation(value: string): MemoryRevision["operation"] {
  if (value === "save" || value === "update" || value === "supersede") return value;
  throw new Error("SQLite contained an unknown memory revision operation");
}
