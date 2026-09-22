import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelMessageContentToText, type MemoryRecord, type ModelRequest } from "@zcode/contracts";
import { openMemoryApp, prompt, response, type MemoryApp } from "./fixtures/memory-app.js";

function modelText(request: ModelRequest): string {
  return request.messages.map((message) => modelMessageContentToText(message.content)).join("\n");
}

function memoryResult(request: ModelRequest): {
  status: string;
  record: MemoryRecord;
  revisions: unknown[];
} {
  const result = request.messages.findLast(
    (message) => message.role === "tool" && message.toolName === "Memory",
  );
  assert.ok(result, "the actual executor must return Memory's result to the model");
  assert.equal(result.isError, false, modelMessageContentToText(result.content));
  return JSON.parse(modelMessageContentToText(result.content));
}

const repair = {
  topicKey: "orion-cache-repair",
  kind: "episode",
  title: "Orion cache invalidation repair",
  summary: "Rebuild the Orion cache index after a schema upgrade.",
  problem: "The cache retains an obsolete schema after restart.",
  resolution: "Invalidate the schema-specific cache index before opening it.",
  rationale: "The index version and schema version must agree.",
  applicability: "Project Orion, cache schema version 2 only.",
  tags: ["orion", "cache"],
};

test(
  "shared memory crosses real app sessions and records confirmation then recurrence",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-experience-runtime-"));
    const apps: MemoryApp[] = [];
    let record!: MemoryRecord;
    try {
      let call = 0;
      const first = await openMemoryApp({
        root,
        project: "orion",
        script: (request) => {
          if (++call === 1) {
            assert.ok(request.tools?.some((tool) => tool.name === "Memory"));
            return response("", {
              action: "save",
              scope: "project",
              content: repair,
              outcome: "attempted",
            });
          }
          const output = memoryResult(request);
          assert.equal(output.status, "success");
          record = output.record;
          assert.equal(record.outcome, "attempted");
          return response();
        },
      });
      apps.push(first);
      await prompt(first, "Remember the Orion cache repair and why it was needed.");
      await first.close();
      apps.pop();

      call = 0;
      const second = await openMemoryApp({
        root,
        project: "orion",
        script: (request) => {
          call += 1;
          if (call === 1) {
            assert.match(modelText(request), /Orion cache/);
            assert.match(modelText(request), /attempted/);
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "The user confirmed the observed repair.",
              outcome: "user_confirmed",
              evidence: [
                { kind: "user", quote: "Sí, funciona.", summary: "User reports the fix works." },
              ],
            });
          }
          if (call === 2) {
            const output = memoryResult(request);
            assert.equal(output.status, "success");
            record = output.record;
            assert.equal(record.outcome, "user_confirmed");
            assert.ok(record.evidence.some((entry) => entry.kind === "user" && entry.messageId));
            return response();
          }
          if (call === 3)
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "The error returned after restart.",
              outcome: "recurring",
              evidence: [
                {
                  kind: "user",
                  quote: "El error de Orion cache volvió.",
                  summary: "User reports recurrence.",
                },
              ],
            });
          const output = memoryResult(request);
          assert.equal(output.status, "success");
          record = output.record;
          assert.equal(record.outcome, "recurring");
          assert.equal(record.revision, 3);
          return response();
        },
      });
      apps.push(second);
      await prompt(second, "Sobre Orion cache: Sí, funciona.");
      await prompt(second, "El error de Orion cache volvió.");
      await second.close();
      apps.pop();

      call = 0;
      const third = await openMemoryApp({
        root,
        project: "orion",
        script: (request) => {
          if (++call === 1) {
            assert.match(modelText(request), /recurring/);
            return response("", { action: "history", id: record.id });
          }
          const output = memoryResult(request);
          assert.equal(output.status, "success");
          assert.equal(output.revisions.length, 3);
          const history = JSON.stringify(output.revisions);
          assert.match(history, /attempted/);
          assert.match(history, /user_confirmed/);
          assert.match(history, /recurring/);
          return response();
        },
      });
      apps.push(third);
      await prompt(third, "What happened with the Orion cache repair?");
    } finally {
      for (const app of apps.reverse()) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "portable memory crosses projects, project knowledge and profiles stay isolated",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-experience-scope-"));
    const apps: MemoryApp[] = [];
    let privateId = "";
    try {
      let call = 0;
      const writer = await openMemoryApp({
        root,
        project: "orion",
        script: (request) => {
          if (++call === 1)
            return response("", { action: "save", scope: "project", content: repair });
          if (call === 2) {
            privateId = memoryResult(request).record.id;
            return response("", {
              action: "save",
              scope: "user",
              content: {
                ...repair,
                topicKey: "cache-portable-method",
                kind: "procedure",
                title: "Portable cache debugging method",
                summary: "Compare schema and index versions before rebuilding a cache.",
                applicability: "Only caches with separately versioned index and schema.",
              },
            });
          }
          assert.equal(memoryResult(request).status, "success");
          return response();
        },
      });
      apps.push(writer);
      await prompt(writer, "Save the private Orion repair and a portable cache method.");
      await writer.close();
      apps.pop();

      call = 0;
      const reader = await openMemoryApp({
        root,
        project: "lyra",
        script: (request) => {
          if (++call === 1) {
            assert.match(modelText(request), /Portable cache debugging method/);
            assert.doesNotMatch(modelText(request), /Orion cache invalidation repair/);
            return response("", { action: "get", id: privateId });
          }
          const denied = request.messages.findLast(
            (message) => message.role === "tool" && message.toolName === "Memory",
          );
          assert.ok(denied);
          assert.equal(denied.isError, true);
          assert.match(modelMessageContentToText(denied.content), /not_found/);
          return response();
        },
      });
      apps.push(reader);
      await prompt(reader, "Recall the cache debugging method.");

      const anotherUser = await openMemoryApp({
        root,
        project: "lyra",
        profile: "other-profile",
        script: (request) => {
          assert.doesNotMatch(modelText(request), /Portable cache debugging method/);
          return response();
        },
      });
      apps.push(anotherUser);
      await prompt(anotherUser, "Recall the cache debugging method.");

      const disabled = await openMemoryApp({
        root,
        project: "orion",
        enabled: false,
        script: (request) => {
          assert.equal(
            request.tools?.some((tool) => tool.name === "Memory"),
            false,
          );
          assert.doesNotMatch(modelText(request), /Orion cache invalidation repair/);
          return response();
        },
      });
      apps.push(disabled);
      await prompt(disabled, "Recall the Orion cache repair.");
    } finally {
      for (const app of apps.reverse()) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
