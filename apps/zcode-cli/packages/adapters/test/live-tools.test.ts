import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createLiveCapabilityWatcher,
  LiveToolConfigurationError,
  loadLiveTools,
} from "../src/live-tools/index.js";

const INPUT_SCHEMA = {
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
  type: "object",
};

const OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: { count: { minimum: 0, type: "integer" } },
  required: ["count"],
  type: "object",
};

function manifest(input: { id: string; name: string; command?: Record<string, unknown> }): string {
  return JSON.stringify({
    id: input.id,
    tools: [
      {
        command: input.command ?? { script: "./word-count.mjs" },
        description: `Run ${input.name}`,
        inputSchema: INPUT_SCHEMA,
        name: input.name,
        outputSchema: OUTPUT_SCHEMA,
      },
    ],
    version: 1,
  });
}

async function writeFixture(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function makeWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "zcode-live-tools-"));
  t.after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });
  return workspace;
}

test("loads ordered roots, captures scripts, and revises after edits and deletion", async (t) => {
  const workspace = await makeWorkspace(t);
  const workspaceTools = join(workspace, ".zcode", "tools");
  const agentTools = join(workspace, ".agents", "tools");
  const userTools = join(workspace, "user-tools");
  const pluginRoot = join(workspace, "plugin-package");
  const pluginTools = join(pluginRoot, "tools");
  const scriptPath = join(workspaceTools, "word-count.mjs");
  const manifestPath = join(workspaceTools, "word-count.json");

  await writeFixture(scriptPath, "process.stdout.write(JSON.stringify({ count: 1 }));\n");
  await writeFixture(manifestPath, manifest({ id: "workspace.words", name: "word_count" }));
  await writeFixture(
    join(agentTools, "agent.json"),
    manifest({ id: "workspace.agents", name: "agent_probe", command: { argv: ["agent-probe"] } }),
  );
  await writeFixture(
    join(userTools, "user.json"),
    manifest({ id: "user.tools", name: "user_probe", command: { argv: ["user-probe"] } }),
  );
  await writeFixture(
    join(pluginTools, "plugin.json"),
    manifest({ id: "plugin.tools", name: "plugin_probe", command: { argv: ["plugin-probe"] } }),
  );
  await writeFixture(join(pluginRoot, "package.json"), JSON.stringify({ name: "example-plugin" }));

  const loadInput = {
    pluginRoots: [{ id: "example.plugin", path: pluginRoot }],
    userRoots: [userTools],
    workspacePath: workspace,
  };
  const first = await loadLiveTools(loadInput);
  const repeated = await loadLiveTools(loadInput);

  assert.equal(first.revision, repeated.revision);
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    repeated.tools.map((tool) => tool.name),
  );
  assert.equal(first.tools.length, 4);
  const wordCount = first.tools.find((tool) => tool.name === "word_count");
  assert.ok(wordCount);
  assert.equal(wordCount.command.kind, "node-script");
  assert.equal(
    Buffer.from(wordCount.command.contents).toString("utf8"),
    "process.stdout.write(JSON.stringify({ count: 1 }));\n",
  );

  await writeFile(scriptPath, "process.stdout.write(JSON.stringify({ count: 2 }));\n", "utf8");
  const edited = await loadLiveTools(loadInput);
  assert.notEqual(edited.revision, first.revision);
  assert.equal(
    Buffer.from(wordCount.command.contents).toString("utf8"),
    "process.stdout.write(JSON.stringify({ count: 1 }));\n",
  );

  await unlink(manifestPath);
  const deleted = await loadLiveTools(loadInput);
  assert.notEqual(deleted.revision, edited.revision);
  assert.equal(
    deleted.tools.some((tool) => tool.name === "word_count"),
    false,
  );
});

