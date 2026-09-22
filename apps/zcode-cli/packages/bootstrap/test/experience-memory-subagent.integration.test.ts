import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelMessageContentToText } from "@zcode/contracts";
import { openMemoryApp, prompt, response, type MemoryApp } from "./fixtures/memory-app.js";

test(
  "a real child recalls the parent's experience and its new memory reaches the parent",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-memory-child-"));
    let app: MemoryApp | undefined;
    let call = 0;
    try {
      app = await openMemoryApp({
        root,
        project: "orion",
        subagents: true,
        script: (request) => {
          call += 1;
          if (call === 1)
            return response("", {
              action: "save",
              scope: "project",
              content: {
                topicKey: "parent-cache-lesson",
                kind: "episode",
                title: "Parent cache lesson",
                summary: "Cache schema version and index version must agree.",
                tags: ["cache"],
              },
            });
          if (call === 2) {
            const output = request.messages.findLast(
              (message) => message.role === "tool" && message.toolName === "Memory",
            );
            assert.equal(output?.isError, false);
            return {
              ...response(),
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "memory-child-task",
                  name: "Agent",
                  input: {
                    description: "Inspect shared cache experience",
                    subagent_type: "general-purpose",
                    prompt:
                      "Recall the Parent cache lesson and save a new child cache observation.",
                  },
                },
              ],
            };
          }
          if (call === 3) {
            assert.ok(
              request.tools?.some((tool) => tool.name === "Memory"),
              "the spawned child receives the real memory tool",
            );
            const text = request.messages
              .map((message) => modelMessageContentToText(message.content))
              .join("\n");
            assert.match(text, /Cache schema version and index version must agree/);
            return response("", {
              action: "save",
              scope: "project",
              content: {
                topicKey: "child-cache-lesson",
                kind: "episode",
                title: "Child cache observation",
                summary: "The child discovered a cache rebuild precondition.",
                tags: ["cache"],
              },
            });
          }
          if (call === 4) {
            const output = request.messages.findLast(
              (message) => message.role === "tool" && message.toolName === "Memory",
            );
            assert.equal(output?.isError, false);
            return response("Child finished and saved its observation.");
          }
          if (call === 5) {
            const result = request.messages.findLast(
              (message) => message.role === "tool" && message.toolName === "Agent",
            );
            assert.ok(result, "the parent must receive the actual child completion");
            assert.equal(result.isError, false, modelMessageContentToText(result.content));
            return response("Parent received child completion.");
          }
          assert.equal(call, 6);
          const text = request.messages
            .map((message) => modelMessageContentToText(message.content))
            .join("\n");
          assert.match(text, /The child discovered a cache rebuild precondition/);
          return response("The parent now recalls the child's experience.");
        },
      });
      await prompt(app, "Share this cache lesson with a child and let it save its own finding.");
      await prompt(app, "Recall the new child cache observation.");
      assert.equal(call, 6);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
