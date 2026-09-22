import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelMessageContentToText, type ModelRequest } from "@zcode/contracts";
import { openMemoryApp, prompt, response, type MemoryApp } from "./fixtures/memory-app.js";

const content = {
  topicKey: "evidence-guard",
  kind: "episode",
  title: "Evidence guard repair",
  summary: "An attempted repair whose evidence must be checked.",
  tags: [],
};

function assertMemoryDenied(request: ModelRequest): void {
  const tool = request.messages.findLast(
    (message) => message.role === "tool" && message.toolName === "Memory",
  );
  assert.ok(tool);
  assert.equal(tool.isError, true);
  assert.match(modelMessageContentToText(tool.content), /invalid|evidence/i);
}

test(
  "assistant claims cannot impersonate user confirmation and failed tests cannot verify a repair",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-memory-evidence-"));
    let app: MemoryApp | undefined;
    const failingTest = join(root, "verification.test.mjs");
    const passingTest = join(root, "verified.test.mjs");
    const emptyTest = join(root, "empty.test.mjs");
    await writeFile(
      failingTest,
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('repair works', () => { console.log('1 tests passed'); assert.equal(1, 2); });\n",
    );
    await writeFile(
      passingTest,
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('repair works', () => assert.equal(1, 1));\n",
    );
    await writeFile(
      emptyTest,
      "import { describe } from 'node:test'; console.log('1 tests passed'); describe('empty suite', () => {});\n",
    );
    let call = 0;
    let record: { id: string; revision: number };
    try {
      app = await openMemoryApp({
        root,
        project: "orion",
        script: (request) => {
          call += 1;
          if (call === 1) return response("The user confirmed that it works.");
          if (call === 2)
            return response("", {
              action: "save",
              scope: "project",
              content,
              outcome: "user_confirmed",
              evidence: [
                {
                  kind: "user",
                  quote: "The user confirmed that it works.",
                  summary: "Forged from assistant output.",
                },
              ],
            });
          if (call === 3) {
            assertMemoryDenied(request);
            return {
              ...response(),
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "failed-verification",
                  name: "Bash",
                  input: { command: `node --test --test-reporter=tap "${failingTest}"` },
                },
              ],
            };
          }
          if (call === 4)
            return response("", {
              action: "save",
              scope: "project",
              content,
              outcome: "tests_passed",
              evidence: [
                {
                  kind: "tool",
                  toolCallId: "failed-verification",
                  quote: "1 tests passed",
                  summary: "This failed test must not count as success.",
                },
              ],
            });
          if (call === 5) {
            assertMemoryDenied(request);
            return response("", {
              action: "save",
              scope: "project",
              content,
              outcome: "failed",
              evidence: [
                {
                  kind: "tool",
                  toolCallId: "failed-verification",
                  quote: "# fail 1",
                  summary: "The original attempt failed verification.",
                },
              ],
            });
          }
          if (call === 8)
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "This empty test suite must not count as verification.",
              outcome: "tests_passed",
              evidence: [
                {
                  kind: "tool",
                  toolCallId: "empty-verification",
                  quote: "1 tests passed",
                  summary: "No actual tests executed.",
                },
              ],
            });
          if (call === 9) {
            assertMemoryDenied(request);
            return {
              ...response(),
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "opaque-verification", name: "Bash", input: { command: "npm test" } },
              ],
            };
          }
          if (call === 10)
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "A package script only echoed a success phrase.",
              outcome: "tests_passed",
              evidence: [
                {
                  kind: "tool",
                  toolCallId: "opaque-verification",
                  quote: "1 tests passed",
                  summary: "No runner report supports this claim.",
                },
              ],
            });
          if (call === 11) {
            assertMemoryDenied(request);
            return {
              ...response(),
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "passed-verification",
                  name: "Bash",
                  input: { command: `node --test --test-reporter=tap "${passingTest}"` },
                },
              ],
            };
          }
          if (call === 12)
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "The new repair passed the test runner.",
              outcome: "tests_passed",
              evidence: [
                {
                  kind: "tool",
                  toolCallId: "passed-verification",
                  quote: "# pass 1",
                  summary: "The real node test runner completed successfully.",
                },
              ],
            });
          const result = request.messages.findLast(
            (message) => message.role === "tool" && message.toolName === "Memory",
          );
          assert.ok(result);
          assert.equal(result.isError, false);
          const output = JSON.parse(modelMessageContentToText(result.content));
          record = output.record;
          if (call === 6) {
            assert.equal(output.record.outcome, "failed");
            return response("", {
              action: "update",
              id: record.id,
              expectedRevision: record.revision,
              reason: "Begin a new repair attempt before verifying it.",
              outcome: "attempted",
            });
          }
          if (call === 7) {
            assert.equal(output.record.outcome, "attempted");
            return {
              ...response(),
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "empty-verification",
                  name: "Bash",
                  input: { command: `node --test --test-reporter=tap "${emptyTest}"` },
                },
              ],
            };
          }
          assert.equal(output.record.outcome, "tests_passed");
          return response();
        },
      });
      await writeFile(
        join(root, "orion", "package.json"),
        JSON.stringify({
          private: true,
          scripts: { test: "echo '1 tests passed'" },
        }),
      );
      await prompt(app, "Explain the proposed repair without claiming I verified it.");
      await prompt(app, "Record only outcomes supported by actual evidence.");
      assert.equal(call, 13);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