test("rejects duplicate public identities and script traversal before returning a candidate", async (t) => {
  const workspace = await makeWorkspace(t);
  const toolRoot = join(workspace, ".zcode", "tools");
  await writeFixture(
    join(toolRoot, "one.json"),
    manifest({ id: "one.tools", name: "duplicate", command: { argv: ["one"] } }),
  );
  await writeFixture(
    join(toolRoot, "two.json"),
    manifest({ id: "two.tools", name: "duplicate", command: { argv: ["two"] } }),
  );

  await assert.rejects(
    loadLiveTools({ workspacePath: workspace }),
    (error: unknown) =>
      error instanceof LiveToolConfigurationError && error.code === "duplicate_tool_name",
  );

  await unlink(join(toolRoot, "two.json"));
  await writeFixture(
    join(toolRoot, "unsafe.json"),
    manifest({ id: "unsafe.tools", name: "unsafe_script", command: { script: "../outside.mjs" } }),
  );

  await assert.rejects(
    loadLiveTools({ workspacePath: workspace }),
    (error: unknown) => error instanceof LiveToolConfigurationError && error.code === "unsafe_path",
  );
});

test("rejects non-object input roots and scripts escaping through symlinks", async (t) => {
  const workspace = await makeWorkspace(t);
  const toolRoot = join(workspace, ".zcode", "tools");
  await writeFixture(
    join(toolRoot, "invalid-schema.json"),
    JSON.stringify({
      id: "invalid.schema",
      tools: [
        {
          command: { argv: ["invalid-schema"] },
          description: "Invalid input root.",
          inputSchema: { ...INPUT_SCHEMA, type: ["object", "null"] },
          name: "invalid_schema",
          outputSchema: OUTPUT_SCHEMA,
        },
      ],
      version: 1,
    }),
  );
  await assert.rejects(
    loadLiveTools({ workspacePath: workspace }),
    (error: unknown) =>
      error instanceof LiveToolConfigurationError && error.code === "invalid_schema",
  );

  await unlink(join(toolRoot, "invalid-schema.json"));
  const invalidUtf8 = Buffer.from(
    manifest({ id: "invalid.utf8", name: "bad_utf8", command: { argv: ["bad-utf8"] } }),
    "utf8",
  );
  const descriptionOffset = invalidUtf8.indexOf(Buffer.from("Run bad_utf8", "utf8"));
  assert.notEqual(descriptionOffset, -1);
  invalidUtf8[descriptionOffset] = 0xc3;
  await writeFile(join(toolRoot, "invalid-utf8.json"), invalidUtf8);
  await assert.rejects(
    loadLiveTools({ workspacePath: workspace }),
    (error: unknown) =>
      error instanceof LiveToolConfigurationError && error.code === "invalid_manifest",
  );
  await unlink(join(toolRoot, "invalid-utf8.json"));

  const outsideScript = join(workspace, "outside.mjs");
  const escapedScript = join(toolRoot, "escaped.mjs");
  await writeFixture(outsideScript, 'process.stdout.write("{}")\n');
  try {
    await symlink(outsideScript, escapedScript);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "EACCES" || code === "EPERM") {
      t.diagnostic("Symlink creation is unavailable in this test environment.");
      return;
    }
    throw error;
  }
  await writeFixture(
    join(toolRoot, "escaped.json"),
    manifest({
      id: "escaped.script",
      name: "escaped_script",
      command: { script: "./escaped.mjs" },
    }),
  );
  await assert.rejects(
    loadLiveTools({ workspacePath: workspace }),
    (error: unknown) => error instanceof LiveToolConfigurationError && error.code === "unsafe_path",
  );
});

test("watcher wakes for a child created below a missing source path", async (t) => {
  const workspace = await makeWorkspace(t);
  const missingRoot = join(workspace, ".zcode", "tools");
  let notifications = 0;
  let resolveNotification: (() => void) | undefined;
  let rejectNotification: ((reason?: unknown) => void) | undefined;
  const notified = new Promise<void>((resolve, reject) => {
    rejectNotification = reject;
    resolveNotification = resolve;
  });
  const watcher = createLiveCapabilityWatcher([missingRoot], () => {
    notifications += 1;
    resolveNotification?.();
  });
  t.after(() => watcher.close());

  await mkdir(missingRoot, { recursive: true });
  const timeout = setTimeout(
    () => rejectNotification?.(new Error("watcher did not notify for a missing-root child")),
    2_000,
  );
  try {
    await notified;
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(notifications, 1);
});
