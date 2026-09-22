import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { MemoryAccess, MemoryRecord } from "@zcode/contracts";

export function throwIfAborted(access: MemoryAccess): void {
  if (!access.signal?.aborted) return;
  throw access.signal.reason instanceof Error
    ? access.signal.reason
    : new Error("Experience memory operation cancelled");
}

export function runWriteTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original storage or validation failure.
    }
    throw error;
  }
}

export function encodeRecord(record: MemoryRecord): string {
  return JSON.stringify(record);
}

export function decodeRecord(json: string): MemoryRecord {
  return JSON.parse(json) as MemoryRecord;
}

export function recordSearchText(record: MemoryRecord): string {
  return [
    record.content.topicKey,
    record.content.kind,
    record.content.title,
    record.content.summary,
    record.content.problem,
    record.content.resolution,
    record.content.rationale,
    record.content.applicability,
    ...record.content.tags,
    ...record.evidence.map((item) => item.summary),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export type SqlRow = Record<string, SQLOutputValue>;

export function sqlString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`SQLite column ${column} was not text`);
  return value;
}

export function sqlNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value !== null && typeof value !== "string") {
    throw new Error(`SQLite column ${column} was not nullable text`);
  }
  return value;
}

export function sqlNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`SQLite column ${column} was not numeric`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`SQLite column ${column} was outside the safe range`);
  return number;
}
