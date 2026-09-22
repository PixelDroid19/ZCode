import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryStoreError,
  type MemoryAccess,
  type MemoryForget,
  type MemoryRecord,
  type MemoryRevision,
  type MemorySave,
  type MemorySearch,
  type MemoryStorePort,
  type MemoryUpdate,
} from "@zcode/contracts";
import { forgetMemory, saveMemory, updateMemory } from "./mutations.js";
import { getRecord, getRecordHistory, searchRecords } from "./queries.js";
import { initializeExperienceMemoryDatabase, EXPERIENCE_MEMORY_BUSY_TIMEOUT_MS } from "./schema.js";
import { validateAccess, validateForget, validateSave, validateUpdate } from "./validation.js";

export interface SqliteMemoryStoreOptions {
  dbPath: string;
}

export class SqliteMemoryStore implements MemoryStorePort {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {}

  static async open(options: SqliteMemoryStoreOptions): Promise<SqliteMemoryStore> {
    if (
      !options ||
      typeof options.dbPath !== "string" ||
      options.dbPath.trim().length === 0 ||
      options.dbPath.length > 4_096
    ) {
      throw new MemoryStoreError("invalid", "dbPath must be a non-empty database path");
    }
    await mkdir(dirname(options.dbPath), { recursive: true });
    const db = new DatabaseSync(options.dbPath, { timeout: EXPERIENCE_MEMORY_BUSY_TIMEOUT_MS });
    try {
      initializeExperienceMemoryDatabase(db);
      return new SqliteMemoryStore(db);
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the initialization failure.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  async search(access: MemoryAccess, input: MemorySearch): Promise<MemoryRecord[]> {
    this.assertOpen();
    return searchRecords(this.db, access, input);
  }

  async get(access: MemoryAccess, id: string): Promise<MemoryRecord | undefined> {
    this.assertOpen();
    return getRecord(this.db, access, id);
  }

  async history(access: MemoryAccess, id: string, limit?: number): Promise<MemoryRevision[]> {
    this.assertOpen();
    return getRecordHistory(this.db, access, id, limit);
  }

  async save(access: MemoryAccess, input: MemorySave): Promise<MemoryRecord> {
    this.assertOpen();
    const validAccess = validateAccess(access);
    const validInput = validateSave(input);
    return saveMemory(this.db, validAccess, validInput);
  }

  async update(access: MemoryAccess, input: MemoryUpdate): Promise<MemoryRecord> {
    this.assertOpen();
    const validAccess = validateAccess(access);
    const validInput = validateUpdate(input);
    return updateMemory(this.db, validAccess, validInput);
  }

  async forget(access: MemoryAccess, input: MemoryForget): Promise<void> {
    this.assertOpen();
    const validAccess = validateAccess(access);
    const validInput = validateForget(input);
    forgetMemory(this.db, validAccess, validInput);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Experience memory store is closed");
  }
}
