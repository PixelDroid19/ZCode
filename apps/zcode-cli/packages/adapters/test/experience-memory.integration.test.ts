import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStoreError, type MemoryAccess, type MemoryContent } from "@zcode/contracts";
import { SqliteMemoryStore } from "../src/storage/index.js";

test("SQLite experience memory shares scopes, revisions, CAS, receipts, supersede and forget", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-experience-memory-"));
  const dbPath = join(root, "memories", "experience.sqlite");
  let first: SqliteMemoryStore | undefined;
  let second: SqliteMemoryStore | undefined;
  const projectA: MemoryAccess = { projectKey: "project-a", sessionId: "session-a" };
  const projectB: MemoryAccess = { projectKey: "project-b", sessionId: "session-b" };
  const siblingSession: MemoryAccess = { projectKey: projectA.projectKey, sessionId: "session-c" };
  const content = (topicKey: string, resolution: string): MemoryContent => ({
    topicKey,
    kind: "episode",
    title: "Repair a flaky integration",
    summary: "The adapter needs durable evidence across sessions.",
    resolution,
    tags: ["sqlite", "repair"],
  });

  try {
    first = await SqliteMemoryStore.open({ dbPath });
    const invalidSuccess = {
      operationId: "invalid-success",
      scope: "project" as const,
      content: content("invalid-success", "Unverified"),
      outcome: "tests_passed" as const,
      evidence: [{ kind: "agent" as const, sessionId: projectA.sessionId, summary: "Looks good." }],
    };
    await assert.rejects(
      first.save(projectA, invalidSuccess),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
    );

    const initialSave = {
      operationId: "save-repair",
      scope: "project",
      content: content("project-repair", "Started with a reproducible failed attempt."),
      outcome: "attempted",
      evidence: [
        { kind: "agent", sessionId: projectA.sessionId, summary: "Reproduced the issue." },
      ],
    };
    const initial = await first.save(projectA, initialSave);
    assert.equal((await first.save(projectA, initialSave)).id, initial.id);
    await assert.rejects(
      first.save(projectA, {
        operationId: "save-repair",
        scope: "project",
        content: content("project-repair", "Changed payload"),
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "operation_conflict",
    );

    await first.close();
    first = await SqliteMemoryStore.open({ dbPath });
    assert.equal((await first.get(projectA, initial.id))?.id, initial.id);
    assert.equal(await first.get(projectB, initial.id), undefined);
    assert.equal((await first.search(projectB, { scope: "project" })).length, 0);
    assert.deepEqual(
      (await first.search(projectA, { query: 'flaky" OR *', scope: "project" })).map(
        (item) => item.id,
      ),
      [initial.id],
    );

    const previousToolEvidence = Array.from({ length: 64 }, (_, index) => ({
      kind: "tool" as const,
      sessionId: projectA.sessionId,
      toolCallId: `bounded-tool-${index}`,
      summary: `Previous bounded test ${index}.`,
    }));
    const boundedRecord = await first.save(projectA, {
      operationId: "save-bounded-evidence",
      scope: "project",
      content: content("bounded-evidence", "Evidence snapshots stay bounded."),
      outcome: "tests_passed",
      evidence: previousToolEvidence,
    });
    const trimmedRecord = await first.update(projectA, {
      operationId: "trim-old-evidence",
      id: boundedRecord.id,
      expectedRevision: 1,
      outcome: "attempted",
      evidence: Array.from({ length: 64 }, (_, index) => ({
        kind: "agent" as const,
        sessionId: projectA.sessionId,
        summary: `New attempt note ${index}.`,
      })),
      reason: "The new bounded batch replaces older inline evidence.",
    });
    assert.equal(trimmedRecord.evidence.length, 64);
    assert.equal(
      trimmedRecord.evidence.some((item) => item.toolCallId === "bounded-tool-0"),
      false,
    );
    assert.equal(
      (await first.history(projectA, boundedRecord.id)).at(-1)?.record.evidence.length,
      64,
    );
    await assert.rejects(
      first.update(projectA, {
        operationId: "reuse-clipped-proof",
        id: boundedRecord.id,
        expectedRevision: trimmedRecord.revision,
        outcome: "tests_passed",
        evidence: [previousToolEvidence[0]!],
        reason: "A clipped source remains in the immutable source index.",
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
    );

    const portable = await first.save(projectA, {
      operationId: "save-user-procedure",
      scope: "user",
      content: {
        ...content("portable-test-method", "Prefer the real SQLite adapter in integration tests."),
        kind: "procedure",
      },
      outcome: "recorded",
    });
    assert.equal((await first.get(projectB, portable.id))?.id, portable.id);
    assert.ok(
      (
        await first.search(projectB, {
          query: "Sobre SQLite adapter: sí, funciona.",
          scope: "user",
        })
      ).some((item) => item.id === portable.id),
    );
    assert.deepEqual(await first.search(projectB, { query: "orion teleport", scope: "user" }), []);

    const toolProof = {
      kind: "tool" as const,
      sessionId: projectA.sessionId,
      toolCallId: "tool-test-1",
      summary: "Targeted integration command completed successfully.",
    };
    const passed = await first.update(projectA, {
      operationId: "update-tests-passed",
      id: initial.id,
      expectedRevision: 1,
      outcome: "tests_passed",
      evidence: [toolProof],
      reason: "The targeted test run passed.",
    });
    const userProof = {
      kind: "user" as const,
      sessionId: projectA.sessionId,
      messageId: "user-message-1",
      quote: "That fixed the issue for me.",
      summary: "The user confirmed the repair.",
    };
    const confirmed = await first.update(projectA, {
      operationId: "update-user-confirmed",
      id: initial.id,
      expectedRevision: passed.revision,
      outcome: "user_confirmed",
      evidence: [userProof],
      reason: "The user confirmed the repaired flow.",
    });
    const changedSolution = await first.update(projectA, {
      operationId: "change-confirmed-solution",
      id: initial.id,
      expectedRevision: confirmed.revision,
      content: content("project-repair", "A different approach has not been verified yet."),
      reason: "Changed the resolution, so prior success evidence no longer applies.",
    });
    assert.equal(changedSolution.outcome, "attempted");
    await assert.rejects(
      first.update(projectA, {
        operationId: "reuse-old-tool-proof",
        id: initial.id,
        expectedRevision: changedSolution.revision,
        outcome: "tests_passed",
        evidence: [toolProof],
        reason: "Attempted to reuse earlier verification.",
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
    );

    const reverified = await first.update(projectA, {
      operationId: "verify-new-solution",
      id: initial.id,
      expectedRevision: changedSolution.revision,
      outcome: "tests_passed",
      evidence: [
        {
          ...toolProof,
          toolCallId: "tool-test-2",
          summary: "New resolution passed targeted tests.",
        },
      ],
      reason: "Verified the changed resolution with a new tool execution.",
    });
    const recurring = await first.update(projectA, {
      operationId: "mark-recurring",
      id: initial.id,
      expectedRevision: reverified.revision,
      outcome: "recurring",
      reason: "The same symptom returned in a later session.",
      evidence: [
        { kind: "agent", sessionId: projectB.sessionId, summary: "The symptom returned." },
      ],
    });
    const annotatedRecurring = await first.update(projectA, {
      operationId: "add-recurrence-context",
      id: initial.id,
      expectedRevision: recurring.revision,
      reason: "Added context without starting a new repair.",
      evidence: [
        { kind: "agent", sessionId: projectA.sessionId, summary: "The failure still recurs." },
      ],
    });
    assert.equal(annotatedRecurring.outcome, "recurring");
    await assert.rejects(
      first.update(projectA, {
        operationId: "skip-attempted-transition",
        id: initial.id,
        expectedRevision: annotatedRecurring.revision,
        outcome: "tests_passed",
        evidence: [{ ...toolProof, toolCallId: "tool-test-3" }],
        reason: "A new verification without a new attempt.",
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "conflict",
    );
    await assert.rejects(
      first.update(projectA, {
        operationId: "recorded-cannot-bridge-recurrence",
        id: initial.id,
        expectedRevision: annotatedRecurring.revision,
        outcome: "recorded",
        reason: "A recorded state cannot bypass a new repair attempt.",
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "conflict",
    );
    const newAttempt = await first.update(projectA, {
      operationId: "new-attempt",
      id: initial.id,
      expectedRevision: annotatedRecurring.revision,
      outcome: "attempted",
      reason: "Started a new repair after recurrence.",
    });

    second = await SqliteMemoryStore.open({ dbPath });
    const casResults = await Promise.allSettled([
      first.update(projectA, {
        operationId: "cas-session-a",
        id: initial.id,
        expectedRevision: newAttempt.revision,
        outcome: "attempted",
        reason: "Concurrent writer A.",
      }),
      second.update(siblingSession, {
        operationId: "cas-session-b",
        id: initial.id,
        expectedRevision: newAttempt.revision,
        outcome: "attempted",
        reason: "Concurrent writer B.",
      }),
    ]);
    assert.equal(casResults.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedCas = casResults.find((result) => result.status === "rejected");
    assert.ok(rejectedCas && rejectedCas.status === "rejected");
    assert.ok(rejectedCas.reason instanceof MemoryStoreError);
    assert.equal(rejectedCas.reason.code, "conflict");
    const casWinner = casResults.find((result) => result.status === "fulfilled");
    assert.ok(casWinner && casWinner.status === "fulfilled");

    await assert.rejects(
      first.save(projectA, {
        operationId: "supersede-reuses-old-confirmation",
        scope: "project",
        content: content("project-repair", "A new record needs its own confirmation."),
        outcome: "user_confirmed",
        evidence: [userProof],
        supersedes: { id: initial.id, expectedRevision: casWinner.value.revision },
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
    );

    const replacement = await first.save(projectA, {
      operationId: "superseding-save",
      scope: "project",
      content: content(
        "project-repair",
        "The replacement record has an independent revision history.",
      ),
      outcome: "attempted",
      supersedes: { id: initial.id, expectedRevision: casWinner.value.revision },
    });
    await assert.rejects(
      first.update(projectA, {
        operationId: "replacement-reuses-lineage-tool-proof",
        id: replacement.id,
        expectedRevision: replacement.revision,
        outcome: "tests_passed",
        evidence: [toolProof],
        reason: "A superseding record cannot borrow the old record's passing tool call.",
      }),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
    );
    const replacementVerified = await first.update(projectA, {
      operationId: "replacement-new-verification",
      id: replacement.id,
      expectedRevision: replacement.revision,
      outcome: "tests_passed",
      evidence: [
        {
          ...toolProof,
          toolCallId: "tool-test-replacement",
          summary: "Replacement passed its own tests.",
        },
      ],
      reason: "Verified the replacement independently.",
    });
    assert.equal((await first.get(projectA, initial.id))?.status, "superseded");
    assert.equal(
      (await first.search(projectA, { query: "project-repair" })).some(
        (item) => item.id === initial.id,
      ),
      false,
    );
    assert.equal(
      (await first.search(projectA, { query: "project-repair", includeInactive: true })).some(
        (item) => item.id === initial.id,
      ),
      true,
    );
    assert.equal(await first.get(projectB, replacement.id), undefined);
    await assert.rejects(
      first.save(projectA, {
        operationId: "duplicate-active-topic",
        scope: "project",
        content: content("project-repair", "Duplicate active topics conflict."),
      }),
      (error: unknown) =>
        error instanceof MemoryStoreError &&
        error.code === "conflict" &&
        error.recordId === replacement.id,
    );

    const history = await first.history(projectA, initial.id);
    assert.equal(history.at(-1)?.operation, "supersede");
    assert.ok(
      history.some((revision) =>
        revision.record.evidence.some((item) => item.toolCallId === "tool-test-1"),
      ),
    );
    assert.ok(history.some((revision) => revision.record.outcome === "recurring"));

    await first.forget(projectA, {
      operationId: "forget-original",
      id: initial.id,
      expectedRevision: history.at(-1)!.revision,
    });
    assert.equal(await first.get(projectA, initial.id), undefined);
    assert.deepEqual(await first.history(projectA, initial.id), []);
    assert.equal(
      (await first.search(projectA, { query: "unverified yet" })).some(
        (item) => item.id === initial.id,
      ),
      false,
    );
    await assert.rejects(
      first.save(projectA, initialSave),
      (error: unknown) => error instanceof MemoryStoreError && error.code === "not_found",
    );
    await first.forget(projectA, {
      operationId: "forget-original",
      id: initial.id,
      expectedRevision: history.at(-1)!.revision,
    });
    assert.equal((await first.get(projectA, replacement.id))?.id, replacementVerified.id);
  } finally {
    await first?.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});
