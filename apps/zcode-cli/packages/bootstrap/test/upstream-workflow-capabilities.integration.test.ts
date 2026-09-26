import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelMessageContentToText, type ModelRequest } from "@zcode/contracts";
import { openMemoryApp, prompt, response, type MemoryApp } from "./fixtures/memory-app.js";

function lastTool(request: ModelRequest, name: string) {
  const result = request.messages.findLast(
    (message) => message.role === "tool" && message.toolName === name,
  );
  assert.ok(result, `Expected the real ${name} result`);
  return result;
}

test(
  "bundled workflow skills gate execution and survive live reload into a real child",
  {
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-upstream-workflow-"));
    let app: MemoryApp | undefined;
    let call = 0;
    let initialEvaluation: { isError?: boolean; text: string } | undefined;
    const snippet = { code: 'return "workflow-integration-ran";' };
    try {
      app = await openMemoryApp({
        root,
        project: "project",
        dynamicWorkflow: true,
        skillsEnabled: false,
        subagents: true,
        script: (request) => {
          call += 1;
          if (call === 1) return response("", snippet, "EvalWorkflowSnippet");
          if (call === 2) {
            const result = lastTool(request, "EvalWorkflowSnippet");
            initialEvaluation = {
              isError: result.isError,
              text: modelMessageContentToText(result.content),
            };
            return response("", { skill: "dynamic-workflows" }, "Skill");
          }
          if (call === 3) {
            assert.equal(lastTool(request, "Skill").isError, false);
            return response("", snippet, "EvalWorkflowSnippet");
          }
          if (call === 4) {
            const result = lastTool(request, "EvalWorkflowSnippet");
            assert.equal(result.isError, false, modelMessageContentToText(result.content));
            assert.match(modelMessageContentToText(result.content), /workflow-integration-ran/);
            return response("The actual workflow snippet completed.");
          }
          if (call === 5)
            return response(
              "",
              {
                description: "Load a bundled workflow skill after reload",
                subagent_type: "general-purpose",
                prompt:
                  "Load dynamic-workflows and confirm the project-reload-marker skill is available.",
              },
              "Agent",
            );
          if (call === 6) {
            const context = request.messages
              .map((message) => modelMessageContentToText(message.content))
              .join("\n");
            assert.match(context, /dynamic-workflows/);
            assert.match(context, /project-reload-marker/);
            return response("", { skill: "dynamic-workflows" }, "Skill");
          }
          if (call === 7) {
            assert.equal(lastTool(request, "Skill").isError, false);
            return response("The child loaded the bundled skill after project reload.");
          }
          assert.equal(call, 8);
          const result = lastTool(request, "Agent");
          assert.equal(result.isError, false, modelMessageContentToText(result.content));
          return response("The parent received the child completion.");
        },
      });
      await app.refreshCapabilities();
      assert.equal((await app.getSkillCatalog()).skills.length, 0);
      // 原始 deps 没有 skillPort；启用后的 gate 必须跟随当前已采用的能力快照。
      await writeFile(
        join(root, "project", ".zcode", "config.json"),
        JSON.stringify({ skills: { enabled: true } }),
      );
      await app.refreshCapabilities();
      await prompt(app, "Evaluate the workflow snippet using the newly enabled skill gate.");
      assert.equal(call, 4);
      assert.equal(initialEvaluation?.isError, true, initialEvaluation?.text);
      assert.match(initialEvaluation.text, /needs.*dynamic-workflows.*skill/);
      const skillRoot = join(root, "project", ".zcode", "skills", "project-reload-marker");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "---\nname: project-reload-marker\ndescription: A project skill added during this session.\n---\nConfirm live skill discovery.\n",
      );
      await app.refreshCapabilities();
      const names = (await app.getSkillCatalog()).skills.map((skill) => skill.name);
      assert.ok(names.includes("project-reload-marker"));
      assert.ok(names.includes("dynamic-workflows"));
      await prompt(app, "Ask a child to load the bundled skill using the updated catalog.");
      assert.equal(call, 8);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
