import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_EVIDENCE_LIMIT,
  MemoryStoreError,
  type MemoryAccess,
  type MemoryEvidence,
  type MemoryForget,
  type MemoryOutcome,
  type MemoryRecord,
  type MemorySave,
  type MemoryUpdate,
} from "@zcode/contracts";
import { nowIso, runWriteTransaction, sqlString, throwIfAborted } from "./internal.js";
import {
  appendRevision,
  evidenceSourceKey,
  findActiveTopic,
  insertCurrentRecord,
  insertSupersedeLink,
  readEvidenceSourceKeys,
  readVisibleRecord,
  updateCurrentRecord,
} from "./repository.js";
import { validateOutcomeEvidence } from "./validation.js";

interface ReceiptRow {
  payload_hash: string;
  result_json: string;
}

interface OperationTombstoneRow {
  payload_hash: string;
}

type ReplayCheck = { found: false } | { found: true; resultJson: string };

export function saveMemory(
  db: DatabaseSync,
  access: MemoryAccess,
  input: MemorySave,
): MemoryRecord {
  throwIfAborted(access);
  const payloadHash = fingerprint("save", access, input);
  return runWriteTransaction(db, () => {
    const replay = findReplay(db, access, input.operationId, payloadHash);
    if (replay.found) return JSON.parse(replay.resultJson) as MemoryRecord;

    const outcome = input.outcome ?? "recorded";
    const evidence = input.evidence ?? [];
    validateOutcomeEvidence(outcome, evidence);
    const id = randomUUID();
    const projectKey = input.scope === "project" ? access.projectKey : null;
    let superseded: MemoryRecord | undefined;
    if (input.supersedes) {
      superseded = readVisibleRecord(db, access, input.supersedes.id);
      if (!superseded) {
        throw new MemoryStoreError("not_found", "Memory record to supersede was not found");
      }
      if (
        superseded.scope !== input.scope ||
        superseded.projectKey !== projectKey ||
        superseded.status !== "active"
      ) {
        throw new MemoryStoreError(
          "conflict",
          "Only an active record in the same scope can be superseded",
          superseded.id,
        );
      }
      assertExpectedRevision(superseded, input.supersedes.expectedRevision);
      if (outcome === "tests_passed" || outcome === "user_confirmed") {
        rejectReusedProof(readEvidenceSourceKeys(db, superseded.id), evidence, outcome);
      }
      const supersededAt = nowIso();
      superseded = {
        ...superseded,
        revision: superseded.revision + 1,
        status: "superseded",
        supersededBy: id,
        updatedAt: supersededAt,
      };
      updateCurrentRecord(db, superseded);
      appendRevision(db, {
        revision: superseded.revision,
        operation: "supersede",
        reason: `Superseded by ${id}`,
        sessionId: access.sessionId,
        record: superseded,
      });
    }

    const duplicateId = findActiveTopic(db, input.scope, projectKey, input.content.topicKey);
    if (duplicateId) {
      throw new MemoryStoreError(
        "conflict",
        "An active memory already uses this topic",
        duplicateId,
      );
    }

    const createdAt = nowIso();
    const record: MemoryRecord = {
      id,
      scope: input.scope,
      projectKey,
      originProjectKey: access.projectKey,
      originSessionId: access.sessionId,
      ...(access.agentId ? { authorAgentId: access.agentId } : {}),
      content: input.content,
      outcome,
      evidence,
      revision: 1,
      status: "active",
      ...(input.reviewAfter ? { reviewAfter: input.reviewAfter } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    insertCurrentRecord(db, record);
    if (superseded) insertSupersedeLink(db, superseded.id, record.id);
    appendRevision(db, {
      revision: 1,
      operation: "save",
      sessionId: access.sessionId,
      record,
    });
    writeReceipt(db, access, input.operationId, payloadHash, record, [
      record.id,
      ...(superseded ? [superseded.id] : []),
    ]);
    return record;
  });
}

export function updateMemory(
  db: DatabaseSync,
  access: MemoryAccess,
  input: MemoryUpdate,
): MemoryRecord {
  throwIfAborted(access);
  const payloadHash = fingerprint("update", access, input);
  return runWriteTransaction(db, () => {
    const replay = findReplay(db, access, input.operationId, payloadHash);
    if (replay.found) return JSON.parse(replay.resultJson) as MemoryRecord;

    const current = readVisibleRecord(db, access, input.id);
    if (!current) throw new MemoryStoreError("not_found", "Memory record was not found");
    if (current.status !== "active") {
      throw new MemoryStoreError("conflict", "A superseded memory cannot be updated", current.id);
    }
    assertExpectedRevision(current, input.expectedRevision);

    if (isAlreadyAppliedEvidenceUpdate(current, input)) {
      // 提取重试可能把预期修订更新到当前值；相同证据和状态不应再次追加历史。
      writeReceipt(db, access, input.operationId, payloadHash, current, [current.id]);
      return current;
    }

    const content = input.content ?? current.content;
    const contentChanged = stableStringify(content) !== stableStringify(current.content);
    const defaultedOutcome: MemoryOutcome = contentChanged
      ? current.outcome === "failed" || current.outcome === "recurring"
        ? "attempted"
        : content.kind === "fact" || content.kind === "preference"
          ? "recorded"
          : "attempted"
      : current.outcome;
    const outcome = input.outcome ?? defaultedOutcome;
    const addedEvidence = input.evidence ?? [];
    const evidence = [...current.evidence, ...addedEvidence].slice(-MEMORY_EVIDENCE_LIMIT);

    if (
      (current.outcome === "failed" || current.outcome === "recurring") &&
      !["attempted", "failed", "recurring"].includes(outcome)
    ) {
      throw new MemoryStoreError(
        "conflict",
        "A failed or recurring experience must return to attempted before leaving the failure state",
        current.id,
      );
    }
    if (input.outcome === "tests_passed" || input.outcome === "user_confirmed") {
      validateOutcomeEvidence(input.outcome, addedEvidence);
      rejectReusedProof(readEvidenceSourceKeys(db, current.id), addedEvidence, input.outcome);
    } else {
      validateOutcomeEvidence(outcome, evidence);
    }

    const duplicateId = findActiveTopic(db, current.scope, current.projectKey, content.topicKey);
    if (duplicateId && duplicateId !== current.id) {
      throw new MemoryStoreError(
        "conflict",
        "An active memory already uses this topic",
        duplicateId,
      );
    }
    const updatedAt = nowIso();
    const updated: MemoryRecord = {
      ...current,
      content,
      outcome,
      evidence,
      revision: current.revision + 1,
      updatedAt,
    };
    if (input.reviewAfter !== undefined) {
      if (input.reviewAfter === null) delete updated.reviewAfter;
      else updated.reviewAfter = input.reviewAfter;
    }
    updateCurrentRecord(db, updated);
    appendRevision(db, {
      revision: updated.revision,
      operation: "update",
      reason: input.reason,
      sessionId: access.sessionId,
      record: updated,
    });
    writeReceipt(db, access, input.operationId, payloadHash, updated, [updated.id]);
    return updated;
  });
}

function isAlreadyAppliedEvidenceUpdate(current: MemoryRecord, input: MemoryUpdate): boolean {
  const evidence = input.evidence;
  if (!evidence?.length) return false;
  if (input.content !== undefined && stableStringify(input.content) !== stableStringify(current.content))
    return false;
  if (input.outcome !== undefined && input.outcome !== current.outcome) return false;
  if (
    input.reviewAfter !== undefined &&
    (input.reviewAfter ?? undefined) !== current.reviewAfter
  )
    return false;
  return evidence.every((item) => current.evidence.some((stored) => sameEvidence(item, stored)));
}

function sameEvidence(left: MemoryEvidence, right: MemoryEvidence): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function forgetMemory(db: DatabaseSync, access: MemoryAccess, input: MemoryForget): void {
  throwIfAborted(access);
  const payloadHash = fingerprint("forget", access, input);
  runWriteTransaction(db, () => {
    const replay = findReplay(db, access, input.operationId, payloadHash);
    if (replay.found) return;

    const current = readVisibleRecord(db, access, input.id);
    if (!current) throw new MemoryStoreError("not_found", "Memory record was not found");
    assertExpectedRevision(current, input.expectedRevision);

    const relatedReceipts = db
      .prepare(
        `SELECT receipts.session_id, receipts.operation_id, receipts.payload_hash, receipts.created_at
         FROM memory_mutation_receipts AS receipts
         JOIN memory_receipt_records AS links
           ON links.session_id = receipts.session_id AND links.operation_id = receipts.operation_id
         WHERE links.record_id = ?`,
      )
      .all(current.id);
    for (const receipt of relatedReceipts) {
      db.prepare(
        `INSERT INTO memory_operation_tombstones(session_id, operation_id, payload_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        sqlString(receipt, "session_id"),
        sqlString(receipt, "operation_id"),
        sqlString(receipt, "payload_hash"),
        sqlString(receipt, "created_at"),
      );
    }
    db.prepare(
      `DELETE FROM memory_mutation_receipts
       WHERE EXISTS (
         SELECT 1 FROM memory_receipt_records AS links
         WHERE links.session_id = memory_mutation_receipts.session_id
           AND links.operation_id = memory_mutation_receipts.operation_id
           AND links.record_id = ?
       )`,
    ).run(current.id);
    db.prepare("DELETE FROM memory_fts WHERE record_id = ?").run(current.id);
    db.prepare("DELETE FROM memory_records WHERE id = ?").run(current.id);
    writeReceipt(db, access, input.operationId, payloadHash, null, []);
  });
}

function assertExpectedRevision(record: MemoryRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) {
    throw new MemoryStoreError("conflict", "Memory revision changed", record.id);
  }
}

function fingerprint(operation: string, access: MemoryAccess, input: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ operation, projectKey: access.projectKey, input }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const fields = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${fields
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function findReplay(
  db: DatabaseSync,
  access: MemoryAccess,
  operationId: string,
  payloadHash: string,
): ReplayCheck {
  const key = [access.sessionId, operationId] as const;
  const receipt = db
    .prepare(
      `SELECT payload_hash, result_json FROM memory_mutation_receipts
       WHERE session_id = ? AND operation_id = ?`,
    )
    .get(...key) as ReceiptRow | undefined;
  if (receipt) {
    if (receipt.payload_hash !== payloadHash) {
      throw new MemoryStoreError(
        "operation_conflict",
        "Operation id was reused with a different payload",
      );
    }
    return { found: true, resultJson: receipt.result_json };
  }

  const tombstone = db
    .prepare(
      `SELECT payload_hash FROM memory_operation_tombstones
       WHERE session_id = ? AND operation_id = ?`,
    )
    .get(...key) as OperationTombstoneRow | undefined;
  if (tombstone) {
    if (tombstone.payload_hash !== payloadHash) {
      throw new MemoryStoreError(
        "operation_conflict",
        "Operation id was reused with a different payload",
      );
    }
    throw new MemoryStoreError("not_found", "The result of this operation was forgotten");
  }
  return { found: false };
}

function writeReceipt(
  db: DatabaseSync,
  access: MemoryAccess,
  operationId: string,
  payloadHash: string,
  result: MemoryRecord | null,
  recordIds: string[],
): void {
  db.prepare(
    `INSERT INTO memory_mutation_receipts(session_id, operation_id, payload_hash, result_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(access.sessionId, operationId, payloadHash, JSON.stringify(result), nowIso());
  for (const recordId of new Set(recordIds)) {
    db.prepare(
      `INSERT INTO memory_receipt_records(session_id, operation_id, record_id) VALUES (?, ?, ?)`,
    ).run(access.sessionId, operationId, recordId);
  }
}

function rejectReusedProof(
  previous: Set<string>,
  added: MemoryEvidence[],
  outcome: MemoryOutcome,
): void {
  const sourceId = (item: MemoryEvidence): string | undefined =>
    item.kind === "tool" ? item.toolCallId : item.kind === "user" ? item.messageId : undefined;
  for (const item of added) {
    if (item.kind !== (outcome === "tests_passed" ? "tool" : "user")) continue;
    const id = sourceId(item);
    if (!id) continue;
    const key = evidenceSourceKey(item.kind, item.sessionId, id);
    if (previous.has(key)) {
      throw new MemoryStoreError(
        "invalid",
        "A previous evidence source cannot verify a new revision",
      );
    }
    previous.add(key);
  }
}
