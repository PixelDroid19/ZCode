import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { loadLiveTools } from "@zcode/adapters/live-tools";
import { prepareLiveToolEntries } from "../src/app/live-tool-entries.js";

const MANIFEST = JSON.stringify({
  id: "example.word-tools",
  tools: [
    {
      command: { script: "./word-count.mjs" },
      description: "Counts words.",
      inputSchema: {
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object",
      },
      name: "word_count",
      outputSchema: {
        additionalProperties: false,
        properties: { count: { type: "integer" } },
        required: ["count"],
        type: "object",
      },
    },
  ],
  version: 1,
});

async function makeWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "zcode-live-tool-entry-"));
  t.after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });
  await mkdir(join(workspace, ".zcode", "tools"), { recursive: true });
  await writeFile(join(workspace, ".zcode", "tools", "word-count.json"), MANIFEST, "utf8");
  return workspace;
}

test("prepared node scripts execute captured bytes through argv and JSON stdin", async (t) => {
  const workspace = await makeWorkspace(t);
  const sourceScript = join(workspace, ".zcode", "tools", "word-count.mjs");
  await writeFile(
    sourceScript,
    'let source = ""; for await (const chunk of process.stdin) source += chunk; JSON.parse(source); process.stdout.write(JSON.stringify({ count: 1 }));\n',
    "utf8",
  );
  const loaded = await loadLiveTools({ workspacePath: workspace });
  const prepared = await prepareLiveToolEntries(loaded.tools, {
    nodeRuntime: { executable: process.execPath },
  });
  t.after(async () => prepared.dispose());

  await writeFile(sourceScript, "process.stdout.write(JSON.stringify({ count: 999 }));\n", "utf8");
  const entry = prepared.tools[0];
  assert.ok(entry);
  assert.equal(entry.metadata.sideEffectScope, "system");
  assert.equal(entry.metadata.riskLevel, "high");
  assert.equal(entry.metadata.needsApproval, true);
  assert.equal(entry.metadata.readOnly, false);
  assert.deepEqual(entry.outputSchema, {
    additionalProperties: false,
    properties: { count: { type: "integer" } },
    required: ["count"],
    type: "object",
  });

  const executionPort = createNodeExecutionAdapter();
  const result = await entry.handler({ text: "one two" }, {
    abortSignal: new AbortController().signal,
    executionPort,
    workingDirectory: workspace,
  } as never);

  assert.deepEqual(result, { count: 1 });
});

test("prepared entries pass JSON through the injected host with fixed cancellation and output limits", async (t) => {
  const workspace = await makeWorkspace(t);
  await writeFile(
    join(workspace, ".zcode", "tools", "word-count.mjs"),
    "process.stdout.write(JSON.stringify({ count: 1 }));\n",
    "utf8",
  );
  const loaded = await loadLiveTools({ workspacePath: workspace });
  const prepared = await prepareLiveToolEntries(loaded.tools, {
    nodeRuntime: {
      args: ["--zcode-live-tool-host"],
      env: { set: { ZCODE_LIVE_TOOL_TEST: "1" } },
      executable: "zcode-node-host",
    },
  });
  t.after(async () => prepared.dispose());
  const controller = new AbortController();
  let receivedRequest: Record<string, unknown> | undefined;
  let receivedOptions: Record<string, unknown> | undefined;
  const result = await prepared.tools[0]!.handler({ text: "one two" }, {
    abortSignal: controller.signal,
    executionPort: {
      async run(request: unknown, options: unknown) {
        receivedRequest = request as Record<string, unknown>;
        receivedOptions = options as Record<string, unknown>;
        return {
          cancelled: false,
          exitCode: 0,
          status: "completed",
          stderr: { bytes: 0, text: "", truncated: false },
          stdout: { bytes: 11, text: '{"count":1}', truncated: false },
          timedOut: false,
        };
      },
    },
    workingDirectory: workspace,
  } as never);

  assert.deepEqual(result, { count: 1 });
  assert.equal(receivedRequest?.stdin, '{"text":"one two"}');
  assert.equal(receivedRequest?.timeoutMs, 30_000);
  assert.deepEqual(receivedRequest?.env, { set: { ZCODE_LIVE_TOOL_TEST: "1" } });
  assert.deepEqual(receivedRequest?.outputLimit, {
    killProcessOnPersistedLimit: true,
    maxBufferBytes: 64 * 1024,
    maxInlineBytes: 64 * 1024,
    maxPersistedBytes: 64 * 1024,
    persistOutput: "on_truncate",
  });
  const command = receivedRequest?.command as { args: string[]; file: string; mode: string };
  assert.equal(command.file, "zcode-node-host");
  assert.equal(command.mode, "argv");
  assert.deepEqual(command.args.slice(0, 1), ["--zcode-live-tool-host"]);
  assert.equal(command.args.length, 2);
  assert.equal(command.args[1]!.endsWith("tool.mjs"), true);
  assert.equal(receivedOptions?.signal, controller.signal);
});
