import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfig } from "@zcode/adapters/config";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createInMemorySessionEventStore, type Logger } from "@zcode/contracts";
import { AgentRuntime, createToolRegistry } from "@zcode/core";
import { resolveZCodePlugins } from "../src/plugins.js";
import { createLiveCapabilityLoader } from "../src/app/live-capability-loader.js";
import { createLiveCapabilitySource } from "../src/app/live-capability-source.js";

const traceContext = { traceId: "live-runtime-recovery" };
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

test("a session recovers its status and callable catalog after restoring capability files without a watcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-runtime-recovery-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const toolRoot = join(workspace, ".zcode", "tools");
  await mkdir(toolRoot, { recursive: true });
  await mkdir(home);
  const manifestPath = join(toolRoot, "recovery.json");
  const manifest = JSON.stringify({
    version: 1,
    id: "integration.recovery",
    tools: [
      {
        name: "recovery_echo",
        description: "Return a stable result from a captured script.",
        command: { script: "./echo.mjs" },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ],
  });
  await writeFile(manifestPath, manifest);
  await writeFile(
    join(toolRoot, "echo.mjs"),
    'process.stdout.write(JSON.stringify({ value: "retained" }));',
  );
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const options = {
    env,
    officialPluginRoots: [],
    pluginStorageRoot: join(root, "plugins"),
    runtimeConfig: { mcp: { enabled: false } },
  };
  const initialConfig = createConfig({ env, workingDirectory: workspace });
  const loader = createLiveCapabilityLoader({
    options,
    initialConfig,
    initialPlugins: resolveZCodePlugins({
      configResult: initialConfig,
      env,
      workingDirectory: workspace,
      officialPluginRoots: [],
      pluginStorageRoot: options.pluginStorageRoot,
    }),
    initialRuntimeConfig: {},
    cliStorageRoot: join(root, "cli"),
    storageRoot: join(root, "storage"),
    workingDirectory: workspace,
    logger,
  });
  const source = createLiveCapabilitySource({
    workingDirectory: workspace,
    load: loader.load,
    createMcpPort() {
      throw new Error("MCP is disabled for this integration");
    },
  });
  const registry = createToolRegistry();
  const runtime = new AgentRuntime(
    "integration-recovery" as never,
    { workingDirectory: workspace, subagents: { enabled: false } },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
      toolRegistry: registry,
    },
  );
  const events: string[] = [];
  const unsubscribe = runtime.subscribeCapabilities((status) => events.push(status.status));
  const executionPort = createNodeExecutionAdapter();
  const runTool = async () => {
    const entry = registry.get("recovery_echo");
    assert.ok(entry, "the adopted live tool must stay registered");
    return entry.handler({}, {
      workingDirectory: workspace,
      executionPort,
      traceContext,
      abortSignal: new AbortController().signal,
    } as never);
  };
  try {
    const initial = await runtime.refreshCapabilities({ traceContext });
    assert.equal(initial.status, "ready");
    assert.deepEqual(await runTool(), { value: "retained" });
    await writeFile(manifestPath, "{ invalid manifest");
    const failed = await runtime.refreshCapabilities({ traceContext });
    assert.equal(failed.status, "error");
    assert.equal(failed.revision, initial.revision);
    assert.deepEqual(await runTool(), { value: "retained" });
    await writeFile(manifestPath, manifest);
    const recovered = await runtime.refreshCapabilities({ traceContext });
    assert.deepEqual(recovered, { status: "ready", revision: initial.revision });
    assert.deepEqual(await runTool(), { value: "retained" });
    assert.deepEqual(events.slice(-2), ["error", "ready"]);
    const count = events.length;
    await runtime.refreshCapabilities({ traceContext });
    assert.equal(events.length, count, "unchanged ready reads do not emit redundant events");
  } finally {
    unsubscribe();
    await runtime.disposeCapabilities();
    await rm(root, { recursive: true, force: true });
  }
});
