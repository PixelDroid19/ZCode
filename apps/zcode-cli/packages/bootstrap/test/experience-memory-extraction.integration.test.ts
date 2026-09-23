import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteMemoryStore } from "@zcode/adapters/storage";
import { modelMessageContentToText, type ModelRequest } from "@zcode/contracts";
import { openMemoryApp, prompt, response, type MemoryApp } from "./fixtures/memory-app.js";

test(
  "automatic extraction drains queued turns without skipping their durable evidence",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-memory-backlog-"));
    let app: MemoryApp | undefined;
    let releaseExtraction!: () => void;
    let extractionStarted!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    const seen = new Set<string>();
    const marker = "Durable transcript (JSON, one message per line):";
    let extractionCalls = 0;
    try {
      app = await openMemoryApp({
        root,
        project: "orion",
        extraction: true,
        script: async (request) => {
          const source = request.messages.findLast(
            (message) =>
              message.role === "user" &&
              modelMessageContentToText(message.content).includes(marker),
          );
          if (!source) return response("Noted the observation.");
          extractionCalls += 1;
          if (extractionCalls === 1) {
            extractionStarted();
            await extractionGate;
          }
          const text = modelMessageContentToText(source.content);
          assert.ok(text.length < 30_000);
          for (const line of text
            .slice(text.indexOf(marker) + marker.length)
            .trim()
            .split("\n")) {
            const message = JSON.parse(line);
            if (message.role !== "user") continue;
            for (const part of message.parts) {
              if (typeof part.text === "string" && part.text.startsWith("Memory backlog event "))
                seen.add(part.text);
            }
          }
          assert.equal(request.toolChoice, "required");
          return response("", { reason: "No durable memory change needed." }, "FinishMemoryExtraction");
        },
      });
      await prompt(app, "Memory backlog event 0");
      await started;
      for (let index = 1; index <= 20; index += 1)
        await prompt(app, `Memory backlog event ${index}`);
      releaseExtraction();
      await app.runtime.drainMemoryExtractions(null);
      assert.deepEqual(
        [...seen].sort(),
        Array.from({ length: 21 }, (_, index) => `Memory backlog event ${index}`).sort(),
      );
      assert.ok(
        extractionCalls >= 3,
        "coalesced evidence must be consumed in multiple bounded batches",
      );
    } finally {
      releaseExtraction();
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "automatic extraction persists an attempt and short user feedback across app sessions",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-memory-extraction-"));
    let app: MemoryApp | undefined;
    let mainCalls = 0;
    let extractionCalls = 0;
    let record: { id: string; revision: number; outcome: string } | undefined;
    const transcriptMarker = "Durable transcript (JSON, one message per line):";
    try {
      app = await openMemoryApp({
        root,
        project: "orion",
        extraction: true,
        script: (request) => {
          const extractionPrompt = request.messages.findLast(
            (message) =>
              message.role === "user" &&
              modelMessageContentToText(message.content).includes(transcriptMarker),
          );
          if (!extractionPrompt) {
            mainCalls += 1;
            return response(
              mainCalls === 1
                ? "I rebuilt the Orion cache index because its schema version was obsolete. Please verify the repair."
                : "You confirmed the Orion cache repair works.",
            );
          }
          extractionCalls += 1;
          assert.deepEqual(
            request.tools?.map((tool) => tool.name),
            ["Memory", "FinishMemoryExtraction"],
          );
          assert.equal(request.toolChoice, "required");
          const source = modelMessageContentToText(extractionPrompt.content);
          assert.ok(source.length < 30_000, "extraction input stays bounded");
          if (extractionCalls === 1)
            return response("", {
              action: "save",
              scope: "project",
              outcome: "attempted",
              content: {
                topicKey: "automatic-orion-repair",
                kind: "episode",
                title: "Automatic Orion cache repair",
                summary: "Rebuild the Orion cache index after a schema upgrade.",
                resolution: "Rebuild the index before opening the cache.",
                rationale: "The index retained an obsolete schema version.",
                applicability: "Project Orion cache schema 2.",
                tags: ["orion", "cache"],
              },
              evidence: [
                {
                  kind: "agent",
                  summary: "The assistant reported the attempt, pending user verification.",
                },
              ],
            });
          if (extractionCalls === 3) {
            assert.ok(record);
            const transcript = source
              .slice(source.indexOf(transcriptMarker) + transcriptMarker.length)
              .trim();
            const feedback = transcript
              .split("\n")
              .map((line) => JSON.parse(line))
              .find(
                (message) =>
                  message.role === "user" &&
                  message.parts.some((part: { text?: string }) => part.text === "Sí, funciona."),
              );
            assert.ok(
              feedback?.messageId,
              "short feedback must retain its durable user message ID",
            );
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "The user confirmed this repair in the next turn.",
              outcome: "user_confirmed",
              evidence: [
                {
                  kind: "user",
                  messageId: feedback.messageId,
                  quote: "Sí, funciona.",
                  summary: "Explicit user confirmation.",
                },
              ],
            });
          }
          const result = request.messages.findLast(
            (message) => message.role === "tool" && message.toolName === "Memory",
          );
          assert.ok(result);
          assert.equal(result.isError, false, modelMessageContentToText(result.content));
          record = JSON.parse(modelMessageContentToText(result.content)).record;
          return response("", { reason: "All useful experience was saved." }, "FinishMemoryExtraction");
        },
      });
      await prompt(app, "Repair the Orion cache index and explain the cause.");
      await app.runtime.drainMemoryExtractions(null);
      assert.equal(record?.outcome, "attempted");
      await prompt(app, "Sí, funciona.");
      await app.runtime.drainMemoryExtractions(null);
      assert.equal(record?.outcome, "user_confirmed");
      assert.equal(record?.revision, 2);
      assert.equal(mainCalls, 2);
      assert.equal(extractionCalls, 4);
      await app.close();
      app = undefined;

      app = await openMemoryApp({
        root,
        project: "orion",
        script: (request: ModelRequest) => {
          const text = request.messages
            .map((message) => modelMessageContentToText(message.content))
            .join("\n");
          assert.match(text, /Automatic Orion cache repair/);
          assert.match(text, /user_confirmed/);
          return response();
        },
      });
      await prompt(app, "Recall the Orion cache repair.");
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "automatic extraction replays a committed write after an unfinished step and still applies later feedback",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-memory-extraction-replay-"));
    const projectKey = "memory-extraction-replay-project";
    const firstFact = "The Orion repair attempted fencingMode=epoch-local.";
    const laterFeedback = "The Orion repair failed again after that attempt.";
    const finalNudge = "Finish recording the Orion recurrence.";
    let app: MemoryApp | undefined;
    let firstRecordId: string | undefined;
    let replayedRecordId: string | undefined;
    try {
      app = await openMemoryApp({
        root,
        project: "orion-replay",
        workspaceIdentity: projectKey,
        extraction: true,
        script: (request) => {
          const source = request.messages.findLast(
            (message) =>
              message.role === "user" &&
              modelMessageContentToText(message.content).includes("Durable transcript (JSON"),
          );
          if (!source) return response("Noted.");
          assert.equal(request.toolChoice, "required");
          const transcript = modelMessageContentToText(source.content)
            .split("Durable transcript (JSON, one message per line):")[1]
            ?.trim()
            .split("\n")
            .map((line) => JSON.parse(line) as {
              messageId: string;
              role: string;
              fresh: boolean;
              parts: Array<{ text?: string }>;
            });
          assert.ok(transcript);
          const citedMessage = (quote: string, mustBeFresh = false) => {
            const entry = transcript.find(
              (message) =>
                message.role === "user" && message.parts.some((part) => part.text === quote),
            );
            assert.ok(entry?.messageId);
            if (mustBeFresh) assert.equal(entry.fresh, true, `${quote} must remain fresh`);
            return entry.messageId;
          };
          const hasFeedback = transcript.some((message) =>
            message.parts.some((part) => part.text === laterFeedback),
          );
          const hasFinalNudge = transcript.some((message) =>
            message.parts.some((part) => part.text === finalNudge),
          );
          if (hasFeedback) citedMessage(firstFact, true);
          if (hasFinalNudge) citedMessage(laterFeedback, true);
          const savedInput = {
            action: "save",
            scope: "project",
            outcome: "attempted",
            content: {
              topicKey: "orion-replay-repair",
              kind: "episode",
              title: "Orion repair attempt",
              summary: "Tried fencingMode=epoch-local for Orion.",
              resolution: "Set fencingMode=epoch-local.",
              applicability: "Orion project only.",
            },
            evidence: [{ kind: "user", messageId: citedMessage(firstFact), quote: firstFact, summary: "Initial repair attempt." }],
          };
          const toolResults = request.messages.filter(
            (message) => message.role === "tool" && message.toolName === "Memory",
          );
          if (toolResults.length === 0) return response("", savedInput);
          const saved = JSON.parse(modelMessageContentToText(toolResults[0]!.content));
          assert.equal(toolResults[0]!.isError, false);
          if (!hasFeedback) {
            firstRecordId = saved.record.id;
            // 写入后的无效结束参数不能推进游标。
            return response("", { reason: 12 }, "FinishMemoryExtraction");
          }
          replayedRecordId = saved.record.id;
          if (toolResults.length === 1) {
            assert.equal(replayedRecordId, firstRecordId);
            return response("", {
              action: "update",
              id: replayedRecordId,
              expectedRevision: hasFinalNudge ? 2 : 1,
              reason: "The user reported the repair failed again.",
              outcome: "recurring",
              evidence: [
                {
                  kind: "user",
                  messageId: citedMessage(laterFeedback),
                  quote: laterFeedback,
                  summary: "The user reported a recurrence.",
                },
              ],
            });
          }
          assert.equal(toolResults[1]!.isError, false);
          if (!hasFinalNudge)
            return response(
              '{"memoryCalls":[{"action":"update"}]}',
              { reason: "Claimed completion in text." },
              "FinishMemoryExtraction",
            );
          if (toolResults.length === 2) {
            const repeated = JSON.parse(modelMessageContentToText(toolResults[1]!.content));
            assert.equal(repeated.record.revision, 2, "identical evidence must not add a revision");
            return response("", {
              action: "update",
              id: replayedRecordId,
              expectedRevision: 2,
              reason: "Clarify the source evidence summary.",
              outcome: "recurring",
              evidence: [
                {
                  kind: "user",
                  messageId: citedMessage(laterFeedback),
                  quote: laterFeedback,
                  summary: "The user confirmed the same repair failed again.",
                },
              ],
            });
          }
          assert.equal(toolResults[2]!.isError, false);
          const corrected = JSON.parse(modelMessageContentToText(toolResults[2]!.content));
          assert.equal(corrected.record.revision, 3, "changed evidence must create a revision");
          return response("", { reason: "The later feedback has been recorded." }, "FinishMemoryExtraction");
        },
      });

      await prompt(app, firstFact);
      await app.runtime.drainMemoryExtractions(null);
      const store = await SqliteMemoryStore.open({
        dbPath: join(root, "profile", "cli", "memories", "experience.sqlite"),
      });
      try {
        const access = { projectKey, sessionId: "replay-observer" };
        const first = await store.search(access, { scope: "project", limit: 10 });
        assert.equal(first.length, 1);
        assert.equal(first[0]?.revision, 1);
        assert.equal(first[0]?.id, firstRecordId);

        await prompt(app, laterFeedback);
        await app.runtime.drainMemoryExtractions(null);
        const afterFeedback = await store.search(access, { scope: "project", limit: 10 });
        assert.equal(afterFeedback.length, 1);
        assert.equal(afterFeedback[0]?.revision, 2);
        assert.equal((await store.history(access, firstRecordId!, 10)).length, 2);

        await prompt(app, finalNudge);
        await app.runtime.drainMemoryExtractions(null);
        const final = await store.search(access, { scope: "project", limit: 10 });
        assert.equal(final.length, 1);
        assert.equal(final[0]?.id, firstRecordId);
        assert.equal(final[0]?.revision, 3);
        assert.equal(final[0]?.outcome, "recurring");
        assert.equal((await store.history(access, firstRecordId!, 10)).length, 3);
        const corrected = await store.get(access, firstRecordId!);
        assert.ok(
          corrected?.evidence.some(
            (item) => item.summary === "The user confirmed the same repair failed again.",
          ),
        );
      } finally {
        await store.close();
      }
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
