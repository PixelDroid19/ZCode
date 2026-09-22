import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
          return response("No durable memory change needed for these observations.");
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
            ["Memory"],
          );
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
          return response();
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
